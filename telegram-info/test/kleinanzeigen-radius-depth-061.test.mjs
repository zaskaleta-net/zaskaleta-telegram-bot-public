import test from 'node:test';
import assert from 'node:assert/strict';
import { searchKleinanzeigenPublicRecovery } from '../src/housing-kleinanzeigen-public-recovery-base.mjs';

// Owner case 2026-10-19: Trittau, 4 persons, 3-4 rooms, 15 km. The Ahrensburg
// offer (887 €, ~12.6 km) was missing because the radius request carried
// swap_s=nein (live: 1 result instead of 30) and only 8 parsed cards survived.

function card(id, { city, plz, km, price, rooms = 3, area = 70 }) {
  const path = `/s-anzeige/3-zimmer-wohnung-${id}/${id}-203-922`;
  return `<article class="aditem" data-adid="${id}">
    <div class="aditem-main">
      <div>${plz} ${city}</div>
      <div>(${km} km)</div>
      <h2><a href="${path}">3-Zimmer-Wohnung zur Miete ${id}</a></h2>
      <p>${area} m² · ${rooms} Zi.</p>
      <p>${price} €</p>
    </div>
  </article>`;
}

const criteria = { location:'Trittau', rooms:'3-4', amount:900, radiusKm:15 };

test('radius request does not ask Kleinanzeigen to drop offers via swap_s', async () => {
  const requested = [];
  await searchKleinanzeigenPublicRecovery(criteria, async url => {
    requested.push(url);
    return new Response('<html></html>', { headers:{ 'content-type':'text/html' } });
  });
  const strict = requested.find(url => url.includes('s-suchanfrage.html'));
  assert.ok(strict, 'strict radius URL is requested');
  assert.doesNotMatch(decodeURIComponent(strict), /swap_s/u);
  assert.match(strict, /radius=15/u);
});

test('in-radius offer beyond the 8th card is kept (Ahrensburg 887 €, 12.6 km)', async () => {
  const cards = [];
  for (let i = 0; i < 22; i += 1) cards.push(card(String(3497000000 + i), { city:'Trittau', plz:'22946', km:'1', price:700 + i }));
  cards.push(card('3497859117', { city:'Ahrensburg', plz:'22926', km:'12,6', price:887 }));
  cards.push(card('3497859118', { city:'Hamburg', plz:'22041', km:'21', price:850 }));
  const html = `<html><body>${cards.join('\n')}</body></html>`;
  const result = await searchKleinanzeigenPublicRecovery(criteria, async () =>
    new Response(html, { headers:{ 'content-type':'text/html; charset=utf-8' } }));
  const urls = result.listings.map(item => item.url);
  assert.ok(urls.some(url => url.includes('3497859117')), 'Ahrensburg offer is returned');
  assert.ok(!urls.some(url => url.includes('3497859118')), 'offer outside the radius stays excluded');
  assert.ok(result.listings.length <= 30, 'result stays bounded');
});

test('expanded Kleinanzeigen search keeps the deep in-radius offer too', async () => {
  const { searchKleinanzeigenPublicRecovery: expanded } = await import('../src/housing-kleinanzeigen-public-expanded.mjs');
  const cards = [];
  for (let i = 0; i < 22; i += 1) cards.push(card(String(3497100000 + i), { city:'Trittau', plz:'22946', km:'1', price:700 + i, area:60 + i }));
  cards.push(card('3497859117', { city:'Ahrensburg', plz:'22926', km:'12,6', price:887 }));
  const html = `<html><body>${cards.join('\n')}</body></html>`;
  const result = await expanded(criteria, async url => new Response(url.includes('s-suchanfrage.html') ? html : '<html></html>',
    { headers:{ 'content-type':'text/html; charset=utf-8' } }), { budgetMs:4500, targetDirectListings:12, maxSupplementalPages:0 });
  assert.ok(result.listings.some(item => item.url.includes('3497859117')));
});
