import test from 'node:test';
import assert from 'node:assert/strict';
import { replyFor } from '../src/worker.mjs';

const cases = [
  ['🏠 Житло', /Тема: житло/u],
  ['🏛 Jobcenter', /Тема: Jobcenter/u],
  ['💼 Робота', /Тема: робота/u],
  ['🎓 Курси', /інтеграційні та мовні курси/u],
  ['👨‍👩‍👧 Школа / Kita', /Тема: школа \/ Kita/u],
  ['🚌 Транспорт', /Тема: транспорт/u],
  ['📄 Документи', /Тема: документи та перебування/u],
  ['👶 Kindergeld', /Familienkasse \/ Kindergeld/u]
];

test('all eight private menu topics route to a dedicated prompt', () => {
  for (const [input, expected] of cases) {
    const reply = replyFor({ text:input });
    assert.match(reply, expected, input);
    assert.doesNotMatch(reply, /База перевірених офіційних джерел ще готується/u, input);
  }
});
