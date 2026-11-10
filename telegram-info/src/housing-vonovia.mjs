// Vonovia flats for rent, verified 14.10 and 17.10.2026 with plain GET:
// /api/real-estate/search-token hands out a public search token (ttl 900 s)
// that /api/real-estate/list expects in X-VON-Search-Token. The list filters
// by exact town only (no radius), so the user's own town is asked; every
// result carries coordinates, so the distance shown is real.
// Requests per search: token (cached) + 1 list (cached per town).
import { placeCoordinates, distanceKm } from './housing-company-sources.mjs';

const BASE = 'https://www.vonovia.de';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BODY_BYTES = 512 * 1024;
const TOKEN_REUSE_MS = 10 * 60 * 1000;
const LIST_CACHE_MS = 30 * 60 * 1000;
const LIST_LIMIT = 50;
const tokenCache = { at:0, token:null };
const listCache = new Map();
export function clearVonoviaCache() { tokenCache.at = 0; tokenCache.token = null; listCache.clear(); }

function nameKey(value) {
  return String(value || '').toLocaleLowerCase('de-DE').replace(/ä/gu, 'ae').replace(/ö/gu, 'oe').replace(/ü/gu, 'ue').replace(/ß/gu, 'ss').normalize('NFKD').replace(/[^a-z0-9]/gu, '');
}

export function vonoviaListUrl(town) {
  const params = new URLSearchParams({ city:String(town || '').trim(), rentType:'miete', immoType:'wohnung', limit:String(LIST_LIMIT), offset:'0' });
  return `${BASE}/api/real-estate/list?${params.toString()}`;
}

export function vonoviaListings(data, origin = null) {
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map(item => {
    const id = String(item?.wrk_id || '');
    const price = Number(item?.preis);
    const postcode = /^\d{5}$/u.test(String(item?.plz || '')) ? String(item.plz) : null;
    // Only Schleswig-Holstein / Hamburg-border postcodes; rentals only.
    if (!/^\d{6,14}$/u.test(id) || !Number.isFinite(price) || price <= 0 || !postcode || !/^2[0-5]/u.test(postcode) || String(item?.vermarktungsart_miete) !== '1') return null;
    const slug = /^[a-z0-9-]{3,200}$/u.test(String(item?.slug || '')) ? item.slug : id;
    const [town, district] = String(item?.ort || '').split(/\s+OT\s+/u).map(part => part.trim());
    const rooms = Number(item?.anzahl_zimmer);
    const area = Number(item?.groesse);
    const image = String(item?.preview_img_url || '');
    const lat = Number(item?.lat);
    const lng = Number(item?.lng);
    const distance = Number.isFinite(lat) && Number.isFinite(lng) ? distanceKm(origin, [lat, lng]) : null;
    return {
      id:`vonovia:${id}`,
      source:'Vonovia',
      sourceId:'vonovia',
      title:String(item?.titel || '').replace(/\s+/gu, ' ').trim().slice(0, 140) || 'Wohnung',
      price:Math.round(price * 100) / 100,
      priceType:'Kaltmiete',
      rooms:Number.isFinite(rooms) && rooms > 0 ? String(rooms) : null,
      areaSqm:Number.isFinite(area) && area > 0 ? Math.round(area * 100) / 100 : null,
      location:[String(item?.strasse || '').trim(), [postcode, town].filter(Boolean).join(' ') + (district ? ` (${district})` : '')].filter(Boolean).join(', ').slice(0, 100),
      postcode,
      town:town || null,
      ...(distance !== null ? { distanceKm:distance } : {}),
      imageUrl:/^https:\/\/cdn\.expose\.vonovia\.de\//u.test(image) ? image : null,
      url:`${BASE}/zuhause-finden/immobilien/${slug}`
    };
  }).filter(Boolean);
}

async function boundedJson(response) {
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('response too large');
  return JSON.parse(text);
}

async function searchToken(transport, pages, now) {
  if (tokenCache.token && now - tokenCache.at < TOKEN_REUSE_MS) return tokenCache.token;
  const started = Date.now();
  const response = await transport(`${BASE}/api/real-estate/search-token`, { method:'GET', headers:{ 'user-agent':USER_AGENT, accept:'application/json' } });
  if (!response?.ok) {
    pages.push({ reason:`http_${Number(response?.status) || 0}`, httpStatus:Number(response?.status) || 0, durationMs:Date.now() - started, step:'vonovia' });
    return null;
  }
  const token = String((await boundedJson(response))?.token || '');
  if (!/^[\w.-]{10,200}$/u.test(token)) {
    pages.push({ reason:'bad_token', httpStatus:200, durationMs:Date.now() - started, step:'vonovia' });
    return null;
  }
  tokenCache.at = now; tokenCache.token = token;
  return token;
}

export async function searchVonoviaHousing(criteria, transport = fetch) {
  const pages = [];
  const town = String(criteria?.location || '').trim();
  const origin = placeCoordinates(town);
  if (!town || !origin) return { source:'Vonovia', status:'skipped', listings:[], pages };
  const now = Date.now();
  const key = nameKey(town);
  const cached = listCache.get(key);
  if (cached && now - cached.at < LIST_CACHE_MS) {
    pages.push({ reason:'cache', httpStatus:200, durationMs:0, matchedCount:cached.listings.length, step:'vonovia' });
    return { source:'Vonovia', status:'ok', listings:cached.listings, pages };
  }
  try {
    const token = await searchToken(transport, pages, now);
    if (!token) return { source:'Vonovia', status:'unavailable', listings:[], pages };
    const started = Date.now();
    const response = await transport(vonoviaListUrl(town), { method:'GET', headers:{ 'user-agent':USER_AGENT, accept:'application/json', 'X-VON-Search-Token':token } });
    if (!response?.ok) {
      // A rejected token is not reused.
      if ([401, 403].includes(Number(response?.status))) { tokenCache.at = 0; tokenCache.token = null; }
      pages.push({ reason:`http_${Number(response?.status) || 0}`, httpStatus:Number(response?.status) || 0, durationMs:Date.now() - started, step:'vonovia' });
      return { source:'Vonovia', status:'unavailable', listings:[], pages };
    }
    const listings = vonoviaListings(await boundedJson(response), origin);
    listCache.set(key, { at:now, listings });
    pages.push({ reason:listings.length ? 'ok' : 'no_listings', httpStatus:200, durationMs:Date.now() - started, matchedCount:listings.length, step:'vonovia' });
    return { source:'Vonovia', status:'ok', listings, pages };
  } catch (error) {
    pages.push({ reason:'source_exception', error:String(error?.message || error).slice(0, 120), httpStatus:0, durationMs:0, step:'vonovia' });
    return { source:'Vonovia', status:'unavailable', listings:[], pages };
  }
}
