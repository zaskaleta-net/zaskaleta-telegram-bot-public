import test from 'node:test';
import assert from 'node:assert/strict';
import { knownHousingLocation, normalizeHousingLocation } from '../src/housing-language.mjs';

test('Rendsburg typo from real beta report is normalized before housing continuation', () => {
  const text = 'Ренсберг житло для сім’ї двоє дітей та двоє';
  assert.equal(normalizeHousingLocation('Ренсберг'), 'Rendsburg');
  assert.equal(knownHousingLocation(text), 'Rendsburg');
});
