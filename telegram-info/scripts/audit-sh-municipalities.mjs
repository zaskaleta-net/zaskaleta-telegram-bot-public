import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  SH_MUNICIPALITY_SOURCE,
  SH_OFFICIAL_MUNICIPALITIES,
  SH_OFFICIAL_MUNICIPALITY_COUNT
} from '../src/sh-municipalities-generated.mjs';
import { jobcenterRuleLocationForMunicipality } from '../src/schleswig-holstein-jobcenter-route.mjs';
import {
  SH_STATEWIDE_KDU_COVERAGE,
  resolveJobcenterRule
} from '../src/jobcenter-registry-statewide.mjs';

const EXPECTED_COUNT = 1104;
const EXPECTED_TERRITORIES = 15;
const PENDING = new Set(['Neumünster']);
const failures = [];
const byJurisdiction = new Map();

function fail(row, reason, details = null) {
  failures.push({
    ags: row?.ags ?? null,
    ars: row?.ars ?? null,
    canonical: row?.canonical ?? null,
    jurisdiction: row?.jurisdiction ?? null,
    reason,
    details
  });
}

assert.equal(SH_OFFICIAL_MUNICIPALITY_COUNT, EXPECTED_COUNT, 'official municipality fixture must contain exactly 1,104 rows');
assert.equal(SH_OFFICIAL_MUNICIPALITIES.length, EXPECTED_COUNT, 'official municipality list length mismatch');
assert.equal(new Set(SH_OFFICIAL_MUNICIPALITIES.map(row => row.ags)).size, EXPECTED_COUNT, 'AGS values must be unique');
assert.equal(new Set(SH_OFFICIAL_MUNICIPALITIES.map(row => row.ars)).size, EXPECTED_COUNT, 'ARS values must be unique');
assert.equal(Object.keys(SH_STATEWIDE_KDU_COVERAGE).length, EXPECTED_TERRITORIES, 'statewide KdU coverage must contain exactly 15 territories');

for (const row of SH_OFFICIAL_MUNICIPALITIES) {
  const jurisdiction = String(row.jurisdiction || '');
  const coverage = SH_STATEWIDE_KDU_COVERAGE[jurisdiction];
  const bucket = byJurisdiction.get(jurisdiction) || {
    jurisdiction,
    total: 0,
    routed: 0,
    verifiedRules: 0,
    pendingFailClosed: 0,
    failed: 0,
    numericStatus: coverage?.numericStatus ?? 'missing'
  };
  bucket.total += 1;
  byJurisdiction.set(jurisdiction, bucket);

  if (!/^010\d{5}$/u.test(String(row.ags || '')) || !/^010\d{9}$/u.test(String(row.ars || ''))) {
    bucket.failed += 1;
    fail(row, 'invalid_official_key_shape');
    continue;
  }
  if (row.ars.slice(0,5) !== row.ags.slice(0,5) || row.ars.slice(9) !== row.ags.slice(5)) {
    bucket.failed += 1;
    fail(row, 'ars_ags_hierarchy_mismatch');
    continue;
  }

  if (!coverage) {
    bucket.failed += 1;
    fail(row, 'missing_statewide_kdu_coverage');
    continue;
  }

  const ruleLocation = jobcenterRuleLocationForMunicipality({
    canonical: row.canonical,
    jurisdiction,
    ars: row.ars
  });
  if (!ruleLocation) {
    bucket.failed += 1;
    fail(row, 'missing_rule_location');
    continue;
  }
  bucket.routed += 1;

  const resolved = resolveJobcenterRule(ruleLocation, 3);
  if (PENDING.has(jurisdiction)) {
    if (coverage.numericStatus !== 'pending_direct_verification') {
      bucket.failed += 1;
      fail(row, 'pending_territory_not_marked_pending', { numericStatus: coverage.numericStatus });
      continue;
    }
    if (resolved?.status === 'verified' || resolved?.rule) {
      bucket.failed += 1;
      fail(row, 'pending_territory_exposed_numeric_rule', { ruleLocation, status: resolved?.status ?? null });
      continue;
    }
    bucket.pendingFailClosed += 1;
    continue;
  }

  if (coverage.numericStatus !== 'verified') {
    bucket.failed += 1;
    fail(row, 'verified_territory_not_marked_verified', { numericStatus: coverage.numericStatus });
    continue;
  }
  if (!resolved || resolved.status !== 'verified') {
    bucket.failed += 1;
    fail(row, 'rule_resolution_failed', { ruleLocation, status: resolved?.status ?? null });
    continue;
  }
  if (resolved.jurisdiction !== jurisdiction) {
    bucket.failed += 1;
    fail(row, 'wrong_jobcenter_jurisdiction', { ruleLocation, resolvedJurisdiction: resolved.jurisdiction });
    continue;
  }
  if (!Number.isFinite(Number(resolved.rule?.grossColdLimit)) || !Number.isFinite(Number(resolved.rule?.maxAreaSqm))) {
    bucket.failed += 1;
    fail(row, 'verified_rule_missing_numeric_limits', { ruleLocation });
    continue;
  }
  bucket.verifiedRules += 1;
}

const territories = [...byJurisdiction.values()].sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction, 'de'));
const routed = territories.reduce((sum, row) => sum + row.routed, 0);
const verifiedRules = territories.reduce((sum, row) => sum + row.verifiedRules, 0);
const pendingFailClosed = territories.reduce((sum, row) => sum + row.pendingFailClosed, 0);
const totalFailed = territories.reduce((sum, row) => sum + row.failed, 0);

const summary = {
  generatedAt: new Date().toISOString(),
  source: SH_MUNICIPALITY_SOURCE,
  officialMunicipalityCount: SH_OFFICIAL_MUNICIPALITY_COUNT,
  routed,
  verifiedRules,
  pendingFailClosed,
  failed: totalFailed,
  territories,
  failures: failures.slice(0, 100)
};

const output = resolve(process.env.STATEWIDE_AUDIT_OUTPUT || 'qa-artifacts/statewide-routing-audit.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

console.log(`STATEWIDE_ROUTING_AUDIT ${JSON.stringify({ total: SH_OFFICIAL_MUNICIPALITY_COUNT, routed, verifiedRules, pendingFailClosed, failed: totalFailed, territories: territories.length })}`);
for (const row of territories) console.log(`TERRITORY ${JSON.stringify(row)}`);

if (failures.length) {
  for (const item of failures.slice(0, 25)) console.error(`ROUTING_FAILURE ${JSON.stringify(item)}`);
  process.exitCode = 1;
}
