import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHouseholdSize, normalizeHousingLocation, knownHousingLocation } from '../src/housing-language.mjs';

test('explicit household counts accept digits and Ukrainian/Russian number words', () => {
  const examples = [
    ['однієї особи', 1], ['одного человека', 1], ['одну людину', 1],
    ['двух людей', 2], ['двох осіб', 2], ['дві людини', 2], ['два человека', 2],
    ['троє людей', 3], ['трьох осіб', 3], ['трех человек', 3],
    ['чотирьох людей', 4], ['четырех человек', 4], ['4 людини', 4],
    ['п’яти осіб', 5], ['пʼять людей', 5], ['шести осіб', 6], ['сімох людей', 7],
    ['восьми осіб', 8], ['дев’яти людей', 9], ['десять людей', 10],
    ['одинадцять осіб', 11], ['дванадцяти людей', 12], ['тринадцать человек', 13],
    ['чотирнадцять осіб', 14], ['п’ятнадцяти людей', 15], ['шістнадцять осіб', 16],
    ['семнадцать человек', 17], ['вісімнадцяти осіб', 18], ['дев’ятнадцять людей', 19],
    ['двадцяти осіб', 20], ['20 Personen', 20]
  ];
  for (const [phrase, expected] of examples) assert.equal(parseHouseholdSize(`Житло для ${phrase} в Lübeck`), expected, phrase);
});

test('rooms, invalid counts and ambiguous household counts never become a small family', () => {
  for (const input of [
    'дві кімнати', '3 кімнати, 900 євро', '2,5 Zimmer', 'для людей', '0 людей', 'нуль людей',
    '-4 людей', '−4 людей', '+4 людей', '21 людей', '104 людей', '2-4 людей',
    '2 - 4 людей', '2,5 людей', 'двох або трьох людей', 'двадцять одна особа',
    'сорок дві людини', '2 людей або 3 людей'
  ]) assert.equal(parseHouseholdSize(input), null, input);
  assert.equal(parseHouseholdSize('Житло для двух людей, 3 кімнати, до 900 €'), 2);
  assert.equal(parseHouseholdSize('два дорослих і троє дітей'), 5);
});

test('compact family requests preserve registered place and household total', () => {
  assert.equal(knownHousingLocation("Шведенек сім'я 3"), 'Schwedeneck');
  assert.equal(parseHouseholdSize("Шведенек сім'я 3"), 3);
  assert.equal(knownHousingLocation("Альтенгольц сім'я 4"), 'Altenholz');
  assert.equal(parseHouseholdSize("Альтенгольц сім'я 4"), 4);
  assert.equal(parseHouseholdSize("Альтенгольц сім'я з 4 осіб"), 4);
  assert.equal(parseHouseholdSize('сімдесят людей'), null);
});

test('Lübeck aliases normalize in city input and lower-case natural text', () => {
  for (const alias of ['Любику', 'любику', 'ЛЮБИКУ', 'Любек', 'Любеку', 'Любеці', 'Любеке', 'Lübeck', 'Luebeck', 'lu\u0308beck']) {
    assert.equal(normalizeHousingLocation(alias), 'Lübeck', alias);
    assert.equal(knownHousingLocation(`Житло в ${alias} під Jobcenter`), 'Lübeck', alias);
  }
  assert.equal(normalizeHousingLocation('  Bad   Oldesloe  '), 'Bad Oldesloe');
  assert.equal(normalizeHousingLocation('Невідоме місто'), 'Невідоме місто');
  assert.equal(knownHousingLocation('Любиково'), null);
  assert.equal(knownHousingLocation('Ahrensburg'), 'Ahrensburg');
});

test('natural statewide locations accept lower-case input and return canonical German place names', () => {
  const examples = [
    ['Потрібно житло для 3 людей in heide під Jobcenter', 'Heide'],
    ['Житло для 4 людей in bad schwartau для Jobcenter', 'Bad Schwartau'],
    ['Wohnung für 2 Personen in neustadt in holstein unter Jobcenter', 'Neustadt in Holstein'],
    ['Житло для 3 людей у oldenburg in holstein Jobcenter', 'Oldenburg in Holstein'],
    ['Житло для 2 людей в neumünster під Джобцентер', 'Neumünster']
  ];
  for (const [input, expected] of examples) assert.equal(knownHousingLocation(input), expected, input);
  assert.equal(knownHousingLocation('Житло для 3 людей під Jobcenter'), null);
});

test('city-first housing requests from the group screenshot resolve without requiring a preposition', () => {
  assert.equal(knownHousingLocation("Trittau житло для сім'ї 4 людини Для Джобцентер"), 'Trittau');
  assert.equal(knownHousingLocation("Тріттау житло для сім'ї 4 людини Для Джобцентер"), 'Trittau');
  assert.equal(knownHousingLocation("Триттау житло для сім'ї 4 людини Для Джобцентер"), 'Trittau');
  assert.equal(knownHousingLocation("Трітау житло для сім'ї 4 людини Для Джобцентер"), 'Trittau');
  assert.equal(knownHousingLocation('Житло в Тріттау для 4 людей під Jobcenter'), 'Trittau');
  assert.equal(knownHousingLocation('Bad Oldesloe житло для 3 людей під Jobcenter'), 'Bad Oldesloe');
});

test('Ukrainian Stormarn district phrasing is recognized without losing district meaning', () => {
  for (const value of ['районі штормарн', 'район Штормарн', 'Kreis Stormarn', 'Landkreis Stormarn']) {
    assert.equal(normalizeHousingLocation(value), 'Kreis Stormarn', value);
  }
  assert.equal(knownHousingLocation("Потрібно житло в районі штормарн для сім'ї з 4 людей"), 'Kreis Stormarn');
  assert.equal(knownHousingLocation("Потрібно житло в районі штормарн для сім'ї з 4 людей під Джобцентер"), 'Kreis Stormarn');
  assert.equal(knownHousingLocation('Житло в штормарн для 4 людей'), 'Stormarn');
});

test('Ukrainian Segeberg district phrasing from the screenshot is recognized as Kreis Segeberg', () => {
  for (const value of ['район Зегеберг', 'районі Зегеберг', 'Kreis Segeberg']) {
    assert.equal(normalizeHousingLocation(value), 'Kreis Segeberg', value);
  }
  assert.equal(
    knownHousingLocation("Потрібно житло сім'я 4 людини район Зегеберг під Джобцентр"),
    'Kreis Segeberg'
  );
});

test('Ukrainian Schleswig-Flensburg district phrasing never collapses to Flensburg city', () => {
  for (const value of ['районі Шлезвіг-Фленсбург', 'район Шлезвіг-Фленсбург', 'Kreis Schleswig-Flensburg']) {
    assert.equal(normalizeHousingLocation(value), 'Kreis Schleswig-Flensburg', value);
  }
  assert.equal(
    knownHousingLocation("Потрібно житло для сім'ї 4 людей в районі Шлезвіг-Фленсбург під Джобцентр"),
    'Kreis Schleswig-Flensburg'
  );
  assert.equal(knownHousingLocation('Житло в Фленсбург для 4 людей під Джобцентр'), 'Flensburg');
});