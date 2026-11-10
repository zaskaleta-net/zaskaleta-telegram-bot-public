import test from 'node:test';
import assert from 'node:assert/strict';
import { kleinanzeigenLocationId } from '../src/kleinanzeigen-location.mjs';
import { KLEINANZEIGEN_LOCATION_IDS, KLEINANZEIGEN_LOCATION_IDS_META } from '../src/kleinanzeigen-location-ids.mjs';
import { SH_RUNTIME_MUNICIPALITY_ROWS } from '../src/sh-municipality-jurisdiction-runtime.mjs';
import { searchKleinanzeigenPublicRecovery } from '../src/housing-kleinanzeigen-public-recovery-base.mjs';

// Live check 2026-10-12: "Plön, Schleswig-Holstein" and "Schleswig, Schleswig-Holstein"
// resolved to the whole state (l408, i.e. Kiel listings) and "Heide, Schleswig-Holstein"
// to Heidesheim (Rheinland-Pfalz). The pinned ids are the portal's own suggestions.
test('pinned Kleinanzeigen ids cover the towns whose free-text search went astray', () => {
  assert.equal(kleinanzeigenLocationId('Plön'), '13383');
  assert.equal(kleinanzeigenLocationId('Schleswig'), '529');
  assert.equal(kleinanzeigenLocationId('Heide'), '836');
  assert.equal(kleinanzeigenLocationId('Trittau'), '10410');
  assert.equal(kleinanzeigenLocationId('24306 Plön'), '13383', 'a leading PLZ is ignored');
  assert.equal(kleinanzeigenLocationId('Holm'), null, 'a name shared by two municipalities is never guessed');
  assert.equal(kleinanzeigenLocationId('Hamburg-Altona'), null);
});

test('the pinned table only keys real municipalities and stays broadly complete', () => {
  const ags = new Set(SH_RUNTIME_MUNICIPALITY_ROWS.map(row => row.ags));
  const keys = Object.keys(KLEINANZEIGEN_LOCATION_IDS);
  assert.ok(keys.every(key => ags.has(key)));
  assert.ok(Object.values(KLEINANZEIGEN_LOCATION_IDS).every(id => Number.isSafeInteger(id) && id > 0));
  assert.equal(KLEINANZEIGEN_LOCATION_IDS_META.resolved, keys.length);
  assert.ok(keys.length >= 700, String(keys.length));
});

test('the strict public search uses the pinned location id instead of the free-text place', async () => {
  const urls = [];
  await searchKleinanzeigenPublicRecovery({ location:'Plön', rooms:'2', amount:570, type:'Bruttokaltmiete', radiusKm:15 }, async url => {
    urls.push(String(url));
    return new Response('unavailable', { status:503 });
  });
  const strict = urls.find(url => url.includes('s-suchanfrage.html'));
  assert.ok(strict, JSON.stringify(urls));
  const params = new URL(strict).searchParams;
  assert.equal(params.get('locationId'), '13383');
  assert.equal(params.get('locationStr'), null);
});
