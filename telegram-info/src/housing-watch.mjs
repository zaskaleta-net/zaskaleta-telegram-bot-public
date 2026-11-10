// Housing monitor (TG-RUNTIME-056/057): a saved radius or whole-Kreis search that the hourly
// cron re-runs; the user gets only listings not shown to them before. No AI.
//
// Workers Free allows 50 external subrequests per invocation and one housing
// search takes about 30, so each search runs in its own Durable Object
// invocation ("run" objects), and the shared object then sends the messages.
// Identical searches of several users are run once. One search per user,
// kept for 30 days (renewed by pressing the button again).
import { pilotConfig, equalSecret, readBoundedJSON, isAllowedPilotChat, isPilotAdmin } from './pilot-security.mjs';
import { subrequestBudgetTransport } from './subrequest-budget.mjs';
import { maintenanceEnabled } from './runtime-maintenance.mjs';
import { privatePilotAccessAllowed } from './runtime-access.mjs';
import { resolveJobcenterRule } from './jobcenter-registry-statewide.mjs';
import { housingWatchSearch, listingStateKey } from './runtime-jobcenter-base.mjs';
import { formatEuro } from './listing-format.mjs';
import { crossPortalSeenKey } from './listing-dedup.mjs';
import { fetchKleinanzeigenAdCosts, kleinanzeigenAdId, adCostsLine, adCostsOverLimit } from './kleinanzeigen-ad-costs.mjs';
import { downloadListingPhoto, sendListingPhotos, PHOTO_MISSING_NOTE, PHOTO_FAILED_NOTE } from './telegram-media.mjs';

export const HOUSING_WATCH_PREFIX = 'telegram-housing-watch:v1:';
export const HOUSING_WATCH_PATH = '/housing-watch';
export const HOUSING_WATCH_RUN_PATH = '/housing-watch-run';
export const HOUSING_WATCH_CALLBACK_PREFIX = 'jcw:';
const WATCH_CALLBACK = /^jcw:(15|20|25|d):(\d{1,2}):(\d{1,2}(?:-\d{1,2})?):(.{1,48})$/u;
const WATCH_OFF_CALLBACK = 'jcw:off';
// TG-RUNTIME-083: a watch ended silently after 30 days. Two days before the
// end the user gets one reminder with "Продовжити"; it adds 30 days.
const WATCH_RENEW_CALLBACK = 'jcw:renew';
const REMIND_BEFORE_MS = 2 * 24 * 60 * 60 * 1000;
const REMINDERS_PER_RUN = 10;
const RADIUS_CALLBACK = /^jcr:(15|20|25):(\d{1,2}):(\d{1,2}(?:-\d{1,2})?):(.{1,48})$/u;
// TG-RUNTIME-057: the whole-Kreis search ("🗺 Шукати весь район").
const DISTRICT_CALLBACK = /^jcd:(\d{1,2}):(\d{1,2}(?:-\d{1,2})?):(.{1,48})$/u;
export const KREIS = 'kreis';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
export const WATCH_DAYS = 30;
const HOUR = 60 * MINUTE;
// TG-RUNTIME-058: the user chooses how often (owner request 18.10.2026:
// new flats are gone fast, so from 15 minutes). The cron runs every 15
// minutes (wrangler.jsonc, HOUSING_WATCH_CRON in runtime.mjs); each gap is
// 5 minutes shorter than the interval so cron jitter does not skip a run.
// The daily time is Berlin time; its slot stays open three hours, so a busy
// or failed cron run is made up by a later one.
export const WATCH_INTERVALS = Object.freeze({
  m15:Object.freeze({ label:'кожні 15 хвилин', button:'⚡ Кожні 15 хв', minGap:10 * MINUTE }),
  m30:Object.freeze({ label:'кожні 30 хвилин', button:'🔔 Кожні 30 хв', minGap:25 * MINUTE }),
  h1:Object.freeze({ label:'щогодини', button:'⏱ Щогодини', minGap:55 * MINUTE }),
  h3:Object.freeze({ label:'кожні 3 години', button:'🕒 Кожні 3 год', minGap:3 * HOUR - 5 * MINUTE }),
  daily:Object.freeze({ label:'раз на день (8:00)', button:'🌅 Раз на день', hours:[8] })
});
const DEFAULT_INTERVAL = 'm15';
const SLOT_HOURS = 3;
const INTERVAL_CALLBACK = /^jcw:i:(m15|m30|h1|h3|daily)$/u;
// No sound at night: the message arrives silently and waits for the morning.
const QUIET_FROM = 22;
const QUIET_UNTIL = 7;

export function berlinHour(now) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Berlin', hour:'2-digit', hourCycle:'h23' }).format(new Date(now)));
}

function intervalOf(value) {
  return Object.hasOwn(WATCH_INTERVALS, value?.interval) ? value.interval : DEFAULT_INTERVAL;
}

// Whether a watch should run now.
export function watchDue(value, now) {
  if (!value || !(value.expiresAt > now)) return false;
  const since = now - (Number(value.lastRunAt) || 0);
  const interval = WATCH_INTERVALS[intervalOf(value)];
  if (interval.minGap) return since >= interval.minGap;
  const hour = berlinHour(now);
  const inSlot = interval.hours.some(start => hour >= start && hour < start + SLOT_HOURS);
  return inSlot && since >= SLOT_HOURS * HOUR;
}

// After a failed search or an undelivered message: an hourly or 3-hourly
// watch waits its interval; a fixed-time watch tries again within its slot.
function retryRunAt(value, now) {
  return WATCH_INTERVALS[intervalOf(value)].minGap ? now : now - (SLOT_HOURS - 1) * HOUR;
}

function quiet(now) {
  const hour = berlinHour(now);
  return hour >= QUIET_FROM || hour < QUIET_UNTIL;
}

function intervalKeyboard(current = null) {
  const button = id => ({ text:`${id === current ? '✅ ' : ''}${WATCH_INTERVALS[id].button}`, callback_data:`jcw:i:${id}` });
  return [[button('m15'), button('m30')], [button('h1'), button('h3')], [button('daily')]];
}
// Searches per cron run (each in its own invocation) and how many at once.
// The cron runs every 15 minutes, so up to 120 searches an hour; a run of
// 30 at 5 at a time takes about a minute.
const GROUPS_PER_RUN = 30;
const RUN_CONCURRENCY = 5;
// Messages one delivery call sends; the rest of the group waits an hour.
const RECIPIENTS_PER_DELIVERY = 30;
const MAX_WATCHES = 1000;
// Seen listings are kept as short hashes: one value stays small even with
// many watches listed at once.
const MAX_SEEN = 200;
// TG-RUNTIME-060: a search does not return the same listings on every run
// (sources time out, pages differ), so one silent first run missed some of
// what the user had already seen; they came later as "new" (phone check
// 19.10.2026). The watch now learns silently for 3 successful runs, or for
// at least one run once 2 hours have passed (for the slow intervals).
const WARMUP_RUNS = 3;
const WARMUP_MS = 2 * 60 * 60 * 1000;
const LISTINGS_PER_MESSAGE = 5;
// TG-RUNTIME-062: alerts carry the listing photos (one album per alert). One
// delivery call stays under the 50 external subrequests of Workers Free: each
// alert is 1 message + 1 album, each photo 1 download (shared by the group).
const DELIVERY_SUBREQUESTS = 45;
const PHOTO_TIMEOUT_MS = 5000;
// Photos stay in memory for the whole call (Workers: 128 MB, up to 5 calls at
// once), and the run waits for this call for 30 s: photos stop at 2 MB each,
// 16 MB in all and after 15 s; the text alerts still go out.
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const PHOTO_TOTAL_BYTES = 16 * 1024 * 1024;
const PHOTO_WINDOW_MS = 15000;
// TG-RUNTIME-063 (owner, 19.10.2026): Kleinanzeigen result pages show the
// Kaltmiete only, so a flat over the Bruttokaltmiete limit once Nebenkosten
// are added (Bad Oldesloe: 820 + 150 = 970 > 943,80) was sent as fitting.
// Before an alert the ad page of each new Kleinanzeigen listing is read and
// a listing over the limit is not sent (it is still remembered as seen).
// Up to 10 ad pages per delivery call, within the same 15 s window.
const AD_PAGES_PER_DELIVERY = 10;
const TELEGRAM_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 30000;

export const WATCH_BUTTON_TEXT = '🔔 Стежити за новими оголошеннями';
const ON_TEXT = (criteria) => [
  '🔔 Моніторинг увімкнено.',
  `${criteria.location}, ${areaLabel(criteria)} · осіб: ${criteria.persons} · кімнати: ${criteria.rooms}.`,
  'Бот повторює цей пошук і надсилає лише нові оголошення. Оголошення, які ви вже бачили, він запам’ятовує і не надсилає повторно; перші перевірки (до 2 годин) лише навчаються. Діє 30 днів; одна підписка на людину — новий пошук замінює попередній. Уночі (22:00–7:00) сповіщення приходять без звуку.',
  'Як часто надсилати нові оголошення?',
  'Змінити або вимкнути: /watch'
].join('\n');
const untilDate = expiresAt => new Date(expiresAt).toLocaleDateString('de-DE', { timeZone:'Europe/Berlin', day:'2-digit', month:'2-digit', year:'numeric' });
const REMIND_TEXT = (criteria, expiresAt) => [
  `⏳ Моніторинг житла закінчується ${untilDate(expiresAt)}.`,
  `${criteria.location}, ${areaLabel(criteria)} · осіб: ${criteria.persons} · кімнати: ${criteria.rooms}.`,
  'Щоб і далі отримувати нові оголошення, натисніть «Продовжити».'
].join('\n');
const RENEW_BUTTON = Object.freeze({ text:`🔁 Продовжити на ${WATCH_DAYS} днів`, callback_data:WATCH_RENEW_CALLBACK });
const OFF_TEXT = '🔕 Моніторинг вимкнено. Збережений пошук видалено.';
const NONE_TEXT = 'Моніторинг житла не увімкнено. Після пошуку житла натисніть «🔔 Стежити за новими оголошеннями».';
const MENU_ROW = Object.freeze([{ text:'☰ Меню', callback_data:'nav:menu' }]);

function withMenuRow(markup) {
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : [];
  if (markup && !Array.isArray(markup.inline_keyboard)) return markup;
  return rows.flat().some(button => button?.callback_data === 'nav:menu') ? markup : { ...(markup || {}), inline_keyboard:[...rows, MENU_ROW] };
}

const DISABLED_TEXT = 'Моніторинг житла зараз вимкнений. Пошук житла працює як завжди: /menu';
const FAILED_TEXT = '⚠️ Не вдалося зберегти моніторинг. Спробуйте пізніше.';

export function housingWatchEnabled(env) {
  return env?.HOUSING_WATCH_ENABLED === 'true';
}

function watchKey(chatId, userId) {
  return `${HOUSING_WATCH_PREFIX}${chatId}:${userId}`;
}

function decodeLocation(value) {
  try {
    const decoded = decodeURIComponent(String(value || '')).replace(/\s+/gu, ' ').trim();
    return /^\p{L}[\p{L}\p{M}.'’()/ -]{1,79}$/u.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

// Only a verified Jobcenter limit makes a watch; the search itself re-checks it.
export function watchCriteria({ radius, persons, rooms, location }) {
  const place = decodeLocation(location);
  const people = Number(persons);
  const kreis = radius === 'd' || radius === KREIS;
  const km = kreis ? KREIS : Number(radius);
  if (!place || !Number.isSafeInteger(people) || people < 1 || people > 20 || (!kreis && ![15, 20, 25].includes(km))) return null;
  if (!/^\d{1,2}(?:-\d{1,2})?$/u.test(String(rooms))) return null;
  const resolved = resolveJobcenterRule(place, people);
  const limit = Number(resolved?.rule?.grossColdLimit);
  if (resolved?.status !== 'verified' || !Number.isFinite(limit) || limit <= 0) return null;
  const jurisdiction = String(resolved?.jurisdiction || resolved?.module?.jurisdiction || '').trim();
  if (kreis && !jurisdiction) return null;
  return { location:place, persons:people, rooms:String(rooms), radius:km, ...(kreis ? { jurisdiction } : {}) };
}

export function areaLabel(criteria) {
  return criteria.radius === KREIS ? `весь район (${criteria.jurisdiction})` : `${criteria.radius} км`;
}

export function watchGroupKey(criteria) {
  return [criteria.location.toLowerCase(), criteria.persons, criteria.rooms, criteria.radius].join('|');
}

function seenId(key) {
  let a = 0x811c9dc5, b = 0x9747b28c;
  const text = String(key);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 2246822519);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

// A seen key without its portal: "x:<fingerprint>@kleinanzeigen" and the
// same flat "@wg-gesucht" give one id.
function crossId(key) {
  return typeof key === 'string' && key.startsWith('x:') ? seenId(key.split('@')[0]) : null;
}

// TG-RUNTIME-060: what the user was shown by their last search
// (runtime-jobcenter-base.mjs record_seen, kept for an hour), as seen ids.
const SEARCH_STATE_PREFIX = 'telegram-jobcenter-search-state:v1:';
const SEARCH_STATE_TTL_MS = 60 * 60 * 1000;
async function shownToUser(storage, chatId, userId, now) {
  const state = await storage.get(`${SEARCH_STATE_PREFIX}${chatId}:${userId}`);
  if (!state || !Number.isSafeInteger(state.updatedAt) || state.updatedAt < now - SEARCH_STATE_TTL_MS) return [];
  const keys = [...(Array.isArray(state.seen) ? state.seen : []), ...(Array.isArray(state.districtBaseline) ? state.districtBaseline : [])]
    .filter(key => typeof key === 'string' && key.length <= 600);
  return [...new Set(keys.map(key => crossId(key) || seenId(key)))].slice(0, MAX_SEEN);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/gu, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[char]);
}

// --- The button under a radius search -----------------------------------------

// The search controls carry the chosen radius or "весь район" as the ✅
// button; the watch button repeats its data.
function watchButtonRow(markup) {
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : null;
  if (!rows) return null;
  const buttons = rows.flat().filter(Boolean);
  if (buttons.some(button => String(button?.callback_data || '').startsWith(HOUSING_WATCH_CALLBACK_PREFIX))) return null;
  const chosen = buttons.find(button => String(button?.text || '').startsWith('✅ ') && (RADIUS_CALLBACK.test(String(button?.callback_data || '')) || DISTRICT_CALLBACK.test(String(button?.callback_data || ''))));
  if (!chosen) return null;
  const data = String(chosen.callback_data).startsWith('jcd:') ? `jcw:d:${String(chosen.callback_data).slice(4)}` : `jcw:${String(chosen.callback_data).slice(4)}`;
  if (new TextEncoder().encode(data).byteLength > 64) return null;
  return [{ text:WATCH_BUTTON_TEXT, callback_data:data }];
}

export function housingWatchButtonTransport(transport, env) {
  if (!housingWatchEnabled(env)) return transport;
  return async (url, options = {}) => {
    const method = /\/bot[^/]+\/([A-Za-z]+)$/u.exec(String(url))?.[1];
    if ((method === 'sendMessage' || method === 'editMessageText' || method === 'editMessageReplyMarkup') && typeof options?.body === 'string') {
      try {
        const body = JSON.parse(options.body);
        const row = Number(body?.chat_id) > 0 ? watchButtonRow(body.reply_markup) : null;
        if (row) {
          body.reply_markup = { inline_keyboard:[...body.reply_markup.inline_keyboard, row] };
          return transport(url, { ...options, body:JSON.stringify(body) });
        }
      } catch {}
    }
    return transport(url, options);
  };
}

// --- Telegram ------------------------------------------------------------------

async function telegram(config, method, payload, transport) {
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/${method}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(payload),
      signal:AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
    });
    const parsed = await readBoundedJSON(response, 65536);
    return { status:response.status, ok:response.ok && parsed.value?.ok === true, description:String(parsed.value?.description || '').slice(0, 200) };
  } catch {
    return { status:0, ok:false };
  }
}

// --- State (shared Durable Object) ---------------------------------------------

export async function housingWatchCall(env, payload) {
  if (!env?.OUTBOX) return { status:'unavailable' };
  try {
    const stub = env.OUTBOX.get(env.OUTBOX.idFromName('telegram-pilot-v1'));
    const response = await stub.fetch(`https://outbox.internal${HOUSING_WATCH_PATH}`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload), signal:AbortSignal.timeout(CALL_TIMEOUT_MS)
    });
    const parsed = await readBoundedJSON(response, 262144);
    return response.ok && !parsed.error ? parsed.value : { status:'unavailable' };
  } catch {
    return { status:'unavailable' };
  }
}

function validCriteria(value) {
  return value && typeof value === 'object' ? watchCriteria({ ...value, location:encodeURIComponent(String(value.location || '')) }) : null;
}

export function compactListing(item) {
  const key = listingStateKey(item);
  const url = String(item?.url || '');
  if (!key || !/^https:\/\//u.test(url)) return null;
  return {
    key:key.slice(0, 600),
    // The same flat on another portal (listing-dedup.mjs).
    cross:String(crossPortalSeenKey(item) || '').slice(0, 300) || null,
    url:url.slice(0, 600),
    title:String(item?.title || '').slice(0, 120),
    price:Number.isFinite(Number(item?.price)) ? Number(item.price) : null,
    rooms:item?.rooms == null ? null : String(item.rooms).slice(0, 8),
    areaSqm:Number.isFinite(Number(item?.areaSqm)) ? Number(item.areaSqm) : null,
    location:String(item?.location || '').slice(0, 80),
    imageUrl:/^https:\/\//u.test(String(item?.imageUrl || '')) ? String(item.imageUrl).slice(0, 600) : null,
    limit:Number.isFinite(Number(item?.limit)) && Number(item.limit) > 0 ? Number(item.limit) : null,
    priceType:String(item?.priceType || '').slice(0, 40)
  };
}

function listingFacts(item) {
  return [
    item.price != null ? `${formatEuro(item.price)} €` : null,
    item.rooms ? `${escapeHtml(item.rooms)} кімн.` : null,
    item.areaSqm != null ? `${item.areaSqm} м²` : null,
    item.location ? escapeHtml(item.location) : null
  ].filter(Boolean).join(' · ');
}

function photoCaption(item, index) {
  const facts = listingFacts(item);
  return `<b>${index + 1}.</b> <a href="${escapeHtml(item.url)}">${escapeHtml(item.title || 'Оголошення')}</a>${facts ? `\n${facts}` : ''}`;
}

// photoState(item): 'missing' (the site has none), 'failed' (not loaded) or
// anything else (the photo follows in the album).
export function watchMessage(criteria, listings, photoState = item => (item.imageUrl ? 'album' : 'missing')) {
  const lines = [`🔔 Нові оголошення — ${escapeHtml(criteria.location)}, ${escapeHtml(areaLabel(criteria))}`, ''];
  listings.slice(0, LISTINGS_PER_MESSAGE).forEach((item, index) => {
    const facts = listingFacts(item);
    const state = photoState(item);
    const note = state === 'missing' ? PHOTO_MISSING_NOTE : state === 'failed' ? PHOTO_FAILED_NOTE : null;
    const costs = adCostsLine(item);
    lines.push(`${index + 1}. <a href="${escapeHtml(item.url)}">${escapeHtml(item.title || 'Оголошення')}</a>${facts ? `\n${facts}` : ''}${costs ? `\n${escapeHtml(costs)}` : ''}${note ? `\n${note}` : ''}`);
  });
  if (listings.length > LISTINGS_PER_MESSAGE) lines.push('', `Ще нових: ${listings.length - LISTINGS_PER_MESSAGE}. Повторіть пошук у меню «🏠 Житло».`);
  lines.push('', '⚠️ Це кандидати, а не Zusicherung: Kaltmiete + Betriebskosten перевіряйте в кожному оголошенні.', 'Вимкнути: /watch');
  return lines.join('\n');
}

async function listWatches(storage) {
  const entries = await storage.list({ prefix:HOUSING_WATCH_PREFIX, limit:MAX_WATCHES });
  return [...entries];
}

// Durable Object side: set / get / delete / plan / deliver.
export async function handleHousingWatchStorage(request, outbox, { transport = fetch } = {}) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== HOUSING_WATCH_PATH) return null;
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
  const parsed = await readBoundedJSON(request.clone(), 262144);
  const body = parsed.error ? null : parsed.value;
  const now = Number(body?.now);
  const storage = outbox?.ctx?.storage || outbox?.householdContextStorage;
  if (!storage) return reply({ ok:false, status:'storage_unavailable' }, 503);
  if (!body || !Number.isSafeInteger(now) || now <= 0) return reply({ ok:false, status:'bad_operation' }, 400);
  const chatId = Number(body.chatId);
  const userId = Number(body.userId);
  const person = Number.isSafeInteger(chatId) && chatId > 0 && chatId === userId;

  if (body.op === 'set') {
    const criteria = validCriteria(body.criteria);
    if (!person || !criteria) return reply({ ok:false, status:'bad_operation' }, 400);
    const key = watchKey(chatId, userId);
    const previous = await storage.get(key);
    if (!previous && (await listWatches(storage)).length >= MAX_WATCHES) return reply({ ok:true, status:'full' });
    const same = previous && watchGroupKey(previous.criteria) === watchGroupKey(criteria);
    const interval = previous && previous.expiresAt > now ? intervalOf(previous) : DEFAULT_INTERVAL;
    // The user has just seen this search: the first runs only record what
    // is there (WARMUP_RUNS), so they get listings that appear afterwards.
    const shown = await shownToUser(storage, chatId, userId, now);
    const kept = same && Array.isArray(previous.seen) ? previous.seen : [];
    await storage.put(key, {
      criteria,
      seen:[...new Set([...shown, ...kept])].slice(0, MAX_SEEN),
      baseline:same ? previous.baseline === true : false,
      warmupRuns:same ? Number(previous.warmupRuns) || 0 : 0,
      createdAt:same ? previous.createdAt : now,
      updatedAt:now,
      expiresAt:now + WATCH_DAYS * DAY,
      lastRunAt:same ? previous.lastRunAt || 0 : 0,
      // TG-RUNTIME-083: the chosen interval is the user's setting; a new
      // search no longer resets it to 15 minutes.
      interval
    });
    return reply({ ok:true, status:'ok', criteria, interval });
  }
  if (body.op === 'interval') {
    if (!person || !Object.hasOwn(WATCH_INTERVALS, body.interval)) return reply({ ok:false, status:'bad_operation' }, 400);
    const key = watchKey(chatId, userId);
    const value = await storage.get(key);
    if (!value || !(value.expiresAt > now)) return reply({ ok:true, status:'none' });
    // updatedAt stays: a delivery running now still records what it sent
    // (it writes the re-read value, so the new interval is kept).
    await storage.put(key, { ...value, interval:body.interval });
    return reply({ ok:true, status:'ok', interval:body.interval });
  }
  if (body.op === 'renew') {
    if (!person) return reply({ ok:false, status:'bad_operation' }, 400);
    const key = watchKey(chatId, userId);
    const value = await storage.get(key);
    if (!value || !(value.expiresAt > now)) return reply({ ok:true, status:'none' });
    const { remindedAt:_reminded, ...rest } = value;
    const expiresAt = now + WATCH_DAYS * DAY;
    await storage.put(key, { ...rest, expiresAt });
    return reply({ ok:true, status:'ok', expiresAt });
  }
  if (body.op === 'remind') {
    const config = outbox?.env ? pilotConfig(outbox.env) : null;
    if (!config?.token) return reply({ ok:true, status:'ok', reminded:0 });
    let reminded = 0;
    for (const [key, value] of await listWatches(storage)) {
      if (reminded >= REMINDERS_PER_RUN) break;
      if (!(value?.expiresAt > now) || value.expiresAt - now > REMIND_BEFORE_MS || value.remindedAt) continue;
      const criteria = validCriteria(value.criteria);
      const chatId = Number(key.slice(HOUSING_WATCH_PREFIX.length).split(':')[0]);
      if (!criteria || (!isAllowedPilotChat(config, chatId) && !isPilotAdmin(config, chatId))) continue;
      // Review #083: re-read right before the write (no network call in
      // between). An earlier send let "off", /forget, a new search or a
      // delivery change the watch; the list copy must not be written back.
      const current = await storage.get(key);
      if (!current || current.updatedAt !== value.updatedAt || current.remindedAt || !(current.expiresAt > now) || current.expiresAt - now > REMIND_BEFORE_MS) continue;
      // Marked first: a failed or slow message is not sent again every run.
      await storage.put(key, { ...current, remindedAt:now });
      reminded += 1;
      await telegram(config, 'sendMessage', {
        chat_id:chatId,
        text:REMIND_TEXT(criteria, current.expiresAt),
        disable_web_page_preview:true,
        ...(quiet(now) ? { disable_notification:true } : {}),
        reply_markup:withMenuRow({ inline_keyboard:[[RENEW_BUTTON], [{ text:'🔕 Вимкнути моніторинг', callback_data:WATCH_OFF_CALLBACK }]] })
      }, transport);
    }
    return reply({ ok:true, status:'ok', reminded });
  }
  if (body.op === 'get') {
    if (!person) return reply({ ok:false, status:'bad_operation' }, 400);
    const value = await storage.get(watchKey(chatId, userId));
    return reply({ ok:true, status:'ok', watch:value && value.expiresAt > now ? { criteria:value.criteria, expiresAt:value.expiresAt, interval:intervalOf(value) } : null });
  }
  if (body.op === 'delete') {
    if (!person) return reply({ ok:false, status:'bad_operation' }, 400);
    const deleted = await storage.delete(watchKey(chatId, userId));
    return reply({ ok:true, status:'ok', deleted:Boolean(deleted) });
  }
  if (body.op === 'plan') {
    const groups = new Map();
    for (const [, value] of await listWatches(storage)) {
      if (!watchDue(value, now)) continue;
      const criteria = validCriteria(value.criteria);
      if (!criteria) continue;
      const group = watchGroupKey(criteria);
      const due = Number(value.lastRunAt) || 0;
      const current = groups.get(group);
      if (!current || due < current.due) groups.set(group, { group, criteria, due });
    }
    const due = [...groups.values()].sort((a, b) => a.due - b.due).slice(0, GROUPS_PER_RUN).map(({ group, criteria }) => ({ group, criteria }));
    return reply({ ok:true, status:'ok', groups:due });
  }
  if (body.op === 'deliver') {
    const criteria = validCriteria(body.criteria);
    const failedSearch = body.failed === true;
    if (!criteria || body.group !== watchGroupKey(criteria) || (!failedSearch && !Array.isArray(body.listings))) return reply({ ok:false, status:'bad_operation' }, 400);
    const listings = failedSearch ? [] : body.listings.map(item => (item && typeof item.key === 'string' && /^https:\/\//u.test(String(item.url || '')) ? { ...item, id:seenId(item.key), crossId:crossId(item.cross) } : null)).filter(Boolean).slice(0, 60);
    const config = outbox?.env ? pilotConfig(outbox.env) : null;
    let sent = 0, baselined = 0, removed = 0, recipients = 0, waited = 0, albums = 0, overLimitSkipped = 0, adPages = 0;
    const adCosts = new Map();
    // Ad page costs, once per listing per call; null when not read.
    const costsFor = async item => {
      if (!kleinanzeigenAdId(item.url) || !Number.isFinite(item.limit) || /warm/iu.test(item.priceType || '')) return null;
      if (!adCosts.has(item.url)) {
        // Over the page budget: shown, with a note that it was not checked.
        if (adPages >= AD_PAGES_PER_DELIVERY || external >= DELIVERY_SUBREQUESTS - 2 || Date.now() >= photoUntil) return { unchecked:true };
        adPages += 1;
        external += 1;
        adCosts.set(item.url, (await fetchKleinanzeigenAdCosts(item.url, transport, AbortSignal.timeout(PHOTO_TIMEOUT_MS))) || { unchecked:true });
      }
      return adCosts.get(item.url);
    };
    let external = 0;
    let photoBytes = 0;
    const photoUntil = Date.now() + PHOTO_WINDOW_MS;
    const photos = new Map();
    // One download per photo per delivery call; null when it did not load.
    const photoFor = async item => {
      if (!item.imageUrl) return null;
      if (!photos.has(item.imageUrl)) {
        if (external >= DELIVERY_SUBREQUESTS - 2 || photoBytes >= PHOTO_TOTAL_BYTES || Date.now() >= photoUntil) return null;
        external += 1;
        const photo = await downloadListingPhoto(item.imageUrl, transport, AbortSignal.timeout(PHOTO_TIMEOUT_MS), Math.min(PHOTO_MAX_BYTES, PHOTO_TOTAL_BYTES - photoBytes));
        photoBytes += photo?.bytes?.byteLength || 0;
        photos.set(item.imageUrl, photo);
      }
      return photos.get(item.imageUrl);
    };
    for (const [key, listed] of await listWatches(storage)) {
      if (recipients >= RECIPIENTS_PER_DELIVERY) break;
      if (!watchDue(listed, now)) continue;
      const own = validCriteria(listed.criteria);
      if (!own || watchGroupKey(own) !== body.group) continue;
      const chatId = Number(key.slice(HOUSING_WATCH_PREFIX.length).split(':')[0]);
      // The value as it is now: /forget, "off" or a new search may have
      // changed it while an earlier message was being sent.
      const unchanged = async () => {
        const current = await storage.get(key);
        return current && current.updatedAt === listed.updatedAt ? current : null;
      };
      // Outside public mode only chats on the allowlist get messages; a chat
      // that lost access loses the watch, so it does not stay due forever.
      if (config && !isAllowedPilotChat(config, chatId) && !isPilotAdmin(config, chatId)) {
        if (await unchanged()) {
          await storage.delete(key);
          removed += 1;
        }
        continue;
      }
      if (failedSearch) {
        // Waits its interval (a fixed-time watch retries within its slot), so a
        // search that keeps failing does not take the place of the others.
        const current = await unchanged();
        if (current) await storage.put(key, { ...current, lastRunAt:retryRunAt(current, now), updatedAt:now, failures:(Number(current.failures) || 0) + 1 });
        waited += 1;
        continue;
      }
      const seen = new Set(Array.isArray(listed.seen) ? listed.seen : []);
      const fresh = listings.filter(item => !seen.has(item.id) && !(item.crossId && seen.has(item.crossId)));
      let record = true;
      const eligible = [];
      const warmupRuns = (Number(listed.warmupRuns) || 0) + (listed.baseline === true ? 0 : 1);
      const learning = listed.baseline !== true;
      if (learning) {
        baselined += 1;
      } else if (fresh.length) {
        if (!config?.token) continue;
        // The rest of the group stays due and gets its alert on the next run.
        if (external >= DELIVERY_SUBREQUESTS) break;
        let checked = 0;
        for (; checked < fresh.length && eligible.length < LISTINGS_PER_MESSAGE; checked += 1) {
          const item = { ...fresh[checked], costs:await costsFor(fresh[checked]) };
          if (adCostsOverLimit(item)) overLimitSkipped += 1;
          else eligible.push(item);
        }
        eligible.push(...fresh.slice(checked));
      }
      // When everything new was over the limit nothing is sent; it is all
      // still remembered as seen.
      if (eligible.length) {
        recipients += 1;
        const shown = eligible.slice(0, LISTINGS_PER_MESSAGE);
        const loaded = new Map();
        for (const item of shown) loaded.set(item, await photoFor(item));
        const state = item => (!item.imageUrl ? 'missing' : loaded.get(item) ? 'album' : 'failed');
        external += 1;
        const result = await telegram(config, 'sendMessage', { chat_id:chatId, text:watchMessage(own, eligible, state), parse_mode:'HTML', disable_web_page_preview:true, ...(quiet(now) ? { disable_notification:true } : {}) }, transport);
        // 400 only for a chat that is gone, not for a message Telegram rejects.
        if (result.status === 403 || (result.status === 400 && /chat not found|user is deactivated/iu.test(result.description))) {
          // Bot blocked or chat gone: the watch is of no use any more.
          if (await unchanged()) {
            await storage.delete(key);
            removed += 1;
          }
          continue;
        }
        if (result.ok) {
          sent += 1;
          // Silent: the text alert above already made the sound.
          const album = shown.map((item, index) => ({ photo:loaded.get(item), caption:photoCaption(item, index) })).filter(entry => entry.photo);
          if (album.length && external < DELIVERY_SUBREQUESTS && Date.now() < photoUntil) {
            external += 1;
            const posted = await sendListingPhotos({ token:config.token, chatId, photos:album, transport, signal:AbortSignal.timeout(TELEGRAM_TIMEOUT_MS * 2) });
            if (posted.ok) albums += 1;
          }
        }
        // Not delivered: tried again with the same listings in an hour.
        else record = false;
      }
      const current = await unchanged();
      if (!current) continue;
      await storage.put(key, {
        ...current,
        baseline:!learning || warmupRuns >= WARMUP_RUNS || now - (Number(current.createdAt) || now) >= WARMUP_MS,
        warmupRuns,
        failures:0,
        lastRunAt:record ? now : retryRunAt(current, now),
        updatedAt:now,
        seen:record ? [...new Set([...fresh.flatMap(item => [item.id, item.crossId].filter(Boolean)), ...seen])].slice(0, MAX_SEEN) : [...seen]
      });
    }
    return reply({ ok:true, status:'ok', sent, baselined, removed, waited, albums, overLimit:overLimitSkipped });
  }
  return reply({ ok:false, status:'bad_operation' }, 400);
}

// Durable Object side: one search in its own invocation (own subrequest budget).
export async function handleHousingWatchRun(request, outbox, { transport = fetch } = {}) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== HOUSING_WATCH_RUN_PATH) return null;
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
  const parsed = await readBoundedJSON(request.clone(), 4096);
  const criteria = parsed.error ? null : validCriteria(parsed.value?.criteria);
  if (!criteria) return reply({ ok:false, status:'bad_operation' }, 400);
  const env = outbox?.env || {};
  let found;
  try {
    // The same provider budget and page replay as a search a user starts.
    found = await housingWatchSearch(criteria, env, subrequestBudgetTransport(transport, env));
  } catch {
    found = { status:'unavailable', listings:[] };
  }
  const listings = found.status === 'ok' ? found.listings.map(compactListing).filter(Boolean).slice(0, 60) : [];
  // With a group, this object hands the result to the shared object itself,
  // so the cron worker (10 ms CPU on Workers Free) never parses listings.
  const group = typeof parsed.value?.group === 'string' ? parsed.value.group : null;
  const now = Number(parsed.value?.now);
  if (group === watchGroupKey(criteria) && Number.isSafeInteger(now) && now > 0) {
    const delivered = await housingWatchCall(env, found.status === 'ok'
      ? { op:'deliver', group, criteria, listings, now }
      : { op:'deliver', group, criteria, failed:true, now });
    return reply({ ok:true, status:found.status, delivered:delivered?.status === 'ok', sent:Number(delivered?.sent) || 0 });
  }
  return reply({ ok:true, status:found.status, listings });
}

// --- Cron ------------------------------------------------------------------------

async function runGroup(env, slot, { group, criteria }, now) {
  const stub = env.OUTBOX.get(env.OUTBOX.idFromName(`housing-watch-run:v1:${slot}`));
  const response = await stub.fetch(`https://outbox.internal${HOUSING_WATCH_RUN_PATH}`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ criteria, group, now }), signal:AbortSignal.timeout(CALL_TIMEOUT_MS + 15000)
  });
  const parsed = await readBoundedJSON(response, 4096);
  const run = parsed.error ? null : parsed.value;
  // The run object delivered (or recorded the failure) itself.
  if (response.ok && run?.delivered === true) return { status:run.status === 'ok' ? 'ok' : 'search_failed', sent:Number(run.sent) || 0 };
  // Otherwise the watch waits its interval, so a failing search does not
  // take the place of the others.
  await housingWatchCall(env, { op:'deliver', group, criteria, failed:true, now });
  return { status:'search_failed' };
}

export async function scheduledHousingWatch(env, now) {
  if (!housingWatchEnabled(env) || !env?.OUTBOX) return { status:'disabled' };
  if (maintenanceEnabled(env)) return { status:'maintenance' };
  const plan = await housingWatchCall(env, { op:'plan', now });
  await housingWatchCall(env, { op:'remind', now });
  const groups = Array.isArray(plan?.groups) ? plan.groups : [];
  let next = 0, sent = 0, failed = 0;
  const worker = async slot => {
    while (next < groups.length) {
      const item = groups[next++];
      try {
        const result = await runGroup(env, slot, item, now);
        if (result?.status === 'ok') sent += Number(result.sent) || 0;
        else failed += 1;
      } catch {
        failed += 1;
        await housingWatchCall(env, { op:'deliver', group:item.group, criteria:item.criteria, failed:true, now }).catch(() => null);
      }
    }
  };
  await Promise.all(Array.from({ length:Math.min(RUN_CONCURRENCY, groups.length) }, (_, slot) => worker(slot)));
  return { status:'ran', groups:groups.length, sent, failed };
}

// --- Commands --------------------------------------------------------------------

function updateFrom(parsed) {
  const update = parsed?.value;
  const query = update?.callback_query;
  const message = update?.message;
  if (query) {
    const chatId = Number(query?.message?.chat?.id);
    const userId = Number(query?.from?.id);
    if (query?.message?.chat?.type !== 'private' || chatId !== userId || query?.from?.is_bot === true) return null;
    return { update, query, chatId, userId, data:String(query.data || '') };
  }
  if (message) {
    const chatId = Number(message?.chat?.id);
    const userId = Number(message?.from?.id);
    if (message?.chat?.type !== 'private' || chatId !== userId || message?.from?.is_bot === true) return null;
    return { update, message, chatId, userId, text:String(message.text || '').trim() };
  }
  return null;
}

function isWatchCommand(text) {
  return /^\/watch(?:@\w+)?$/iu.test(text);
}

export async function housingWatchCommand(request, env, now, transport) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (url.pathname !== '/telegram/stateless' || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const input = updateFrom(parsed);
  if (!input) return null;
  const isCallback = Boolean(input.query) && input.data.startsWith(HOUSING_WATCH_CALLBACK_PREFIX);
  const isCommand = Boolean(input.message) && isWatchCommand(input.text);
  if (!isCallback && !isCommand) return null;
  const done = (mode, extra = {}) => new Response(JSON.stringify({ ok:true, mode, ...extra }), { status:200, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
  if (!(await privatePilotAccessAllowed(input.update, config, transport))) return null;
  if (isCallback) await telegram(config, 'answerCallbackQuery', { callback_query_id:input.query.id }, transport);
  // TG-RUNTIME-071: every watch screen has a way back to the menu.
  const send = (text, extra = {}) => telegram(config, 'sendMessage', { chat_id:input.chatId, text, disable_web_page_preview:true, ...extra, reply_markup:withMenuRow(extra.reply_markup) }, transport);
  if (!housingWatchEnabled(env)) {
    await send(DISABLED_TEXT);
    return done('housing-watch-disabled');
  }
  const ids = { chatId:input.chatId, userId:input.userId, now };

  if (isCallback && input.data === WATCH_OFF_CALLBACK) {
    const result = await housingWatchCall(env, { op:'delete', ...ids });
    await send(result?.status === 'ok' ? OFF_TEXT : FAILED_TEXT);
    return done('housing-watch-off');
  }
  if (isCallback && input.data === WATCH_RENEW_CALLBACK) {
    const result = await housingWatchCall(env, { op:'renew', ...ids });
    await send(result?.status === 'ok'
      ? `✅ Моніторинг продовжено до ${untilDate(result.expiresAt)}.\nЗмінити або вимкнути: /watch`
      : result?.status === 'none' ? NONE_TEXT : FAILED_TEXT);
    return done('housing-watch-renew');
  }
  const chosen = isCallback ? INTERVAL_CALLBACK.exec(input.data) : null;
  if (chosen) {
    const result = await housingWatchCall(env, { op:'interval', ...ids, interval:chosen[1] });
    await send(result?.status === 'ok'
      ? `⏱ Нові оголошення надсилатимуться ${WATCH_INTERVALS[chosen[1]].label}.\nЗмінити або вимкнути: /watch`
      : result?.status === 'none' ? NONE_TEXT : FAILED_TEXT);
    return done('housing-watch-interval');
  }
  if (isCallback) {
    const match = WATCH_CALLBACK.exec(input.data);
    const criteria = match ? watchCriteria({ radius:match[1], persons:match[2], rooms:match[3], location:match[4] }) : null;
    if (!criteria) {
      await send(FAILED_TEXT);
      return done('housing-watch-invalid');
    }
    const result = await housingWatchCall(env, { op:'set', ...ids, criteria });
    if (result?.status === 'ok') await send(ON_TEXT(criteria), { reply_markup:{ inline_keyboard:intervalKeyboard(result.interval) } });
    else await send(result?.status === 'full' ? '⚠️ Зараз досягнуто максимальної кількості моніторингів. Спробуйте пізніше.' : FAILED_TEXT);
    return done('housing-watch-on');
  }
  const result = await housingWatchCall(env, { op:'get', ...ids });
  if (result?.status !== 'ok') {
    await send(FAILED_TEXT);
    return done('housing-watch-status-unavailable');
  }
  if (!result.watch) {
    await send(NONE_TEXT);
    return done('housing-watch-none');
  }
  const { criteria, expiresAt } = result.watch;
  const interval = Object.hasOwn(WATCH_INTERVALS, result.watch.interval) ? result.watch.interval : DEFAULT_INTERVAL;
  const until = untilDate(expiresAt);
  await send([
    '🔔 Моніторинг житла увімкнено.',
    `${criteria.location}, ${areaLabel(criteria)} · осіб: ${criteria.persons} · кімнати: ${criteria.rooms}.`,
    `Діє до ${until}. Нові оголошення — ${WATCH_INTERVALS[interval].label}.`,
    'Змінити, як часто надсилати:'
  ].join('\n'), { reply_markup:{ inline_keyboard:[...intervalKeyboard(interval), [RENEW_BUTTON], [{ text:'🔕 Вимкнути моніторинг', callback_data:WATCH_OFF_CALLBACK }]] } });
  return done('housing-watch-status');
}
