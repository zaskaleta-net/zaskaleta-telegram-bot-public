import test from 'node:test';
import assert from 'node:assert/strict';
import { translateNewsText } from '../src/news-translation.mjs';
import { withTranslationMemo, loadTranslationMemo, trimmedMemoEntries } from '../src/news-translation-memo.mjs';

function storage() {
  const data = new Map();
  return { data, async get(key) { return structuredClone(data.get(key)); }, async put(key, value) { data.set(key, structuredClone(value)); } };
}

function countingAI() {
  const ai = { calls:0, async run(_model, input) {
    ai.calls += 1;
    const text = input.messages ? input.messages.at(-1).content.replace(/^Translate into Ukrainian:\n/u, '') : input.text;
    return { response:`Переклад: ${text.replace(/[A-Za-zÄÖÜäöüß]+/gu, 'слово')}` };
  } };
  return ai;
}

test('an hourly rebuild translates only headlines it has not seen before', async () => {
  const box = storage();
  const AI = countingAI();
  const first = await withTranslationMemo(box, { AI }, env => Promise.all([
    translateNewsText(env, 'Sperrung der B76 zwischen Plön und Eutin'),
    translateNewsText(env, 'Fähre Missunde III fällt aus')
  ]));
  assert.equal(AI.calls, 2);
  assert.ok(first.every(Boolean));

  const second = await withTranslationMemo(box, { AI }, env => Promise.all([
    translateNewsText(env, 'Sperrung der B76 zwischen Plön und Eutin'),
    translateNewsText(env, 'Fähre Missunde III fällt aus'),
    translateNewsText(env, 'Neue Buslinie in Kiel ab Montag')
  ]));
  assert.equal(AI.calls, 3, 'two answers came from the memo, one new headline went to the model');
  assert.deepEqual(second.slice(0, 2), first);
  assert.equal((await loadTranslationMemo(box)).size, 3);
});

test('a memo hit costs no translation budget', async () => {
  const box = storage();
  const AI = countingAI();
  await withTranslationMemo(box, { AI }, env => translateNewsText(env, 'Fähre Missunde III fällt aus'));
  const budget = { count:0, max:0 };
  const again = await withTranslationMemo(box, { AI }, env => translateNewsText(env, 'Fähre Missunde III fällt aus', { budget }));
  assert.ok(again);
  assert.equal(budget.count, 0);
});

test('a rejected translation is not remembered', async () => {
  const box = storage();
  const AI = { calls:0, async run() { AI.calls += 1; return { response:'' }; } };
  await withTranslationMemo(box, { AI }, env => translateNewsText(env, 'Fähre Missunde III fällt aus'));
  assert.equal((await loadTranslationMemo(box)).size, 0);
});

test('the stored memo stays under the Durable Object value limit and keeps the newest entries', () => {
  const memo = new Map();
  for (let index = 0; index < 400; index += 1) memo.set(index.toString(16).padStart(64, '0'), 'т'.repeat(300));
  const kept = trimmedMemoEntries(memo);
  assert.ok(new TextEncoder().encode(JSON.stringify({ entries:kept })).byteLength < 128 * 1024);
  assert.equal(kept.at(-1)[0], (399).toString(16).padStart(64, '0'));
  assert.ok(kept.length < 400);
});
