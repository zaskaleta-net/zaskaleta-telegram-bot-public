import test from 'node:test';
import assert from 'node:assert/strict';
import { HAMBURG_BOROUGHS, HAMBURG_STADTTEILE, canonicalHamburgPlace, hamburgPlaceRoute } from '../src/hamburg-place-names.mjs';
import { HAMBURG_STADTTEIL_SURCHARGE_10, resolveHamburgRule } from '../src/jobcenter-rules-hamburg.mjs';
import { resolveJobcenterRule, EXTENDED_KDU_COVERAGE } from '../src/jobcenter-registry-statewide.mjs';
import { housingJobcenterOverview } from '../src/housing-jobcenter-overview.mjs';
import { knownHousingLocation, normalizeHousingLocation } from '../src/housing-language.mjs';

test('Hamburg directory covers all 7 Bezirke and all 104 Stadtteile', () => {
  assert.deepEqual(HAMBURG_BOROUGHS, ['Altona','Bergedorf','Eimsbüttel','Hamburg-Mitte','Hamburg-Nord','Harburg','Wandsbek']);
  assert.equal(HAMBURG_STADTTEILE.length, 104);
  assert.equal(new Set(HAMBURG_STADTTEILE).size, 104);
  for (const required of ['Rahlstedt','Bramfeld','Farmsen-Berne','Volksdorf','Winterhude','Blankenese','Harburg','Bergedorf']) {
    assert.ok(HAMBURG_STADTTEILE.includes(required), required);
  }
  assert.equal(EXTENDED_KDU_COVERAGE.Hamburg.numericStatus, 'verified');
});

test('Hamburg place routing accepts German, postcode and Ukrainian names', () => {
  assert.equal(canonicalHamburgPlace('Hamburg'), 'Hamburg');
  assert.equal(canonicalHamburgPlace('22147 Hamburg Rahlstedt'), 'Rahlstedt');
  assert.equal(canonicalHamburgPlace('Hamburg Farmsen-Berne'), 'Farmsen-Berne');
  assert.equal(canonicalHamburgPlace('Брамфельд'), 'Bramfeld');
  assert.equal(canonicalHamburgPlace('Фольксдорф'), 'Volksdorf');
  assert.equal(hamburgPlaceRoute('22147 Hamburg Rahlstedt')?.borough, 'Wandsbek');
  assert.equal(normalizeHousingLocation('Брамфельд'), 'Bramfeld');
  assert.equal(knownHousingLocation('Брамфельд житло для 4 людей під Jobcenter'), 'Bramfeld');
  assert.equal(knownHousingLocation('Житло в Rahlstedt для 4 людей під Jobcenter'), 'Rahlstedt');
});

test('Hamburg 2026 base Bruttokaltmiete limits are resolved from the official table', () => {
  const expected = new Map([[1,574],[2,697.80],[3,860.25],[4,1036.80],[5,1480.50],[6,1668.00],[7,1876.50]]);
  for (const [persons, amount] of expected) {
    const resolved = resolveHamburgRule('Rahlstedt', persons);
    assert.equal(resolved.status, 'verified');
    assert.equal(resolved.rule.grossColdLimit, amount);
    assert.equal(resolved.rule.surchargePercent, 0);
    assert.equal(resolved.rule.maxAreaSqm, null);
  }
  assert.equal(resolveJobcenterRule('22147 Hamburg Rahlstedt', 4).rule.grossColdLimit, 1036.80);
});

test('Hamburg Anlage 3 Stadtteil surcharge is applied only to listed Stadtteile', () => {
  assert.ok(HAMBURG_STADTTEIL_SURCHARGE_10.has('Winterhude'));
  assert.ok(HAMBURG_STADTTEIL_SURCHARGE_10.has('Volksdorf'));
  assert.ok(!HAMBURG_STADTTEIL_SURCHARGE_10.has('Rahlstedt'));
  assert.equal(resolveHamburgRule('Winterhude', 4).rule.grossColdLimit, 1140.48);
  assert.equal(resolveHamburgRule('Volksdorf', 2).rule.grossColdLimit, 767.58);
  assert.equal(resolveHamburgRule('Rahlstedt', 4).rule.grossColdLimit, 1036.80);
});

test('Hamburg overview labels Hamburg as a separate federal state, not Schleswig-Holstein', () => {
  const base = housingJobcenterOverview('Rahlstedt', 4, '2026-09-11');
  assert.equal(base.needsLocation, false);
  assert.match(base.text, /Jobcenter team\.arbeit\.hamburg/);
  assert.match(base.text, /Hamburg \(Гамбург\) — окрема федеральна земля/);
  assert.match(base.text, /Це НЕ Schleswig-Holstein/);
  assert.match(base.text, /1036,80/);
  assert.doesNotMatch(base.text, /undefined|NaN/);
  assert.match(base.text, /не публікує.*окрему межу площі|грошові межі Bruttokaltmiete/u);

  const boosted = housingJobcenterOverview('Winterhude', 4, '2026-09-11');
  assert.match(boosted.text, /Hamburg \(Гамбург\) — окрема федеральна земля/);
  assert.match(boosted.text, /1140,48/);
  assert.match(boosted.text, /\+10%/);
  assert.match(boosted.text, /1036,80/);
});
