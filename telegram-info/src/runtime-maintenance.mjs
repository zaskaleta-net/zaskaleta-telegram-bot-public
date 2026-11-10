// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { pilotConfig, equalSecret, isPilotAdmin, readBoundedJSON } from './pilot-security.mjs';
import { isGroupAdministrator } from './group-launch-panel-v1.mjs';
import { INTERNAL_PUBLISH_PATH, MANUAL_BUCKET_MS, normalizeManualPublishRequest } from './admin-publish-v1.mjs';
import { isSubrequestNotSentError } from './subrequest-budget.mjs';
const STATELESS_PATH = '/telegram/stateless';

const SENDING_STALE_MS = 2 * 60 * 1000;

const TELEGRAM_TIMEOUT_MS = 8000;

const MAINTENANCE_PATH = '/maintenance-announcement-v1';

const MAINTENANCE_MARKER_PREFIX = 'maintenance-announcement:v1:';

const MAINTENANCE_PRIVATE_TEXT = [
  '🛠 Schleswig-Holstein Помічник тимчасово на технічному обслуговуванні.',
  '',
  'Проводиться реконструкція та стабілізація системи. На цей час користувацький доступ до функцій бота обмежено.',
  '',
  'Після завершення повного тестування ми повідомимо про відновлення роботи.'
].join('\n');

const MAINTENANCE_MESSAGE = [
  '🛠 Schleswig-Holstein Помічник — технічна реконструкція',
  '',
  'Шановні учасники!',
  '',
  'Ми тимчасово призупиняємо користувацький доступ до бота для проведення комплексної технічної реконструкції та стабілізації системи.',
  '',
  'Під час тестування було виявлено нестабільну роботу окремих функцій, зокрема навігації, пошуку житла, розпізнавання населених пунктів та автоматичних інформаційних сервісів.',
  '',
  'Наш пріоритет — не випускати нестабільні оновлення, а забезпечити передбачувану, надійну та однакову роботу сервісу для всіх користувачів.',
  '',
  '🔒 На час технічних робіт основні функції бота тимчасово недоступні для користувачів. Адміністративний доступ збережено для внутрішнього тестування.',
  '',
  'Після завершення реконструкції ми проведемо повний цикл перевірок і окремо повідомимо про відновлення стабільної роботи бота.',
  '',
  'Дякуємо за розуміння та терпіння.',
  '',
  'Команда Schleswig-Holstein Помічник 🇺🇦🇩🇪'
].join('\n');

export function maintenanceEnabled(env) {
  return env?.TELEGRAM_MAINTENANCE_MODE === 'true';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

function pilotGroups(config) {
  return [...new Set((config?.chatIds || []).filter(id => Number.isSafeInteger(id) && id < 0))];
}

async function telegramSendText(config, chatId, text, transport = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        chat_id:chatId,
        text,
        disable_notification:false,
        link_preview_options:{ is_disabled:true }
      }),
      signal:controller.signal
    });
    const parsed = await readBoundedJSON(response, 32768);
    return response.ok && !parsed.error && parsed.value?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// Classifies one announcement send like the outbox does: only a confirmed
// Telegram answer is definite. A timeout, a 5xx or an unreadable reply may
// follow an accepted message, so it is never resent automatically.
async function sendAnnouncement(config, chatId, transport = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ chat_id:chatId, text:MAINTENANCE_MESSAGE, disable_notification:false, link_preview_options:{ is_disabled:true } }),
      signal:controller.signal
    });
    const parsed = await readBoundedJSON(response, 32768);
    if (response.ok && !parsed.error && parsed.value?.ok === true) return { state:'sent' };
    if (!parsed.error && parsed.value?.ok === false && response.status === 429) {
      const retryAfter = Number(parsed.value?.parameters?.retry_after);
      return { state:'rate_limited', retryAfterMs:(Number.isFinite(retryAfter) ? Math.max(1, Math.min(3600, Math.ceil(retryAfter))) : 60) * 1000 };
    }
    if (!parsed.error && parsed.value?.ok === false && response.status >= 400 && response.status < 500) return { state:'rejected' };
    return { state:'uncertain' };
  } catch (error) {
    return { state:isSubrequestNotSentError(error) ? 'not_sent' : 'uncertain' };
  } finally {
    clearTimeout(timeout);
  }
}

// Markers are per maintenance window: once maintenance mode is off, the next
// window must be announced again. Called on Durable Object requests (every
// webhook claims through it); runs once per object instance, and an env change
// always starts a new instance.
export async function clearMaintenanceMarkersWhenOff(outbox) {
  if (maintenanceEnabled(outbox?.env) || outbox?.maintenanceMarkersCleared) return;
  const storage = outbox?.householdContextStorage;
  if (!storage || typeof storage.delete !== 'function') return;
  outbox.maintenanceMarkersCleared = true;
  try {
    for (const chatId of pilotGroups(pilotConfig(outbox.env))) await storage.delete(`${MAINTENANCE_MARKER_PREFIX}${chatId}`);
  } catch {
    outbox.maintenanceMarkersCleared = false;
  }
}

async function outboxPublish(env, publication, now) {
  if (!env?.OUTBOX) return { status:'unavailable' };
  try {
    const id = env.OUTBOX.idFromName('telegram-pilot-v1');
    const response = await env.OUTBOX.get(id).fetch(`https://outbox.internal${INTERNAL_PUBLISH_PATH}`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ now, publication })
    });
    const parsed = await readBoundedJSON(response, 32768);
    return parsed.error ? { status:'unavailable' } : parsed.value;
  } catch {
    return { status:'unavailable' };
  }
}

export async function triggerMaintenanceAnnouncement(env, now = Date.now()) {
  if (!maintenanceEnabled(env) || !env?.OUTBOX || !Number.isFinite(now) || now < 0) return { status:'skipped' };
  try {
    const id = env.OUTBOX.idFromName('telegram-pilot-v1');
    const response = await env.OUTBOX.get(id).fetch(`https://outbox.internal${MAINTENANCE_PATH}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ now })
    });
    const parsed = await readBoundedJSON(response, 32768);
    return parsed.error ? { status:'unavailable' } : parsed.value;
  } catch {
    return { status:'unavailable' };
  }
}

async function adminAuthorized(config, userId, transport) {
  if (isPilotAdmin(config, userId)) return true;
  for (const groupId of pilotGroups(config)) {
    if (await isGroupAdministrator(config, groupId, userId, transport)) return true;
  }
  return false;
}

export async function maintenanceGate(request, env, transport) {
  if (!maintenanceEnabled(env)) return null;
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const update = parsed.value;
  const chat = update?.message?.chat || update?.callback_query?.message?.chat;
  const from = update?.message?.from || update?.callback_query?.from;
  const chatId = Number(chat?.id);
  const userId = Number(from?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0 || from?.is_bot === true) return null;
  if (await adminAuthorized(config, userId, transport)) return null;

  if (chat?.type === 'private' && Number.isSafeInteger(chatId) && chatId > 0) {
    const delivered = await telegramSendText(config, chatId, MAINTENANCE_PRIVATE_TEXT, transport);
    return json({ ok:true, mode:'maintenance', delivered });
  }

  if (['group','supergroup'].includes(chat?.type)) {
    return json({ ok:true, ignored:true, mode:'maintenance' });
  }
  return null;
}

export async function adminPublishCommand(request, env, now, transport) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const message = parsed.value?.message;
  if (message?.chat?.type !== 'private' || !/^\/publishnow(?:@ZaskaletaInfoBot)?\s*$/iu.test(String(message?.text || '').trim())) return null;

  const chatId = Number(message?.chat?.id);
  const userId = Number(message?.from?.id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || message?.from?.is_bot === true) return json({ ok:true, ignored:true, reason:'admin_required' });

  if (!(await adminAuthorized(config, userId, transport))) return json({ ok:true, ignored:true, reason:'admin_required' });

  const publication = normalizeManualPublishRequest({ type:'digest', idempotency_key:`digest:${Math.floor(now / MANUAL_BUCKET_MS)}` }, now);
  const result = publication ? await outboxPublish(env, publication, now) : { status:'bad_operation' };
  return json({ ok:result?.status === 'ok', mode:'admin-publish-now-v1', sent:Number(result?.sent || 0), alreadySent:Number(result?.alreadySent || 0), inFlight:Number(result?.inFlight || 0), failed:Number(result?.failed || 0) });
}
export async function handleMaintenanceStorage(request, outbox) {
 const url=new URL(request.url);
    if (request.method === 'POST' && url.hostname === 'outbox.internal' && url.pathname === MAINTENANCE_PATH) {
      const parsed = await readBoundedJSON(request.clone(), 8192);
      const now = Number(parsed.error ? NaN : parsed.value?.now);
      if (!Number.isFinite(now) || now < 0) return json({ status:'bad_operation' }, 400);

      const config = pilotConfig(outbox.env);
      const groups = pilotGroups(config);
      if (!config || !groups.length) return json({ status:'forbidden' }, 403);

      let sent = 0;
      let alreadySent = 0;
      let inFlight = 0;
      let failed = 0;
      let uncertain = 0;
      const storage = outbox.householdContextStorage;
      for (const chatId of groups) {
        const markerKey = `${MAINTENANCE_MARKER_PREFIX}${chatId}`;
        const existing = await storage.get(markerKey);
        if (existing?.state === 'sent') {
          alreadySent += 1;
          continue;
        }
        if (existing?.state === 'uncertain') {
          uncertain += 1;
          continue;
        }
        if (existing?.state === 'sending') {
          if (Number.isFinite(existing.startedAt) && now - existing.startedAt < SENDING_STALE_MS) {
            inFlight += 1;
            continue;
          }
          // The attempt died mid-send; Telegram may have posted it.
          await storage.put(markerKey, { state:'uncertain', since:now });
          uncertain += 1;
          continue;
        }
        if (existing?.state === 'rate_limited' && Number.isFinite(existing.retryAt) && now < existing.retryAt) {
          failed += 1;
          continue;
        }

        await storage.put(markerKey, { state:'sending', startedAt:now });
        const outcome = await sendAnnouncement(config, chatId);
        if (outcome.state === 'sent') {
          await storage.put(markerKey, { state:'sent', sentAt:now });
          sent += 1;
        } else if (outcome.state === 'uncertain') {
          await storage.put(markerKey, { state:'uncertain', since:now });
          uncertain += 1;
        } else if (outcome.state === 'rate_limited') {
          await storage.put(markerKey, { state:'rate_limited', retryAt:now + outcome.retryAfterMs });
          failed += 1;
        } else {
          // Definite rejection, or never sent: nothing reached the group.
          await storage.delete(markerKey);
          failed += 1;
        }
      }

      const ok = failed === 0 || sent > 0 || alreadySent > 0 || inFlight > 0 || uncertain > 0;
      return json({ status:ok ? 'ok' : 'unavailable', sent, alreadySent, inFlight, uncertain, failed }, ok ? 200 : 503);
    }


return null;
}
