// WG-Gesucht whole-flat offers (categories 1-Zimmer-Wohnung + Wohnung),
// verified 14.10.2026 with plain GET: the list is server-rendered, the city
// id comes from the portal's own autocomplete, and a radius search around the
// user's town prints "Entfernung: N km" on every card.
//
// Only unbefristet offers are asked for (rent_types[]=2), so Zwischenmiete
// is excluded by the portal. The card price is the Gesamtmiete (warm).
// Requests per search: autocomplete (cached per Worker instance) + 1 page.
import { placeCoordinates, distanceKm, germanNumber } from './housing-company-sources.mjs';

const BASE = 'https://www.wg-gesucht.de';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_HTML_BYTES = 1024 * 1024;
const SH_STATE_ID = '13';
const cityIdCache = new Map();
export function clearWgGesuchtCache() { cityIdCache.clear(); }

// Rooms, WG rooms, reserved ads and swaps are not offers of a whole flat.
const NOT_A_FLAT = /\b(?:wg[-\s]?zimmer|zimmer\s+in\s+(?:einer\s+)?wg|reserviert|vergeben|tausch|zwischenmiete|untermiete)\b/iu;
// TG-RUNTIME-080: a student dorm room or a let "auf Zeit" is no flat to live in.
// Review #080: "Wohnheimstraße" or "nicht auf Zeit" are flats; a single room
// ("Einzelzimmer") and a room in any WG ("Frauen-WG") are not.
const NOT_FOR_LIVING = /(?:(?<!ehem(?:alig\p{L}*|\.)\s+(?:\p{L}+\s+)?)\b\p{L}*wohnheim(?!stra(?:ß|ss)e|str\.|weg|allee)\p{L}*|(?<!nicht\s)\bauf\s+zeit\b(?!basis)|\beinzelzimmer\b|(?<!(?:für|fuer|als)\s+)\b[\p{L}]+-wg\b(?!-?geeignet))/iu;

// "Bad Segeberg Altstadt" → "Bad Segeberg": the longest known place prefix.
function townOf(place) {
  const words = String(place || '').split(/\s+/u).filter(Boolean);
  for (let n = words.length; n > 0; n -= 1) {
    const name = words.slice(0, n).join(' ');
    if (placeCoordinates(name)) return name;
  }
  return words[0] || null;
}

function decode(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&euro;/gu, '€').replace(/&sup2;/gu, '²').replace(/&amp;/gu, '&').replace(/&quot;/gu, '"').replace(/&#0?39;/gu, "'").replace(/&nbsp;/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
}

function nameKey(value) {
  return String(value || '').toLocaleLowerCase('de-DE').replace(/ä/gu, 'ae').replace(/ö/gu, 'oe').replace(/ü/gu, 'ue').replace(/ß/gu, 'ss').normalize('NFKD').replace(/[^a-z0-9]/gu, '');
}

export function wgCitySlug(name) {
  return String(name || '').trim()
    .replace(/ä/gu, 'ae').replace(/ö/gu, 'oe').replace(/ü/gu, 'ue').replace(/Ä/gu, 'Ae').replace(/Ö/gu, 'Oe').replace(/Ü/gu, 'Ue').replace(/ß/gu, 'ss')
    .replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
}


export function pickWgCity(data, location) {
  const cities = Array.isArray(data?._embedded?.cities) ? data._embedded.cities : [];
  const wanted = nameKey(location);
  return cities.find(city => String(city?.federated_state_id) === SH_STATE_ID && nameKey(city?.city_name) === wanted) || null;
}

export function wgSearchUrl({ cityId, cityName, lat, lon, radiusKm, maxRent }) {
  const params = new URLSearchParams();
  params.set('offer_filter', '1');
  params.set('city_id', String(cityId));
  params.set('noDeact', '1');
  params.append('categories[]', '1');
  params.append('categories[]', '2');
  params.append('rent_types[]', '2');
  // Whole euros, rounded up: 943,80 € → 944, so a listing at 943,50 € is not
  // hidden; filterPrimaryListings drops anything above the exact limit.
  if (Number.isFinite(maxRent) && maxRent > 0) params.set('rMax', String(Math.ceil(maxRent)));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set('radLat', String(lat));
    params.set('radLng', String(lon));
    params.set('radDis', String(Math.max(1, Math.min(50, Number(radiusKm) || 15)) * 1000));
  }
  return `${BASE}/1-zimmer-wohnungen-und-wohnungen-in-${wgCitySlug(cityName)}.${cityId}.1+2.1.0.html?${params.toString()}`;
}

// TG-RUNTIME-080: since 10.2026 a card is <a id="liste-details-ad-N"
// class="wgg-list-card"> with the price in "card-main-text", the type, town and
// street in the "ad-subtitle" title ("2-Zimmer-Wohnung · Kiel Gaarden-Ost ·
// Iltisstraße 18") and size and date in the "middle-row". The old layout
// (test fixture of 14.10.2026) is still read when no new card is found.
function parseWgGesuchtCards(html) {
  const cards = String(html || '').split(/<a\s+id="liste-details-ad-/u).slice(1);
  return cards.map(raw => {
    const card = raw.split(/<\/a>\s*<div class="printonly">|<a\s+id="liste-details-ad-/u)[0];
    const id = /^(\d+)"/u.exec(card)?.[1];
    const href = /\bhref="([^"]+)"/u.exec(card)?.[1];
    const title = decode(/<span class="card-main-text ad-title"[^>]*>([\s\S]*?)<\/span>/u.exec(card)?.[1] || /aria-label="([^"]*)"/u.exec(card)?.[1] || '');
    const priceText = decode(/price-row[\s\S]*?<span class="card-main-text">([\s\S]*?)<\/span>/u.exec(card)?.[1] || '');
    const subtitle = decode(/class="card-subtitle ad-subtitle[^"]*" title="([^"]*)"/u.exec(card)?.[1] || '');
    const middle = /middle-row">([\s\S]*?)<div class="vertical-align-center noprint bottom-card/u.exec(card)?.[1] || '';
    const sizeText = decode(/<span class="size-value">([\s\S]*?)<\/span>/u.exec(middle)?.[1] || '');
    const dateText = decode(middle.replace(/<span class="size-value">[\s\S]*?<\/span>/u, ''));
    const image = /<img class="top-image-card[^"]*" src="([^"]+)"/u.exec(card)?.[1] || '';
    const distance = germanNumber(/Entfernung:\s*([\d.,]+)\s*km/u.exec(card)?.[1]);
    const [type = '', place = '', street = ''] = subtitle.split('·').map(part => part.trim());
    const rooms = germanNumber(/([\d,]+)-Zimmer/u.exec(type)?.[1]);
    const price = germanNumber(priceText);
    if (!id || !href || !Number.isFinite(price) || price <= 0 || /\d{2}\.\d{2}\.\d{4}\s*-\s*\d{2}\.\d{2}\.\d{4}/u.test(dateText)) return null;
    if (NOT_A_FLAT.test(`${title} ${type}`) || NOT_FOR_LIVING.test(title) || !/wohnung/iu.test(type)) return null;
    return {
      id:`wg-gesucht:${id}`,
      source:'WG-Gesucht',
      sourceId:'wg-gesucht',
      title:title.slice(0, 140) || type,
      price,
      priceType:'Gesamtmiete',
      rooms:Number.isFinite(rooms) && rooms > 0 ? String(rooms) : null,
      areaSqm:germanNumber(sizeText),
      location:[place, street].filter(Boolean).join(', ').slice(0, 100),
      town:townOf(place),
      ...(Number.isFinite(distance) ? { distanceKm:distance } : {}),
      imageUrl:/^https:\/\//u.test(image) && !/placeholder|dummy/iu.test(image) ? image : null,
      url:new URL(href.replace(/&amp;/gu, '&'), BASE).toString()
    };
  }).filter(Boolean);
}

export function parseWgGesuchtList(html) {
  // Review #080: a premium ad is shown twice (pinned and in the list).
  if (/<a\s+id="liste-details-ad-/u.test(String(html || ''))) return parseWgGesuchtCards(html).filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  const cards = String(html || '').split(/<div\s+id="liste-details-ad-/u).slice(1);
  return cards.map(raw => {
    const card = raw.split(/<div\s+id="liste-details-ad-|<span id="back_to_ad_|<div class="printonly">/u)[0];
    const id = /^(\d+)"/u.exec(card)?.[1];
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/u.exec(card);
    const title = decode(link?.[2] || '');
    const summary = decode(/<div class="col-xs-11[^"]*">\s*<span[^>]*>([\s\S]*?)<\/span>/u.exec(card)?.[1] || '');
    const middle = /<div class="row noprint middle[^"]*">([\s\S]*?)<div class="row noprint bottom/u.exec(card)?.[1] || '';
    const [priceText, dateText, sizeText] = [...middle.matchAll(/<div class="col-xs-\d[^"]*">([\s\S]*?)<\/div>/gu)].map(match => decode(match[1]));
    const image = /card_image[\s\S]*?<img src="([^"]+)"/u.exec(card)?.[1] || '';
    const distance = germanNumber(/Entfernung:\s*([\d.,]+)\s*km/u.exec(card)?.[1]);
    const [type = '', place = '', street = ''] = summary.split('|').map(part => part.trim());
    const rooms = germanNumber(/([\d,]+)-Zimmer/u.exec(type)?.[1]);
    const price = germanNumber(priceText);
    // A date range ("08.11.2026 - 23.03.2027") is a temporary let.
    if (!id || !link || !Number.isFinite(price) || price <= 0 || / - /u.test(dateText || '')) return null;
    if (NOT_A_FLAT.test(`${title} ${type}`) || !/wohnung/iu.test(type)) return null;
    const url = new URL(link[1].replace(/&amp;/gu, '&'), BASE).toString();
    return {
      id:`wg-gesucht:${id}`,
      source:'WG-Gesucht',
      sourceId:'wg-gesucht',
      title:title.slice(0, 140) || type,
      price,
      priceType:'Gesamtmiete',
      rooms:Number.isFinite(rooms) && rooms > 0 ? String(rooms) : null,
      areaSqm:germanNumber(sizeText),
      location:[place, street].filter(Boolean).join(', ').slice(0, 100),
      town:place.split(/\s+/u)[0] || null,
      ...(Number.isFinite(distance) ? { distanceKm:distance } : {}),
      imageUrl:/^https:\/\//u.test(image) && !/placeholder|dummy/iu.test(image) ? image : null,
      url
    };
  }).filter(Boolean);
}

async function boundedText(response) {
  const text = await response.text();
  return text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
}

async function cityFor(location, transport, pages) {
  const key = nameKey(location);
  if (cityIdCache.has(key)) return cityIdCache.get(key);
  const started = Date.now();
  const response = await transport(`${BASE}/api/location/cities/names/${encodeURIComponent(String(location).trim())}`, {
    method:'GET', headers:{ 'user-agent':USER_AGENT, accept:'application/json' }
  });
  pages.push({ reason:response?.ok ? 'ok' : `http_${Number(response?.status) || 0}`, httpStatus:Number(response?.status) || 0, durationMs:Date.now() - started, step:'city' });
  if (!response?.ok) return null;
  const city = pickWgCity(JSON.parse(await boundedText(response)), location);
  // A town WG-Gesucht does not know is remembered too: no second lookup.
  cityIdCache.set(key, city);
  return city;
}

export async function searchWgGesuchtHousing(criteria, transport = fetch) {
  const pages = [];
  const location = String(criteria?.location || '').trim();
  const point = placeCoordinates(location);
  if (!location || !point) return { source:'WG-Gesucht', status:'skipped', listings:[], pages };
  try {
    const city = await cityFor(location, transport, pages);
    if (!city) return { source:'WG-Gesucht', status:'skipped', listings:[], pages };
    const started = Date.now();
    const response = await transport(wgSearchUrl({
      cityId:city.city_id, cityName:city.city_name, lat:point[0], lon:point[1], radiusKm:criteria?.radiusKm, maxRent:Number(criteria?.amount)
    }), { method:'GET', headers:{ 'user-agent':USER_AGENT, accept:'text/html', 'accept-language':'de-DE' } });
    if (!response?.ok) {
      pages.push({ reason:`http_${Number(response?.status) || 0}`, httpStatus:Number(response?.status) || 0, durationMs:Date.now() - started, step:'list' });
      return { source:'WG-Gesucht', status:'unavailable', listings:[], pages };
    }
    // Cards without "Entfernung" (searches around a big city's centre) get the
    // distance of their town from the pinned coordinates.
    const listings = parseWgGesuchtList(await boundedText(response)).map(item => {
      if (Number.isFinite(item.distanceKm)) return item;
      const distance = distanceKm(point, placeCoordinates(item.town));
      return distance === null ? item : { ...item, distanceKm:distance, distanceApprox:true };
    });
    pages.push({ reason:listings.length ? 'ok' : 'no_listings', httpStatus:200, durationMs:Date.now() - started, matchedCount:listings.length, step:'list' });
    return { source:'WG-Gesucht', status:'ok', listings, pages };
  } catch (error) {
    pages.push({ reason:'source_exception', error:String(error?.message || error).slice(0, 120), httpStatus:0, durationMs:0, step:'wg' });
    return { source:'WG-Gesucht', status:'unavailable', listings:[], pages };
  }
}
