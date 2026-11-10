import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateJobcenterHousing, resolveJobcenterRule } from '../src/jobcenter-registry-statewide.mjs';

test('Schleswig-Flensburg uses verified limits effective 01.03.2026', () => {
  const four = resolveJobcenterRule('24837 Schleswig', 4);
  assert.equal(four.status, 'verified');
  assert.equal(four.rule.grossColdLimit, 818);
  assert.equal(four.rule.maxAreaSqm, 90);
  assert.equal(four.rule.validFrom, '2026-03-01');
  const six = resolveJobcenterRule('Schleswig-Flensburg', 6);
  assert.equal(six.rule.grossColdLimit, 1041);
  assert.equal(six.rule.maxAreaSqm, 115);
});

test('Schleswig-Holstein suffix alone cannot be mistaken for Schleswig-Flensburg', () => {
  const kiel = resolveJobcenterRule('Kiel, Schleswig-Holstein', 4);
  assert.equal(kiel.jurisdiction, 'Kiel');
  assert.equal(kiel.rule.grossColdLimit, 815.50);
});

test('complete rent breakdown is mandatory before automatic green', () => {
  const incomplete = evaluateJobcenterHousing({ location: '24837 Schleswig', householdSize: 4, areaSqm: 85, kaltmiete: 650, betriebskosten: 120 });
  assert.equal(incomplete.status, 'insufficient_data');
  const complete = evaluateJobcenterHousing({ location: '24837 Schleswig', householdSize: 4, areaSqm: 85, kaltmiete: 650, betriebskosten: 120, heizkosten: 100 });
  assert.equal(complete.status, 'within_guideline');
  const over = evaluateJobcenterHousing({ location: '24837 Schleswig', householdSize: 4, areaSqm: 85, kaltmiete: 750, betriebskosten: 120, heizkosten: 100 });
  assert.equal(over.status, 'over_limit');
});
