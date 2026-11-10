import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DITHMARSCHEN_KDU_REGISTRY,
  evaluateDithmarschenHousing,
  resolveDithmarschenRule,
  resolveDithmarschenZone
} from '../src/jobcenter-rules-dithmarschen.mjs';

test('Dithmarschen registry covers all 116 current municipalities and both official comparison zones', () => {
  assert.equal(DITHMARSCHEN_KDU_REGISTRY.municipalityCount, 116);
  assert.deepEqual(Object.keys(DITHMARSCHEN_KDU_REGISTRY.zones).sort(), ['north', 'south']);
  assert.equal(DITHMARSCHEN_KDU_REGISTRY.validFrom, '2025-01-01');
});

test('Dithmarschen north and south 4-person published limits are routed correctly', () => {
  const north = resolveDithmarschenRule('25746 Heide', 4);
  assert.equal(north.status, 'verified');
  assert.equal(north.rule.zone, 'north');
  assert.equal(north.rule.grossColdLimit, 751.50);
  assert.equal(north.rule.maxAreaSqm, 90);

  const south = resolveDithmarschenRule('Brunsbüttel', 4);
  assert.equal(south.status, 'verified');
  assert.equal(south.rule.zone, 'south');
  assert.equal(south.rule.grossColdLimit, 699.30);
  assert.equal(south.rule.maxAreaSqm, 90);
});

test('published additional-person increments are retained but large households require review', () => {
  const rule = resolveDithmarschenRule('Meldorf', 6);
  assert.equal(rule.status, 'verified');
  assert.equal(rule.rule.grossColdLimit, 979.20);
  assert.equal(rule.rule.maxAreaSqm, 115);

  const assessment = evaluateDithmarschenHousing({
    location: 'Meldorf', householdSize: 6, areaSqm: 110,
    kaltmiete: 700, betriebskosten: 150, heizkosten: 120
  });
  assert.equal(assessment.status, 'needs_review');
  assert.equal(assessment.reason, 'large_household_individual_review');
});

test('Produkttheorie does not reject an otherwise affordable unit only because area is above orientation', () => {
  const assessment = evaluateDithmarschenHousing({
    location: 'Heide', householdSize: 4, areaSqm: 100,
    kaltmiete: 560, betriebskosten: 150, heizkosten: 160
  });
  assert.equal(assessment.status, 'within_guideline');
  assert.equal(assessment.heatingAreaCaution, true);
});

test('Dithmarschen still requires separate Kaltmiete, Betriebskosten and Heizkosten values', () => {
  const assessment = evaluateDithmarschenHousing({
    location: 'Heide', householdSize: 4, areaSqm: 80,
    kaltmiete: 550, betriebskosten: 120
  });
  assert.equal(assessment.status, 'insufficient_data');
});

test('ambiguous bare municipality names never auto-route to Dithmarschen', () => {
  assert.equal(resolveDithmarschenZone('Quickborn').status, 'ambiguous_municipality');
  assert.equal(resolveDithmarschenRule('Quickborn', 4).status, 'ambiguous_municipality');
  assert.equal(resolveDithmarschenZone('Quickborn Dithmarschen').zone, 'south');
  assert.equal(resolveDithmarschenZone('Burg (Dithmarschen)').zone, 'south');
});

test('unrelated Schleswig-Holstein locations are not claimed by Dithmarschen resolver', () => {
  assert.equal(resolveDithmarschenZone('Kiel'), null);
  assert.equal(resolveDithmarschenZone('Rendsburg'), null);
});
