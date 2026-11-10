// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { safeLogText } from './log-safe.mjs';
import { withKleinanzeigenAdCosts, adCostsTimeLeft } from './kleinanzeigen-ad-costs.mjs';
import { resolveJobcenterRule } from './jobcenter-registry-statewide.mjs';
import { pilotConfig, equalSecret, readBoundedJSON, normalizePilotUpdate } from './pilot-security.mjs';
import { privatePilotAccessAllowed } from './runtime-access.mjs';
import { klazKeyConfigured, klazApiKey } from './housing-provider-base.mjs';
import { searchLiveHousing, formatHousingListings, housingListingsMarkup, externalHousingSearchMarkup } from './housing-provider.mjs';
import { sendHousingMediaReply } from './telegram-media.mjs';
import { scopedJobcenterSearchMarkup, jobcenterPhotoCards, jobcenterAreaWarnings } from './runtime-housing-search.mjs';
import { SH_UKRAINIAN_PLACE_ROWS } from './schleswig-holstein-place-names.mjs';
import { jobcenterRuleLocationForMunicipality } from './schleswig-holstein-jobcenter-route.mjs';
import { filterHousingListingsToJurisdiction, jurisdictionForHousingLocation } from './housing-jurisdiction-scope.mjs';
import { searchKleinanzeigenPublicRecovery } from './housing-kleinanzeigen-public-expanded.mjs';
import { searchPrimaryHousing } from './housing-primary-search.mjs';
import { providerSubrequestBudget } from './subrequest-budget.mjs';
import { parseRoomSpec } from './rooms.mjs';
import { dedupeListings, crossPortalSeenKey, seenOnOtherPortal } from './listing-dedup.mjs';
import { companySourcesFor } from './housing-company-sources.mjs';
import { recordOpsMetrics, opsSourceKeys } from './ops-metrics.mjs';
import { formatEuro } from './listing-format.mjs';
import { hasHousingFallbackMarker } from './housing-fallback-markers.mjs';
import { housingProviderFailureText } from './runtime-housing-output.mjs';
const STATELESS_PATH = '/telegram/stateless';
const TELEGRAM_TIMEOUT_MS = 8000;
const DEFAULT_RADIUS_KM = 15;
const RADII = Object.freeze([15, 20, 25]);
const JOBCENTER_ACTION_CALLBACK = /^hka:j:(\d{1,2}):([^:]{1,8}):(.{1,48})$/u;
const JOBCENTER_RADIUS_CALLBACK = /^jcr:(15|20|25):(\d{1,2}):([^:]{1,8}):(.{1,48})$/u;
const JOBCENTER_DISTRICT_CALLBACK = /^jcd:(\d{1,2}):([^:]{1,8}):(.{1,48})$/u;
const JOBCENTER_DISTRICT_PAGE_CALLBACK = /^jcp:(\d{1,2}):(\d{1,2}):([^:]{1,8}):(.{1,48})$/u;
// jrp:<page>[:<previousRadius>] — the previous radius is set after widening
// (15→20, 20→25) so later pages keep the same ring; old jrp:<page> still works.
const JOBCENTER_RADIUS_PAGE_CALLBACK = /^jrp:(\d{1,2})(?::(15|20|25))?$/u;
const JOBCENTER_SEARCH_STATE_PATH = '/jobcenter-search-state';
const JOBCENTER_SEARCH_STATE_PREFIX = 'telegram-jobcenter-search-state:v1:';
const JOBCENTER_DISTRICT_INFLIGHT_PREFIX = 'telegram-jobcenter-district-inflight:v1:';
const JOBCENTER_SEARCH_STATE_TTL_MS = 60 * 60 * 1000;
const JOBCENTER_DISTRICT_INFLIGHT_TTL_MS = 45 * 1000;
const JOBCENTER_STATE_CALL_TIMEOUT_MS = 1500;
// Two keys per shown listing (URL and cross-portal identity): about 60 listings.
const JOBCENTER_SEARCH_STATE_MAX_KEYS = 120;
const LISTINGS_PAGE_SIZE = 5;
const DISTRICT_LIMIT_CACHE = new Map();
const DISTRICT_ANCHOR_LIMIT = 5;
const DISTRICT_ANCHOR_RADIUS_KM = 25;
const DISTRICT_ANCHOR_TIMEOUT_MS = 8500;
const DISTRICT_RECOVERY_TIMEOUT_MS = 3000;
const DISTRICT_TOTAL_SEARCH_TIMEOUT_MS = 12000;
const LOCAL_TOTAL_SEARCH_TIMEOUT_MS = 12000;
const MEDIA_DELIVERY_TIMEOUT_MS = 8000;
export const JOBCENTER_SEARCH_TIMINGS = Object.freeze({ search:LOCAL_TOTAL_SEARCH_TIMEOUT_MS, district:DISTRICT_TOTAL_SEARCH_TIMEOUT_MS, media:MEDIA_DELIVERY_TIMEOUT_MS });
const JOBCENTER_SEARCH_MAX_ROOMS = 8;
export const JOBCENTER_BACKGROUND_TASK_HEADER = 'x-zaskaleta-jobcenter-background-task';
export const JOBCENTER_BACKGROUND_ACK_HEADER = 'x-zaskaleta-jobcenter-callback-acked';
export const JOBCENTER_BACKGROUND_PROGRESS_HEADER = 'x-zaskaleta-jobcenter-progress-message-id';
export const JOBCENTER_BACKGROUND_LOCK_HEADER = 'x-zaskaleta-jobcenter-district-lock-acquired';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function encodeLocation(value) {
  const encoded = encodeURIComponent(String(value || '').replace(/\s+/gu, ' ').trim());
  return encoded && new TextEncoder().encode(encoded).byteLength <= 48 ? encoded : null;
}

function decodeLocation(value) {
  try {
    const decoded = decodeURIComponent(String(value || '')).replace(/\s+/gu, ' ').trim();
    // Place names such as "Lauenburg/Elbe" or "Reinfeld (Holstein)" need '/', '(' and ')'.
    return /^\p{L}[\p{L}\p{M}.'’()/ -]{1,79}$/u.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function shownNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100).replace('.', ',');
}

// A euro amount always shows its cents (943,80 €), as on listing cards.
function euro(value) {
  return Number.isFinite(Number(value)) ? formatEuro(value) : shownNumber(value);
}

function previousRadiusFromChooser(text) {
  const match = /^📍 Радіус пошуку:\s*(15|20|25)\s*км\s*$/mu.exec(String(text || ''));
  const radius = Number(match?.[1]);
  return RADII.includes(radius) ? radius : null;
}

export function radiusPageContextFromText(text, page = 0) {
  const source = String(text || '');
  const location = /^🔎 Автопошук житла під Jobcenter\s*[—–-]\s*([^\n]{2,120})\s*$/mu.exec(source)?.[1]?.trim();
  const persons = Number(/^Осіб:\s*(\d{1,2})\s*$/mu.exec(source)?.[1]);
  const rooms = /^Кімнати:\s*(\d{1,2}(?:-\d{1,2})?)\s*$/mu.exec(source)?.[1]?.trim();
  const radius = Number(/^📍 Радіус пошуку:\s*(15|20|25)\s*км\s*$/mu.exec(source)?.[1]);
  if (!location || !Number.isSafeInteger(persons) || persons < 1 || persons > 20 || !rooms || !RADII.includes(radius) || !Number.isSafeInteger(page) || page < 0) return null;
  return { location, persons, rooms, radius, page };
}

function radiusPageCallback(page, radius, previousRadius) {
  const next = Math.max(0, Number(page) || 0) + 1;
  return RADII.includes(previousRadius) && RADII.includes(radius) && radius > previousRadius
    ? `jrp:${next}:${previousRadius}`
    : `jrp:${next}`;
}

export function localSearchSummaryPayload({ location, rooms, persons, radius, previousRadius = null, jurisdiction, page = 0, total = 0, visible = 0 }) {
  const pageStart = Math.max(0, Number(page) || 0) * LISTINGS_PAGE_SIZE;
  const safeVisible = Math.max(0, Number(visible) || 0);
  const safeTotal = Math.max(0, Number(total) || 0);
  const hasMore = safeTotal > pageStart + safeVisible;
  const shownRange = safeVisible
    ? `✅ Показано ${pageStart + 1}–${pageStart + safeVisible} із ${safeTotal} знайдених оголошень.`
    : 'ℹ️ За цими критеріями нових оголошень не знайдено.';
  const text = [
    `🔎 Автопошук житла під Jobcenter — ${location}`,
    `Осіб: ${persons}`,
    `Кімнати: ${rooms}`,
    jurisdiction ? `Jobcenter/Kreis: ${jurisdiction}.` : null,
    `📍 Радіус пошуку: ${radius} км`,
    shownRange,
    !hasMore ? 'ℹ️ Оголошень більше немає.' : null
  ].filter(Boolean).join('\n');
  return {
    text,
    hasMore,
    ...(hasMore ? { reply_markup:{ inline_keyboard:[[{ text:'➡️ Наступні оголошення', callback_data:radiusPageCallback(page, radius, previousRadius) }]] } } : {})
  };
}

export function districtSearchProgressText(jurisdiction) {
  return `🔎 Шукаю оголошення по всьому Jobcenter/Kreis ${jurisdiction}…`;
}

export function districtSearchCompletedNotice(jurisdiction, count = 0) {
  const total = Math.max(0, Number(count) || 0);
  return [
    `✅ Пошук по всьому Jobcenter/Kreis ${jurisdiction} завершено.`,
    `Знайдено нових оголошень: ${total}.`,
    'Результати та керування пошуком надсилаю нижче.'
  ].join('\n');
}

export function localSearchProgressText(location) {
  return `🔎 Шукаю житло — ${String(location || '').trim()}…`;
}

export function localSearchUnavailableText(location) {
  return [
    `⚠️ Не вдалося отримати оголошення — ${String(location || '').trim()}.`,
    'Пошук не завершився вчасно або джерела тимчасово недоступні.',
    'Бот не залишатиме натискання без фінальної відповіді.',
    'Спробуйте ще раз або змініть радіус пошуку.'
  ].join('\n');
}

export function districtSearchUnavailableText(jurisdiction) {
  return [
    `⚠️ Пошук по всьому Jobcenter/Kreis ${jurisdiction} не завершився вчасно.`,
    'Бот не буде залишати вас лише з повідомленням «Шукаю…».',
    'Спробуйте пошук району ще раз або поверніться до пошуку за радіусом.'
  ].join('\n');
}

async function settleWithin(promise, timeoutMs, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => {
        timer = setTimeout(() => resolve(typeof fallback === 'function' ? fallback() : fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function transportWithAbortSignal(transport = fetch, parentSignal = null) {
  if (!parentSignal) return transport;
  return (url, options = {}) => {
    const childSignal = options?.signal;
    let signal = parentSignal;
    if (childSignal && childSignal !== parentSignal && typeof AbortSignal?.any === 'function') {
      signal = AbortSignal.any([parentSignal, childSignal]);
    } else if (childSignal?.aborted) {
      signal = childSignal;
    }
    return transport(url, { ...options, signal });
  };
}

export async function settleWithinAbortable(factory, timeoutMs, fallback) {
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  try {
    const operation = Promise.resolve().then(() => factory(controller.signal));
    return await Promise.race([
      operation,
      new Promise(resolve => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve(typeof fallback === 'function' ? fallback() : fallback);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
    if (timedOut) {
      // The operation promise already has Promise.race rejection handlers attached;
      // aborting here prevents any underlying fetch from surviving the timeout.
    }
  }
}

function validPrivateSearchIdentity(chatId, userId) {
  return Number.isSafeInteger(chatId) && chatId > 0 && chatId === userId;
}

function searchStateKey(chatId, userId) {
  return `${JOBCENTER_SEARCH_STATE_PREFIX}${chatId}:${userId}`;
}

function districtInFlightKey(chatId, userId) {
  return `${JOBCENTER_DISTRICT_INFLIGHT_PREFIX}${chatId}:${userId}`;
}

export function jobcenterSearchSignature({ location, persons, rooms, jurisdiction }) {
  const normalizedLocation = districtKey(location);
  const normalizedJurisdiction = districtKey(jurisdiction);
  const people = Number(persons);
  const roomText = String(rooms || '').trim();
  if (!normalizedLocation || !normalizedJurisdiction || !Number.isSafeInteger(people) || people < 1 || people > 20 || !/^\d{1,2}(?:-\d{1,2})?$/u.test(roomText)) return null;
  return `${normalizedJurisdiction}|${normalizedLocation}|${people}|${roomText}`;
}

export function listingStateKey(item) {
  const url = String(item?.url || item?.ad_url || '').trim().toLowerCase().replace(/[?#].*$/u, '');
  if (/^https:\/\//u.test(url)) return `u:${url}`;
  const id = String(item?.id || item?.ad_id || item?.sourceId || '').trim().toLowerCase();
  if (id) return `i:${id}`;
  const fingerprint = strongListingFingerprint(item);
  return fingerprint ? `f:${fingerprint}` : null;
}

function normalizedStateKeys(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(value => value && value.length <= 600))]
    .slice(0, JOBCENTER_SEARCH_STATE_MAX_KEYS);
}

export function filterUnseenDistrictListings(listings, seenKeys = []) {
  const seen = new Set(normalizedStateKeys(seenKeys));
  return (Array.isArray(listings) ? listings : []).filter(item => {
    const key = listingStateKey(item);
    if (key && seen.has(key)) return false;
    // Already shown from another portal (same postcode, rent, area, rooms).
    return !seenOnOtherPortal(item, seen);
  });
}

export function districtNoNewMessage(jurisdiction, baselineCount = 0, rawCount = 0) {
  const previous = Math.max(0, Number(baselineCount) || 0);
  const found = Math.max(0, Number(rawCount) || 0);
  return [
    `✅ Пошук по всьому Jobcenter/Kreis ${jurisdiction} завершено.`,
    'Нових оголошень не знайдено.',
    found > 0
      ? 'Усі оголошення, знайдені в поточному пошуку, вже були показані вище.'
      : previous > 0
        ? 'Нових варіантів понад уже показані оголошення немає.'
        : 'За цими критеріями оголошень у поточному пошуку не знайдено.'
  ].join('\n');
}

export function districtSearchStateUnavailableText(jurisdiction) {
  return [
    `⚠️ Пошук по всьому Jobcenter/Kreis ${jurisdiction} зараз не запущено.`,
    'Захист від дубльованого паралельного запуску тимчасово недоступний.',
    'Спробуйте ще раз через кілька секунд.'
  ].join('\n');
}

export function districtSummaryPayload({ jurisdiction, listings = [], pageStart = 0, total = 0, hasMore = false, location = '', persons = 0, rooms = '', alreadyShown = 0 } = {}) {
  const shownBefore = Math.max(0, Math.floor(Number(alreadyShown) || 0));
  const repeatNote = shownBefore ? `Ще ${shownBefore} — ті самі оголошення, що вже були у пошуку за радіусом; вдруге їх не надсилаю.` : null;
  const visible = Array.isArray(listings) ? listings : [];
  const locations = [...new Set(visible.map(item => String(item?.location || '').replace(/\s+/gu, ' ').trim()).filter(Boolean))].slice(0, 4);
  const text = visible.length
    ? [
        `✅ Пошук по всьому Jobcenter/Kreis ${jurisdiction} завершено.`,
        `Показано ${pageStart + 1}–${pageStart + visible.length} із ${Math.max(visible.length, Number(total) || 0)} знайдених оголошень.`,
        locations.length ? `Локації: ${locations.join(' · ')}.` : null,
        repeatNote,
        !hasMore ? 'Більше оголошень за цими критеріями не знайдено.' : null,
        'Результати з інших Jobcenter/Kreis не включаються.'
      ].filter(Boolean).join('\n')
    : [
        `✅ Пошук по всьому Jobcenter/Kreis ${jurisdiction} завершено.`,
        'Придатних нових оголошень у поточному підтвердженому наборі не знайдено.',
        repeatNote,
        'Результати з інших Jobcenter/Kreis не включаються.'
      ].filter(Boolean).join('\n');
  const encoded = hasMore ? encodeLocation(location) : null;
  const reply_markup = encoded
    ? { inline_keyboard:[[{ text:'➡️ Наступні оголошення', callback_data:`jcp:${Math.floor(pageStart / LISTINGS_PAGE_SIZE) + 1}:${persons}:${rooms}:${encoded}` }]] }
    : null;
  return { text, ...(reply_markup ? { reply_markup } : {}) };
}

export async function deliverDistrictTerminal({ config, chatId, progressMessageId = null, text, replyMarkup = null, transport = fetch, visibleNewMessage = false }) {
  const base = {
    chat_id:chatId,
    text:String(text || '').slice(0, 4096),
    ...(replyMarkup ? { reply_markup:replyMarkup } : {})
  };
  if (visibleNewMessage) {
    await markProgressCompleted(config, chatId, progressMessageId, transport);
    const sent = await telegramJSON(config, 'sendMessage', {
      ...base,
      disable_notification:true
    }, transport);
    return { ok:sent.ok, mode:sent.ok ? 'sent-visible' : 'failed' };
  }
  if (Number.isSafeInteger(progressMessageId) && progressMessageId > 0) {
    const edited = await telegramJSON(config, 'editMessageText', {
      ...base,
      message_id:progressMessageId
    }, transport);
    if (edited.ok) return { ok:true, mode:'edited' };
  }
  const sent = await telegramJSON(config, 'sendMessage', {
    ...base,
    disable_notification:true
  }, transport);
  return { ok:sent.ok, mode:sent.ok ? 'sent' : 'failed' };
}

async function jobcenterSearchStateCall(env, payload) {
  if (!env?.OUTBOX) return { status:'unavailable' };
  try {
    return await settleWithin((async () => {
      const id = env.OUTBOX.idFromName('telegram-pilot-v1');
      const response = await env.OUTBOX.get(id).fetch(`https://outbox.internal${JOBCENTER_SEARCH_STATE_PATH}`, {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify(payload)
      });
      if (!response.ok) return { status:'unavailable' };
      const parsed = await readBoundedJSON(response, 32768);
      return parsed.error ? { status:'unavailable' } : parsed.value;
    })(), JOBCENTER_STATE_CALL_TIMEOUT_MS, () => ({ status:'unavailable' }));
  } catch {
    return { status:'unavailable' };
  }
}

export async function handleJobcenterSearchStorage(request, outbox) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== JOBCENTER_SEARCH_STATE_PATH) return null;
  const parsed = await readBoundedJSON(request.clone(), 32768);
  const value = parsed.error ? null : parsed.value;
  const chatId = Number(value?.chatId);
  const userId = Number(value?.userId);
  const now = Number(value?.now);
  const signature = String(value?.signature || '').slice(0, 320);
  if (!validPrivateSearchIdentity(chatId, userId) || !Number.isSafeInteger(now) || now < 0) {
    return json({ status:'bad_operation' }, 400);
  }

  const op = String(value?.op || '');
  const lockKey = districtInFlightKey(chatId, userId);

  if (op === 'district_cancel_user') {
    try {
      await outbox.householdContextStorage.delete(lockKey);
      await outbox.householdContextStorage.delete(searchStateKey(chatId, userId));
      return json({ status:'ok', cancelled:true });
    } catch {
      return json({ status:'unavailable' }, 503);
    }
  }

  if (op === 'district_acquire' || op === 'district_release' || op === 'district_check') {
    const token = String(value?.token || '').slice(0, 256);
    if (!token || (op === 'district_acquire' && !signature)) return json({ status:'bad_operation' }, 400);
    try {
      const current = await outbox.householdContextStorage.get(lockKey);
      const active = current
        && typeof current.token === 'string'
        && current.token
        && Number.isSafeInteger(current.expiresAt)
        && current.expiresAt > now;

      if (op === 'district_acquire') {
        if (active) {
          return json({
            status:'ok',
            acquired:false,
            duplicate:current.token === token,
            expiresAt:current.expiresAt
          });
        }
        const expiresAt = now + JOBCENTER_DISTRICT_INFLIGHT_TTL_MS;
        await outbox.householdContextStorage.put(lockKey, { token, signature, expiresAt });
        return json({ status:'ok', acquired:true, expiresAt });
      }

      if (op === 'district_check') {
        return json({
          status:'ok',
          owned:Boolean(active && current.token === token),
          expiresAt:active ? current.expiresAt : null
        });
      }

      if (!current || current.token !== token) return json({ status:'ok', released:false });
      await outbox.householdContextStorage.delete(lockKey);
      return json({ status:'ok', released:true });
    } catch {
      return json({ status:'unavailable' }, 503);
    }
  }

  if (!signature) return json({ status:'bad_operation' }, 400);
  const key = searchStateKey(chatId, userId);
  try {
    const currentRaw = await outbox.householdContextStorage.get(key);
    const current = currentRaw
      && Number.isSafeInteger(currentRaw.updatedAt)
      && currentRaw.updatedAt >= now - JOBCENTER_SEARCH_STATE_TTL_MS
      && currentRaw.signature === signature
      ? currentRaw
      : null;

    if (value.op === 'clear') {
      await outbox.householdContextStorage.delete(key);
      return json({ status:'ok' });
    }

    if (value.op === 'record_seen') {
      const reset = value.reset === true;
      const existing = reset ? [] : normalizedStateKeys(current?.seen);
      const keys = normalizedStateKeys(value.keys);
      const seen = normalizedStateKeys([...existing, ...keys]);
      await outbox.householdContextStorage.put(key, {
        signature,
        seen,
        districtBaseline:reset ? null : normalizedStateKeys(current?.districtBaseline),
        updatedAt:now
      });
      return json({ status:'ok', seen });
    }

    if (value.op === 'district_baseline') {
      const initialize = value.initialize === true;
      let seen = normalizedStateKeys(current?.seen);
      let districtBaseline = normalizedStateKeys(current?.districtBaseline);
      if (initialize || !current?.districtBaseline) {
        districtBaseline = [...seen];
        await outbox.householdContextStorage.put(key, {
          signature,
          seen,
          districtBaseline,
          updatedAt:now
        });
      }
      return json({ status:'ok', baseline:districtBaseline, seen });
    }

    return json({ status:'bad_operation' }, 400);
  } catch {
    return json({ status:'unavailable' }, 503);
  }
}

function filterExpandedRadiusResult(result, previousRadius, radius) {
  if (!RADII.includes(previousRadius) || !RADII.includes(radius) || radius <= previousRadius) return result;
  const listings = Array.isArray(result?.listings)
    ? result.listings.filter(item => Number.isFinite(item?.distanceKm) && item.distanceKm > previousRadius && item.distanceKm <= radius)
    : [];
  return {
    ...result,
    listings,
    radiusKm:radius,
    ...(result?.criteria ? { criteria:{ ...result.criteria, radiusKm:radius } } : {})
  };
}

async function telegramJSON(config, method, payload, transport = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/${method}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(payload),
      signal:controller.signal
    });
    const parsed = await readBoundedJSON(response, 32768);
    return { ok:response.ok && !parsed.error && parsed.value?.ok === true, data:parsed.error ? null : parsed.value };
  } catch {
    return { ok:false, data:null };
  } finally {
    clearTimeout(timeout);
  }
}

async function answerCallback(config, query, transport) {
  if (typeof query?.id !== 'string' || !query.id) return false;
  const result = await telegramJSON(config, 'answerCallbackQuery', { callback_query_id:query.id }, transport);
  return result.ok;
}

export async function prepareJobcenterBackgroundAck(request, env, transport = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return { handled:false };
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return { handled:false };
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return { handled:false };
  const update = parsed.value;
  const query = update?.callback_query;
  const context = query ? callbackContext(String(query?.data || '')) : null;
  if (!query || !context) return { handled:false };
  const chatId = Number(query?.message?.chat?.id);
  const userId = Number(query?.from?.id);
  if (query?.message?.chat?.type !== 'private'
      || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId
      || query?.from?.is_bot === true) return { handled:false };

  const callbackAnswered = await answerCallback(config, query, transport);
  // hka:j only shows the paused Jobcenter guideline with a "Почати пошук"
  // button; a "Шукаю…" progress message would never be completed.
  if (JOBCENTER_ACTION_CALLBACK.test(String(query?.data || ''))) {
    return { handled:true, callbackAnswered, progressMessageId:null, lockAcquired:false, skipBackground:false };
  }
  const resolved = resolveJobcenterRule(context.location, context.persons);
  const limit = Number(resolved?.rule?.grossColdLimit);
  if (resolved?.status !== 'verified' || !Number.isFinite(limit) || limit <= 0) {
    return { handled:true, callbackAnswered, progressMessageId:null, lockAcquired:false, skipBackground:false };
  }

  let lockAcquired = false;
  if (context.district) {
    const jurisdiction = String(resolved?.jurisdiction || resolved?.module?.jurisdiction || '').trim();
    const signature = jobcenterSearchSignature({
      location:context.location,
      persons:context.persons,
      rooms:context.rooms,
      jurisdiction
    });
    const token = String(query?.id || '').slice(0,256);
    const lock = signature && token
      ? await jobcenterSearchStateCall(env,{
          op:'district_acquire',
          chatId,
          userId,
          signature,
          token,
          now:Date.now()
        })
      : { status:'unavailable' };

    if (lock?.status === 'ok' && lock?.acquired !== true) {
      const sent = await telegramJSON(config,'sendMessage',{
        chat_id:chatId,
        text:`⏳ Пошук по Jobcenter/Kreis ${jurisdiction} уже виконується. Дочекайтеся фінальної відповіді цього пошуку.`,
        disable_notification:true
      },transport);
      return {
        handled:true,
        callbackAnswered,
        progressMessageId:null,
        lockAcquired:false,
        skipBackground:true,
        duplicateSuppressed:true,
        delivered:sent.ok
      };
    }
    if (env?.OUTBOX && lock?.status !== 'ok') {
      const sent = await telegramJSON(config,'sendMessage',{
        chat_id:chatId,
        text:districtSearchStateUnavailableText(jurisdiction),
        disable_notification:true
      },transport);
      return {
        handled:true,
        callbackAnswered,
        progressMessageId:null,
        lockAcquired:false,
        skipBackground:true,
        delivered:sent.ok
      };
    }
    lockAcquired = lock?.status === 'ok' && lock?.acquired === true;
  }

  const progressText = context.district
    ? districtSearchProgressText(String(resolved?.jurisdiction || resolved?.module?.jurisdiction || '').trim() || context.location)
    : localSearchProgressText(context.location);
  const progress = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text:progressText,
    disable_notification:true
  }, transport);
  const candidate = Number(progress?.data?.result?.message_id);
  return {
    handled:true,
    callbackAnswered,
    progressMessageId:Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null,
    lockAcquired,
    skipBackground:false
  };
}

export async function releasePreparedJobcenterBackgroundLock(request, env) {
  try {
    if (!env?.OUTBOX || request?.headers?.get(JOBCENTER_BACKGROUND_LOCK_HEADER) !== '1') return false;
    const parsed = await readBoundedJSON(request.clone(), 65536);
    if (parsed.error) return false;
    const update = parsed.value;
    const query = update?.callback_query;
    const context = query ? callbackContext(String(query?.data || '')) : null;
    if (!query || !context?.district) return false;
    const chatId = Number(query?.message?.chat?.id);
    const userId = Number(query?.from?.id);
    if (!validPrivateSearchIdentity(chatId, userId)) return false;
    const resolved = resolveJobcenterRule(context.location, context.persons);
    const jurisdiction = String(resolved?.jurisdiction || resolved?.module?.jurisdiction || '').trim();
    const signature = jobcenterSearchSignature({
      location:context.location,
      persons:context.persons,
      rooms:context.rooms,
      jurisdiction
    });
    const token = String(query?.id || '').slice(0,256);
    if (!signature || !token) return false;
    const released = await jobcenterSearchStateCall(env, {
      op:'district_release',
      chatId,
      userId,
      signature,
      token,
      now:Date.now()
    });
    return released?.status === 'ok' && released?.released === true;
  } catch {
    return false;
  }
}

export async function cancelJobcenterBackgroundForNavigation(request, env, now = Date.now()) {
  try {
    if (!env?.OUTBOX) return false;
    const parsed = await readBoundedJSON(request.clone(), 65536);
    if (parsed.error) return false;
    const update = parsed.value;
    const message = update?.callback_query?.message || update?.message;
    const from = update?.callback_query?.from || update?.message?.from;
    const chatId = Number(message?.chat?.id);
    const userId = Number(from?.id);
    if (message?.chat?.type !== 'private' || !validPrivateSearchIdentity(chatId, userId) || from?.is_bot === true) return false;
    const cancelled = await jobcenterSearchStateCall(env, {
      op:'district_cancel_user',
      chatId,
      userId,
      now
    });
    return cancelled?.status === 'ok' && cancelled?.cancelled === true;
  } catch {
    return false;
  }
}

async function districtBackgroundStillOwned(env, chatId, userId, token) {
  if (!env?.OUTBOX || !token) return true;
  const checked = await jobcenterSearchStateCall(env, {
    op:'district_check',
    chatId,
    userId,
    token,
    now:Date.now()
  });
  return checked?.status !== 'ok' || checked?.owned === true;
}

function radiusMarkup(location, rooms, persons, selectedRadius, districtSelected = false) {
  const encoded = encodeLocation(location);
  if (!encoded) return null;
  const button = radius => ({
    text:`${radius === selectedRadius && !districtSelected ? '✅ ' : ''}${radius} км`,
    callback_data:`jcr:${radius}:${persons}:${rooms}:${encoded}`
  });
  return {
    inline_keyboard:[
      [button(15), button(20), button(25)],
      [{
        text:`${districtSelected ? '✅ ' : ''}🗺 Шукати весь район`,
        callback_data:`jcd:${persons}:${rooms}:${encoded}`
      }]
    ]
  };
}

export function finalSearchControlsMarkup({ location, rooms, persons, radius = null, previousRadius = null, districtSelected = false, page = 0, hasMore = false } = {}) {
  const base = radiusMarkup(location, rooms, persons, radius, districtSelected);
  if (!base) return null;
  const rows = [];
  if (hasMore) {
    const encoded = encodeLocation(location);
    const callback = districtSelected
      ? (encoded ? `jcp:${Math.max(0, Number(page) || 0) + 1}:${persons}:${rooms}:${encoded}` : null)
      : radiusPageCallback(page, radius, previousRadius);
    if (callback) rows.push([{ text:'➡️ Наступні оголошення', callback_data:callback }]);
  }
  rows.push(...base.inline_keyboard);
  return { inline_keyboard:rows };
}

async function markProgressCompleted(config, chatId, progressMessageId, transport) {
  if (!Number.isSafeInteger(progressMessageId) || progressMessageId <= 0) return false;
  const edited = await settleWithin(
    telegramJSON(config, 'editMessageText', {
      chat_id:chatId,
      message_id:progressMessageId,
      text:'✅ Пошук завершено. Результат і керування нижче.'
    }, transport),
    1200,
    () => ({ ok:false, timedOut:true })
  );
  return edited.ok === true;
}

function partialDeliverySummary({ location, rooms, persons, districtJurisdiction = null, radius = null, sent = 0, requested = 0 }) {
  return [
    `⚠️ Пошук завершено, але Telegram підтвердив доставку лише ${sent} із ${requested} підготовлених оголошень.`,
    `Локація: ${location}`,
    `Осіб: ${persons}`,
    `Кімнати: ${rooms}`,
    districtJurisdiction ? `Jobcenter/Kreis: ${districtJurisdiction}.` : `📍 Радіус пошуку: ${radius} км`,
    'Щоб не пропустити варіанти, повторіть пошук цієї зони.'
  ].join('\n');
}

async function sendRadiusChooser(config, chatId, location, rooms, persons, radius, transport) {
  const markup = radiusMarkup(location, rooms, persons, radius);
  if (!markup) return false;
  const result = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text:[
      `📍 Радіус пошуку: ${radius} км`,
      'Змінити радіус пошуку житла під Jobcenter:'
    ].join('\n'),
    disable_notification:true,
    reply_markup:markup
  }, transport);
  return result.ok;
}

async function sendDistrictChooser(config, chatId, location, rooms, persons, jurisdiction, transport) {
  const markup = radiusMarkup(location, rooms, persons, null, true);
  if (!markup) return false;
  const result = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text:[
      `🗺 Територія пошуку: Jobcenter/Kreis ${jurisdiction}`,
      'Показуються лише оголошення, які можна віднести до цієї адміністративної території.',
      'Можна повернутися до пошуку за радіусом:'
    ].join('\n'),
    disable_notification:true,
    reply_markup:markup
  }, transport);
  return result.ok;
}

export async function deliverListingsThenControls(deliverListings, deliverControls) {
  const listings = await deliverListings();
  const controls = await deliverControls();
  return { listings, controls };
}

async function sendUnavailable(config, chatId, resolved, transport) {
  const authority = resolved?.pending?.authority || resolved?.module?.authority || resolved?.rule?.authority || 'Jobcenter';
  const detail = String(resolved?.pending?.messageUk || '').trim();
  const text = [
    `🏛 Житло під Jobcenter — ${authority}`,
    '',
    'Для цієї локації зараз немає напряму підтвердженого числового ліміту, який можна безпечно використати для автоматичного пошуку.',
    detail || 'Я не підставляю старі або неперевірені суми.',
    '',
    'Автопошук під Jobcenter буде доступний після прямої верифікації чинного офіційного нормативу.'
  ].join('\n');
  const result = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text,
    disable_notification:true,
    link_preview_options:{ is_disabled:true }
  }, transport);
  return result.ok;
}

function exactRadiusExternalMarkup(criteria) {
  const base = `${criteria.location} ${criteria.rooms} Zimmer Wohnung mieten bis ${criteria.amount} EUR Umkreis ${criteria.radiusKm} km`;
  const google = query => `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  return { inline_keyboard:[
    [{ text:'↗ Kleinanzeigen', url:google(`site:kleinanzeigen.de/s-anzeige ${base}`) }],
    [
      { text:'↗ ImmoScout24', url:google(`site:immobilienscout24.de/Suche ${base}`) },
      { text:'↗ Immowelt', url:google(`site:immowelt.de/suche ${base}`) }
    ]
  ] };
}

export function districtSearchLimitCandidates(jurisdiction, originLocation = '') {
  return districtAnchorLocations(jurisdiction, originLocation).slice(0, DISTRICT_ANCHOR_LIMIT);
}

function districtSearchLimit(jurisdiction, persons, fallback, originLocation = '') {
  const cacheKey = `${jurisdiction}:${persons}:${districtKey(originLocation)}`;
  if (DISTRICT_LIMIT_CACHE.has(cacheKey)) return DISTRICT_LIMIT_CACHE.get(cacheKey);

  let limit = Number(fallback);
  for (const location of districtSearchLimitCandidates(jurisdiction, originLocation)) {
    const candidate = resolveJobcenterRule(location, persons);
    const value = Number(candidate?.rule?.grossColdLimit);
    if (candidate?.status === 'verified' && candidate?.jurisdiction === jurisdiction && Number.isFinite(value) && value > 0) {
      limit = Number.isFinite(limit) ? Math.max(limit, value) : value;
    }
  }

  DISTRICT_LIMIT_CACHE.set(cacheKey, limit);
  return limit;
}

// The limit that applies to a listing is the one of the municipality where it
// is located. A listing whose municipality cannot be resolved to a verified
// zone of the same Jobcenter keeps the user's own limit (conservative).
export function districtListingOwnLimit(listing, { jurisdiction, persons, fallbackLimit } = {}) {
  const candidate = resolveJobcenterRule(String(listing?.location || ''), persons);
  const value = Number(candidate?.rule?.grossColdLimit);
  if (candidate?.status === 'verified' && candidate?.jurisdiction === jurisdiction && Number.isFinite(value) && value > 0) return value;
  const fallback = Number(fallbackLimit);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

export function filterDistrictListingsToOwnLimits(listings, options = {}) {
  const source = Array.isArray(listings) ? listings : [];
  const kept = source.filter(item => {
    const price = Number(item?.price);
    const limit = districtListingOwnLimit(item, options);
    return !Number.isFinite(price) || !Number.isFinite(limit) || price <= limit;
  });
  return { listings:kept, excluded:source.length - kept.length };
}

export function districtLimitNote({ jurisdiction, location, persons, ownLimit, searchLimit, excluded = 0 } = {}) {
  const own = guidelineNumber(ownLimit);
  const max = guidelineNumber(searchLimit);
  const dropped = Math.max(0, Number(excluded) || 0);
  return [
    `💶 Ціну кожного оголошення перевірено за нормою своєї громади (осіб: ${persons}).`,
    own ? `Ваша норма — ${location}: до ${own} € Bruttokaltmiete.` : null,
    max && Number(searchLimit) > Number(ownLimit)
      ? `Пошук ішов до ${max} € — найвища підтверджена межа серед громад ${jurisdiction}; оголошення, дорожчі за норму своєї громади, не показуються.`
      : null,
    dropped ? `Відсіяно як дорожчі за норму своєї громади: ${dropped}.` : null
  ].filter(Boolean).join('\n');
}

function districtKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ß/gu, 'ss')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function districtAnchorLocations(jurisdiction, originLocation = '') {
  const origin = String(originLocation || '').replace(/\s+/gu, ' ').trim();
  const originKey = districtKey(origin);
  const candidates = [...new Set(
    SH_UKRAINIAN_PLACE_ROWS
      .filter(row => row?.jurisdiction === jurisdiction)
      .map(row => String(row?.canonical || '').replace(/\s+/gu, ' ').trim())
      .filter(Boolean)
      .filter(name => jurisdictionForHousingLocation(name) === jurisdiction)
  )].filter(name => districtKey(name) !== originKey);

  if (candidates.length <= DISTRICT_ANCHOR_LIMIT - 1) {
    return [origin, ...candidates].filter(Boolean);
  }

  const slots = DISTRICT_ANCHOR_LIMIT - 1;
  const picked = [];
  for (let i = 0; i < slots; i++) {
    const index = slots === 1 ? 0 : Math.round(i * (candidates.length - 1) / (slots - 1));
    const name = candidates[index];
    if (name && !picked.includes(name)) picked.push(name);
  }
  for (const name of candidates) {
    if (picked.length >= slots) break;
    if (!picked.includes(name)) picked.push(name);
  }
  return [origin, ...picked].filter(Boolean).slice(0, DISTRICT_ANCHOR_LIMIT);
}

function normalizedImageKey(value) {
  const url = String(value || '').trim();
  if (!/^https:\/\//iu.test(url)) return null;
  return url.replace(/[?#].*$/u, '');
}

function strongListingFingerprint(item) {
  const title = districtKey(item?.title);
  const location = districtKey(item?.location);
  const price = Number(item?.price);
  const rooms = Number(item?.rooms);
  const area = Number(item?.areaSqm);
  if (!title || !location || !Number.isFinite(price)) return null;
  return [
    title,
    location,
    Math.round(price * 100) / 100,
    Number.isFinite(rooms) ? Math.round(rooms * 10) / 10 : '',
    Number.isFinite(area) ? Math.round(area) : ''
  ].join('|');
}

export function mergeDistrictListings(groups, originLocation = '', max = 12) {
  const seenUrls = new Set();
  const seenImages = new Set();
  const seenFingerprints = new Set();
  const unique = [];

  for (const item of (Array.isArray(groups) ? groups.flat() : [])) {
    if (!item) continue;
    const url = String(item?.url || '').trim();
    const image = normalizedImageKey(item?.imageUrl);
    const fingerprint = strongListingFingerprint(item);
    if (url && seenUrls.has(url)) continue;
    if (image && seenImages.has(image)) continue;
    if (fingerprint && seenFingerprints.has(fingerprint)) continue;
    if (url) seenUrls.add(url);
    if (image) seenImages.add(image);
    if (fingerprint) seenFingerprints.add(fingerprint);
    unique.push(item);
  }

  const crossPortalUnique = dedupeListings(unique);
  unique.length = 0;
  unique.push(...crossPortalUnique);

  const originKey = districtKey(originLocation);
  unique.sort((a, b) => {
    const aOrigin = originKey && districtKey(a?.location).includes(originKey) ? 1 : 0;
    const bOrigin = originKey && districtKey(b?.location).includes(originKey) ? 1 : 0;
    if (aOrigin !== bOrigin) return aOrigin - bOrigin;
    const aPrice = Number(a?.price);
    const bPrice = Number(b?.price);
    if (Number.isFinite(aPrice) && Number.isFinite(bPrice) && aPrice !== bPrice) return aPrice - bPrice;
    return String(a?.title || '').localeCompare(String(b?.title || ''), 'de');
  });
  return unique.slice(0, max);
}

// The origin anchor runs the same primary search as a radius search
// (Kleinanzeigen public pages, ohne-makler, KIP): ohne-makler 2 + KIP 4 +
// Kleinanzeigen public 1 + 3 + 6 provider calls, Immomio 1, WG-Gesucht 2,
// Vonovia 2 (token + list), plus the API when configured; housing company
// pages are counted separately.
export const DISTRICT_ORIGIN_PROVIDER_CALLS = 21;
// Each further anchor's Kleinanzeigen API search costs /locations + /search 203 + 205.
// Public-page recovery runs in parallel with it, so without a cap its pages
// used the provider share first and the API searches were refused. The API
// calls are reserved up front (only when a key is configured); recovery gets
// what remains, with the leftover going to the first anchor.
export const DISTRICT_API_CALLS_PER_ANCHOR = 3;

export function districtRecoveryPageCaps(anchorCount, providerBudget, apiCallsPerAnchor = DISTRICT_API_CALLS_PER_ANCHOR) {
  const count = Math.max(0, Math.floor(Number(anchorCount) || 0));
  if (!count) return [];
  const remaining = Math.max(0, Math.floor(Number(providerBudget) || 0) - count * Math.max(0, Number(apiCallsPerAnchor) || 0));
  const each = Math.floor(remaining / count);
  return Array.from({ length:count }, (_, index) => each + (index === 0 ? remaining - each * count : 0));
}

function cappedTransport(transport, maxCalls) {
  let calls = 0;
  return (url, options) => {
    if (calls >= maxCalls) return Promise.reject(new TypeError('District recovery page cap reached'));
    calls += 1;
    return transport(url, options);
  };
}

export async function searchDistrictHousing(displayCriteria, env, transport) {
  const jurisdiction = String(displayCriteria?.districtJurisdiction || '').trim();
  const anchors = districtAnchorLocations(jurisdiction, displayCriteria?.location);
  const apiCalls = klazKeyConfigured(klazApiKey(env)) ? DISTRICT_API_CALLS_PER_ANCHOR : 0;
  // Housing company pages the origin search may fetch come off the budget too.
  const companyCalls = companySourcesFor({ ...displayCriteria, location:anchors[0], radiusKm:DISTRICT_ANCHOR_RADIUS_KM, districtJurisdiction:jurisdiction }).length;
  const recoveryCaps = districtRecoveryPageCaps(
    Math.max(0, anchors.length - 1),
    providerSubrequestBudget(env) - DISTRICT_ORIGIN_PROVIDER_CALLS - companyCalls - apiCalls,
    apiCalls
  );
  const scoped = anchor => ({
    ...displayCriteria,
    location:anchor,
    radiusKm:DISTRICT_ANCHOR_RADIUS_KM,
    districtJurisdiction:jurisdiction
  });
  const originTask = anchors[0]
    ? settleWithin(
        searchPrimaryHousing(scoped(anchors[0]), klazApiKey(env), transport, { includeApi:apiCalls > 0, sourceTimeoutMs:DISTRICT_ANCHOR_TIMEOUT_MS }),
        DISTRICT_ANCHOR_TIMEOUT_MS + 500,
        () => ({ status:'timeout', listings:[], source:'district-origin-timeout' })
      ).then(primary => ({ anchor:anchors[0], primary, recovery:{ status:'skipped', listings:[] } }))
    : null;
  const anchorResults = await Promise.all([
    ...(originTask ? [originTask] : []),
    ...anchors.slice(1).map(async (anchor, index) => {
      const scopedCriteria = scoped(anchor);
      const recoveryCap = recoveryCaps[index] || 0;
      const [primary, recovery] = await Promise.all([
        apiCalls > 0
          ? settleWithin(
              searchLiveHousing(scopedCriteria, klazApiKey(env), transport, { includePublic:false }),
              DISTRICT_ANCHOR_TIMEOUT_MS,
              () => ({ status:'timeout', listings:[], source:'district-anchor-timeout' })
            )
          : { status:'skipped', listings:[] },
        recoveryCap > 0
          ? settleWithin(
              searchKleinanzeigenPublicRecovery(
                scopedCriteria,
                cappedTransport(transport, recoveryCap),
                // One page is the strict location search; the rest are catalog pages.
                { budgetMs:2200, targetDirectListings:5, maxSupplementalPages:recoveryCap - 1 }
              ),
              DISTRICT_RECOVERY_TIMEOUT_MS,
              () => ({ status:'timeout', listings:[] })
            )
          : { status:'skipped', listings:[] }
      ]);
      return { anchor, primary, recovery };
    })
  ]);

  const primaryGroups = [];
  const recoveryGroups = [];
  const sources = [];
  // A portal measures "(7 km)" from the place it was asked about. Only the
  // origin anchor is the user's start point, so other anchors' distances would
  // read as distances from it on the card (Issue #63: Travenbrück "≈7 км" from
  // Trittau was 7 km from Reinfeld).
  const fromAnchor = (listings, anchor) => anchor === anchors[0]
    ? listings
    : listings.map(item => (Number.isFinite(item?.distanceKm) ? { ...item, distanceKm:null } : item));
  for (const entry of anchorResults) {
    const primary = fromAnchor(filterHousingListingsToJurisdiction(entry.primary?.listings, jurisdiction, displayCriteria?.location), entry.anchor);
    const recovery = fromAnchor(filterHousingListingsToJurisdiction(entry.recovery?.listings, jurisdiction, displayCriteria?.location), entry.anchor);
    primaryGroups.push(primary);
    recoveryGroups.push(recovery);
    sources.push(
      {
        source:`district-anchor:${entry.anchor || 'unknown'}`,
        status:entry.primary?.status || 'unavailable',
        count:primary.length
      },
      {
        source:`district-public:${entry.anchor || 'unknown'}`,
        status:entry.recovery?.status || 'unavailable',
        count:recovery.length
      }
    );
  }

  const listings = mergeDistrictListings([...primaryGroups, ...recoveryGroups], displayCriteria?.location, 12);
  const readable = sources.some(result => result.status === 'ok');

  return {
    status:listings.length ? 'ok' : readable ? 'ok' : 'unavailable',
    listings:listings.slice(0, 12),
    source:'district_multi_anchor_parallel',
    // The origin anchor's portal-by-portal outcome, for the daily report.
    primarySources:anchorResults[0]?.primary?.sources || [],
    resolvedLocation:jurisdiction,
    radiusKm:null,
    criteria:displayCriteria,
    districtAnchors:anchors,
    sources
  };
}

async function searchAtRadius({ location, rooms, persons, radius, previousRadius, resolved, districtJurisdiction = null }, env, transport) {
  const originLimit = Number(resolved?.rule?.grossColdLimit);
  const limit = districtJurisdiction
    ? districtSearchLimit(districtJurisdiction, persons, originLimit, location)
    : originLimit;
  const jobcenterJurisdiction = String(resolved?.jurisdiction || resolved?.module?.jurisdiction || '').trim() || null;
  // The Jobcenter limit is a price, not a room count: a larger flat whose
  // Bruttokaltmiete fits is still a candidate, so only the lower bound stays.
  const roomSpec = parseRoomSpec(rooms);
  const displayCriteria = {
    location,
    rooms,
    ...(roomSpec ? { roomsMin:roomSpec.min, roomsMax:Math.max(roomSpec.max, JOBCENTER_SEARCH_MAX_ROOMS) } : {}),
    amount:limit,
    type:'Bruttokaltmiete',
    radiusKm:radius,
    ...(jobcenterJurisdiction ? { jobcenterJurisdiction } : {}),
    ...(districtJurisdiction ? { districtJurisdiction } : {})
  };

  // The sources support 5/10/15/25/50 km. For an exact 20 km user choice,
  // query 25 km and then strictly keep only listings whose measured distance
  // is <= 20 km; listings without a measured distance are dropped.
  const providerCriteria = radius === 20 ? { ...displayCriteria, radiusKm:25 } : displayCriteria;
  let found = districtJurisdiction
    ? await settleWithinAbortable(
        signal => searchDistrictHousing(
          displayCriteria,
          env,
          transportWithAbortSignal(transport, signal)
        ),
        DISTRICT_TOTAL_SEARCH_TIMEOUT_MS,
        () => ({
          status:'timeout',
          listings:[],
          source:'district-total-timeout',
          resolvedLocation:districtJurisdiction,
          radiusKm:null,
          criteria:displayCriteria,
          sources:[{ source:'district-total', status:'timeout', count:0 }]
        })
      )
    : await settleWithinAbortable(
        async signal => {
          const boundedTransport = transportWithAbortSignal(transport, signal);
          // Public portals are the primary sources; the paid API is an extra.
          return searchPrimaryHousing(providerCriteria, klazApiKey(env), boundedTransport);
        },
        LOCAL_TOTAL_SEARCH_TIMEOUT_MS,
        () => ({
          status:'timeout',
          listings:[],
          source:'local-total-timeout',
          resolvedLocation:location,
          radiusKm:radius,
          criteria:displayCriteria
        })
      );

  // Which housing sources answered, for the admins' daily report (one call).
  recordOpsMetrics(env, opsSourceKeys(districtJurisdiction ? found?.primarySources : found?.sources)).catch(() => {});

  const radiusBoundResult = radius === 20
    ? {
        ...found,
        listings:Array.isArray(found?.listings)
          ? found.listings.filter(item => Number.isFinite(item?.distanceKm) && item.distanceKm <= 20)
          : [],
        radiusKm:20,
        criteria:displayCriteria
      }
    : found;

  const districtBoundResult = districtJurisdiction
    ? {
        ...radiusBoundResult,
        listings:filterHousingListingsToJurisdiction(radiusBoundResult?.listings, districtJurisdiction, location),
        criteria:displayCriteria
      }
    : radiusBoundResult;

  return {
    criteria:displayCriteria,
    result:filterExpandedRadiusResult(districtBoundResult, previousRadius, radius)
  };
}

// TG-RUNTIME-056: the saved-search monitor (housing-watch.mjs) re-runs the
// same radius search a user chose, with the same limit and filters.
export async function housingWatchSearch({ location, rooms, persons, radius }, env, transport) {
  const resolved = resolveJobcenterRule(location, persons);
  const limit = Number(resolved?.rule?.grossColdLimit);
  const kreis = radius === 'kreis';
  if (resolved?.status !== 'verified' || !Number.isFinite(limit) || limit <= 0 || (!kreis && !RADII.includes(radius))) return { status:'unverified', listings:[] };
  if (!kreis) {
    const { result } = await searchAtRadius({ location, rooms, persons, radius, previousRadius:null, resolved }, env, transport);
    // TG-RUNTIME-063: the limit each listing was checked against travels with
    // it, so the alert can add the Nebenkosten from the ad page.
    return { status:String(result?.status || 'unavailable'), listings:(Array.isArray(result?.listings) ? result.listings : []).map(item => ({ ...item, limit })), amount:limit };
  }
  // TG-RUNTIME-057: the whole-Kreis search, with each listing checked
  // against the limit of its own municipality, as deliverSearch does.
  const districtJurisdiction = String(resolved?.jurisdiction || resolved?.module?.jurisdiction || '').trim();
  if (!districtJurisdiction) return { status:'unverified', listings:[] };
  const { result } = await searchAtRadius({ location, rooms, persons, radius:50, previousRadius:null, resolved, districtJurisdiction }, env, transport);
  const listings = Array.isArray(result?.listings) ? result.listings : [];
  const own = { jurisdiction:districtJurisdiction, persons, fallbackLimit:limit };
  const fitting = filterDistrictListingsToOwnLimits(listings, own).listings.map(item => ({ ...item, limit:districtListingOwnLimit(item, own) }));
  return { status:String(result?.status || 'unavailable'), listings:fitting, amount:limit };
}

async function deliverSearch({ config, chatId, userId, location, rooms, persons, radius, previousRadius, resolved, districtJurisdiction = null, districtToken = null, page = 0, progressMessageId = null, env, transport, now = Date.now() }) {
  const searchStarted = Date.now();
  const { criteria, result } = await searchAtRadius({ location, rooms, persons, radius, previousRadius, resolved, districtJurisdiction }, env, transport);
  const rawListings = Array.isArray(result?.listings) ? result.listings : [];
  const jobcenterJurisdiction = String(resolved?.jurisdiction || resolved?.module?.jurisdiction || '').trim() || null;
  const signature = jobcenterSearchSignature({
    location,
    persons,
    rooms,
    jurisdiction:districtJurisdiction || jobcenterJurisdiction
  });

  // Whole-Kreis queries the provider with the highest limit among the zones,
  // so each listing is re-checked against the limit of its own municipality.
  const ownLimit = Number(resolved?.rule?.grossColdLimit);
  const limitFit = districtJurisdiction
    ? filterDistrictListingsToOwnLimits(rawListings, { jurisdiction:districtJurisdiction, persons, fallbackLimit:ownLimit })
    : { listings:rawListings, excluded:0 };
  const fittingListings = limitFit.listings;
  const limitNote = districtJurisdiction
    ? districtLimitNote({ jurisdiction:districtJurisdiction, location, persons, ownLimit, searchLimit:criteria.amount, excluded:limitFit.excluded })
    : null;

  let districtBaseline = [];
  let allListings = fittingListings;
  if (districtJurisdiction && signature) {
    const state = await jobcenterSearchStateCall(env, {
      op:'district_baseline',
      chatId,
      userId,
      signature,
      initialize:page === 0,
      now
    });
    districtBaseline = normalizedStateKeys(state?.baseline);
    allListings = filterUnseenDistrictListings(fittingListings, districtBaseline);
  }

  const pageStart = Math.max(0, page) * LISTINGS_PAGE_SIZE;
  // TG-RUNTIME-064: result pages show the Kaltmiete only. The ad pages of the
  // Kleinanzeigen listings on this page give the Nebenkosten; a card over
  // the limit with them is marked (it stays, so paging is unchanged).
  const listingLimit = item => districtJurisdiction
    ? districtListingOwnLimit(item, { jurisdiction:districtJurisdiction, persons, fallbackLimit:ownLimit })
    : Number(criteria.amount);
  const pageListings = await withKleinanzeigenAdCosts(
    allListings.slice(pageStart, pageStart + LISTINGS_PAGE_SIZE).map(item => ({ ...item, limit:listingLimit(item) })),
    transport,
    { timeoutMs:adCostsTimeLeft(searchStarted, districtJurisdiction ? DISTRICT_TOTAL_SEARCH_TIMEOUT_MS : LOCAL_TOTAL_SEARCH_TIMEOUT_MS) }
  );
  const hasMoreListings = allListings.length > pageStart + pageListings.length;
  const pageResult = { ...result, listings:pageListings };
  const authority = resolved?.module?.authority || resolved?.rule?.authority || 'Jobcenter';
  const maxArea = districtJurisdiction ? null : Number(resolved?.rule?.maxAreaSqm);
  const isExpansion = !districtJurisdiction && RADII.includes(previousRadius) && radius > previousRadius;
  const intro = [
    `🔎 Автопошук житла під Jobcenter — ${location}`,
    `Осіб: ${persons}`,
    `Кімнати: ${rooms}`,
    districtJurisdiction
      ? `Орієнтир пошуку ${authority}: до ${euro(criteria.amount)} € Bruttokaltmiete — максимальна підтверджена межа серед зон цієї території; для конкретної громади норма перевіряється окремо.`
      : `Орієнтир ${authority}: до ${euro(criteria.amount)} € Bruttokaltmiete${Number.isFinite(maxArea) && maxArea > 0 ? `; площа-орієнтир до ${shownNumber(maxArea)} м²` : ''}.`,
    'Heizkosten перевіряються окремо.',
    districtJurisdiction
      ? `Територія Jobcenter/Kreis: ${districtJurisdiction}.`
      : `Jobcenter/Kreis: ${jobcenterJurisdiction || 'невизначено'}.\nРадіус пошуку: ${radius} км.`,
    districtJurisdiction ? 'Результати з інших Jobcenter/Kreis відсікаються.' : null,
    districtJurisdiction ? 'Показую лише нові оголошення, яких ще не було в цьому пошуку.' : null,
    isExpansion ? `Показую лише нові варіанти в доданій зоні понад ${previousRadius} км, щоб не повторювати вже показані оголошення.` : null,
    '',
    '⚠️ Це автоматичний пошук кандидатів, а не Zusicherung. Ціна в оголошенні може бути Kaltmiete, Warmmiete або неповною. Для кожної квартири потрібно окремо перевірити Kaltmiete + Betriebskosten без Heizkosten.'
  ].filter(Boolean).join('\n');

  const listingText = formatHousingListings(districtJurisdiction ? { ...criteria, location:districtJurisdiction } : criteria, pageResult);
  const areaWarnings = jobcenterAreaWarnings(pageResult?.listings, maxArea);
  const text = `${intro}\n\n${listingText}${areaWarnings ? `\n\n${areaWarnings}` : ''}`.slice(0, 4096);
  const rawReplyMarkup = pageResult.status === 'ok' && pageListings.length
    ? housingListingsMarkup(pageResult)
    : districtJurisdiction
      ? null
      : radius === 20
        ? exactRadiusExternalMarkup(criteria)
        : externalHousingSearchMarkup(criteria);
  const replyMarkup = scopedJobcenterSearchMarkup(rawReplyMarkup, authority, criteria, { preserveListingRows:true });
  const context = { location, persons, rooms:{ label:rooms }, criteria, resolved };
  const media = pageResult.status === 'ok' && pageListings.length
    ? jobcenterPhotoCards({ ...pageResult, criteria }, context, authority, maxArea)
    : [];

  const incomplete = result?.status !== 'ok';

  // Top-level navigation can invalidate a detached district task while provider
  // work is still in flight. A cancelled task must not write into the new chat flow.
  if (districtJurisdiction && districtToken
      && !(await districtBackgroundStillOwned(env, chatId, userId, districtToken))) {
    return json({
      ok:true,
      mode:'private-jobcenter-district-search-cancelled',
      delivered:true,
      cancelled:true,
      districtJurisdiction,
      mediaCount:0
    });
  }

  // Zero-result and timeout states must be complete in one visible terminal message.
  // Keep the provider's canonical empty/failure marker in local messages so the
  // existing recovery transport can still replace it with ImmoScout/KIP/public
  // candidates when those sources are available.
  if (pageListings.length === 0) {
    const controls = finalSearchControlsMarkup({
      location,
      rooms,
      persons,
      radius:districtJurisdiction ? null : radius,
      districtSelected:Boolean(districtJurisdiction),
      page,
      hasMore:false
    });
    const terminalText = districtJurisdiction
      ? (incomplete
          ? districtSearchUnavailableText(districtJurisdiction)
          : [districtNoNewMessage(districtJurisdiction, districtBaseline.length, fittingListings.length), limitNote].filter(Boolean).join('\n\n'))
      : (hasHousingFallbackMarker(listingText) || housingProviderFailureText(listingText))
        // The housing transport replaces the marker with the public-source
        // result, which already says what was found or why nothing was. A
        // local summary in front of it repeated the header and the "not
        // found" (Issue #63 B, phone smoke 17.10.2026).
        ? [intro, listingText].join('\n\n')
        : [
          intro,
          incomplete
            ? localSearchUnavailableText(location)
            : localSearchSummaryPayload({
                location,
                rooms,
                persons,
                radius,
                jurisdiction:jobcenterJurisdiction,
                page,
                total:allListings.length,
                visible:0
              }).text,
          listingText
        ].filter(Boolean).join('\n\n');
    const terminal = await deliverDistrictTerminal({
      config,
      chatId,
      progressMessageId:page === 0 ? progressMessageId : null,
      text:terminalText,
      replyMarkup:controls,
      transport,
      visibleNewMessage:true
    });
    return json({
      ok:true,
      mode:districtJurisdiction
        ? 'private-jobcenter-district-search'
        : (result?.status === 'timeout' ? 'private-jobcenter-radius-search-timeout' : 'private-jobcenter-radius-search'),
      delivered:terminal.ok,
      radiusChooserDelivered:terminal.ok && Boolean(controls),
      radiusKm:districtJurisdiction ? null : radius,
      previousRadiusKm:districtJurisdiction ? null : previousRadius,
      ...(districtJurisdiction ? { districtJurisdiction, districtSummaryDelivered:terminal.ok } : { localSummaryDelivered:terminal.ok }),
      terminalMode:terminal.mode,
      mediaCount:0,
      ...(districtJurisdiction ? { newListings:0, alreadyShown:districtBaseline.length } : {})
    });
  }

  // Whole-Kreis results arrive as the same photo cards as a radius search. The
  // search runs in its Durable Object alarm (85 s watchdog); card delivery is
  // bounded by MEDIA_DELIVERY_TIMEOUT_MS like every other search.
  if (districtJurisdiction && districtToken
      && !(await districtBackgroundStillOwned(env, chatId, userId, districtToken))) {
    return json({
      ok:true,
      mode:'private-jobcenter-district-search-cancelled',
      delivered:true,
      cancelled:true,
      districtJurisdiction,
      mediaCount:0
    });
  }

  // Replace the stale "Шукаю…" line, but keep the final summary as a NEW message
  // after every listing so it remains visible even if the user sent /start meanwhile.
  await markProgressCompleted(config, chatId, page === 0 ? progressMessageId : null, transport);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_DELIVERY_TIMEOUT_MS);
  try {
    const delivered = await settleWithin(
      sendHousingMediaReply({
        config:{ ...config, chatId },
        media,
        text,
        // Listing cards keep only direct listing actions. Pagination + radius/Kreis
        // are emitted once, after all cards, by postText/postReplyMarkup.
        replyMarkup:media.length ? null : replyMarkup,
        transport,
        signal:controller.signal,
        replyToMessageId:null,
        ownerUserId:userId,
        separateItems:true,
        postText:delivery => {
          if (delivery.partial) {
            return partialDeliverySummary({
              location,
              rooms,
              persons,
              districtJurisdiction,
              radius,
              sent:delivery.sent,
              requested:delivery.requested
            });
          }
          if (districtJurisdiction) {
            return [districtSummaryPayload({
              jurisdiction:districtJurisdiction,
              listings:pageListings,
              pageStart,
              total:allListings.length,
              hasMore:hasMoreListings,
              location,
              persons,
              rooms,
              alreadyShown:fittingListings.length - allListings.length
            }).text, limitNote].filter(Boolean).join('\n\n').slice(0, 4096);
          }
          return localSearchSummaryPayload({
            location,
            rooms,
            persons,
            radius,
            previousRadius:isExpansion ? previousRadius : null,
            jurisdiction:jobcenterJurisdiction,
            page,
            total:allListings.length,
            visible:pageListings.length
          }).text;
        },
        postReplyMarkup:delivery => finalSearchControlsMarkup({
          location,
          rooms,
          persons,
          radius:districtJurisdiction ? null : radius,
          previousRadius:isExpansion ? previousRadius : null,
          districtSelected:Boolean(districtJurisdiction),
          page,
          hasMore:delivery.partial ? false : hasMoreListings
        })
      }),
      MEDIA_DELIVERY_TIMEOUT_MS,
      () => ({ status:'timeout', mediaCount:0, requestedCount:media.length, partial:true })
    );

    const deliveredOk = delivered.status === 'sent';
    const finalDelivered = delivered.postTextDelivered !== false && deliveredOk;
    if (signature && deliveredOk) {
      // Record only the number of cards Telegram positively confirmed. This prevents
      // a partial delivery from marking unseen listings as already shown.
      const confirmedCount = Math.min(pageListings.length, Math.max(0, Number(delivered.mediaCount) || 0));
      const shownKeys = pageListings.slice(0, confirmedCount || pageListings.length).flatMap(item => [listingStateKey(item), crossPortalSeenKey(item)]).filter(Boolean);
      const resetSeen = !districtJurisdiction && page === 0 && !RADII.includes(previousRadius);
      await jobcenterSearchStateCall(env, {
        op:'record_seen',
        chatId,
        userId,
        signature,
        keys:shownKeys,
        reset:resetSeen,
        now
      });
    }

    // If the media layer could not produce the final post message at all, create
    // an explicit visible fallback so no successful search ends in silence.
    if (!finalDelivered) {
      const fallbackControls = finalSearchControlsMarkup({
        location,
        rooms,
        persons,
        radius:districtJurisdiction ? null : radius,
        districtSelected:Boolean(districtJurisdiction),
        page,
        hasMore:false
      });
      const fallback = await deliverDistrictTerminal({
        config,
        chatId,
        text:partialDeliverySummary({
          location,
          rooms,
          persons,
          districtJurisdiction,
          radius,
          sent:Number(delivered.mediaCount) || 0,
          requested:pageListings.length
        }),
        replyMarkup:fallbackControls,
        transport,
        visibleNewMessage:true
      });
      return json({
        ok:true,
        mode:districtJurisdiction ? 'private-jobcenter-district-search-partial' : 'private-jobcenter-radius-search-partial',
        delivered:fallback.ok,
        radiusChooserDelivered:fallback.ok && Boolean(fallbackControls),
        radiusKm:districtJurisdiction ? null : radius,
        previousRadiusKm:districtJurisdiction ? null : previousRadius,
        ...(districtJurisdiction ? { districtJurisdiction, districtSummaryDelivered:fallback.ok } : { localSummaryDelivered:fallback.ok }),
        mediaCount:Number(delivered.mediaCount) || 0,
        partial:true
      });
    }

    return json({
      ok:true,
      mode:districtJurisdiction ? 'private-jobcenter-district-search' : 'private-jobcenter-radius-search',
      delivered:true,
      radiusChooserDelivered:true,
      radiusKm:districtJurisdiction ? null : radius,
      previousRadiusKm:districtJurisdiction ? null : previousRadius,
      ...(districtJurisdiction ? { districtJurisdiction, districtSummaryDelivered:true } : { localSummaryDelivered:true }),
      mediaCount:delivered.mediaCount || 0,
      ...(delivered.partial ? { partial:true } : {})
    });
  } finally {
    clearTimeout(timeout);
  }
}

function callbackContext(data) {
  const districtPage = JOBCENTER_DISTRICT_PAGE_CALLBACK.exec(data);
  if (districtPage) return { district:true, page:Number(districtPage[1]), radius:25, persons:Number(districtPage[2]), rooms:districtPage[3], location:decodeLocation(districtPage[4]) };
  const district = JOBCENTER_DISTRICT_CALLBACK.exec(data);
  if (district) {
    return {
      district:true,
      radius:25,
      persons:Number(district[1]),
      rooms:district[2],
      location:decodeLocation(district[3])
    };
  }
  const initial = JOBCENTER_ACTION_CALLBACK.exec(data);
  if (initial) {
    return {
      radius:DEFAULT_RADIUS_KM,
      persons:Number(initial[1]),
      rooms:initial[2],
      location:decodeLocation(initial[3])
    };
  }
  const radius = JOBCENTER_RADIUS_CALLBACK.exec(data);
  if (!radius) return null;
  return {
    radius:Number(radius[1]),
    persons:Number(radius[2]),
    rooms:radius[3],
    location:decodeLocation(radius[4])
  };
}

export async function maybeHandleJobcenterRadiusSearch(request, env, now, transport) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const update = parsed.value;
  const query = update?.callback_query;
  if (!query) return null;
  const data = String(query?.data || '');
  const radiusPage = JOBCENTER_RADIUS_PAGE_CALLBACK.exec(data);
  const context = radiusPage
    ? radiusPageContextFromText(query?.message?.text, Number(radiusPage[1]))
    : callbackContext(data);
  if (!context) return null;

  const chatId = Number(query?.message?.chat?.id);
  const userId = Number(query?.from?.id);
  const previousRadius = radiusPage
    ? (radiusPage[2] ? Number(radiusPage[2]) : null)
    : previousRadiusFromChooser(query?.message?.text);
  const { location, rooms, persons, radius, district = false, page = 0 } = context;
  if (query?.message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || query?.from?.is_bot === true) return null;
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20 || !/^\d{1,2}(?:-\d{1,2})?$/u.test(rooms) || !location || !RADII.includes(radius)) return null;
  if (!(await privatePilotAccessAllowed(update, config, transport))) return null;

  const callbackAlreadyAnswered = request.headers.get(JOBCENTER_BACKGROUND_ACK_HEADER) === '1';
  if (!callbackAlreadyAnswered) await answerCallback(config, query, transport);
  const backgroundProgressMessageId = Number(request.headers.get(JOBCENTER_BACKGROUND_PROGRESS_HEADER));
  const resolved = resolveJobcenterRule(location, persons);
  const limit = Number(resolved?.rule?.grossColdLimit);
  if (resolved?.status !== 'verified' || !Number.isFinite(limit) || limit <= 0) {
    const delivered = await sendUnavailable(config, chatId, resolved, transport);
    return json({ ok:true, mode:'jobcenter-housing-search-unverified', delivered, location, rooms, persons });
  }

  if (district) {
    const jurisdiction = String(resolved?.jurisdiction || resolved?.module?.jurisdiction || '').trim();
    if (!jurisdiction) return json({ ok:false, mode:'jobcenter-district-search-unresolved', location, rooms, persons }, 422);

    const signature = jobcenterSearchSignature({ location, persons, rooms, jurisdiction });
    const token = String(query?.id || '').slice(0, 256);
    const backgroundLockAcquired = request.headers.get(JOBCENTER_BACKGROUND_LOCK_HEADER) === '1';
    const lock = backgroundLockAcquired
      ? { status:'ok', acquired:true, prepared:true }
      : signature && token
        ? await jobcenterSearchStateCall(env, {
            op:'district_acquire',
            chatId,
            userId,
            signature,
            token,
            now
          })
        : { status:'unavailable' };

    if (lock?.status === 'ok' && lock?.acquired !== true) {
      const sent = await telegramJSON(config, 'sendMessage', {
        chat_id:chatId,
        text:`⏳ Пошук по Jobcenter/Kreis ${jurisdiction} уже виконується. Дочекайтеся фінальної відповіді цього пошуку.`,
        disable_notification:true
      }, transport);
      return json({
        ok:true,
        mode:'private-jobcenter-district-search-in-flight',
        duplicateSuppressed:true,
        delivered:sent.ok,
        districtJurisdiction:jurisdiction
      });
    }

    if (env?.OUTBOX && lock?.status !== 'ok') {
      const sent = await telegramJSON(config, 'sendMessage', {
        chat_id:chatId,
        text:districtSearchStateUnavailableText(jurisdiction),
        disable_notification:true
      }, transport);
      return json({
        ok:true,
        mode:'private-jobcenter-district-search-lock-unavailable',
        delivered:sent.ok,
        districtJurisdiction:jurisdiction
      });
    }

    const lockAcquired = lock?.status === 'ok' && lock?.acquired === true;
    let progressMessageId = page === 0 && Number.isSafeInteger(backgroundProgressMessageId) && backgroundProgressMessageId > 0
      ? backgroundProgressMessageId
      : null;
    if (page === 0 && progressMessageId === null) {
      const progress = await telegramJSON(config, 'sendMessage', {
        chat_id:chatId,
        text:districtSearchProgressText(jurisdiction),
        disable_notification:true
      }, transport);
      const candidate = Number(progress?.data?.result?.message_id);
      progressMessageId = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
    }

    try {
      // "Search whole district" is an administrative scope, not a larger-radius
      // approximation. We still use the provider's widest query window to collect
      // candidates, but only listings belonging to this Jobcenter/Kreis are allowed
      // to reach presentation.
      return await deliverSearch({
        config, chatId, userId, location, rooms, persons,
        radius:50,
        previousRadius:null,
        resolved,
        districtJurisdiction:jurisdiction,
        districtToken:token,
        page,
        progressMessageId,
        env,
        transport,
        now
      });
    } catch (error) {
      console.error('jobcenter_district_search_delivery_failed', {
        jurisdiction,
        name:String(error?.name || 'Error'),
        message:safeLogText(error?.message || 'District search delivery failed')
      });
      const markup = radiusMarkup(location, rooms, persons, null, true);
      const terminal = await deliverDistrictTerminal({
        config,
        chatId,
        progressMessageId,
        text:districtSearchUnavailableText(jurisdiction),
        replyMarkup:markup,
        transport,
        visibleNewMessage:true
      });
      return json({
        ok:true,
        mode:'private-jobcenter-district-search-recovered',
        delivered:terminal.ok,
        districtJurisdiction:jurisdiction,
        recoveredFromError:true
      });
    } finally {
      if (lockAcquired && signature && token) {
        await jobcenterSearchStateCall(env, {
          op:'district_release',
          chatId,
          userId,
          signature,
          token,
          now:Date.now()
        });
      }
    }
  }

  let progressMessageId = page === 0 && Number.isSafeInteger(backgroundProgressMessageId) && backgroundProgressMessageId > 0
    ? backgroundProgressMessageId
    : null;
  if (page === 0 && progressMessageId === null) {
    const progress = await telegramJSON(config, 'sendMessage', {
      chat_id:chatId,
      text:localSearchProgressText(location),
      disable_notification:true
    }, transport);
    const candidate = Number(progress?.data?.result?.message_id);
    progressMessageId = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
  }
  try {
    return await deliverSearch({
      config, chatId, userId, location, rooms, persons, radius, previousRadius, resolved,
      page, progressMessageId, env, transport, now
    });
  } catch (error) {
    console.error('jobcenter_local_search_delivery_failed', {
      location:safeLogText(location, 80),
      name:String(error?.name || 'Error'),
      message:safeLogText(error?.message || 'Local search delivery failed')
    });
    const terminal = await deliverDistrictTerminal({
      config,
      chatId,
      progressMessageId,
      text:localSearchUnavailableText(location),
      replyMarkup:radiusMarkup(location, rooms, persons, radius),
      transport,
      visibleNewMessage:true
    });
    return json({
      ok:true,
      mode:'private-jobcenter-local-search-recovered',
      delivered:terminal.ok,
      location,
      rooms,
      persons,
      radius,
      recoveredFromError:true
    });
  }
}
function guidelineNumber(value) {
  // TG-RUNTIME-078 review: Hamburg publishes no area (null), which showed as
  // "Площа-орієнтир: 0 м²".
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return (Math.round(number * 100) / 100).toLocaleString('de-DE', { minimumFractionDigits: number % 1 ? 2 : 0, maximumFractionDigits: 2 });
}
function shownDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value || ''));
  return match ? `${match[3]}.${match[2]}.${match[1]}` : String(value || '').trim();
}

function jobcenterGuidelineText(location, rooms, persons, resolved) {
  const rule = resolved?.rule;
  const authority = rule?.authority || resolved?.module?.authority || 'Jobcenter';
  const amount = guidelineNumber(rule?.grossColdLimit);
  const area = guidelineNumber(rule?.maxAreaSqm);
  const validFrom = shownDate(rule?.validFrom);
  const sourceUrl = String(rule?.sourceUrl || resolved?.module?.sources?.[0]?.url || '').trim();
  const territory = String(rule?.zoneLabel || rule?.municipality || resolved?.jurisdiction || '').trim();

  return [
    `Тема: житло — ${location}. Локацію вже визначено.`,
    `Осіб: ${persons}`,
    `Кімнат: ${rooms}`,
    '',
    `🏛 Орієнтири ${authority}`,
    // The same notice as the compact Jobcenter message (jobcenter-compact-message.mjs).
    resolved?.jurisdiction === 'Hamburg' ? '📍 Hamburg — окрема федеральна земля, НЕ Schleswig-Holstein.' : null,
    territory ? `Територія: ${territory}.` : null,
    area ? `Площа-орієнтир: ${area} м² за опублікованою таблицею (довідково; сама по собі більша площа не є автоматичною відмовою).` : null,
    amount ? `Оренда без опалення: до ${amount} € на місяць.` : null,
    'Це Bruttokaltmiete: Kaltmiete + Betriebskosten без опалення.',
    'Опалення (Heizkosten): окремо, після перевірки Jobcenter. Загальну Warmmiete без суми опалення визначити не можна.',
    validFrom ? `Дані чинні з: ${validFrom}.` : null,
    sourceUrl ? `Джерело: ${sourceUrl}` : null,
    'Це орієнтир для пошуку. Остаточне погодження конкретного житла надає Jobcenter.',
    '',
    '🔎 Починаю пошук житла під ці параметри…'
  ].filter(Boolean).join('\n');
}
function searchButtonMarkup(location, rooms, persons) {
  const encoded = encodeLocation(location);
  if (!encoded) return null;
  return {
    inline_keyboard:[[
      {
        text:'🔎 Почати пошук',
        callback_data:`jcr:${DEFAULT_RADIUS_KM}:${persons}:${rooms}:${encoded}`
      }
    ]]
  };
}

function pausedGuidelineText(location, rooms, persons, resolved) {
  const base = jobcenterGuidelineText(location, rooms, persons, resolved)
    .replace(/\n+🔎 Починаю пошук житла під ці параметри…$/u, '');
  return `${base}\n\n📖 Ознайомтеся з нормою Jobcenter. Коли будете готові, натисніть «🔎 Почати пошук».`;
}

// TG-RUNTIME-078: the rooms typed in answer to a Jobcenter rooms question
// ("Для пошуку підтвердьте кількість кімнат", or the manual rooms step that
// carries "Умова: житло під Jobcenter.") get the same paused guideline with
// «🔎 Почати пошук» as the rooms button (hka:j); before, the condition was
// lost and the bot asked for the action again.
const JOBCENTER_ROOMS_QUESTION = /^Тема: житло — ([^.\n]{2,80})\. Локацію вже визначено\.[\s\S]*?(?:Для пошуку підтвердьте кількість кімнат|Вкажіть кількість кімнат)/u;

export async function maybeHandleJobcenterTypedRooms(request, env, now, transport) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error || parsed.value?.callback_query) return null;
  const message = normalizePilotUpdate(parsed.value, now);
  if (!message || message.chatType !== 'private') return null;
  const previous = String(message.replyToText || '');
  const question = JOBCENTER_ROOMS_QUESTION.exec(previous);
  if (!question || !/^Умова: житло під Jobcenter\.$/mu.test(previous)) return null;
  const persons = Number(/^Осіб:\s*(\d{1,2})$/mu.exec(previous)?.[1]);
  const rooms = parseRoomSpec(message.text)?.label;
  const location = question[1].trim();
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20 || !rooms || !/^\d{1,2}(?:-\d{1,2})?$/u.test(rooms)) return null;
  if (!(await privatePilotAccessAllowed(parsed.value, config, transport))) return null;
  const resolved = resolveJobcenterRule(location, persons);
  const limit = Number(resolved?.rule?.grossColdLimit);
  if (resolved?.status !== 'verified' || !Number.isFinite(limit) || limit <= 0) return null;
  const replyMarkup = searchButtonMarkup(location, rooms, persons);
  if (!replyMarkup) return null;
  const sent = await telegramJSON(config, 'sendMessage', {
    chat_id:message.chatId,
    text:pausedGuidelineText(location, rooms, persons, resolved),
    disable_notification:true,
    link_preview_options:{ is_disabled:true },
    reply_markup:replyMarkup
  }, transport);
  return json({ ok:true, mode:'jobcenter-guideline-awaiting-search-typed', delivered:sent.ok, location, rooms, persons, radiusKm:DEFAULT_RADIUS_KM });
}

export async function maybeHandleJobcenterPreSearch(request, env, transport) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const update = parsed.value;
  const query = update?.callback_query;
  const match = JOBCENTER_ACTION_CALLBACK.exec(String(query?.data || ''));
  if (!match) return null;

  const chatId = Number(query?.message?.chat?.id);
  const userId = Number(query?.from?.id);
  const persons = Number(match[1]);
  const rooms = match[2];
  const location = decodeLocation(match[3]);
  if (query?.message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || query?.from?.is_bot === true) return null;
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20 || !/^\d{1,2}(?:-\d{1,2})?$/u.test(rooms) || !location) return null;
  if (!(await privatePilotAccessAllowed(update, config, transport))) return null;

  const resolved = resolveJobcenterRule(location, persons);
  const limit = Number(resolved?.rule?.grossColdLimit);
  if (resolved?.status !== 'verified' || !Number.isFinite(limit) || limit <= 0) return null;

  if (request.headers.get(JOBCENTER_BACKGROUND_ACK_HEADER) !== '1' && typeof query?.id === 'string' && query.id) {
    await telegramJSON(config, 'answerCallbackQuery', { callback_query_id:query.id }, transport);
  }

  const replyMarkup = searchButtonMarkup(location, rooms, persons);
  if (!replyMarkup) return null;
  const sent = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text:pausedGuidelineText(location, rooms, persons, resolved),
    disable_notification:true,
    link_preview_options:{ is_disabled:true },
    reply_markup:replyMarkup
  }, transport);

  return json({
    ok:true,
    mode:'jobcenter-guideline-awaiting-search',
    delivered:sent.ok,
    location,
    rooms,
    persons,
    radiusKm:DEFAULT_RADIUS_KM
  });
}
