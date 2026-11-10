import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseImmoScout24SearchPage,
  searchExpandedHousing,
  searchImmoScout24Housing,
  searchKipHousing
} from '../src/housing-expanded-v22.mjs';
import { SH_JURISDICTIONS } from '../src/jobcenter-jurisdictions.mjs';
import { SH_UKRAINIAN_PLACE_ROWS, placeRouteForJobcenter } from '../src/schleswig-holstein-place-names.mjs';

const REPRESENTATIVE_PLACES = Object.freeze({
  Dithmarschen:'Büsum',
  'Herzogtum Lauenburg':'Ratzeburg',
  Nordfriesland:'Husum',
  Ostholstein:'Eutin',
  Pinneberg:'Pinneberg',
  'Plön':'Plön',
  'Rendsburg-Eckernförde':'Rendsburg',
  'Schleswig-Flensburg':'Schleswig',
  Segeberg:'Bad Segeberg',
  Steinburg:'Itzehoe',
  Stormarn:'Trittau',
  Flensburg:'Flensburg',
  Kiel:'Kiel',
  Lübeck:'Lübeck',
  Neumünster:'Neumünster'
});

// A successful empty search has an explicit result marker; arbitrary HTTP 200 is insufficient.
function okHtml(html = '<html><body><p>Keine Wohnungen gefunden</p></body></html>') {
  return new Response(html, {
    status:200,
    headers:{ 'content-type':'text/html; charset=utf-8' }
  });
}

function criteria(location, overrides = {}) {
  return {
    location,
    rooms:'3-4',
    amount:1400,
    type:'Bruttokaltmiete',
    radiusKm:15,
    ...overrides
  };
}

test('statewide housing coverage includes all 11 Kreise and 4 kreisfreie Städte', () => {
  assert.equal(SH_JURISDICTIONS.length, 15);
  assert.deepEqual(
    new Set(Object.keys(REPRESENTATIVE_PLACES)),
    new Set(SH_JURISDICTIONS)
  );

  const coveredByPlaceRegistry = new Set(SH_UKRAINIAN_PLACE_ROWS.map(row => row.jurisdiction));
  for (const jurisdiction of SH_JURISDICTIONS) {
    assert.ok(coveredByPlaceRegistry.has(jurisdiction), `missing place coverage for ${jurisdiction}`);
  }
});

test('every curated Schleswig-Holstein place routes to its expected housing jurisdiction independently of KdU numeric coverage', () => {
  assert.ok(SH_UKRAINIAN_PLACE_ROWS.length >= 63);
  for (const row of SH_UKRAINIAN_PLACE_ROWS) {
    const resolved = placeRouteForJobcenter(row.canonical);
    assert.ok(resolved, `no housing route for ${row.canonical}`);
    assert.equal(resolved.jurisdiction, row.jurisdiction, `${row.canonical} routed to wrong jurisdiction`);
  }
});

test('ImmoScout24 search builds a Schleswig-Holstein search for every registered place, not only Büsum', async () => {
  for (const row of SH_UKRAINIAN_PLACE_ROWS) {
    const requested = [];
    const transport = async url => {
      requested.push(String(url));
      return okHtml();
    };
    const result = await searchImmoScout24Housing(criteria(row.canonical), transport);
    assert.equal(result.status, 'ok', `ImmoScout route unavailable for ${row.canonical}`);
    assert.equal(requested.length, 1, `unexpected ImmoScout request count for ${row.canonical}`);
    const url = new URL(requested[0]);
    assert.equal(url.hostname, 'www.immobilienscout24.de');
    assert.match(url.pathname, /^\/Suche\/de\/schleswig-holstein\//u, `not a Schleswig-Holstein path for ${row.canonical}`);
  }
});

test('KIP builds Schleswig-Holstein search pages for every registered place and tolerates empty result pages', async () => {
  for (const row of SH_UKRAINIAN_PLACE_ROWS) {
    const requested = [];
    const transport = async url => {
      requested.push(String(url));
      return okHtml();
    };
    const result = await searchKipHousing(criteria(row.canonical), transport);
    assert.equal(result.status, 'ok', `KIP route unavailable for ${row.canonical}`);
    assert.ok(requested.length >= 1, `no KIP request for ${row.canonical}`);
    for (const rawUrl of requested) {
      const url = new URL(rawUrl);
      assert.equal(url.hostname, 'www.kip.net');
      assert.match(url.pathname, /^\/schleswig-holstein\//u);
    }
  }
});

test('3–4 room filtering, direct expose links and German thousands prices work across every Schleswig-Holstein jurisdiction', () => {
  for (const [jurisdiction, location] of Object.entries(REPRESENTATIVE_PLACES)) {
    const html = [
      `<a href="/expose/${jurisdiction.length}01">Familienwohnung 900 € 74 m² 3 Zi. ${location}</a>`,
      `<a href="/expose/${jurisdiction.length}02">Große Familienwohnung 1.400 € 96 m² 4 Zi. ${location}</a>`,
      `<a href="/expose/${jurisdiction.length}03">Zu klein 650 € 51 m² 2 Zi. ${location}</a>`,
      `<a href="/expose/${jurisdiction.length}04">Zu teuer 1.401 € 100 m² 4 Zi. ${location}</a>`
    ].join('');

    const listings = parseImmoScout24SearchPage(html, criteria(location));
    assert.equal(listings.length, 2, `${jurisdiction} should keep exactly 3/4-room listings within 1.400 €`);
    assert.deepEqual(listings.map(item => item.rooms), [3, 4]);
    assert.deepEqual(listings.map(item => item.price), [900, 1400]);
    for (const item of listings) {
      assert.equal(item.location, location);
      assert.match(item.url, /^https:\/\/www\.immobilienscout24\.de\/expose\/\d+$/u);
      assert.match(item.summaryUk, /Перед зверненням перевірте Betriebskosten, Heizkosten/u);
    }
  }
});

test('exact room filters do not leak adjacent room counts', () => {
  const html = [
    '<a href="/expose/501">2 Zimmer 700 € 55 m² 2 Zi. Kiel</a>',
    '<a href="/expose/502">3 Zimmer 800 € 70 m² 3 Zi. Kiel</a>',
    '<a href="/expose/503">4 Zimmer 900 € 88 m² 4 Zi. Kiel</a>'
  ].join('');
  const listings = parseImmoScout24SearchPage(html, criteria('Kiel', { rooms:'3', amount:1000 }));
  assert.equal(listings.length, 1);
  assert.equal(listings[0].rooms, 3);
  assert.equal(listings[0].id, '502');
});

test('all housing sources fail soft when sites are unavailable', async () => {
  const transport = async () => { throw new Error('synthetic network outage'); };
  for (const location of Object.values(REPRESENTATIVE_PLACES)) {
    const result = await searchExpandedHousing(criteria(location), transport);
    assert.equal(result.status, 'unavailable', `${location} must fail soft`);
    assert.deepEqual(result.listings, []);
    assert.ok(Array.isArray(result.sources));
    // KIP + WoDi; ImmoScout24 is no longer fetched automatically.
    assert.ok(result.sources.length >= 2);
    assert.ok(!result.sources.some(source => source.source === 'ImmoScout24'));
    for (const link of result.searchLinks || []) {
      const url = new URL(link.url);
      assert.ok(['www.immobilienscout24.de', 'www.kip.net', 'www.wo-di.de'].includes(url.hostname));
      assert.equal(url.protocol, 'https:');
    }
  }
});

test('cross-host redirects are rejected instead of parsing an untrusted housing page', async () => {
  const transport = async () => ({
    ok:true,
    url:'https://evil.example/redirected-listings',
    headers:{ get: name => String(name).toLowerCase() === 'content-type' ? 'text/html' : null },
    text:async () => '<a href="/expose/999">4 Zimmer 800 € 90 m² 4 Zi.</a>'
  });
  const result = await searchImmoScout24Housing(criteria('Kiel'), transport);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.listings, []);
});

test('representative four-person searches keep direct listing URLs and never substitute generic pages as listings', () => {
  for (const location of Object.values(REPRESENTATIVE_PLACES)) {
    const html = `<a href="/expose/7777">Familienwohnung 1.250 € 92 m² 4 Zi. ${location}</a>`;
    const listings = parseImmoScout24SearchPage(html, criteria(location, { rooms:'4', amount:1400 }));
    assert.equal(listings.length, 1, `missing direct listing for ${location}`);
    assert.equal(listings[0].price, 1250);
    assert.equal(listings[0].rooms, 4);
    assert.equal(listings[0].url, 'https://www.immobilienscout24.de/expose/7777');
  }
});
