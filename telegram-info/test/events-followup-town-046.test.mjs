import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './runtime-fixture.mjs';

// Phone smoke 17.10.2026, 22:41: after the events list for «Тріттау» the
// owner typed «Гамбург». The saved town question had already been used, so
// the still-active housing context answered «… Trittau …» and the typed
// Hamburg was ignored.

async function housingThenEvents(f) {
  await f.send('Шукаю житло в Trittau');
  await f.send('3-4');
  await f.send('', { callback:'nav:events' });
  await f.send('', { callback:'ev:ask' });
  const first = await f.send('Тріттау');
  assert.equal(first.body.mode, 'events-v1', JSON.stringify(first.body));
}

test('#046 a bare town typed right after an events list gets events for that town', async () => {
  const f = await fixture();
  try {
    await housingThenEvents(f);
    const next = await f.send('Гамбург');
    assert.equal(next.body.mode, 'events-v1', `routed to ${JSON.stringify(next.body)}: ${next.last?.text}`);
    assert.doesNotMatch(String(next.last?.text || ''), /Trittau/u);
    const again = await f.send('Kiel');
    assert.equal(again.body.mode, 'events-v1', 'the follow-up holds for the next bare town too');
  } finally { f.close(); }
});

test('#046 a sentence after an events list is not taken as an events town', async () => {
  const f = await fixture();
  try {
    await housingThenEvents(f);
    const next = await f.send('Шукаю житло в Kiel');
    assert.notEqual(next.body.mode, 'events-v1', JSON.stringify(next.body));
    assert.match(String(next.last?.text || ''), /Kiel/u, next.last?.text);
  } finally { f.close(); }
});

test('#046 a menu button after an events list ends the events follow-up', async () => {
  const f = await fixture();
  try {
    await housingThenEvents(f);
    await f.send('☰ Меню');
    const next = await f.send('Гамбург');
    assert.notEqual(next.body.mode, 'events-v1', JSON.stringify(next.body));
  } finally { f.close(); }
});

test('#046 a bare town typed right after a counselling list gets counselling for that town', async () => {
  const f = await fixture();
  try {
    await f.send('Шукаю житло в Trittau');
    await f.send('3-4');
    const list = await f.send('/beratung Trittau');
    assert.equal(list.body.mode, 'beratung-v1');
    const next = await f.send('Гамбург');
    assert.equal(next.body.mode, 'beratung-v1', `routed to ${JSON.stringify(next.body)}: ${next.last?.text}`);
    const sentence = await f.send('Шукаю житло в Kiel');
    assert.notEqual(sentence.body.mode, 'beratung-v1');
  } finally { f.close(); }
});

test('#046 review F1/F2: /start or any other command ends the follow-up', async () => {
  for (const command of ['/start', '/report', '/menu']) {
    const f = await fixture();
    try {
      await f.send('', { callback:'nav:events' });
      await f.send(command);
      const next = await f.send('Kiel');
      assert.notEqual(next.body.mode, 'events-v1', `${command} then «Kiel» -> ${JSON.stringify(next.body)}`);
    } finally { f.close(); }
  }
});

test('#046 review F3: one-word Ukrainian town spellings continue the section', async () => {
  for (const town of ['Хайде', 'Ойтін', 'Квікборн', 'Кіль']) {
    const f = await fixture();
    try {
      await f.send('Шукаю житло в Trittau');
      await f.send('3-4');
      await f.send('', { callback:'nav:events' });
      const next = await f.send(town);
      assert.equal(next.body.mode, 'events-v1', `«${town}» -> ${JSON.stringify(next.body)}: ${next.last?.text}`);
    } finally { f.close(); }
  }
});
