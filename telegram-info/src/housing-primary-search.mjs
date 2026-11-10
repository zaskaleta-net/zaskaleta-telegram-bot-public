// Primary radius housing search. Public portals are the main sources and run
// in parallel: Kleinanzeigen public pages, ohne-makler.net and KIP. The paid Kleinanzeigen agent API (KLAZ) runs alongside as an optional
// extra; its failure never fails the result. ImmoScout24 is not fetched
// (Cloudflare egress gets 401) and neither is immowelt.de (403 from Cloudflare
// on staging, 2026-10-12); both stay external search buttons only.
//
// Subrequests per search (provider share is 32): API <= 3, Kleinanzeigen
// public <= 1 + 3 + KLEINANZEIGEN_SUPPLEMENTAL_PAGES, ohne-makler 2, KIP <= 4,
// housing companies <= 6 (MAX_COMPANY_PAGES; only those whose town can be in
// the result),
// Immomio companies <= 3, WG-Gesucht <= 2.
import { pageLog } from './log-safe.mjs';
import { roomSpecFromCriteria, roomValueInSpec } from './rooms.mjs';
import { searchLiveHousing, klazLocationProbe } from './housing-provider-base.mjs';
import { searchKleinanzeigenPublicRecovery } from './housing-kleinanzeigen-public-expanded.mjs';
import { searchOhneMaklerHousing } from './housing-ohne-makler.mjs';
import { searchKipHousing } from './housing-expanded-v22.mjs';
import { filterHousingListingsToJurisdiction } from './housing-jurisdiction-scope.mjs';
import { dedupeListings, listingPortal } from './listing-dedup.mjs';
import { searchHousingCompanies, placeCoordinates, distanceKm as placeDistanceKm } from './housing-company-sources.mjs';
import { searchImmomioHousing } from './housing-immomio.mjs';
import { searchWgGesuchtHousing } from './housing-wg-gesucht.mjs';
import { searchVonoviaHousing } from './housing-vonovia.mjs';

export const KLEINANZEIGEN_SUPPLEMENTAL_PAGES = 6;
const TOWN_SCOPED_SOURCES = new Set(['ohne-makler-public', 'wankendorfer', 'trave', 'wobau-neumuenster', 'gewoba-nord', 'bgs-sachsenwald', 'neue-gewoge', 'wg-gesucht', 'vonovia',
  'fab', 'wbg-kiel-ost', 'luebecker-bauverein', 'neue-luebecker', 'woge-kiel', 'adlershorst', 'big-verwaltung', 'wodi-dithmarschen', 'zbvv', 'hug-kiel']);
const KALT_LIMIT = /^(?:Kalt|Nettokalt)miete$/iu;
const SOURCE_TIMEOUT_MS = 8500;
const API_HEAD_START_MS = 2500;
const ALLOWED_RADII = new Set([5, 10, 15, 20, 25, 50]);
const ANSWERED = new Set(['ok', 'partial']);

const WANTED_TITLE = /\b(?:mietgesuch|wohnungssuche|gesuch)\b|^\s*(?:ich|wir)\s+suche(?:n)?\b|^\s*suche\b|\b(?:familie|paar|ehepaar|student(?:in)?|rentner(?:in)?)\b.{0,40}\bsucht\b|\bsuche[n]?\b.{0,60}\b(?:wohnung|mietwohnung|zimmer|haus|zuhause)\b/iu;
const SEARCHED_TITLE = /\b(?:wohnung|mietwohnung|zimmer|haus|zuhause)\b.{0,80}\bgesucht\b/iu;
const NACHMIETER = /\bnach(?:m(?:ie)?ter)(?:in)?\b.{0,100}\bgesucht\b/iu;
const EXCLUDED_TITLE = /\b(?:tauschwohnung|tauschangebot|wohnungstausch|wohnungsswap|zum\s+tauschen|zwischenmiete|untermiete|untermietzimmer|wg[-\s]?zimmer|mitbewohner(?:in)?|anfragestopp|stellplatz|garage|carport)\b|\bzimmer\s+(?:in|fuer|für)\b.{0,32}\b(?:\d+er\s*)?wg\b/iu;

export function housingOfferTitleAllowed(title) {
  const text = String(title || '').replace(/\s+/gu, ' ').trim();
  if (!text || EXCLUDED_TITLE.test(text)) return false;
  if (NACHMIETER.test(text)) return !/^\s*(?:ich|wir)\s+suche/iu.test(text);
  return !WANTED_TITLE.test(text) && !SEARCHED_TITLE.test(text);
}

function radiusOf(criteria) {
  const value = Number(criteria?.radiusKm);
  return ALLOWED_RADII.has(value) ? value : 15;
}

function titleRooms(title) {
  const match = /(\d{1,2}(?:[.,]\d+)?)\s*[-–]?\s*(?:Zimmer|Zi\.?)(?![a-zäöü])/iu.exec(String(title || ''));
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function normalizedKey(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[̀-ͯ]/gu, '').replace(/ß/gu, 'ss')
    .toLowerCase().replace(/\b\d{5}\b/gu, ' ').replace(/[^a-z0-9]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function settle(promise, label, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(error => ({
      source:label,
      status:'unavailable',
      listings:[],
      pages:[{ reason:'source_exception', error:String(error?.message || error).slice(0, 120), httpStatus:0, bytesReceived:0, durationMs:0 }]
    })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ source:label, status:'timeout', listings:[], pages:[{ reason:'timeout', httpStatus:0, bytesReceived:0, durationMs:timeoutMs }] }), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}


// Fails closed: price, rooms (structured and in the title), measured radius,
// wanted/swap/WG wording and, for Jobcenter searches, the Kreis boundary.
// TG-RUNTIME-061: a listing from a town-scoped source has no measured
// distance; its town's coordinates give one ("22926 Ahrensburg" is 12.6 km
// from Trittau, inside a 15 km search, but was dropped: phone check
// 19.10.2026). Null when either town is unknown.
function townDistanceKm(item, origin) {
  if (!origin) return null;
  const town = String(item?.location || '').split(',').at(-1).replace(/\b\d{5}\b/gu, ' ').replace(/\s+/gu, ' ').trim();
  const point = town ? placeCoordinates(town) : null;
  const distance = point ? placeDistanceKm(origin, point) : null;
  return Number.isFinite(distance) ? distance : null;
}

export function filterPrimaryListings(listings, criteria) {
  const roomSpec = roomSpecFromCriteria(criteria);
  const originPoint = placeCoordinates(criteria?.location);
  const amount = Number(criteria?.amount);
  const radiusKm = Number(criteria?.radiusKm);
  const origin = normalizedKey(criteria?.location);
  const kept = (Array.isArray(listings) ? listings : []).filter(item => {
    // A Kaltmiete limit is compared with the Kaltmiete when the source gives
    // both; any other limit with the full (warm) price.
    const price = Number(KALT_LIMIT.test(String(criteria?.type || '')) && Number.isFinite(item?.coldPrice) ? item.coldPrice : item?.price);
    if (!Number.isFinite(price) || price <= 0 || price > amount) return false;
    if (!housingOfferTitleAllowed(item?.title)) return false;
    const rooms = Number(String(item?.rooms ?? '').replace(',', '.'));
    if (item?.rooms != null && item.rooms !== '' && Number.isFinite(rooms) && !roomValueInSpec(rooms, roomSpec)) return false;
    const titled = titleRooms(item?.title);
    if (Number.isFinite(titled) && !roomValueInSpec(titled, roomSpec)) return false;
    if (Number.isFinite(item?.distanceKm) && Number.isFinite(radiusKm) && item.distanceKm > radiusKm) return false;
    // Sources without a portal-side radius (ohne-makler fill-ins, housing
    // companies in a town without pinned coordinates): without a measured
    // distance only a listing in the requested town itself is kept.
    if (TOWN_SCOPED_SOURCES.has(item?.sourceId) && !Number.isFinite(item?.distanceKm)
        && !` ${normalizedKey(item?.location)} `.includes(` ${origin} `)) {
      const town = Number.isFinite(radiusKm) ? townDistanceKm(item, originPoint) : null;
      if (town === null || town > radiusKm) return false;
    }
    return true;
  });
  const jurisdiction = String(criteria?.districtJurisdiction || criteria?.jobcenterJurisdiction || '').trim();
  return jurisdiction ? filterHousingListingsToJurisdiction(kept, jurisdiction, criteria?.location) : kept;
}

export function mergePrimaryListings(groups) {
  const seenUrls = new Set();
  const seenFingerprints = new Set();
  const merged = [];
  for (const item of groups.flat()) {
    const url = String(item?.url || '').replace(/[?#].*$/u, '');
    if (!url || seenUrls.has(url)) continue;
    const fingerprint = `${normalizedKey(item?.title)}|${Number(item?.price)}`;
    if (normalizedKey(item?.title) && seenFingerprints.has(fingerprint)) continue;
    seenUrls.add(url);
    seenFingerprints.add(fingerprint);
    merged.push(item);
  }
  // The same flat on another portal (different URL and title) counts once.
  return interleaveBySource(dedupeListings(merged).sort((a, b) => {
    const da = Number.isFinite(a?.distanceKm) ? a.distanceKm : Infinity;
    const db = Number.isFinite(b?.distanceKm) ? b.distanceKm : Infinity;
    return (da - db) || (Number(a?.price) - Number(b?.price)) || 0;
  }));
}

// Nearest first, but one portal does not fill a whole page: the sorted list
// is dealt out round-robin across portals, each keeping its own order.
export function interleaveBySource(items) {
  const queues = new Map();
  for (const item of items) {
    const portal = listingPortal(item) || 'other';
    if (!queues.has(portal)) queues.set(portal, []);
    queues.get(portal).push(item);
  }
  const out = [];
  while (out.length < items.length) {
    for (const queue of queues.values()) if (queue.length) out.push(queue.shift());
  }
  return out;
}

function apiSourceEntry(result) {
  const status = result?.status || 'unavailable';
  return {
    source:'Kleinanzeigen API',
    status,
    count:Array.isArray(result?.listings) ? result.listings.length : 0,
    // Skipped after an account failure earlier in this invocation: no
    // request was sent, so the ops report must not count another failure.
    ...(result?.skipped ? { notSent:true } : {}),
    pages:status === 'ok' ? [] : [{ reason:String(result?.skipped || result?.providerError || status).slice(0, 40), httpStatus:0, bytesReceived:0, durationMs:0 }]
  };
}

export async function searchPrimaryHousing(criteria, key, transport = fetch, options = {}) {
  const roomSpec = roomSpecFromCriteria(criteria);
  const amount = Number(criteria?.amount);
  if (!criteria?.location || !roomSpec || !Number.isFinite(amount) || amount < 100 || amount > 50000) return { status:'not_configured', listings:[] };
  const radiusKm = radiusOf(criteria);
  const scoped = { ...criteria, radiusKm };
  const timeoutMs = Number(options.sourceTimeoutMs) > 0 ? Number(options.sourceTimeoutMs) : SOURCE_TIMEOUT_MS;
  const supplementalPages = Number.isFinite(Number(options.kleinanzeigenSupplementalPages))
    ? Math.max(0, Math.floor(Number(options.kleinanzeigenSupplementalPages)))
    : KLEINANZEIGEN_SUPPLEMENTAL_PAGES;

  const apiTask = options.includeApi === false
    ? Promise.resolve({ status:'skipped', listings:[] })
    : settle(searchLiveHousing(scoped, key, transport, { includePublic:false }), 'Kleinanzeigen API', timeoutMs);
  // Let the API issue its /search calls before the public pages start, so a
  // tight provider budget cannot starve the cheap API answer. After a known
  // account failure (402 credits) the API is skipped and nothing is waited on.
  const probe = klazLocationProbe(transport);
  if (probe) {
    let timer;
    await Promise.race([
      Promise.resolve(probe).catch(() => null).then(() => new Promise(resolve => setTimeout(resolve, 0))),
      new Promise(resolve => { timer = setTimeout(resolve, API_HEAD_START_MS); })
    ]);
    clearTimeout(timer);
  }
  const [api, kleinanzeigen, ohneMakler, kip, companies, immomio, wgGesucht, vonovia] = await Promise.all([
    apiTask,
    settle(searchKleinanzeigenPublicRecovery(scoped, transport, { budgetMs:4500, targetDirectListings:12, maxSupplementalPages:supplementalPages }), 'Kleinanzeigen public', timeoutMs),
    settle(searchOhneMaklerHousing(scoped, transport), 'Ohne-Makler', timeoutMs),
    settle(searchKipHousing(scoped, transport), 'KIP Schleswig-Holstein', timeoutMs),
    settle(searchHousingCompanies(scoped, transport), 'Housing companies', timeoutMs),
    settle(searchImmomioHousing(scoped, transport), 'Immomio', timeoutMs),
    settle(searchWgGesuchtHousing(scoped, transport), 'WG-Gesucht', timeoutMs),
    settle(searchVonoviaHousing(scoped, transport), 'Vonovia', timeoutMs)
  ]);

  const publicResults = [
    ['Kleinanzeigen public', kleinanzeigen],
    ['Ohne-Makler', ohneMakler],
    ['KIP Schleswig-Holstein', kip],
    ['Housing companies', companies],
    ['Immomio', immomio],
    ['WG-Gesucht', wgGesucht],
    ['Vonovia', vonovia]
  ];
  const sources = [
    apiSourceEntry(api),
    ...publicResults.map(([label, result]) => ({
      source:label,
      status:result?.status || 'unavailable',
      count:Array.isArray(result?.listings) ? result.listings.length : 0,
      pages:pageLog(result?.pages)
    }))
  ];

  const merged = mergePrimaryListings([
    api?.status === 'ok' && Array.isArray(api.listings) ? api.listings : [],
    ...publicResults.map(([, result]) => Array.isArray(result?.listings) ? result.listings : [])
  ]);
  const listings = filterPrimaryListings(merged, scoped).slice(0, 200);
  sources.push({ source:'primary-merge', status:'ok', count:listings.length, pages:[] });
  // Fixed source labels, statuses, HTTP codes, sizes and counts only.
  console.info('housing_search_sources', JSON.stringify(sources));

  const answered = api?.status === 'ok' || publicResults.some(([, result]) => ANSWERED.has(result?.status));
  const snapshot = {
    location:criteria.location,
    rooms:roomSpec.label,
    amount:criteria.amount,
    type:criteria.type,
    radiusKm,
    ...(criteria?.districtJurisdiction ? { districtJurisdiction:criteria.districtJurisdiction } : {})
  };
  return {
    // The provider's own account wording (credits, keys) never reaches users:
    // without any answering source the search is simply unavailable.
    status:answered ? 'ok' : 'unavailable',
    listings,
    source:'primary_sources',
    resolvedLocation:criteria.location,
    radiusKm,
    criteria:snapshot,
    sources,
    searchUrls:publicResults.flatMap(([, result]) => Array.isArray(result?.searchUrls) ? result.searchUrls : []).slice(0, 8)
  };
}
