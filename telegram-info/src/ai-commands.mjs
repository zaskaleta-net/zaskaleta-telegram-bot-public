// AI module in Telegram (TG-RUNTIME-047), private chats only:
// - "🤖 Написати орендодавцю (ШІ)" under every listing card: a German letter
//   to the landlord from the card's own data (no personal data);
// - /scanner, then a photo or the text of an official letter: what it is,
//   the terms, the deadlines, with "Перевірте точні дані в оригіналі";
// - a question typed outside the menu that the bot could not route: an AI
//   answer instead of the "could not understand" fallback;
// - /premium (Telegram Stars, XTR), /paysupport.
// Everything is off unless AI_ASSISTANT_ENABLED is 'true'; payments also
// need AI_PREMIUM_ENABLED 'true' and the webhook subscribed to
// pre_checkout_query.
import { pilotConfig, equalSecret, readBoundedJSON } from './pilot-security.mjs';
import { rememberPrivatePrompt, forgetPrivatePrompt, readPrivatePrompt } from './runtime-keyboard.mjs';
import { answerQuestion, scanLetter, writeLandlordLetter, landlordLetterTemplate, aiAnswerText, scanAnswerText, letterText, listingFromCard, externalSafe } from './ai-assistant.mjs';
import { aiStateCall, aiLimits, cacheKey, PREMIUM_DAYS } from './ai-state.mjs';
import { privatePilotAccessAllowed } from './runtime-access.mjs';
import { housingInputPending } from './runtime-housing-state.mjs';

const STATELESS_PATH = '/telegram/stateless';
export const AI_LETTER_CALLBACK = 'ai:letter';
export const AI_LETTER_BUTTON_TEXT = '🤖 Написати орендодавцю (ШІ)';
export const PREMIUM_PAYLOAD = 'premium:30d:v1';
export const PREMIUM_PRICE_XTR = 250;
const MAX_IMAGE_BYTES = 1500000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const SCANNER_COMMAND = /^\/(?:scanner|scan)(?:@ZaskaletaInfoBot)?\s*$/iu;
const PREMIUM_COMMAND = /^\/premium(?:@ZaskaletaInfoBot)?\s*$/iu;
const PAYSUPPORT_COMMAND = /^\/paysupport(?:@ZaskaletaInfoBot)?\s*$/iu;
// The bot's own "could not understand" reply (runtime-housing-state.mjs).
const UNCLEAR_REPLY = /^Не вдалося однозначно зрозуміти запит\./u;

export const SCANNER_PROMPT = [
  '📄 Сканер листів (ШІ)',
  '',
  'Надішліть фото листа (Bescheid, Antrag, Anhörung тощо) одним повідомленням або вставте його текст.',
  '',
  'Перед фото прикрийте Kundennummer/BG-Nummer, IBAN і дату народження. Фото й текст бот не зберігає.'
].join('\n');
const SCANNER_NOT_IMAGE = '📄 Сканер приймає фото або зображення (JPG, PNG) до 1,5 МБ. PDF-файли не підтримуються: надішліть фото сторінки або вставте текст.';
const SCANNER_IMAGE_FAILED = '⚠️ Не вдалося завантажити фото. Надішліть його ще раз як фото (не файлом) або вставте текст листа.';
// TG-RUNTIME-054: no dead end. Everything in the menu works without the AI.
const NO_AI_HINT = 'Розділи меню (житло, робота, школа й Kita, новини) працюють без ШІ: /menu\nБезкоштовні консультації: /beratung';
const AI_UNAVAILABLE = `⚠️ ШІ зараз недоступний. Спробуйте пізніше.\n${NO_AI_HINT}`;
const GLOBAL_LIMIT_TEXT = `⚠️ Загальний денний ліміт ШІ бота вичерпано. Він оновиться опівночі.\n${NO_AI_HINT}`;
const LETTER_NO_CARD = '⚠️ Не вдалося прочитати дані оголошення. Відкрийте оголошення і напишіть орендодавцю через портал.';
const AI_DISABLED_NOTICE = 'Ця функція зараз вимкнена.';
const AI_OFF_TEXT = 'ШІ-функції бота (/scanner, /premium, листи орендодавцю) зараз вимкнені. Решта бота працює як завжди: /menu';
// A card's own link button. A search summary numbers its links ("1. Відкрити
// оголошення"), and so does the last text card, which reuses the search
// keyboard; a numbered link counts only on a message with a listing price line.
const CARD_LINK = /^🔗\s*Відкрити оголошення$/u;
const NUMBERED_LINK = /^\d{1,2}\.\s*Відкрити оголошення$/u;
const PRICE_LINE = /(?:^|\n)\s*💶\s*(?:<b>)?\s*\d/u;

function listingLink(button, text) {
  if (typeof button?.url !== 'string') return false;
  const label = String(button?.text || '').trim();
  return CARD_LINK.test(label) || (NUMBERED_LINK.test(label) && PRICE_LINE.test(String(text || '')));
}
export const PAYSUPPORT_TEXT = [
  '⭐ Підтримка оплати Premium',
  '',
  'Опишіть проблему через /report: дату оплати і що сталося. Telegram-ID в повідомленні про помилку не передається, тому вкажіть також своє ім’я користувача Telegram, якщо хочете відповіді.',
  '',
  'Оплата проходить через Telegram Stars; банківських даних бот не отримує.'
].join('\n');

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

export function aiEnabled(env) {
  return env?.AI_ASSISTANT_ENABLED === 'true';
}

export function premiumEnabled(env) {
  return aiEnabled(env) && env?.AI_PREMIUM_ENABLED === 'true';
}

// Every Telegram call of the AI paths is bounded, so one hanging call cannot
// hold a background task past its 30 s window (TG-RUNTIME-053). The timer
// also covers a transport that ignores the abort signal.
const TELEGRAM_TIMEOUT_MS = 3000;

async function telegram(config, method, payload, transport) {
  const controller = new AbortController();
  let timer;
  try {
    const call = (async () => {
      const response = await transport(`https://api.telegram.org/bot${config.token}/${method}`, {
        method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload), signal:controller.signal
      });
      if (!response?.ok) return null;
      const parsed = await readBoundedJSON(response, 65536);
      return parsed.error || parsed.value?.ok !== true ? null : parsed.value.result ?? true;
    })();
    call.catch(() => null);
    return await Promise.race([
      call,
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, TELEGRAM_TIMEOUT_MS); })
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// TG-RUNTIME-071: every AI screen has a way back to the menu.
const MENU_MARKUP = Object.freeze({ inline_keyboard:[[{ text:'☰ Меню', callback_data:'nav:menu' }]] });

function send(config, chatId, text, transport, extra = {}) {
  return telegram(config, 'sendMessage', { chat_id:chatId, text, link_preview_options:{ is_disabled:true }, reply_markup:MENU_MARKUP, ...extra }, transport);
}

async function authorizedUpdate(request, env) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  return parsed.error ? null : { config, update:parsed.value };
}

// chat id = user id: the owner's own private chat.
function privateMessage(update) {
  const message = update?.message;
  const chatId = Number(message?.chat?.id);
  if (message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== Number(message?.from?.id) || message?.from?.is_bot === true) return null;
  return { message, chatId };
}

function privateCallback(update) {
  const query = update?.callback_query;
  const chatId = Number(query?.message?.chat?.id);
  if (!query || query.message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== Number(query.from?.id) || query.from?.is_bot === true) return null;
  return { query, chatId };
}

function plural(n, one, few, many) {
  const tens = n % 100;
  const units = n % 10;
  if (units === 1 && tens !== 11) return one;
  if (units >= 2 && units <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

function requests(n) {
  return `${n} ${plural(n, 'запит', 'запити', 'запитів')}`;
}

// After "до" (up to) Ukrainian uses the genitive: "до 1 запиту", "до 3 запитів".
function requestsUpTo(n) {
  return `${n} ${plural(n, 'запиту', 'запитів', 'запитів')}`;
}

function limitText(env, quota) {
  if (quota?.reason === 'global_limit') return GLOBAL_LIMIT_TEXT;
  const limit = Number(quota?.limit) || 0;
  if (quota?.premium) return `⚠️ Денний ліміт Premium вичерпано (${requests(limit)}). Він оновиться опівночі.`;
  return [
    `⚠️ Безкоштовний денний ліміт ШІ вичерпано (${requests(limit)}). Він оновиться опівночі.`,
    NO_AI_HINT,
    ...(premiumEnabled(env) ? [`⭐ Premium — до ${requestsUpTo(aiLimits(env).premium)} на день: /premium`] : [])
  ].join('\n');
}

// One unit of the daily limit; a failed model call gives it back.
async function withQuota(env, chatId, now, run) {
  const limits = aiLimits(env);
  const quota = await aiStateCall(env, { op:'consume', chatId, userId:chatId, now, freeLimit:limits.free, premiumLimit:limits.premium, globalLimit:limits.global });
  if (quota?.status !== 'ok') return { status:'unavailable' };
  if (!quota.allowed) return { status:'limited', quota };
  const result = await run();
  if (result?.status !== 'ok') await aiStateCall(env, { op:'release', chatId, userId:chatId, now });
  return result?.status === 'ok' ? result : { status:'unavailable' };
}

// Only a general question is cached: the same screen as the external
// fallback (ai-assistant.mjs externalSafe).
const cacheable = externalSafe;

async function cachedOrGenerate(env, chatId, now, kind, input, run, { cache = true } = {}) {
  const key = cache ? await cacheKey(kind, input) : null;
  if (key) {
    const hit = await aiStateCall(env, { op:'cache-get', key, now });
    if (hit?.status === 'ok' && typeof hit.text === 'string' && hit.text) return { status:'ok', text:hit.text, cached:true };
  }
  const result = await withQuota(env, chatId, now, run);
  if (result.status === 'ok' && key) await aiStateCall(env, { op:'cache-put', key, text:result.text, now });
  return result;
}

function failureText(env, result) {
  return result?.status === 'limited' ? limitText(env, result.quota) : AI_UNAVAILABLE;
}

// --- Listing cards ---------------------------------------------------------

function withLetterButton(markup, chatId, text = '') {
  if (!(Number(chatId) > 0)) return null;
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : null;
  if (!rows) return null;
  const buttons = rows.flatMap(row => (Array.isArray(row) ? row : []));
  if (buttons.some(button => button?.callback_data === AI_LETTER_CALLBACK)) return null;
  // Exactly one listing link: a single card, not a list or a navigation post.
  const isLink = button => listingLink(button, text);
  const linkRows = rows.map((row, index) => (Array.isArray(row) && row.some(isLink) ? index : -1)).filter(index => index >= 0);
  const links = buttons.filter(isLink);
  if (links.length !== 1 || linkRows.length !== 1) return null;
  let at = linkRows[0] + 1;
  // Keep the card's own Jobcenter button right under its link.
  if (Array.isArray(rows[at]) && rows[at].some(button => /^jc:/u.test(String(button?.callback_data || '')))) at += 1;
  const next = rows.map(row => (Array.isArray(row) ? [...row] : row));
  next.splice(at, 0, [{ text:AI_LETTER_BUTTON_TEXT, callback_data:AI_LETTER_CALLBACK }]);
  return { ...markup, inline_keyboard:next };
}

// Adds the letter button to every listing card the bot sends in a private
// chat, whatever path built the card (search, pages, whole Kreis, photos).
export function aiCardButtonTransport(transport, env) {
  if (!aiEnabled(env)) return transport;
  return async (url, options = {}) => {
    const method = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(sendMessage|sendPhoto|editMessageReplyMarkup)$/u.exec(String(url))?.[1];
    if (!method || !options?.body) return transport(url, options);
    if (typeof options.body === 'string') {
      let payload;
      try { payload = JSON.parse(options.body); } catch { return transport(url, options); }
      const markup = withLetterButton(payload?.reply_markup, payload?.chat_id, payload?.text ?? payload?.caption);
      return markup ? transport(url, { ...options, body:JSON.stringify({ ...payload, reply_markup:markup }) }) : transport(url, options);
    }
    if (typeof FormData !== 'undefined' && options.body instanceof FormData) {
      const raw = options.body.get('reply_markup');
      let markup = null;
      try { markup = typeof raw === 'string' ? withLetterButton(JSON.parse(raw), options.body.get('chat_id'), options.body.get('caption')) : null; } catch {}
      if (!markup) return transport(url, options);
      const form = new FormData();
      for (const [name, value] of options.body.entries()) form.append(name, name === 'reply_markup' ? JSON.stringify(markup) : value);
      return transport(url, { ...options, body:form });
    }
    return transport(url, options);
  };
}

// The button belongs to a listing card: the pressed message itself carries
// exactly one listing link.
function isListingCard(message) {
  const buttons = (Array.isArray(message?.reply_markup?.inline_keyboard) ? message.reply_markup.inline_keyboard : []).flatMap(row => (Array.isArray(row) ? row : []));
  const text = message?.text ?? message?.caption;
  return buttons.filter(button => listingLink(button, text)).length === 1;
}

async function landlordLetter(config, env, query, chatId, now, transport) {
  if (!isListingCard(query.message)) {
    await telegram(config, 'answerCallbackQuery', { callback_query_id:query.id, text:LETTER_NO_CARD }, transport);
    return json({ ok:true, mode:'ai-letter-v1', delivered:false, source:'no_card' });
  }
  await telegram(config, 'answerCallbackQuery', { callback_query_id:query.id, text:'✍️ Готую лист…' }, transport);
  const reply = Number.isSafeInteger(query.message?.message_id)
    ? { reply_parameters:{ message_id:query.message.message_id, allow_sending_without_reply:true } }
    : {};
  const listing = listingFromCard(query.message?.text || query.message?.caption);
  if (!listing) {
    const sent = await send(config, chatId, LETTER_NO_CARD, transport, reply);
    return json({ ok:true, mode:'ai-letter-v1', delivered:Boolean(sent), source:'no_card' });
  }
  // The typing indicator is cosmetic: not waited for.
  telegram(config, 'sendChatAction', { chat_id:chatId, action:'typing' }, transport);
  const result = await cachedOrGenerate(env, chatId, now, 'letter', listing, () => writeLandlordLetter(env, listing, transport));
  const text = result.status === 'ok'
    ? letterText(result.text)
    : `${letterText(landlordLetterTemplate(listing), { template:true })}${result.status === 'limited' ? `\n\n${limitText(env, result.quota)}` : ''}`;
  const sent = await send(config, chatId, text, transport, reply);
  return json({ ok:true, mode:'ai-letter-v1', delivered:Boolean(sent), source:result.status === 'ok' ? (result.cached ? 'cache' : 'ai') : 'template' });
}

// --- Letter scanner ---------------------------------------------------------

function imageCandidate(message) {
  if (Array.isArray(message?.photo) && message.photo.length) {
    const sizes = message.photo
      .filter(size => typeof size?.file_id === 'string' && (!Number.isFinite(size.file_size) || size.file_size <= MAX_IMAGE_BYTES))
      .sort((a, b) => (Number(a.width) || 0) - (Number(b.width) || 0));
    const best = sizes.at(-1);
    return best ? { fileId:best.file_id, type:'image/jpeg' } : { tooLarge:true };
  }
  const document = message?.document;
  if (document) {
    const type = String(document.mime_type || '').toLowerCase();
    if (!IMAGE_TYPES.has(type) || typeof document.file_id !== 'string') return { unsupported:true };
    if (Number.isFinite(document.file_size) && document.file_size > MAX_IMAGE_BYTES) return { tooLarge:true };
    return { fileId:document.file_id, type };
  }
  return null;
}

function base64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function downloadImage(config, candidate, transport) {
  const file = await telegram(config, 'getFile', { file_id:candidate.fileId }, transport);
  const path = typeof file?.file_path === 'string' ? file.file_path : '';
  if (!/^[A-Za-z0-9_./-]{1,256}$/u.test(path) || path.includes('..')) return null;
  if (Number.isFinite(file?.file_size) && file.file_size > MAX_IMAGE_BYTES) return null;
  try {
    const response = await transport(`https://api.telegram.org/file/bot${config.token}/${path}`, { method:'GET', signal:AbortSignal.timeout(6000) });
    if (!response?.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    const type = /\.png$/iu.test(path) ? 'image/png' : /\.webp$/iu.test(path) ? 'image/webp' : candidate.type;
    return `data:${type};base64,${base64(bytes)}`;
  } catch {
    return null;
  }
}

async function scanReply(config, env, chatId, now, transport, input, replyTo) {
  // The typing indicator is cosmetic: not waited for.
  telegram(config, 'sendChatAction', { chat_id:chatId, action:'typing' }, transport);
  // A person's letter is never cached.
  const result = await cachedOrGenerate(env, chatId, now, 'scan', '', () => scanLetter(env, input, transport), { cache:false });
  const text = result.status === 'ok' ? scanAnswerText(result.text) : failureText(env, result);
  const sent = await send(config, chatId, text, transport, Number.isSafeInteger(replyTo) ? { reply_parameters:{ message_id:replyTo, allow_sending_without_reply:true } } : {});
  return json({ ok:true, mode:'ai-scan-v1', delivered:Boolean(sent), source:result.status });
}

async function scanImage(config, env, message, chatId, now, transport) {
  await forgetPrivatePrompt(env, chatId, now).catch(() => null);
  const candidate = imageCandidate(message);
  if (!candidate?.fileId) {
    const sent = await send(config, chatId, candidate?.unsupported || candidate?.tooLarge ? SCANNER_NOT_IMAGE : SCANNER_IMAGE_FAILED, transport);
    return json({ ok:true, mode:'ai-scan-v1', delivered:Boolean(sent), source:'not_image' });
  }
  const imageDataUrl = await downloadImage(config, candidate, transport);
  if (!imageDataUrl) {
    const sent = await send(config, chatId, SCANNER_IMAGE_FAILED, transport);
    return json({ ok:true, mode:'ai-scan-v1', delivered:Boolean(sent), source:'download_failed' });
  }
  return scanReply(config, env, chatId, now, transport, { imageDataUrl }, message.message_id);
}

// --- Premium (Telegram Stars) ----------------------------------------------

function berlinDate(ms) {
  return new Intl.DateTimeFormat('de-DE', { timeZone:'Europe/Berlin', day:'2-digit', month:'2-digit', year:'numeric' }).format(new Date(ms));
}

export function premiumSoonText(env) {
  return [
    '⭐ Premium',
    '',
    'Оплата Premium ще не відкрита.',
    '',
    `Зараз безкоштовно: до ${requestsUpTo(aiLimits(env).free)} до ШІ на день — відповіді на запитання, розбір листів (/scanner) і «${AI_LETTER_BUTTON_TEXT}» під оголошеннями.`,
    'Базова допомога бота залишається безкоштовною.'
  ].join('\n');
}

export function premiumOfferText(env, status) {
  return [
    '⭐ Premium на 30 днів — 250 Telegram Stars',
    '',
    `• до ${requestsUpTo(aiLimits(env).premium)} до ШІ на день замість ${aiLimits(env).free};`,
    '• розбір листів (/scanner), відповіді на запитання, листи орендодавцю.',
    '',
    ...(status?.premium && status.until ? [`Ваш Premium діє до ${berlinDate(status.until)}; нова оплата продовжить його на 30 днів.`, ''] : []),
    'Увага: /forget видаляє всі ваші дані в боті, разом із Premium.',
    'Базова допомога бота залишається безкоштовною. Питання щодо оплати: /paysupport'
  ].join('\n');
}

async function premiumCommand(config, env, chatId, now, transport) {
  if (!premiumEnabled(env)) {
    const sent = await send(config, chatId, premiumSoonText(env), transport);
    return json({ ok:true, mode:'ai-premium-v1', delivered:Boolean(sent), source:'not_open' });
  }
  const status = await aiStateCall(env, { op:'premium-status', chatId, userId:chatId, now });
  await send(config, chatId, premiumOfferText(env, status?.status === 'ok' ? status : null), transport);
  const invoice = await telegram(config, 'sendInvoice', {
    chat_id:chatId,
    title:'Premium на 30 днів',
    description:`До ${requestsUpTo(aiLimits(env).premium)} до ШІ на день протягом 30 днів.`,
    payload:PREMIUM_PAYLOAD,
    currency:'XTR',
    // Telegram Stars take an empty provider token.
    provider_token:'',
    prices:[{ label:'Premium 30 днів', amount:PREMIUM_PRICE_XTR }]
  }, transport);
  return json({ ok:true, mode:'ai-premium-v1', delivered:Boolean(invoice), source:'invoice' });
}

async function preCheckout(config, env, query, transport) {
  const valid = premiumEnabled(env)
    && query?.invoice_payload === PREMIUM_PAYLOAD
    && query?.currency === 'XTR'
    && Number(query?.total_amount) === PREMIUM_PRICE_XTR
    && Number.isSafeInteger(Number(query?.from?.id)) && Number(query.from.id) > 0;
  // Telegram waits at most 10 seconds for this answer.
  const answered = await telegram(config, 'answerPreCheckoutQuery', valid
    ? { pre_checkout_query_id:query.id, ok:true }
    : { pre_checkout_query_id:query.id, ok:false, error_message:'Оплата Premium зараз недоступна. Спробуйте пізніше або напишіть /paysupport.' }, transport);
  return json({ ok:true, mode:'ai-premium-v1', delivered:Boolean(answered), source:valid ? 'pre_checkout_ok' : 'pre_checkout_rejected' });
}

async function successfulPayment(config, env, message, chatId, now, transport) {
  const payment = message.successful_payment;
  const valid = payment?.invoice_payload === PREMIUM_PAYLOAD && payment?.currency === 'XTR' && Number(payment?.total_amount) === PREMIUM_PRICE_XTR;
  const granted = valid
    ? await aiStateCall(env, { op:'premium-grant', chatId, userId:chatId, chargeId:String(payment.telegram_payment_charge_id || ''), amount:Number(payment.total_amount), now })
    : null;
  const ok = granted?.status === 'ok' && Number.isSafeInteger(granted.until);
  // Fixed fields only; no ids.
  console.info('TELEGRAM_PREMIUM_PAYMENT', JSON.stringify({ status:ok ? 'granted' : valid ? 'grant_failed' : 'invalid' }));
  const text = ok
    ? `✅ Premium активовано до ${berlinDate(granted.until)} (${PREMIUM_DAYS} днів). Дякуємо!\n\nЛіміт ШІ: до ${requestsUpTo(aiLimits(env).premium)} на день.`
    : '⚠️ Оплату отримано, але Premium не вдалося активувати автоматично. Напишіть, будь ласка, /paysupport — ми це виправимо.';
  const sent = await send(config, chatId, text, transport);
  return json({ ok:true, mode:'ai-premium-v1', delivered:Boolean(sent), source:ok ? 'granted' : 'grant_failed' });
}

// --- Entry points -----------------------------------------------------------

// Payments run before the maintenance gate: a paid Premium is never lost to
// a maintenance reply.
export async function aiPaymentUpdate(request, env, now = Date.now(), transport = fetch) {
  const authorized = await authorizedUpdate(request, env);
  if (!authorized) return null;
  const { config, update } = authorized;
  if (update?.pre_checkout_query) return preCheckout(config, env, update.pre_checkout_query, transport);
  const own = privateMessage(update);
  if (own?.message?.successful_payment) return successfulPayment(config, env, own.message, own.chatId, now, transport);
  return null;
}

// Commands, the card button and photos for the scanner. Runs before the
// saved prompt context is applied.
export async function aiCommand(request, env, now = Date.now(), transport = fetch) {
  const authorized = await authorizedUpdate(request, env);
  if (!authorized) return null;
  const { config, update } = authorized;
  // In allowlist mode only pilot users reach the model; the normal flow
  // answers everyone else.
  if (aiEnabled(env) && !(await privatePilotAccessAllowed(update, config, transport))) return null;

  const callback = privateCallback(update);
  if (callback?.query?.data === AI_LETTER_CALLBACK) {
    if (!aiEnabled(env)) {
      await telegram(config, 'answerCallbackQuery', { callback_query_id:callback.query.id, text:AI_DISABLED_NOTICE }, transport);
      return json({ ok:true, mode:'ai-letter-v1', delivered:false, source:'disabled' });
    }
    return landlordLetter(config, env, callback.query, callback.chatId, now, transport);
  }

  const own = privateMessage(update);
  if (!own) return null;
  const { message, chatId } = own;
  const text = String(message.text || '').trim();
  if (!aiEnabled(env)) {
    // People may still type these commands (the command menu hides them while
    // switched off, bot-command-sync.mjs); the kill switch answers them.
    if (!SCANNER_COMMAND.test(text) && !PREMIUM_COMMAND.test(text) && !PAYSUPPORT_COMMAND.test(text)) return null;
    const sent = await send(config, chatId, AI_OFF_TEXT, transport);
    return json({ ok:true, mode:'ai-off-v1', delivered:Boolean(sent) });
  }

  if (PAYSUPPORT_COMMAND.test(text)) {
    const sent = await send(config, chatId, PAYSUPPORT_TEXT, transport);
    return json({ ok:true, mode:'ai-premium-v1', delivered:Boolean(sent), source:'paysupport' });
  }
  if (PREMIUM_COMMAND.test(text)) return premiumCommand(config, env, chatId, now, transport);
  if (SCANNER_COMMAND.test(text)) {
    const sent = await send(config, chatId, SCANNER_PROMPT, transport);
    if (sent) await rememberPrivatePrompt(env, chatId, SCANNER_PROMPT, now).catch(() => null);
    return json({ ok:true, mode:'ai-scan-v1', delivered:Boolean(sent), source:'prompt' });
  }

  if (message.photo || message.document) {
    const caption = String(message.caption || '').trim();
    const asked = SCANNER_COMMAND.test(caption)
      || message.reply_to_message?.text === SCANNER_PROMPT
      || (await readPrivatePrompt(env, chatId, now).catch(() => null)) === SCANNER_PROMPT;
    if (asked) return scanImage(config, env, message, chatId, now, transport);
  }
  return null;
}

// The two slow AI paths (a photo of a letter, the landlord letter) are
// answered after the webhook returns: the webhook delivers one update at a
// time (max_connections 1), so a model call must not hold the queue.
export async function isAiBackgroundRequest(request, env, now = Date.now()) {
  if (!aiEnabled(env)) return false;
  const authorized = await authorizedUpdate(request, env);
  if (!authorized) return false;
  if (privateCallback(authorized.update)?.query?.data === AI_LETTER_CALLBACK) return true;
  const own = privateMessage(authorized.update);
  if (!own) return false;
  const text = String(own.message.text || '').trim();
  const media = Boolean(own.message.photo || own.message.document);
  // A photo, or a pasted letter (not a command), answering the scanner prompt.
  if (!media && (!text || text.startsWith('/'))) return false;
  if (media && SCANNER_COMMAND.test(String(own.message.caption || '').trim())) return true;
  return own.message.reply_to_message?.text === SCANNER_PROMPT
    || (await readPrivatePrompt(env, own.chatId, now).catch(() => null)) === SCANNER_PROMPT;
}

// The text of a letter typed or pasted after /scanner (a reply to the prompt
// or the saved prompt context). Runs after preparePrivatePromptContext.
export async function aiPromptedScan(request, env, now = Date.now(), transport = fetch) {
  if (!aiEnabled(env)) return null;
  const authorized = await authorizedUpdate(request, env);
  const own = authorized ? privateMessage(authorized.update) : null;
  const text = String(own?.message?.text || '').trim();
  if (!own || !text || text.startsWith('/') || own.message.reply_to_message?.text !== SCANNER_PROMPT) return null;
  if (!(await privatePilotAccessAllowed(authorized.update, authorized.config, transport))) return null;
  return scanReply(authorized.config, env, own.chatId, now, transport, { text }, own.message.message_id);
}

// A question rather than a typo: several words, enough letters.
function looksLikeQuestion(text) {
  const value = String(text || '').trim();
  return value.length >= 12 && value.length <= 4000 && !value.startsWith('/') && /\S\s+\S/u.test(value) && (value.match(/\p{L}/gu) || []).length >= 8;
}

// When the bot would answer a private free-text question with its "could not
// understand" fallback, the AI answers instead. The dialogue state is
// recorded from the original fallback before this transport sees it.
export async function aiFreeTextTransport(request, env, now, transport) {
  if (!aiEnabled(env)) return transport;
  const authorized = await authorizedUpdate(request, env);
  const own = authorized ? privateMessage(authorized.update) : null;
  const question = String(own?.message?.text || '').trim();
  if (!own || !looksLikeQuestion(question)) return transport;
  if (!(await privatePilotAccessAllowed(authorized.update, authorized.config, transport))) return transport;
  let used = false;
  return async (url, options = {}) => {
    if (used || !/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/u.test(String(url)) || typeof options?.body !== 'string') return transport(url, options);
    let payload;
    try { payload = JSON.parse(options.body); } catch { return transport(url, options); }
    if (Number(payload?.chat_id) !== own.chatId || !UNCLEAR_REPLY.test(String(payload?.text || '').trim())) return transport(url, options);
    used = true;
    // Inside a housing step the same text is a retry prompt; it stays.
    if (await housingInputPending(env, own.chatId, now).catch(() => false)) return transport(url, options);
    const result = await cachedOrGenerate(env, own.chatId, now, 'question', question, () => answerQuestion(env, question, transport), { cache:cacheable(question) });
    if (result.status !== 'ok' && result.status !== 'limited') return transport(url, options);
    const next = { ...payload, text:result.status === 'ok' ? aiAnswerText(result.text) : `${limitText(env, result.quota)}\n\n${payload.text}` };
    delete next.parse_mode;
    delete next.entities;
    return transport(url, { ...options, body:JSON.stringify(next) });
  };
}
