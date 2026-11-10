import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlaceName, transliterations } from '../src/place-search.mjs';
import { eventsPlace } from '../src/events-nordticker.mjs';
import { beratungPlace } from '../src/beratung-bamf.mjs';

test('Ukrainian spellings find the Schleswig-Holstein municipality', () => {
  const cases = { 'Тріттау':'Trittau', 'тріттау':'Trittau', 'Ельмсхорн':'Elmshorn', 'Бад Ольдесло':'Bad Oldesloe', 'Ноймюнстер':'Neumünster',
    'Гайде':'Heide', 'Пінеберг':'Pinneberg', 'Ітцехое':'Itzehoe', 'Гузум':'Husum', 'Рендсбург':'Rendsburg', 'Шлезвіг':'Schleswig',
    'Еккернферде':'Eckernförde', 'Бад Зеґеберг':'Bad Segeberg', 'Кіль':'Kiel' };
  for (const [typed, town] of Object.entries(cases)) assert.equal(resolvePlaceName(typed), town, typed);
});

test('German names, umlauts written as plain letters and small typos are found', () => {
  assert.equal(resolvePlaceName('Kiel'), 'Kiel');
  assert.equal(resolvePlaceName('Neumunster'), 'Neumünster');
  assert.equal(resolvePlaceName('Elmhorn'), 'Elmshorn');
  assert.equal(resolvePlaceName('bad segeberg'), 'Bad Segeberg');
});

test('nothing outside Schleswig-Holstein and no guess on noise', () => {
  for (const typed of ['Москва', 'abc', '', 'xyzzy', 'München']) assert.equal(resolvePlaceName(typed), null, typed);
});

test('transliteration is bounded', () => {
  assert.ok(transliterations('Гхгхгхгхгхгхгхгх').length <= 64);
  assert.ok(transliterations('Тріттау').includes('trittau'));
});

test('events and counselling use the town search', () => {
  assert.equal(eventsPlace('Тріттау').town, 'Trittau');
  assert.deepEqual(beratungPlace('Тріттау'), { kreis:'01062', kreisName:'Stormarn', town:'Trittau' });
  assert.equal(beratungPlace('Ельмсхорн').kreisName, 'Pinneberg');
});
