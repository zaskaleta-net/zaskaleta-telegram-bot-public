// Cloudflare staging exact-SHA retrigger 2026-09-26; no runtime behavior change.
// Stable configuration entrypoint. Active routing is consolidated in runtime.mjs.
// Control-plane requests are intercepted here before normal runtime routing.
// All non-control traffic continues through the existing runtime unchanged.

import { safeLogText } from './log-safe.mjs';
import runtime, {
  TelegramOutbox as RuntimeTelegramOutbox,
  handle as runtimeHandle,
  superviseBackgroundJobcenterTask,
  JOBCENTER_BACKGROUND_TASK_PATH
} from './runtime.mjs';
import {
  JOBCENTER_BACKGROUND_TASK_HEADER,
  transportWithAbortSignal
} from './runtime-jobcenter.mjs';
import {
  isDurableJobcenterWorker,
  queueDurableJobcenterBackgroundTask,
  runQueuedDurableJobcenterBackgroundTask
} from './durable-jobcenter-alarm.mjs';
import { handleControlRequest } from './control-api.mjs';
import { handlePrivacyPolicyRequest } from './privacy-policy.mjs';
import { handleImpressumRequest } from './legal-commands.mjs';
import { recordOpsMetric, opsMetricKey } from './ops-metrics.mjs';
import { equalSecret, pilotConfig, readBoundedJSON, withStatelessDirectReply } from './pilot-security.mjs';
import { capturePosthogEvent, classifyTelegramTelemetry } from './telemetry-posthog.mjs';
import { subrequestBudgetTransport } from './subrequest-budget.mjs';

export {
  handle,
  scheduled,
  queueAggregateRequestTelemetry
} from './runtime.mjs';

export class TelegramOutbox extends RuntimeTelegramOutbox {
  async fetch(request) {
    let url = null;
    try { url = new URL(request?.url || ''); } catch {}
    if (
      request?.method === 'POST'
      && url?.hostname === 'outbox.internal'
      && url.pathname === JOBCENTER_BACKGROUND_TASK_PATH
      && request.headers.get(JOBCENTER_BACKGROUND_TASK_HEADER) === '1'
    ) {
      try {
        const queued = await queueDurableJobcenterBackgroundTask(request, this);
        return new Response(JSON.stringify({
          ok:queued.queued === true,
          mode:queued.queued === true
            ? 'telegram-jobcenter-search-durable-alarm-accepted'
            : 'telegram-jobcenter-search-durable-alarm-unavailable',
          ...(queued.reason ? { reason:queued.reason } : {})
        }), {
          status:queued.queued === true ? 200 : 503,
          headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
        });
      } catch (error) {
        console.error('telegram_jobcenter_durable_queue_failed', {
          name:String(error?.name || 'Error'),
          message:safeLogText(error?.message || 'Durable Jobcenter queue failed')
        });
        return new Response(JSON.stringify({ ok:false, mode:'telegram-jobcenter-search-durable-alarm-failed' }), {
          status:503,
          headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
        });
      }
    }
    return super.fetch(request);
  }

  async alarm(alarmInfo) {
    if (!await isDurableJobcenterWorker(this)) return super.alarm(alarmInfo);

    return runQueuedDurableJobcenterBackgroundTask(this, {
      onReplay:taskRequest => superviseBackgroundJobcenterTask(
        Promise.reject(new Error('Interrupted durable Jobcenter task was not replayed')),
        taskRequest,
        this.env
      ),
      runTask:async taskRequest => {
        const fallbackRequest = taskRequest.clone();
        const taskController = new AbortController();
        const taskTransport = transportWithAbortSignal(subrequestBudgetTransport(fetch, this.env), taskController.signal);
        return superviseBackgroundJobcenterTask(
          runtimeHandle(taskRequest, this.env, Date.now(), taskTransport),
          fallbackRequest,
          this.env,
          { abortController:taskController }
        );
      }
    });
  }
}

export { triggerMaintenanceAnnouncement } from './runtime-maintenance.mjs';
export { shouldClearLegacyReplyKeyboard } from './runtime-keyboard.mjs';

export {
  collapsiblePrivateKeyboardTransport,
  persistentPrivateKeyboardFinalTransport
} from './runtime-compatibility.mjs';

export {
  normalizeBuesumHousingText,
  normalizeStatewideHousingText
} from './runtime-cities.mjs';

export { housingActiveTransport } from './housing-active-v21.mjs';


async function telegramTelemetryContext(request, env) {
  if (env?.TELEGRAM_INGRESS_ENABLED !== 'true' || request?.method !== 'POST') return null;
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (url.pathname !== '/telegram/stateless') return null;

  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;

  try {
    const parsed = await readBoundedJSON(request.clone(), 65536);
    if (parsed.error) return null;
    return classifyTelegramTelemetry(parsed.value);
  } catch {
    return null;
  }
}

function queuePosthogTelemetry(ctx, env, event, properties) {
  const task = capturePosthogEvent(env, event, properties);
  if (typeof ctx?.waitUntil === 'function') {
    ctx.waitUntil(task);
  } else {
    task.catch(() => {});
  }
}

// Aggregate counters for the admins' daily report: the feature of the update
// and, when it failed, the failure kind. No ids or text (ops-metrics.mjs).
function queueOpsMetrics(ctx, env, telemetry, outcome) {
  const keys = [opsMetricKey('feature', telemetry?.feature), outcome === 'success' ? null : opsMetricKey('request', outcome)].filter(Boolean);
  const task = Promise.all(keys.map(key => recordOpsMetric(env, key)));
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(task);
  else task.catch(() => {});
}

function telemetryProperties(env, telemetry, outcome, status, startedAt) {
  return {
    ...telemetry,
    outcome,
    http_status:status,
    duration_ms:Math.max(0, Math.min(300000, Date.now() - startedAt)),
    worker_version:String(env?.CF_VERSION_METADATA?.id || ''),
    release:String(env?.TELEGRAM_RELEASE_APPROVED || '')
  };
}

async function housingCallbackEnv(request, env) {
  if (env?.TELEGRAM_DELIVERY_ENABLED !== 'true' || request?.method !== 'POST') return env;
  let url;
  try { url = new URL(request.url); } catch { return env; }
  if (url.pathname !== '/telegram/stateless') return env;
  try {
    const update = await request.clone().json();
    const data = String(update?.callback_query?.data || '');
    if (!/^(?:jcn:[ld]:\d{1,3}:u\d{1,20}|jcd:u\d{1,20})$/u.test(data)) return env;
    // The dedicated housing callback handlers reply directly only with the
    // explicit marker; the real delivery configuration stays unchanged.
    return withStatelessDirectReply(env);
  } catch {
    return env;
  }
}

export default {
  async fetch(request, env, ctx) {
    // Public privacy page: answered before telemetry, idempotency and the
    // maintenance trigger, which only concern Telegram traffic.
    const privacyPage = handlePrivacyPolicyRequest(request) ?? handleImpressumRequest(request);
    if (privacyPage !== null) {
      return privacyPage;
    }

    const controlResponse = handleControlRequest(request, env);

    if (controlResponse !== null) {
      return controlResponse;
    }

    const startedAt = Date.now();
    const telemetry = await telegramTelemetryContext(request, env);

    try {
      const response = await runtime.fetch(request, await housingCallbackEnv(request, env), ctx);
      if (telemetry) {
        queuePosthogTelemetry(
          ctx,
          env,
          'telegram webhook processed',
          telemetryProperties(env, telemetry, response.ok ? 'success' : 'rejected', response.status, startedAt)
        );
        queueOpsMetrics(ctx, env, telemetry, response.ok ? 'success' : 'rejected');
      }
      return response;
    } catch (error) {
      if (telemetry) {
        queuePosthogTelemetry(
          ctx,
          env,
          'telegram runtime failed',
          telemetryProperties(env, telemetry, 'exception', 500, startedAt)
        );
        queueOpsMetrics(ctx, env, telemetry, 'exception');
      }
      throw error;
    }
  },

  async scheduled(controller, env, ctx) {
    if (typeof runtime.scheduled === 'function') {
      return runtime.scheduled(controller, env, ctx);
    }
  }
};