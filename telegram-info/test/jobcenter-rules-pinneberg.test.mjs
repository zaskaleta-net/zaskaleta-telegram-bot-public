import test from 'node:test';
import assert from 'node:assert/strict';
import { PINNEBERG_KDU_REGISTRY, resolvePinnebergRule, evaluatePinnebergHousing } from '../src/jobcenter-rules-pinneberg.mjs';

test('official Pinneberg table covers all four Mietstufen and 49 municipalities', () => {
  assert.equal(PINNEBERG_KDU_REGISTRY.municipalityCount, 49);
  assert.equal(resolvePinnebergRule('Elmshorn',4).rule.grossColdLimit,981.64);
  assert.equal(resolvePinnebergRule('25421 Pinneberg',4).rule.grossColdLimit,1078.44);
  assert.equal(resolvePinnebergRule('22880 Wedel',4).rule.grossColdLimit,1176.34);
  assert.equal(resolvePinnebergRule('22869 Schenefeld',4).rule.grossColdLimit,1290.74);
});

test('published additional-person increments are zone specific', () => {
  assert.equal(resolvePinnebergRule('Elmshorn',6).rule.grossColdLimit,1259.50);
  assert.equal(resolvePinnebergRule('25421 Pinneberg',6).rule.grossColdLimit,1378.30);
  assert.equal(resolvePinnebergRule('22880 Wedel',6).rule.grossColdLimit,1513.60);
  assert.equal(resolvePinnebergRule('22869 Schenefeld',6).rule.grossColdLimit,1659.90);
});

test('ambiguous bare municipality names never inherit a Pinneberg threshold', () => {
  assert.equal(resolvePinnebergRule('Quickborn',4).status,'ambiguous_municipality');
  assert.equal(resolvePinnebergRule('Schenefeld',4).status,'ambiguous_municipality');
  assert.equal(resolvePinnebergRule('Tangstedt',4).status,'ambiguous_municipality');
  assert.equal(resolvePinnebergRule('Kreis Pinneberg',4).status,'not_yet_mapped');
  assert.equal(resolvePinnebergRule('Kreis Pinneberg, Quickborn',4).rule.grossColdLimit,1078.44);
});

test('Pinneberg refuses green without complete rent breakdown', () => {
  assert.equal(evaluatePinnebergHousing({location:'25421 Pinneberg',householdSize:4,kaltmiete:850,betriebskosten:150}).status,'insufficient_data');
  assert.equal(evaluatePinnebergHousing({location:'25421 Pinneberg',householdSize:4,kaltmiete:950,betriebskosten:150,heizkosten:100}).status,'over_limit');
  const overArea=evaluatePinnebergHousing({location:'25421 Pinneberg',householdSize:4,kaltmiete:850,betriebskosten:150,heizkosten:100,areaSqm:95});
  assert.equal(overArea.status,'within_guideline');
  assert.equal(overArea.areaAboveGuideline,true);
  assert.equal(evaluatePinnebergHousing({location:'25421 Pinneberg',householdSize:4,kaltmiete:850,betriebskosten:150,heizkosten:100,areaSqm:90}).status,'within_guideline');
});
