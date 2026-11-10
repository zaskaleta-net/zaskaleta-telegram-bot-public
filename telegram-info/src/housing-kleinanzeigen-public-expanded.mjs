import { parseRoomSpec } from './rooms.mjs';
import {
  parseKleinanzeigenPublicPage,
  searchKleinanzeigenPublicRecovery as searchPrimaryKleinanzeigenRecovery
} from './housing-kleinanzeigen-public-recovery-base.mjs';

const TARGET_DIRECT_LISTINGS = 12;
const MAX_DIRECT_LISTINGS = 30;
const MAX_SUPPLEMENTAL_URLS = 20;
const SUPPLEMENTAL_CONCURRENCY = 4;
const SUPPLEMENTAL_BUDGET_MS = 6500;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 4500;
const HOST_RE = /^(?:www\.)?kleinanzeigen\.de$/iu;
const BROWSER_HEADERS = Object.freeze({
  accept:'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language':'de-DE,de;q=0.9,en;q=0.7',
  'cache-control':'no-cache',
  pragma:'no-cache',
  'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
});

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ä/gu, 'ae').replace(/ö/gu, 'oe').replace(/ü/gu, 'ue').replace(/ß/gu, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function slug(value) { return normalize(value).replace(/\s+/gu, '-'); }

function roomValues(criteria) {
  const spec = parseRoomSpec(criteria?.rooms);
  if (!spec || !Number.isInteger(spec.min) || !Number.isInteger(spec.max) || spec.max - spec.min > 2) return [];
  const out = [];
  for (let room = spec.min; room <= spec.max; room += 1) out.push(room);
  return out;
}

export function supplementalKleinanzeigenUrls(criteria) {
  const location = slug(criteria?.location);
  if (!location) return [];
  const rooms = roomValues(criteria);
  const urls = [];
  if (location === 'bad-segeberg' && rooms.length === 1) {
    urls.push(`https://www.kleinanzeigen.de/s-wohnung-mieten/bad-segeberg/wohnung-mieten---${rooms[0]}/k0c203l883`);
  }
  if (location === 'heide' && rooms.length === 1) {
    urls.push(`https://www.kleinanzeigen.de/s-wohnung-mieten/heide/${rooms[0]}----zimmer/k0c203l836`);
    urls.push(`https://www.kleinanzeigen.de/s-immobilien/heide/anzeige%3Aangebote/${rooms[0]}-zimmer-wohnung/k0c195l836`);
  }
  if (location === 'luebeck' && rooms.length === 1) {
    urls.push(`https://www.kleinanzeigen.de/s-wohnung-mieten/luebeck/${rooms[0]}---zimmer/k0c203l409`);
    urls.push(`https://www.kleinanzeigen.de/s-wohnung-mieten/luebeck/${rooms[0]}-zimmer.wohnung/k0c203l409`);
  }

  // Statewide depth: inspect several public result pages instead of stopping
  // after the first catalog page. The parser remains the authority for
  // location, room-spec and price filtering, so extra pages increase recall
  // without weakening Jobcenter safety semantics.
  urls.push(`https://www.kleinanzeigen.de/s-wohnung-mieten-${location}/k0`);
  urls.push(`https://www.kleinanzeigen.de/s-haus-mieten-${location}/k0`);
  urls.push(`https://www.kleinanzeigen.de/s-wohnung-mieten-${location}/seite:2/k0`);
  urls.push(`https://www.kleinanzeigen.de/s-haus-mieten-${location}/seite:2/k0`);
  urls.push(`https://www.kleinanzeigen.de/s-wohnung-mieten-${location}/seite:3/k0`);
  urls.push(`https://www.kleinanzeigen.de/s-haus-mieten-${location}/seite:3/k0`);
  for (const room of rooms) {
    urls.push(`https://www.kleinanzeigen.de/s-${location}/${room}-zimmer-wohnung-mieten/k0`);
    urls.push(`https://www.kleinanzeigen.de/s-${location}/${room}-zimmer-haus-mieten/k0`);
    urls.push(`https://www.kleinanzeigen.de/s-${location}/seite%3A2/${room}-zimmer-wohnung-mieten/k0`);
    urls.push(`https://www.kleinanzeigen.de/s-${location}/seite%3A3/${room}-zimmer-wohnung-mieten/k0`);
  }
  return [...new Set(urls)].slice(0, MAX_SUPPLEMENTAL_URLS);
}

function offerLike(item) {
  const title = String(item?.title || '').replace(/\s+/gu, ' ').trim();
  if (!title) return false;
  if (/tauschwohnung|tauschangebot|wohnungstausch/iu.test(title)) return false;
  if (/\banfragestopp\b/iu.test(title)) return false;
  if (/\bnachmieter(?:in)?\b.{0,100}\bgesucht\b/iu.test(title)) return true;
  if (/^\s*(?:ich|wir)\s+suche(?:n)?\b/iu.test(title)) return false;
  if (/^\s*suche\b/iu.test(title)) return false;
  if (/\bgesuch\b|\bwohnungssuche\b/iu.test(title)) return false;
  if (/\b(?:wohnung|mietwohnung|zimmer|zuhause)\b.{0,100}\bgesucht\b/iu.test(title)) return false;
  if (/\b(?:suche|sucht|suchen)\b.{0,100}\b(?:wohnung|mietwohnung|zuhause)\b/iu.test(title)) return false;
  if (/(?:\bwg[- ]?zimmer\b|\bzimmer\s*\(\s*wg\s*\)|\bzimmer\s+(?:in|fuer|für)\b.{0,32}\b(?:\d+er\s*)?wg\b|\bmitbewohner(?:in)?\b|\buntermietzimmer\b)/iu.test(title)) return false;
  return true;
}

function mergeListings(...groups) {
  const seenUrls = new Set();
  const seenImages = new Set();
  const seenFingerprints = new Set();
  const out = [];
  for (const item of groups.flat()) {
    if (!item?.url || !offerLike(item)) continue;
    const url = String(item.url);
    let image = String(item?.imageUrl || '').trim();
    if (image) image = image.replace(/[?#].*$/u, '');
    const fingerprint = [
      normalize(item?.title),
      normalize(item?.location),
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
    out.push(item);
    if (out.length >= MAX_DIRECT_LISTINGS) break;
  }
  return out;
}

async function readBounded(response) {
  if (!response?.ok) return { html:null, reason:'http_error', bytes:0 };
  const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (type && !type.includes('text/html') && !type.includes('application/xhtml+xml') && !type.includes('text/plain')) return { html:null, reason:'unsupported_content_type', bytes:0 };
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) return { html:null, reason:'response_too_large', bytes:0 };
  const reader = response.body?.getReader?.();
  if (!reader) {
    const html = await response.text();
    const bytes = new TextEncoder().encode(html).byteLength;
    return bytes <= MAX_HTML_BYTES ? { html, reason:'read', bytes } : { html:null, reason:'response_too_large', bytes };
  }
  const decoder = new TextDecoder();
  let html = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { html:html + decoder.decode(), reason:'read', bytes };
      bytes += value.byteLength;
      if (bytes > MAX_HTML_BYTES) {
        await reader.cancel().catch(() => {});
        return { html:null, reason:'response_too_large', bytes };
      }
      html += decoder.decode(value, { stream:true });
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function fetchSupplemental(url, criteria, transport) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const started = Date.now();
  let status = 0;
  try {
    const response = await transport(url, { method:'GET', headers:BROWSER_HEADERS, redirect:'follow', signal:controller.signal });
    status = Number(response?.status) || 0;
    if (response?.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== 'https:' || !HOST_RE.test(finalUrl.hostname)) return { listings:[], reason:'rejected_redirect', status, bytes:0, durationMs:Date.now() - started };
    }
    if (status === 403) return { listings:[], reason:'blocked', status, bytes:0, durationMs:Date.now() - started };
    const read = await readBounded(response);
    if (read.html == null) return { listings:[], reason:read.reason, status, bytes:read.bytes, durationMs:Date.now() - started };
    if (/captcha|verify\s+you\s+are\s+human|zugriff\s+verweigert|access\s+denied/iu.test(read.html)) return { listings:[], reason:'challenge', status, bytes:read.bytes, durationMs:Date.now() - started };
    const listings = parseKleinanzeigenPublicPage(read.html, criteria).filter(offerLike);
    const recognized = /class=["'][^"']*\baditem\b|\/s-anzeige\//iu.test(read.html);
    return { listings, reason:listings.length ? 'parsed' : recognized ? 'no_match' : 'unrecognized_html', status, bytes:read.bytes, durationMs:Date.now() - started };
  } catch {
    return { listings:[], reason:controller.signal.aborted ? 'timeout' : 'network_error', status, bytes:0, durationMs:Date.now() - started };
  } finally { clearTimeout(timeout); }
}

// TG-RUNTIME-068: once one page is blocked (403), no further batch is sent:
// the rest would be blocked too and only use up subrequests and time.
async function collectSupplementalPages(criteria, transport, urls, deadline, targetDirectListings = TARGET_DIRECT_LISTINGS, block = { blocked:false }) {
  const pages = [];
  let listings = [];
  for (let offset = 0; offset < urls.length && listings.length < targetDirectListings && Date.now() < deadline && !block.blocked; offset += SUPPLEMENTAL_CONCURRENCY) {
    const batch = urls.slice(offset, offset + SUPPLEMENTAL_CONCURRENCY);
    const remaining = Math.max(1, deadline - Date.now());
    const batchPages = await Promise.race([
      Promise.all(batch.map(url => fetchSupplemental(url, criteria, transport))),
      new Promise(resolve => setTimeout(() => resolve([]), remaining))
    ]);
    if (!batchPages.length) break;
    pages.push(...batchPages);
    if (batchPages.some(page => page.reason === 'blocked')) block.blocked = true;
    listings = mergeListings(listings, batchPages.flatMap(page => page.listings || []));
  }
  return pages;
}

export async function searchKleinanzeigenPublicRecovery(criteria, transport = fetch, options = {}) {
  // The exact city/radius request and supplemental depth run inside one bounded
  // end-to-end budget. Callers may request a shorter fill-only pass without
  // weakening the default statewide recovery depth.
  const requestedBudget = Number(options?.budgetMs);
  const budgetMs = Number.isFinite(requestedBudget)
    ? Math.max(1000, Math.min(SUPPLEMENTAL_BUDGET_MS, Math.round(requestedBudget)))
    : SUPPLEMENTAL_BUDGET_MS;
  const requestedTarget = Number(options?.targetDirectListings);
  const targetDirectListings = Number.isFinite(requestedTarget)
    ? Math.max(1, Math.min(MAX_DIRECT_LISTINGS, Math.round(requestedTarget)))
    : TARGET_DIRECT_LISTINGS;
  const deadline = Date.now() + budgetMs;
  const requestedMaxPages = Number(options?.maxSupplementalPages);
  const maxSupplementalPages = Number.isFinite(requestedMaxPages)
    ? Math.max(0, Math.min(MAX_SUPPLEMENTAL_URLS, Math.floor(requestedMaxPages)))
    : MAX_SUPPLEMENTAL_URLS;
  const candidateSupplementalUrls = supplementalKleinanzeigenUrls(criteria).slice(0, maxSupplementalPages);
  const block = { blocked:false };
  const supplementalPromise = collectSupplementalPages(criteria, transport, candidateSupplementalUrls, deadline, targetDirectListings, block);
  const primary = await searchPrimaryKleinanzeigenRecovery(criteria, transport);
  if (primary?.status === 'blocked') block.blocked = true;
  const primaryListings = mergeListings(primary?.listings || []);
  const pages = await supplementalPromise;

  const primaryUrls = new Set(Array.isArray(primary?.searchUrls) ? primary.searchUrls : []);
  const urls = candidateSupplementalUrls.filter(url => !primaryUrls.has(url));
  const listings = mergeListings(primaryListings, pages.flatMap(page => page.listings || []));
  const supplementalPages = pages.map(page => ({ reason:page.reason, httpStatus:page.status, bytesReceived:page.bytes, durationMs:page.durationMs, matchedCount:page.listings?.length || 0, supplemental:true }));
  const allPages = [...(Array.isArray(primary?.pages) ? primary.pages : []), ...supplementalPages];
  const anyReadable = allPages.some(page => page.reason === 'parsed' || page.reason === 'no_match');
  return {
    ...primary,
    status:listings.length ? 'ok' : anyReadable ? 'ok' : block.blocked ? 'blocked' : primary?.status || 'unavailable',
    listings,
    searchUrls:[...(Array.isArray(primary?.searchUrls) ? primary.searchUrls : []), ...urls],
    pages:allPages,
    expanded:pages.length > 0
  };
}
