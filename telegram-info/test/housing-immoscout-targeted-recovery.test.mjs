import test from 'node:test';
import assert from 'node:assert/strict';
import { searchTargetedImmoScoutRecovery } from '../src/housing-immoscout-targeted-recovery.mjs';

function card(id, { city, price=600, rooms=3, area=70 } = {}) {
  return `<div class="listing-card card-listing-S">
    <a href="/expose/${id}"><img alt="" src="/preview.jpg"></a>
    <div class="card-attributes"><a href="/expose/${id}">
      <h2 data-testid="headline">Wohnung ${id}</h2>
      <div data-testid="attributes"><dl><dd>${price} €</dd></dl><dl><dd>${area} m²</dd></dl><dl><dd>${rooms} Zi.</dd></dl></div>
      <div data-testid="hybridViewAddress">${city}</div>
    </a></div></div>`;
}

function htmlResponse(html) {
  return new Response(html, { headers:{ 'content-type':'text/html; charset=utf-8', 'content-length':String(new TextEncoder().encode(html).length) } });
}

test('Lübeck exact-room recovery reads a room-scoped page after compacting large scripts', async () => {
  const criteria = { location:'Lübeck', rooms:'3', amount:680, radiusKm:15 };
  const fetched = [];
  const requests = [];
  const hugeScript = `<script>${'x'.repeat(3 * 1024 * 1024)}</script>`;
  const result = await searchTargetedImmoScoutRecovery(criteria, async (url, options) => {
    fetched.push(String(url));
    requests.push(options);
    return htmlResponse(hugeScript + card('170001', { city:'Lübeck', price:650, rooms:3, area:60 }));
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].id, '170001');
  assert.equal(result.listings[0].price, 650);
  assert.equal(fetched.length, 1);
  assert.match(fetched[0], /\/luebeck\/3-zimmer-wohnung-mieten$/u);
  assert.match(requests[0].headers['user-agent'], /Chrome\//u);
  assert.doesNotMatch(requests[0].headers['user-agent'], /Pomichnyk/iu);
  assert.match(requests[0].headers['accept-language'], /^de-DE/u);
});

test('Rendsburg 3-4 recovery fetches both exact room pages and merges direct candidates', async () => {
  const criteria = { location:'Rendsburg', rooms:'3-4', amount:1138.5, radiusKm:15 };
  const fetched = [];
  const result = await searchTargetedImmoScoutRecovery(criteria, async url => {
    const value = String(url);
    fetched.push(value);
    if (value.includes('/3-zimmer-wohnung-mieten')) return htmlResponse(card('180003', { city:'Rendsburg', price:640, rooms:3, area:72 }));
    if (value.includes('/4-zimmer-wohnung-mieten')) return htmlResponse(card('180004', { city:'Rendsburg', price:900, rooms:4, area:88 }));
    return new Response('not found', { status:404 });
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.listings.map(item => item.id).sort(), ['180003','180004']);
  assert.equal(fetched.length, 2);
  assert.ok(fetched.every(url => /rendsburg-eckernfoerde-kreis\/rendsburg\/[34]-zimmer-wohnung-mieten$/u.test(url)));
});

test('challenge page fails closed and never becomes an empty successful search', async () => {
  const criteria = { location:'Bad Segeberg', rooms:'3', amount:800, radiusKm:15 };
  const result = await searchTargetedImmoScoutRecovery(criteria, async () => htmlResponse('<h1>Verify you are human</h1><p>CAPTCHA</p>'));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.listings.length, 0);
  assert.equal(result.pages[0].reason, 'challenge');
});

test('other anti-bot wording is also classified as challenge', async () => {
  const criteria = { location:'Rendsburg', rooms:'3', amount:645.75, radiusKm:15 };
  const result = await searchTargetedImmoScoutRecovery(criteria, async () => htmlResponse('<h1>Unusual traffic</h1><p>Automated requests detected</p>'));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.pages[0].reason, 'challenge');
});
