import test from 'node:test';
import assert from 'node:assert/strict';
import { housingJobcenterOverview } from '../src/housing-jobcenter-overview.mjs';

test('Kiel one-person reply keeps official table and exposes the 2026 LSG caveat', () => {
  const result = housingJobcenterOverview('Kiel', 1, '2026-09-16');
  assert.match(result.text, /474,50 €|474\.50 €|474,5 €|474\.5 €/u);
  assert.match(result.text, /502,50 €/u);
  assert.match(result.text, /11\.05\.2026/u);
  assert.match(result.text, /L 6 AS 175\/25 B ER/u);
  assert.match(result.text, /не автоматична загальна заміна нормативу/u);
});

test('Kiel multi-person reply does not apply the one-person court caveat', () => {
  const result = housingJobcenterOverview('Kiel', 2, '2026-09-16');
  assert.match(result.text, /545/u);
  assert.doesNotMatch(result.text, /502,50|L 6 AS 175\/25 B ER/u);
});

// 2026-10-12: the Jobcenter Ostholstein page still links "Mietobergrenzen ab Mai
// 2025" as its current table, so the zone limit is shown with that date and source.
test('Ostholstein reply shows the official May 2025 zone limit with its date and source', () => {
  const result = housingJobcenterOverview('Eutin', 4, '2026-10-12');
  assert.equal(result.needsLocation,false);
  assert.match(result.text, /829,80 €/u);
  assert.match(result.text, /01\.05\.2025/u);
  assert.match(result.text, /jobcenter-ostholstein\.de/u);
  assert.doesNotMatch(result.text, /Непідтверджені суми не підставляю/u);
});

test('Neumünster pending reply names the announced change and activates no values', () => {
  // TG-RUNTIME-073: the same text on any date; it states the announcement only.
  const result = housingJobcenterOverview('Neumünster', 4, '2026-10-24');
  assert.match(result.text, /оголосила нові межі.*з 01\.10\.2026/u);
  assert.doesNotMatch(result.text, /діють/u);
  assert.match(result.text, /Непідтверджені суми не підставляю/u);
  assert.doesNotMatch(result.text, /до \d+[\d.,]* €|до \d+ м²/u);
});
