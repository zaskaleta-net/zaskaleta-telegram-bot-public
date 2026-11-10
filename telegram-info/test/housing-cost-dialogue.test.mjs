import test from 'node:test';
import assert from 'node:assert/strict';
import { replyFor } from '../src/worker.mjs';
const action = 'Житло — Kiel, 3-4 кімнати. Оберіть дію.';
const reply = (text, replyToText) => replyFor({ text, replyToText });

test('phone conversation keeps Kiel and rooms through Cyrillic action, ambiguous sum and typo', () => {
  let prompt = reply('Джобцентр', action);
  assert.match(prompt, /^Jobcenter-погодження житла — Kiel, 3-4 кімнати/);
  prompt = reply('900', prompt);
  assert.match(prompt, /Сума без призначення: 900/);
  assert.doesNotMatch(prompt, /Бюджет|Вкажіть місто/);
  prompt = reply('Brtriebskosten', prompt);
  assert.match(prompt, /Зібрано: Betriebskosten 900/);
  prompt = reply('Kaltmiete 700', prompt);
  assert.match(prompt, /Betriebskosten 900/);
  assert.match(prompt, /Ще потрібні: Heizkosten/);
  prompt = reply('Heizkosten 100', prompt);
  assert.match(prompt, /Вкажіть кількість осіб/);
  prompt = reply('4', prompt);
  assert.match(prompt, /Kiel, 3-4 кімнати/);
  assert.match(prompt, /Kaltmiete \+ Betriebskosten: 1600 €/);
  assert.match(prompt, /не Zusicherung/);
  assert.match(prompt, /Джерело: https/);
});

test('replying to older cost prompt accepts labelled typo without guessing unlabeled costs', () => {
  const initial = reply('Jobcenter', action);
  const partial = reply('Brtriebskosten 900', initial);
  assert.match(partial, /Зібрано: Betriebskosten 900/);
  assert.match(partial, /Ще потрібні: Kaltmiete, Heizkosten/);
  assert.doesNotMatch(partial, /не перевищує|Дякуємо за звернення/);
  const unknown = reply('не знаю', partial);
  assert.match(unknown, /Betriebskosten 900/);
  assert.match(unknown, /Kiel, 3-4 кімнати/);
});

test('three labelled amounts are not confused with household size; invalid persons preserve costs', () => {
  let prompt = reply('Kaltmiete 700, Betriebskosten 150, Heizkosten 0', reply('Jobcenter', action));
  assert.match(prompt, /Вкажіть кількість осіб/);
  prompt = reply('0', prompt);
  assert.match(prompt, /Вкажіть кількість осіб/);
  assert.match(prompt, /Heizkosten 0/);
  prompt = reply('4', prompt);
  assert.match(prompt, /Kaltmiete \+ Betriebskosten: 850 €/);
});

test('unrecognised and negative amounts do not become accepted rent data', () => {
  const initial = reply('Jobcenter', action);
  for (const value of ['Kaltmiete -900', 'Kaltmiete 900.123', 'Warmmiete 900', '900 150 100']) {
    const result = reply(value, initial);
    assert.doesNotMatch(result, /Зібрано:|не перевищує/);
    assert.match(result, /Ще потрібні/);
  }
});

test('Jobcenter spellings enter cost collection in both topic and housing action routing', () => {
  for (const text of ['Джобцентр', 'Джобцентер', 'Джобсентер', 'Джобцэнтр', 'ДЖОБЦЕНТЕР', 'Джоб центр', 'Джоб-центер', 'Jobcenter', 'Job Center']) {
    assert.match(reply(text), /^Тема: Jobcenter\./, text);
    const prompt = reply(text, action);
    assert.match(prompt, /^Jobcenter-погодження житла — Kiel, 3-4 кімнати\./, text);
    const next = reply('800', prompt);
    assert.match(next, /Сума без призначення: 800 €/, text);
    assert.doesNotMatch(next, /Оберіть: пошук житла|Вкажіть місто|Бюджет/, text);
  }
});

test('explicit Jobcenter rental assessment is not swallowed by generic rent matching', () => {
  for (const text of ['Джобцентер перевірка оренди', 'Jobcenter погодження оренди', 'погодження оренди']) {
    assert.match(reply(text, action), /^Jobcenter-погодження житла — Kiel/);
  }
  assert.match(reply('перевірка оренди', action), /^Перевірка оренди — Kiel/);
  assert.match(reply('пошук житла для Jobcenter', action), /^Пошук житла — Kiel/);
});

test('number at action menu requests the missing action without inventing its purpose', () => {
  const result = reply('800', action);
  assert.match(result, /^Житло — Kiel, 3-4 кімнати\./);
  assert.match(result, /Спочатку оберіть дію/);
  assert.doesNotMatch(result, /Зібрано:|Бюджет/);
  assert.match(reply('Джобцентер', result), /^Jobcenter-погодження житла — Kiel/);
});
