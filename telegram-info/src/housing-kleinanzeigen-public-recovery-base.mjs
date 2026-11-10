import { roomSpecFromCriteria, roomValueInSpec } from './rooms.mjs';
import { kleinanzeigenLocationId } from './kleinanzeigen-location.mjs';

const RAW_LIMIT = 3 * 1024 * 1024;
const TIMEOUT_MS = 10000;
// In-radius neighbours (e.g. Ahrensburg for Trittau, match 10 live) can sit
// below the first matches, so a whole result page (about 25 ads) is kept.
const MAX_MATCHED_LISTINGS = 30;
const HOST_RE = /^(?:www\.)?kleinanzeigen\.de$/iu;
const BROWSER_HEADERS = Object.freeze({
  accept:'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language':'de-DE,de;q=0.9,en;q=0.7',
  'cache-control':'no-cache',
  pragma:'no-cache',
  'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
});

function decodeHtml(value) {
  const named = new Map([
    ['amp','&'],['quot','"'],['apos',"'"],['lt','<'],['gt','>'],['nbsp',' '],
    ['auml','ä'],['Auml','Ä'],['ouml','ö'],['Ouml','Ö'],['uuml','ü'],['Uuml','Ü'],['szlig','ß']
  ]);
  return String(value || '')
    .replace(/&([a-zA-Z]+);/gu, (all, name) => named.has(name) ? named.get(name) : all)
    .replace(/&#(\d+);/gu, (all, number) => {
      const code = Number(number);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    })
    .replace(/&#x([0-9a-f]+);/giu, (all, number) => {
      const code = Number.parseInt(number, 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    });
}

function cleanText(value, max = 2000) {
  return decodeHtml(String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' '))
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

function htmlLines(value) {
  const source = String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/article|\/section|\/h[1-6]|\/span)\b[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ');
  return decodeHtml(source).split(/\n+/u).map(line => line.replace(/\s+/gu, ' ').trim()).filter(Boolean);
}

function numberDe(value) {
  let text = String(value ?? '').replace(/\s/gu, '').replace(/€/gu, '');
  if (!text) return null;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/u.test(text)) text = text.replace(/\./gu, '').replace(',', '.');
  else if (text.includes(',')) text = text.replace(/\./gu, '').replace(',', '.');
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalized(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ä/gu, 'ae').replace(/ö/gu, 'oe').replace(/ü/gu, 'ue').replace(/ß/gu, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/gu, '')
    .replace(/\b\d{5}\b/gu, ' ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function slug(value) {
  return normalized(value).replace(/\s+/gu, '-');
}

function exactLocationMatch(requested, actual) {
  const wanted = normalized(requested);
  const seen = normalized(actual);
  if (!wanted || !seen) return false;
  return seen === wanted || seen.startsWith(`${wanted} `) || seen.endsWith(` ${wanted}`) || seen.includes(` ${wanted} `);
}

function roomSearchValues(criteria) {
  const spec = roomSpecFromCriteria(criteria);
  if (!spec) return [];
  const values = [];
  if (Number.isInteger(spec.min) && Number.isInteger(spec.max) && spec.max - spec.min <= 2) {
    for (let room = spec.min; room <= spec.max; room += 1) values.push(room);
  }
  return values;
}

function searchUrls(criteria) {
  const location = slug(criteria?.location);
  if (!location) return [];
  const generic = `https://www.kleinanzeigen.de/s-wohnung-mieten/${location}/k0c203`;
  const rooms = roomSearchValues(criteria);
  if (!rooms.length) return [generic];
  const scoped = rooms.map(room => `https://www.kleinanzeigen.de/s-wohnung-mieten/${location}/${room}--zimmer-wohnung-mieten/k0c203`);
  return [generic, ...scoped].slice(0, 3);
}

function locationIdFromHtml(html, criteria) {
  const wanted = slug(criteria?.location);
  if (!wanted) return null;
  for (const match of String(html || '').matchAll(/href=["']([^"']+)["']/giu)) {
    const href = decodeHtml(match[1]);
    if (!href.includes(`/s-wohnung-mieten/${wanted}/`) && !href.includes(`/s-${wanted}/`)) continue;
    const id = /(?:c203|k0)l(\d{1,12})(?:\b|[/?#&])/u.exec(href)?.[1];
    if (id) return id;
  }
  return null;
}

function strictLocationSearchUrl(criteria, locationId = null) {
  const roomSpec = roomSpecFromCriteria(criteria);
  const amount = Number(criteria?.amount);
  const location = String(criteria?.location || '').replace(/\s+/gu, ' ').trim();
  if (!location || !roomSpec || !Number.isFinite(amount) || amount < 100 || amount > 50000) return null;
  const params = new URLSearchParams();
  params.set('categoryId', '203');
  const id = String(locationId || '').trim();
  if (/^\d{1,12}$/u.test(id)) params.set('locationId', id);
  else params.set('locationStr', `${location}, Schleswig-Holstein`);
  params.set('attributeMap[wohnung_mieten.zimmer_d]', `${roomSpec.min},${roomSpec.max}`);
  // Whole euros: Kleinanzeigen reads "943.8" as 9438 (preis::9438). Rounding up
  // keeps every offer up to the limit; the parser applies the exact limit.
  params.set('maxPrice', String(Math.ceil(amount)));
  const radiusKm = Number(criteria?.radiusKm);
  if (!criteria?.districtJurisdiction && Number.isFinite(radiusKm) && radiusKm > 0 && radiusKm <= 100) {
    params.set('radius', String(Math.round(radiusKm)));
  }
  return `https://www.kleinanzeigen.de/s-suchanfrage.html?${params.toString()}`;
}

async function readBounded(response) {
  if (!response?.ok) return { html:null, reason:'http_error', bytes:0 };
  const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (type && !type.includes('text/html') && !type.includes('application/xhtml+xml') && !type.includes('text/plain')) return { html:null, reason:'unsupported_content_type', bytes:0 };
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > RAW_LIMIT) return { html:null, reason:'response_too_large', bytes:0 };
  const reader = response.body?.getReader?.();
  if (!reader) {
    const html = await response.text();
    const bytes = new TextEncoder().encode(html).byteLength;
    return bytes <= RAW_LIMIT ? { html, reason:'read', bytes } : { html:null, reason:'response_too_large', bytes };
  }
  const decoder = new TextDecoder();
  let html = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { html:html + decoder.decode(), reason:'read', bytes };
      bytes += value.byteLength;
      if (bytes > RAW_LIMIT) {
        await reader.cancel().catch(() => {});
        return { html:null, reason:'response_too_large', bytes };
      }
      html += decoder.decode(value, { stream:true });
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function articleCards(source) {
  const starts = [...String(source || '').matchAll(/<article\b[^>]*(?:class=["'][^"']*\baditem\b[^"']*["']|data-adid=["'][^"']+["'])[^>]*>/giu)];
  if (!starts.length) return [];
  return starts.map((match, index) => String(source).slice(match.index, starts[index + 1]?.index ?? String(source).length));
}

function anchorCards(source) {
  const links = [...String(source || '').matchAll(/<a\b[^>]*href=["']([^"']*\/s-anzeige\/[^"']+)["'][^>]*>/giu)];
  return links.map((match, index) => {
    const next = links.slice(index + 1).find(other => other[1] !== match[1]);
    const start = Math.max(0, match.index - 2500);
    const end = Math.min(String(source).length, next?.index ?? match.index + 12000);
    return String(source).slice(start, end);
  });
}

function absoluteListingUrl(href) {
  try {
    const url = new URL(href, 'https://www.kleinanzeigen.de');
    if (url.protocol !== 'https:' || !HOST_RE.test(url.hostname) || !/\/s-anzeige\//u.test(url.pathname)) return null;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

function imageUrl(card) {
  const candidates = [...String(card || '').matchAll(/<(?:img|source)\b[^>]*(?:src|data-src|data-imgsrc|srcset)=["']([^"']+)["'][^>]*>/giu)];
  for (const match of candidates) {
    const raw = String(match[1] || '').split(/\s+/u)[0];
    try {
      const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, 'https://www.kleinanzeigen.de');
      if (url.protocol !== 'https:') continue;
      if (!/(?:kleinanzeigen\.de|ebayimg\.com|img\.kleinanzeigen\.de)$/iu.test(url.hostname)) continue;
      return url.toString();
    } catch {}
  }
  return null;
}

function titleFromCard(card, href) {
  const escaped = String(href || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const exact = escaped ? new RegExp(`<a\\b[^>]*href=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/a>`, 'iu').exec(card)?.[1] : null;
  const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/iu.exec(card)?.[1];
  const candidate = cleanText(heading || exact || '', 180);
  if (candidate) return candidate;
  const lines = htmlLines(card);
  return lines.find(line => /wohnung|apartment|zuhause|zimmer/iu.test(line) && line.length >= 8 && line.length <= 180) || 'Kleinanzeigen Wohnungsangebot';
}

function parseCard(card, criteria, { locationScoped = false } = {}) {
  const roomSpec = roomSpecFromCriteria(criteria);
  if (!roomSpec) return null;
  const hrefMatch = /<a\b[^>]*href=["']([^"']*\/s-anzeige\/[^"']+)["'][^>]*>/iu.exec(card);
  if (!hrefMatch) return null;
  const url = absoluteListingUrl(hrefMatch[1]);
  if (!url) return null;
  const lines = htmlLines(card);
  const locationIndex = lines.findIndex(line => /^\d{5}\s+.{2,100}$/u.test(line) && !/[€²]/u.test(line));
  const rawLocation = locationIndex >= 0 ? lines[locationIndex] : '';
  const adjacentDistance = locationIndex >= 0
    ? lines.slice(locationIndex + 1, locationIndex + 3)
      .find(line => /^\((?:ca\.\s*)?\d{1,3}(?:[.,]\d+)?\s*km\)$/iu.test(line)) || ''
    : '';
  const locationDistanceText = adjacentDistance ? `${rawLocation}${adjacentDistance}` : rawLocation;
  const distanceMatch = /\((?:ca\.\s*)?(\d{1,3}(?:[.,]\d+)?)\s*km\)\s*$/iu.exec(locationDistanceText);
  const distanceKm = distanceMatch ? numberDe(distanceMatch[1]) : null;
  const location = rawLocation.replace(/\s*\((?:ca\.\s*)?\d{1,3}(?:[.,]\d+)?\s*km\)\s*$/iu, '').trim();
  const radiusKm = Number(criteria?.radiusKm);
  if (!location || (!locationScoped && !exactLocationMatch(criteria.location, location))) return null;
  if (locationScoped && Number.isFinite(distanceKm) && Number.isFinite(radiusKm) && distanceKm > radiusKm) return null;
  const metricLine = lines.find(line => /m(?:²|2)/iu.test(line) && /\bZi\.?\b/iu.test(line)) || cleanText(card, 12000);
  const areaThenRooms = /(\d{1,4}(?:[.,]\d+)?)\s*m(?:²|2)[^\d]{0,30}(\d{1,2}(?:[.,]\d+)?)\s*Zi\.?/iu.exec(metricLine);
  const roomsThenArea = areaThenRooms ? null : /(\d{1,2}(?:[.,]\d+)?)\s*Zi\.?[^\d]{0,30}(\d{1,4}(?:[.,]\d+)?)\s*m(?:²|2)/iu.exec(metricLine);
  let areaSqm = null;
  let rooms = null;
  if (areaThenRooms) {
    areaSqm = numberDe(areaThenRooms[1]);
    rooms = numberDe(areaThenRooms[2]);
  } else if (roomsThenArea) {
    rooms = numberDe(roomsThenArea[1]);
    areaSqm = numberDe(roomsThenArea[2]);
  }
  if (!Number.isFinite(rooms)) {
    const roomMatch = /(\d{1,2}(?:[.,]\d+)?)\s*Zi\.?/iu.exec(cleanText(card, 12000));
    rooms = roomMatch ? numberDe(roomMatch[1]) : null;
  }
  if (!Number.isFinite(areaSqm)) {
    const areaMatch = /(\d{1,4}(?:[.,]\d+)?)\s*m(?:²|2)/iu.exec(cleanText(card, 12000));
    areaSqm = areaMatch ? numberDe(areaMatch[1]) : null;
  }
  if (!Number.isFinite(rooms) || !roomValueInSpec(rooms, roomSpec)) return null;
  const text = cleanText(card, 12000);
  const title = titleFromCard(card, hrefMatch[1]);
  if (/tauschwohnung|tauschangebot|wohnungstausch/iu.test(`${title} ${text}`)) return null;
  if (/\bgesuch\b/iu.test(text)) return null;
  if (/\b(?:eigentumswohnung|zum\s+verkauf|zu\s+verkaufen)\b/iu.test(`${title} ${text}`)) return null;
  const prices = lines
    .filter(line => /€|EUR/iu.test(line) && !/kaution|courtage|provision/iu.test(line))
    .map(line => /(?:^|\s)(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:€|EUR)/iu.exec(line)?.[1])
    .map(numberDe)
    .filter(value => Number.isFinite(value) && value >= 100 && value <= 50000);
  const price = prices[0] ?? null;
  const maxPrice = Number(criteria?.amount);
  if (!Number.isFinite(price) || !Number.isFinite(maxPrice) || price > maxPrice) return null;
  const id = /\/(\d{6,}(?:-\d+){0,3})(?:\/)?$/u.exec(new URL(url).pathname)?.[1] || url;
  return {
    id,
    source:'Kleinanzeigen',
    sourceId:'kleinanzeigen-public',
    title,
    price,
    priceType:'ціна в оголошенні',
    location,
    rooms,
    areaSqm:Number.isFinite(areaSqm) ? areaSqm : null,
    url,
    imageUrl:imageUrl(card),
    distanceKm:Number.isFinite(distanceKm) ? distanceKm : null,
    locationScoped:Boolean(locationScoped),
    publicSource:true
  };
}

export function parseKleinanzeigenPublicPage(html, criteria, options = {}) {
  const source = String(html || '');
  if (!source) return [];
  let cards = articleCards(source);
  if (!cards.length) cards = anchorCards(source);
  const out = [];
  const seen = new Set();
  for (const card of cards) {
    const item = parseCard(card, criteria, options);
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
    if (out.length >= MAX_MATCHED_LISTINGS) break;
  }
  return out;
}

async function fetchPage(url, criteria, transport, { locationScoped = false, timeoutMs = TIMEOUT_MS } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  let bytes = 0;
  try {
    const response = await transport(url, { method:'GET', headers:BROWSER_HEADERS, redirect:'follow', signal:controller.signal });
    status = Number(response?.status) || 0;
    if (response?.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== 'https:' || !HOST_RE.test(finalUrl.hostname)) return { listings:[], reason:'rejected_redirect', status, bytes, durationMs:Date.now() - started, locationId:null };
    }
    // TG-RUNTIME-068: Kleinanzeigen answers 403 for whole days (logs since
    // 20.10.2026); that is a block, not a missing page.
    if (status === 403) return { listings:[], reason:'blocked', status, bytes:0, durationMs:Date.now() - started, locationId:null };
    const read = await readBounded(response);
    bytes = read.bytes;
    if (read.html == null) return { listings:[], reason:read.reason, status, bytes, durationMs:Date.now() - started, locationId:null };
    if (/captcha|verify\s+you\s+are\s+human|zugriff\s+verweigert|access\s+denied/iu.test(read.html)) return { listings:[], reason:'challenge', status, bytes, durationMs:Date.now() - started, locationId:null };
    const locationId = locationIdFromHtml(read.html, criteria);
    const listings = parseKleinanzeigenPublicPage(read.html, criteria, { locationScoped });
    const recognized = /class=["'][^"']*\baditem\b|\/s-anzeige\//iu.test(read.html);
    return { listings, reason:listings.length ? 'parsed' : recognized ? 'no_match' : 'unrecognized_html', status, bytes, durationMs:Date.now() - started, locationId };
  } catch {
    return { listings:[], reason:controller.signal.aborted ? 'timeout' : 'network_error', status, bytes:0, durationMs:Date.now() - started, locationId:null };
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchKleinanzeigenPublicRecovery(criteria, transport = fetch) {
  if (!criteria?.location || !roomSpecFromCriteria(criteria)) return { status:'not_relevant', listings:[], searchUrls:[], pages:[] };

  // A pinned id avoids the free-text place guess ("Plön, Schleswig-Holstein"
  // resolves to the whole state, i.e. Kiel).
  const strictUrl = strictLocationSearchUrl(criteria, kleinanzeigenLocationId(criteria.location));
  const urls = [];
  const pages = [];
  if (strictUrl) {
    urls.push(strictUrl);
    const strictPage = await fetchPage(strictUrl, criteria, transport, { locationScoped:true, timeoutMs:4500 });
    pages.push(strictPage);
    if (strictPage.listings?.length) {
      return {
        status:'ok',
        listings:strictPage.listings.slice(0, MAX_MATCHED_LISTINGS),
        searchUrls:urls,
        pages:pages.map(page => ({ reason:page.reason, httpStatus:page.status, bytesReceived:page.bytes, durationMs:page.durationMs, matchedCount:page.listings?.length || 0 }))
      };
    }
    // Blocked: the catalog pages come from the same host and are blocked too.
    if (strictPage.reason === 'blocked') {
      return {
        status:'blocked',
        listings:[],
        searchUrls:urls,
        pages:pages.map(page => ({ reason:page.reason, httpStatus:page.status, bytesReceived:page.bytes, durationMs:page.durationMs, matchedCount:0 }))
      };
    }
    // A recognized result page with zero parsed cards is not authoritative.
    // Kleinanzeigen markup changes can make the strict parser miss valid offers,
    // so continue through the fallback catalog URLs before declaring zero results.
  }

  const fallbackUrls = searchUrls(criteria).filter(url => !urls.includes(url));
  const fallbackPages = await Promise.all(fallbackUrls.map(url => fetchPage(url, criteria, transport)));
  urls.push(...fallbackUrls);
  pages.push(...fallbackPages);

  const seen = new Set();
  const listings = pages.flatMap(page => page.listings || []).filter(item => {
    if (!item?.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }).slice(0, MAX_MATCHED_LISTINGS);
  return {
    status:listings.length ? 'ok' : pages.some(page => page.reason === 'no_match') ? 'ok' : 'unavailable',
    listings,
    searchUrls:urls,
    pages:pages.map(page => ({ reason:page.reason, httpStatus:page.status, bytesReceived:page.bytes, durationMs:page.durationMs, matchedCount:page.listings?.length || 0 }))
  };
}
