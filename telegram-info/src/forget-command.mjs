// /forget: a user deletes everything the bot keeps about them, at once and
// without writing to anyone. Only a private chat qualifies (chat id = user id).
// Telegram's own copy of the chat history is not the bot's to delete.
import { pilotConfig, equalSecret, readBoundedJSON } from './pilot-security.mjs';
import { PRIVACY_CONTROLLER, privacyPolicyPublished } from './privacy-policy.mjs';

const STATELESS_PATH = '/telegram/stateless';
export const FORGET_USER_PATH = '/forget-user';
const FORGET_COMMAND = /^\/forget(?:@ZaskaletaInfoBot)?\s*$/iu;
const CALL_TIMEOUT_MS = 3000;

// Keys that end in ":<chatId>:<userId>".
const PER_USER_PREFIXES = Object.freeze([
  'telegram-household-context:v1:',
  'telegram-private-prompt:v1:',
  'telegram-housing-cost-pending:v1:',
  'telegram-report-pending:v1:',
  'telegram-jobcenter-search-state:v1:',
  'telegram-jobcenter-district-inflight:v1:',
  'telegram-keyboard-reset:v6:',
  // AI module (ai-state.mjs): the daily counter and the Premium record.
  'telegram-ai-usage:v1:',
  'telegram-ai-premium:v1:',
  // Housing monitor (housing-watch.mjs): the saved search.
  'telegram-housing-watch:v1:',
  // Search rate limit (search-rate-limit.mjs): start times of recent searches.
  'telegram-search-rate:v1:'
]);
// Keys that end in ":<chatId>".
const PER_CHAT_PREFIXES = Object.freeze(['housing-cost-active:v14:']);
// The user's own whole-Kreis object holds queued searches (raw updates).
const OWN_OBJECT_PREFIXES = Object.freeze(['telegram-jobcenter-district-task:v1:']);

export const FORGET_DONE_TEXT = [
  '🗑 Ваші дані в боті видалено.',
  '',
  'Видалено: склад сім’ї, стан діалогу, критерії та історію пошуку житла, незавершені запити, лічильник запитів до ШІ, Premium і моніторинг житла.',
  '',
  'Повідомлення про помилки зберігаються без вашого Telegram-ID, тому знайти їх за вами неможливо. Історія цього чату зберігається в Telegram; очистити її можна в самому Telegram (⋮ → Очистити історію).',
  '',
  'Ви можете й далі користуватися ботом: /start'
].join('\n');

// TG-RUNTIME-066: the address is named only once the Impressum is published.
export function forgetFailedText(controller = PRIVACY_CONTROLLER) {
  return privacyPolicyPublished(controller)
    ? `⚠️ Не вдалося видалити дані зараз. Спробуйте ще раз через кілька хвилин або напишіть на ${controller.email}.`
    : '⚠️ Не вдалося видалити дані зараз. Спробуйте ще раз через кілька хвилин.';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

export function forgetKeys(chatId, userId) {
  return [
    ...PER_USER_PREFIXES.map(prefix => `${prefix}${chatId}:${userId}`),
    ...PER_CHAT_PREFIXES.map(prefix => `${prefix}${chatId}`)
  ];
}

// Durable Object side. In the shared object it deletes the user's keys; in
// the user's own whole-Kreis object it also drops queued searches.
export async function handleForgetUserStorage(request, outbox) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== FORGET_USER_PATH) return null;
  const parsed = await readBoundedJSON(request.clone(), 4096);
  const chatId = Number(parsed.error ? NaN : parsed.value?.chatId);
  const userId = Number(parsed.error ? NaN : parsed.value?.userId);
  if (!Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId) return json({ status:'bad_operation' }, 400);
  const storage = outbox?.householdContextStorage || outbox?.ctx?.storage;
  if (!storage || typeof storage.delete !== 'function') return json({ status:'storage_unavailable' }, 503);
  try {
    let deleted = await storage.delete(forgetKeys(chatId, userId));
    if (parsed.value?.ownObject === true && typeof storage.list === 'function') {
      for (const prefix of OWN_OBJECT_PREFIXES) {
        const keys = [...(await storage.list({ prefix })).keys()];
        for (let index = 0; index < keys.length; index += 128) deleted += await storage.delete(keys.slice(index, index + 128));
      }
    }
    return json({ status:'ok', deleted:Number(deleted) || 0 });
  } catch {
    return json({ status:'unavailable' }, 503);
  }
}

async function objectCall(env, name, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await env.OUTBOX.get(env.OUTBOX.idFromName(name)).fetch(`https://outbox.internal${FORGET_USER_PATH}`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body), signal:controller.signal
    });
    const parsed = await readBoundedJSON(response, 4096);
    return response.ok && !parsed.error && parsed.value?.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function forgetCommand(request, env, now, transport = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const message = parsed.value?.message;
  if (!FORGET_COMMAND.test(String(message?.text || '').trim())) return null;
  const chatId = Number(message?.chat?.id);
  const userId = Number(message?.from?.id);
  if (message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || message?.from?.is_bot === true) {
    return json({ ok:true, ignored:true, reason:'private_chat_required' });
  }
  if (!env?.OUTBOX) return json({ ok:false, mode:'forget-v1', reason:'storage_unavailable' }, 503);
  const [shared, own] = await Promise.all([
    objectCall(env, 'telegram-pilot-v1', { chatId, userId }),
    objectCall(env, `jobcenter-district-search:v2:${chatId}`, { chatId, userId, ownObject:true })
  ]);
  const ok = shared && own;
  try {
    await transport(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ chat_id:chatId, text:ok ? FORGET_DONE_TEXT : forgetFailedText() })
    });
  } catch {}
  // Fixed fields only; no ids.
  console.info('TELEGRAM_FORGET', JSON.stringify({ status:ok ? 'deleted' : 'failed' }));
  return json({ ok, mode:'forget-v1' }, ok ? 200 : 503);
}
