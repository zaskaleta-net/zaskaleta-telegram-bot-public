import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseOhneMaklerPage,
  searchOhneMaklerHousing,
  ohneMaklerSearchUrls,
  ohneMaklerLocation
} from '../src/housing-ohne-makler.mjs';
import { filterPrimaryListings } from '../src/housing-primary-search.mjs';

// Trimmed captures of www.ohne-makler.net (2026-10-11), see the HTML comments.
const SIMILAR = readFileSync(new URL('./fixtures/ohne-makler-trittau-similar.html', import.meta.url), 'utf8');
const RADIUS25 = readFileSync(new URL('./fixtures/ohne-makler-trittau-radius25.html', import.meta.url), 'utf8');
const html = body => new Response(body, { status:200, headers:{ 'content-type':'text/html; charset=utf-8' } });

test('ohne-makler cards yield title, price, rooms, area, PLZ Ort, photo, link and measured distance', () => {
  const { listings, recognized, parsedCount } = parseOhneMaklerPage(RADIUS25, { location:'Trittau', rooms:'1-4', amount:2100, radiusKm:25 });
  assert.equal(recognized, true);
  assert.equal(parsedCount, 5);
  const reinfeld = listings.find(item => item.id === '498456');
  assert.deepEqual(
    { title:reinfeld.title, price:reinfeld.price, rooms:reinfeld.rooms, areaSqm:reinfeld.areaSqm, location:reinfeld.location, url:reinfeld.url },
    { title:'2 Zi. Neubauwohnung', price:772, rooms:2, areaSqm:53.25, location:'23858 Reinfeld (Holstein)', url:'https://www.ohne-makler.net/immobilie/498456/' }
  );
  assert.match(reinfeld.imageUrl, /^https:\/\/media\.ohne-makler\.net\//u);
  assert.ok(reinfeld.distanceKm > 20 && reinfeld.distanceKm < 25, String(reinfeld.distanceKm));
  assert.equal(listings.find(item => item.id === '502765').location, '22147 Hamburg, Rahlstedt');
  assert.equal(listings.find(item => item.id === '489585').location, '22946 Brunsbek, Kronshorst');
});

test('live ohne-makler markup links cards relatively and still yields the same listings', () => {
  const criteria = { location:'Trittau', rooms:'1-4', amount:2100, radiusKm:25 };
  const relative = RADIUS25.replaceAll('href="https://www.ohne-makler.net/immobilie/', 'href="/immobilie/');
  assert.notEqual(relative, RADIUS25);
  const absoluteIds = parseOhneMaklerPage(RADIUS25, criteria).listings.map(item => item.id).sort();
  const live = parseOhneMaklerPage(relative, criteria);
  assert.deepEqual(live.listings.map(item => item.id).sort(), absoluteIds);
  assert.ok(live.listings.every(item => item.url.startsWith('https://www.ohne-makler.net/immobilie/')));
});

test('the hidden autocomplete "Keine Ergebnisse gefunden" line does not mark an unparsed page as answered', () => {
  const autocomplete = '<ul><li x-show="statusMsg === \'no_results\'" class="status">Keine Ergebnisse gefunden</li></ul>';
  const page = parseOhneMaklerPage(`<html><body>${autocomplete}<div>geändertes Layout</div></body></html>`, { location:'Trittau', rooms:'1-4', amount:2100, radiusKm:25 });
  assert.equal(page.recognized, false);
  const empty = parseOhneMaklerPage(`<html><body>${autocomplete}<p>Keine Ergebnisse gefunden</p></body></html>`, { location:'Trittau', rooms:'1-4', amount:2100, radiusKm:25 });
  assert.equal(empty.recognized, true);
});

test('ohne-makler measured radius drops listings beyond the requested km', () => {
  const ids = parseOhneMaklerPage(RADIUS25, { location:'Trittau', rooms:'1-4', amount:2100, radiusKm:15 }).listings.map(item => item.id);
  assert.deepEqual(ids.sort(), ['489585', '500834']);
});

test('Hamburg and Lübeck "similar" fill-ins are filtered out of a Trittau (Stormarn) Jobcenter search', () => {
  const criteria = { location:'Trittau', rooms:'1-3', amount:1000, radiusKm:15, jobcenterJurisdiction:'Stormarn' };
  // Even with a generous portal radius the fill-ins must not survive the
  // Kreis boundary: Hamburg (Rahlstedt, Horn), Lübeck and Mölln (Lauenburg).
  const wide = parseOhneMaklerPage(SIMILAR, { ...criteria, radiusKm:100 }).listings;
  assert.equal(wide.length, 5);
  assert.ok(wide.every(item => item.surrounding === true));
  assert.deepEqual(filterPrimaryListings(wide, { ...criteria, radiusKm:100 }), []);
  assert.deepEqual(parseOhneMaklerPage(SIMILAR, criteria).listings, [], 'all fill-ins are beyond 15 km');
});

test('Stormarn listings from the radius page pass the Jobcenter filter; Hamburg and Lauenburg do not', () => {
  const criteria = { location:'Trittau', rooms:'2', amount:1100, radiusKm:25, jobcenterJurisdiction:'Stormarn' };
  const kept = filterPrimaryListings(parseOhneMaklerPage(RADIUS25, criteria).listings, criteria);
  assert.deepEqual(kept.map(item => item.location).sort(), ['23843 Bad Oldesloe', '23858 Reinfeld (Holstein)']);
});

test('a non-Jobcenter search keeps fill-ins only with a measured distance inside the radius', () => {
  const criteria = { location:'Trittau', rooms:'1-3', amount:1000, radiusKm:15 };
  const unmeasured = [{ id:'1', title:'Wohnung', price:500, rooms:2, location:'22143 Hamburg, Rahlstedt', sourceId:'ohne-makler-public', distanceKm:null, url:'https://www.ohne-makler.net/immobilie/1/' },
    { id:'2', title:'Wohnung', price:500, rooms:2, location:'22946 Trittau', sourceId:'ohne-makler-public', distanceKm:null, url:'https://www.ohne-makler.net/immobilie/2/' }];
  assert.deepEqual(filterPrimaryListings(unmeasured, criteria).map(item => item.id), ['2']);
});

test('ohne-makler parsing is defensive: no cards, broken JSON and junk never throw', () => {
  const criteria = { location:'Trittau', rooms:'2', amount:800, radiusKm:15 };
  for (const page of ['', '<html><body>Keine passenden Angebote gefunden</body></html>', '<a href="https://www.ohne-makler.net/immobilie/1/">', '<script id="immobilien-geojson" type="application/json">{broken</script>' + SIMILAR.slice(0, 5000)]) {
    const parsed = parseOhneMaklerPage(page, criteria);
    assert.ok(Array.isArray(parsed.listings));
  }
  assert.equal(parseOhneMaklerPage('<p>Keine passenden Angebote gefunden</p>', criteria).recognized, true);
  assert.equal(ohneMaklerLocation(['820 €', 'Titel']), '');
});

test('ohne-makler search reads wohnung and haus pages with the portal radius and rejects foreign redirects', async () => {
  assert.deepEqual(ohneMaklerSearchUrls({ location:'Großensee', radiusKm:15 }), [
    'https://www.ohne-makler.net/immobilien/wohnung-mieten/schleswig-holstein/grossensee/?radius=25',
    'https://www.ohne-makler.net/immobilien/haus-mieten/schleswig-holstein/grossensee/?radius=25'
  ]);
  const seen = [];
  const result = await searchOhneMaklerHousing({ location:'Trittau', rooms:'2', amount:1100, radiusKm:25 }, async (url, options) => {
    seen.push({ url, redirect:options.redirect });
    if (url.includes('/haus-mieten/')) {
      const response = html(RADIUS25);
      Object.defineProperty(response, 'url', { value:'https://evil.example/' });
      return response;
    }
    return html(RADIUS25);
  });
  assert.equal(seen.length, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.pages[1].reason, 'rejected_redirect');
  assert.ok(result.listings.length >= 2);

  const failed = await searchOhneMaklerHousing({ location:'Trittau', rooms:'2', amount:1100, radiusKm:25 }, async () => { throw new Error('reset'); });
  assert.equal(failed.status, 'unavailable');
  assert.deepEqual(failed.listings, []);
});

test('ohne-makler body is bounded at 2 MB', async () => {
  let pulls = 0;
  const result = await searchOhneMaklerHousing({ location:'Trittau', rooms:'2', amount:1100, radiusKm:25 }, async () => new Response(new ReadableStream({
    pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(256 * 1024)); }
  }), { headers:{ 'content-type':'text/html' } }));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.pages[0].reason, 'response_too_large');
  assert.ok(pulls <= 20, String(pulls));
});
