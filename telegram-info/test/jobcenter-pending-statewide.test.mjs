import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SH_PENDING_KDU_TERRITORIES,
  SH_STATEWIDE_KDU_COVERAGE,
  SH_KDU_CAVEATS,
  evaluateJobcenterHousing,
  resolveJobcenterRule
} from '../src/jobcenter-registry-statewide.mjs';

test('all 15 Schleswig-Holstein territories exist in the statewide KdU directory', () => {
  assert.equal(Object.keys(SH_STATEWIDE_KDU_COVERAGE).length,15);
  const entries=Object.values(SH_STATEWIDE_KDU_COVERAGE);
  assert.equal(entries.filter(entry => entry.type === 'kreis').length,11);
  assert.equal(entries.filter(entry => entry.type === 'kreisfreie_stadt').length,4);
  assert.equal(entries.filter(entry => entry.numericStatus === 'verified').length,14);
  assert.equal(entries.filter(entry => entry.numericStatus === 'pending_direct_verification').length,1);
  assert.equal(entries.filter(entry => entry.numericStatus === 'missing').length,0);
});

test('only Neumünster remains numeric-pending', () => {
  assert.deepEqual(Object.keys(SH_PENDING_KDU_TERRITORIES), ['Neumünster']);
});

test('Ostholstein uses the official zone table published as current (gültig ab Mai 2025)', () => {
  const resolved = resolveJobcenterRule('23701 Eutin', 4);
  assert.equal(resolved.status, 'verified');
  assert.equal(resolved.jurisdiction, 'Ostholstein');
  assert.equal(resolved.rule.grossColdLimit, 829.80);
  assert.equal(resolved.rule.zoneLabel, 'Vergleichsraum Eutin');
  assert.equal(SH_STATEWIDE_KDU_COVERAGE.Ostholstein.numericStatus,'verified');
  assert.equal(SH_STATEWIDE_KDU_COVERAGE.Ostholstein.validFrom,'2025-05-01');
  assert.match(SH_STATEWIDE_KDU_COVERAGE.Ostholstein.sourceUrl, /jobcenter-ostholstein\.de/);
  assert.equal(resolveJobcenterRule('Bad Schwartau', 2).rule.grossColdLimit, 637.20);

  const within = evaluateJobcenterHousing({ location:'23701 Eutin', householdSize:4, kaltmiete:600, betriebskosten:150, heizkosten:100, areaSqm:88 });
  assert.equal(within.status, 'within_guideline');
  const over = evaluateJobcenterHousing({ location:'23701 Eutin', householdSize:4, kaltmiete:700, betriebskosten:150, heizkosten:100 });
  assert.equal(over.status, 'over_limit');
  // A bare Kreis name has no zone and never borrows one.
  assert.notEqual(resolveJobcenterRule('Ostholstein', 4).status, 'verified');
});

test('Neumünster future change is recorded without early activation', () => {
  const resolved = resolveJobcenterRule('24534 Neumünster', 4);
  assert.equal(resolved.status, 'not_yet_verified');
  assert.equal(resolved.jurisdiction, 'Neumünster');
  assert.equal(resolved.rule, null);
  assert.equal(resolved.pending.futureChangeFrom, '2026-10-01');
  assert.equal(resolved.pending.verifiedCurrentOn, '2026-09-11');
  assert.match(resolved.pending.sourceUrl, /session\.neumuenster\.de/);
  // TG-RUNTIME-073: 01.10.2026 has passed; the text says the change was
  // announced (not that it is in force) and still adds no numbers.
  assert.match(resolved.pending.messageUk, /оголосила нові межі.*з 01\.10\.2026/u);
  assert.doesNotMatch(resolved.pending.messageUk, /діють|не застосовуються раніше/u);
  assert.match(resolved.pending.messageUk, /Перевіреної офіційної таблиці з сумами в боті поки немає/u);
  assert.equal(SH_STATEWIDE_KDU_COVERAGE.Neumünster.numericStatus,'pending_direct_verification');
  const assessment = evaluateJobcenterHousing({location:'24534 Neumünster', householdSize:4, kaltmiete:500, betriebskosten:100, heizkosten:100});
  assert.equal(assessment.status, 'not_yet_verified');
  assert.equal(assessment.rule, null);
});

test('Kiel one-person court decision is a caveat, never a silent table override', () => {
  const caveat=SH_KDU_CAVEATS.Kiel;
  assert.equal(caveat.householdSize,1);
  assert.equal(caveat.publishedGrossColdLimit,474.50);
  assert.equal(caveat.interimCourtAmount,502.50);
  assert.equal(caveat.caseReference,'L 6 AS 175/25 B ER');
  assert.match(caveat.noteUk,/не автоматична загальна заміна нормативу/);
  const official=resolveJobcenterRule('Kiel',1);
  assert.equal(official.status,'verified');
  assert.equal(official.rule.grossColdLimit,474.50);
  assert.equal(SH_STATEWIDE_KDU_COVERAGE.Kiel.caveat,caveat);
});
