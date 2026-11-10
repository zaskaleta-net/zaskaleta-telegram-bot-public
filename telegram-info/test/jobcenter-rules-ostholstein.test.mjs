import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OSTHOLSTEIN_KDU_REGISTRY,
  evaluateOstholsteinHousing,
  resolveOstholsteinRule,
  resolveOstholsteinZone
} from '../src/jobcenter-rules-ostholstein.mjs';

const EXPECTED = Object.freeze({
  eutin:Object.freeze({
    names:Object.freeze(['Eutin','Malente','Bosau','Süsel']),
    limits:Object.freeze([461.50,555.00,679.50,829.80,963.90]),
    extra:91.80
  }),
  badSchwartau:Object.freeze({
    names:Object.freeze(['Bad Schwartau','Stockelsdorf','Ratekau','Scharbeutz','Timmendorfer Strand','Ahrensbök']),
    limits:Object.freeze([525.00,637.20,803.25,989.10,1187.55]),
    extra:113.10
  }),
  neustadt:Object.freeze({
    names:Object.freeze(['Neustadt in Holstein','Dahme','Grömitz','Kellenhusen (Ostsee)','Altenkrempe','Kasseedorf','Schashagen','Schönwalde am Bungsberg','Sierksdorf']),
    limits:Object.freeze([448.50,608.40,729.00,913.50,1086.75]),
    extra:103.50
  }),
  oldenburg:Object.freeze({
    names:Object.freeze(['Oldenburg in Holstein','Fehmarn','Heiligenhafen','Grube','Göhl','Gremersdorf','Großenbrode','Heringsdorf','Neukirchen','Wangels','Beschendorf','Damlos','Harmsdorf','Kabelhorst','Lensahn','Manhagen','Riepsdorf']),
    limits:Object.freeze([507.00,595.80,681.75,836.10,1082.55]),
    extra:103.10
  })
});

const AREAS = [50,60,75,90,105];

test('official Ostholstein registry contains exactly 36 municipalities in four comparison zones', () => {
  assert.equal(OSTHOLSTEIN_KDU_REGISTRY.validFrom,'2025-05-01');
  assert.equal(OSTHOLSTEIN_KDU_REGISTRY.verifiedCurrentOn,'2026-10-12');
  assert.equal(OSTHOLSTEIN_KDU_REGISTRY.municipalityCount,36);
  assert.match(OSTHOLSTEIN_KDU_REGISTRY.costMeasure,/Bruttokaltmiete/u);
  assert.match(OSTHOLSTEIN_KDU_REGISTRY.heatingRule,/separat/u);

  const names=[];
  for (const [zoneId, expected] of Object.entries(EXPECTED)) {
    const zone=OSTHOLSTEIN_KDU_REGISTRY.zones[zoneId];
    assert.ok(zone,`missing ${zoneId}`);
    assert.equal(zone.municipalities.length,expected.names.length,zoneId);
    names.push(...zone.municipalities.map(item=>item.canonical));
  }
  assert.equal(names.length,36);
  assert.equal(new Set(names).size,36);
});

test('all 36 Ostholstein municipalities resolve to the correct comparison zone', () => {
  for (const [zoneId, expected] of Object.entries(EXPECTED)) {
    for (const name of expected.names) {
      const zone=resolveOstholsteinZone(name);
      assert.equal(zone?.status,'resolved',name);
      assert.equal(zone?.zone,zoneId,name);
      const rule=resolveOstholsteinRule(name,3);
      assert.equal(rule?.status,'verified',name);
      assert.equal(rule?.jurisdiction,'Ostholstein',name);
      assert.equal(rule?.rule?.grossColdLimit,expected.limits[2],name);
      assert.equal(rule?.rule?.maxAreaSqm,75,name);
    }
  }
});

test('Ostholstein 1-5 person limits and area thresholds match the official table', () => {
  for (const [zoneId, expected] of Object.entries(EXPECTED)) {
    const location=expected.names[0];
    for (let persons=1;persons<=5;persons+=1) {
      const resolved=resolveOstholsteinRule(location,persons);
      assert.equal(resolved.status,'verified',`${zoneId}/${persons}`);
      assert.equal(resolved.rule.grossColdLimit,expected.limits[persons-1],`${zoneId}/${persons}`);
      assert.equal(resolved.rule.maxAreaSqm,AREAS[persons-1],`${zoneId}/${persons}`);
    }
  }
});

test('each additional person after five applies the zone-specific BKM increment and 10 m²', () => {
  for (const [zoneId, expected] of Object.entries(EXPECTED)) {
    const resolved=resolveOstholsteinRule(expected.names[0],6);
    assert.equal(resolved.status,'verified',zoneId);
    assert.equal(resolved.rule.grossColdLimit,Math.round((expected.limits[4]+expected.extra)*100)/100,zoneId);
    assert.equal(resolved.rule.maxAreaSqm,115,zoneId);
  }
});

test('Ostholstein evaluation uses gross-cold cost while area remains informational', () => {
  const within=evaluateOstholsteinHousing({
    location:'23701 Eutin', householdSize:3, kaltmiete:500, betriebskosten:150, heizkosten:120, areaSqm:74
  });
  assert.equal(within.status,'within_guideline');
  assert.equal(within.grossCold,650);

  const over=evaluateOstholsteinHousing({
    location:'23701 Eutin', householdSize:3, kaltmiete:600, betriebskosten:100, heizkosten:80, areaSqm:70
  });
  assert.equal(over.status,'over_limit');
  assert.equal(over.grossCold,700);

  const area=evaluateOstholsteinHousing({
    location:'23701 Eutin', householdSize:3, kaltmiete:500, betriebskosten:100, heizkosten:80, areaSqm:76
  });
  assert.equal(area.status,'within_guideline');
  assert.equal(area.areaAboveGuideline,true);
});

test('bare Kreis Ostholstein never receives a guessed comparison-zone limit', () => {
  const resolved=resolveOstholsteinRule('Kreis Ostholstein',3);
  assert.equal(resolved.status,'not_yet_mapped');
  assert.equal(resolved.rule,null);
});
