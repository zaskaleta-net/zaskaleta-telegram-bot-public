import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeListings, crossPortalFingerprint, crossPortalSeenKey, seenOnOtherPortal } from '../src/listing-dedup.mjs';
import { mergePrimaryListings } from '../src/housing-primary-search.mjs';
import { mergeDistrictListings, filterUnseenDistrictListings, listingStateKey } from '../src/runtime-jobcenter.mjs';

const ka = { title:'Schöne 3-Zimmer-Wohnung mit Balkon', price:600, areaSqm:58, rooms:'3', location:'24143 Gaarden', url:'https://www.kleinanzeigen.de/s-anzeige/x/111-203-702', sourceId:'kleinanzeigen-public' };
const om = { title:'Helle 3 Zi. Whg. in Kiel-Gaarden', price:600, areaSqm:58.2, rooms:3, location:'24143 Kiel', url:'https://www.ohne-makler.net/immobilie/222/', imageUrl:'https://img.example/om.jpg', distanceKm:1.1, sourceId:'ohne-makler-public' };

test('the same flat on two portals is shown once, the better-described copy wins', () => {
  const out = dedupeListings([ka, om]);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, om.url, 'the copy with a photo and distance is kept');
  assert.equal(crossPortalFingerprint(ka), crossPortalFingerprint(om));
});

test('identical units of one landlord on one portal both stay (Rendsburg, 13.10.2026)', () => {
  const a = { title:'Moderne 3-Zimmer-Wohnung mit EBK', price:509, areaSqm:52.51, rooms:3, location:'24768 Rendsburg', url:'https://www.ohne-makler.net/immobilie/496160/' };
  const b = { title:'Herbstliche Ersparnis: Schicke 3-Zimmer-Wohnung', price:509, areaSqm:52.51, rooms:3, location:'24768 Rendsburg', url:'https://www.ohne-makler.net/immobilie/496162/' };
  assert.equal(dedupeListings([a, b]).length, 2);
  // ...and a copy of one of them on another portal is still recognised.
  const c = { ...a, title:'3 Zimmer Rendsburg', url:'https://www.kleinanzeigen.de/s-anzeige/y/333-203-496' };
  assert.equal(dedupeListings([a, b, c]).length, 2);
});

test('different flats are never merged', () => {
  const other = { ...om, price:650, url:'https://www.ohne-makler.net/immobilie/999/' };
  const noArea = { ...ka, areaSqm:null, url:'https://www.kleinanzeigen.de/s-anzeige/z/444-203-1' };
  assert.equal(dedupeListings([ka, other]).length, 2);
  assert.equal(dedupeListings([noArea, om]).length, 2, 'without an area the identity is unknown, nothing is merged');
  assert.equal(dedupeListings([ka, { ...ka, url:ka.url + '?utm=x' }]).length, 1, 'tracking parameters are ignored');
});

test('both merge paths use the cross-portal check', () => {
  assert.equal(mergePrimaryListings([[ka], [om]]).length, 1);
  assert.equal(mergeDistrictListings([[ka], [om]], 'Kiel', 12).length, 1);
});

test('a flat shown in the radius search does not return from another portal in the whole-Kreis search', () => {
  const seen = [listingStateKey(ka), crossPortalSeenKey(ka)];
  assert.equal(seenOnOtherPortal(om, seen), true);
  assert.deepEqual(filterUnseenDistrictListings([ka, om, { ...om, price:700, url:'https://www.ohne-makler.net/immobilie/777/' }], seen).map(item => item.price), [700]);
});

test('one portal does not fill a whole page: sources are dealt out round-robin', async () => {
  const { interleaveBySource } = await import('../src/housing-primary-search.mjs');
  const z = n => ({ url:`https://www.zbvv.de/immobilien/${n}/`, price:400 + n });
  const k = n => ({ url:`https://www.kleinanzeigen.de/s-anzeige/${n}`, price:500 + n });
  assert.deepEqual(interleaveBySource([z(1), z(2), z(3), k(1), k(2)]).map(item => item.url.includes('zbvv') ? 'z' : 'k').join(''), 'zkzkz');
});

test('a town-centre distance filters by radius but is not shown on the card', async () => {
  const { housingListingMedia } = await import('../src/housing-provider-base.mjs');
  const media = housingListingMedia({ status:'ok', listings:[
    { title:'A', price:450, location:'Kiel-Mettenhof', rooms:'2', areaSqm:50, distanceKm:0, distanceApprox:true, url:'https://www.zbvv.de/immobilien/a/', imageUrl:'https://img.example/a.jpg' },
    { title:'B', price:460, location:'24143 Kiel', rooms:'2', areaSqm:50, distanceKm:1.2, url:'https://www.kleinanzeigen.de/s-anzeige/b/1-203-1', imageUrl:'https://img.example/b.jpg' }
  ] });
  const captions = (Array.isArray(media) ? media : media?.items || []).map(item => String(item.caption || item.text || ''));
  assert.ok(captions.length >= 2, JSON.stringify(media).slice(0, 200));
  assert.doesNotMatch(captions[0], /📍/u);
  assert.match(captions[1], /📍 ≈1,2 км/u);
});
