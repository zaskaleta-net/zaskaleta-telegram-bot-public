import test from 'node:test';
import assert from 'node:assert/strict';
import { searchDistrictHousing } from '../src/runtime-jobcenter-base.mjs';

// Issue #63 (phone smoke 17.10.2026): the whole-Kreis search from Trittau showed
// "Wohnen auf dem Dorf mit Balkon — 23843 Travenbrück · 📍 ≈7 км" under
// "Стартова точка: Trittau". Kleinanzeigen's "(7 km)" was measured from the
// Reinfeld anchor that found the ad; Travenbrück is not 7 km from Trittau,
// and the 15 km radius search from Trittau rightly did not return it.

function card(id, { city, plz, title, price, rooms, area }) {
  return `<article class="aditem" data-adid="${id}">
    <div class="aditem-image"><a href="/s-anzeige/x/${id}-203-477"><img src="https://img.kleinanzeigen.de/api/v1/prod-ads/images/${id}.jpg"></a></div>
    <div class="aditem-main">
      <div>${plz} ${city}</div>
      <h2><a href="/s-anzeige/x/${id}-203-477">${title}</a></h2>
      <p>Objektbeschreibung für die angebotene Mietwohnung.</p>
      <p>${area} m² · ${rooms} Zi.</p>
      <p>${price} €</p>
    </div>
  </article>`;
}

function transportFor(pages) {
  const requested = [];
  const transport = async url => {
    const target = String(url);
    requested.push(target);
    for (const [pattern, html] of pages) {
      if (pattern.test(target)) return new Response(html, { headers:{ 'content-type':'text/html; charset=utf-8' } });
    }
    return new Response('unavailable', { status:503 });
  };
  return { transport, requested };
}

const criteria = { location:'Trittau', rooms:'3-4', amount:1138.5, persons:4, districtJurisdiction:'Stormarn' };

test('#63 a distance measured from another district anchor is not shown as distance from the start point', async () => {
  const travenbrueck = card('3100000001', { city:'Travenbrück(7 km)', plz:'23843', title:'Wohnen auf dem Dorf mit Balkon', price:860, rooms:3, area:82 });
  const { transport } = transportFor([[/locationId=761|reinfeld/iu, travenbrueck]]);
  const result = await searchDistrictHousing(criteria, {}, transport);
  const found = result.listings.find(item => /Wohnen auf dem Dorf/u.test(item.title));
  assert.ok(found, `the Reinfeld anchor result reaches the district list: ${JSON.stringify(result.sources)}`);
  assert.equal(found.distanceKm ?? null, null, 'Kleinanzeigen measured 7 km from Reinfeld, not from Trittau');
});

test('#63 a distance measured from the start point itself is kept', async () => {
  const local = card('3100000002', { city:'Trittau(2 km)', plz:'22946', title:'Helle Wohnung am Park', price:900, rooms:3, area:80 });
  const { transport } = transportFor([[/locationId=10410|trittau/iu, local]]);
  const result = await searchDistrictHousing(criteria, {}, transport);
  const found = result.listings.find(item => /Helle Wohnung am Park/u.test(item.title));
  assert.ok(found, JSON.stringify(result.sources));
  assert.equal(found.distanceKm, 2);
});

test('#63 Kleinanzeigen gets a whole-euro maxPrice (943.8 was read as 9438)', async () => {
  const { transport, requested } = transportFor([]);
  await searchDistrictHousing(criteria, {}, transport);
  const strict = requested.filter(url => /s-suchanfrage\.html/u.test(url));
  assert.ok(strict.length, 'the strict location search runs');
  for (const url of strict) assert.equal(new URL(url).searchParams.get('maxPrice'), '1139', url);
});
