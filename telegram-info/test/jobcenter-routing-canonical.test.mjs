import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateJobcenterHousing, resolveJobcenterRule } from '../src/jobcenter-registry-statewide.mjs';
import { SH_RUNTIME_MUNICIPALITY_ROWS } from '../src/sh-municipality-jurisdiction-runtime.mjs';
import { jobcenterRuleLocationForMunicipality } from '../src/schleswig-holstein-jobcenter-route.mjs';
import { housingJobcenterOverview } from '../src/housing-jobcenter-overview.mjs';

// Bare canonical municipality names (what the bot stores after the statewide
// directory resolved the user's place) must route through the pinned 1104-row
// Schleswig-Holstein index, never through substring hits in another Kreis or a
// same-named Hamburg Stadtteil.

function verified(location, persons) {
  const resolved = resolveJobcenterRule(location, persons);
  assert.equal(resolved?.status, 'verified', `${location} (${persons}) -> ${resolved?.status}`);
  return resolved;
}

function assertAmbiguous(location, expectedCandidates) {
  const resolved = resolveJobcenterRule(location, 2);
  assert.equal(resolved?.status, 'ambiguous_municipality', `${location} -> ${resolved?.status}/${resolved?.jurisdiction}`);
  assert.equal(resolved.rule, null);
  assert.equal(resolved.jurisdiction, null);
  assert.deepEqual([...resolved.candidates].sort(), [...expectedCandidates].sort(), location);
}

test('Groß Kummerfeld uses Kreis Segeberg, not Pinneberg Mietstufe 4', () => {
  const resolved = verified('Groß Kummerfeld', 3);
  assert.equal(resolved.jurisdiction, 'Segeberg');
  assert.equal(resolved.rule.grossColdLimit, 678.26);
  assert.notEqual(resolved.rule.grossColdLimit, 843.26);
});

test('Neuendorf b. Elmshorn uses Kreis Steinburg, not Elmshorn/Pinneberg', () => {
  const resolved = verified('Neuendorf b. Elmshorn', 3);
  assert.equal(resolved.jurisdiction, 'Steinburg');
  assert.equal(resolved.rule.grossColdLimit, 645.70);
});

test('SH municipalities sharing a Hamburg Stadtteil name stay in Schleswig-Holstein', () => {
  const langenhorn = verified('Langenhorn', 3);
  assert.equal(langenhorn.jurisdiction, 'Nordfriesland');
  assert.equal(langenhorn.rule.grossColdLimit, 742);

  const osdorf = verified('Osdorf', 3);
  assert.equal(osdorf.jurisdiction, 'Rendsburg-Eckernförde');
  assert.equal(osdorf.rule.grossColdLimit, 766.50);

  assertAmbiguous('Hohenfelde', ['Plön', 'Steinburg', 'Stormarn']);
  assert.notEqual(resolveJobcenterRule('Hohenfelde', 3).jurisdiction, 'Hamburg');
});

test('explicit Hamburg context still routes to Hamburg', () => {
  for (const location of ['Hamburg Langenhorn', 'Hamburg-Osdorf', 'Hohenfelde Hamburg', 'Hamburg']) {
    assert.equal(resolveJobcenterRule(location, 3)?.jurisdiction, 'Hamburg', location);
  }
});

test('Alt-Mölln uses its own Amt Breitenfelde zone, not Stadt Mölln', () => {
  const resolved = verified('Alt-Mölln', 3);
  assert.equal(resolved.jurisdiction, 'Herzogtum Lauenburg');
  assert.equal(resolved.rule.zone, 'vr1');
  assert.equal(resolved.rule.grossColdLimit, 685.50);
  assert.equal(verified('Mölln', 3).rule.grossColdLimit, 722.70);
});

test('names that exist in two Kreise ask which Kreis is meant', () => {
  for (const name of ['Elmenhorst', 'Grabau', 'Hamfelde', 'Köthel']) assertAmbiguous(name, ['Herzogtum Lauenburg', 'Stormarn']);
  assertAmbiguous('Rethwisch', ['Steinburg', 'Stormarn']);
  assertAmbiguous('Nortorf', ['Rendsburg-Eckernförde', 'Steinburg']);
  assertAmbiguous('Quickborn', ['Dithmarschen', 'Pinneberg']);
  assertAmbiguous('Schenefeld', ['Pinneberg', 'Steinburg']);
});

test('the Gemeinde Steinburg (Stormarn) does not hide Kreis Steinburg', () => {
  assertAmbiguous('Steinburg', ['Steinburg', 'Stormarn']);
});

test('explicit Kreis input disambiguates duplicate names', () => {
  const stormarn = verified('Elmenhorst Kreis Stormarn', 3);
  assert.equal(stormarn.jurisdiction, 'Stormarn');
  assert.equal(stormarn.rule.grossColdLimit, 810.70);
  const lauenburg = verified('Schwarzenbek-Land Kreis Herzogtum Lauenburg', 3);
  assert.equal(lauenburg.jurisdiction, 'Herzogtum Lauenburg');
  assert.equal(lauenburg.rule.grossColdLimit, 693);
  assert.equal(verified('Quickborn Kreis Pinneberg', 3).rule.grossColdLimit, 922.46);
  assert.equal(verified('Nortorf Kreis Rendsburg-Eckernförde', 3).rule.grossColdLimit, 660.75);
});

test('canonical names in previously unmapped Kreise resolve to their own Kreis', () => {
  const expectations = [
    ['Hohenaspe', 'Steinburg', 645.70],
    ['Wankendorf', 'Plön', 680],
    ['Tarp', 'Schleswig-Flensburg', 669],
    ['Breitenberg', 'Steinburg', 645.70]
  ];
  for (const [name, jurisdiction, limit] of expectations) {
    const resolved = verified(name, 3);
    assert.equal(resolved.jurisdiction, jurisdiction, name);
    assert.equal(resolved.rule.grossColdLimit, limit, name);
  }
});

test('Pinneberg Mietstufe 4 towns are not lifted to Mietstufe 5 by the "Kreis Pinneberg" suffix', () => {
  for (const name of ['Elmshorn', 'Uetersen', 'Barmstedt', 'Appen', 'Helgoland']) {
    for (const location of [name, `${name} Kreis Pinneberg`]) {
      const resolved = verified(location, 3);
      assert.equal(resolved.rule.zone, 'stufe4', location);
      assert.equal(resolved.rule.grossColdLimit, 843.26, location);
    }
  }
  for (const location of ['Pinneberg', 'Pinneberg Kreis Pinneberg']) {
    assert.equal(verified(location, 3).rule.zone, 'stufe5', location);
  }
  assert.equal(verified('Wedel Kreis Pinneberg', 3).rule.zone, 'stufe6');
});

test('Amt Itzehoe-Land municipalities use the Steinburg rest group, Stadt Itzehoe keeps its own limits', () => {
  assert.equal(verified('Itzehoe', 3).rule.grossColdLimit, 722.70);
  const amt = verified('Amt Itzehoe-Land Kreis Steinburg', 3);
  assert.equal(amt.rule.zone, 'rest');
  assert.equal(amt.rule.grossColdLimit, 645.70);
  const itzehoeLand = SH_RUNTIME_MUNICIPALITY_ROWS.filter(row => jobcenterRuleLocationForMunicipality(row) === 'Amt Itzehoe-Land Kreis Steinburg');
  assert.ok(itzehoeLand.length >= 20, `expected Amt Itzehoe-Land rows, got ${itzehoeLand.length}`);
  for (const row of itzehoeLand) {
    const resolved = resolveJobcenterRule(row.canonical, 3);
    if (resolved.status === 'ambiguous_municipality') continue;
    assert.equal(resolved.rule?.zone, 'rest', row.canonical);
  }
});

test('area guideline above extraAfter continues from the last published row', () => {
  const eight = verified('Husum', 8);
  const nine = verified('Husum', 9);
  assert.equal(eight.rule.maxAreaSqm, 135);
  assert.equal(nine.rule.maxAreaSqm, 145);
  assert.equal(nine.rule.grossColdLimit, 1461);
  assert.equal(verified('Geesthacht', 6).rule.maxAreaSqm, 115);
});

test('housing evaluation follows the same canonical routing', () => {
  const kummerfeld = evaluateJobcenterHousing({ location:'Groß Kummerfeld', householdSize:3, kaltmiete:550, betriebskosten:120, heizkosten:80 });
  assert.equal(kummerfeld.rule.jurisdiction, 'Segeberg');
  assert.equal(kummerfeld.rule.grossColdLimit, 678.26);
  assert.equal(kummerfeld.status, 'within_guideline');

  const elmshorn = evaluateJobcenterHousing({ location:'Elmshorn', householdSize:3, kaltmiete:750, betriebskosten:120, heizkosten:80 });
  assert.equal(elmshorn.status, 'over_limit');
  assert.equal(elmshorn.rule.grossColdLimit, 843.26);

  assert.equal(evaluateJobcenterHousing({ location:'Hohenfelde', householdSize:3, kaltmiete:500, betriebskosten:100, heizkosten:80 }).status, 'ambiguous_municipality');
  assert.equal(evaluateJobcenterHousing({ location:'Langenhorn', householdSize:3, kaltmiete:600, betriebskosten:100, heizkosten:80 }).rule.jurisdiction, 'Nordfriesland');
});

test('ambiguous overview asks for the Kreis and lists the candidates', () => {
  const overview = housingJobcenterOverview('Elmenhorst', 3, '2026-10-11');
  assert.equal(overview.needsLocation, true);
  assert.match(overview.text, /Kreis Herzogtum Lauenburg/u);
  assert.match(overview.text, /Kreis Stormarn/u);
  assert.doesNotMatch(overview.text, /€/u);
});

test('Ukrainian aliases keep working', () => {
  assert.equal(verified('Ельмсгорн', 3).rule.grossColdLimit, 843.26);
  assert.equal(verified('Ітцего', 3).rule.grossColdLimit, 722.70);
  assert.equal(verified('Кіль', 1).jurisdiction, 'Kiel');
});

test('sweep: every row of the 1104 index resolves to its own Kreis or asks for the Kreis', () => {
  assert.equal(SH_RUNTIME_MUNICIPALITY_ROWS.length, 1104);
  const failures = [];
  for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
    const resolved = resolveJobcenterRule(row.canonical, 2);
    if (resolved?.status === 'ambiguous_municipality') {
      if (resolved.jurisdiction !== null || !resolved.candidates?.includes(row.jurisdiction)) failures.push(`${row.canonical}: ambiguous without ${row.jurisdiction}`);
      continue;
    }
    if (resolved?.jurisdiction !== row.jurisdiction || resolved?.status === 'unknown_jurisdiction') {
      failures.push(`${row.canonical}: expected ${row.jurisdiction}, got ${resolved?.status}/${resolved?.jurisdiction}`);
      continue;
    }
    const direct = resolveJobcenterRule(jobcenterRuleLocationForMunicipality(row), 2);
    if (resolved.rule?.grossColdLimit !== direct?.rule?.grossColdLimit || resolved.status !== direct?.status) {
      failures.push(`${row.canonical}: canonical ${resolved.status}/${resolved.rule?.grossColdLimit} != route ${direct?.status}/${direct?.rule?.grossColdLimit}`);
    }
  }
  assert.deepEqual(failures, []);
});
