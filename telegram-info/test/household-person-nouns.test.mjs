import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHouseholdSize } from '../src/housing-language.mjs';

test('household parser accepts natural Ukrainian person nouns', () => {
  assert.equal(parseHouseholdSize('2 жінки'), 2);
  assert.equal(parseHouseholdSize('дві жінки'), 2);
  assert.equal(parseHouseholdSize('2 чоловіки'), 2);
  assert.equal(parseHouseholdSize('2 дорослих'), 2);
  assert.equal(parseHouseholdSize('2 дітей'), 2);
});

test('household parser sums explicit household composition', () => {
  assert.equal(parseHouseholdSize('2 дорослих і двоє дітей'), 4);
  assert.equal(parseHouseholdSize('1 жінка, 1 чоловік і 2 дітей'), 4);
  assert.equal(parseHouseholdSize('2 Erwachsene und 2 Kinder'), 4);
  assert.equal(parseHouseholdSize('2 взрослых и 2 детей'), 4);
  assert.equal(parseHouseholdSize('2 adults and 2 children'), 4);
  assert.equal(parseHouseholdSize('4 особи: 2 дорослих і 2 дітей'), 4);
});

test('household parser keeps common German, Russian and English nouns usable', () => {
  assert.equal(parseHouseholdSize('2 Frauen'), 2);
  assert.equal(parseHouseholdSize('2 Männer'), 2);
  assert.equal(parseHouseholdSize('2 Erwachsene'), 2);
  assert.equal(parseHouseholdSize('2 Kinder'), 2);
  assert.equal(parseHouseholdSize('2 женщины'), 2);
  assert.equal(parseHouseholdSize('2 взрослых'), 2);
  assert.equal(parseHouseholdSize('2 women'), 2);
  assert.equal(parseHouseholdSize('2 adults'), 2);
});

test('household parser refuses ambiguous, conflicting and oversized household counts', () => {
  assert.equal(parseHouseholdSize('2-3 жінки'), null);
  assert.equal(parseHouseholdSize('25 жінок'), null);
  assert.equal(parseHouseholdSize('5 осіб: 2 дорослих і 2 дітей'), null);
  assert.equal(parseHouseholdSize('12 дорослих і 9 дітей'), null);
});
