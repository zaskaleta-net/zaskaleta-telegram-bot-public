import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchDistrictHousing, districtSummaryPayload, districtRecoveryPageCaps } from '../src/runtime-jobcenter-base.mjs';
import { listingTitle } from '../src/housing-provider-base.mjs';
import { topicGuidance } from '../src/topic-guidance.mjs';

// The Ohne-Makler capture with one card moved to Großensee (Stormarn, 620 €),
// as in housing-primary-search.test.mjs.
const OHNE_MAKLER_STORMARN = readFileSync(new URL('./fixtures/ohne-makler-trittau-radius25.html', import.meta.url), 'utf8')
  .replace('772 €', '620 €')
  .replace(/23858 Reinfeld\s*\(Reinfeld \(Holstein\)\)/u, '22946 Großensee')
  .replace('{"id":498456,"type":"Feature","geometry":{"type":"Point","coordinates":[10.50257,53.82654]}', '{"id":498456,"type":"Feature","geometry":{"type":"Point","coordinates":[10.3383,53.6106]}');
const html = body => new Response(body, { status:200, headers:{ 'content-type':'text/html; charset=utf-8' } });

// Production 2026-10-13 (Kiel, Rendsburg): the whole-Kreis search asked only
// Kleinanzeigen and found fewer flats than the 15 km radius search.
test('the whole-Kreis search asks the same portals as a radius search, ohne-makler included', async () => {
  const hosts = new Set();
  const transport = async url => {
    const target = String(url?.url || url);
    hosts.add(new URL(target).hostname);
    return html(target.includes('ohne-makler.net') ? OHNE_MAKLER_STORMARN : '<html><body></body></html>');
  };
  const found = await searchDistrictHousing({ location:'Trittau', rooms:'1-2', roomsMin:1, roomsMax:8, amount:700, type:'Bruttokaltmiete', radiusKm:null, districtJurisdiction:'Stormarn' }, {}, transport);
  assert.ok(hosts.has('www.ohne-makler.net'), [...hosts].join(','));
  assert.ok(found.listings.some(item => item.location === '22946 Großensee' && item.price === 620), JSON.stringify(found.listings.map(item => item.location)));
});

test('without an API key no provider calls are reserved for it', () => {
  assert.deepEqual(districtRecoveryPageCaps(4, 16, 0), [4, 4, 4, 4]);
  assert.deepEqual(districtRecoveryPageCaps(4, 16, 3), [1, 1, 1, 1]);
});

test('the whole-Kreis summary says how many offers were already shown in the radius search', () => {
  const text = districtSummaryPayload({ jurisdiction:'Kiel', listings:[{ location:'24143 Gaarden' }], total:1, alreadyShown:5 }).text;
  assert.match(text, /Ще 5 — ті самі оголошення, що вже були у пошуку за радіусом/u);
  assert.doesNotMatch(districtSummaryPayload({ jurisdiction:'Kiel', listings:[{ location:'Kiel' }], total:1 }).text, /Ще \d/u);
});

test('Markdown emphasis in a landlord title does not reach the caption', () => {
  assert.equal(listingTitle({ title:'**Herbstliche Ersparnis: 1 NKM FREI** Modern und gemütlich' }), 'Herbstliche Ersparnis: 1 NKM FREI Modern und gemütlich');
});

test('a transport route typed in Cyrillic with a dash is understood', () => {
  assert.match(topicGuidance('transport', 'Тріттау - Гамбург').text, /🧭 Trittau → Hamburg[\s\S]*hvv\.de/u);
  assert.match(topicGuidance('transport', 'з Тріттау до Гамбурга').text, /🧭 Trittau → Hamburg/u);
  assert.match(topicGuidance('transport', 'Кіль → Рендсбург').text, /🧭 Kiel → Rendsburg/u);
});
