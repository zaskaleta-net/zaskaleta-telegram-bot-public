import { readBoundedJSON } from './pilot-security.mjs';
import { parseRoomSpec, roomSpecFromCriteria, roomValueInSpec, roomsWord } from './rooms.mjs';
import { searchPublicHousingSources } from './housing-public-sources.mjs';
import { formatEuro, formatArea, formatDistance, priceTypeLabel } from './listing-format.mjs';
import { filterHousingListingsToJurisdiction } from './housing-jurisdiction-scope.mjs';
// Shown next to the price only when the source names the rent type exactly.
const KNOWN_PRICE_TYPE = /^(?:Warm|Kalt|Nettokalt|Bruttokalt|Gesamt)miete$/u;

const API_ROOT = 'https://api.kleinanzeigen-agent.de/api/v2/kleinanzeigen';
const KEY = /^klaz_live_[A-Za-z0-9_-]{8,256}$/;
// Landlords decorate titles with Markdown ("**1 NKM FREI**"); Telegram
// captions are HTML, so the asterisks would show literally.
export function listingTitle(item, limit = 140) {
  return String(item?.title || '').replace(/\*{2,}|_{2,}|~{2,}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}
export function klazKeyConfigured(key) { return KEY.test(String(key || '')); }
// The Kleinanzeigen API is switched off by the owner (17.10.2026: the account
// kept failing; the public Kleinanzeigen pages answer). KLAZ_API_ENABLED
// "false" makes every search run without the key, so no API request is made
// and the key itself stays untouched in the environment.
export function klazApiKey(env) { return env?.KLAZ_API_ENABLED === 'false' ? '' : (env?.KLAZ_API_KEY || ''); }
const SAFE_URL = /^https:\/\/(?:www\.)?kleinanzeigen\.de\//i;
const SAFE_PUBLIC_URL = /^https:\/\/(?:www\.)?(?:immobilienscout24\.de|immowelt\.de|ohne-makler\.net|kip\.net|wankendorfer\.de|wobau-neumuenster\.de|fab\.sh|wbg-kiel-ost\.de|luebecker-bauverein\.de|wobau-oh\.de|wo-di\.de|trave\.de|wogekiel\.de|neueluebecker\.de|adlershorst\.de|big-verwaltung\.de|zbvv\.de|hausundgrund\.de|wg-gesucht\.de|vonovia\.de|tenant\.immomio\.com)\//i;
const WANTED = /(?:^|\b)(?:mietgesuch|wohnungssuche)\b|^\s*(?:ich|wir)\s+suche(?:n)?\b|\b(?:familie|paar|ehepaar)\s+sucht\b|\bsucht\s+(?:eine\s+)?\d{1,2}(?:[.,]\d+)?(?:\s*[-–]\s*\d{1,2}(?:[.,]\d+)?)?\s*zimmer\b|\b\d{1,2}(?:[.,]\d+)?(?:\s*[-–]\s*\d{1,2}(?:[.,]\d+)?)?\s*zimmer\s+gesucht\b|\b(?:wohnung|mietwohnung|haus)\s+gesucht\b/i;
const EXCLUDED = /\b(?:tauschwohnung|wohnungstausch|wohnungsswap|zum\s+tauschen|zwischenmiete|untermiete|wg[-\s]?zimmer|anfragestopp)\b|\bzimmer\s+(?:in|fuer|für)\b.{0,32}\b(?:\d+er\s*)?wg\b/i;
const RELIABLE_PRICE_TYPES = new Set(['SPECIFIED_AMOUNT', 'FIXED']);
const PROVIDER_JSON_MAX_BYTES = 524288;
const DEFAULT_SEARCH_RADIUS_KM = 15;
const ALLOWED_SEARCH_RADII = new Set([5, 10, 15, 25, 50]);

export const HOUSING_SEARCH_SOURCES = Object.freeze([
  Object.freeze({ id:'kleinanzeigen', label:'Kleinanzeigen', mode:'live_api', url:'https://www.kleinanzeigen.de/' }),
  Object.freeze({ id:'immoscout24', label:'ImmoScout24', mode:'external_search', url:'https://www.immobilienscout24.de/' }),
  Object.freeze({ id:'immowelt', label:'Immowelt', mode:'external_search', url:'https://www.immowelt.de/' }),
  Object.freeze({ id:'wankendorfer', label:'Wankendorfer', mode:'public_live', url:'https://www.wankendorfer.de/wohnungssuche/' }),
  Object.freeze({ id:'neue-luebecker', label:'NEUE LÜBECKER', mode:'public_search', url:'https://www.neueluebecker.de/mieten/immobilienangebote/' }),
  Object.freeze({ id:'fab', label:'FAB Flensburg', mode:'public_live', url:'https://www.fab.sh/main/aktuelle-wohnungsangebote/' }),
  Object.freeze({ id:'immomio', label:'Immomio', mode:'profile_matching', url:'https://www.immomio.com/mieter/' }),
  Object.freeze({ id:'wg-gesucht', label:'WG-Gesucht', mode:'external_search', url:'https://www.wg-gesucht.de/' }),
  Object.freeze({ id:'ohne-makler', label:'Ohne-Makler', mode:'external_search', url:'https://www.ohne-makler.net/' }),
  Object.freeze({ id:'woge-kiel', label:'WOGE Kiel', mode:'public_search', url:'https://www.wogekiel.de/mietangebote' }),
  Object.freeze({ id:'wobau-neumuenster', label:'WOBAU Neumünster', mode:'public_live', url:'https://www.wobau-neumuenster.de/mieten/mietangebote' }),
  Object.freeze({ id:'semmelhaack', label:'SEMMELHAACK', mode:'public_search', url:'https://semmelhaack.de/mietangebote/' }),
  Object.freeze({ id:'kip-sh', label:'KIP Schleswig-Holstein', mode:'external_search', url:'https://www.kip.net/schleswig-holstein/' }),
  Object.freeze({ id:'bgh-kiel', label:'BG Kiel-Hassee', mode:'interest_profile', url:'https://bgh-kiel.de/' }),
  Object.freeze({ id:'wbg-kiel-ost', label:'WBG Kiel-Ost', mode:'public_live', url:'https://www.wbg-kiel-ost.de/mieten/objekte/mietwohnungen.html' }),
  Object.freeze({ id:'luebecker-bauverein', label:'Lübecker Bauverein', mode:'public_live', url:'https://www.luebecker-bauverein.de/angebotsfinder.html' }),
  Object.freeze({ id:'bgm', label:'Baugenossenschaft Mittelholstein', mode:'interest_profile', url:'https://bgm-wohnen.de/wohnen/vermietung/' }),
  Object.freeze({ id:'gewoba-nord', label:'GEWOBA Nord', mode:'profile_matching', url:'https://www.gewoba-nord.de/wohne-mit-uns/wohnungssuche/' }),
  Object.freeze({ id:'sbv-flensburg', label:'SBV Flensburg', mode:'profile_matching', url:'https://www.sbv-flensburg.de/fuer-wohnungssuchende/immobiliensuche/aktuelle-angebote' }),
  Object.freeze({ id:'trave-luebeck', label:'TRAVE Lübeck', mode:'public_live', url:'https://www.trave.de/interessenten/wohnung-mieten' }),
  Object.freeze({ id:'wobau-ostholstein', label:'WOBAU Ostholstein', mode:'public_live', url:'https://www.wobau-oh.de/wohnung-mieten-ostholstein.php' }),
  Object.freeze({ id:'wodi-dithmarschen', label:'Wohnungsunternehmen Dithmarschen', mode:'public_live', url:'https://www.wo-di.de/wohnen.html' }),
  Object.freeze({ id:'gkb-pinneberg', label:'GKB Pinneberg', mode:'public_search', url:'https://www.gkb-pinneberg.de/mietangebote/' }),
  Object.freeze({ id:'neue-gewoge', label:'Neue GeWoGe Pinneberg', mode:'profile_matching', url:'https://www.neue-gewoge.de/wohnen-und-leben/wohnung-finden/' })
]);

function housingRadius(criteria) {
  const value = Number(criteria?.radiusKm);
  return ALLOWED_SEARCH_RADII.has(value) ? value : DEFAULT_SEARCH_RADIUS_KM;
}

export function parseHousingSearchAction(text) {
  const match = /^🔎\s+(.{2,80}?)\s+·\s+(\d{1,2}(?:-\d{1,2})?)\s+·\s+(\d{2,5}(?:[.,]\d{1,2})?)\s+·\s+([WK])(?:\s+·\s+(5|10|15|25|50)\s*km)?$/iu.exec(String(text || '').trim());
  if (!match) return null;
  const location = match[1].replace(/\s+/g, ' ').trim();
  const roomSpec = parseRoomSpec(match[2]);
  const amount = Number(match[3].replace(',', '.'));
  const type = match[4] === 'W' ? 'Warmmiete' : 'Kaltmiete';
  if (!/^[\p{L}\p{M}.'’ -]{2,80}$/u.test(location) || !roomSpec || !Number.isFinite(amount) || amount < 100 || amount > 50000) return null;
  const roomFields = roomSpec.min === roomSpec.max ? { rooms: roomSpec.min } : { rooms: roomSpec.label, roomsMin: roomSpec.min, roomsMax: roomSpec.max };
  const radiusKm = match[5] ? Number(match[5]) : null;
  return { location, ...roomFields, amount: Math.round(amount * 100) / 100, type, ...(radiusKm ? { radiusKm } : {}) };
}

export function housingSearchAction(criteria) {
  if (!criteria) return null;
  const location = String(criteria.location || '').replace(/[·\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
  const roomSpec = roomSpecFromCriteria(criteria);
  const amount = Number(criteria.amount);
  const type = criteria.type === 'Warmmiete' ? 'W' : criteria.type === 'Kaltmiete' ? 'K' : null;
  if (!/^[\p{L}\p{M}.'’ -]{2,80}$/u.test(location) || !roomSpec || !Number.isFinite(amount) || amount < 100 || amount > 50000 || !type) return null;
  const shown = Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace('.', ',');
  const radiusKm = Number(criteria.radiusKm);
  const suffix = ALLOWED_SEARCH_RADII.has(radiusKm) ? ` · ${radiusKm}km` : '';
  return `🔎 ${location} · ${roomSpec.label} · ${shown} · ${type}${suffix}`;
}

function normalizeLocations(data) {
  const candidates = data?.data?.locations ?? data?.data ?? data?.locations ?? [];
  return Array.isArray(candidates) ? candidates : [];
}

function providerLocationKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ß/gu, 'ss')
    .toLowerCase()
    .replace(/\s*\(\s*schleswig[- ]holstein\s*\)\s*$/iu, '')
    .replace(/,\s*schleswig[- ]holstein\s*$/iu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function chooseLocation(items, requested) {
  const target = providerLocationKey(requested);
  const valid = items.filter(item => item && /^[0-9]+$/.test(String(item.id ?? item.location_id ?? '')));
  return valid.find(item => [item.name, item.city, item.display_name].some(value => providerLocationKey(value) === target)) || null;
}

function coordinates(value) {
  const latitude = Number(value?.latitude ?? value?.lat);
  const longitude = Number(value?.longitude ?? value?.lng ?? value?.lon);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function distanceKmBetween(a, b) {
  const from = coordinates(a), to = coordinates(b);
  if (!from || !to) return null;
  const rad = value => value * Math.PI / 180;
  const dLat = rad(to.latitude - from.latitude);
  const dLon = rad(to.longitude - from.longitude);
  const lat1 = rad(from.latitude), lat2 = rad(to.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function withinSearchRadius(ad, origin, radiusKm) {
  const from = coordinates(origin);
  const to = coordinates(ad?.location);
  // The provider request already includes location_id + distance. Keep our local
  // Haversine guard whenever both coordinate pairs are present, but do not discard
  // an otherwise valid provider-scoped listing merely because an ad omits coordinates.
  if (!from || !to) return true;
  const distance = distanceKmBetween(from, to);
  return Number.isFinite(distance) && distance <= radiusKm;
}

function publicTextOfAd(ad) { return `${ad?.title || ''} ${ad?.description || ''}`.replace(/\s+/g, ' ').trim(); }

function roomCandidates(ad) {
  const values = [];
  const add = value => { if (value == null) return; const normalized = String(value).trim().replace(',', '.'); if (/^\d{1,2}(?:\.\d+)?$/.test(normalized)) values.push(normalized); };
  if (ad?.details && typeof ad.details === 'object' && !Array.isArray(ad.details)) for (const [name, value] of Object.entries(ad.details)) if (String(name).toLocaleLowerCase('de-DE') === 'zimmer') add(value);
  for (const attribute of Array.isArray(ad?.attributes) ? ad.attributes : []) {
    const name = String(attribute?.name || '').toLocaleLowerCase('de-DE');
    const label = String(attribute?.label || '').toLocaleLowerCase('de-DE');
    if (name !== 'wohnung_mieten.zimmer' && label !== 'zimmer') continue;
    for (const value of Array.isArray(attribute?.values) ? attribute.values : []) add(value?.value ?? value?.label);
  }
  const text = publicTextOfAd(ad).replace(/,/g, '.');
  const pattern = /(\d{1,2}(?:\.\d+)?)\s*[-–]?\s*(?:Zimmer|Zi\.?|кімнат)/giu;
  for (const match of text.matchAll(pattern)) add(match[1]);
  return [...new Set(values)];
}

function adMatchesRoomSpec(ad, roomSpec) { return roomCandidates(ad).some(value => roomValueInSpec(value, roomSpec)); }

function firstHttpsString(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') { const url = value.trim(); return /^https:\/\//i.test(url) && url.length <= 2048 ? url : null; }
  if (Array.isArray(value)) { for (const item of value) { const found = firstHttpsString(item, depth + 1); if (found) return found; } return null; }
  if (typeof value === 'object') {
    const preferred = ['thumbnail_url', 'thumbnail', 'medium', 'url', 'image_url', 'src', 'large', 'original'];
    for (const key of preferred) { if (!(key in value)) continue; const found = firstHttpsString(value[key], depth + 1); if (found) return found; }
    for (const item of Object.values(value)) { const found = firstHttpsString(item, depth + 1); if (found) return found; }
  }
  return null;
}

function imageUrlOfAd(ad) { return firstHttpsString(Array.isArray(ad?.images) ? ad.images : []); }

function areaSqmOfAd(ad) {
  const candidates = [];
  const add = value => { const match = String(value ?? '').replace(',', '.').match(/\d{1,4}(?:\.\d{1,2})?/); if (!match) return; const number = Number(match[0]); if (Number.isFinite(number) && number >= 10 && number <= 1000) candidates.push(number); };
  if (ad?.details && typeof ad.details === 'object' && !Array.isArray(ad.details)) for (const [name, value] of Object.entries(ad.details)) if (/wohnfl[aä]che|wohnflaeche|fl[aä]che/i.test(String(name))) add(value);
  for (const attribute of Array.isArray(ad?.attributes) ? ad.attributes : []) { const name = `${attribute?.name || ''} ${attribute?.label || ''}`; if (!/wohnfl[aä]che|wohnflaeche/i.test(name)) continue; for (const value of Array.isArray(attribute?.values) ? attribute.values : []) add(value?.value ?? value?.label); }
  return candidates[0] ?? null;
}

function roomLabelOfAd(ad) { const value = roomCandidates(ad)[0]; return value ? String(value).replace('.', ',') : null; }
function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function looksLikeOffer(ad, criteria) {
  if (!ad || ad.deleted === true || (ad.status && ad.status !== 'ACTIVE')) return false;
  const title = String(ad.title || '').trim(); if (!title) return false;
  const publicText = publicTextOfAd(ad); if (WANTED.test(publicText) || EXCLUDED.test(publicText)) return false;
  const url = String(ad.ad_url || ''); if (!SAFE_URL.test(url)) return false;
  const price = Number(ad?.price?.amount); if (!Number.isFinite(price) || price <= 0 || price > criteria.amount) return false;
  const priceType = String(ad?.price?.price_type || '').trim(); if (priceType && !RELIABLE_PRICE_TYPES.has(priceType)) return false;
  const roomSpec = roomSpecFromCriteria(criteria); if (!roomSpec) return false;
  if (!adMatchesRoomSpec(ad, roomSpec)) return false;
  return true;
}

function failureStatus(httpStatus, errorCode) {
  if (httpStatus === 401 || errorCode === 'API_KEY_MISSING' || errorCode === 'API_KEY_INVALID') return 'auth_error';
  if (httpStatus === 402 || errorCode === 'INSUFFICIENT_CREDITS') return 'insufficient_credits';
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus === 400) return 'bad_request';
  if (httpStatus === 500 || httpStatus === 502 || httpStatus === 504) return 'upstream_unavailable';
  return 'unavailable';
}

// Fixed endpoint name, status and HTTP code only: never the key or the query.
async function api(path, key, transport) {
  const result = await apiRequest(path, key, transport);
  if (!result.ok) {
    console.info('housing_primary_provider', {
      endpoint:String(path).split('?')[0],
      status:result.status,
      httpStatus:Number(result.httpStatus) || 0,
      errorCode:typeof result.errorCode === 'string' ? result.errorCode.slice(0, 60) : null
    });
  }
  return result;
}

async function apiRequest(path, key, transport) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await transport(API_ROOT + path, { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${key}`, klaz_key: key }, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) return { ok: false, status: 'unavailable', httpStatus: response.status, errorCode: 'UNEXPECTED_REDIRECT' };
    const parsed = await readBoundedJSON(response, PROVIDER_JSON_MAX_BYTES);
    if (parsed.error) return { ok: false, status: 'unavailable', httpStatus: response.status, errorCode: parsed.error };
    if (response.ok && parsed.value?.success === true) return { ok: true, data: parsed.value };
    return { ok: false, status: failureStatus(response.status, parsed.value?.error_code), httpStatus: response.status, errorCode: typeof parsed.value?.error_code === 'string' ? parsed.value.error_code : null, requestId: typeof parsed.value?.request_id === 'string' ? parsed.value.request_id : null };
  } catch { return { ok: false, status: 'unavailable', httpStatus: 0, errorCode: 'NETWORK_OR_TIMEOUT' }; }
  finally { clearTimeout(timeout); }
}

function externalSourceEntries(criteria) {
  const roomSpec = roomSpecFromCriteria(criteria); const roomLabel = roomSpec?.label || String(criteria?.rooms || ''); const radiusKm = housingRadius(criteria);
  const base = `${criteria?.location || ''} ${roomLabel} Zimmer Wohnung mieten bis ${criteria?.amount || ''} EUR ${criteria?.type || ''} Umkreis ${radiusKm} km`;
  const google = query => `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  return [
    ['ImmoScout24', google('site:immobilienscout24.de/Suche ' + base)], ['Immowelt', google('site:immowelt.de/suche ' + base)],
    ['Wankendorfer', 'https://www.wankendorfer.de/wohnungssuche/'], ['NEUE LÜBECKER', 'https://www.neueluebecker.de/mieten/immobilienangebote/'],
    ['FAB Flensburg', 'https://www.fab.sh/main/aktuelle-wohnungsangebote/'], ['Immomio', 'https://www.immomio.com/mieter/'],
    ['WG-Gesucht', google('site:wg-gesucht.de wohnung ' + base)], ['Ohne-Makler', google('site:ohne-makler.net wohnung mieten ' + base)],
    ['WOGE Kiel', 'https://www.wogekiel.de/mietangebote'], ['WOBAU Neumünster', 'https://www.wobau-neumuenster.de/mieten/mietangebote'],
    ['SEMMELHAACK', 'https://semmelhaack.de/mietangebote/'], ['KIP Schleswig-Holstein', google('site:kip.net/schleswig-holstein mieten wohnungen ' + base)],
    ['BG Kiel-Hassee', 'https://bgh-kiel.de/'], ['WBG Kiel-Ost', 'https://www.wbg-kiel-ost.de/mieten/objekte/mietwohnungen.html'],
    ['Lübecker Bauverein', 'https://www.luebecker-bauverein.de/angebotsfinder.html'], ['Baugenossenschaft Mittelholstein', 'https://bgm-wohnen.de/wohnen/vermietung/'],
    ['GEWOBA Nord', 'https://www.gewoba-nord.de/wohne-mit-uns/wohnungssuche/'], ['SBV Flensburg', 'https://www.sbv-flensburg.de/fuer-wohnungssuchende/immobiliensuche/aktuelle-angebote'],
    ['TRAVE Lübeck', 'https://www.trave.de/interessenten/wohnung-mieten'], ['WOBAU Ostholstein', 'https://www.wobau-oh.de/wohnung-mieten-ostholstein.php'],
    ['Wohnungsunternehmen Dithmarschen', 'https://www.wo-di.de/wohnen.html'], ['GKB Pinneberg', 'https://www.gkb-pinneberg.de/mietangebote/'],
    ['Neue GeWoGe Pinneberg', 'https://www.neue-gewoge.de/wohnen-und-leben/wohnung-finden/']
  ];
}

function pairButtons(entries) { const rows = []; for (let i = 0; i < entries.length; i += 2) rows.push(entries.slice(i, i + 2).map(([name, url]) => ({ text: `↗ ${name}`, url }))); return rows; }

function multiSourceSearchUrl(criteria) {
  const roomSpec = roomSpecFromCriteria(criteria); const roomLabel = roomSpec?.label || String(criteria?.rooms || ''); const radiusKm = housingRadius(criteria);
  const base = `${criteria?.location || ''} ${roomLabel} Zimmer Wohnung mieten bis ${criteria?.amount || ''} EUR ${criteria?.type || ''} Umkreis ${radiusKm} km`;
  const domains = HOUSING_SEARCH_SOURCES.filter(source => source.id !== 'kleinanzeigen').map(source => `site:${new URL(source.url).hostname.replace(/^www\./, '')}`).join(' OR ');
  return `https://www.google.com/search?q=${encodeURIComponent(`${base} (${domains})`)}`;
}

function criteriaSnapshot(criteria, roomSpec, radiusKm) { return { location: criteria.location, rooms: roomSpec.label, amount: criteria.amount, type: criteria.type, radiusKm }; }
function safeHousingUrl(value) { const url = String(value || ''); return SAFE_URL.test(url) || SAFE_PUBLIC_URL.test(url); }

// Account-level API failures (no credits, rejected key, rate limit) hold for
// the rest of the invocation. Searches sharing one transport (whole-Kreis
// anchors, repeated phases) wait for the first /locations answer and then
// skip the API instead of spending a subrequest on a known failure.
const ACCOUNT_FAILURES = new Set(['insufficient_credits', 'auth_error', 'rate_limited']);
const apiGates = new WeakMap();

function apiGate(transport) {
  if (!transport || (typeof transport !== 'function' && typeof transport !== 'object')) return { blocked:null, probe:null };
  let gate = apiGates.get(transport);
  if (!gate) { gate = { blocked:null, probe:null }; apiGates.set(transport, gate); }
  return gate;
}

// The pending or finished first /locations request on this transport, if any.
export function klazLocationProbe(transport) {
  return (transport && apiGates.get(transport)?.probe) || null;
}

function blockOnAccountFailure(gate, response) {
  if (!response?.ok && ACCOUNT_FAILURES.has(response?.status) && !gate.blocked) {
    gate.blocked = { status:response.status, providerError:response.errorCode || null, requestId:response.requestId || null };
  }
}

export async function searchLiveHousing(criteria, key, transport = fetch, options = {}) {
  const roomSpec = roomSpecFromCriteria(criteria); const radiusKm = housingRadius(criteria);
  if (!criteria || !roomSpec || !KEY.test(String(key || ''))) return { status: 'not_configured', listings: [] };
  const gate = apiGate(transport);
  if (gate.probe) await gate.probe.catch(() => null);
  if (gate.blocked) return { status: gate.blocked.status, listings: [], providerError: gate.blocked.providerError, requestId: gate.blocked.requestId, skipped: 'account_failure_seen' };
  const locationRequest = api('/locations?q=' + encodeURIComponent(criteria.location) + '&limit=5', key, transport);
  if (!gate.probe) gate.probe = locationRequest;
  const locationResponse = await locationRequest;
  blockOnAccountFailure(gate, locationResponse);
  if (!locationResponse.ok) return { status: locationResponse.status, listings: [], providerError: locationResponse.errorCode, requestId: locationResponse.requestId || null };
  const location = chooseLocation(normalizeLocations(locationResponse.data), criteria.location); if (!location) return { status: 'location_not_found', listings: [] };
  const locationId = String(location.id ?? location.location_id);
  // max_price in whole euros, rounded up (TG-RUNTIME-051); looksLikeOffer drops
  // anything above the exact limit.
  const searchCategory = async categoryId => {
    const params = new URLSearchParams({ category_id: categoryId, location_id: locationId, distance: String(radiusKm), max_price: String(Math.ceil(criteria.amount)), picture_required: 'false', page: '0', size: '100' });
    return api('/search?' + params.toString(), key, transport);
  };
  // Search both rental apartments (203) and rental houses (205). Results are
  // merged and deduplicated below; the same room/price/radius safety filters
  // apply to both property types.
  const [apartmentResponse, houseResponse] = await Promise.all([searchCategory('203'), searchCategory('205')]);
  blockOnAccountFailure(gate, apartmentResponse);
  blockOnAccountFailure(gate, houseResponse);
  const usableResponses = [apartmentResponse, houseResponse].filter(response => response?.ok);
  if (!usableResponses.length) {
    const failed = apartmentResponse || houseResponse;
    return { status: failed?.status || 'unavailable', listings: [], providerError: failed?.errorCode || null, requestId: failed?.requestId || null };
  }
  const ads = usableResponses.flatMap(response => Array.isArray(response.data?.data?.ads) ? response.data.data.ads : []);
  const seenAds = new Set();
  const uniqueAds = ads.filter(ad => {
    const key = String(ad?.ad_id || ad?.ad_url || '');
    if (!key || seenAds.has(key)) return false;
    seenAds.add(key);
    return true;
  });
  const providerListings = uniqueAds.filter(ad => looksLikeOffer(ad, { ...criteria, rooms: roomSpec.label, roomsMin: roomSpec.min, roomsMax: roomSpec.max })).filter(ad => withinSearchRadius(ad, location, radiusKm)).map(ad => ({
    id: String(ad.ad_id || ''), source: 'Kleinanzeigen', sourceId: 'kleinanzeigen', title: String(ad.title || '').replace(/\s+/g, ' ').trim().slice(0, 140), price: Number(ad.price.amount),
    location: String(ad?.location?.name || ad?.location?.city || criteria.location).replace(/\s+/g, ' ').trim().slice(0, 100), distanceKm: distanceKmBetween(location, ad?.location), rooms: roomLabelOfAd(ad), areaSqm: areaSqmOfAd(ad), createdAt: typeof ad?.created_at === 'string' ? ad.created_at : null, imageUrl: imageUrlOfAd(ad), url: String(ad.ad_url)
  })).sort((a, b) => (Number.isFinite(a.distanceKm) ? a.distanceKm : Infinity) - (Number.isFinite(b.distanceKm) ? b.distanceKm : Infinity));
  const jobcenterScope = String(criteria?.districtJurisdiction || criteria?.jobcenterJurisdiction || '').trim();
  const listings = jobcenterScope
    ? filterHousingListingsToJurisdiction(providerListings, jobcenterScope, criteria.location).slice(0, 200)
    : providerListings.slice(0, 200);
  const snapshot = { ...criteriaSnapshot(criteria, roomSpec, radiusKm), ...(criteria?.districtJurisdiction ? { districtJurisdiction:criteria.districtJurisdiction } : {}) };
  if (listings.length) return { status: 'ok', listings, source: 'Kleinanzeigen', resolvedLocation: String(location.name || location.city || criteria.location), radiusKm, criteria: snapshot };
  const includePublic = options.includePublic ?? transport === fetch;
  if (includePublic) {
    const publicResult = await searchPublicHousingSources(criteria, transport);
    const publicListings = jobcenterScope
      ? filterHousingListingsToJurisdiction(publicResult?.listings, jobcenterScope, criteria.location)
      : (Array.isArray(publicResult?.listings) ? publicResult.listings : []);
    if (publicResult.status === 'ok' && publicListings.length) return { status: 'ok', listings: publicListings.slice(0, 200), source: 'public_sources', resolvedLocation: String(location.name || location.city || criteria.location), radiusKm, criteria: snapshot, publicSources: publicResult.sources };
  }
  return { status: 'ok', listings: [], source: 'Kleinanzeigen', resolvedLocation: String(location.name || location.city || criteria.location), radiusKm, criteria: snapshot };
}

// A euro amount always shows its cents (943,80 €), as on listing cards.
function shownAmount(value) {
  return formatEuro(value);
}

export function formatHousingListings(criteria, result) {
  const roomSpec = roomSpecFromCriteria(criteria); const roomLabel = roomSpec?.label || String(criteria?.rooms || '');
  if (result?.status === 'not_configured') return 'Живий пошук оголошень підготовлено, але провайдер ще не підключено. Поки що використайте кнопки пошуку по зовнішніх джерелах.';
  if (result?.status === 'location_not_found') return `Не вдалося однозначно знайти локацію ${criteria.location} у провайдера. Спробуйте назву міста або поштовий індекс.`;
  if (result?.status === 'auth_error') return 'Провайдер не прийняв API-авторизацію. Ключ не показується; інтеграцію потрібно повторно синхронізувати.';
  if (result?.status === 'insufficient_credits') return 'У провайдера недостатньо credits для live-пошуку. Поповніть або дочекайтеся доступного безкоштовного ліміту.';
  if (result?.status === 'rate_limited') return 'Провайдер тимчасово обмежив частоту live-запитів. Спробуйте один раз пізніше; повторні натискання зараз не потрібні.';
  if (result?.status === 'bad_request') return 'Провайдер відхилив параметри пошуку. Я зберіг критерії; використайте зовнішні кнопки, поки інтеграція уточнюється.';
  if (result?.status === 'upstream_unavailable') return 'Kleinanzeigen тимчасово не відповідає провайдеру. Критерії збережені; спробуйте пізніше або відкрийте зовнішній пошук.';
  if (result?.status !== 'ok') return 'Сервіс актуальних оголошень тимчасово недоступний. Спробуйте ще раз пізніше або відкрийте зовнішній пошук.';
  if (!result.listings.length) return `За фільтром ${criteria.location}, ${roomLabel} ${roomsWord(roomLabel)}, до ${shownAmount(criteria.amount)} € зараз не знайдено надійно відфільтрованих пропозицій. Розширте бюджет/радіус або перевірте зовнішній пошук.`;
  if (result.source === 'public_sources') {
    const lines = [`Kleinanzeigen не дав придатних результатів. Знайдено пропозиції у відкритих житлових джерелах — ${criteria.location}, ${roomLabel} ${roomsWord(roomLabel)}, до ${shownAmount(criteria.amount)} €:`];
    result.listings.forEach((item, index) => { const priceType = item.priceType ? ` · ${priceTypeLabel(item.priceType)}` : ''; const area = Number.isFinite(item.areaSqm) ? ` · ${formatArea(item.areaSqm)} м²` : ''; lines.push(`\n${index + 1}. ${item.title}\n${formatEuro(item.price)} €${priceType} · ${item.location}${area}\nДжерело: ${item.source}`); });
    lines.push('\nДані взято з відкритих сторінок житлових організацій. Перед зверненням перевірте актуальність оголошення та склад орендної плати на сторінці джерела.'); return lines.join('\n').slice(0, 4096);
  }
  const lines = [`Знайдено актуальні пропозиції — ${criteria.location}, ${roomLabel} ${roomsWord(roomLabel)}, до ${shownAmount(criteria.amount)} €:`];
  const mixed = result.listings.some(item => item?.source && item.source !== 'Kleinanzeigen');
  result.listings.forEach((item, index) => { const distance = Number.isFinite(item.distanceKm) ? ` · ≈${formatDistance(item.distanceKm)} км` : ''; const source = mixed && item?.source ? ` · ${String(item.source).slice(0, 40)}` : ''; lines.push(`\n${index + 1}. ${item.title}\n${shownAmount(item.price)} € · ${item.location}${distance}${source}`); });
  lines.push(mixed
    ? `\nЦіна — значення, вказане в самому оголошенні. Портали не завжди структуровано позначають Kaltmiete/Warmmiete, тому ${criteria.type} та Nebenkosten перевіряйте в тексті оголошення перед контактом.`
    : `\nЦіна — значення, вказане в самому оголошенні. Kleinanzeigen не завжди структуровано позначає Kaltmiete/Warmmiete, тому ${criteria.type} та Nebenkosten перевіряйте в тексті оголошення перед контактом.`); return lines.join('\n').slice(0, 4096);
}

export function housingListingMedia(result) {
  const listings = Array.isArray(result?.listings) ? result.listings : [];
  const extraSearch = result?.criteria ? multiSourceSearchUrl(result.criteria) : null;
  // Preserve the original listing order even when a provider has no usable photo.
  // The Telegram delivery layer can render those entries as text cards, so summary
  // counts and Jobcenter callbacks always refer to the same listing index.
  return listings
    .filter(item => safeHousingUrl(item?.url))
    .slice(0, 5)
    .map((item, index) => {
      const details = [];
      if (item.rooms) details.push(`🛏 ${escapeHtml(item.rooms)} кімн.`);
      if (Number.isFinite(item.areaSqm)) details.push(`📐 ${formatArea(item.areaSqm)} м²`);
      if (Number.isFinite(item.distanceKm) && !item.distanceApprox) details.push(`📍 ≈${formatDistance(item.distanceKm)} км`);
      const date = item.createdAt && /^\d{4}-\d{2}-\d{2}/.test(item.createdAt)
        ? item.createdAt.slice(0, 10).split('-').reverse().join('.')
        : null;
      if (date) details.push(`📅 ${date}`);
      const extra = index === 0 && extraSearch
        ? `\n<a href="${escapeHtml(extraSearch)}">🌐 Пошук ще у ${HOUSING_SEARCH_SOURCES.length - 1} джерелах</a>`
        : '';
      const caption = ([
        `<b>${index + 1}. ${escapeHtml(listingTitle(item))}</b>`,
        `💶 <b>${formatEuro(item.price)} €</b>${KNOWN_PRICE_TYPE.test(String(item.priceType || '')) ? ` ${priceTypeLabel(item.priceType)}` : ''}${Number.isFinite(item?.coldPrice) ? ` (Kaltmiete ${formatEuro(item.coldPrice)} €)` : ''} · ${escapeHtml(String(item.location || '').slice(0, 100))}`,
        details.join(' · '),
        `<a href="${escapeHtml(item.url)}">🔗 Відкрити оголошення</a>`
      ].filter(Boolean).join('\n') + extra);
      const media = item?.imageUrl && /^https:\/\//i.test(String(item.imageUrl))
        ? String(item.imageUrl)
        : null;
      return { type:media ? 'photo' : 'text', media, caption, parse_mode:'HTML' };
    });
}

export function housingListingsMarkup(result) {
  const listings = Array.isArray(result?.listings) ? result.listings : [];
  const rows = listings.slice(0, 5).filter(item => safeHousingUrl(item?.url)).map((item, index) => [{ text: item?.publicSource ? `${index + 1}. ${String(item.source || 'Джерело').slice(0, 32)}` : `${index + 1}. Відкрити оголошення`, url: String(item.url) }]);
  const supplemental = result?.criteria ? pairButtons(externalSourceEntries(result.criteria)) : [];
  const combined = [...rows, ...supplemental].slice(0, 16); return combined.length ? { inline_keyboard: combined } : null;
}

export function externalHousingSearchMarkup(criteria) {
  const sites = [['Kleinanzeigen', `https://www.google.com/search?q=${encodeURIComponent('site:kleinanzeigen.de/s-anzeige ' + `${criteria.location} ${roomSpecFromCriteria(criteria)?.label || criteria.rooms} Zimmer Wohnung mieten bis ${criteria.amount} EUR ${criteria.type} Umkreis ${housingRadius(criteria)} km`)}`], ...externalSourceEntries(criteria)];
  return { inline_keyboard: pairButtons(sites) };
}
