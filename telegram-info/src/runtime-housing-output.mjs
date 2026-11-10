// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { searchPublicHousingSources } from './housing-public-sources.mjs';
import { searchKleinanzeigenPublicRecovery } from './housing-kleinanzeigen-public-recovery.mjs';
import { housingActiveTransport, parseJobcenterSearchCriteria } from './housing-active-v22.mjs';
import { sendPublicHousingCards } from './public-housing-cards.mjs';
import { filterHousingListingsToJurisdiction } from './housing-jurisdiction-scope.mjs';
import { formatEuro } from './listing-format.mjs';
import { roomsWord } from './rooms.mjs';
const HOUSING_PROVIDER_CREDIT_TEXT = 'У провайдера недостатньо credits для live-пошуку. Поповніть або дочекайтеся доступного безкоштовного ліміту.';
const PUBLIC_RECOVERY_TARGET = 12;
// The caller's Telegram timeout starts before the recovery search below. On
// staging (13.10.2026) slow portals used it up, the final answer was aborted
// and the chat ended at "Пошук завершено". The recovery has its own bound and
// the final send gets its own timeout; the task watchdog still applies below.
const PUBLIC_RECOVERY_TIMEOUT_MS = 20000;
const FINAL_SEND_TIMEOUT_MS = 9000;

function settleWithinMs(promise, timeoutMs, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

const HOUSING_PROVIDER_FAILURE_PREFIXES = Object.freeze([
  HOUSING_PROVIDER_CREDIT_TEXT,
  'Живий пошук оголошень підготовлено, але провайдер ще не підключено.',
  'Не вдалося однозначно знайти локацію',
  'Провайдер не прийняв API-авторизацію.',
  'Провайдер тимчасово обмежив частоту live-запитів.',
  'Провайдер відхилив параметри пошуку.',
  'Kleinanzeigen тимчасово не відповідає провайдеру.',
  'Сервіс актуальних оголошень тимчасово недоступний.'
]);

const SAFE_PUBLIC_HOUSING_URL = /^https:\/\/(?:www\.)?(?:kleinanzeigen\.de|immobilienscout24\.de|immowelt\.de|ohne-makler\.net|kip\.net|wankendorfer\.de|wobau-neumuenster\.de|fab\.sh|wbg-kiel-ost\.de|luebecker-bauverein\.de|wobau-oh\.de|wo-di\.de|trave\.de|wogekiel\.de|neueluebecker\.de|adlershorst\.de|big-verwaltung\.de|zbvv\.de|hausundgrund\.de|wg-gesucht\.de|vonovia\.de|tenant\.immomio\.com)\//i;
const DIRECT_PUBLIC_HOUSING_URL = /^https:\/\/(?:www\.)?kleinanzeigen\.de\/s-anzeige\//iu;
const NON_HOUSING_PUBLIC_TITLE = /^(?:stellplatz|parkplatz|garage|carport|tiefgaragenstellplatz|garagenstellplatz)\b/iu;

function normalizedCandidateKey(item) {
  const directUrl = String(item?.url || '').trim();
  if (DIRECT_PUBLIC_HOUSING_URL.test(directUrl)) return `url:${directUrl}`;
  return [
    String(item?.sourceId || item?.source || '').trim().toLowerCase(),
    String(item?.location || '').replace(/\s+/gu, ' ').trim().toLowerCase(),
    String(item?.rooms ?? '').trim(),
    String(item?.price ?? '').trim(),
    String(item?.areaSqm ?? '').trim()
  ].join('|');
}

function plausiblePublicHousingListing(item) {
  const title = String(item?.title || '').replace(/\s+/gu, ' ').trim();
  if (NON_HOUSING_PUBLIC_TITLE.test(title)) return false;
  if (item?.price !== null && item?.price !== undefined && String(item.price).trim() !== '') {
    const price = Number(item.price);
    if (Number.isFinite(price) && price < 100) return false;
  }
  return true;
}

function isDirectPublicHousingListing(item) {
  return plausiblePublicHousingListing(item) && DIRECT_PUBLIC_HOUSING_URL.test(String(item?.url || ''));
}

function mergePublicHousingCandidates(primary = [], recovery = []) {
  const seen = new Set();
  const seenImages = new Set();
  const seenFingerprints = new Set();
  const merged = [];
  for (const item of [...recovery, ...primary]) {
    if (!plausiblePublicHousingListing(item)) continue;
    const key = normalizedCandidateKey(item);
    let image = String(item?.imageUrl || '').trim();
    if (image) image = image.replace(/[?#].*$/u, '');
    const fingerprint = [
      String(item?.title || '').replace(/\s+/gu, ' ').trim().toLowerCase(),
      String(item?.location || '').replace(/\s+/gu, ' ').trim().toLowerCase(),
      Number.isFinite(Number(item?.price)) ? Number(item.price) : '',
      Number.isFinite(Number(item?.rooms)) ? Number(item.rooms) : '',
      Number.isFinite(Number(item?.areaSqm)) ? Math.round(Number(item.areaSqm)) : ''
    ].join('|');
    if (!key || seen.has(key)) continue;
    if (image && seenImages.has(image)) continue;
    if (fingerprint.replace(/\|/gu, '') && seenFingerprints.has(fingerprint)) continue;
    seen.add(key);
    if (image) seenImages.add(image);
    if (fingerprint.replace(/\|/gu, '')) seenFingerprints.add(fingerprint);
    merged.push(item);
    if (merged.length >= 20) break;
  }
  return merged;
}

function presentationHousingResult(result) {
  const sourceListings = Array.isArray(result?.listings) ? result.listings : [];
  const listings = sourceListings.filter(plausiblePublicHousingListing);
  if (listings.length === sourceListings.length) return result;
  return {
    ...(result || {}),
    listings,
    ...(result?.status === 'ok' && !listings.length ? { status:'empty' } : {})
  };
}

function jurisdictionScopedHousingResult(criteria, result) {
  const jurisdiction = String(criteria?.districtJurisdiction || criteria?.jobcenterJurisdiction || '').trim();
  if (!jurisdiction) return result;
  const sourceListings = Array.isArray(result?.listings) ? result.listings : [];
  const listings = filterHousingListingsToJurisdiction(sourceListings, jurisdiction, criteria?.location);
  if (listings.length === sourceListings.length) return result;
  return {
    ...(result || {}),
    listings,
    ...(result?.status === 'ok' && !listings.length ? { status:'empty' } : {})
  };
}

function shouldRunPublicRecovery(result) {
  const listings = Array.isArray(result?.listings) ? result.listings : [];
  const direct = listings.filter(isDirectPublicHousingListing).length;
  return direct < PUBLIC_RECOVERY_TARGET;
}

// True when this transport will replace the text from a provider failure or
// the empty-filter line on with its own public-source result.
export function housingProviderFailureText(text) {
  return providerFailureIndex(text) >= 0;
}

function providerFailureIndex(text) {
  const source = String(text || '');
  const empty = /За фільтром [^\n]+ зараз не знайдено надійно відфільтрованих пропозицій\. Розширте бюджет\/радіус або перевірте зовнішній пошук\./u.exec(source);
  let found = empty?.index ?? -1;
  for (const prefix of HOUSING_PROVIDER_FAILURE_PREFIXES) {
    const index = source.indexOf(prefix);
    if (index >= 0 && (found < 0 || index < found)) found = index;
  }
  return found;
}

function shownNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  return number.toLocaleString('de-DE', { maximumFractionDigits:2 });
}

// A euro amount always shows its cents (943,80 €), as on listing cards.
function euro(value) {
  return Number.isFinite(Number(value)) ? formatEuro(value) : shownNumber(value);
}

function publicFallbackText(criteria, result) {
  const listings = Array.isArray(result?.listings) ? result.listings.slice(0, 5) : [];
  const districtJurisdiction = String(criteria?.districtJurisdiction || '').trim();
  const scopeLabel = districtJurisdiction ? `Jobcenter/Kreis ${districtJurisdiction}` : criteria.location;
  if (!listings.length) {
    return [
      '🔎 Автоматичний пошук виконано через доступні відкриті житлові джерела.',
      `У межах ${scopeLabel}, ${criteria.rooms} ${roomsWord(criteria.rooms)}, до ${euro(criteria.amount)} € зараз не знайдено надійно відфільтрованих пропозицій.`,
      districtJurisdiction
        ? 'Пошук не розширюється за межі цього Jobcenter/Kreis.'
        : 'Кнопки Kleinanzeigen, ImmoScout24 та Immowelt нижче залишаються активними — можна відкрити пошук на порталах одразу.'
    ].join('\n');
  }

  const lines = [
    '🔎 Пошук автоматично продовжено через доступні відкриті житлові джерела.',
    `Знайдено кандидати в межах ${scopeLabel}, ${criteria.rooms} ${roomsWord(criteria.rooms)}, до ${euro(criteria.amount)} €:`
  ];
  listings.forEach((item, index) => {
    const priceType = item?.priceType ? ` · ${String(item.priceType).slice(0, 40)}` : '';
    const area = Number.isFinite(Number(item?.areaSqm)) ? ` · ${shownNumber(item.areaSqm)} м²` : '';
    lines.push(`\n${index + 1}. ${String(item?.title || 'Оголошення').replace(/\s+/g, ' ').trim().slice(0, 140)}\n${euro(item?.price)} €${priceType} · ${String(item?.location || criteria.location).replace(/\s+/g, ' ').trim().slice(0, 100)}${area}\nДжерело: ${String(item?.source || 'відкрите джерело').slice(0, 60)}`);
  });
  lines.push('\nЦе кандидати для перевірки, а не Zusicherung. Перед зверненням перевірте актуальність оголошення та склад орендної плати.');
  return lines.join('\n');
}

function prependPublicListingButtons(markup, result) {
  const existing = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : [];
  const rows = (Array.isArray(result?.listings) ? result.listings : [])
    .slice(0, 5)
    .filter(item => SAFE_PUBLIC_HOUSING_URL.test(String(item?.url || '')))
    .map((item, index) => [{
      text:`${index + 1}. ${isDirectPublicHousingListing(item) ? 'Відкрити оголошення' : String(item?.source || 'Відкрити джерело').slice(0, 40)}`,
      url:String(item.url)
    }]);
  if (!rows.length) return markup;
  return { ...(markup || {}), inline_keyboard:[...rows, ...existing].slice(0, 16) };
}

async function activatePublicHousingFallback(payload, transport) {
  if (typeof payload?.text !== 'string') return null;
  const failureAt = providerFailureIndex(payload.text);
  if (failureAt < 0) return null;
  const criteria = parseJobcenterSearchCriteria(payload.text);
  if (!criteria) return null;

  let result = { status:'unavailable', listings:[], sources:[] };
  try {
    result = await searchPublicHousingSources(criteria, transport);
  } catch {}
  result = jurisdictionScopedHousingResult(criteria, presentationHousingResult(result));

  if (shouldRunPublicRecovery(result)) {
    try {
      const recovery = await searchKleinanzeigenPublicRecovery(criteria, transport);
      const recoveryListings = (Array.isArray(recovery?.listings) ? recovery.listings : []).filter(plausiblePublicHousingListing);
      const source = {
        source:'kleinanzeigen-public',
        status:recovery?.status || 'unavailable',
        count:recoveryListings.length,
        pages:Array.isArray(recovery?.pages) ? recovery.pages : []
      };
      const merged = mergePublicHousingCandidates(result.listings, recoveryListings);
      result = jurisdictionScopedHousingResult(criteria, {
        ...result,
        status:merged.length ? 'ok' : result.status,
        listings:merged,
        sources:[...(Array.isArray(result?.sources) ? result.sources : []), source]
      });
    } catch {}
  }

  result = jurisdictionScopedHousingResult(criteria, presentationHousingResult(result));
  const replacement = publicFallbackText(criteria, result);
  payload.text = `${payload.text.slice(0, failureAt)}${replacement}`.slice(0, 4096);
  payload.reply_markup = prependPublicListingButtons(payload.reply_markup, result);
  return { criteria, result };
}
function plainCaption(value) {
  return String(value || '')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&(amp|lt|gt|quot);/gu, (_m, name) => ({ amp:'&', lt:'<', gt:'>', quot:'"' })[name])
    .replace(/\s+/gu, ' ')
    .trim();
}

function bogusHousingCaption(caption) {
  const text = plainCaption(caption);
  if (!text) return false;
  const priceMatch = /(?:^|\s)(\d{1,5}(?:[.,]\d{1,2})?)\s*€/u.exec(text);
  const price = priceMatch ? Number(priceMatch[1].replace(',', '.')) : NaN;
  if (Number.isFinite(price) && price < 100) return true;
  const title = text.split(/💶|\s\d{1,5}(?:[.,]\d{1,2})?\s*€/u, 1)[0];
  if (NON_HOUSING_PUBLIC_TITLE.test(title.replace(/^\s*(?:🏠\s*)?\d+\/\d+\.?\s*/u, ''))) return true;
  if (/\bnachmieter(?:in)?\b.{0,90}\bgesucht\b/iu.test(title)) return false;
  if (/\b(?:wohnung|mietwohnung|haus|zuhause|zimmer)\b.{0,90}\bgesucht\b/iu.test(title)) return true;
  if (/^\s*(?:ich|wir)\s+suche(?:n)?\b/iu.test(title)) return true;
  return false;
}

function syntheticTelegramSuccess(chatId, messageId) {
  return new Response(JSON.stringify({
    ok:true,
    result:{ message_id:messageId, chat:{ id:chatId } }
  }), { status:200, headers:{ 'content-type':'application/json' } });
}

function housingResultQualityTransport(transport = fetch) {
  let suppressed = 0;
  return async (url, options = {}) => {
    const target = String(url || '');
    if (/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendPhoto$/u.test(target) && options?.body instanceof FormData) {
      const caption = options.body.get('caption');
      if (bogusHousingCaption(caption)) {
        const chatId = Number(options.body.get('chat_id'));
        suppressed += 1;
        return syntheticTelegramSuccess(chatId, 900000000 + suppressed);
      }
    }
    if (/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/u.test(target) && typeof options?.body === 'string') {
      try {
        const payload = JSON.parse(options.body);
        const text = String(payload?.text || '');
        const cardLike = /🏠\s*\d+\/\d+/u.test(text) && /кандидат|Bruttokaltmiete|Zusicherung/iu.test(text);
        if (cardLike && bogusHousingCaption(text)) {
          const chatId = Number(payload?.chat_id);
          suppressed += 1;
          return syntheticTelegramSuccess(chatId, 900000000 + suppressed);
        }
      } catch {}
    }
    return transport(url, options);
  };
}
export function housingOutputTransport(transport=fetch) {
  const expanded=housingActiveTransport(transport,{keyboardPolicy:false});
  const output=async(url,options={})=>{
    if (!/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/u.test(String(url)) || typeof options.body!=='string') return expanded(url,options);
    let payload;try{payload=JSON.parse(options.body);}catch{return expanded(url,options);}
    const recovering=typeof payload?.text==='string' && providerFailureIndex(payload.text)>=0;
    const activation=recovering ? await settleWithinMs(activatePublicHousingFallback(payload,transport),PUBLIC_RECOVERY_TIMEOUT_MS,null) : null;
    if(recovering) options={...options,signal:AbortSignal.timeout(FINAL_SEND_TIMEOUT_MS)};
    const directListings = (Array.isArray(activation?.result?.listings) ? activation.result.listings : []).filter(isDirectPublicHousingListing);
    if (directListings.length) {
      const cardResponse=await sendPublicHousingCards({
        url,
        payload,
        criteria:activation.criteria,
        result:{ ...activation.result, listings:directListings },
        transport:housingResultQualityTransport(transport),
        signal:options.signal
      });
      if (cardResponse) return cardResponse;
    }
    if(typeof payload.text==='string' && payload.text.includes(HOUSING_PROVIDER_CREDIT_TEXT)) payload.text=payload.text.replace(HOUSING_PROVIDER_CREDIT_TEXT,'Автоматичний пошук оголошень зараз тимчасово недоступний. Скористайтеся кнопками пошуку нижче або спробуйте пізніше.');
    return expanded(url,{...options,body:JSON.stringify(payload)});
  };
  return housingResultQualityTransport(output);
}