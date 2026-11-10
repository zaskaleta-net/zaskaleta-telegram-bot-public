import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW, USER, json } from './runtime-fixture.mjs';
import { handleHousingWatchStorage, HOUSING_WATCH_PATH, HOUSING_WATCH_PREFIX, WATCH_DAYS } from '../src/housing-watch.mjs';

// TG-RUNTIME-082/083: monitoring settings persist. A new search kept the
// watch but reset the chosen interval to 15 minutes; a watch ended silently
// after 30 days.

const KEY = `${HOUSING_WATCH_PREFIX}${USER}:${USER}`;
const DAY = 24 * 60 * 60 * 1000;
const TRITTAU = { location:'Trittau', persons:3, rooms:'3-4', radius:20 };
const KIEL = { location:'Kiel', persons:2, rooms:'2', radius:15 };
const ENV = { TELEGRAM_BOT_TOKEN:`123456789:${'A'.repeat(35)}`, TELEGRAM_WEBHOOK_SECRET:'B'.repeat(40), TELEGRAM_RELEASE_APPROVED:'pilot-v1', TELEGRAM_PILOT_MODE:'allowlist', TELEGRAM_ALLOWED_CHAT_IDS:String(USER) };

function memoryStorage(entries = []) {
  const data = new Map(entries);
  return {
    data,
    async get(key) { return structuredClone(data.get(key)); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { return data.delete(key); },
    async list({ prefix = '' } = {}) { return new Map([...data].filter(([key]) => key.startsWith(prefix))); }
  };
}
const call = (storage, body, transport = async () => json({ ok:true, result:{} })) => handleHousingWatchStorage(new Request(`https://outbox.internal${HOUSING_WATCH_PATH}`, { method:'POST', body:JSON.stringify({ now:NOW, ...body }) }), { householdContextStorage:storage, env:ENV }, { transport }).then(response => response.json());
const ids = { chatId:USER, userId:USER };

test('#083 a new search keeps the chosen interval', async () => {
  const storage = memoryStorage();
  await call(storage, { op:'set', ...ids, criteria:TRITTAU });
  await call(storage, { op:'interval', ...ids, interval:'h3' });
  const changed = await call(storage, { op:'set', ...ids, criteria:KIEL });
  assert.equal(changed.interval, 'h3');
  assert.equal(storage.data.get(KEY).interval, 'h3');
  assert.equal(storage.data.get(KEY).criteria.location, 'Kiel');
  assert.equal(storage.data.get(KEY).baseline, false, 'a new search still learns first');
});

test('#083 an expired watch does not pass its interval on', async () => {
  const storage = memoryStorage([[KEY, { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW - 1, lastRunAt:0, updatedAt:1, interval:'daily' }]]);
  assert.equal((await call(storage, { op:'set', ...ids, criteria:KIEL })).interval, 'm15');
});

test('#083 two days before the end one reminder with "Продовжити"; renew adds 30 days', async () => {
  const storage = memoryStorage([[KEY, { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW + DAY, lastRunAt:0, updatedAt:1, interval:'h1' }],
    [`${HOUSING_WATCH_PREFIX}5:5`, { criteria:KIEL, seen:[], baseline:true, expiresAt:NOW + 10 * DAY, lastRunAt:0, updatedAt:1 }]]);
  const sent = [];
  const transport = async (url, options) => { sent.push(JSON.parse(options.body)); return json({ ok:true, result:{} }); };
  assert.equal((await call(storage, { op:'remind' }, transport)).reminded, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, USER);
  assert.match(sent[0].text, /^⏳ Моніторинг житла закінчується \d{2}\.\d{2}\.\d{4}\.\nTrittau/u);
  const buttons = sent[0].reply_markup.inline_keyboard.flat().map(button => button.callback_data);
  assert.deepEqual(buttons, ['jcw:renew', 'jcw:off', 'nav:menu']);
  assert.equal((await call(storage, { op:'remind', now:NOW + 60 * 60 * 1000 }, transport)).reminded, 0, 'only once');
  const renewed = await call(storage, { op:'renew', ...ids });
  assert.equal(renewed.expiresAt, NOW + WATCH_DAYS * DAY);
  const value = storage.data.get(KEY);
  assert.equal(value.interval, 'h1');
  assert.equal(value.remindedAt, undefined, 'the next period gets its own reminder');
  assert.equal((await call(storage, { op:'renew', chatId:6, userId:6 })).status, 'none');
});

test('#083 the renew button and the /watch screen work end to end', async () => {
  const f = await fixture({ HOUSING_WATCH_ENABLED:'true', TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' });
  try {
    await f.env.OUTBOX.get(f.env.OUTBOX.idFromName('telegram-pilot-v1')).fetch(`https://outbox.internal${HOUSING_WATCH_PATH}`, { method:'POST', body:JSON.stringify({ op:'set', ...ids, criteria:TRITTAU, now:NOW }) });
    const status = await f.send('/watch');
    assert.ok(status.last.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'jcw:renew'), 'renew on the /watch screen');
    const renewed = await f.send('', { callback:'jcw:renew' });
    assert.match(renewed.last.text, /^✅ Моніторинг продовжено до \d{2}\.\d{2}\.\d{4}\./u);
  } finally { f.close(); }
});

// Review findings (#083 round 1).
test('#083 a watch changed or deleted while a reminder is sent is not written back', async () => {
  const B = `${HOUSING_WATCH_PREFIX}5:5`;
  const ENV_B = { ...ENV, TELEGRAM_ALLOWED_CHAT_IDS:`${USER},5` };
  const near = { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW + DAY, lastRunAt:0, updatedAt:1, interval:'h1' };
  for (const change of ['delete', 'set', 'interval']) {
    const storage = memoryStorage([[KEY, near], [B, near]]);
    const sent = [];
    const transport = async (url, options) => {
      const body = JSON.parse(options.body);
      sent.push(body.chat_id);
      if (body.chat_id === USER) {
        if (change === 'delete') await storage.delete(B);
        if (change === 'set') await storage.put(B, { ...near, criteria:KIEL, expiresAt:NOW + 30 * DAY, updatedAt:2 });
        // The real interval op keeps updatedAt: the watch is still reminded.
        if (change === 'interval') await storage.put(B, { ...(await storage.get(B)), interval:'daily' });
      }
      return json({ ok:true, result:{} });
    };
    const result = await handleHousingWatchStorage(new Request(`https://outbox.internal${HOUSING_WATCH_PATH}`, { method:'POST', body:JSON.stringify({ op:'remind', now:NOW }) }), { householdContextStorage:storage, env:ENV_B }, { transport }).then(response => response.json());
    assert.deepEqual(sent, change === 'interval' ? [USER, 5] : [USER], change);
    assert.equal(result.reminded, change === 'interval' ? 2 : 1, change);
    if (change === 'delete') assert.equal(storage.data.has(B), false, 'a deleted watch stays deleted');
    if (change === 'set') assert.equal(storage.data.get(B).criteria.location, 'Kiel');
    if (change === 'interval') assert.equal(storage.data.get(B).interval, 'daily');
  }
});

test('#083 no reminder for a chat without access; at most 10 per run; silent at night', async () => {
  const near = { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW + DAY, lastRunAt:0, updatedAt:1 };
  const stranger = memoryStorage([[`${HOUSING_WATCH_PREFIX}6:6`, near]]);
  assert.equal((await call(stranger, { op:'remind' })).reminded, 0);
  const many = Array.from({ length:12 }, (_, i) => [`${HOUSING_WATCH_PREFIX}${100 + i}:${100 + i}`, near]);
  const env = { ...ENV, TELEGRAM_ALLOWED_CHAT_IDS:many.map(([key]) => key.split(':').at(-1)).join(',') };
  const storage = memoryStorage(many);
  const bodies = [];
  const night = Date.UTC(2026, 9, 18, 1, 0);
  const remind = now => handleHousingWatchStorage(new Request(`https://outbox.internal${HOUSING_WATCH_PATH}`, { method:'POST', body:JSON.stringify({ op:'remind', now }) }), { householdContextStorage:storage, env }, { transport:async (url, options) => { bodies.push(JSON.parse(options.body)); return json({ ok:true, result:{} }); } }).then(response => response.json());
  for (const [key, value] of many) storage.data.set(key, { ...value, expiresAt:night + DAY });
  assert.equal((await remind(night)).reminded, 10);
  assert.ok(bodies.every(body => body.disable_notification === true), 'silent at night');
  assert.equal((await remind(night + 15 * 60 * 1000)).reminded, 2, 'the rest in the next run');
});
