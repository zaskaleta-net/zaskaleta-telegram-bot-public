import assert from 'node:assert/strict';
import { SH_RUNTIME_MUNICIPALITY_ROWS } from '../../telegram-info/src/sh-municipality-jurisdiction-runtime.mjs';
import { jobcenterRuleLocationForMunicipality } from '../../telegram-info/src/schleswig-holstein-jobcenter-route.mjs';
import { SH_STATEWIDE_KDU_COVERAGE, resolveJobcenterRule } from '../../telegram-info/src/jobcenter-registry-statewide.mjs';

const PENDING = new Set(['Neumünster']);
assert.equal(SH_RUNTIME_MUNICIPALITY_ROWS.length, 1104);
assert.equal(new Set(SH_RUNTIME_MUNICIPALITY_ROWS.map(row => row.ags)).size, 1104);
assert.equal(new Set(SH_RUNTIME_MUNICIPALITY_ROWS.map(row => row.ars)).size, 1104);
assert.equal(Object.keys(SH_STATEWIDE_KDU_COVERAGE).length, 15);

let routed = 0;
let verified = 0;
let pending = 0;
const territoryCounts = {};

for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
  territoryCounts[row.jurisdiction] = (territoryCounts[row.jurisdiction] || 0) + 1;
  assert.match(String(row.ags || ''), /^010\d{5}$/u, row.canonical);
  assert.match(String(row.ars || ''), /^010\d{9}$/u, row.canonical);

  const coverage = SH_STATEWIDE_KDU_COVERAGE[row.jurisdiction];
  assert.ok(coverage, `missing coverage: ${row.jurisdiction}`);

  const ruleLocation = jobcenterRuleLocationForMunicipality(row);
  assert.ok(ruleLocation, `missing rule location: ${row.canonical}`);
  routed += 1;

  const result = resolveJobcenterRule(ruleLocation, 3);
  if (PENDING.has(row.jurisdiction)) {
    assert.equal(coverage.numericStatus, 'pending_direct_verification', row.jurisdiction);
    assert.notEqual(result?.status, 'verified', row.canonical);
    assert.equal(result?.rule ?? null, null, row.canonical);
    pending += 1;
  } else {
    assert.equal(coverage.numericStatus, 'verified', row.jurisdiction);
    assert.equal(result?.status, 'verified', row.canonical);
    assert.equal(result?.jurisdiction, row.jurisdiction, row.canonical);
    assert.ok(Number.isFinite(Number(result?.rule?.grossColdLimit)), row.canonical);
    assert.ok(Number.isFinite(Number(result?.rule?.maxAreaSqm)), row.canonical);
    verified += 1;
  }
}

console.log('STATEWIDE_RUNTIME_X64_PASS', JSON.stringify({
  total:SH_RUNTIME_MUNICIPALITY_ROWS.length,
  routed,
  verified,
  pending,
  territories:Object.keys(territoryCounts).length,
  territoryCounts
}));
