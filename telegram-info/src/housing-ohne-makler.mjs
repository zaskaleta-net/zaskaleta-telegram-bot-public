// ohne-makler.net public search (private landlords). Pages are server
// rendered: every card links to /immobilie/<id>/, the map data
// (#immobilien-geojson) carries each listing's coordinates and #geodbArea the
// searched municipality's boundary. When the town has no own offers the page
// fills up with "Ähnliche Immobilien in der Umgebung" (Hamburg, Lübeck, …);
// those cards get a measured distance and go through the same radius and
// Jobcenter filters as every other listing.
import { roomSpecFromCriteria, roomValueInSpec } from './rooms.mjs';
import { fetchPublicHtml, pageDiagnostic, htmlText, decodeHtmlEntities, numberDe, portalSlug } from './housing-html-fetch.mjs';

const HOST = 'ohne-makler.net';
const ORIGIN = 'https://www.ohne-makler.net';
const TIMEOUT_MS = 6000;
// The portal's own radius choices; the measured distance enforces the exact one.
const PORTAL_RADII = [10, 25, 50, 100];

function criteriaUsable(criteria) {
  const amount = Number(criteria?.amount);
  return !!criteria?.location && !!roomSpecFromCriteria(criteria) && Number.isFinite(amount) && amount >= 100 && amount <= 50000;
}

function portalRadius(radiusKm) {
  const value = Number(radiusKm);
  if (!Number.isFinite(value) || value <= 0) return 10;
  return PORTAL_RADII.find(radius => radius >= value) || 100;
}

export function ohneMaklerSearchUrls(criteria) {
  const slug = portalSlug(criteria?.location);
  if (!slug) return [];
  const radius = portalRadius(criteria?.radiusKm);
  return ['wohnung-mieten', 'haus-mieten'].map(kind => `${ORIGIN}/immobilien/${kind}/schleswig-holstein/${slug}/?radius=${radius}`);
}

function jsonScript(html, id) {
  const match = new RegExp(`<script\\b[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'iu').exec(html);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function validPoint(lon, lat) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function listingCoordinates(html) {
  const map = new Map();
  const geo = jsonScript(html, 'immobilien-geojson');
  for (const feature of Array.isArray(geo?.features) ? geo.features : []) {
    const [lon, lat] = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates.map(Number) : [];
    const id = String(feature?.id ?? feature?.properties?.id ?? '');
    if (/^\d{1,12}$/u.test(id) && validPoint(lon, lat)) map.set(id, { latitude:lat, longitude:lon });
  }
  return map;
}

// Centre of the searched municipality's bounding box.
export function ohneMaklerOrigin(html) {
  const area = jsonScript(String(html || ''), 'geodbArea');
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  const visit = value => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      const [lon, lat] = value;
      if (!validPoint(lon, lat)) return;
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      return;
    }
    value.forEach(visit);
  };
  visit(area?.geometry?.coordinates);
  if (!Number.isFinite(minLat) || maxLat - minLat > 1 || maxLon - minLon > 1) return null;
  return { latitude:(minLat + maxLat) / 2, longitude:(minLon + maxLon) / 2 };
}

export function distanceKm(a, b) {
  if (!a || !b) return null;
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function textLines(card) {
  return decodeHtmlEntities(card
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/giu, ' ')
    .replace(/<[^>]+>/gu, '\n'))
    .split('\n')
    .map(line => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

function titledValue(card, title) {
  const match = new RegExp(`<div\\b[^>]*title=["']${title}["'][^>]*>([\\s\\S]*?)<\\/div>`, 'iu').exec(card);
  return match ? htmlText(match[1], 60) : '';
}

// "23858 Reinfeld" + "(Reinfeld (Holstein))" -> "23858 Reinfeld (Holstein)";
// "22143 Hamburg" + "(Rahlstedt)" -> "22143 Hamburg, Rahlstedt".
export function ohneMaklerLocation(lines) {
  const index = lines.findIndex(line => /^\d{5}\s+\S/u.test(line));
  if (index < 0) return '';
  const base = lines[index].slice(0, 100);
  const sub = /^\((.{2,80})\)$/u.exec(lines[index + 1] || '')?.[1]?.trim();
  if (!sub) return base;
  const [plz, ...townParts] = base.split(' ');
  const town = townParts.join(' ');
  if (sub.toLocaleLowerCase('de-DE').startsWith(town.toLocaleLowerCase('de-DE'))) return `${plz} ${sub}`.slice(0, 120);
  return `${base}, ${sub}`.slice(0, 120);
}

export function parseOhneMaklerPage(html, criteria) {
  if (!criteriaUsable(criteria)) return { listings:[], recognized:false, parsedCount:0 };
  const source = String(html || '');
  const roomSpec = roomSpecFromCriteria(criteria);
  const amount = Number(criteria.amount);
  const radiusKm = Number(criteria?.radiusKm);
  const coordinates = listingCoordinates(source);
  const origin = ohneMaklerOrigin(source);
  const surrounding = /Ähnliche Immobilien in der Umgebung/iu.test(source);
  // The live site links cards relatively (/immobilie/<id>/); saved pages may
  // carry the absolute form.
  const anchors = [...source.matchAll(/<a\b[^>]*href=["'](?:https:\/\/www\.ohne-makler\.net)?\/immobilie\/(\d{1,12})\/["'][^>]*>/giu)];
  const listings = [];
  const seen = new Set();
  let parsedCount = 0;
  for (const anchor of anchors) {
    const id = anchor[1];
    if (seen.has(id)) continue;
    const type = /data-om-type=["']([A-Z_]+)["']/u.exec(anchor[0])?.[1];
    const end = source.indexOf('</a>', anchor.index);
    const card = source.slice(anchor.index, end > anchor.index ? end : anchor.index + 20000);
    const lines = textLines(card);
    const price = numberDe(/^(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*€$/u.exec(lines.find(line => /^\d[\d.,]*\s*€$/u.test(line)) || '')?.[1]);
    const title = htmlText(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/iu.exec(card)?.[1], 140);
    const location = ohneMaklerLocation(lines);
    if (!Number.isFinite(price) || !title || !location) continue;
    seen.add(id);
    parsedCount += 1;
    if (type && type !== 'RENT') continue;
    const rooms = numberDe(titledValue(card, 'Zimmer'));
    const areaSqm = numberDe(/(\d{1,4}(?:,\d{1,2})?)\s*m²/u.exec(titledValue(card, 'Wohnfläche'))?.[1]);
    if (!Number.isFinite(rooms) || !roomValueInSpec(rooms, roomSpec)) continue;
    if (!(price > 0 && price <= amount)) continue;
    const distance = distanceKm(origin, coordinates.get(id));
    if (Number.isFinite(distance) && Number.isFinite(radiusKm) && distance > radiusKm) continue;
    const image = /<img\b[^>]*\bsrc=["'](https:\/\/media\.ohne-makler\.net\/[^"']+)["']/iu.exec(card)?.[1];
    listings.push({
      id,
      source:'Ohne-Makler',
      sourceId:'ohne-makler-public',
      title,
      price,
      priceType:'ціна в оголошенні',
      location,
      rooms,
      areaSqm:Number.isFinite(areaSqm) ? areaSqm : null,
      url:`${ORIGIN}/immobilie/${id}/`,
      imageUrl:image ? decodeHtmlEntities(image) : null,
      distanceKm:Number.isFinite(distance) ? Math.round(distance * 10) / 10 : null,
      surrounding,
      publicSource:true
    });
  }
  // The location autocomplete ships its own hidden "Keine Ergebnisse gefunden"
  // line on every page; only text outside those Alpine x-show templates counts.
  const visible = source.replace(/<li\b[^>]*\bx-show=[^>]*>[\s\S]*?<\/li>/giu, ' ');
  const empty = /keine\s+(?:passenden\s+)?(?:Angebote|Ergebnisse|Immobilien)\s+gefunden/iu.test(htmlText(visible, 400000));
  return { listings, recognized:parsedCount > 0 || empty, parsedCount };
}

export async function searchOhneMaklerHousing(criteria, transport = fetch) {
  const label = 'Ohne-Makler';
  if (!criteriaUsable(criteria)) return { source:label, status:'invalid_criteria', listings:[], pages:[] };
  const urls = ohneMaklerSearchUrls(criteria);
  const pages = await Promise.all(urls.map(async url => {
    const page = await fetchPublicHtml(url, { allowedHost:HOST, transport, timeoutMs:TIMEOUT_MS });
    return { page, parsed:page.html == null ? null : parseOhneMaklerPage(page.html, criteria) };
  }));
  const seen = new Set();
  const listings = pages.flatMap(({ parsed }) => parsed?.listings || []).filter(item => !seen.has(item.id) && seen.add(item.id));
  const readable = pages.filter(({ parsed }) => parsed?.recognized).length;
  return {
    source:label,
    status:readable === pages.length && readable ? 'ok' : readable ? 'partial' : 'unavailable',
    listings,
    searchUrls:urls,
    pages:pages.map(({ page, parsed }) => pageDiagnostic(page, parsed))
  };
}
