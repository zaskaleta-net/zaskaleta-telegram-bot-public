import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SH_VERIFIED_KDU_MODULES,
  evaluateJobcenterHousing,
  resolveJobcenterRule
} from '../src/jobcenter-registry.mjs';

test('base registry contains eleven source-verified territories', () => {
  assert.deepEqual(Object.keys(SH_VERIFIED_KDU_MODULES).sort(), [
    'Dithmarschen', 'Flensburg', 'Herzogtum Lauenburg', 'Kiel', 'Lübeck',
    'Nordfriesland', 'Plön', 'Rendsburg-Eckernförde', 'Segeberg', 'Steinburg', 'Stormarn'
  ].sort());
});

test('flat kreisfreie city modules remain unchanged', () => {
  const kiel = resolveJobcenterRule('24103 Kiel', 4);
  assert.equal(kiel.status, 'verified');
  assert.equal(kiel.rule.grossColdLimit, 815.50);
  assert.equal(kiel.rule.validFrom, '2025-01-01');

  const flensburg = resolveJobcenterRule('24937 Flensburg', 4);
  assert.equal(flensburg.rule.grossColdLimit, 772);

  const luebeck = resolveJobcenterRule('23552 Lübeck', 4);
  assert.equal(luebeck.rule.grossColdLimit, 923);
  assert.equal(resolveJobcenterRule('Lübeck', 7).status, 'individual_review');
});

test('zoned modules resolve before top-level jurisdiction fallback', () => {
  assert.equal(resolveJobcenterRule('Geesthacht', 4).rule.grossColdLimit, 1040.60);
  assert.equal(resolveJobcenterRule('Husum', 4).rule.grossColdLimit, 921);
  assert.equal(resolveJobcenterRule('Plön', 4).rule.grossColdLimit, 800);
  assert.equal(resolveJobcenterRule('Rendsburg', 4).rule.grossColdLimit, 784.80);
  assert.equal(resolveJobcenterRule('Itzehoe', 4).rule.grossColdLimit, 842.60);
});

test('verified district with unresolved subzone never inherits a random threshold', () => {
  for (const location of [
    'Kreis Herzogtum Lauenburg', 'Kreis Nordfriesland',
    'Kreis Rendsburg-Eckernförde', 'Kreis Steinburg'
  ]) {
    const resolved = resolveJobcenterRule(location, 4);
    assert.equal(resolved.status, 'not_yet_mapped', location);
    assert.equal(resolved.rule, null, location);
  }
});

test('all active module types refuse automatic green without complete rent breakdown', () => {
  for (const location of ['Kiel', 'Flensburg', 'Lübeck', '22946 Trittau', 'Heide', 'Geesthacht', 'Husum', 'Plön', 'Rendsburg', 'Itzehoe']) {
    const assessment = evaluateJobcenterHousing({
      location, householdSize: 4, areaSqm: 80, kaltmiete: 600, betriebskosten: 100
    });
    assert.equal(assessment.status, 'insufficient_data', location);
  }
});

test('pending territories and out-of-state locations cannot return automatic green', () => {
  assert.equal(resolveJobcenterRule('Neumünster', 4).status, 'not_yet_verified');
  // Ostholstein limits depend on the municipality's zone; the bare Kreis name has none.
  assert.notEqual(resolveJobcenterRule('Ostholstein', 4).status, 'verified');
  assert.equal(resolveJobcenterRule('Hamburg', 4).status, 'unknown_jurisdiction');
});

test('Stormarn and Dithmarschen behavior stays intact', () => {
  assert.equal(resolveJobcenterRule('22946 Trittau', 4).rule.grossColdLimit, 943.80);
  assert.equal(resolveJobcenterRule('Heide', 4).rule.grossColdLimit, 751.50);
  assert.equal(resolveJobcenterRule('Brunsbüttel', 4).rule.grossColdLimit, 699.30);
});


test('base metadata does not impersonate a numerical rule owned by the statewide facade', () => {
  for (const location of ['Pinneberg', 'Schleswig-Flensburg']) {
    const result = resolveJobcenterRule(location, 4);
    assert.equal(result.status, 'not_yet_mapped');
    assert.equal(result.rule, null);
    assert.notEqual(evaluateJobcenterHousing({location,householdSize:4,kaltmiete:500,betriebskosten:100,heizkosten:80}).status, 'within_guideline');
  }
});

test('Steinburg district and ambiguous name cannot inherit Stormarn municipality values', () => {
  for (const location of ['Steinburg', 'Kreis Steinburg', 'Landkreis Steinburg']) {
    const result = resolveJobcenterRule(location, 4);
    assert.equal(result.rule, null, location);
    assert.notEqual(result.status, 'verified', location);
  }
  assert.equal(resolveJobcenterRule('Steinburg, Kreis Stormarn', 4).jurisdiction, 'Stormarn');
});
