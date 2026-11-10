import test from 'node:test';
import assert from 'node:assert/strict';
import { replyFor } from '../src/worker.mjs';
import { normalizeHousingLocation, knownHousingLocation } from '../src/housing-language.mjs';
import { housingJobcenterOverview } from '../src/housing-jobcenter-overview.mjs';

const request = "Потрібно житло сім'я 4 людини район Зегеберг під Джобцентр";

test('Ukrainian Segeberg district wording is recognized without a preposition', () => {
  for (const value of ['район Зегеберг', 'районі Зегеберг', 'Kreis Segeberg', 'Landkreis Segeberg']) {
    assert.equal(normalizeHousingLocation(value), 'Kreis Segeberg', value);
  }
  assert.equal(knownHousingLocation(request), 'Kreis Segeberg');
});

test('screenshot request keeps four people and shows Segeberg district tiers immediately', () => {
  const prompt = replyFor({ text: request, replyToText: replyFor({ text: '/start' }) });
  assert.match(prompt, /Kreis Segeberg визначено/u);
  assert.match(prompt, /^Осіб: 4$/mu);
  assert.match(prompt, /Площа-орієнтир: 85 м²/u);
  assert.match(prompt, /Norderstedt.*1176,34 €/u);
  assert.match(prompt, /Henstedt-Ulzburg.*1078,44 €/u);
  assert.match(prompt, /Bad Segeberg.*981,64 €/u);
  assert.match(prompt, /Bad Bramstedt.*880,44 €/u);
  assert.match(prompt, /інші громади Kreis Segeberg.*792,44 €/u);
  assert.match(prompt, /конкретне місто або громаду/u);
});

test('specific Segeberg municipality uses the current published table without requiring validFrom', () => {
  const result = housingJobcenterOverview('Bad Segeberg', 4, '2026-09-11');
  assert.equal(result.needsLocation, false);
  assert.match(result.text, /Mietstufe 4 – Stadt Bad Segeberg/u);
  assert.match(result.text, /Площа-орієнтир: 85 м²/u);
  assert.match(result.text, /до 981,64 € на місяць/u);
  assert.match(result.text, /aktuelle veröffentlichte Tabelle 2025/u);
  assert.match(result.text, /перевірено 10\.09\.2026/u);
});
