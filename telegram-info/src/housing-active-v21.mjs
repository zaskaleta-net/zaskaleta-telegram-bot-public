import { sourcesLog } from './log-safe.mjs';
import { readBoundedJSON } from './pilot-security.mjs';
import { searchExpandedHousing, ukrainianHousingSummary } from './housing-expanded-v22.mjs';
import { searchKleinanzeigenPublicRecovery } from './housing-kleinanzeigen-public-expanded.mjs';
import { parseRoomSpec, roomValueInSpec, roomsWord } from './rooms.mjs';
import { filterHousingListingsToJurisdiction } from './housing-jurisdiction-scope.mjs';
import { formatEuro } from './listing-format.mjs';
import { HOUSING_FALLBACK_MARKERS } from './housing-fallback-markers.mjs';

const STATELESS_PATH = '/telegram/stateless';
const TELEGRAM_API_RE = /^https:\/\/api\.telegram\.org\/bot[^/]+\//u;

function clean(value, max = 300) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

export function normalizeBuesumHousingText(value) {
  const source = clean(value, 1000);
  if (!source) return source;
  const alias = /(?:^|[^\p{L}])(?:büsum|buesum|бюзум|бюсум)(?=$|[^\p{L}])/iu;
  if (!alias.test(source)) return source;
  if (!/(?:житл|квартир|wohnung|wohnraum|miete|оренд)/iu.test(source)) return source;
  if (/^Büsum\s+житло\b/iu.test(source)) return source;
  const stripped = source.replace(alias, ' ').replace(/\s+/gu, ' ').trim().replace(/^житл[аоу]?\s*/iu, '');
  return `Büsum житло ${stripped}`.replace(/\s+/gu, ' ').trim();
}

export async function normalizeBuesumRequest(request) {
  let url;
  try { url = new URL(request.url); } catch { return request; }
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST') return request;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return request;
  const update = parsed.value;
  const message = update?.message;
  if (message?.chat?.type !== 'private' || typeof message?.text !== 'string') return request;

  const normalized = normalizeBuesumHousingText(message.text);
  if (!normalized || normalized === message.text) return request;

  const copy = JSON.parse(JSON.stringify(update));
  copy.message.text = normalized;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method:'POST', headers, body:JSON.stringify(copy) });
}

export function parseJobcenterSearchCriteria(text) {
  const source = String(text || '');
  const location = /^🔎\s*Автопошук житла під Jobcenter\s*[—–-]\s*([^\n]{2,120})\s*$/mu.exec(source)?.[1]?.trim();
  const roomRaw = /^Кімнати:\s*(\d{1,2}(?:[.,]\d+)?(?:\s*[-–]\s*\d{1,2}(?:[.,]\d+)?)?)\s*$/mu.exec(source)?.[1];
  const amountRaw = /Орієнтир[^\n:]{0,180}:\s*до\s*(\d{2,5}(?:[.,]\d{1,2})?)\s*€\s*Bruttokaltmiete/iu.exec(source)?.[1];
  const radiusRaw = /^Радіус пошуку:\s*(5|10|15|25|50)\s*км\.?\s*$/mu.exec(source)?.[1];
  const districtJurisdiction = /^Територія Jobcenter\/Kreis:\s*([^\n.]{2,120})\.?\s*$/mu.exec(source)?.[1]?.trim() || null;
  const jobcenterJurisdiction = /^Jobcenter\/Kreis:\s*([^\n.]{2,120})\.?\s*$/mu.exec(source)?.[1]?.trim() || null;
  if (!location || !roomRaw || !amountRaw || (!radiusRaw && !districtJurisdiction)) return null;
  if (!/^[\p{L}\p{M}.'’ -]{2,120}$/u.test(location)) return null;
  if (districtJurisdiction && !/^[\p{L}\p{M}.'’ -]{2,120}$/u.test(districtJurisdiction)) return null;
  if (jobcenterJurisdiction && !/^[\p{L}\p{M}.'’ -]{2,120}$/u.test(jobcenterJurisdiction)) return null;
  const rooms = roomRaw.replace(/\s*[–-]\s*/u, '-').replace(',', '.');
  const amount = Number(amountRaw.replace(',', '.'));
  const radiusKm = radiusRaw ? Number(radiusRaw) : 50;
  if (!Number.isFinite(amount) || amount < 100 || amount > 50000) return null;
  return {
    location,
    rooms,
    amount,
    type:'Bruttokaltmiete',
    radiusKm,
    ...(jobcenterJurisdiction ? { jobcenterJurisdiction } : {}),
    ...(districtJurisdiction ? { districtJurisdiction } : {})
  };
}

function markerIndex(text) {
  const source = String(text || '');
  let best = -1;
  for (const marker of HOUSING_FALLBACK_MARKERS) {
    const index = source.indexOf(marker);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

function shown(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return clean(value, 40);
  return number.toLocaleString('de-DE', { maximumFractionDigits:2 });
}

// A euro amount always shows its cents (943,80 €), as on listing cards.
function euro(value) {
  return Number.isFinite(Number(value)) ? formatEuro(value) : shown(value);
}

function explicitTitleRoomValue(title) {
  const match = /(\d{1,2}(?:[.,]\d+)?)\s*[-–]?\s*(?:Zimmer|Zi\.?)/iu.exec(String(title || ''));
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

export function qualityGateHousingListings(criteria, result) {
  const spec = parseRoomSpec(criteria?.rooms);
  const listings = Array.isArray(result?.listings) ? result.listings : [];
  if (!spec || !listings.length) return result;
  const filtered = listings.filter(item => {
    const structured = Number(item?.rooms);
    if (Number.isFinite(structured) && !roomValueInSpec(structured, spec)) return false;
    const titled = explicitTitleRoomValue(item?.title);
    if (Number.isFinite(titled) && !roomValueInSpec(titled, spec)) return false;
    return true;
  });
  return filtered.length === listings.length ? result : { ...result, listings:filtered };
}

function expandedHousingText(criteria, result) {
  const listings = Array.isArray(result?.listings) ? result.listings.slice(0, 8) : [];
  const districtJurisdiction = String(criteria?.districtJurisdiction || '').trim();
  const scopeLabel = districtJurisdiction ? `Jobcenter/Kreis ${districtJurisdiction}` : criteria.location;
  if (!listings.length) {
    const coverage = result?.status === 'ok'
      ? '🔎 У прочитаних джерелах не знайдено оголошень за цими параметрами.'
      : result?.status === 'partial'
        ? '🔎 Пошук виконано частково: деякі джерела не вдалося прочитати. У доступних результатах відповідних оголошень не знайдено.'
        : '🔎 Не вдалося отримати оголошення з підключених джерел. Це не означає, що пропозицій немає.';
    return [
      coverage,
      `Параметри: ${scopeLabel}, ${criteria.rooms} ${roomsWord(criteria.rooms)}, до ${euro(criteria.amount)} €.`,
      districtJurisdiction
        ? 'Пошук не розширюється за межі цього Jobcenter/Kreis.'
        : 'Спробуйте пізніше або відкрийте пошук на порталах за кнопками нижче. Це посилання на пошук, а не окремі оголошення.'
    ].join('\n');
  }

  const lines = [
    '🔎 Активний пошук оголошень виконано.',
    `Знайдено прямі оголошення в межах ${scopeLabel}, ${criteria.rooms} ${roomsWord(criteria.rooms)}, до ${euro(criteria.amount)} €:`
  ];
  listings.forEach((item, index) => {
    lines.push(
      '',
      `${index + 1}. ${clean(item.title || 'Оголошення', 160)}`,
      `🇺🇦 Коротко: ${clean(item.summaryUk || ukrainianHousingSummary(item), 420)}`,
      `💶 ${euro(item.price)} € · ${clean(item.priceType || 'ціна в оголошенні', 70)}`,
      `📍 ${clean(item.location || criteria.location, 120)}`,
      `📰 ${clean(item.source || 'джерело', 90)}`
    );
  });
  lines.push('', '⚠️ Це кандидати для перевірки, а не Zusicherung. Перед зверненням перевірте склад орендної плати та актуальність оголошення.');
  if (result?.status === 'partial') lines.push('Частину джерел не вдалося прочитати; список може бути неповним.');
  return lines.join('\n').slice(0, 4096);
}

function mergeInlineMarkup(primary, secondary) {
  const first = Array.isArray(primary?.inline_keyboard) ? primary.inline_keyboard : [];
  const second = Array.isArray(secondary?.inline_keyboard) ? secondary.inline_keyboard : [];
  if (!first.length) return secondary || null;
  if (!second.length) return primary || null;
  const seen = new Set();
  const rows = [];
  for (const row of [...first, ...second]) {
    const cleanRow = (Array.isArray(row) ? row : []).filter(button => {
      const key = String(button?.callback_data || button?.url || button?.text || '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (cleanRow.length) rows.push(cleanRow);
  }
  return { inline_keyboard:rows };
}

function directListingMarkup(result, criteria = null) {
  const rows = (Array.isArray(result?.listings) ? result.listings : [])
    .slice(0, 8)
    .filter(item => /^https:\/\//u.test(String(item?.url || '')))
    .map((item, index) => [{
      text:`${index + 1}. ${clean(item.source || 'Оголошення', 24)} · ${euro(item.price)} €`,
      url:String(item.url)
    }]);
  if (rows.length) return { inline_keyboard:rows };
  if (criteria?.districtJurisdiction) return null;

  const seenSearchLabels = new Set();
  const links = (Array.isArray(result?.searchLinks) ? result.searchLinks : [])
    .filter(item => {
      const url = String(item?.url || '');
      if (!/^https:\/\//u.test(url)) return false;
      const label = clean(item?.label || item?.source || 'Пошук', 80).toLowerCase();
      const key = label || url;
      if (seenSearchLabels.has(key)) return false;
      seenSearchLabels.add(key);
      return true;
    })
    .slice(0, 4)
    .map(item => [{ text:`↗ ${clean(item.label || item.source || 'Пошук', 48)}`, url:String(item.url) }]);
  return links.length ? { inline_keyboard:links } : null;
}

function addUkrainianSummaryToText(text) {
  const source = String(text || '');
  if (!/Знайдено актуальні пропозиції|Знайдено пропозиції у відкритих житлових джерелах/u.test(source)) return source;
  if (/🇺🇦 Коротко:/u.test(source)) return source;
  return source.replace(
    /(\n\d+\.\s+[^\n]{1,180}\n)([^\n]*€[^\n]*)/gu,
    (all, titleLine, priceLine) => `${titleLine}${priceLine}\n🇺🇦 Коротко: актуальний кандидат на оренду. Перевірте площу, склад орендної плати, Heizkosten та умови оголошення.`
  );
}

export function statewideHousingCopy(text) {
  const source = String(text || '');
  if (!source) return source;
  return source
    .replace(
      /Вкажіть місто або район, наприклад:\s*Hamburg або Trittau\./gu,
      'Вкажіть місто або район у Schleswig-Holstein, наприклад: Lübeck, Kiel або Trittau.'
    )
    .replace(/наприклад:\s*Hamburg,/gu, 'наприклад: Lübeck,')
    .replace(/наприклад:\s*Hamburg\./gu, 'наприклад: Lübeck.');
}

function fixCaptionSummary(caption) {
  const source = String(caption || '');
  if (!source.includes('🔗 Відкрити оголошення') || source.includes('🇺🇦 <b>Коротко:</b>')) return source;
  const linkMatch = /\n(<a href="[^"]+">🔗 Відкрити оголошення<\/a>)/u.exec(source);
  if (!linkMatch) return source;
  const price = /💶\s*<b>([^<]+)<\/b>/u.exec(source)?.[1];
  const location = /💶\s*<b>[^<]+<\/b>\s*·\s*([^\n<]+)/u.exec(source)?.[1];
  const detail = /(?:^|\n)(🛏[^\n]+)/u.exec(source)?.[1];
  const bits = [];
  if (detail) bits.push(clean(detail.replace(/<[^>]+>/gu, ''), 110));
  if (location) bits.push(`📍 ${clean(location, 90)}`);
  if (price) bits.push(`💶 ${clean(price, 45)}`);
  const summary = `🇺🇦 <b>Коротко:</b> ${bits.join(' · ') || 'перевірте параметри житла в оголошенні.'}`;
  return source.replace(linkMatch[0], `\n${summary}\n${linkMatch[1]}`).slice(0, 1024);
}


function mergeDirectHousingListings(...groups) {
  const seenUrls = new Set();
  const seenImages = new Set();
  const seenFingerprints = new Set();
  const merged = [];
  for (const item of groups.flat()) {
    const url = String(item?.url || '');
    if (!url) continue;
    let image = String(item?.imageUrl || '').trim();
    if (image) image = image.replace(/[?#].*$/u, '');
    const fingerprint = [
      clean(item?.title, 180).toLowerCase(),
      clean(item?.location, 120).toLowerCase(),
      Number.isFinite(Number(item?.price)) ? Number(item.price) : '',
      Number.isFinite(Number(item?.rooms)) ? Number(item.rooms) : '',
      Number.isFinite(Number(item?.areaSqm)) ? Math.round(Number(item.areaSqm)) : ''
    ].join('|');
    if (seenUrls.has(url)) continue;
    if (image && seenImages.has(image)) continue;
    if (fingerprint.replace(/\|/gu, '') && seenFingerprints.has(fingerprint)) continue;
    seenUrls.add(url);
    if (image) seenImages.add(image);
    if (fingerprint.replace(/\|/gu, '')) seenFingerprints.add(fingerprint);
    merged.push(item);
    if (merged.length >= 8) break;
  }
  return merged;
}

function jurisdictionScopedResult(criteria, result) {
  const jurisdiction = String(criteria?.districtJurisdiction || criteria?.jobcenterJurisdiction || '').trim();
  if (!jurisdiction) return result;
  const source = Array.isArray(result?.listings) ? result.listings : [];
  const listings = filterHousingListingsToJurisdiction(source, jurisdiction, criteria?.location);
  return listings.length === source.length ? result : { ...(result || {}), listings };
}

async function recoverPublicKleinanzeigenIfNeeded(criteria, result, transport) {
  const existing = Array.isArray(result?.listings) ? result.listings : [];
  if (existing.length >= 5) return result;

  let recovery;
  try {
    recovery = await searchKleinanzeigenPublicRecovery(criteria, transport);
  } catch {
    return result;
  }

  const recovered = Array.isArray(recovery?.listings)
    ? recovery.listings
    : [];

  const listings = mergeDirectHousingListings(existing, recovered);

  const sources = [
    ...(Array.isArray(result?.sources) ? result.sources : []),
    {
      source:'Kleinanzeigen public recovery',
      status:recovery?.status || 'unavailable',
      count:recovered.length,
      pages:Array.isArray(recovery?.pages) ? recovery.pages : []
    }
  ];

  const searchLinks = [
    ...(Array.isArray(result?.searchLinks) ? result.searchLinks : []),
    ...(Array.isArray(recovery?.searchUrls)
      ? recovery.searchUrls.map(url => ({
          source:'Kleinanzeigen',
          label:'Kleinanzeigen · публічний пошук',
          url
        }))
      : [])
  ]
    .filter((item, index, array) =>
      item?.url &&
      array.findIndex(other => other.url === item.url) === index
    )
    .slice(0, 4);

  return {
    ...result,
    status:listings.length
      ? (result?.status === 'ok' ? 'ok' : 'partial')
      : result?.status,
    listings,
    sources,
    searchLinks
  };
}

export function housingActiveTransport(transport = fetch, { keyboardPolicy = true } = {}) {
  return async (url, options = {}) => {
    if (!TELEGRAM_API_RE.test(String(url || '')) || typeof options.body !== 'string') {
      return transport(url, options);
    }

    let payload;
    try { payload = JSON.parse(options.body); } catch { return transport(url, options); }

    if (keyboardPolicy && Array.isArray(payload?.reply_markup?.keyboard)) {
      payload.reply_markup = {
        ...payload.reply_markup,
        resize_keyboard:true,
        one_time_keyboard:false,
        is_persistent:false
      };
    }

    if (typeof payload?.caption === 'string') payload.caption = fixCaptionSummary(payload.caption);

    if (typeof payload?.text === 'string') {
      payload.text = statewideHousingCopy(addUkrainianSummaryToText(payload.text));
      const housingish = /житл|wohnung|wohnraum|оренд|miete|місто або район/iu.test(payload.text);
      if (housingish && typeof payload?.reply_markup?.input_field_placeholder === 'string') {
        payload.reply_markup.input_field_placeholder = payload.reply_markup.input_field_placeholder.replace(/Hamburg/gu, 'Lübeck');
      }
      const criteria = parseJobcenterSearchCriteria(payload.text);
      const fallbackAt = markerIndex(payload.text);
      if (criteria && fallbackAt >= 0) {
        let result = { status:'unavailable', listings:[], searchLinks:[], sources:[] };
        try { result = await searchExpandedHousing(criteria, transport); } catch {}
        result = jurisdictionScopedResult(criteria, result);
        result = await recoverPublicKleinanzeigenIfNeeded(criteria, result, transport);
        result = jurisdictionScopedResult(criteria, result);
        result = qualityGateHousingListings(criteria, result);
        // Fixed source labels, HTTP/timing and counts only: no query, chat or URL.
        console.info('housing_search_sources', JSON.stringify(sourcesLog(result.sources)));
        payload.text = `${payload.text.slice(0, fallbackAt)}${expandedHousingText(criteria, result)}`.slice(0, 4096);
        const markup = directListingMarkup(result, criteria);
        // Recovery must enrich the terminal result, never replace its navigation.
        // Preserve radius/Kreis/menu callbacks that were already attached by the
        // active runtime and prepend direct listing/search actions above them.
        if (markup) payload.reply_markup = mergeInlineMarkup(markup, payload.reply_markup);
      }
    }

    return transport(url, { ...options, body:JSON.stringify(payload) });
  };
}
