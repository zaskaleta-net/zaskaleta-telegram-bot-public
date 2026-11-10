import test from 'node:test';
import assert from 'node:assert/strict';
import { replyFor } from '../src/worker.mjs';

const cases = [
  // A topic with a concrete question now answers with next steps directly.
  ['Jobcenter Bescheid', /^🏛 Jobcenter\n[\s\S]*Rechtsbehelfsbelehrung/u],
  ['Kindergeld Familienkasse', /Familienkasse/],
  ['Aufenthalt eAT', /документи та перебування/],
  ['Шукаю житло в Trittau', /Тема: житло/],
  ['Потрібна робота', /Тема: робота/],
  ['Integrationskurs Deutsch', /інтеграційні та мовні курси/],
  ['Schule Kita', /школа \/ Kita/],
  ['HVV поїзд Hamburg', /^🚌 Транспорт\n[\s\S]*https:\/\/www\.hvv\.de\//u]
];

for (const [input, expected] of cases) {
  test(`routes topic: ${input}`, () => {
    const reply = replyFor({ text: input });
    assert.match(reply, expected);
    assert.ok(reply.length > 20 && reply.length < 1000);
  });
}

test('housing request reuses an explicitly supplied location', () => {
  const reply = replyFor({ text: 'Шукаю житло в Trittau' });
  assert.match(reply, /житло — Trittau/);
  assert.match(reply, /Локацію вже визначено/);
  assert.doesNotMatch(reply, /Вкажіть місто або район/);
});

test('multi-word German location is preserved', () => {
  const reply = replyFor({ text: 'Шукаю Wohnung in Bad Oldesloe' });
  assert.match(reply, /житло — Bad Oldesloe/);
  assert.doesNotMatch(reply, /Вкажіть місто або район/);
});

test('housing request without location still asks for one', () => {
  const reply = replyFor({ text: 'Шукаю житло' });
  assert.match(reply, /Вкажіть місто або район/);
});

test('unknown free text still fails closed without inventing an answer', () => {
  const reply = replyFor({ text: 'Невідоме довільне питання' });
  assert.match(reply, /ще готується/);
  assert.match(reply, /\/topics/);
});
