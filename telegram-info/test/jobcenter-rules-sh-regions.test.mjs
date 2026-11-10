import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SH_REGIONAL_KDU_MODULES,
  resolveRegionalJobcenterRule
} from '../src/jobcenter-rules-sh-regions.mjs';

test('five additional Schleswig-Holstein regional KdU modules are source-verified', () => {
  assert.deepEqual(Object.keys(SH_REGIONAL_KDU_MODULES).sort(), [
    'Herzogtum Lauenburg', 'Nordfriesland', 'Plön', 'Rendsburg-Eckernförde', 'Steinburg'
  ].sort());
});

test('Rendsburg-Eckernförde uses four official comparison spaces from 01.07.2026', () => {
  assert.equal(resolveRegionalJobcenterRule('Rendsburg', 4).rule.grossColdLimit, 784.80);
  assert.equal(resolveRegionalJobcenterRule('Kronshagen', 4).rule.grossColdLimit, 949.50);
  assert.equal(resolveRegionalJobcenterRule('Eckernförde', 4).rule.grossColdLimit, 908.10);
  assert.equal(resolveRegionalJobcenterRule('Wasbek', 4).rule.grossColdLimit, 796.50);
  assert.equal(resolveRegionalJobcenterRule('Rendsburg', 6).rule.grossColdLimit, 1053.40);
});

test('Herzogtum Lauenburg preserves local comparison-space limits and official >5 formula', () => {
  assert.equal(resolveRegionalJobcenterRule('Geesthacht', 4).rule.grossColdLimit, 1040.60);
  assert.equal(resolveRegionalJobcenterRule('Ratzeburg', 8).rule.grossColdLimit, 1312.30);
  assert.equal(resolveRegionalJobcenterRule('Amt Hohe Elbgeest', 4).rule.grossColdLimit, 954.00);
  assert.equal(resolveRegionalJobcenterRule('Kreis Herzogtum Lauenburg', 4).status, 'not_yet_mapped');
});

test('Nordfriesland uses current 01.01.2026 regions and handles k.A. conservatively', () => {
  assert.equal(resolveRegionalJobcenterRule('Husum', 4).rule.grossColdLimit, 921);
  assert.equal(resolveRegionalJobcenterRule('Sylt', 8).rule.grossColdLimit, 1614);
  assert.equal(resolveRegionalJobcenterRule('Südtondern', 6).rule.grossColdLimit, 1078);
  assert.equal(resolveRegionalJobcenterRule('Südtondern', 7).status, 'individual_review');
});

test('Plön and Steinburg values are zone-specific and no bare ambiguous Schenefeld is auto-routed', () => {
  assert.equal(resolveRegionalJobcenterRule('Plön', 4).rule.grossColdLimit, 800);
  assert.equal(resolveRegionalJobcenterRule('Preetz', 4).rule.grossColdLimit, 890);
  assert.equal(resolveRegionalJobcenterRule('Itzehoe', 4).rule.grossColdLimit, 842.60);
  assert.equal(resolveRegionalJobcenterRule('Amt Schenefeld', 4).rule.grossColdLimit, 754.60);
  assert.equal(resolveRegionalJobcenterRule('Schenefeld', 4).status, 'ambiguous_location');
});


test('explicit Kreis suffix never hijacks a more specific regional KdU zone', () => {
  const cases = [
    ['Amt Hohe Elbgeest Kreis Herzogtum Lauenburg', 'vr6-hohe-elbgeest', 787.50],
    ['Amt Eiderstedt Kreis Nordfriesland', 'sud', 768],
    ['Amt Lütjenburg Kreis Plön', 'ost', 680],
    ['Altenholz Kreis Rendsburg-Eckernförde', 'vr2', 766.50],
    ['Amt Dänischenhagen Kreis Rendsburg-Eckernförde', 'vr2', 766.50],
    ['Amt Dänischer Wohld Kreis Rendsburg-Eckernförde', 'vr2', 766.50],
    ['Amt Bordesholm Kreis Rendsburg-Eckernförde', 'vr4', 660.75],
    ['Fockbek Kreis Rendsburg-Eckernförde', 'vr1', 645.75],
    ['Amt Krempermarsch Kreis Steinburg', 'rest', 645.70]
  ];
  for (const [location, zone, grossColdLimit] of cases) {
    const resolved = resolveRegionalJobcenterRule(location, 3);
    assert.equal(resolved?.status, 'verified', location);
    assert.equal(resolved?.rule?.zone, zone, location);
    assert.equal(resolved?.rule?.grossColdLimit, grossColdLimit, location);
  }
  assert.equal(resolveRegionalJobcenterRule('Kreis Rendsburg-Eckernförde', 3).status, 'not_yet_mapped');
});


test('Nortorf resolves to the published Rendsburg-Eckernförde VR4 limits', () => {
  const resolved = resolveRegionalJobcenterRule('Nortorf', 4);
  assert.equal(resolved?.status, 'verified');
  assert.equal(resolved?.jurisdiction, 'Rendsburg-Eckernförde');
  assert.equal(resolved?.rule?.zone, 'vr4');
  assert.equal(resolved?.rule?.grossColdLimit, 796.50);
});
