import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWgGesuchtList, searchWgGesuchtHousing, clearWgGesuchtCache } from '../src/housing-wg-gesucht.mjs';

// TG-RUNTIME-080: the ops reports of 25.–26.10.2026 showed WG-Gesucht 85/0
// (every request answered) but no listing ever reached a search: the portal
// changed its list cards to <a id="liste-details-ad-N" class="wgg-list-card">,
// and the parser still looked for <div id="liste-details-ad-N">.

const NEW = readFileSync(new URL('./fixtures/wg-gesucht-kiel-cards-2026-10-27.html', import.meta.url), 'utf8');
const OLD = readFileSync(new URL('./fixtures/wg-gesucht-rendsburg-radius-2026-10-14.html', import.meta.url), 'utf8');

test('#080 the new WG-Gesucht cards are read: price, rooms, size, town, street, link, photo', () => {
  const listings = parseWgGesuchtList(NEW);
  assert.ok(listings.length >= 6, `parsed ${listings.length}`);
  const first = listings.find(item => item.id === 'wg-gesucht:6065412');
  assert.deepEqual({ price:first.price, rooms:first.rooms, areaSqm:first.areaSqm, town:first.town, location:first.location, priceType:first.priceType }, {
    price:588, rooms:'1', areaSqm:26, town:'Kiel', location:'Kiel Südfriedhof, Michelsenstraße 27', priceType:'Gesamtmiete'
  });
  assert.equal(first.url, 'https://www.wg-gesucht.de/1-zimmer-wohnungen-in-Kiel-Suedfriedhof.6065412.html');
  assert.match(first.imageUrl, /^https:\/\/img\.wg-gesucht\.de\//u);
  const two = listings.find(item => item.id === 'wg-gesucht:14138984');
  assert.equal(two.rooms, '2');
  assert.equal(two.price, 680);
});

test('#080 student dorm rooms and lets "auf Zeit" are no flats', () => {
  const titles = parseWgGesuchtList(NEW).map(item => item.title);
  assert.ok(!titles.some(title => /wohnheim|auf zeit/iu.test(title)), titles.join(' | '));
});

test('#080 the old card layout is still read', () => {
  assert.ok(parseWgGesuchtList(OLD).length > 0);
});

test('#080 a search with the new layout returns listings', async () => {
  clearWgGesuchtCache();
  const transport = async url => String(url).includes('/api/location/cities/names/')
    ? new Response(JSON.stringify({ _embedded:{ cities:[{ city_id:'71', city_name:'Kiel', federated_state_id:'13' }] } }), { status:200 })
    : new Response(NEW, { status:200, headers:{ 'content-type':'text/html' } });
  const result = await searchWgGesuchtHousing({ location:'Kiel', rooms:1, amount:900, type:'Warmmiete', radiusKm:10 }, transport);
  assert.equal(result.status, 'ok');
  assert.ok(result.listings.length >= 6, `listings ${result.listings.length}`);
  assert.ok(result.listings.every(item => item.distanceKm !== undefined), 'a distance for the radius filter');
});

// Review findings (#080 round 1).
test('#080 the fixture carries no advertiser names or profile photos', () => {
  assert.doesNotMatch(NEW, /user_photo|user-name"|profile_image/u);
});

test('#080 the not-for-living filter keeps real flats and drops rooms', async () => {
  const card = (id, title, type = '2-Zimmer-Wohnung') => `<a id="liste-details-ad-${id}" class="wgg-list-card" data-id="${id}" href="/wohnungen-in-Kiel.${id}.html" aria-label="${title}"><div class="card-content"><div class="price-row"><div><span class="card-main-text">600 &euro;</span></div></div><h2><span class="card-main-text ad-title">${title}</span></h2><div class="card-subtitle ad-subtitle noprint" title="${type} · Kiel Wik · Teststraße 1"><span></span></div><div class="card-subtitle vertical-align-center noprint middle-row"><div><span class="size-value">50 m&sup2;</span></div><div>01.11.2026</div></div><div class="vertical-align-center noprint bottom-card"></div></div></a>`;
  const html = [card(1, '2 Zi an der Wohnheimstraße'), card(2, 'Mietwohnung - nicht auf Zeit'), card(3, 'Wohnung im ehem. Schwesternwohnheim, saniert'),
    card(4, 'Zimmer in einer Frauen-WG'), card(5, 'Einzelzimmer, eigenes Bad'), card(6, 'Möbliertes Apartment auf Zeit'), card(1, '2 Zi an der Wohnheimstraße'),
    card(7, 'Ruhige Wohnung', '2-Zimmer-Wohnung').replace('01.11.2026', '01.01.2027-01.03.2027'), card(8, '3-Zimmer-Wohnung, ideal für Studenten-WG'),
    card(9, 'Zimmer im Studierendenwohnheim Kiel'), card(10, 'Wohnheimzimmer frei')].join('\n');
  const ids = parseWgGesuchtList(html).map(item => item.id.replace('wg-gesucht:', ''));
  assert.deepEqual(ids, ['1', '2', '3', '8'], 'kept flats, one premium duplicate removed, rooms and a dated let dropped');
});

// TG-RUNTIME-080 (ops reports 25.10.2026, "Житлові компанії 0/3").
test('#080 one slow housing-company page no longer loses the other companies', async () => {
  const { searchHousingCompanies, companySourcesFor } = await import('../src/housing-company-sources.mjs');
  const criteria = { location:'Kiel', rooms:2, amount:900, type:'Warmmiete', radiusKm:10 };
  const sources = companySourcesFor(criteria);
  assert.ok(sources.length >= 2, 'several companies for Kiel');
  const slow = sources[0];
  const transport = (url, options = {}) => String(url).startsWith(slow.base)
    ? new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    : Promise.resolve(new Response('<html><body>keine Angebote</body></html>', { status:200 }));
  const started = Date.now();
  const result = await searchHousingCompanies(criteria, transport, { pageTimeoutMs:200 });
  assert.ok(Date.now() - started < 2000, 'the group is not held by the slow page');
  assert.equal(result.status, 'ok', 'the other companies answered');
  const slowPages = result.pages.filter(page => page.step === slow.id);
  assert.deepEqual(slowPages.map(page => page.reason), ['timeout'], 'the slow page is logged once, as its own timeout');
  assert.ok(result.pages.some(page => page.step !== slow.id && page.httpStatus === 200));
});
