import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW, USER, json } from './runtime-fixture.mjs';
import { handleHousingWatchStorage, watchDue, berlinHour, HOUSING_WATCH_PATH, HOUSING_WATCH_PREFIX } from '../src/housing-watch.mjs';
import { privacyPolicyHtml } from '../src/privacy-policy.mjs';
import { scheduled, HOUSING_WATCH_CRON } from '../src/runtime.mjs';
import { readFileSync } from 'node:fs';

// TG-RUNTIME-058: the user chooses how often new listings are sent (owner
// request 18.10.2026); no sound at night.

const KEY = `${HOUSING_WATCH_PREFIX}${USER}:${USER}`;
const TRITTAU = { location:'Trittau', persons:3, rooms:'3-4', radius:20 };
const GROUP = 'trittau|3|3-4|20';
const HOUR = 60 * 60 * 1000;
// 18.10.2026 is summer time in Berlin (UTC+2).
const berlin = hour => Date.UTC(2026, 9, 18, hour - 2, 5);
const watch = (interval, lastRunAt) => ({ criteria:TRITTAU, seen:[], baseline:true, expiresAt:berlin(23) + 1000 * HOUR, lastRunAt, updatedAt:1, interval });

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

const ENV = { TELEGRAM_BOT_TOKEN:`123456789:${'A'.repeat(35)}`, TELEGRAM_WEBHOOK_SECRET:'B'.repeat(40), TELEGRAM_RELEASE_APPROVED:'pilot-v1', TELEGRAM_PILOT_MODE:'allowlist', TELEGRAM_ALLOWED_CHAT_IDS:String(USER) };
const call = (storage, body, transport) => handleHousingWatchStorage(new Request(`https://outbox.internal${HOUSING_WATCH_PATH}`, { method:'POST', body:JSON.stringify(body) }), { householdContextStorage:storage, env:ENV }, { transport }).then(response => response.json());
const listing = id => ({ key:`u:https://www.kleinanzeigen.de/s-anzeige/x/${id}`, url:`https://www.kleinanzeigen.de/s-anzeige/x/${id}`, title:`Wohnung ${id}`, price:650 });

test('#058 each interval is due at its own times (Berlin time)', () => {
  assert.equal(berlinHour(berlin(8)), 8);
  assert.equal(watchDue(watch('h1', berlin(7)), berlin(8)), true);
  assert.equal(watchDue(watch('h1', berlin(8) - 30 * 60 * 1000), berlin(8)), false);
  assert.equal(watchDue(watch('h3', berlin(6)), berlin(8)), false);
  assert.equal(watchDue(watch('h3', berlin(5)), berlin(8)), true);
  assert.equal(watchDue(watch('daily', berlin(8) - 24 * HOUR), berlin(7)), false, 'before the 8:00 slot');
  assert.equal(watchDue(watch('daily', berlin(8) - 24 * HOUR), berlin(8)), true);
  assert.equal(watchDue(watch('daily', berlin(8)), berlin(9)), false, 'once per slot');
  assert.equal(watchDue(watch('daily', berlin(8) - 24 * HOUR), berlin(10)), true, 'a missed 8:00 run is made up until 11:00');
  assert.equal(watchDue(watch('daily', berlin(8) - 24 * HOUR), berlin(11)), false);
  const minute = 60 * 1000;
  assert.equal(watchDue(watch('m15', berlin(8) - 15 * minute), berlin(8)), true, 'every 15 minutes (owner request)');
  assert.equal(watchDue(watch('m15', berlin(8) - 5 * minute), berlin(8)), false);
  assert.equal(watchDue(watch('m30', berlin(8) - 15 * minute), berlin(8)), false);
  assert.equal(watchDue(watch('m30', berlin(8) - 30 * minute), berlin(8)), true);
  assert.equal(watchDue({ ...watch(undefined, berlin(8) - 15 * minute) }, berlin(8)), true, 'a watch without interval runs every 15 minutes');
});

test('#058 at night a message arrives without sound; in the day with sound', async () => {
  for (const [hour, silent] of [[23, true], [3, true], [12, false]]) {
    const storage = memoryStorage([[KEY, watch('h1', 0)]]);
    const bodies = [];
    await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, listings:[listing(hour)], now:berlin(hour) }, async (url, options) => { bodies.push(JSON.parse(options.body)); return json({ ok:true, result:{} }); });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].disable_notification === true, silent, String(hour));
  }
});

test('#058 a failed run of a daily watch is tried again within its slot', async () => {
  const storage = memoryStorage([[KEY, watch('daily', berlin(8) - 24 * HOUR)]]);
  await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, failed:true, now:berlin(8) });
  assert.equal(watchDue(storage.data.get(KEY), berlin(9)), true);
  assert.equal(watchDue(storage.data.get(KEY), berlin(12)), false);
});

test('#058 the user picks the interval after switching on and changes it in /watch', async () => {
  const f = await fixture({ HOUSING_WATCH_ENABLED:'true' });
  try {
    const on = await f.send('', { callback:'jcw:20:3:3-4:Trittau' });
    assert.match(on.last.text, /Як часто надсилати/u);
    const data = on.last.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
    assert.deepEqual(data, ['jcw:i:m15', 'jcw:i:m30', 'jcw:i:h1', 'jcw:i:h3', 'jcw:i:daily', 'nav:menu'], 'TG-RUNTIME-071: the menu row is last');
    assert.match(on.last.reply_markup.inline_keyboard[0][0].text, /^✅ ⚡ Кожні 15 хв/u, 'every 15 minutes is the default');
    const picked = await f.send('', { callback:'jcw:i:daily' });
    assert.match(picked.last.text, /раз на день \(8:00\)/u);
    assert.equal(f.data.get(`${HOUSING_WATCH_PREFIX}${USER}:${USER}`).interval, 'daily');
    const status = await f.send('/watch');
    assert.match(status.last.text, /Нові оголошення — раз на день/u);
    assert.ok(status.last.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'jcw:i:daily' && button.text.startsWith('✅ ')));
    // The same search again keeps the chosen interval.
    await f.send('', { callback:'jcw:20:3:3-4:Trittau' });
    assert.equal(f.data.get(`${HOUSING_WATCH_PREFIX}${USER}:${USER}`).interval, 'daily');
    await f.send('', { callback:'jcw:off' });
    assert.match((await f.send('', { callback:'jcw:i:h3' })).last.text, /не увімкнено/u);
  } finally { f.close(); }
});

test('#058 the privacy policy describes the chosen interval', () => {
  const html = privacyPolicyHtml({ name:'A B', address:'Str. 1, 00000 Musterstadt', email:'a@example.org' });
  assert.match(html, /alle 15 Minuten bis einmal täglich/u);
  assert.match(html, /від кожних 15 хвилин до раз на день/u);
});

test('#058 the 15-minute cron runs only the housing watch; at minute 0 the hourly work runs too; the daily cron never runs the watch', async () => {
  const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.equal((wrangler.match(/"crons": \["\*\/15 \* \* \* \*", "30 8 \* \* \*"\]/gu) || []).length, 2);
  for (const [cron, time, watch, hourly] of [
    [HOUSING_WATCH_CRON, Date.UTC(2026, 9, 18, 10, 15), true, false],
    [HOUSING_WATCH_CRON, Date.UTC(2026, 9, 18, 10, 0), true, true],
    ['30 8 * * *', Date.UTC(2026, 9, 18, 6, 30), false, true],
    // TG-RUNTIME-059: while the deployed schedule is still the hourly one.
    ['0 * * * *', Date.UTC(2026, 9, 18, 10, 0), true, true]
  ]) {
    const f = await fixture({ HOUSING_WATCH_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' });
    try {
      const pending = [];
      await scheduled({ cron, scheduledTime:time }, f.env, { waitUntil:promise => pending.push(promise) });
      await Promise.allSettled(pending);
      assert.equal(f.internal.includes(HOUSING_WATCH_PATH), watch, `${cron} watch`);
      assert.equal(f.internal.includes('/retention-sweep'), hourly, `${cron} hourly work`);
    } finally { f.close(); }
  }
});

test('#058 review: the run object hands its result to the shared object itself; the cron worker gets only a status', async () => {
  const f = await fixture({ HOUSING_WATCH_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' });
  try {
    f.data.set(KEY, { criteria:TRITTAU, seen:[], baseline:false, expiresAt:NOW + 1000 * HOUR, lastRunAt:0, updatedAt:1, interval:'m15' });
    const transport = async () => new Response('<html></html>', { status:200, headers:{ 'content-type':'text/html' } });
    const { handleHousingWatchRun, HOUSING_WATCH_RUN_PATH } = await import('../src/housing-watch.mjs');
    const response = await handleHousingWatchRun(new Request(`https://outbox.internal${HOUSING_WATCH_RUN_PATH}`, { method:'POST', body:JSON.stringify({ criteria:TRITTAU, group:GROUP, now:NOW }) }), f.object, { transport });
    const body = await response.json();
    assert.equal(body.delivered, true);
    assert.equal(Object.hasOwn(body, 'listings'), false, 'no listing data back to the cron worker');
    assert.equal(f.data.get(KEY).lastRunAt > 0, true);
  } finally { f.close(); }
});
