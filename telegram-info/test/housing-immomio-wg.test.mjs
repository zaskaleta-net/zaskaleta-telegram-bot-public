import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { immomioListings, immomioSourcesFor, searchImmomioHousing, IMMOMIO_SOURCES, clearImmomioCache } from '../src/housing-immomio.mjs';
import { parseWgGesuchtList, pickWgCity, wgSearchUrl, wgCitySlug, searchWgGesuchtHousing, clearWgGesuchtCache } from '../src/housing-wg-gesucht.mjs';

const read = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const GEWOBA = JSON.parse(read('immomio-gewoba-nord-2026-10-14.json'));
const WG = read('wg-gesucht-rendsburg-radius-2026-10-14.html');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json' } });

test('Immomio: rented flats only, Gesamtmiete, the public apply link as URL', () => {
  const items = immomioListings(IMMOMIO_SOURCES[0], GEWOBA);
  assert.equal(items.length, 3, 'the commercial unit is skipped');
  assert.ok(items.every(item => item.priceType === 'Gesamtmiete' && /^https:\/\/tenant\.immomio\.com\/apply\//u.test(item.url)));
  const husum = items.find(item => item.town === 'Husum');
  assert.equal(husum.price, 746.06);
  assert.match(husum.location, /^25813 Husum/u);
});

test('Immomio: GEWOBA Nord is always asked, BGS only near Reinbek', () => {
  assert.deepEqual(immomioSourcesFor({ location:'Kiel', radiusKm:15 }).map(source => source.id), ['gewoba-nord']);
  assert.ok(immomioSourcesFor({ location:'Reinbek', radiusKm:10 }).some(source => source.id === 'bgs-sachsenwald'));
});

test('Immomio: an API error is reported, nothing is invented', async () => {
  clearImmomioCache();
  const found = await searchImmomioHousing({ location:'Husum', radiusKm:15 }, async () => json({ errors:[{ message:'token invalid' }] }));
  assert.equal(found.listings.length, 0);
  assert.equal(found.pages[0].reason, 'api_error');
});

test('WG-Gesucht: unbefristete whole flats with distance; temporary lets and Untermiete are skipped', () => {
  const items = parseWgGesuchtList(WG);
  assert.equal(items.length, 3);
  assert.deepEqual([items[0].price, items[0].priceType, items[0].rooms, items[0].areaSqm, items[0].distanceKm, items[0].town], [750, 'Gesamtmiete', '3', 72, 31, 'Neumünster']);
  assert.ok(items.every(item => /^https:\/\/www\.wg-gesucht\.de\//u.test(item.url)));
  assert.ok(!items.some(item => /Untermiete|DACHAPARTMENT/u.test(item.title)));
});

test('WG-Gesucht: city id from the portal autocomplete, radius URL around the town', () => {
  const city = pickWgCity({ _embedded:{ cities:[{ city_id:'1366', city_name:'Rendsburg', federated_state_id:'13' }, { city_id:'9', city_name:'Rendsburg', federated_state_id:'2' }] } }, 'Rendsburg');
  assert.equal(city.city_id, '1366');
  assert.equal(wgCitySlug('Lübeck'), 'Luebeck');
  const url = new URL(wgSearchUrl({ cityId:1366, cityName:'Rendsburg', lat:54.3, lon:9.66, radiusKm:25, maxRent:645.75 }));
  assert.match(url.pathname, /\/1-zimmer-wohnungen-und-wohnungen-in-Rendsburg\.1366\.1\+2\.1\.0\.html$/u);
  assert.equal(url.searchParams.get('radDis'), '25000');
  assert.equal(url.searchParams.get('rMax'), '646', 'TG-RUNTIME-051: rounded up; the bot filters the exact limit');
  assert.deepEqual(url.searchParams.getAll('rent_types[]'), ['2']);
});

test('WG-Gesucht: one autocomplete per town per instance, unknown towns are skipped', async () => {
  clearWgGesuchtCache();
  const calls = [];
  const transport = async url => {
    calls.push(String(url));
    if (String(url).includes('/api/location/cities/names/')) return json({ _embedded:{ cities:[{ city_id:'1366', city_name:'Rendsburg', federated_state_id:'13' }] } });
    return new Response(WG, { status:200, headers:{ 'content-type':'text/html' } });
  };
  const first = await searchWgGesuchtHousing({ location:'Rendsburg', radiusKm:50, amount:1200 }, transport);
  assert.equal(first.listings.length, 3);
  await searchWgGesuchtHousing({ location:'Rendsburg', radiusKm:50, amount:1200 }, transport);
  assert.equal(calls.filter(url => url.includes('/cities/names/')).length, 1);
  assert.equal((await searchWgGesuchtHousing({ location:'Atlantis', radiusKm:15 }, transport)).status, 'skipped');
});
