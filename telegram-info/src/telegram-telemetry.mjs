import { recordOpsMetric } from './ops-metrics.mjs';

const ALLOWED_EVENTS = new Set(['telegram_request', 'telegram_report', 'telegram_search', 'telegram_error']);
const CHAT_TYPES = new Set(['private', 'group', 'supergroup', 'unknown']);
const ACTIONS = new Set(['start', 'menu', 'topic', 'report', 'search', 'news', 'stats', 'other']);
const OUTCOMES = new Set(['handled', 'ignored', 'delivered', 'failed', 'queued']);
const SEARCH_REASONS = new Set(['completed', 'timeout', 'error', 'delivery_failed']);
const RUNTIMES = new Set(['v21', 'v22']);

function safeEnum(value, allowed, fallback) {
  const normalized = String(value || '').trim();
  return allowed.has(normalized) ? normalized : fallback;
}

export function buildTelegramTelemetryPayload(event, properties = {}, runtime = 'v22') {
  if (!ALLOWED_EVENTS.has(event)) return null;
  const reason = safeEnum(properties.reason, SEARCH_REASONS, null);
  return {
    event,
    properties:{
      distinct_id:'telegram-pilot-aggregate',
      $process_person_profile:false,
      channel:'telegram',
      chat_type:safeEnum(properties.chat_type, CHAT_TYPES, 'unknown'),
      action:safeEnum(properties.action, ACTIONS, 'other'),
      outcome:safeEnum(properties.outcome, OUTCOMES, 'handled'),
      ...(reason ? { reason } : {}),
      runtime:safeEnum(runtime, RUNTIMES, 'v22')
    }
  };
}

// Product analytics is off (owner decision 2026-10-14): nothing is sent to
// PostHog any more. Background search outcomes feed the admins' daily
// operations report as aggregate counters (ops-metrics.mjs).
export async function captureTelegramTelemetry(env, event, properties = {}, runtime = 'v22') {
  const payload = buildTelegramTelemetryPayload(event, properties, runtime);
  if (!payload || payload.event !== 'telegram_search' || !payload.properties.reason) return { status:'skipped' };
  return recordOpsMetric(env, `search:${payload.properties.reason}`);
}
