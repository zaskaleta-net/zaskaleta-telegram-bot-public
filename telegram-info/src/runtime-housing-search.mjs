// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { budgetFromText, budgetPhrase } from './housing-budget-line.mjs';
import { safeLogText } from './log-safe.mjs';
import { knownHousingLocation, parseHouseholdSize } from './housing-language.mjs';
import { pilotConfig, equalSecret, normalizePilotUpdate, readBoundedJSON, statelessDirectReplyEnabled } from './pilot-security.mjs';
import { resolveJobcenterRule } from './jobcenter-registry-statewide.mjs';
import { parseRoomSpec } from './rooms.mjs';
import { searchLiveHousing, formatHousingListings, housingListingMedia, housingListingsMarkup, externalHousingSearchMarkup, klazApiKey, housingSearchAction } from './housing-provider.mjs';
import { getLiveHousingAdDetail } from './housing-ad-detail.mjs';
import { sendHousingMediaReply } from './telegram-media.mjs';
import { adCostsLine } from './kleinanzeigen-ad-costs.mjs';
import { filterHousingListingsToJurisdiction } from './housing-jurisdiction-scope.mjs';
import { searchExpandedHousing } from './housing-expanded-v22.mjs';
import { searchPrimaryHousing } from './housing-primary-search.mjs';
import { formatEuro } from './listing-format.mjs';


const EXPLICIT_TOPIC = /(?:житл|квартир|wohnung|wohnraum|job[\s-]*center|джоб[\s-]*[цс][еэ]нт[еэ]?р|bürgergeld|buergergeld|bescheid|mitwirkung|widerspruch|kindergeld|familienkasse|ausländer|auslaender|aufenthalt|fiktions|arbeit|робот|курс|schule|школ|kita|садок|transport|транспорт|hvv|bahn|bus)/iu;
const JOBCENTER_TOPIC_PREFIX = 'Тема: Jobcenter.';
const HOUSEHOLD_COMPOSITION_CUE = /(?:сім['’ʼ]?ї|семь(?:я|и)|famil(?:ie|y)|доросл|взросл|adult|діт|реб[её]н|child|kinder|жін|женщин|frau|чолов|мужчин|mann|männer|maenner)/iu;
const EXPLICIT_NON_HOUSING_JOBCENTER = /(?:bürgergeld|buergergeld|bescheid|mitwirkung|widerspruch|kindergeld|familienkasse|frist|строк|підготовк[аи]\s+листа|лист(?:а|ом|у)?|brief)/iu;
const DEFAULT_JOBCENTER_SEARCH_RADIUS_KM = 15;
const OWNED_JOBCENTER_CALLBACK = /^jc:(\d{6,20}):u(\d{1,20})$/u;
const DISTRICT_SEARCH_CALLBACK = /^jcd:u(\d{1,20})$/u;
const NEXT_HOUSING_CALLBACK = /^jcn:([ld]):(\d{1,3}):u(\d{1,20})$/u;
const HOUSING_PAGE_SIZE = 5;
const COMMON_HOUSING_SOURCE_BUTTONS = new Set([
  '↗ Kleinanzeigen',
  '↗ ImmoScout24',
  '↗ Immowelt'
]);

function localHousingSourceButtons(authority) {
  const name = String(authority || '');
  if (/Dithmarschen/iu.test(name)) return new Set(['↗ Wohnungsunternehmen Dithmarschen']);
  if (/Pinneberg/iu.test(name)) return new Set(['↗ GKB Pinneberg', '↗ Neue GeWoGe Pinneberg']);
  if (/Ostholstein/iu.test(name)) return new Set(['↗ WOBAU Ostholstein']);
  if (/Lübeck|Luebeck/iu.test(name)) return new Set(['↗ TRAVE Lübeck', '↗ Lübecker Bauverein', '↗ NEUE LÜBECKER']);
  if (/Kiel/iu.test(name)) return new Set(['↗ WOGE Kiel', '↗ BG Kiel-Hassee', '↗ WBG Kiel-Ost']);
  if (/Neumünster|Neumuenster/iu.test(name)) return new Set(['↗ WOBAU Neumünster']);
  if (!/Schleswig-Flensburg/iu.test(name) && /Flensburg/iu.test(name)) return new Set(['↗ FAB Flensburg', '↗ SBV Flensburg']);
  return new Set();
}

function simplifiedPortalSearchUrl(label, criteria) {
  const location = String(criteria?.location || '').replace(/\s+/g, ' ').trim();
  const roomSpec = parseRoomSpec(criteria?.rooms);
  const rooms = roomSpec?.label || String(criteria?.rooms || '').trim();
  if (!location || !rooms) return null;
  const query = `${location} ${rooms} Zimmer Wohnung mieten`;
  if (label === '↗ ImmoScout24') return `https://www.google.com/search?q=${encodeURIComponent(`site:immobilienscout24.de ${query}`)}`;
  if (label === '↗ Immowelt') return `https://www.google.com/search?q=${encodeURIComponent(`site:immowelt.de ${query}`)}`;
  return null;
}

function rewriteGenericSearchButton(button, criteria) {
  const label = String(button?.text || '');
  const replacement = simplifiedPortalSearchUrl(label, criteria);
  return replacement ? { ...button, url:replacement } : button;
}

export function scopedJobcenterSearchMarkup(markup, authority = '', criteria = null, { preserveListingRows = false } = {}) {
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : null;
  if (!rows) return markup;
  const hasListingRows = rows.some(row => Array.isArray(row) && row.some(button => /^\d+\.\s/u.test(String(button?.text || ''))));
  const allowed = new Set([...COMMON_HOUSING_SOURCE_BUTTONS, ...localHousingSourceButtons(authority)]);
  // Listing actions belong to each photo card. Do not repeat the same
  // "open" + "Jobcenter" controls in the summary/navigation keyboard.
  const inline_keyboard = rows.map(row => (Array.isArray(row) ? row : []).filter(button => {
    const label = String(button?.text || '');
    if (/^\d+\.\s/u.test(label)) return preserveListingRows;
    if (hasListingRows) return false;
    return allowed.has(label);
  }).map(button => rewriteGenericSearchButton(button, criteria))).filter(row => row.length > 0);
  return { ...markup, inline_keyboard };
}

function shownNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100).replace('.', ',');
}

// A euro amount always shows its cents (943,80 €), as on listing cards.
function euro(value) {
  return Number.isFinite(Number(value)) ? formatEuro(value) : shownNumber(value);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripExtraSearchLink(caption) {
  return String(caption || '').replace(/\n<a href="[^"]+">🌐 Пошук ще у \d+ джерелах<\/a>\s*$/u, '');
}

function cardIndex(caption) {
  const value = Number(/^<b>(\d+)\.\s/u.exec(String(caption || ''))?.[1]);
  return Number.isSafeInteger(value) && value > 0 ? value - 1 : null;
}

export function jobcenterPhotoCards(result, context, authority, maxAreaSqm) {
  const maxArea = Number(maxAreaSqm);
  return housingListingMedia(result).map(card => {
    const index = cardIndex(card.caption);
    const listing = index == null ? null : result?.listings?.[index];
    const area = Number(listing?.areaSqm);
    const districtJurisdiction = String(context?.criteria?.districtJurisdiction || '').trim();
    const callbackJurisdiction = String(
      districtJurisdiction || context?.jurisdiction || context?.resolved?.jurisdiction || context?.criteria?.jobcenterJurisdiction || ''
    ).trim();
    const notes = [
      `Стартова точка: ${context?.location || context?.criteria?.location || ''}`,
      `Склад сім'ї: ${context?.persons || ''}`,
      `Кімнати: ${context?.rooms?.label || context?.rooms || context?.criteria?.rooms || ''}`,
      callbackJurisdiction ? `Територія Jobcenter/Kreis: ${callbackJurisdiction}.` : null,
      districtJurisdiction
        ? `🏛 ${authority}: пошук обмежено територією ${districtJurisdiction}. Для конкретної громади Bruttokaltmiete перевіряється за її чинною зоною Jobcenter.`
        : `🏛 ${authority}: до ${euro(context.criteria.amount)} € Bruttokaltmiete${Number.isFinite(maxArea) && maxArea > 0 ? `; площа-орієнтир до ${shownNumber(maxArea)} м² (не критерій автоматичного відсіву)` : ''}.`,
      'Heizkosten перевіряються окремо.'
    ];
    // TG-RUNTIME-064: Kaltmiete + Nebenkosten from the ad page, when read.
    notes.splice(3, 0, adCostsLine(listing));
    notes.push('Це кандидат для перевірки, не Zusicherung.');
    const suffix = notes.filter(Boolean).map(escapeHtml).join('\n');
    return { ...card, caption:`${stripExtraSearchLink(card.caption)}\n\n${suffix}` };
  });
}

export function jobcenterAreaWarnings() {
  // Product-theory UX: area is informational only. Never warn, reject, or
  // downgrade a housing candidate solely because its area exceeds a guideline.
  return '';
}







function callbackSearchLocation(message) {
  const source = `${message?.text || ''}\n${message?.caption || ''}`;
  const match = /Автопошук житла під Jobcenter\s*[—–-]\s*([^\n]{2,120})/u.exec(source);
  return match?.[1]?.replace(/\s+/g, ' ').trim() || null;
}

export async function enrichPrivateJobcenterCallbackRequest(request, env, transport) {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/stateless' || request.method !== 'POST') return request;
  const config = pilotConfig(env);
  if (!config || env.TELEGRAM_INGRESS_ENABLED !== 'true' || !statelessDirectReplyEnabled(env)) return request;
  if (!equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return request;

  const parsed = await readBoundedJSON(request.clone());
  if (parsed.error) return request;
  const query = parsed.value?.callback_query;
  const match = OWNED_JOBCENTER_CALLBACK.exec(String(query?.data || ''));
  if (!match) return request;
  const userId = Number(query?.from?.id);
  const ownerUserId = Number(match[2]);
  const chatId = Number(query?.message?.chat?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0 || ownerUserId !== userId || chatId !== userId || query?.message?.chat?.type !== 'private') return request;

  const fallbackLocation = callbackSearchLocation(query.message);
  const detail = await getLiveHousingAdDetail(match[1], klazApiKey(env), transport);
  const location = fallbackLocation || (detail.status === 'ok' ? detail.location : null);
  const areaSqm = detail.status === 'ok' ? detail.areaSqm : null;
  if (!location && !Number.isFinite(areaSqm)) return request;

  const copy = JSON.parse(JSON.stringify(parsed.value));
  const lines = [];
  if (location) lines.push(`💶 · ${location}`);
  if (Number.isFinite(areaSqm)) lines.push(`📐 ${shownNumber(areaSqm)} м²`);
  const existingCaption = String(copy.callback_query?.message?.caption || '').trim();
  copy.callback_query.message.caption = [...lines, existingCaption].filter(Boolean).join('\n');

  return new Request(request.url, {
    method:request.method,
    headers:request.headers,
    body:JSON.stringify(copy)
  });
}


function paginationMarkup(markup, scope, offset, hasMore, ownerUserId) {
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard.map(row => [...row]) : [];
  if (hasMore) rows.push([{ text:'➡️ Наступні оголошення', callback_data:`jcn:${scope}:${offset}:u${ownerUserId}` }]);
  return { inline_keyboard:rows };
}

export function housingPaginationFinalNotice(hasMore) {
  return hasMore ? '' : '\n\nℹ️ Оголошень більше немає.';
}

function stableHousingListings(listings) {
  const seenUrl = new Set(), seenImage = new Set(), seenFingerprint = new Set();
  return (Array.isArray(listings) ? listings : []).filter(item => {
    const url = String(item?.url || item?.id || '').trim().toLowerCase();
    const image = String(item?.imageUrl || '').trim().toLowerCase();
    const fingerprint = [
      String(item?.title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),
      String(item?.location || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),
      Number(item?.price) || '',
      Number(item?.rooms) || '',
      Number(item?.areaSqm) || ''
    ].join('|');
    if (!url || seenUrl.has(url) || (image && seenImage.has(image)) || (fingerprint !== '||||' && seenFingerprint.has(fingerprint))) return false;
    seenUrl.add(url);
    if (image) seenImage.add(image);
    if (fingerprint !== '||||') seenFingerprint.add(fingerprint);
    return true;
  }).sort((a, b) =>
    (Number(a?.price) || Number.MAX_SAFE_INTEGER) - (Number(b?.price) || Number.MAX_SAFE_INTEGER) ||
    String(a?.location || '').localeCompare(String(b?.location || ''), 'de') ||
    String(a?.url || '').localeCompare(String(b?.url || ''), 'de')
  );
}

function housingCallbackContext(query) {
  const source = `${query?.message?.text || ''}\n${query?.message?.caption || ''}`;
  const location = /(?:Автопошук житла під Jobcenter\s*[—–-]|стартова точка\s*:?\s*)([^\n]{2,120})/iu.exec(source)?.[1]?.trim();
  const persons = Number(/^(?:Осіб|Склад сім'ї):\s*(\d{1,2})/mu.exec(source)?.[1]);
  const rooms = /^Кімнати:\s*([^\n]{1,40})$/mu.exec(source)?.[1]?.trim();
  const jurisdiction = /^Територія Jobcenter\/Kreis:\s*([^\n.]{2,120})\.?$/mu.exec(source)?.[1]?.trim();
  if (!location || !Number.isSafeInteger(persons) || persons < 1 || persons > 20 || !rooms || !jurisdiction) return null;
  const resolved = resolveJobcenterRule(location, persons);
  const amount = Number(resolved?.rule?.grossColdLimit);
  if (resolved?.status !== 'verified' || resolved.jurisdiction !== jurisdiction || !Number.isFinite(amount) || amount <= 0) return null;
  return { location, persons, rooms, jurisdiction, resolved, criteria:{ location, rooms, amount, type:'Bruttokaltmiete', radiusKm:DEFAULT_JOBCENTER_SEARCH_RADIUS_KM, districtJurisdiction:jurisdiction, jobcenterJurisdiction:jurisdiction } };
}

// Stops the Telegram button spinner before the (slow) provider search starts.
async function answerHousingCallback(config, query, transport) {
  if (typeof query?.id !== 'string' || !query.id) return false;
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/answerCallbackQuery`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ callback_query_id:query.id }),
      signal:AbortSignal.timeout(8000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function districtSearchMarkup(markup, jurisdiction, ownerUserId) {
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard.map(row => [...row]) : [];
  const label = `🔎 Шукати по всьому ${String(jurisdiction || 'Kreis').slice(0, 48)}`;
  rows.push([{ text:label, callback_data:`jcd:u${ownerUserId}` }]);
  return { inline_keyboard:rows };
}

function districtSearchContext(query) {
  const context = housingCallbackContext(query);
  if (!context) return null;
  const criteria = { ...context.criteria };
  delete criteria.radiusKm;
  return { ...context, criteria };
}

export async function maybeHandleDistrictJobcenterSearch(request, env, transport) {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/stateless' || request.method !== 'POST') return null;
  const config = pilotConfig(env);
  if (!config || env.TELEGRAM_INGRESS_ENABLED !== 'true' || !statelessDirectReplyEnabled(env)) return null;
  if (!equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone());
  if (parsed.error) return null;
  const query = parsed.value?.callback_query;
  const match = DISTRICT_SEARCH_CALLBACK.exec(String(query?.data || ''));
  if (!match) return null;
  const userId = Number(query?.from?.id), ownerUserId = Number(match[1]), chatId = Number(query?.message?.chat?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0 || ownerUserId !== userId || chatId !== userId || query?.message?.chat?.type !== 'private') return null;
  const context = districtSearchContext(query);
  if (!context) return null;
  await answerHousingCallback(config, query, transport);
  let expanded;
  try {
    expanded = await searchExpandedHousing(context.criteria, transport);
  } catch (error) {
    console.error('jobcenter_district_housing_search_failed', { name:String(error?.name || 'Error'), message:safeLogText(error?.message || 'Housing district search failed') });
    expanded = { status:'unavailable', listings:[] };
  }
  const pool = stableHousingListings(filterHousingListingsToJurisdiction(expanded?.listings, context.jurisdiction, context.location));
  const listings = pool.slice(0, HOUSING_PAGE_SIZE);
  const result = { ...(expanded || {}), status:listings.length ? 'ok' : (expanded?.status || 'unavailable'), listings };
  const authority = context.resolved?.module?.authority || context.resolved?.rule?.authority || 'Jobcenter';
  const maxArea = Number(context.resolved?.rule?.maxAreaSqm);
  const intro = [
    `🔎 Пошук по всьому ${context.jurisdiction} — стартова точка ${context.location}`,
    `Осіб: ${context.persons}`,
    `Кімнати: ${context.rooms}`,
    `Територія Jobcenter/Kreis: ${context.jurisdiction}.`,
    'Пошук не виходить за межі цієї адміністративної території.'
  ].join('\n');
  const hasMore = pool.length > HOUSING_PAGE_SIZE;
  const finalNotice = housingPaginationFinalNotice(hasMore);
  const text = `${intro}\n\n${formatHousingListings(context.criteria, result)}${finalNotice}`.slice(0, 4096);
  const rawMarkup = result.status === 'ok' && listings.length ? housingListingsMarkup(result) : externalHousingSearchMarkup(context.criteria);
  const replyMarkup = paginationMarkup(scopedJobcenterSearchMarkup(rawMarkup, authority, context.criteria), 'd', HOUSING_PAGE_SIZE, hasMore, userId);
  const media = result.status === 'ok' && listings.length ? jobcenterPhotoCards(result, context, authority, maxArea) : [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const delivered = await sendHousingMediaReply({ config:{ ...config, chatId }, media, text, replyMarkup, transport, signal:controller.signal, ownerUserId:userId, separateItems:true, postText:hasMore ? null : 'ℹ️ Оголошень більше немає.' });
    return new Response(JSON.stringify({ ok:true, mode:'private-jobcenter-district-search', delivered:delivered.status === 'sent', mediaCount:delivered.mediaCount || 0 }), { status:200, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
  } finally { clearTimeout(timeout); }
}

export async function maybeHandleNextHousingPage(request, env, transport) {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/stateless' || request.method !== 'POST') return null;
  const config = pilotConfig(env);
  if (!config || env.TELEGRAM_INGRESS_ENABLED !== 'true' || !statelessDirectReplyEnabled(env)) return null;
  if (!equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone());
  if (parsed.error) return null;
  const query = parsed.value?.callback_query;
  const match = NEXT_HOUSING_CALLBACK.exec(String(query?.data || ''));
  if (!match) return null;
  const scope = match[1], offset = Number(match[2]), userId = Number(query?.from?.id), ownerUserId = Number(match[3]), chatId = Number(query?.message?.chat?.id);
  if (!Number.isSafeInteger(offset) || offset < HOUSING_PAGE_SIZE || offset > 995 || !Number.isSafeInteger(userId) || userId <= 0 || ownerUserId !== userId || chatId !== userId || query?.message?.chat?.type !== 'private') return null;
  const context = housingCallbackContext(query);
  if (!context) return null;
  await answerHousingCallback(config, query, transport);
  let searched;
  try {
    if (scope === 'l') {
      searched = await searchPrimaryHousing(context.criteria, klazApiKey(env), transport);
    } else {
      const districtCriteria = { ...context.criteria };
      delete districtCriteria.radiusKm;
      context.criteria = districtCriteria;
      searched = await searchExpandedHousing(districtCriteria, transport);
    }
  } catch (error) {
    console.error('jobcenter_housing_next_page_failed', { scope, offset, name:String(error?.name || 'Error'), message:safeLogText(error?.message || 'Housing pagination failed') });
    searched = { status:'unavailable', listings:[] };
  }
  const pool = stableHousingListings(filterHousingListingsToJurisdiction(searched?.listings, context.jurisdiction, context.location));
  const listings = pool.slice(offset, offset + HOUSING_PAGE_SIZE);
  const result = {
    ...(searched || {}),
    status:listings.length ? 'ok' : 'empty',
    listings
  };
  const authority = context.resolved?.module?.authority || context.resolved?.rule?.authority || 'Jobcenter';
  const maxArea = Number(context.resolved?.rule?.maxAreaSqm);
  const intro = [
    `🔎 Наступні оголошення — ${scope === 'l' ? '15 км' : context.jurisdiction}`,
    `Стартова точка: ${context.location}`,
    `Склад сім'ї: ${context.persons}`,
    `Кімнати: ${context.rooms}`,
    `Територія Jobcenter/Kreis: ${context.jurisdiction}.`
  ].join('\n');
  const hasMore = pool.length > offset + HOUSING_PAGE_SIZE;
  const finalNotice = housingPaginationFinalNotice(hasMore);
  const text = `${intro}\n\n${formatHousingListings(context.criteria, result)}${finalNotice}`.slice(0, 4096);
  const rawMarkup = listings.length ? housingListingsMarkup(result) : null;
  let replyMarkup = paginationMarkup(scopedJobcenterSearchMarkup(rawMarkup, authority, context.criteria), scope, offset + HOUSING_PAGE_SIZE, hasMore, userId);
  if (scope === 'l') replyMarkup = districtSearchMarkup(replyMarkup, context.jurisdiction, userId);
  const media = listings.length ? jobcenterPhotoCards(result, context, authority, maxArea) : [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const delivered = await sendHousingMediaReply({ config:{ ...config, chatId }, media, text, replyMarkup, transport, signal:controller.signal, ownerUserId:userId, separateItems:true, indexOffset:offset, postText:hasMore ? null : 'ℹ️ Оголошень більше немає.' });
    return new Response(JSON.stringify({ ok:true, mode:'private-jobcenter-housing-next-page', scope, offset, delivered:delivered.status === 'sent', mediaCount:delivered.mediaCount || 0 }), { status:200, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
  } finally { clearTimeout(timeout); }
}

export async function normalizeStandaloneHouseholdRequest(request) {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/stateless' || request.method !== 'POST') return request;

  const parsed = await readBoundedJSON(request.clone());
  if (parsed.error) return request;
  const update = parsed.value;
  const message = update?.message;
  const text = String(message?.text || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const previous = String(message?.reply_to_message?.text || '');

  if (message?.chat?.type !== 'private' || !text || text.startsWith('/')) return request;

  const location = knownHousingLocation(text);
  const persons = parseHouseholdSize(text);
  const housing = /житл|квартир|wohnung|wohnraum|оренд|miete/iu.test(text);
  const naturalHouseholdHousing = HOUSEHOLD_COMPOSITION_CUE.test(text) && !EXPLICIT_NON_HOUSING_JOBCENTER.test(text);

  // A guided Jobcenter reply can already identify a housing case without the
  // literal word "житло", e.g. "Плен для сім'ї двоє дітей та двоє дорослих".
  // In that narrow case, location + concrete household composition is enough to
  // continue the housing branch immediately. Explicit Bürgergeld/Bescheid/etc.
  // wording always wins and is never rewritten into a housing request.
  if (previous.startsWith(JOBCENTER_TOPIC_PREFIX) && location && persons && (housing || naturalHouseholdHousing)) {
    const copy = JSON.parse(JSON.stringify(update));
    // Keep the canonical location first. The general housing parser reliably
    // recognizes the "CITY житло ..." form for every registered municipality,
    // not only the small hard-coded alias subset used for free-text shortcuts.
    copy.message.text = `${location} житло для ${persons} осіб під Jobcenter`;
    delete copy.message.reply_to_message;
    return new Request(request.url, {
      method:request.method,
      headers:request.headers,
      body:JSON.stringify(copy)
    });
  }

  // Do not interfere with other guided replies or messages that already name a topic.
  if (message.reply_to_message || EXPLICIT_TOPIC.test(text)) return request;
  if (!location || !persons) return request;

  // A standalone place + household composition is a strong housing-search signal.
  // Rewrite to the canonical CITY-first form instead of prefixing "Житло" to the
  // original sentence. This keeps both the canonical municipality and household
  // size unambiguous for every downstream parser.
  const copy = JSON.parse(JSON.stringify(update));
  // TG-RUNTIME-075: keep a budget from the sentence ("до 800 €") in the rewrite.
  const budget = budgetFromText(text);
  copy.message.text = [`${location} житло для ${persons} осіб`, budgetPhrase(budget)].filter(Boolean).join(' ');
  return new Request(request.url, {
    method:request.method,
    headers:request.headers,
    body:JSON.stringify(copy)
  });
}

function jobcenterRoomSearchContext(message) {
  const previous = String(message?.replyToText || '');
  const match = /^Тема: житло — ([^.\n]{2,120})\. Локацію вже визначено\./u.exec(previous);
  if (!match || !previous.includes('Умова: житло під Jobcenter.') || !previous.includes('Для пошуку підтвердьте кількість кімнат')) return null;
  const persons = Number(/^Осіб:\s*(\d{1,2})$/mu.exec(previous)?.[1]);
  const rooms = parseRoomSpec(message?.text);
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20 || !rooms) return null;
  const location = match[1].trim();
  const resolved = resolveJobcenterRule(location, persons);
  const limit = Number(resolved?.rule?.grossColdLimit);
  if (resolved?.status !== 'verified' || !Number.isFinite(limit) || limit <= 0) return null;
  return {
    location,
    persons,
    rooms,
    resolved,
    criteria:{
      location,
      rooms:rooms.label,
      amount:limit,
      type:'Bruttokaltmiete',
      radiusKm:DEFAULT_JOBCENTER_SEARCH_RADIUS_KM,
      districtJurisdiction:resolved.jurisdiction,
      jobcenterJurisdiction:resolved.jurisdiction
    }
  };
}

export async function maybeHandleVerifiedJobcenterSearch(request, env, now, transport) {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/stateless' || request.method !== 'POST') return null;
  const config = pilotConfig(env);
  if (!config || env.TELEGRAM_INGRESS_ENABLED !== 'true' || !statelessDirectReplyEnabled(env)) return null;
  if (!equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;

  const parsed = await readBoundedJSON(request.clone());
  if (parsed.error) return null;
  const message = normalizePilotUpdate(parsed.value, now);
  if (!message || message.chatType !== 'private') return null;

  const context = jobcenterRoomSearchContext(message);
  if (!context) return null;

  const liveResult = await searchPrimaryHousing(context.criteria, klazApiKey(env), transport)
    .catch(error => {
      console.error('jobcenter_local_housing_search_failed', {
        name:String(error?.name || 'Error'),
        message:safeLogText(error?.message || 'Housing search failed')
      });
      return { status:'unavailable', listings:[] };
    });
  const jurisdiction = context.resolved?.jurisdiction;
  const scopedListings = jurisdiction
    ? stableHousingListings(filterHousingListingsToJurisdiction(liveResult?.listings, jurisdiction, context.location))
    : [];
  const pageListings = scopedListings.slice(0, HOUSING_PAGE_SIZE);
  const result = {
    ...(liveResult || {}),
    status:pageListings.length ? 'ok' : (liveResult?.status || 'unavailable'),
    listings:pageListings
  };
  const authority = context.resolved?.module?.authority || context.resolved?.rule?.authority || 'Jobcenter';
  const maxArea = Number(context.resolved?.rule?.maxAreaSqm);
  const intro = [
    `🔎 Автопошук житла під Jobcenter — ${context.location}`,
    `Осіб: ${context.persons}`,
    `Кімнати: ${context.rooms.label}`,
    `Орієнтир ${authority}: до ${euro(context.criteria.amount)} € Bruttokaltmiete${Number.isFinite(maxArea) && maxArea > 0 ? `; площа-орієнтир до ${maxArea} м² (довідково)` : ''}.`,
    'Heizkosten перевіряються окремо.',
    `Радіус пошуку: ${context.criteria.radiusKm} км.`,
    `Територія Jobcenter/Kreis: ${context.resolved.jurisdiction}.`,
    'На цьому етапі пошук обмежено 15 км і не виходить за межі цього Kreis.',
    '',
    '⚠️ Це автоматичний пошук кандидатів, а не Zusicherung. Ціна в оголошенні може бути Kaltmiete, Warmmiete або неповною. Для кожної квартири потрібно окремо перевірити Kaltmiete + Betriebskosten без Heizkosten.'
  ].join('\n');
  const listingText = formatHousingListings(context.criteria, result);
  const areaWarnings = jobcenterAreaWarnings(result?.listings, maxArea);
  const hasMore = scopedListings.length > HOUSING_PAGE_SIZE;
  const finalNotice = housingPaginationFinalNotice(hasMore);
  const text = `${intro}\n\n${listingText}${areaWarnings ? `\n\n${areaWarnings}` : ''}${finalNotice}`.slice(0, 4096);
  const rawReplyMarkup = result.status === 'ok' && Array.isArray(result.listings) && result.listings.length
    ? housingListingsMarkup(result)
    : externalHousingSearchMarkup(context.criteria);
  const localMarkup = paginationMarkup(scopedJobcenterSearchMarkup(rawReplyMarkup, authority, context.criteria), 'l', HOUSING_PAGE_SIZE, hasMore, message.userId);
  const replyMarkup = districtSearchMarkup(localMarkup, context.resolved.jurisdiction, message.userId);
  const media = result.status === 'ok' && Array.isArray(result.listings) && result.listings.length
    ? jobcenterPhotoCards(result, context, authority, maxArea)
    : [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const delivered = await sendHousingMediaReply({
      config:{ ...config, chatId:message.chatId },
      media,
      text,
      replyMarkup,
      transport,
      signal:controller.signal,
      replyToMessageId:message.messageId,
      ownerUserId:message.userId,
      separateItems:true,
      postText:hasMore ? null : 'ℹ️ Оголошень більше немає.'
    });
    return new Response(JSON.stringify({
      ok:true,
      mode:'private-jobcenter-auto-search',
      delivered:delivered.status === 'sent',
      mediaCount:delivered.mediaCount || 0
    }), {
      status:200,
      headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
    });
  } finally {
    clearTimeout(timeout);
  }
}

// TG-RUNTIME-079 (phone smoke 27.10.2026, #8): after the radius the bot only
// said "Критерії пошуку зібрано… Наступний крок — перевірка актуальних
// оголошень" and waited for the «🔎 …» keyboard button, which testers did not
// see. The radius answer now is that button: the search runs at once.
const RADIUS_PROMPT = /^Параметри житла: ([^,\n]{1,80}),\s*(\d{1,2}(?:-\d{1,2})?)\s+кімнат(?:а|и)?, до ([\d.,]+) € (Warmmiete|Kaltmiete)\. Оберіть радіус пошуку:/u;

export async function radiusAnswerSearchRequest(request) {
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const update = parsed.value;
  const message = update?.message;
  if (!message || message.chat?.type !== 'private' || update?.callback_query) return null;
  const previous = message.reply_to_message;
  // The same trust rule as trustedBotReply (pilot-security.mjs).
  const username = previous?.from?.username;
  if (previous?.from?.is_bot !== true || previous?.chat?.id !== message.chat?.id || (username !== undefined && username !== 'ZaskaletaInfoBot')) return null;
  const prompt = RADIUS_PROMPT.exec(String(previous.text || ''));
  const radius = /^(5|10|15|25|50)\s*(?:км|km)?$/iu.exec(String(message.text || '').trim());
  if (!prompt || !radius) return null;
  const action = housingSearchAction({ location:prompt[1].trim(), rooms:prompt[2], amount:Number(prompt[3].replace(',', '.')), type:prompt[4], radiusKm:Number(radius[1]) });
  if (!action) return null;
  const copy = JSON.parse(JSON.stringify(update));
  copy.message.text = action;
  delete copy.message.reply_to_message;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method:'POST', headers, body:JSON.stringify(copy) });
}
