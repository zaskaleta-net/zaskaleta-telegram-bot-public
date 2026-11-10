// Housing companies that publish their offers through the Immomio homepage
// widget (verified 14.10.2026). The widget is a JS app, but its GraphQL API
// answers a plain POST. The tokens are the public ones embedded in each
// company's own listing page (no expiry claim); if a company changes its
// token, the source answers with an error and the daily report shows it.
import { placeCoordinates, distanceKm } from './housing-company-sources.mjs';

const ENDPOINT = 'https://gql-hp.immomio.com/homepage/graphql';
const PAGE_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 512 * 1024;
const QUERY = 'query propertyList($input: HomepagePropertySearchRequest!){propertyList(input:$input){page{totalElements} nodes{name totalRooms size totalRentGross objectId applicationLink propertyType marketingType wbs titleImage{url} address{street houseNumber zipCode city district}}}}';

export const IMMOMIO_SOURCES = Object.freeze([
  Object.freeze({ id:'gewoba-nord', label:'GEWOBA Nord', token:'eyJhbGciOiJIUzI1NiJ9.eyJjdXN0b21lcklkIjoxNDcxNTI4MzI3LCJjcmVhdGVkIjoxNzUwMjQyNDgxNTQyLCJpZCI6MTQ3Njg1MTM3OX0.mDHY0oNEEGimpBIq_ZdX1TPHmw1Jll3lq4O8beoF8eQ', near:null }),
  Object.freeze({ id:'bgs-sachsenwald', label:'BGS Sachsenwald', token:'eyJhbGciOiJIUzI1NiJ9.eyJjdXN0b21lcklkIjoxMDc4MjcxLCJjcmVhdGVkIjoxNzc3NDQ2NDY3MDAwLCJpZCI6Mjk4NTIxNTA1OH0.RsAS0_eOUw0Qp-Nv9lm0IVVHJIJlleiUge5THaYxPE4', near:'Reinbek' }),
  Object.freeze({ id:'neue-gewoge', label:'Neue GeWoGe', token:'eyJhbGciOiJIUzI1NiJ9.eyJjdXN0b21lcklkIjoxMjEwNzQ5MzM2LCJpZCI6MTIyMjk5MTM5NiwiY3JlYXRlZCI6MTczMzc0NzU2NTc3Nn0.mAEovitG83IRNodt3WZOaYrWcy6-3P6ZUCaq4kTLRg0', near:'Pinneberg' })
]);

const cache = new Map();
export function clearImmomioCache() { cache.clear(); }

function nameKey(value) {
  return String(value || '').toLocaleLowerCase('de-DE').replace(/ä/gu, 'ae').replace(/ö/gu, 'oe').replace(/ü/gu, 'ue').replace(/ß/gu, 'ss').normalize('NFKD').replace(/[^a-z0-9]/gu, '');
}

// GEWOBA Nord lets in many northern towns (one request); the others are
// asked only when their town can be in the result.
export function immomioSourcesFor(criteria) {
  const origin = placeCoordinates(criteria?.location);
  const radius = Number(criteria?.radiusKm) || 25;
  const territory = nameKey(criteria?.districtJurisdiction || '');
  return IMMOMIO_SOURCES.filter(source => {
    if (!source.near) return true;
    if (nameKey(source.near) === nameKey(criteria?.location)) return true;
    if (territory && nameKey(source.near) === territory) return true;
    const distance = distanceKm(origin, placeCoordinates(source.near));
    return distance !== null && distance <= radius + 10;
  });
}

export function immomioListings(source, data) {
  const nodes = Array.isArray(data?.data?.propertyList?.nodes) ? data.data.propertyList.nodes : [];
  return nodes.map(node => {
    if (node?.propertyType !== 'FLAT' || node?.marketingType !== 'RENT') return null;
    const price = Number(node.totalRentGross);
    const url = String(node.applicationLink || '');
    if (!Number.isFinite(price) || price <= 0 || !/^https:\/\/tenant\.immomio\.com\/apply\/[0-9a-f-]+$/u.test(url)) return null;
    const address = node.address || {};
    const postcode = /^\d{5}$/u.test(String(address.zipCode || '')) ? String(address.zipCode) : null;
    // Only Schleswig-Holstein / Hamburg-border postcodes.
    if (postcode && !/^2[0-5]/u.test(postcode)) return null;
    const town = String(address.city || '').trim() || null;
    const rooms = Number(node.totalRooms);
    const area = Number(node.size);
    const image = String(node.titleImage?.url || '');
    return {
      id:`${source.id}:${node.objectId || url}`,
      source:source.label,
      sourceId:source.id,
      title:String(node.name || '').replace(/\s+/gu, ' ').trim().slice(0, 140) || 'Wohnung',
      price,
      priceType:'Gesamtmiete',
      rooms:Number.isFinite(rooms) && rooms > 0 ? String(rooms) : null,
      areaSqm:Number.isFinite(area) && area > 0 ? Math.round(area * 100) / 100 : null,
      location:[postcode, town].filter(Boolean).join(' ') + (address.district ? ` (${String(address.district).trim()})` : ''),
      postcode,
      town,
      imageUrl:/^https:\/\//u.test(image) ? image : null,
      url
    };
  }).filter(Boolean);
}

async function boundedJson(response) {
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('response too large');
  return JSON.parse(text);
}

export async function searchImmomioHousing(criteria, transport = fetch) {
  const origin = placeCoordinates(criteria?.location);
  const sources = immomioSourcesFor(criteria);
  const pages = [];
  const results = await Promise.all(sources.map(async source => {
    const started = Date.now();
    const cached = cache.get(source.id);
    if (cached && started - cached.at < PAGE_CACHE_TTL_MS) {
      pages.push({ reason:'cache', httpStatus:200, durationMs:0, matchedCount:cached.listings.length, step:source.id });
      return cached.listings;
    }
    try {
      const response = await transport(ENDPOINT, {
        method:'POST',
        headers:{ 'content-type':'application/json', accept:'application/json' },
        body:JSON.stringify({ query:QUERY, variables:{ input:{ token:source.token, page:0, size:100 } } })
      });
      if (!response?.ok) {
        pages.push({ reason:`http_${Number(response?.status) || 0}`, httpStatus:Number(response?.status) || 0, durationMs:Date.now() - started, step:source.id });
        return [];
      }
      const data = await boundedJson(response);
      if (Array.isArray(data?.errors) && data.errors.length) {
        pages.push({ reason:'api_error', httpStatus:200, durationMs:Date.now() - started, step:source.id });
        return [];
      }
      const listings = immomioListings(source, data);
      cache.set(source.id, { at:started, listings });
      pages.push({ reason:listings.length ? 'ok' : 'no_listings', httpStatus:200, durationMs:Date.now() - started, matchedCount:listings.length, step:source.id });
      return listings;
    } catch (error) {
      pages.push({ reason:'source_exception', error:String(error?.message || error).slice(0, 120), httpStatus:0, durationMs:Date.now() - started, step:source.id });
      return [];
    }
  }));
  const listings = results.flat().map(item => {
    const distance = distanceKm(origin, placeCoordinates(item.town));
    return distance === null ? item : { ...item, distanceKm:distance, distanceApprox:true };
  });
  return { source:'Immomio', status:pages.some(page => page.httpStatus === 200) ? 'ok' : (sources.length ? 'unavailable' : 'skipped'), listings, pages };
}
