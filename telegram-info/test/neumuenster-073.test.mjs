import test from 'node:test';
import assert from 'node:assert/strict';
import { SH_PENDING_KDU_TERRITORIES } from '../src/jobcenter-registry-statewide.mjs';

// TG-RUNTIME-073 (full analysis H6): after 01.10.2026 the Neumünster text
// still said the new limits "не застосовуються раніше 01.10.2026" — a future
// tense for a date that has passed. No numbers are added: the new table is
// still not verified from an official source.
test('#073 Neumünster: the new limits are announced from 01.10.2026, not claimed in force; no unverified numbers', () => {
  const pending = SH_PENDING_KDU_TERRITORIES.Neumünster;
  assert.match(pending.messageUk, /оголосила нові межі.*з 01\.10\.2026/u);
  assert.doesNotMatch(pending.messageUk, /діють/u, 'the agenda item only announces it');
  assert.match(pending.messageUk, /Перевіреної офіційної таблиці з сумами в боті поки немає/u);
  assert.doesNotMatch(pending.messageUk, /не застосовуються раніше|майбутні межі/u);
  assert.match(pending.messageUk, /уточніть межу для вашого домогосподарства в Jobcenter Neumünster/u);
  assert.doesNotMatch(pending.messageUk, /\d+[.,]\d{2}\s*€|\d{3,4}\s*€/u, 'no amounts');
  assert.equal(pending.status, 'current-and-future-thresholds-need-direct-official-verification');
});
