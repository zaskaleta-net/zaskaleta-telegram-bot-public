import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// TG-RUNTIME-070 (dialogue check 24.10.2026, after the full analysis): people
// type, they do not reply to the bot's message.
// - A new complete request kept the previous town: after "Житло — Trittau, …"
//   both "Шукаю квартиру в Kiel до 800 € для 3 осіб" and "Kiel, 3 кімнати,
//   800" were answered about Trittau.
// - A bare town name ("Kiel") gave "Не вдалося однозначно зрозуміти запит".
// - A typed request with town, rooms and persons ended without the action
//   buttons that the button flow shows.

const STAGING = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' };
const USER = 555555;

async function say(f, text) {
  const before = f.calls.length;
  await handle(f.request(text, { user:USER }), f.env, NOW, f.transport);
  const sent = f.calls.slice(before).filter(call => call.method === 'sendMessage' && call.body?.text);
  return sent.at(-1)?.body;
}

function buttons(body) {
  return (body?.reply_markup?.inline_keyboard || []).flat().map(button => button.callback_data).filter(Boolean);
}

test('#070 a new complete request with another town does not keep the previous town', async () => {
  for (const next of ['Шукаю квартиру в Kiel до 800 € для 3 осіб', 'Kiel, 3 кімнати, 800']) {
    const f = await fixture(STAGING);
    try {
      const first = await say(f, 'Житло — Trittau, 4 особи, 3-4 кімнати');
      assert.match(first.text, /Trittau/u);
      const reply = await say(f, next);
      assert.match(reply.text, /Kiel/u, next);
      assert.doesNotMatch(reply.text, /Trittau/u, next);
      assert.ok(!buttons(reply).some(data => data.includes('Trittau')), `${next}: no Trittau buttons`);
    } finally { f.close(); }
  }
});

test('#070 a bare town name offers the topics for that town; housing continues from there', async () => {
  for (const [typed, town] of [['Kiel', 'Kiel'], ['Elmshorn', 'Elmshorn'], ['bad oldesloe', 'Bad Oldesloe'], ['Любек', 'Lübeck']]) {
    const f = await fixture(STAGING);
    try {
      const reply = await say(f, typed);
      assert.doesNotMatch(reply.text, /Не вдалося однозначно зрозуміти/u, typed);
      assert.match(reply.text, new RegExp(`^📍 ${town} — що потрібно\\?`, 'u'), typed);
      const data = buttons(reply);
      const encoded = encodeURIComponent(town);
      assert.ok(data.includes(`hkr:x:${encoded}`), `${typed}: housing ${data}`);
      assert.ok(data.some(value => /^adv:01\d{3}$/u.test(value)), `${typed}: consultations in the Kreis ${data}`);
      assert.ok(data.includes(`ev:t:${town}`), `${typed}: events ${data}`);
      assert.ok(data.includes('nav:menu'), `${typed}: menu`);
      // The housing button opens the rooms step for this town.
      const before = f.calls.length;
      await handle(f.request('', { user:USER, callback:`hkr:x:${encoded}`, previous:{ message_id:9, text:reply.text } }), f.env, NOW, f.transport);
      const rooms = f.calls.slice(before).filter(call => call.method === 'sendMessage').at(-1)?.body;
      assert.match(rooms.text, new RegExp(`^Тема: житло — ${town}\\.`, 'u'), typed);
    } finally { f.close(); }
  }
});

test('#070 an unknown word is still not taken for a town', async () => {
  const f = await fixture(STAGING);
  try {
    const reply = await say(f, 'Привіт');
    assert.doesNotMatch(reply.text, /Тема: житло —/u);
  } finally { f.close(); }
});

test('#070 a typed request with town, rooms and persons shows the action buttons', async () => {
  const f = await fixture(STAGING);
  try {
    const reply = await say(f, 'Житло — Trittau, 4 особи, 3-4 кімнати');
    const data = buttons(reply);
    assert.ok(data.includes('hka:s:4:3-4:Trittau'), `search button: ${data}`);
    assert.ok(data.includes('hka:j:4:3-4:Trittau'), `Jobcenter button: ${data}`);
  } finally { f.close(); }
});

test('#070 a typed request with town and rooms asks for persons with buttons', async () => {
  const f = await fixture(STAGING);
  try {
    const reply = await say(f, 'Житло — Trittau, 3-4 кімнати');
    const data = buttons(reply);
    assert.ok(data.some(value => value.startsWith('hkp:') && value.endsWith(':3-4:Trittau')), `persons buttons: ${data}`);
  } finally { f.close(); }
});

// Review findings (#070 round 1).
test('#070 a capitalised word after "в" is not a new town; the dialogue continues', async () => {
  const f = await fixture(STAGING);
  try {
    await say(f, 'Житло — Trittau, 4 особи, 3-4 кімнати');
    const reply = await say(f, 'погодження житла в Jobcenter');
    assert.doesNotMatch(reply.text, /житло — Jobcenter/u);
    assert.match(reply.text, /^Jobcenter-погодження житла — Trittau, 3-4 кімнати\./u);
  } finally { f.close(); }
});

test('#070 a typed answer naming the same town keeps rooms and persons', async () => {
  for (const [next, expected] of [['пошук житла в Trittau', /^Пошук житла — Trittau, 3-4 кімнати\. Уточніть/u], ['житло під Jobcenter у Trittau', /Trittau[\s\S]*3-4/u]]) {
    const f = await fixture(STAGING);
    try {
      await say(f, 'Житло — Trittau, 4 особи, 3-4 кімнати');
      const reply = await say(f, next);
      assert.match(reply.text, expected, next);
      assert.doesNotMatch(reply.text, /Вкажіть кількість кімнат|вкажіть кількість осіб/u, `${next}: nothing asked again`);
    } finally { f.close(); }
  }
});

test('#070 the same town with other persons starts over with them', async () => {
  const f = await fixture(STAGING);
  try {
    await say(f, 'Житло — Trittau, 4 особи, 3-4 кімнати');
    const reply = await say(f, 'Житло — Trittau, 2 особи, 2 кімнати');
    assert.match(reply.text, /Trittau, 2 кімнати\.\nОсіб: 2/u);
  } finally { f.close(); }
});

test('#070 a bare other town during an open dialogue answers about that town', async () => {
  const f = await fixture(STAGING);
  try {
    await say(f, 'Житло — Trittau, 4 особи, 3-4 кімнати');
    const reply = await say(f, 'Kiel');
    assert.match(reply.text, /^📍 Kiel — що потрібно\?/u);
    assert.doesNotMatch(reply.text, /Trittau/u);
  } finally { f.close(); }
});

test('#070 "Куди піти" opens events only for a place the events section knows', async () => {
  const f = await fixture(STAGING);
  try {
    const reply = await say(f, 'Stormarn');
    assert.match(reply.text, /^📍 Stormarn — що потрібно\?/u);
    const data = buttons(reply);
    assert.ok(!data.includes('ev:t:Stormarn'), `no events town the events section rejects: ${data}`);
    assert.ok(data.includes('nav:events'));
    assert.ok(data.includes('adv:01062'), 'consultations in Kreis Stormarn');
  } finally { f.close(); }
});

test('#070 the persons step does not repeat the rooms line', async () => {
  const f = await fixture(STAGING);
  try {
    await say(f, 'житло 3 кімнати');
    const reply = await say(f, 'Kiel');
    assert.equal((reply.text.match(/Кімнат: 3/gu) || []).length, 1, reply.text);
  } finally { f.close(); }
});

test('#070 groups get no town buttons promise', async () => {
  const { replyFor } = await import('../src/worker.mjs');
  assert.doesNotMatch(replyFor({ text:'Kiel', chatType:'supergroup' }), /кнопкою нижче/u);
  assert.match(replyFor({ text:'Kiel', chatType:'private' }), /^📍 Kiel — що потрібно\?/u);
});

test('#070 "in der Nähe" is not the town Nahe', async () => {
  const { knownHousingLocation } = await import('../src/housing-language.mjs');
  assert.equal(knownHousingLocation('пошук житла в der Nähe'), null);
  assert.equal(knownHousingLocation('житло in der Nähe'), null);
  const f = await fixture(STAGING);
  try {
    await say(f, 'Житло — Trittau, 4 особи, 3-4 кімнати');
    const reply = await say(f, 'пошук житла в der Nähe');
    assert.match(reply.text, /^Пошук житла — Trittau, 3-4 кімнати\./u);
  } finally { f.close(); }
});
