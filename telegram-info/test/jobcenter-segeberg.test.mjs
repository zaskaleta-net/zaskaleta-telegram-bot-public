import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEGEBERG_KDU_REGISTRY,
  evaluateSegebergHousing,
  resolveSegebergRule
} from '../src/jobcenter-rules-segeberg.mjs';

test('Segeberg current official table keeps the five published rent stages distinct', () => {
  assert.equal(resolveSegebergRule('Norderstedt',4).rule.grossColdLimit,1176.34);
  assert.equal(resolveSegebergRule('Henstedt-Ulzburg',4).rule.grossColdLimit,1078.44);
  assert.equal(resolveSegebergRule('Kaltenkirchen',4).rule.grossColdLimit,981.64);
  assert.equal(resolveSegebergRule('Bad Segeberg',4).rule.grossColdLimit,981.64);
  assert.equal(resolveSegebergRule('Bad Bramstedt',4).rule.grossColdLimit,880.44);
  assert.equal(resolveSegebergRule('Wahlstedt',4).rule.grossColdLimit,792.44);
});

test('Segeberg all-other municipality map covers current Kreis municipalities and excludes Tangstedt Stormarn', () => {
  assert.equal(SEGEBERG_KDU_REGISTRY.municipalityCount,95);
  assert.equal(resolveSegebergRule('Trappenkamp',2).rule.grossColdLimit,569.58);
  assert.equal(resolveSegebergRule('Boostedt',2).rule.grossColdLimit,569.58);
  assert.equal(resolveSegebergRule('Tangstedt',2),null);
});

test('Segeberg uses published additional-person increments', () => {
  assert.equal(resolveSegebergRule('Norderstedt',6).rule.grossColdLimit,1513.60);
  assert.equal(resolveSegebergRule('Bad Segeberg',6).rule.grossColdLimit,1259.50);
  assert.equal(resolveSegebergRule('Wahlstedt',6).rule.grossColdLimit,1012.11);
  assert.equal(resolveSegebergRule('Wahlstedt',6).rule.maxAreaSqm,105);
});

test('ambiguous bare municipality names do not get a false Segeberg threshold', () => {
  assert.equal(resolveSegebergRule('Borstel',4).status,'ambiguous_municipality');
  assert.equal(resolveSegebergRule('Borstel, Kreis Segeberg',4).rule.grossColdLimit,792.44);
});

test('Segeberg requires complete costs but never rejects on area alone', () => {
  assert.equal(evaluateSegebergHousing({location:'Bad Segeberg',householdSize:4,kaltmiete:700,betriebskosten:150}).status,'insufficient_data');
  assert.equal(evaluateSegebergHousing({location:'Bad Segeberg',householdSize:4,kaltmiete:900,betriebskosten:100,heizkosten:100,areaSqm:85}).status,'over_limit');
  const overArea=evaluateSegebergHousing({location:'Bad Segeberg',householdSize:4,kaltmiete:700,betriebskosten:150,heizkosten:100,areaSqm:90});
  assert.equal(overArea.status,'within_guideline');
  assert.equal(overArea.areaAboveGuideline,true);
  assert.equal(evaluateSegebergHousing({location:'Bad Segeberg',householdSize:4,kaltmiete:700,betriebskosten:150,heizkosten:100,areaSqm:85}).status,'within_guideline');
});
