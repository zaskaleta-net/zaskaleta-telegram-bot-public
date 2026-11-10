import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SH_CITY_COUNT,
  SH_UKRAINIAN_PLACE_ROWS,
  canonicalSchleswigHolsteinPlace,
  placeRouteForJobcenter
} from '../src/schleswig-holstein-place-names.mjs';
import { resolveJobcenterRule } from '../src/jobcenter-registry-statewide.mjs';
import { normalizeHousingLocation, knownHousingLocation } from '../src/housing-language.mjs';

test('Ukrainian place registry covers all 63 Schleswig-Holstein cities', () => {
  assert.equal(SH_CITY_COUNT, 63);
  const cities = SH_UKRAINIAN_PLACE_ROWS.filter(row => row.city);
  assert.equal(new Set(cities.map(row => row.canonical)).size, 63);
  for (const row of cities) assert.ok(row.aliases.length >= 1, row.canonical);
});

test('representative Ukrainian city names normalize across every Schleswig-Holstein territory', () => {
  const examples = [
    ['Гайде','Heide'], ['Рацебург','Ratzeburg'], ['Гузум','Husum'], ['Ойтін','Eutin'],
    ['Піннеберг','Pinneberg'], ['Пльон','Plön'], ['Екернферде','Eckernförde'], ['Шлезвіг','Schleswig'],
    ['Бад Зегеберг','Bad Segeberg'], ['Ітцего','Itzehoe'], ['Аренсбург','Ahrensburg'],
    ['Фленсбург','Flensburg'], ['Кіль','Kiel'], ['Любек','Lübeck'], ['Ноймюнстер','Neumünster']
  ];
  for (const [uk, canonical] of examples) assert.equal(normalizeHousingLocation(uk), canonical, uk);
});

test('natural Ukrainian Neumünster spelling without final e normalizes and routes', () => {
  assert.equal(normalizeHousingLocation('Ноймюнстр'), 'Neumünster');
  assert.equal(knownHousingLocation("Ноймюнстр сім'я 3"), 'Neumünster');
  assert.equal(placeRouteForJobcenter('Ноймюнстр')?.jurisdiction, 'Neumünster');
});

test('registered cities route safely: verified/pending where unique and clarification where names are ambiguous', () => {
  // Quickborn, Schenefeld and Nortorf exist in two Kreise each; the bare name asks
  // which Kreis is meant and lists the registered city's Kreis as a candidate.
  const ambiguous = new Set(['Quickborn', 'Schenefeld', 'Nortorf']);
  for (const row of SH_UKRAINIAN_PLACE_ROWS.filter(item => item.city)) {
    const route = placeRouteForJobcenter(row.canonical);
    assert.ok(route, row.canonical);
    const resolved = resolveJobcenterRule(row.canonical, 4);
    if (ambiguous.has(row.canonical)) {
      assert.match(resolved?.status || '', /^ambiguous/u, row.canonical);
      assert.equal(resolved?.rule ?? null, null, row.canonical);
      assert.ok(resolved?.candidates?.includes(row.jurisdiction), row.canonical);
      continue;
    }
    assert.equal(resolved?.jurisdiction, row.jurisdiction, row.canonical);
    if (!['Ostholstein','Neumünster'].includes(row.jurisdiction)) {
      assert.equal(resolved?.status, 'verified', `${row.canonical}: ${resolved?.status}`);
    }
  }
});

test('Ukrainian city names work at the start of a natural housing request and after a preposition', () => {
  assert.equal(knownHousingLocation("Ітцего житло для сім'ї 4 людини під Джобцентр"), 'Itzehoe');
  assert.equal(knownHousingLocation('Потрібно житло в Бредштедт для 3 людей під Jobcenter'), 'Bredstedt');
  assert.equal(knownHousingLocation('Житло у Каппельн для 4 людей під Jobcenter'), 'Kappeln');
  assert.equal(knownHousingLocation("Тріттау житло для сім'ї 4 людини Для Джобцентер"), 'Trittau');
});

test('canonical Ukrainian aliases preserve city search text while Jobcenter routing can use a zone hint', () => {
  assert.equal(canonicalSchleswigHolsteinPlace('Бредштедт'), 'Bredstedt');
  assert.equal(placeRouteForJobcenter('Бредштедт').ruleLocation, 'Amt Mittleres Nordfriesland');
  assert.equal(placeRouteForJobcenter('Каппельн').ruleLocation, 'Kreis Schleswig-Flensburg');
  assert.equal(placeRouteForJobcenter('Тріттау').ruleLocation, 'Trittau');
});
