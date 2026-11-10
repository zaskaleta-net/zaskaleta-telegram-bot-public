import { safeLogText } from './log-safe.mjs';
import { parseRoomSpec, roomSpecFromCriteria, roomValueInSpec } from './rooms.mjs';
import { resolveJobcenterRule } from './jobcenter-registry-statewide.mjs';
import { placeRouteForJobcenter } from './schleswig-holstein-place-names.mjs';

// Current result pages exceed 768 KiB. Keep a hard bound while reading the stream.
const MAX_HTML_BYTES = 2 * 1024 * 1024;
// Measured complete public responses take ~9 s; keep the whole fetch bounded.
const FETCH_TIMEOUT_MS = 12000;

const DISTRICT_SLUGS = Object.freeze({
  Dithmarschen:'dithmarschen-kreis',
  'Herzogtum Lauenburg':'herzogtum-lauenburg-kreis',
  Nordfriesland:'nordfriesland-kreis',
  Ostholstein:'ostholstein-kreis',
  Pinneberg:'pinneberg-kreis',
  Plön:'ploen-kreis',
  'Rendsburg-Eckernförde':'rendsburg-eckernfoerde-kreis',
  'Schleswig-Flensburg':'schleswig-flensburg-kreis',
  Segeberg:'segeberg-kreis',
  Steinburg:'steinburg-kreis',
  Stormarn:'stormarn-kreis'
});

const CITY_JURISDICTIONS = new Set(['Flensburg','Kiel','Lübeck','Neumünster']);

const KIP_DISTRICT_SLUGS = Object.freeze({
  Dithmarschen:'kreis-dithmarschen',
  'Herzogtum Lauenburg':'herzogtum-lauenburg',
  Nordfriesland:'nordfriesland',
  Ostholstein:'ostholstein',
  Pinneberg:'kreis-pinneberg',
  Plön:'kreis-ploen',
  'Rendsburg-Eckernförde':'rendsburg-eckernfoerde',
  'Schleswig-Flensburg':'schleswig-flensburg',
  Segeberg:'kreis-segeberg',
  Steinburg:'landkreis-steinburg',
  Stormarn:'kreis-stormarn'
});

function cleanText(value, max = 500) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&auml;/giu, 'ä')
    .replace(/&ouml;/giu, 'ö')
    .replace(/&uuml;/giu, 'ü')
    .replace(/&szlig;/giu, 'ß')
    .replace(/&euro;|&#0*(?:8364|128);|&#x0*(?:20ac|80);/giu, '€')
    .replace(/&sup2;|&#178;/giu, '²')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

export function housingSearchSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ä/gu, 'ae')
    .replace(/ö/gu, 'oe')
    .replace(/ü/gu, 'ue')
    .replace(/ß/gu, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

export function housingJurisdiction(location) {
  const routed = placeRouteForJobcenter(location);
  if (routed?.jurisdiction) return routed.jurisdiction;
  return resolveJobcenterRule(location, 1)?.jurisdiction || null;
}

function numberDe(value) {
  let text = String(value ?? '').replace(/\s/gu, '');
  if (!text) return null;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/u.test(text)) {
    text = text.replace(/\./gu, '').replace(',', '.');
  } else if (text.includes(',')) {
    text = text.replace(/\./gu, '').replace(',', '.');
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

const MONEY = String.raw`(?:\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;

function priceFromText(text) {
  const match = new RegExp(`(${MONEY})(?:\\s*[–—-]\\s*(${MONEY}))?\\s*€`, 'u').exec(String(text || ''));
  if (!match) return null;
  const a = numberDe(match[1]);
  const b = numberDe(match[2]);
  if (!Number.isFinite(a)) return null;
  return Number.isFinite(b) ? Math.max(a, b) : a;
}

function metric(text, re) {
  const match = re.exec(String(text || ''));
  return match ? numberDe(match[1]) : null;
}

async function cancelBody(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

async function readText(response, progress) {
  const reject = async reason => {
    await cancelBody(response);
    return { html:null, reason };
  };
  if (!response?.ok) return reject('http_error');
  const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (type && !type.includes('text/html') && !type.includes('text/plain') && !type.includes('application/xhtml+xml')) return reject('unsupported_content_type');
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) return reject('response_too_large');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    progress.bytesReceived = new TextEncoder().encode(text).byteLength;
    return progress.bytesReceived <= MAX_HTML_BYTES ? { html:text, reason:'read' } : { html:null, reason:'response_too_large' };
  }
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { html:text + decoder.decode(), reason:'read' };
      progress.bytesReceived += value.byteLength;
      if (progress.bytesReceived > MAX_HTML_BYTES) {
        await reader.cancel().catch(() => {});
        return { html:null, reason:'response_too_large' };
      }
      text += decoder.decode(value, { stream:true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function allowedFinalHost(hostname, allowedHost) {
  const actual = String(hostname || '').toLowerCase();
  const allowed = String(allowedHost || '').toLowerCase();
  return actual === allowed || actual === `www.${allowed}`;
}

async function fetchHtml(url, allowedHost, transport) {
  const started = Date.now();
  const progress = { httpStatus:0, bytesReceived:0 };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  let result;
  try {
    response = await transport(url, {
      method:'GET',
      headers:{
        accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'user-agent':'Mozilla/5.0 (compatible; Schleswig-Holstein-Pomichnyk/1.0)'
      },
      redirect:'follow',
      signal:controller.signal
    });
    progress.httpStatus = Number(response?.status) || 0;
    if (response?.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== 'https:' || !allowedFinalHost(finalUrl.hostname, allowedHost)) {
        await cancelBody(response);
        result = { html:null, reason:'rejected_redirect' };
      }
    }
    result ||= await readText(response, progress);
  } catch {
    await cancelBody(response);
    result = { html:null, reason:controller.signal.aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timeout);
  }
  return { ...result, ...progress, durationMs:Date.now() - started };
}

function pageDiagnostic(page, parsed = null) {
  return {
    reason:page.html == null ? page.reason : parsed?.recognized ? 'parsed' : 'unrecognized_html',
    httpStatus:page.httpStatus,
    bytesReceived:page.bytesReceived,
    durationMs:page.durationMs,
    parsedCount:parsed ? parsed.parsedCount ?? null : 0,
    matchedCount:parsed?.listings?.length || 0
  };
}

function criteriaOk(criteria) {
  const roomSpec = roomSpecFromCriteria(criteria);
  const amount = Number(criteria?.amount);
  return !!criteria?.location && !!roomSpec && Number.isFinite(amount) && amount >= 100 && amount <= 50000;
}

function listingFits(item, criteria) {
  const roomSpec = roomSpecFromCriteria(criteria);
  const amount = Number(criteria?.amount);
  return !!roomSpec
    && Number.isFinite(item?.rooms)
    && roomValueInSpec(item.rooms, roomSpec)
    && Number.isFinite(item?.price)
    && item.price > 0
    && item.price <= amount;
}

export function ukrainianHousingSummary(item) {
  const rooms = Number(item?.rooms);
  const area = Number(item?.areaSqm);
  const price = Number(item?.price);
  const where = cleanText(item?.location || '', 90);
  const type = cleanText(item?.priceType || 'ціна в оголошенні', 60);
  const parts = [];
  if (Number.isFinite(rooms)) parts.push(`${String(rooms).replace('.', ',')}-кімнатне житло`);
  else parts.push('Житло');
  if (Number.isFinite(area) && area > 0) parts.push(`площею ${String(area).replace('.', ',')} м²`);
  if (where) parts.push(`у ${where}`);
  const sentence = `${parts.join(' ')}.`;
  const priceLine = Number.isFinite(price) ? ` Вказано ${String(price).replace('.', ',')} € (${type}).` : '';
  return `${sentence}${priceLine} Перед зверненням перевірте Betriebskosten, Heizkosten та актуальність пропозиції.`.slice(0, 420);
}

function dedupe(listings) {
  const seen = new Set();
  return listings.filter(item => {
    const key = `${item.sourceId}|${item.id || item.url}`;
    if (!item.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function immoScoutSearchUrls(criteria) {
  const jurisdiction = housingJurisdiction(criteria.location);
  const locationSlug = housingSearchSlug(criteria.location);
  if (!jurisdiction || !locationSlug) return [];
  const scopes = [];
  if (CITY_JURISDICTIONS.has(jurisdiction)) {
    scopes.push(`https://www.immobilienscout24.de/Suche/de/schleswig-holstein/${locationSlug}`);
  } else {
    const districtSlug = DISTRICT_SLUGS[jurisdiction];
    if (!districtSlug) return [];
    // District mode deliberately drops the origin municipality from the URL.
    // The central jurisdiction filter remains the final fail-closed boundary.
    scopes.push(criteria?.districtJurisdiction
      ? `https://www.immobilienscout24.de/Suche/de/schleswig-holstein/${districtSlug}`
      : `https://www.immobilienscout24.de/Suche/de/schleswig-holstein/${districtSlug}/${locationSlug}`);
  }
  const suffixes = criteria?.districtJurisdiction ? ['wohnung-mieten','haus-mieten'] : ['wohnung-mieten'];
  return [...new Set(scopes.flatMap(scope => suffixes.map(suffix => `${scope}/${suffix}`)))];
}

function listingCards(source, classes) {
  const openings = /<(div|article)\b[^>]*class=["']([^"']*)["'][^>]*>/giu;
  const cards = [];
  for (const opening of source.matchAll(openings)) {
    if (!opening[2].split(/\s+/u).some(name => classes.includes(name))) continue;
    const tags = new RegExp(`<\\/?${opening[1]}\\b[^>]*>`, 'giu');
    tags.lastIndex = opening.index + opening[0].length;
    let depth = 1;
    let tag;
    while ((tag = tags.exec(source))) {
      depth += tag[0].startsWith('</') ? -1 : 1;
      if (!depth) {
        cards.push(source.slice(opening.index, tags.lastIndex));
        break;
      }
    }
  }
  return cards;
}

function parseImmoScoutPage(html, criteria) {
  if (!criteriaOk(criteria)) return { listings:[], recognized:false };
  const source = String(html || '');
  const results = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']*\/expose\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/giu;
  const roomsPattern = /(\d{1,2}(?:[.,]\d+)?)\s*Zi\.?/iu;
  const areaPattern = /(\d{1,4}(?:[.,]\d+)?)\s*m²/iu;
  let recognized = false;
  let parsedCount = 0;
  let cards = listingCards(source, ['listing-card', 'result-list-entry']);
  if (!cards.length) {
    // Older markup has adjacent anchors instead of card containers.
    const anchors = [...source.matchAll(anchorPattern)];
    cards = anchors.map((match, index) => {
      const next = anchors.slice(index + 1).find(other => other[2] !== match[2]);
      return source.slice(match.index, Math.min(next?.index ?? source.length, match.index + 6000));
    });
  }
  for (const card of cards) {
    const anchors = [...card.matchAll(anchorPattern)];
    const match = anchors.find(anchor => /<h[1-6]\b/iu.test(anchor[3])) || anchors[0];
    if (!match) continue;
    let target;
    try { target = new URL(match[1], 'https://www.immobilienscout24.de'); } catch { continue; }
    if (target.protocol !== 'https:' || !allowedFinalHost(target.hostname, 'immobilienscout24.de')) continue;
    const cardText = cleanText(card, 12000);
    if (/deaktiviert\s+vor|nicht\s+mehr\s+verfügbar/iu.test(cardText)) {
      recognized = true;
      continue;
    }
    const metricsAnchor = anchors.find(anchor => {
      const text = cleanText(anchor[3], 3000);
      return Number.isFinite(priceFromText(text)) && Number.isFinite(metric(text, roomsPattern));
    });
    const metricsText = metricsAnchor ? cleanText(metricsAnchor[3], 3000) : cardText;
    const price = priceFromText(metricsText);
    const rooms = metric(metricsText, roomsPattern);
    const areaSqm = metric(metricsText, areaPattern);
    if (!Number.isFinite(price) || !Number.isFinite(rooms)) continue;
    recognized = true;
    parsedCount++;
    const address = cleanText(/<[^>]+data-testid=["']hybridViewAddress["'][^>]*>([\s\S]*?)<\//iu.exec(card)?.[1], 140);
    // In Jobcenter district mode, exact-city matching would incorrectly discard
    // valid municipalities from the same Kreis. Jurisdiction filtering is applied
    // centrally after collection. Outside district mode, keep the strict city gate.
    if (!criteria?.districtJurisdiction && address && !` ${housingSearchSlug(address).replaceAll('-', ' ')} `.includes(` ${housingSearchSlug(criteria.location).replaceAll('-', ' ')} `)) continue;
    const anchorText = cleanText(match[3], 900);
    const priceMatch = new RegExp(`(${MONEY})(?:\\s*[–—-]\\s*(${MONEY}))?\\s*€`, 'u').exec(anchorText);
    const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/iu.exec(card)?.[1];
    const title = cleanText(heading || (priceMatch ? anchorText.slice(0, priceMatch.index) : anchorText), 180) || 'Оголошення ImmoScout24';
    const url = `https://www.immobilienscout24.de/expose/${match[2]}`;
    const item = {
      id:match[2],
      source:'ImmoScout24',
      sourceId:'immoscout24-public',
      title,
      price,
      priceType:'Kaltmiete',
      location:address || criteria.location,
      rooms,
      areaSqm:Number.isFinite(areaSqm) ? areaSqm : null,
      url,
      imageUrl:null,
      distanceKm:null,
      publicSource:true
    };
    item.summaryUk = ukrainianHousingSummary(item);
    if (listingFits(item, criteria)) results.push(item);
  }
  const empty = /(?:keine|0)\s+(?:passenden?\s+)?(?:Wohnungen|Immobilien|Angebote|Treffer)\s+(?:gefunden|in|für)/iu.test(cleanText(source, source.length));
  return { listings:dedupe(results).slice(0, 200), recognized:recognized || empty, parsedCount };
}

export function parseImmoScout24SearchPage(html, criteria) {
  return parseImmoScoutPage(html, criteria).listings;
}

export async function searchImmoScout24Housing(criteria, transport = fetch) {
  const urls = immoScoutSearchUrls(criteria);
  if (!urls.length) return { status:'unavailable', listings:[], source:'ImmoScout24' };
  const pages = await Promise.all(urls.map(async url => {
    const page = await fetchHtml(url, 'immobilienscout24.de', transport);
    const parsed = page.html == null ? null : parseImmoScoutPage(page.html, criteria);
    return { url, page, parsed };
  }));
  const listings = dedupe(pages.flatMap(({ parsed }) => parsed?.listings || []));
  const readable = pages.filter(({ parsed }) => parsed?.recognized);
  return {
    status:readable.length === pages.length ? 'ok' : readable.length ? 'partial' : 'unavailable',
    listings:listings.slice(0, 200),
    source:'ImmoScout24',
    searchUrl:pages.length === 1 && ![404, 410].includes(pages[0].page.httpStatus) ? pages[0].url : null,
    searchUrls:pages.filter(({ page }) => ![404, 410].includes(page.httpStatus)).map(({ url }) => url),
    pages:pages.map(({ page, parsed }) => pageDiagnostic(page, parsed))
  };
}

function kipCandidateUrls(criteria) {
  const requestedJurisdiction = String(criteria?.districtJurisdiction || criteria?.jobcenterJurisdiction || '').trim();
  const jurisdiction = KIP_DISTRICT_SLUGS[requestedJurisdiction] || CITY_JURISDICTIONS.has(requestedJurisdiction)
    ? requestedJurisdiction
    : housingJurisdiction(criteria.location);
  const place = housingSearchSlug(criteria.location);
  const districtMode = !!criteria?.districtJurisdiction;
  const scopes = [];
  if (!districtMode && place) scopes.push(place);
  if (jurisdiction && !CITY_JURISDICTIONS.has(jurisdiction)) {
    const district = KIP_DISTRICT_SLUGS[jurisdiction];
    if (district) scopes.push(district);
  } else if (jurisdiction && CITY_JURISDICTIONS.has(jurisdiction) && place) {
    scopes.push(place);
  }
  if (!districtMode && /^büsum$/iu.test(String(criteria.location || ''))) scopes.push('buesum-wesselburen');
  const categories = districtMode ? ['wohnungen','haeuser'] : ['wohnungen','haeuser'];
  return [...new Set(scopes.flatMap(scope => categories.map(category =>
    `https://www.kip.net/schleswig-holstein/${scope}/mieten/${category}`
  )))].slice(0, 6);
}

function parseKipPage(html, criteria) {
  if (!criteriaOk(criteria)) return { listings:[], recognized:false, parsedCount:0 };
  const source = String(html || '');
  const results = [];
  const anchor = /<a\b[^>]*href=["']([^"']*\/mieten\/(?:Wohnung|Haus)_[^"'?#\s]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/giu;
  let cards = listingCards(source, ['list-element']);
  if (!cards.length) {
    const anchors = [...source.matchAll(anchor)];
    cards = anchors.map((match, index) => {
      const next = anchors.slice(index + 1).find(other => other[1] !== match[1]);
      return source.slice(match.index, Math.min(next?.index ?? source.length, match.index + 16000));
    });
  }
  let parsedCount = 0;
  for (const card of cards) {
    const match = [...card.matchAll(anchor)].find(item => cleanText(item[2], 180));
    if (!match) continue;
    let url;
    try { url = new URL(match[1], 'https://www.kip.net').toString(); } catch { continue; }
    if (new URL(url).protocol !== 'https:' || new URL(url).hostname !== 'www.kip.net') continue;
    const title = cleanText(match[2], 180);
    if (!title) continue;
    // Metrics follow several nested columns; never borrow them from the next card.
    const window = cleanText(card, 16000);
    const kaltMatch = new RegExp(`(${MONEY})\\s*€\\s*Kaltmiete`, 'iu').exec(window);
    const price = kaltMatch ? numberDe(kaltMatch[1]) : priceFromText(window);
    const rooms = metric(window, /(\d{1,2}(?:[.,]\d+)?)\s*(?:Anzahl\s+Zimmer|Zimmer)/iu);
    const areaSqm = metric(window, /(\d{1,4}(?:[.,]\d+)?)\s*m²/iu);
    const locationMatch = /\b(\d{5}\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß .-]{2,80}?)(?=\s+\d{1,4}(?:[.,]\d+)?\s*m²|\s+Wohnfl(?:ä|ae)che|\s+\d{1,2}(?:[.,]\d+)?\s*(?:Anzahl\s+Zimmer|Zimmer))/u.exec(window);
    const location = cleanText(locationMatch?.[1] || criteria.location, 100);
    if (!Number.isFinite(price) || !Number.isFinite(rooms)) continue;
    parsedCount++;
    if (/nicht\s+mehr\s+verfügbar|bereits\s+vermietet/iu.test(window)) continue;
    if (!criteria?.districtJurisdiction && !location.toLocaleLowerCase('de-DE').includes(String(criteria.location).toLocaleLowerCase('de-DE'))) continue;
    const id = /(?:Wohnung|Haus)_([^/?#]+)/u.exec(url)?.[1] || url;
    const item = {
      id,
      source:'KIP Schleswig-Holstein',
      sourceId:'kip-sh-live',
      title,
      price,
      priceType:kaltMatch ? 'Kaltmiete' : /warm/iu.test(window) ? 'Warmmiete' : 'ціна в оголошенні',
      location,
      rooms,
      areaSqm:Number.isFinite(areaSqm) ? areaSqm : null,
      url,
      imageUrl:null,
      distanceKm:null,
      publicSource:true
    };
    item.summaryUk = ukrainianHousingSummary(item);
    if (listingFits(item, criteria)) results.push(item);
  }
  const empty = /(?:keine\s+(?:passenden?\s+)?(?:Wohnungen|Häuser|Haeuser|Angebote|Immobilien)\s+gefunden|aktuell\s+(?:0|keine)\s+(?:Mietwohnungen|Miethäuser|Miethaeuser))/iu.test(cleanText(source, MAX_HTML_BYTES));
  return { listings:dedupe(results).slice(0, 200), recognized:parsedCount > 0 || empty, parsedCount };
}

export function parseKipHousingPage(html, criteria) {
  return parseKipPage(html, criteria).listings;
}

export async function searchKipHousing(criteria, transport = fetch) {
  const urls = kipCandidateUrls(criteria);
  if (!urls.length) return { status:'unavailable', listings:[], source:'KIP Schleswig-Holstein' };
  const pages = await Promise.all(urls.map(async url => {
    const page = await fetchHtml(url, 'kip.net', transport);
    return { page, parsed:page.html == null ? null : parseKipPage(page.html, criteria) };
  }));
  const listings = dedupe(pages.flatMap(({ parsed }) => parsed?.listings || []));
  const readable = pages.filter(({ parsed }) => parsed?.recognized);
  return {
    status:readable.length === pages.length ? 'ok' : readable.length ? 'partial' : 'unavailable',
    listings:listings.slice(0, 200),
    source:'KIP Schleswig-Holstein',
    searchUrls:urls.filter((_url, index) => ![404, 410].includes(pages[index].page.httpStatus)),
    pages:pages.map(({ page, parsed }) => pageDiagnostic(page, parsed))
  };
}

export function parseWodiHousingPage(html, criteria) {
  if (!criteriaOk(criteria)) return [];
  if (housingJurisdiction(criteria.location) !== 'Dithmarschen') return [];
  const source = String(html || '');
  const anchors = [...source.matchAll(/<a\b[^>]*href=["']([^"']*\/wohnen\/immobilienansicht\/objekt\/ansicht\/[^"']+)["'][^>]*>[\s\S]*?<\/a>/giu)];
  const out = [];
  for (let index = 0; index < anchors.length; index += 1) {
    const match = anchors[index];
    const end = index + 1 < anchors.length ? anchors[index + 1].index : Math.min(source.length, match.index + 5000);
    const window = cleanText(source.slice(match.index, end), 2200);
    const rooms = metric(window, /Zimmer\s*:?\s*(\d{1,2}(?:[.,]\d+)?)/iu);
    const areaSqm = metric(window, /Wohnfl(?:ä|ae)che\s*:?\s*(\d{1,4}(?:[.,]\d+)?)/iu);
    const priceMatch = /Kaltmiete\s*:?\s*(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:EUR|€)/iu.exec(window);
    const price = priceMatch ? numberDe(priceMatch[1]) : null;
    if (!Number.isFinite(rooms) || !Number.isFinite(price)) continue;
    const titleMatch = /Details\s*\+?\s*(.{4,180}?)\s+Zimmer\s*:/iu.exec(window);
    const title = cleanText(titleMatch?.[1] || 'Wohnungsunternehmen Dithmarschen – Mietangebot', 180);
    const location = cleanText(title.split(':')[0] || criteria.location, 100);
    if (!location.toLocaleLowerCase('de-DE').includes(String(criteria.location).toLocaleLowerCase('de-DE'))
        && !String(criteria.location).toLocaleLowerCase('de-DE').includes(location.toLocaleLowerCase('de-DE'))) continue;
    let url;
    try { url = new URL(match[1], 'https://www.wo-di.de').toString(); } catch { continue; }
    if (new URL(url).hostname !== 'www.wo-di.de') continue;
    const id = url.split('/').pop() || url;
    const item = {
      id,
      source:'Wohnungsunternehmen Dithmarschen',
      sourceId:'wodi-direct',
      title,
      price,
      priceType:'Kaltmiete',
      location,
      rooms,
      areaSqm:Number.isFinite(areaSqm) ? areaSqm : null,
      url,
      imageUrl:null,
      distanceKm:null,
      publicSource:true
    };
    item.summaryUk = ukrainianHousingSummary(item);
    if (listingFits(item, criteria)) out.push(item);
  }
  return dedupe(out).slice(0, 8);
}

export async function searchWodiHousing(criteria, transport = fetch) {
  if (housingJurisdiction(criteria?.location) !== 'Dithmarschen') {
    return { status:'not_relevant', listings:[], source:'Wohnungsunternehmen Dithmarschen' };
  }
  const url = 'https://www.wo-di.de/wohnen.html';
  const page = await fetchHtml(url, 'wo-di.de', transport);
  const html = page.html;
  if (html == null) return { status:'unavailable', listings:[], source:'Wohnungsunternehmen Dithmarschen', searchUrl:url, pages:[pageDiagnostic(page)] };
  const listings = parseWodiHousingPage(html, criteria);
  const text = cleanText(html, MAX_HTML_BYTES);
  const recognized = (/\/wohnen\/immobilienansicht\/objekt\/ansicht\//u.test(html) && /Kaltmiete\s*:?\s*\d/iu.test(text) && /Zimmer\s*:?\s*\d/iu.test(text))
    || /(?:keine\s+(?:freien\s+)?Wohnungen|keine\s+Angebote)\s+(?:verfügbar|gefunden)/iu.test(text);
  return { status:recognized ? 'ok' : 'unavailable', listings, source:'Wohnungsunternehmen Dithmarschen', searchUrl:url, pages:[pageDiagnostic(page, { recognized, listings })] };
}

export async function searchExpandedHousing(criteria, transport = fetch) {
  if (!criteriaOk(criteria)) return { status:'invalid_criteria', listings:[], sources:[] };
  // ImmoScout24 answers Cloudflare egress with 401 on every request, so it is
  // not fetched automatically; it remains an external search button.
  const sourceTasks = [
    ['KIP Schleswig-Holstein', () => searchKipHousing(criteria, transport)],
    ['Wohnungsunternehmen Dithmarschen', () => searchWodiHousing(criteria, transport)]
  ];
  const settled = await Promise.allSettled(sourceTasks.map(([, run]) => run()));
  const results = settled.map((value, index) => {
    if (value.status === 'fulfilled') return value.value;
    const error = value.reason;
    console.error('housing source search failed', {
      source:sourceTasks[index][0],
      jurisdiction:housingJurisdiction(criteria.location),
      error:safeLogText(error instanceof Error ? error.message : error)
    });
    return {
      status:'unavailable',
      listings:[],
      source:sourceTasks[index][0],
      pages:[{
        reason:'source_exception',
        error:safeLogText(error instanceof Error ? error.message : error),
        httpStatus:0,
        bytesReceived:0,
        durationMs:0,
        parsedCount:0,
        matchedCount:0
      }]
    };
  });
  const listings = dedupe(results.flatMap(result => result.listings || []))
    .sort((a, b) => (a.price - b.price) || ((b.areaSqm || 0) - (a.areaSqm || 0)))
    .slice(0, 200);
  const searchLinks = [];
  for (const result of results) {
    if (result.searchUrl) searchLinks.push({ source:result.source, url:result.searchUrl });
    for (const url of Array.isArray(result.searchUrls) ? result.searchUrls : []) {
      const scope = url.includes('/kreis-') ? `Kreis ${housingJurisdiction(criteria.location)}`
        : url.includes('/buesum-wesselburen/') ? 'Büsum-Wesselburen' : criteria.location;
      const label = result.source === 'KIP Schleswig-Holstein' ? `KIP · ${scope}` : `${result.source} · ${scope}`;
      searchLinks.push({ source:result.source, label, url });
    }
  }
  const relevant = results.filter(result => result.status !== 'not_relevant');
  const hasReadable = relevant.some(result => result.status === 'ok' || result.status === 'partial');
  return {
    status:relevant.every(result => result.status === 'ok') ? 'ok' : hasReadable ? 'partial' : 'unavailable',
    listings,
    sources:results.map(result => ({ source:result.source, status:result.status, count:(result.listings || []).length, pages:result.pages || [] })),
    searchLinks:searchLinks.filter((item, index, array) => array.findIndex(other => other.url === item.url) === index).slice(0, 4)
  };
}

export function parseRoomLabel(value) {
  return parseRoomSpec(value)?.label || null;
}
