import { pilotConfig, equalSecret, readBoundedJSON } from './pilot-security.mjs';

// TG-RUNTIME-115: the channel «Українці Schleswig-Holstein» carries every
// automatic news post; the discussion group carries no news. A new member
// joins the group through a join request, approved only when Telegram
// confirms the person is subscribed to the channel. Existing members are
// never removed; a request that cannot be checked stays pending.

export const NEWS_CHANNEL_ID = -1004480749326;
export const DISCUSSION_GROUP_ID = -1004338212607;
export const NEWS_CHANNEL_URL = 'https://t.me/ukrainci_schleswig_holstein';
export const JOIN_CHECK_CALLBACK = 'jrq:check';

const STATELESS_PATH = '/telegram/stateless';
const TELEGRAM_TIMEOUT_MS = 6000;
// getChatMember statuses that confirm a subscription; "restricted" counts
// only with is_member === true. Anything else is not a confirmation.
const SUBSCRIBED = new Set(['creator', 'administrator', 'member']);
const NOT_SUBSCRIBED = new Set(['left', 'kicked']);
// approveChatJoinRequest answers these when the request is already handled
// (a repeated update, a second button press): nothing is left to do.
const ALREADY_HANDLED = /HIDE_REQUESTER_MISSING|USER_ALREADY_PARTICIPANT|REQUEST_NOT_FOUND|user is already a (?:member|participant)/iu;

export const NOT_SUBSCRIBED_TEXT = [
  '👋 Дякуємо за заявку до групи обговорень «Українці Schleswig-Holstein».',
  '',
  'Вступ до групи — після підписки на канал з новинами.',
  '1. Підпишіться на канал кнопкою нижче.',
  '2. Поверніться сюди й натисніть «✅ Я підписався — перевірити».',
  '',
  'Заявка чекає; повторно надсилати її не потрібно.'
].join('\n');
export const APPROVED_TEXT = '✅ Підписку підтверджено, заявку до групи схвалено. Ласкаво просимо!';
const STILL_NOT_SUBSCRIBED_TEXT = 'Підписку на канал ще не видно. Підпишіться кнопкою нижче й натисніть «Перевірити» ще раз.';
const NO_REQUEST_TEXT = 'Заявку до групи не знайдено або її вже розглянуто. Якщо ви ще не в групі, надішліть заявку ще раз за посиланням групи.';
const UNVERIFIED_TEXT = 'Зараз не вдалося перевірити підписку. Спробуйте, будь ласка, за кілька хвилин.';
export const UNVERIFIED_JOIN_TEXT = [
  '👋 Дякуємо за заявку до групи обговорень «Українці Schleswig-Holstein».',
  '',
  'Вступ до групи — після підписки на канал з новинами. Зараз підписку не вдалося перевірити автоматично.',
  'Якщо ви вже підписані, натисніть «✅ Я підписався — перевірити» за кілька хвилин; якщо ні — спершу підпишіться кнопкою нижче.',
  '',
  'Заявка чекає; повторно надсилати її не потрібно.'
].join('\n');
// Review #115 (F3): the webhook runs with max_connections 1, so a 503 would
// hold every later update. A short 429 is waited for once inside the request;
// any other failure answers 200 and leaves the way in by the button.
const RETRY_WAIT_LIMIT_S = 2;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

function joinKeyboard() {
  return { inline_keyboard:[
    [{ text:'📣 Підписатися на канал', url:NEWS_CHANNEL_URL }],
    [{ text:'✅ Я підписався — перевірити', callback_data:JOIN_CHECK_CALLBACK }]
  ] };
}

// One Bot API call. Never throws; status 0 means a network failure or timeout.
async function telegram(config, method, payload, transport, { retry = false } = {}) {
  const first = await telegramOnce(config, method, payload, transport);
  if (!retry || first.status !== 429 || first.retryAfter > RETRY_WAIT_LIMIT_S) return first;
  await new Promise(resolve => setTimeout(resolve, Math.max(1, first.retryAfter) * 1000));
  return telegramOnce(config, method, payload, transport);
}

async function telegramOnce(config, method, payload, transport) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/${method}`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload), signal:controller.signal
    });
    const parsed = await readBoundedJSON(response, 32768);
    const body = parsed.error ? null : parsed.value;
    return {
      ok:response.ok && body?.ok === true,
      status:response.status,
      result:body?.result,
      description:String(body?.description || ''),
      retryAfter:Number(body?.parameters?.retry_after) || 0
    };
  } catch {
    return { ok:false, status:0, result:null, description:'', retryAfter:0 };
  } finally {
    clearTimeout(timer);
  }
}

// A failure that may heal by itself: rate limit, server error, network.
// A 400/403 (no rights, bad chat) will not.
function transient(call) {
  return call.status === 0 || call.status === 429 || call.status >= 500;
}

// subscribed | not_subscribed | unverified (+ transient for a retry).
export async function channelSubscription(config, userId, transport = fetch) {
  if (!config?.token || !Number.isSafeInteger(userId) || userId <= 0) return { state:'unverified', transient:false, reason:'invalid' };
  const call = await telegram(config, 'getChatMember', { chat_id:NEWS_CHANNEL_ID, user_id:userId }, transport, { retry:true });
  if (!call.ok) return { state:'unverified', transient:transient(call), reason:call.status === 0 ? 'network' : `http_${call.status}` };
  const status = String(call.result?.status || '');
  if (SUBSCRIBED.has(status)) return { state:'subscribed', status };
  if (status === 'restricted') return call.result?.is_member === true ? { state:'subscribed', status } : { state:'not_subscribed', status };
  if (NOT_SUBSCRIBED.has(status)) return { state:'not_subscribed', status };
  return { state:'unverified', transient:false, reason:'unknown_status' };
}

async function approve(config, userId, transport) {
  const call = await telegram(config, 'approveChatJoinRequest', { chat_id:DISCUSSION_GROUP_ID, user_id:userId }, transport, { retry:true });
  if (call.ok) return { state:'approved' };
  if (call.status === 400 && ALREADY_HANDLED.test(call.description)) return { state:'already_handled' };
  return { state:'failed', transient:transient(call), reason:call.status === 0 ? 'network' : `http_${call.status}` };
}

// The request stays pending; the applicant gets the way in (user_chat_id lets
// the bot write for 5 minutes, even without /start). A refused message
// (privacy, 403) changes nothing about the request.
async function notifyApplicant(config, request, userId, text, transport) {
  const chatId = Number(request.user_chat_id) || userId;
  const sent = await telegram(config, 'sendMessage', { chat_id:chatId, text, disable_web_page_preview:true, reply_markup:joinKeyboard() }, transport);
  return sent.ok;
}

function log(outcome, reason = '') {
  // No user or chat identifiers in logs.
  console.info('TELEGRAM_JOIN_GATE', JSON.stringify({ outcome, ...(reason ? { reason } : {}) }));
}

export async function handleJoinRequestUpdate(update, config, transport = fetch) {
  const request = update?.chat_join_request;
  if (!request) return null;
  // Only the discussion group; another chat's requests are left untouched.
  if (Number(request.chat?.id) !== DISCUSSION_GROUP_ID) {
    log('ignored', 'other_chat');
    return json({ ok:true, mode:'channel-join-gate', ignored:true, reason:'other_chat' });
  }
  const userId = Number(request.from?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0 || request.from?.is_bot === true) {
    log('ignored', 'invalid_requester');
    return json({ ok:true, mode:'channel-join-gate', ignored:true, reason:'invalid_requester' });
  }
  const subscription = await channelSubscription(config, userId, transport);
  const pending = async (reason, text) => {
    // A lasting failure (bot not admin of the channel, no rights in the
    // group) waits for the admins; a transient one for the button.
    const notified = text ? await notifyApplicant(config, request, userId, text, transport) : false;
    log('pending', `${reason}${text ? (notified ? '_notified' : '_unnotified') : ''}`);
    return json({ ok:true, mode:'channel-join-gate', approved:false, pending:true, reason, ...(text ? { notified } : {}) });
  };
  if (subscription.state === 'unverified') return pending(subscription.reason, subscription.transient ? UNVERIFIED_JOIN_TEXT : null);
  if (subscription.state === 'subscribed') {
    const approved = await approve(config, userId, transport);
    if (approved.state === 'failed') return pending(approved.reason, approved.transient ? UNVERIFIED_JOIN_TEXT : null);
    log(approved.state);
    return json({ ok:true, mode:'channel-join-gate', approved:approved.state === 'approved', reason:approved.state });
  }
  return pending('not_subscribed', NOT_SUBSCRIBED_TEXT);
}

// "✅ Я підписався — перевірити" in the private chat: the same check again.
export async function handleJoinCheckCallback(update, config, transport = fetch) {
  const query = update?.callback_query;
  if (String(query?.data || '') !== JOIN_CHECK_CALLBACK) return null;
  const userId = Number(query?.from?.id);
  const chatId = Number(query?.message?.chat?.id);
  if (query?.message?.chat?.type !== 'private' || chatId !== userId || query?.from?.is_bot === true) {
    return json({ ok:true, mode:'channel-join-check', ignored:true });
  }
  await telegram(config, 'answerCallbackQuery', { callback_query_id:query.id }, transport);
  const subscription = await channelSubscription(config, userId, transport);
  let text = UNVERIFIED_TEXT, markup = null, outcome = subscription.state;
  if (subscription.state === 'not_subscribed') {
    text = STILL_NOT_SUBSCRIBED_TEXT;
    markup = joinKeyboard();
  } else if (subscription.state === 'subscribed') {
    const approved = await approve(config, userId, transport);
    outcome = approved.state;
    text = approved.state === 'approved' ? APPROVED_TEXT : approved.state === 'already_handled' ? NO_REQUEST_TEXT : UNVERIFIED_TEXT;
  }
  await telegram(config, 'sendMessage', { chat_id:chatId, text, disable_web_page_preview:true, ...(markup ? { reply_markup:markup } : {}) }, transport);
  log(`check_${outcome}`);
  return json({ ok:true, mode:'channel-join-check', result:outcome });
}

// Webhook entry: authenticated stateless updates only.
export async function channelJoinGate(request, env, transport = fetch) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  return await handleJoinRequestUpdate(parsed.value, config, transport)
    || await handleJoinCheckCallback(parsed.value, config, transport);
}

// News: only the channel, whatever TELEGRAM_NEWS_CHAT_IDS says.
export function isNewsChannel(chatId) {
  return Number(chatId) === NEWS_CHANNEL_ID;
}

export const GROUP_NEWS_POINTER_TEXT = '🗞 Новини публікуються в каналі «Українці Schleswig-Holstein». Тут — обговорення.';

export function groupNewsPointerPayload(chatId, replyTo) {
  return {
    chat_id:chatId,
    text:GROUP_NEWS_POINTER_TEXT,
    disable_notification:true,
    disable_web_page_preview:true,
    ...(Number.isSafeInteger(replyTo) && replyTo > 0 ? { reply_parameters:{ message_id:replyTo, allow_sending_without_reply:true } } : {}),
    reply_markup:{ inline_keyboard:[[{ text:'📣 Відкрити канал з новинами', url:NEWS_CHANNEL_URL }]] }
  };
}
