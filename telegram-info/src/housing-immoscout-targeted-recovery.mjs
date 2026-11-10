import { parseRoomSpec } from './rooms.mjs';
import { housingJurisdiction, housingSearchSlug, parseImmoScout24SearchPage } from './housing-expanded-v22.mjs';

const RAW_LIMIT = 12 * 1024 * 1024;
const COMPACT_LIMIT = 3 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const BROWSER_HEADERS = Object.freeze({
  accept:'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language':'de-DE,de;q=0.9,en;q=0.7',
  'cache-control':'no-cache',
  pragma:'no-cache',
  'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
});

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

function allowedHost(value) {
  try {
    const host = new URL(String(value)).hostname.toLowerCase();
    return host === 'immobilienscout24.de' || host === 'www.immobilienscout24.de';
  } catch { return false; }
}

function scopedUrls(criteria) {
  const spec = parseRoomSpec(criteria?.rooms);
  const location = housingSearchSlug(criteria?.location);
  const jurisdiction = housingJurisdiction(criteria?.location);
  if (!spec || !location || !jurisdiction || spec.max - spec.min > 2) return [];
  const base = CITY_JURISDICTIONS.has(jurisdiction)
    ? `https://www.immobilienscout24.de/Suche/de/schleswig-holstein/${location}`
    : DISTRICT_SLUGS[jurisdiction]
      ? `https://www.immobilienscout24.de/Suche/de/schleswig-holstein/${DISTRICT_SLUGS[jurisdiction]}/${location}`
      : null;
  if (!base) return [];
  const out = [];
  for (let rooms = spec.min; rooms <= spec.max; rooms += 1) out.push(`${base}/${rooms}-zimmer-wohnung-mieten`);
  return out;
}

async function readBounded(response) {
  if (!response?.ok) return { html:null, reason:'http_error', bytes:0 };
  const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (type && !type.includes('text/html') && !type.includes('application/xhtml+xml') && !type.includes('text/plain')) {
    return { html:null, reason:'unsupported_content_type', bytes:0 };
  }
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > RAW_LIMIT) return { html:null, reason:'response_too_large', bytes:0 };
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    return bytes <= RAW_LIMIT ? { html:text, reason:'read', bytes } : { html:null, reason:'response_too_large', bytes };
  }
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { html:text + decoder.decode(), reason:'read', bytes };
      bytes += value.byteLength;
      if (bytes > RAW_LIMIT) {
        await reader.cancel().catch(() => {});
        return { html:null, reason:'response_too_large', bytes };
      }
      text += decoder.decode(value, { stream:true });
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function compactHtml(source) {
  const compact = String(source || '')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ');
  return new TextEncoder().encode(compact).byteLength <= COMPACT_LIMIT ? compact : null;
}

async function fetchScoped(url, criteria, transport) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let status = 0;
  let bytes = 0;
  try {
    const response = await transport(url, {
      method:'GET',
      headers:{ ...BROWSER_HEADERS },
      redirect:'follow',
      signal:controller.signal
    });
    status = Number(response?.status) || 0;
    if (response?.url && !allowedHost(response.url)) return { listings:[], reason:'rejected_redirect', status, bytes, durationMs:Date.now()-started };
    const read = await readBounded(response);
    bytes = read.bytes;
    if (read.html == null) return { listings:[], reason:read.reason, status, bytes, durationMs:Date.now()-started };
    if (/verify\s+you\s+are\s+human|captcha|access\s+denied|unusual\s+traffic|automated\s+requests?/iu.test(read.html)) {
      return { listings:[], reason:'challenge', status, bytes, durationMs:Date.now()-started };
    }
    const compact = compactHtml(read.html);
    if (compact == null) return { listings:[], reason:'compact_too_large', status, bytes, durationMs:Date.now()-started };
    const listings = parseImmoScout24SearchPage(compact, criteria);
    return { listings, reason:listings.length ? 'parsed' : 'no_match', status, bytes, durationMs:Date.now()-started };
  } catch {
    return { listings:[], reason:controller.signal.aborted ? 'timeout' : 'network_error', status, bytes, durationMs:Date.now()-started };
  } finally {
    clearTimeout(timeout);
  }
}

function dedupe(listings) {
  const seen = new Set();
  return listings.filter(item => {
    const key = String(item?.url || item?.id || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function searchTargetedImmoScoutRecovery(criteria, transport = fetch) {
  const urls = scopedUrls(criteria);
  if (!urls.length) return { status:'not_relevant', listings:[], searchUrls:[], pages:[] };
  const pages = await Promise.all(urls.map(url => fetchScoped(url, criteria, transport)));
  const listings = dedupe(pages.flatMap(page => page.listings || [])).slice(0, 8);
  return {
    status:listings.length ? 'ok' : 'unavailable',
    listings,
    searchUrls:urls,
    pages:pages.map(page => ({ reason:page.reason, httpStatus:page.status, bytesReceived:page.bytes, durationMs:page.durationMs, matchedCount:page.listings?.length || 0 }))
  };
}
