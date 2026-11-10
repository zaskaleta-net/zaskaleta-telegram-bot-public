import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJobcenterSearchCriteria } from '../src/housing-active-v21.mjs';
import { districtAnchorLocations, mergeDistrictListings } from '../src/runtime-jobcenter.mjs';
import {
  filterHousingListingsToJurisdiction,
  jurisdictionForHousingLocation
} from '../src/housing-jurisdiction-scope.mjs';
import {
  SH_RUNTIME_MUNICIPALITY_INDEX_META,
  SH_RUNTIME_MUNICIPALITY_ROWS,
  SH_RUNTIME_MUNICIPALITY_JURISDICTIONS
} from '../src/sh-municipality-jurisdiction-runtime.mjs';

test('official municipality matcher distinguishes neighboring Jobcenter territories', () => {
  assert.equal(jurisdictionForHousingLocation('24782 Büdelsdorf'), 'Rendsburg-Eckernförde');
  assert.equal(jurisdictionForHousingLocation('24768 Rendsburg'), 'Rendsburg-Eckernförde');
  assert.equal(jurisdictionForHousingLocation('24103 Kiel'), 'Kiel');
  assert.equal(jurisdictionForHousingLocation('21465 Wentorf bei Hamburg'), 'Herzogtum Lauenburg');
  assert.equal(jurisdictionForHousingLocation('Hamburg'), null);

  const source = [
    { id:'a', location:'24782 Büdelsdorf' },
    { id:'b', location:'24768 Rendsburg' },
    { id:'c', location:'24103 Kiel' }
  ];
  assert.deepEqual(
    filterHousingListingsToJurisdiction(source, 'Rendsburg-Eckernförde', 'Rendsburg').map(item => item.id),
    ['a','b']
  );
  assert.deepEqual(
    filterHousingListingsToJurisdiction(source, 'Kiel', 'Kiel').map(item => item.id),
    ['c']
  );
});

test('kreisfreie city keeps city-scoped neighborhood cards but rejects other-place cards', () => {
  const source = [
    { id:'gaarden', sourceId:'kleinanzeigen-public', location:'24143 Gaarden', distanceKm:null },
    { id:'rendsburg', sourceId:'kleinanzeigen-public', location:'24768 Rendsburg', distanceKm:30 }
  ];
  assert.deepEqual(
    filterHousingListingsToJurisdiction(source, 'Kiel', 'Kiel').map(item => item.id),
    ['gaarden']
  );
});

test('district search text carries administrative scope without exposing 50 km semantics', () => {
  const text = [
    '🔎 Автопошук житла під Jobcenter — Kiel',
    'Осіб: 3',
    'Кімнати: 3',
    'Орієнтир пошуку Jobcenter Kiel: до 679 € Bruttokaltmiete — максимальна підтверджена межа серед зон цієї території; для конкретної громади норма перевіряється окремо.',
    'Heizkosten перевіряються окремо.',
    'Територія Jobcenter/Kreis: Kiel.',
    'Результати з інших Jobcenter/Kreis відсікаються.'
  ].join('\n');

  assert.doesNotMatch(text, /Радіус пошуку:\s*50\s*км/u);
  const parsed = parseJobcenterSearchCriteria(text);
  assert.equal(parsed?.location, 'Kiel');
  assert.equal(parsed?.districtJurisdiction, 'Kiel');
  assert.equal(parsed?.radiusKm, 50);
});


test('whole-district scope keeps only the origin Jobcenter/Kreis across representative borders', () => {
  const stormarn = [
    { id:'trittau', location:'22946 Trittau' },
    { id:'ahrensburg', location:'22926 Ahrensburg' },
    { id:'molln', location:'23879 Mölln' }
  ];
  assert.deepEqual(
    filterHousingListingsToJurisdiction(stormarn, 'Stormarn', 'Trittau').map(item => item.id),
    ['trittau','ahrensburg']
  );

  const rendsburg = [
    { id:'rendsburg', location:'24768 Rendsburg' },
    { id:'buedelsdorf', location:'24782 Büdelsdorf' },
    { id:'kiel', location:'24103 Kiel' }
  ];
  assert.deepEqual(
    filterHousingListingsToJurisdiction(rendsburg, 'Rendsburg-Eckernförde', 'Rendsburg').map(item => item.id),
    ['rendsburg','buedelsdorf']
  );
});


test('runtime municipality index is pinned to the full Schleswig-Holstein scope', () => {
  assert.equal(SH_RUNTIME_MUNICIPALITY_INDEX_META.version, '2026-03-31');
  assert.equal(SH_RUNTIME_MUNICIPALITY_INDEX_META.activeRows, 1104);
  assert.equal(SH_RUNTIME_MUNICIPALITY_ROWS.length, 1104);
  assert.equal(new Set(SH_RUNTIME_MUNICIPALITY_ROWS.map(row => row.ags)).size, 1104);
  assert.equal(new Set(SH_RUNTIME_MUNICIPALITY_ROWS.map(row => row.jurisdiction)).size, 15);
});


function scopeKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ß/gu, 'ss')
    .toLowerCase()
    .replace(/\([^)]*\bkm\s*\)\s*$/giu, ' ')
    .replace(/\b\d{5}\b/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

test('all unambiguous runtime municipality names resolve to their pinned Jobcenter jurisdiction', () => {
  const entries = Object.entries(SH_RUNTIME_MUNICIPALITY_JURISDICTIONS);
  assert.equal(entries.length, SH_RUNTIME_MUNICIPALITY_INDEX_META.uniqueSafeNames);
  for (const [name, expectedJurisdiction] of entries) {
    assert.equal(
      jurisdictionForHousingLocation(name),
      expectedJurisdiction,
      `${name} must resolve only to ${expectedJurisdiction}`
    );
  }
});

test('all 15 Jobcenter territories are mutually isolated by whole-district filtering', () => {
  const representativeByJurisdiction = new Map();
  for (const [name, jurisdiction] of Object.entries(SH_RUNTIME_MUNICIPALITY_JURISDICTIONS)) {
    if (!representativeByJurisdiction.has(jurisdiction)) representativeByJurisdiction.set(jurisdiction, name);
  }
  assert.equal(representativeByJurisdiction.size, 15);

  const representatives = [...representativeByJurisdiction.entries()].map(([jurisdiction, name], index) => ({
    id:`territory-${index}`,
    location:name,
    jurisdiction
  }));

  for (const [targetJurisdiction, origin] of representativeByJurisdiction) {
    const filtered = filterHousingListingsToJurisdiction(representatives, targetJurisdiction, origin);
    assert.deepEqual(
      filtered.map(item => item.jurisdiction),
      [targetJurisdiction],
      `${targetJurisdiction} must reject every other Jobcenter/Kreis`
    );
  }
});

test('ambiguous municipality names fail closed instead of crossing a Jobcenter boundary', () => {
  const grouped = new Map();
  for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
    const name = scopeKey(row.canonical);
    if (!name) continue;
    const jurisdictions = grouped.get(name) || new Set();
    jurisdictions.add(row.jurisdiction);
    grouped.set(name, jurisdictions);
  }

  const ambiguous = [...grouped.entries()]
    .filter(([name, jurisdictions]) => jurisdictions.size > 1 && !(name in SH_RUNTIME_MUNICIPALITY_JURISDICTIONS));

  assert.ok(ambiguous.length > 0);
  for (const [name] of ambiguous) {
    assert.equal(
      jurisdictionForHousingLocation(name),
      null,
      `${name} is ambiguous and must fail closed`
    );
  }
});

test('all 1104 municipality rows belong to one of the 15 runtime territories and safe names never disagree with source rows', () => {
  const jurisdictions = new Set(Object.values(SH_RUNTIME_MUNICIPALITY_JURISDICTIONS));
  assert.equal(jurisdictions.size, 15);

  for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
    assert.ok(jurisdictions.has(row.jurisdiction), `unknown jurisdiction for ${row.canonical}`);
    const normalized = scopeKey(row.canonical);
    const safe = SH_RUNTIME_MUNICIPALITY_JURISDICTIONS[normalized];
    if (safe) assert.equal(safe, row.jurisdiction, `runtime source mismatch for ${row.canonical}`);
  }
});


test('whole-district search uses multiple in-jurisdiction anchors for Kreise but one anchor for kreisfreie cities', () => {
  const dithmarschen = districtAnchorLocations('Dithmarschen', 'Heide');
  assert.equal(dithmarschen[0], 'Heide');
  assert.ok(dithmarschen.length > 1);
  assert.ok(dithmarschen.every(name => ['Heide','Brunsbüttel','Meldorf','Wesselburen','Marne (Holstein)','Büsum'].includes(name)));

  const stormarn = districtAnchorLocations('Stormarn', 'Ahrensburg');
  assert.equal(stormarn[0], 'Ahrensburg');
  assert.ok(stormarn.length > 1);
  assert.ok(stormarn.includes('Bad Oldesloe') || stormarn.includes('Trittau') || stormarn.includes('Reinbek'));

  assert.deepEqual(districtAnchorLocations('Flensburg', 'Flensburg'), ['Flensburg']);
  assert.deepEqual(districtAnchorLocations('Kiel', 'Kiel'), ['Kiel']);

  const rendsburg = districtAnchorLocations('Rendsburg-Eckernförde', 'Rendsburg');
  assert.equal(rendsburg[0], 'Rendsburg');
  assert.ok(rendsburg.length > 1, 'whole-district Rendsburg search must cover municipalities beyond the origin city');
  assert.ok(rendsburg.length <= 5);
  assert.ok(rendsburg.every(name => jurisdictionForHousingLocation(name) === 'Rendsburg-Eckernförde'));
});

test('district merge prioritizes other municipalities and removes duplicate photo/content cards', () => {
  const duplicateImage = 'https://img.kleinanzeigen.de/api/v1/prod-ads/images/shared.jpg?size=large';
  const items = [
    {
      id:'origin',
      url:'https://www.kleinanzeigen.de/s-anzeige/origin/400000001-203-1',
      imageUrl:'https://img.kleinanzeigen.de/api/v1/prod-ads/images/origin.jpg',
      title:'3-Zimmer-Wohnung in Ahrensburg',
      location:'22926 Ahrensburg',
      price:700,
      rooms:3,
      areaSqm:70
    },
    {
      id:'other-a',
      url:'https://www.kleinanzeigen.de/s-anzeige/other-a/400000002-203-1',
      imageUrl:duplicateImage,
      title:'3-Zimmer-Wohnung in Bad Oldesloe',
      location:'23843 Bad Oldesloe',
      price:690,
      rooms:3,
      areaSqm:68
    },
    {
      id:'other-b-duplicate-photo',
      url:'https://www.kleinanzeigen.de/s-anzeige/other-b/400000003-203-1',
      imageUrl:'https://img.kleinanzeigen.de/api/v1/prod-ads/images/shared.jpg?size=small',
      title:'Noch eine 3-Zimmer-Wohnung',
      location:'23843 Bad Oldesloe',
      price:695,
      rooms:3,
      areaSqm:69
    }
  ];

  const merged = mergeDistrictListings([items], 'Ahrensburg', 5);
  assert.deepEqual(merged.map(item => item.id), ['other-a','origin']);
});


test('statewide whole-district anchors cover all 15 territories without cross-jurisdiction leakage', () => {
  const representatives = Object.freeze({
    Dithmarschen:'Heide',
    'Herzogtum Lauenburg':'Ratzeburg',
    Nordfriesland:'Husum',
    Ostholstein:'Eutin',
    Pinneberg:'Pinneberg',
    'Plön':'Plön',
    'Rendsburg-Eckernförde':'Rendsburg',
    'Schleswig-Flensburg':'Schleswig',
    Segeberg:'Bad Segeberg',
    Steinburg:'Itzehoe',
    Stormarn:'Bad Oldesloe',
    Flensburg:'Flensburg',
    Kiel:'Kiel',
    'Lübeck':'Lübeck',
    'Neumünster':'Neumünster'
  });

  assert.equal(Object.keys(representatives).length, 15);

  for (const [jurisdiction, origin] of Object.entries(representatives)) {
    assert.equal(jurisdictionForHousingLocation(origin), jurisdiction, `origin must resolve: ${jurisdiction} / ${origin}`);
    const anchors = districtAnchorLocations(jurisdiction, origin);
    assert.equal(anchors[0], origin, `origin must stay first: ${jurisdiction}`);
    assert.ok(anchors.length >= 1 && anchors.length <= 5, `bounded anchors: ${jurisdiction}`);
    assert.ok(
      anchors.every(name => jurisdictionForHousingLocation(name) === jurisdiction),
      `cross-jurisdiction anchor leakage: ${jurisdiction} -> ${anchors.join(', ')}`
    );
    if (!['Flensburg','Kiel','Lübeck','Neumünster'].includes(jurisdiction)) {
      assert.ok(anchors.length > 1, `Kreis whole-district search must broaden beyond origin: ${jurisdiction}`);
    } else {
      assert.deepEqual(anchors, [origin], `kreisfreie Stadt must remain city-scoped: ${jurisdiction}`);
    }
  }
});


test('district merge retains enough unique results for 5-item pagination', () => {
  const listings = Array.from({ length:12 }, (_, index) => ({
    id:`item-${index + 1}`,
    url:`https://example.invalid/${index + 1}`,
    location:'24768 Rendsburg',
    title:`Wohnung ${index + 1}`,
    price:500 + index,
    rooms:3,
    areaSqm:70 + index
  }));
  const merged = mergeDistrictListings([listings], 'Rendsburg', 12);
  assert.equal(merged.length, 12);
  assert.deepEqual(merged.slice(0,5).map(x => x.id), listings.slice(0,5).map(x => x.id));
  assert.deepEqual(merged.slice(5,10).map(x => x.id), listings.slice(5,10).map(x => x.id));
  assert.deepEqual(merged.slice(10,15).map(x => x.id), listings.slice(10,12).map(x => x.id));
});
