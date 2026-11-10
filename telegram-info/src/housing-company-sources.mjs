// Listings of Schleswig-Holstein housing companies read from their own,
// server-rendered list pages (verified 14.10.2026, plain GET, no tokens):
//   Wankendorfer Baugenossenschaft – about 60 flats across SH, Gesamtmiete;
//   TRAVE Lübeck – Nettokaltmiete;
//   WOBAU Neumünster – Warmmiete;
//   FAB Flensburg, WBG Kiel-Ost, Lübecker Bauverein, WOGE Kiel – Gesamtmiete;
//   Neue Lübecker, Adlershorst, BIG-Verwaltung, Wohnungsunternehmen
//   Dithmarschen, ZBVV, Haus und Grund Kiel – Kaltmiete.
// Each list is a single page; only ZBVV needs the town in the URL.
// Company flats are usually moderate in rent, which suits Jobcenter limits.
// The pages give a town, not a distance; the distance is measured from the
// pinned municipality coordinates (sh-place-coordinates.mjs).
import { SH_RUNTIME_MUNICIPALITY_ROWS } from './sh-municipality-jurisdiction-runtime.mjs';
import { SH_PLACE_COORDINATES } from './sh-place-coordinates.mjs';

const MAX_HTML_BYTES = 768 * 1024;
// Company list pages change a few times a day; a parsed page is reused for
// 30 minutes within a Worker instance, which saves the provider budget.
const PAGE_CACHE_TTL_MS = 30 * 60 * 1000;
const pageCache = new Map();
export function clearHousingCompanyCache() { pageCache.clear(); }
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export const ZBVV_TOWNS = Object.freeze(['Kiel', 'Rendsburg', 'Lübeck', 'Bordesholm', 'Neumünster', 'Bad Bramstedt', 'Flensburg', 'Brunsbüttel']);

// The searched town, or the town of the Jobcenter territory searched.
function zbvvTown(criteria) {
  const keys = [criteria?.location, criteria?.districtJurisdiction].map(nameKey).filter(Boolean);
  return ZBVV_TOWNS.find(town => keys.includes(nameKey(town))) || null;
}

function zbvvPath(criteria) {
  const town = zbvvTown(criteria);
  return town ? `/vermietungsangebote/?inx-search-marketing-type=zu-vermieten&inx-search-locality=${encodeURIComponent(town)}` : null;
}

export const HOUSING_COMPANY_SOURCES = Object.freeze([
  Object.freeze({ id:'wankendorfer', label:'Wankendorfer', base:'https://www.wankendorfer.de', path:'/wohnungssuche/', priceType:'Gesamtmiete', near:null }),
  Object.freeze({ id:'trave', label:'TRAVE Lübeck', base:'https://www.trave.de', path:'/interessenten/wohnung-mieten', priceType:'Nettokaltmiete', near:'Lübeck' }),
  Object.freeze({ id:'wobau-neumuenster', label:'WOBAU Neumünster', base:'https://www.wobau-neumuenster.de', path:'/mieten/mietangebote', priceType:'Warmmiete', near:'Neumünster' }),
  // `near` is the town (or the towns) a company lets in; a list page is asked
  // only when one of them can be in the result. `districts` also opens it for
  // a Jobcenter territory search.
  Object.freeze({ id:'fab', label:'FAB Flensburg', base:'https://www.fab.sh', path:'/main/aktuelle-wohnungsangebote/', priceType:'Gesamtmiete', near:'Flensburg' }),
  Object.freeze({ id:'wbg-kiel-ost', label:'WBG Kiel-Ost', base:'https://www.wbg-kiel-ost.de', path:'/mieten/objekte/mietwohnungen.html', priceType:'Gesamtmiete', near:'Kiel' }),
  Object.freeze({ id:'luebecker-bauverein', label:'Lübecker Bauverein', base:'https://www.luebecker-bauverein.de', path:'/angebotsfinder.html', priceType:'Gesamtmiete', near:Object.freeze(['Lübeck', 'Bad Schwartau']) }),
  Object.freeze({ id:'neue-luebecker', label:'Neue Lübecker', base:'https://www.neueluebecker.de', path:'/mieten/immobilienangebote/', priceType:'Kaltmiete', near:Object.freeze(['Lübeck', 'Norderstedt', 'Ahrensburg', 'Elmshorn', 'Ratzeburg', 'Büchen', 'Bad Oldesloe', 'Neustadt in Holstein']) }),
  Object.freeze({ id:'woge-kiel', label:'WOGE Kiel', base:'https://www.wogekiel.de', path:'/mietangebote', priceType:'Gesamtmiete', near:Object.freeze(['Kiel', 'Flensburg', 'Bordesholm', 'Preetz']) }),
  Object.freeze({ id:'adlershorst', label:'Adlershorst', base:'https://www.adlershorst.de', path:'/wohnen/fuer-wohnungssuchende/freie-wohnungen/', priceType:'Kaltmiete', near:Object.freeze(['Norderstedt', 'Tornesch']) }),
  Object.freeze({ id:'big-verwaltung', label:'BIG-Verwaltung', base:'https://big-verwaltung.de', path:'/immobilien-vermarktungsart/miete/', priceType:'Kaltmiete', near:Object.freeze(['Kiel', 'Neumünster', 'Bordesholm', 'Schleswig', 'Itzehoe']) }),
  Object.freeze({ id:'wodi-dithmarschen', label:'Wohnungsunternehmen Dithmarschen', base:'https://www.wo-di.de', path:'/wohnen.html', priceType:'Kaltmiete', near:Object.freeze(['Heide', 'Brunsbüttel', 'Meldorf']), districts:Object.freeze(['Dithmarschen']) }),
  // ZBVV lets all over Germany; its list is asked for the searched town only,
  // and only for the SH towns where it has flats.
  Object.freeze({ id:'zbvv', label:'ZBVV', base:'https://www.zbvv.de', path:'/vermietungsangebote/', priceType:'Kaltmiete', near:null, townFor:zbvvTown, pathFor:zbvvPath }),
  Object.freeze({ id:'hug-kiel', label:'Haus und Grund Kiel', base:'https://www.hausundgrund.de', path:'/verein/kiel/immobilienservice/fuer-mieter/mietangebote/verwaltung?marketing_type=RENT&page=0', priceType:'Kaltmiete', near:'Kiel' })
]);

const sourceById = id => HOUSING_COMPANY_SOURCES.find(source => source.id === id);

function nameKey(value) {
  return String(value || '').toLocaleLowerCase('de-DE')
    .replace(/ä/gu, 'ae').replace(/ö/gu, 'oe').replace(/ü/gu, 'ue').replace(/ß/gu, 'ss')
    .normalize('NFKD').replace(/[^a-z0-9]/gu, '');
}

let placeIndex = null;
function placeRow(name) {
  if (!placeIndex) {
    placeIndex = new Map();
    for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
      const key = nameKey(String(row.canonical).replace(/\s*\(.*?\)\s*/gu, ' ').split(',')[0]);
      if (key && !placeIndex.has(key)) placeIndex.set(key, row);
    }
  }
  return placeIndex.get(nameKey(String(name || '').replace(/\s*\(.*?\)\s*/gu, ' ').split(',')[0])) || null;
}

// The official 8-digit municipality key (AGS) for a typed name.
export function placeAgs(name) {
  return placeRow(name)?.ags || null;
}

// The official municipality name for a typed one ("kiel" -> "Kiel").
export function placeName(name) {
  const row = placeRow(name);
  return row ? String(row.canonical).replace(/\s*\(.*?\)\s*/gu, ' ').split(',')[0].trim() : null;
}

export function placeCoordinates(name) {
  const row = placeRow(name);
  const point = row ? SH_PLACE_COORDINATES[row.ags] : null;
  return Array.isArray(point) ? point : null;
}

export function distanceKm(a, b) {
  if (!a || !b) return null;
  const rad = degrees => degrees * Math.PI / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(h)) * 10) / 10;
}

function decode(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&amp;/gu, '&').replace(/&quot;/gu, '"').replace(/&#0?39;|&apos;/gu, "'").replace(/&nbsp;|&#160;/gu, ' ')
    .replace(/&auml;/gu, 'ä').replace(/&ouml;/gu, 'ö').replace(/&uuml;/gu, 'ü').replace(/&Auml;/gu, 'Ä').replace(/&Ouml;/gu, 'Ö').replace(/&Uuml;/gu, 'Ü').replace(/&szlig;/gu, 'ß')
    .replace(/&sup2;/gu, '²').replace(/&euro;/gu, '€')
    .replace(/&#(\d{2,6});/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/gu, ' ').trim();
}

function first(part, re) {
  const match = re.exec(part);
  return match ? decode(match[1]) : null;
}

// "1.650,00 €" -> 1650; "772.71" -> 772.71; "66,86 m²" -> 66.86
export function germanNumber(value) {
  let text = String(value ?? '').replace(/[^\d.,]/gu, '');
  if (!text) return null;
  if (text.includes(',')) text = text.replace(/\./gu, '').replace(',', '.');
  // "1.029 €" is one thousand and twenty-nine (staging 14.10.2026: read as
  // 1.029 € it passed a 680 € Jobcenter limit); "772.71" stays a decimal.
  else if (/^\d{1,3}(?:\.\d{3})+$/u.test(text)) text = text.replace(/\./gu, '');
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function absolute(base, href) {
  if (!href) return null;
  try {
    const url = new URL(href.replace(/&amp;/gu, '&'), base);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// "Theodor-Storm-Str. 63, 23795 Bad Segeberg" -> { postcode, town, location }
export function addressParts(address) {
  const match = /\b(2\d{4})\s+([^,(]+?)(?:\s*\(([^)]*)\))?\s*$/u.exec(String(address || '').trim());
  if (!match) return { postcode:null, town:null, location:String(address || '').trim() || null };
  const town = match[2].trim();
  return { postcode:match[1], town, location:`${match[1]} ${town}${match[3] ? ` (${match[3].trim()})` : ''}` };
}

function listing(source, fields) {
  const price = germanNumber(fields.price);
  const areaSqm = germanNumber(fields.area);
  const rooms = germanNumber(fields.rooms);
  const parts = addressParts(fields.address);
  // A list without a postcode names the town; it stands in for the location.
  if (!parts.town && fields.town) Object.assign(parts, { town:fields.town, location:fields.location || fields.town });
  if (!Number.isFinite(price) || price <= 0 || !fields.url || !fields.title) return null;
  // A list that also names the Warmmiete (BIG, Haus & Grund Kiel) gives the
  // full monthly cost: it becomes the price, the Kaltmiete stays as detail.
  const warm = germanNumber(fields.warmPrice);
  const withWarm = Number.isFinite(warm) && warm >= price;
  return {
    id:`${source.id}:${fields.id || fields.url}`,
    source:source.label,
    sourceId:source.id,
    title:String(fields.title).slice(0, 140),
    price:withWarm ? warm : price,
    priceType:withWarm ? 'Warmmiete' : source.priceType,
    ...(withWarm ? { coldPrice:price } : {}),
    rooms:Number.isFinite(rooms) && rooms > 0 ? String(rooms) : null,
    areaSqm:Number.isFinite(areaSqm) && areaSqm > 0 ? Math.round(areaSqm * 100) / 100 : null,
    location:parts.location,
    postcode:parts.postcode,
    town:parts.town,
    imageUrl:fields.image && !/placeholder|dummy/iu.test(fields.image) ? fields.image : null,
    url:fields.url
  };
}

export function parseWankendorfer(html, source = HOUSING_COMPANY_SOURCES[0]) {
  return String(html || '').split('js-immoFilter-item').slice(1).map(part => {
    const rooms = first(part, /data-rooms="([^"]*)"/u);
    const area = first(part, /Fläche<\/p>\s*<h4 class="Base-h4">([\s\S]*?)<\/h4>/u);
    // Parking spaces have no rooms and no living area.
    if (!area || !Number(germanNumber(rooms))) return null;
    return listing(source, {
      id:first(part, /aria-label="Objekt ([^"]+)"/u),
      title:first(part, /<h4 class="Base-h4">([^<]*)<\/h4>/u),
      address:first(part, /ImmoListTeaser-subline[^>]*>[\s\S]*?<\/span>([^<]*)<\/p>/u) || first(part, /<\/span>([^<]*\b2\d{4}\b[^<]*)<\/p>/u),
      price:first(part, /data-price="([^"]*)"/u),
      rooms,
      area,
      image:absolute(source.base, first(part, /<img[^>]*src="([^"]+)"/u)),
      url:absolute(source.base, first(part, /href="(\/wohnungssuche\/wohnungsangebot-detail\/[^"]+)"/u))
    });
  }).filter(Boolean);
}

export function parseTrave(html, source = HOUSING_COMPANY_SOURCES[1]) {
  const value = (part, label) => first(part, new RegExp(`<strong[^>]*>([^<]*)<\\/strong>\\s*<span>${label}`, 'u'));
  return String(html || '').split('id="data-list-item-').slice(1).map(part => listing(source, {
    id:first(part, /^(\d+)/u),
    title:first(part, /<h3 class="uk-card-title">([\s\S]*?)<\/h3>/u),
    address:first(part, /<\/h3>\s*<p>([\s\S]*?)<\/p>/u),
    price:value(part, 'Nettokaltmiete'),
    area:value(part, 'Wohnfläche'),
    rooms:value(part, 'Zimmer'),
    image:absolute(source.base, first(part, /<img[^>]*src="([^"]+)"/u)),
    url:absolute(source.base, first(part, /href="(\/interessenten\/wohnung-mieten\?[^"]*action%5D=detail[^"]*)"/u))
  })).filter(Boolean);
}

export function parseWobauNeumuenster(html, source = HOUSING_COMPANY_SOURCES[2]) {
  return String(html || '').split('id="immobilie-list-item-').slice(1).map(part => {
    if (!/^\s*Wohnung\s*$/iu.test(first(part, /<p class="small">([^<]*)<\/p>/u) || '')) return null;
    const smalls = [...part.matchAll(/<div class="small">([\s\S]*?)<\/div>/gu)].map(match => decode(match[1]));
    const address = smalls.find(text => /\b2\d{4}\b/u.test(text));
    const area = smalls.find(text => /m²/u.test(text));
    const rooms = smalls.find(text => /Zimmer/iu.test(text));
    const price = smalls.find(text => /€/u.test(text));
    return listing(source, {
      id:first(part, /^(\d+)/u),
      title:first(part, /<h3 class="h4">([\s\S]*?)<\/h3>/u),
      address,
      area,
      rooms,
      price,
      image:absolute(source.base, first(part, /<img[^>]*src="([^"]+)"/u)),
      url:absolute(source.base, first(part, /href="(\/mieten\/mietangebote\/detail\/[^"]+)"/u))
    });
  }).filter(Boolean);
}

// Relative links resolve against the page's own <base href>, when it is on
// the company's site.
function pageBase(html, source) {
  const href = /<base href="([^"]+)"/u.exec(String(html || ''))?.[1];
  return href && href.startsWith(source.base) ? href : `${source.base}/`;
}

const PARKING_OR_COMMERCIAL = /garage|stellplatz|parken|parkplatz|carport|gewerbe|büro|buero|praxis|laden|geschäft|lager|halle|schulung/iu;
const SH_POSTCODE = /^2\d{4}$/u;

export function parseFab(html, source = sourceById('fab')) {
  return String(html || '').split('class="teaser borderitem"').slice(1).map(part => {
    const raw = /<div class="bg-box">[\s\S]*?<p>([\s\S]*?)<\/p>/u.exec(part)?.[1] || '';
    // "Flensburg,<br/>Junkerhohlweg 13a<br/> 2,0 Zimmer, 56 m<sup>2</sup><br/> 792,00 €"
    const text = decode(raw.replace(/<sup>2<\/sup>/gu, '²'));
    const town = /^([^,\d]+),/u.exec(text)?.[1]?.trim() || 'Flensburg';
    const url = absolute(source.base, first(part, /<a class="teaserLink" href="([^"]+)"/u));
    return listing(source, {
      id:/-(\d+)\/?$/u.exec(url || '')?.[1],
      title:first(part, /<div class="subline">([\s\S]*?)<\/div>/u),
      town,
      rooms:/([\d.,]+)\s*Zimmer/u.exec(text)?.[1],
      area:/([\d.,]+)\s*m²/u.exec(text)?.[1],
      price:/([\d.,]+)\s*€/u.exec(text)?.[1],
      image:absolute(source.base, first(part, /<img[^>]*src="([^"]+)"/u)),
      url
    });
  }).filter(Boolean);
}

export function parseWbgKielOst(html, source = sourceById('wbg-kiel-ost')) {
  const base = pageBase(html, source);
  const fact = (part, label) => first(part, new RegExp(`<dt[^>]*>\\s*<span>${label}:?<\\/span>\\s*<\\/dt>\\s*<dd[^>]*>\\s*<span>([^<]*)<\\/span>`, 'u'));
  return String(html || '').split('class="immo-list-item"').slice(1).map(part => {
    const url = absolute(base, first(part, /<h2 class="teaser-immo-title[^"]*">\s*<a[^>]*href="([^"]+)"/u));
    return listing(source, {
      id:/expose\/([^/]+?)\.html/u.exec(url || '')?.[1],
      title:first(part, /<h2 class="teaser-immo-title[^"]*">\s*<a[^>]*>([\s\S]*?)<\/a>/u),
      address:first(part, /teaser-immo-location">[\s\S]*?<span class="label">([^<]*)<\/span>/u),
      area:fact(part, 'Wohnfläche'),
      rooms:fact(part, 'Zimmer'),
      price:fact(part, 'Gesamtmiete'),
      image:absolute(base, first(part, /<img[^>]*src="([^"]+)"/u)),
      url
    });
  }).filter(Boolean);
}

// Lübecker Bauverein and Neue Lübecker share one Contao card template:
// the link title is "Title - PLZ Ort", the facts are table rows.
function parseContaoCards(html, source, { types, area, price }) {
  const base = pageBase(html, source);
  return String(html || '').split('class="card h-100 wohnung"').slice(1).map(raw => {
    const part = raw.replace(/<!--[\s\S]*?-->/gu, '');
    const type = first(part, /<figcaption class="[^"]*caption">([^<]*)<\/figcaption>/u) || '';
    if (!types.test(type)) return null;
    const row = label => first(part, new RegExp(`<th>${label}:?<\\/th>\\s*<td>([\\s\\S]*?)<\\/td>`, 'u'));
    const linkTitle = first(part, /<a href="[^"]+" title="([^"]*)"/u) || '';
    const cut = linkTitle.lastIndexOf(' - ');
    const place = cut >= 0 ? linkTitle.slice(cut + 3).trim() : '';
    const postcode = /^(\d{5})\s/u.exec(place)?.[1];
    // Both companies also let in Mecklenburg-Vorpommern (1xxxx).
    if (!postcode || !SH_POSTCODE.test(postcode)) return null;
    const street = row('Straße') || first(part, /<h5 class="card-title">[\s\S]*?<small>([\s\S]*?)<\/small>/u);
    const url = absolute(base, first(part, /<h5 class="card-title"><a href="([^"]+)"/u));
    return listing(source, {
      id:/\/([^/]+?)(?:\.html|\/)$/u.exec(url || '')?.[1],
      title:(cut > 0 ? linkTitle.slice(0, cut).trim() : '') || `${type} ${place}`,
      address:street ? `${street}, ${place}` : place,
      rooms:row('Zimmer'),
      // "ca. 68 m²"
      area:/([\d.,]+)\s*m²/u.exec(row(area) || '')?.[1],
      price:row(price),
      image:absolute(base, first(part, /<img[^>]*src="([^"]+)"/u)),
      url
    });
  }).filter(Boolean);
}

export function parseLuebeckerBauverein(html, source = sourceById('luebecker-bauverein')) {
  return parseContaoCards(html, source, { types:/^\s*Wohnung\s*$/iu, area:'Fläche', price:'Gesamtmiete' });
}

export function parseNeueLuebecker(html, source = sourceById('neue-luebecker')) {
  return parseContaoCards(html, source, { types:/^\s*(?:Wohnen|Mit WBS)\s*$/iu, area:'Größe', price:'Grundmiete' });
}

export function parseWogeKiel(html, source = sourceById('woge-kiel')) {
  const base = pageBase(html, source);
  return String(html || '').split("href='/mietangebote?&id=").slice(1).map(part => {
    const id = /^(\d+)/u.exec(part)?.[1];
    const title = first(part, /immotool_ElementTitle[^"]*">([\s\S]*?)<\/div>/u);
    const rooms = first(part, /Anzahl Zimmer\s*:\s*([^<]*)</u);
    const area = first(part, /Fläche\s*:\s*([^<]*)</u);
    // Parking spaces are listed with 0 rooms and 0 m².
    if (!id || !Number(germanNumber(rooms)) || !Number(germanNumber(area)) || PARKING_OR_COMMERCIAL.test(title || '')) return null;
    return listing(source, {
      id,
      title,
      address:first(part, /immotool_ElementAddress">\s*Straße\s*:\s*([^<]*)</u),
      town:first(part, /immotool_ElementRegion">\s*Ort\s*:\s*([^<]*)</u),
      rooms,
      area,
      price:first(part, /Mietpreis\s*:\s*([^<]*)</u),
      image:absolute(base, first(part, /<img src="([^"]+)"/u)),
      url:absolute(source.base, `/mietangebote?&id=${id}`)
    });
  }).filter(Boolean);
}

export function parseAdlershorst(html, source = sourceById('adlershorst')) {
  return String(html || '').split('class="ImmoObjectListFilter-listItem').slice(1).map(part => {
    const type = first(part, /<h6[^>]*>([\s\S]*?)<\/h6>/u) || '';
    const facts = first(part, /<p class="Base-p Base-p--small">([\s\S]*?)<\/p>/u) || '';
    const area = /Wohnfläche:\s*([\d.,]+)\s*m²/u.exec(facts)?.[1];
    const rooms = /Zimmer:\s*([\d.,]+)/u.exec(facts)?.[1];
    if (PARKING_OR_COMMERCIAL.test(type) || !area || !rooms) return null;
    // "Title<br> Street<br>PLZ Ort"
    const lines = (/<p class="Base-p">([\s\S]*?)<\/p>/u.exec(part)?.[1] || '').split(/<br\s*\/?>/u).map(decode).filter(Boolean);
    const url = absolute(source.base, first(part, /href="(\/mietobjekt\/[^"]+)"/u));
    return listing(source, {
      id:/mietobjekt\/([^/]+)\//u.exec(url || '')?.[1],
      title:lines[0],
      address:lines.slice(1).join(', '),
      area,
      rooms,
      price:first(part, /<div class="Base-h5[^"]*">([\s\S]*?)<\/div>/u),
      image:absolute(source.base, first(part, /<img[^>]*src="([^"]+)"/u)),
      url
    });
  }).filter(Boolean);
}

const RESIDENTIAL_TYPE = /wohnung|apartment|appartement|haus|maisonette|penthouse|loft|souterrain/iu;

export function parseBigVerwaltung(html, source = sourceById('big-verwaltung')) {
  const data = (part, field) => first(part, new RegExp(`data-${field}"[^>]*>[\\s\\S]*?<div class="dd[^"]*">([\\s\\S]*?)<\\/div>`, 'u'));
  return String(html || '').split('class="property" role="listitem"').slice(1).map(part => {
    // "24159 Kiel, Apartment"
    const subtitle = first(part, /class="property-subtitle">([\s\S]*?)<\/div>/u) || '';
    const cut = subtitle.lastIndexOf(',');
    const type = cut >= 0 ? subtitle.slice(cut + 1).trim() : '';
    if (!RESIDENTIAL_TYPE.test(type) || PARKING_OR_COMMERCIAL.test(type)) return null;
    const url = absolute(source.base, first(part, /<h3 class="property-title">\s*<a href="([^"]+)"/u));
    return listing(source, {
      id:/immobilien\/([^/]+)\//u.exec(url || '')?.[1],
      title:first(part, /<h3 class="property-title">\s*<a[^>]*>([\s\S]*?)<\/a>/u),
      address:subtitle.slice(0, cut),
      rooms:data(part, 'anzahl_zimmer'),
      area:data(part, 'wohnflaeche'),
      price:data(part, 'kaltmiete'),
      warmPrice:data(part, 'warmmiete'),
      image:absolute(source.base, first(part, /<img[^>]*src="([^"]+)"/u)),
      url
    });
  }).filter(Boolean);
}

export function parseWodiDithmarschen(html, source = sourceById('wodi-dithmarschen')) {
  return String(html || '').split('class="objekt"').slice(1).map(part => {
    // "<h2>Brunsbüttel: 2-Zimmerwohnung für Preisbewusste</h2>"
    const heading = first(part, /<h2>([\s\S]*?)<\/h2>/u) || '';
    const facts = decode(/<\/h2>\s*<p class="bodytext">([\s\S]*?)<\/p>/u.exec(part)?.[1] || '');
    const rooms = /Zimmer:\s*([\d.,]+)/u.exec(facts)?.[1];
    if (!rooms || PARKING_OR_COMMERCIAL.test(heading)) return null;
    const cut = heading.indexOf(':');
    const url = absolute(source.base, first(part, /href="(https:\/\/www\.wo-di\.de\/wohnen\/immobilienansicht\/objekt\/ansicht\/[^"]+)"/u));
    return listing(source, {
      id:/-(\d+)\.html$/u.exec(url || '')?.[1],
      title:cut > 0 ? heading.slice(cut + 1).trim() : heading,
      town:cut > 0 ? heading.slice(0, cut).trim() : null,
      rooms,
      area:/Wohnfläche:\s*([\d.,]+)\s*m²/u.exec(facts)?.[1],
      price:/Kaltmiete:\s*([\d.,]+)/u.exec(facts)?.[1],
      image:absolute(source.base, first(part, /<img[^>]*src="([^"]+)"/u)),
      url
    });
  }).filter(Boolean);
}

export function parseZbvv(html, source = sourceById('zbvv'), context = {}) {
  const town = context?.town || null;
  return String(html || '').split('inx-property-list-item--card').slice(1).map(part => {
    const type = first(part, /__property-type">[\s\S]*?<div>([^<]*)<\/div>/u) || '';
    const location = (first(part, /__location"[^>]*>[\s\S]*?<div>([^<]*)<\/div>/u) || '').replace(/\.+$/u, '');
    // "Kiel-Dietrichsdorf": only flats in the town that was asked for.
    if (PARKING_OR_COMMERCIAL.test(type) || !town || !nameKey(location).startsWith(nameKey(town))) return null;
    const href = first(part, /__title[^"]*">\s*<a href="([^"]+)"/u);
    const url = absolute(source.base, href ? href.replace(/[?#].*$/u, '') : null);
    return listing(source, {
      id:/immobilien\/([^/]+)\//u.exec(url || '')?.[1],
      title:first(part, /__title[^"]*">\s*<a[^>]*>([\s\S]*?)<\/a>/u),
      town,
      location,
      area:first(part, /title="Wohnfläche"><\/i>([^<]*)</u),
      rooms:first(part, /title="Zimmer"><\/i>([^<]*)</u),
      price:first(part, /inx-property-price[^>]*>([^<]*)</u),
      image:absolute(source.base, first(part, /<img[^>]*src="([^"]+)"/u)),
      url
    });
  }).filter(Boolean);
}

export function parseHausUndGrundKiel(html, source = sourceById('hug-kiel')) {
  const pair = (part, label) => first(part, new RegExp(`<span class="(?:text-muted|fw-bold)">\\s*${label}\\s*<\\/span>\\s*<span class="(?:text-muted|fw-bold)">([\\s\\S]*?)<\\/span>`, 'u'));
  return String(html || '').split('class="property col').slice(1).map(part => {
    const type = first(part, /<p class="text-muted small mb-2">([^<]*)<\/p>/u) || '';
    const rooms = pair(part, 'Zimmer');
    const address = first(part, /<\/svg>([^<]*)<\/p>/u);
    // The Kiel association also lists a few flats outside Schleswig-Holstein.
    if (PARKING_OR_COMMERCIAL.test(type) || !rooms || !addressParts(address).postcode) return null;
    const url = absolute(source.base, first(part, /href="(\/verein\/kiel\/immobilien-angebot\/[^"]+)"/u));
    return listing(source, {
      id:/\/(\d+)$/u.exec(url || '')?.[1],
      title:first(part, /<h6 class="card-title[^"]*">([\s\S]*?)<\/h6>/u),
      address,
      rooms,
      area:pair(part, 'Wohnfläche'),
      price:pair(part, 'Kaltmiete'),
      warmPrice:pair(part, 'Warmmiete'),
      image:absolute(source.base, first(part, /<img src="([^"]+)"/u)),
      url
    });
  }).filter(Boolean);
}

const PARSERS = Object.freeze({
  wankendorfer:parseWankendorfer, trave:parseTrave, 'wobau-neumuenster':parseWobauNeumuenster,
  fab:parseFab, 'wbg-kiel-ost':parseWbgKielOst, 'luebecker-bauverein':parseLuebeckerBauverein, 'neue-luebecker':parseNeueLuebecker,
  'woge-kiel':parseWogeKiel, adlershorst:parseAdlershorst, 'big-verwaltung':parseBigVerwaltung, 'wodi-dithmarschen':parseWodiDithmarschen,
  zbvv:parseZbvv, 'hug-kiel':parseHausUndGrundKiel
});

async function boundedText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTML_BYTES) { await reader.cancel().catch(() => {}); break; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

// A company that only lets in one town is asked only when that town can be
// in the result: inside the radius, or in the Jobcenter territory searched.
// A company with a town-specific list URL (ZBVV) is asked only for its towns.
// At most MAX_COMPANY_PAGES pages per search (the nearest companies first),
// so a 50 km search stays inside the provider subrequest share.
export const MAX_COMPANY_PAGES = 6;

export function companySourcesFor(criteria) {
  const origin = placeCoordinates(criteria?.location);
  const radius = Number(criteria?.radiusKm) || 25;
  const territory = nameKey(criteria?.districtJurisdiction || '');
  const location = nameKey(criteria?.location);
  // Distance of the company's nearest town; 0 when it lets in the searched
  // town or territory, null when it cannot be in the result.
  const reach = source => {
    if (source.pathFor) return source.pathFor(criteria) ? 0 : null;
    if (!source.near) return 0;
    const towns = [].concat(source.near);
    if (territory && [...towns, ...(source.districts || [])].some(town => nameKey(town) === territory)) return 0;
    if (towns.some(town => nameKey(town) === location)) return 0;
    const distances = towns.map(town => distanceKm(origin, placeCoordinates(town))).filter(distance => distance !== null && distance <= radius + 5);
    return distances.length ? Math.min(...distances) : null;
  };
  const reached = HOUSING_COMPANY_SOURCES.map((source, index) => ({ source, index, distance:reach(source) }))
    .filter(entry => entry.distance !== null);
  return reached
    .sort((a, b) => (a.distance - b.distance) || (a.index - b.index))
    .slice(0, MAX_COMPANY_PAGES)
    .sort((a, b) => a.index - b.index)
    .map(entry => entry.source);
}

// TG-RUNTIME-080 (ops reports 25.10.2026, "Житлові компанії 0/3"): one slow
// company page held the whole group past the 8.5 s source timeout, so the
// listings of every company were lost and only the group was counted as
// failed. Each page now has its own limit; a late one is dropped alone.
export const COMPANY_PAGE_TIMEOUT_MS = 6500;

export async function searchHousingCompanies(criteria, transport = fetch, { pageTimeoutMs = COMPANY_PAGE_TIMEOUT_MS } = {}) {
  const origin = placeCoordinates(criteria?.location);
  const sources = companySourcesFor(criteria);
  const pages = [];
  const results = await Promise.all(sources.map(source => {
    let timer;
    const started = Date.now();
    const controller = new AbortController();
    const late = new Promise(resolve => { timer = setTimeout(() => {
      controller.abort();
      pages.push({ reason:'timeout', httpStatus:0, durationMs:Date.now() - started, step:source.id });
      resolve([]);
    }, pageTimeoutMs); });
    return Promise.race([companyPage(source, criteria, transport, pages, controller.signal), late]).finally(() => clearTimeout(timer));
  }));
  const listings = results.flat().map(item => {
    const distance = distanceKm(origin, placeCoordinates(item.town));
    // Town-centre distance: good for the radius, too rough to show.
    return distance === null ? item : { ...item, distanceKm:distance, distanceApprox:true };
  });
  const answered = pages.some(page => page.httpStatus === 200);
  return { source:'Housing companies', status:answered ? 'ok' : (sources.length ? 'unavailable' : 'skipped'), listings, pages };
}

async function companyPage(source, criteria, transport, pages, signal) {
  const started = Date.now();
  const path = source.pathFor ? source.pathFor(criteria) : source.path;
  const context = { town:source.townFor ? source.townFor(criteria) : null };
  // A town-specific list is cached per town.
  const cacheKey = source.pathFor ? `${source.id}:${path}` : source.id;
  const cached = pageCache.get(cacheKey);
  if (cached && started - cached.at < PAGE_CACHE_TTL_MS) {
    pages.push({ reason:'cache', httpStatus:200, durationMs:0, matchedCount:cached.listings.length, step:source.id });
    return cached.listings;
  }
  try {
    const response = await transport(`${source.base}${path}`, {
      method:'GET',
      cache:'no-store',
      signal,
      headers:{ 'user-agent':USER_AGENT, accept:'text/html', 'accept-language':'de-DE' }
    });
    if (signal?.aborted) return [];
    if (!response?.ok) {
      pages.push({ reason:`http_${Number(response?.status) || 0}`, httpStatus:Number(response?.status) || 0, durationMs:Date.now() - started, step:source.id });
      return [];
    }
    const html = await boundedText(response);
    if (signal?.aborted) return [];
    const parsed = PARSERS[source.id](html, source, context);
    if (parsed.length) pageCache.set(cacheKey, { at:started, listings:parsed });
    pages.push({ reason:parsed.length ? 'ok' : 'no_listings', httpStatus:200, bytesReceived:html.length, durationMs:Date.now() - started, matchedCount:parsed.length, step:source.id });
    return parsed;
  } catch (error) {
    // A page stopped by its time limit is already logged as "timeout".
    if (signal?.aborted) return [];
    pages.push({ reason:'source_exception', error:String(error?.message || error).slice(0, 120), httpStatus:0, durationMs:Date.now() - started, step:source.id });
    return [];
  }
}
