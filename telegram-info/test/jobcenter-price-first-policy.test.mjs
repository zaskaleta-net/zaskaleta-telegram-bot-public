import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateJobcenterHousing, resolveJobcenterRule } from '../src/jobcenter-registry-statewide.mjs';

const REPRESENTATIVES = Object.freeze([
  '22946 Trittau',
  'Heide',
  'Geesthacht',
  'Husum',
  'Plön',
  'Rendsburg',
  'Itzehoe',
  'Bad Segeberg',
  'Kiel',
  'Flensburg',
  'Lübeck',
  '25421 Pinneberg',
  '24837 Schleswig'
]);

test('all verified Schleswig-Holstein evaluators treat area as informational when gross-cold cost fits', () => {
  for (const location of REPRESENTATIVES) {
    const resolved = resolveJobcenterRule(location, 4);
    assert.equal(resolved?.status, 'verified', location);
    const limit = Number(resolved.rule.grossColdLimit);
    const maxArea = Number(resolved.rule.maxAreaSqm);
    assert.ok(Number.isFinite(limit) && limit > 0, location);
    assert.ok(Number.isFinite(maxArea) && maxArea > 0, location);

    const areaSqm = maxArea + 5;
    const publishedMinimum = Number(resolved.module?.minimumBetriebskostenPerSqm);
    const betriebskosten = Number.isFinite(publishedMinimum) && publishedMinimum > 0
      ? Math.ceil(areaSqm * publishedMinimum * 100) / 100
      : 100;
    const grossCold = Math.round((limit - 5) * 100) / 100;
    const kaltmiete = Math.round((grossCold - betriebskosten) * 100) / 100;
    assert.ok(kaltmiete > 0, location);

    const assessment = evaluateJobcenterHousing({
      location,
      householdSize:4,
      kaltmiete,
      betriebskosten,
      heizkosten:100,
      areaSqm
    });

    assert.equal(assessment?.status, 'within_guideline', location);
    assert.notEqual(assessment?.reason, 'area', location);
  }
});

test('price over the local gross-cold limit still wins regardless of area', () => {
  for (const location of REPRESENTATIVES) {
    const resolved = resolveJobcenterRule(location, 4);
    assert.equal(resolved?.status, 'verified', location);
    const limit = Number(resolved.rule.grossColdLimit);
    const maxArea = Number(resolved.rule.maxAreaSqm);
    const assessment = evaluateJobcenterHousing({
      location,
      householdSize:4,
      kaltmiete:Math.round((limit + 1) * 100) / 100,
      betriebskosten:1,
      heizkosten:100,
      areaSqm:Math.max(1, maxArea - 10)
    });
    assert.equal(assessment?.status, 'over_limit', location);
  }
});
