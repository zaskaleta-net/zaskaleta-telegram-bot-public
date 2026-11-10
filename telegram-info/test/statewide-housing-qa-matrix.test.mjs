import test from 'node:test';
import assert from 'node:assert/strict';
import { SH_JURISDICTIONS } from '../src/jobcenter-jurisdictions.mjs';
import { SH_STATEWIDE_KDU_COVERAGE, resolveJobcenterRule } from '../src/jobcenter-registry-statewide.mjs';
import { SH_CITY_COUNT, SH_UKRAINIAN_PLACE_ROWS, placeRouteForJobcenter } from '../src/schleswig-holstein-place-names.mjs';
import { parseRoomSpec, roomValueInSpec } from '../src/rooms.mjs';

// Exact-SHA diagnostic retrigger: full regression suite isolated from external workbook QA.
const MATRIX = Object.freeze([
  ['Dithmarschen','Heide','verified'],
  ['Herzogtum Lauenburg','Ratzeburg','verified'],
  ['Nordfriesland','Husum','verified'],
  ['Ostholstein','Eutin','verified'],
  ['Pinneberg','Pinneberg','verified'],
  ['Plön','Plön','verified'],
  ['Rendsburg-Eckernförde','Rendsburg','verified'],
  ['Schleswig-Flensburg','Schleswig','verified'],
  ['Segeberg','Bad Segeberg','verified'],
  ['Steinburg','Itzehoe','verified'],
  ['Stormarn','Ahrensburg','verified'],
  ['Flensburg','Flensburg','verified'],
  ['Kiel','Kiel','verified'],
  ['Lübeck','Lübeck','verified'],
  ['Neumünster','Neumünster','pending_direct_verification']
]);

test('statewide matrix covers exactly 11 Kreise plus 4 kreisfreie Städte', () => {
  assert.equal(SH_JURISDICTIONS.length, 15);
  assert.deepEqual(new Set(MATRIX.map(([jurisdiction]) => jurisdiction)), new Set(SH_JURISDICTIONS));
});

test('statewide KdU status is explicit for all 15 territories', () => {
  for (const [jurisdiction, _location, expected] of MATRIX) {
    const coverage = SH_STATEWIDE_KDU_COVERAGE[jurisdiction];
    assert.ok(coverage, `missing coverage for ${jurisdiction}`);
    assert.equal(coverage.numericStatus, expected, jurisdiction);
    assert.ok(coverage.authority, `missing authority for ${jurisdiction}`);
    assert.ok(coverage.sourceUrl, `missing source for ${jurisdiction}`);
  }
});

test('representative municipality in each verified territory resolves to the correct Jobcenter jurisdiction', () => {
  for (const [jurisdiction, location, status] of MATRIX) {
    if (status !== 'verified') continue;
    const resolved = resolveJobcenterRule(location, 3);
    assert.ok(resolved, `no rule for ${location}`);
    assert.equal(resolved.status, 'verified', `${location} status`);
    assert.equal(resolved.jurisdiction, jurisdiction, `${location} jurisdiction`);
    assert.ok(Number.isFinite(Number(resolved.rule?.grossColdLimit)), `${location} grossColdLimit`);
    assert.ok(Number.isFinite(Number(resolved.rule?.maxAreaSqm)), `${location} maxAreaSqm`);
  }
});

test('pending territories remain fail-closed instead of inheriting stale numeric values', () => {
  for (const [jurisdiction, location, status] of MATRIX) {
    if (status !== 'pending_direct_verification') continue;
    const coverage = SH_STATEWIDE_KDU_COVERAGE[jurisdiction];
    assert.equal(coverage.numericStatus, 'pending_direct_verification');
    const resolved = resolveJobcenterRule(location, 3);
    assert.notEqual(resolved?.status, 'verified', `${location} must not become numerically verified`);
    assert.equal(resolved?.rule ?? null, null, `${location} must not expose a current numeric rule`);
  }
});

test('all curated Schleswig-Holstein places route only inside the 15 statewide jurisdictions', () => {
  assert.equal(SH_CITY_COUNT, 63);
  const allowed = new Set(SH_JURISDICTIONS);
  for (const row of SH_UKRAINIAN_PLACE_ROWS) {
    const route = placeRouteForJobcenter(row.canonical);
    assert.ok(route, `missing route for ${row.canonical}`);
    assert.equal(route.canonical, row.canonical);
    assert.equal(route.jurisdiction, row.jurisdiction);
    assert.ok(allowed.has(route.jurisdiction), `out-of-state route for ${row.canonical}`);
  }
});

test('fractional room values can never satisfy an integer 3-room search', () => {
  const exact = parseRoomSpec('3');
  const range = parseRoomSpec('3-4');
  assert.equal(roomValueInSpec(2.5, exact), false);
  assert.equal(roomValueInSpec(2.5, range), false);
  assert.equal(roomValueInSpec(3, exact), true);
  assert.equal(roomValueInSpec(3, range), true);
  assert.equal(roomValueInSpec(4, range), true);
});
