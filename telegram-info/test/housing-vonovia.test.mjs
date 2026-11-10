import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { vonoviaListings, vonoviaListUrl, searchVonoviaHousing, clearVonoviaCache } from '../src/housing-vonovia.mjs';
import { placeCoordinates } from '../src/housing-company-sources.mjs';

const KIEL = JSON.parse(readFileSync(new URL('./fixtures/vonovia-kiel-2026-10-17.json', import.meta.url), 'utf8'));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json' } });

test('Vonovia results become Kaltmiete listings with real distance and a detail link', () => {
  const listings = vonoviaListings(KIEL, placeCoordinates('Kiel'));
  assert.equal(listings.length, 4);
  const first = listings[0];
  assert.equal(first.source, 'Vonovia');
  assert.equal(first.sourceId, 'vonovia');
  assert.equal(first.priceType, 'Kaltmiete');
  assert.equal(first.price, 825.27);
  assert.equal(first.rooms, '3');
  assert.equal(first.town, 'Kiel');
  assert.equal(first.postcode, '24146');
  assert.match(first.location, /^Lechweg 95, 24146 Kiel \(Elmschenhagen\)$/u);
  assert.equal(first.url, 'https://www.vonovia.de/zuhause-finden/immobilien/schoene-wohnung-grosszuegige-3-zimmer-wohnung-81-1355030001');
  assert.ok(Number.isFinite(first.distanceKm) && first.distanceKm < 15);
  assert.equal(first.distanceApprox, undefined);
  assert.match(first.imageUrl, /^https:\/\/cdn\.expose\.vonovia\.de\//u);
});

test('Vonovia: purchase offers, foreign postcodes and broken ids are dropped', () => {
  const base = KIEL.results[0];
  const data = { results:[
    { ...base, vermarktungsart_miete:'0' },
    { ...base, plz:'44787' },
    { ...base, wrk_id:'x' },
    { ...base, preis:0 }
  ] };
  assert.deepEqual(vonoviaListings(data, null), []);
});

test('Vonovia search: token then list with the search token header; cached per town', async () => {
  clearVonoviaCache();
  const calls = [];
  const transport = async (url, options = {}) => {
    calls.push({ url:String(url), token:options.headers?.['X-VON-Search-Token'] || null });
    if (String(url).endsWith('/api/real-estate/search-token')) return json({ token:'1792229853.abcdef0123456789', ttl:900 });
    if (String(url).startsWith('https://www.vonovia.de/api/real-estate/list?')) return json(KIEL);
    return json({}, 404);
  };
  const result = await searchVonoviaHousing({ location:'Kiel', amount:900 }, transport);
  assert.equal(result.status, 'ok');
  assert.equal(result.listings.length, 4);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, vonoviaListUrl('Kiel'));
  assert.equal(calls[1].token, '1792229853.abcdef0123456789');
  assert.equal((await searchVonoviaHousing({ location:'Kiel', amount:900 }, transport)).pages[0].reason, 'cache');
  assert.equal(calls.length, 2);
  clearVonoviaCache();
});

test('Vonovia search: an unknown town is skipped, a failed token is unavailable', async () => {
  clearVonoviaCache();
  assert.equal((await searchVonoviaHousing({ location:'Atlantis' }, async () => json({}))).status, 'skipped');
  const failed = await searchVonoviaHousing({ location:'Kiel' }, async () => json({}, 503));
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.pages[0].step, 'vonovia');
  clearVonoviaCache();
});
