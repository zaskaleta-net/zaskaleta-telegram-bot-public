import test from 'node:test';
import assert from 'node:assert/strict';
import { STORMARN_KDU_REGISTRY, stormarnGroupForLocation, stormarnRuleFor, evaluateStormarnHousing, parseRentBreakdown } from '../src/jobcenter-rules.mjs';

test('registry is explicitly source-grounded and valid from 2025-01-01', () => {
  assert.equal(STORMARN_KDU_REGISTRY.validFrom, '2025-01-01');
  assert.equal(STORMARN_KDU_REGISTRY.costMeasure, 'Kaltmiete + Betriebskosten (ohne Heizkosten)');
  assert.ok(STORMARN_KDU_REGISTRY.sources.every(source => source.url.startsWith('https://')));
});

test('all 55 Stormarn municipalities map to a verified rules group', () => {
  const names = [
    'Ahrensburg','Bad Oldesloe','Bargteheide','Glinde','Reinbek','Reinfeld (Holstein)','Ammersbek','Barsbüttel','Großhansdorf','Oststeinbek',
    'Braak','Brunsbek','Hoisdorf','Siek','Stapelfeld',
    'Grabau','Lasbek','Meddewade','Neritz','Pölitz','Rethwisch','Rümpel','Steinburg','Travenbrück',
    'Bargfeld-Stegen','Delingsdorf','Elmenhorst','Hammoor','Jersbek','Nienwohld','Todendorf','Tremsbüttel',
    'Badendorf','Barnitz','Feldhorst','Hamberge','Heidekamp','Heilshoop','Klein Wesenberg','Mönkhagen','Rehhorst','Wesenberg','Westerau','Zarpen',
    'Grande','Grönwohld','Großensee','Hamfelde','Hohenfelde','Köthel','Lütjensee','Rausdorf','Trittau','Witzhave','Tangstedt'
  ];
  assert.equal(names.length, 55);
  for (const name of names) assert.ok(stormarnGroupForLocation(name === 'Steinburg' ? 'Steinburg, Kreis Stormarn' : name), name);
  assert.equal(stormarnGroupForLocation('Hamburg Farmsen-Berne'), null);
});

test('official Stormarn thresholds are reproduced exactly', () => {
  assert.equal(stormarnRuleFor('22946 Trittau', 4).grossColdLimit, 943.80);
  assert.equal(stormarnRuleFor('Ahrensburg', 4).grossColdLimit, 1138.50);
  assert.equal(stormarnRuleFor('Glinde', 4).grossColdLimit, 1040.60);
  assert.deepEqual(
    { cost: stormarnRuleFor('Trittau', 6).grossColdLimit, area: stormarnRuleFor('Trittau', 6).maxAreaSqm },
    { cost: 1211.10, area: 115 }
  );
});

test('assessment never emits automatic pass without full cold/heating breakdown', () => {
  assert.equal(evaluateStormarnHousing({ location:'Trittau', householdSize:4, kaltmiete:700, betriebskosten:150 }).status, 'insufficient_data');
  assert.equal(evaluateStormarnHousing({ location:'Trittau', householdSize:4, kaltmiete:900, betriebskosten:100, heizkosten:80 }).status, 'over_limit');
  const overArea = evaluateStormarnHousing({ location:'Trittau', householdSize:4, kaltmiete:700, betriebskosten:150, heizkosten:80, areaSqm:95 });
  assert.equal(overArea.status, 'within_guideline');
  assert.equal(overArea.areaAboveGuideline, true);
  assert.equal(evaluateStormarnHousing({ location:'Trittau', householdSize:4, kaltmiete:700, betriebskosten:150, heizkosten:80, areaSqm:90 }).status, 'within_guideline');
});

test('rent breakdown accepts labels or exactly three ordered amounts', () => {
  assert.deepEqual(parseRentBreakdown('Kaltmiete 700, Nebenkosten 150, Heizkosten 80'), { kaltmiete:700, betriebskosten:150, heizkosten:80 });
  assert.deepEqual(parseRentBreakdown('700 150 80'), { kaltmiete:700, betriebskosten:150, heizkosten:80 });
});

