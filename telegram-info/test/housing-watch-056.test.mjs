import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW, USER, json } from './runtime-fixture.mjs';
import { housingWatchButtonTransport, handleHousingWatchStorage, handleHousingWatchRun, scheduledHousingWatch, watchMessage, WATCH_BUTTON_TEXT, HOUSING_WATCH_PATH, HOUSING_WATCH_RUN_PATH, HOUSING_WATCH_PREFIX } from '../src/housing-watch.mjs';
import { forgetKeys } from '../src/forget-command.mjs';
import { RETENTION_RULES, retentionExpired } from '../src/retention-sweep.mjs';
import { privacyPolicyHtml } from '../src/privacy-policy.mjs';
import { BRANDED_BOT_COMMANDS } from '../src/bot-command-sync.mjs';

// TG-RUNTIME-056: a saved housing search re-run hourly, new listings only,
// no AI (owner request 18.10.2026: "постійний пошук житла").

const ON = { HOUSING_WATCH_ENABLED:'true' };
const KEY = `${HOUSING_WATCH_PREFIX}${USER}:${USER}`;
const TRITTAU = { location:'Trittau', persons:3, rooms:'3-4', radius:20 };
const GROUP = 'trittau|3|3-4|20';
const MINUTE = 60 * 1000;

function controls(selected = 20, district = false) {
  const button = radius => ({ text:`${radius === selected && !district ? '✅ ' : ''}${radius} км`, callback_data:`jcr:${radius}:3:3-4:Trittau` });
  return { inline_keyboard:[[button(15), button(20), button(25)], [{ text:`${district ? '✅ ' : ''}🗺 Шукати весь район`, callback_data:'jcd:3:3-4:Trittau' }]] };
}

async function outgoing(env, chatId, markup) {
  let body;
  const transport = housingWatchButtonTransport(async (url, options) => { body = JSON.parse(options.body); return json({ ok:true }); }, env);
  await transport('https://api.telegram.org/bot1:x/sendMessage', { method:'POST', body:JSON.stringify({ chat_id:chatId, text:'controls', reply_markup:markup }) });
  return body.reply_markup;
}

function memoryStorage(entries = []) {
  const data = new Map(entries);
  return {
    data,
    async get(key) { return structuredClone(data.get(key)); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { return data.delete(key); },
    async list({ prefix = '', limit = Infinity } = {}) { return new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit)); }
  };
}

function call(storage, body, { transport, env = { TELEGRAM_BOT_TOKEN:`123456789:${'A'.repeat(35)}`, TELEGRAM_WEBHOOK_SECRET:'B'.repeat(40), TELEGRAM_RELEASE_APPROVED:'pilot-v1', TELEGRAM_PILOT_MODE:'allowlist', TELEGRAM_ALLOWED_CHAT_IDS:`${USER},888888888` } } = {}) {
  return handleHousingWatchStorage(new Request(`https://outbox.internal${HOUSING_WATCH_PATH}`, { method:'POST', body:JSON.stringify({ now:NOW, ...body }) }), { householdContextStorage:storage, env }, { transport }).then(response => response.json());
}

const listing = id => ({ key:`u:https://www.kleinanzeigen.de/s-anzeige/x/${id}`, url:`https://www.kleinanzeigen.de/s-anzeige/x/${id}`, title:`Wohnung ${id}`, price:650, rooms:'3', areaSqm:70, location:'Trittau' });

test('#056 the controls of a radius search get the watch button; never twice, not in groups, not when off (TG-RUNTIME-057: a whole-Kreis search gets it too)', async () => {
  const markup = await outgoing(ON, USER, controls(20));
  assert.deepEqual(markup.inline_keyboard.at(-1), [{ text:WATCH_BUTTON_TEXT, callback_data:'jcw:20:3:3-4:Trittau' }]);
  assert.equal((await outgoing(ON, USER, markup)).inline_keyboard.length, markup.inline_keyboard.length, 'no second row');
  assert.deepEqual((await outgoing(ON, USER, controls(20, true))).inline_keyboard.at(-1), [{ text:WATCH_BUTTON_TEXT, callback_data:'jcw:d:3:3-4:Trittau' }]);
  for (const [env, chat, controlsMarkup] of [[ON, -100123, controls(20)], [{}, USER, controls(20)], [ON, USER, controls(null)]]) {
    const result = await outgoing(env, chat, controlsMarkup);
    assert.equal(result.inline_keyboard.flat().some(button => button.text === WATCH_BUTTON_TEXT), false, JSON.stringify(env));
  }
});

test('#056 the button saves the search; /watch shows it with an off button; off deletes it; /forget covers it', async () => {
  const f = await fixture(ON);
  try {
    const on = await f.send('', { callback:'jcw:20:3:3-4:Trittau' });
    assert.match(on.last.text, /^🔔 Моніторинг увімкнено\./u);
    assert.match(on.last.text, /Trittau, 20 км/u);
    assert.deepEqual(f.data.get(KEY).criteria, TRITTAU);
    assert.equal(f.data.get(KEY).expiresAt, NOW + 30 * 24 * 60 * MINUTE);
    assert.equal(f.calls.some(call => call.method === 'answerCallbackQuery'), true);
    const status = await f.send('/watch');
    assert.match(status.last.text, /Діє до/u);
    assert.equal(status.last.reply_markup.inline_keyboard.at(-2)[0].callback_data, 'jcw:off', 'TG-RUNTIME-058: the interval rows come first');
    assert.equal(status.last.reply_markup.inline_keyboard.at(-1)[0].callback_data, 'nav:menu', 'TG-RUNTIME-071: the menu row is last');
    const off = await f.send('', { callback:'jcw:off' });
    assert.match(off.last.text, /Моніторинг вимкнено/u);
    assert.equal(f.data.has(KEY), false);
    assert.match((await f.send('/watch')).last.text, /не увімкнено/u);
    assert.ok(forgetKeys(USER, USER).includes(KEY));
  } finally { f.close(); }
});

test('#056 a place without a verified Jobcenter limit is not saved; with the feature off nothing is saved', async () => {
  const f = await fixture(ON);
  try {
    const result = await f.send('', { callback:'jcw:20:3:3-4:Berlin' });
    assert.match(result.last.text, /Не вдалося зберегти/u);
    assert.equal(f.data.has(KEY), false);
  } finally { f.close(); }
  const off = await fixture();
  try {
    const result = await off.send('', { callback:'jcw:20:3:3-4:Trittau' });
    assert.match(result.last.text, /вимкнений/u);
    assert.equal(off.data.has(KEY), false);
  } finally { off.close(); }
});

test('#056/#060 the first runs only record what is there; later runs send only new listings, once', async () => {
  const storage = memoryStorage();
  const messages = [];
  const transport = async (url, options) => { messages.push(JSON.parse(options.body)); return json({ ok:true, result:{} }); };
  assert.equal((await call(storage, { op:'set', chatId:USER, userId:USER, criteria:TRITTAU })).status, 'ok');
  const first = await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, listings:[listing(1), listing(2)] }, { transport });
  assert.deepEqual([first.sent, first.baselined], [0, 1]);
  assert.equal(messages.length, 0, 'the user has just seen these');
  // Within the interval the watch is not due.
  assert.deepEqual((await call(storage, { op:'plan', now:NOW + 5 * MINUTE })).groups, []);
  assert.deepEqual((await call(storage, { op:'plan', now:NOW + 15 * MINUTE })).groups, [{ group:GROUP, criteria:TRITTAU }]);
  // TG-RUNTIME-060: a listing the search returned only on the second run
  // was there all along; the warm-up runs record it silently.
  const second = await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, listings:[listing(1), listing(2), listing(3)], now:NOW + 15 * MINUTE }, { transport });
  const third = await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, listings:[listing(2)], now:NOW + 30 * MINUTE }, { transport });
  assert.deepEqual([second.baselined, third.baselined, messages.length], [1, 1, 0]);
  const fourth = await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, listings:[listing(1), listing(3), listing(4)], now:NOW + 45 * MINUTE }, { transport });
  assert.equal(fourth.sent, 1);
  assert.equal(messages[0].chat_id, USER);
  assert.match(messages[0].text, /Wohnung 4/u);
  assert.doesNotMatch(messages[0].text, /Wohnung 1|Wohnung 2|Wohnung 3/u);
  const fifth = await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, listings:[listing(4)], now:NOW + 60 * MINUTE }, { transport });
  assert.equal(fifth.sent, 0, 'listing 4 is not sent twice');
});

test('#060 a slow interval learns for one run once two hours have passed', async () => {
  const storage = memoryStorage();
  const messages = [];
  const transport = async (url, options) => { messages.push(JSON.parse(options.body)); return json({ ok:true, result:{} }); };
  await call(storage, { op:'set', chatId:USER, userId:USER, criteria:TRITTAU });
  const key = `${HOUSING_WATCH_PREFIX}${USER}:${USER}`;
  storage.data.set(key, { ...storage.data.get(key), interval:'daily' });
  await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, listings:[listing(1)], now:NOW + 24 * 60 * MINUTE }, { transport });
  assert.equal(storage.data.get(key).baseline, true);
  assert.equal(messages.length, 0);
});

test('#056 identical searches of two users are one search; a user who blocked the bot loses the watch', async () => {
  const other = 888888888;
  const storage = memoryStorage([
    [KEY, { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW + 1000 * MINUTE, lastRunAt:0 }],
    [`${HOUSING_WATCH_PREFIX}${other}:${other}`, { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW + 1000 * MINUTE, lastRunAt:0 }],
    [`${HOUSING_WATCH_PREFIX}5:5`, { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW - 1, lastRunAt:0 }]
  ]);
  assert.equal((await call(storage, { op:'plan' })).groups.length, 1);
  const transport = async (url, options) => JSON.parse(options.body).chat_id === other ? json({ ok:false }, 403) : json({ ok:true, result:{} });
  const result = await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, listings:[listing(9)] }, { transport });
  assert.deepEqual([result.sent, result.removed], [1, 1]);
  assert.equal(storage.data.has(`${HOUSING_WATCH_PREFIX}${other}:${other}`), false);
  assert.equal(storage.data.get(`${HOUSING_WATCH_PREFIX}5:5`).lastRunAt, 0, 'an expired watch is not run');
});

test('#056 a failed search sends nothing and waits an hour instead of blocking the others', async () => {
  const f = await fixture({ ...ON, TELEGRAM_MAINTENANCE_MODE:'false' });
  try {
    f.data.set(KEY, { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW + 1000 * MINUTE, lastRunAt:0 });
    const run = await handleHousingWatchRun(new Request(`https://outbox.internal${HOUSING_WATCH_RUN_PATH}`, { method:'POST', body:JSON.stringify({ criteria:TRITTAU }) }), f.object, { transport:async () => new Response('down', { status:503 }) });
    assert.notEqual((await run.json()).listings?.length, 1);
    const result = await scheduledHousingWatch({ ...f.env, OUTBOX:{ idFromName:name => name, get:() => ({ fetch:async (url, options) => {
      const path = new URL(url).pathname;
      if (path === HOUSING_WATCH_RUN_PATH) return json({ ok:true, status:'unavailable', listings:[] });
      return f.object.fetch(new Request(url, options));
    } }) } }, NOW);
    assert.deepEqual([result.groups, result.sent, result.failed], [1, 0, 1]);
    assert.equal(f.data.get(KEY).lastRunAt, NOW);
    assert.equal(f.data.get(KEY).failures, 1);
    assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 0);
    assert.deepEqual(await scheduledHousingWatch({ ...f.env, TELEGRAM_MAINTENANCE_MODE:'true' }, NOW + 60 * MINUTE), { status:'maintenance' });
  } finally { f.close(); }
});

test('#056 review: a watch deleted while a message is being sent is not written back', async () => {
  const other = 888888888;
  const storage = memoryStorage([
    [KEY, { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW + 1000 * MINUTE, lastRunAt:0, updatedAt:1 }],
    [`${HOUSING_WATCH_PREFIX}${other}:${other}`, { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW + 1000 * MINUTE, lastRunAt:0, updatedAt:1 }]
  ]);
  // /forget of the second user lands while the first message is in flight.
  const transport = async () => { storage.data.delete(`${HOUSING_WATCH_PREFIX}${other}:${other}`); storage.data.delete(KEY); return json({ ok:true, result:{} }); };
  await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, listings:[listing(4)] }, { transport });
  assert.deepEqual([...storage.data.keys()], []);
});

test('#056 review: an undelivered message is retried; a gone chat (400) removes the watch; non-allowlisted chats get nothing', async () => {
  const gone = 888888888;
  const storage = memoryStorage([
    [KEY, { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW + 1000 * MINUTE, lastRunAt:0, updatedAt:1 }],
    [`${HOUSING_WATCH_PREFIX}${gone}:${gone}`, { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW + 1000 * MINUTE, lastRunAt:0, updatedAt:1 }],
    [`${HOUSING_WATCH_PREFIX}5:5`, { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW + 1000 * MINUTE, lastRunAt:0, updatedAt:1 }]
  ]);
  const chats = [];
  const transport = async (url, options) => { const chat = JSON.parse(options.body).chat_id; chats.push(chat); return chat === gone ? json({ ok:false, description:'Bad Request: chat not found' }, 400) : json({ ok:false }, 502); };
  const result = await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, listings:[listing(5)] }, { transport });
  assert.deepEqual([result.sent, result.removed], [0, 2]);
  assert.equal(chats.includes(5), false, 'chat 5 is not on the allowlist');
  assert.equal(storage.data.has(`${HOUSING_WATCH_PREFIX}5:5`), false, 'a chat without access loses the watch');
  assert.equal(storage.data.get(KEY).lastRunAt, NOW, 'waits an hour');
  assert.deepEqual(storage.data.get(KEY).seen, [], 'listing 5 is offered again');
});

test('#056 review: the search of a watch keeps to the provider subrequest budget', async () => {
  // A small budget makes the limiter visible: an unbounded search makes ~20 calls.
  const f = await fixture({ ...ON, TELEGRAM_PROVIDER_SUBREQUEST_BUDGET:'5' });
  try {
    let calls = 0;
    const transport = async url => { if (!String(url).startsWith('https://api.telegram.org/')) calls += 1; return new Response('<html></html>', { status:200, headers:{ 'content-type':'text/html' } }); };
    const run = await handleHousingWatchRun(new Request(`https://outbox.internal${HOUSING_WATCH_RUN_PATH}`, { method:'POST', body:JSON.stringify({ criteria:TRITTAU }) }), f.object, { transport });
    assert.equal(run.status, 200);
    assert.ok(calls > 0 && calls <= 5, String(calls));
  } finally { f.close(); }
});

test('#056 the real radius search shows the watch button under its controls', async () => {
  const f = await fixture(ON);
  try {
    await f.send('/start');
    const city = await f.send('Любек дві жінки');
    const rooms = await f.send('', { callback:'hkr:3:L%C3%BCbeck', previous:city.last });
    const guideline = await f.send('', { callback:'hka:j:2:3:L%C3%BCbeck', previous:rooms.last });
    const search = await f.send('', { callback:'jcr:15:2:3:L%C3%BCbeck', previous:guideline.last });
    const callbacks = search.messages.flatMap(message => (message.reply_markup?.inline_keyboard || []).flat().map(button => button.callback_data));
    assert.ok(callbacks.includes('jcw:15:2:3:L%C3%BCbeck'), callbacks.join(','));
  } finally { f.close(); }
});

test('#056 the message links each new listing and says it is no Zusicherung; retention, command and privacy policy', () => {
  const text = watchMessage(TRITTAU, [listing(1), { ...listing(2), title:'<b>x</b>' }]);
  assert.match(text, /<a href="https:\/\/www\.kleinanzeigen\.de\/s-anzeige\/x\/1">Wohnung 1<\/a>/u);
  assert.match(text, /&lt;b&gt;x&lt;\/b&gt;/u);
  assert.match(text, /не Zusicherung/u);
  const rule = RETENTION_RULES.find(item => item.prefix === HOUSING_WATCH_PREFIX);
  assert.ok(rule);
  assert.equal(retentionExpired(rule, { expiresAt:NOW - 1 }, NOW), true);
  assert.equal(retentionExpired(rule, { expiresAt:NOW + 1 }, NOW), false);
  assert.ok(BRANDED_BOT_COMMANDS.some(item => item.command === 'watch'));
  const html = privacyPolicyHtml({ name:'A B', address:'Str. 1, 00000 Musterstadt', email:'a@example.org' });
  assert.match(html, /Wohnungs-Benachrichtigung/u);
  assert.match(html, /eine KI wird dafür nicht verwendet/u);
  assert.match(html, /Сповіщення про житло/u);
});

test('#056 review 2: a message Telegram rejects (400, not a gone chat) keeps the watch and is retried', async () => {
  const storage = memoryStorage([[KEY, { criteria:TRITTAU, seen:[], baseline:true, expiresAt:NOW + 1000 * MINUTE, lastRunAt:0, updatedAt:1 }]]);
  const transport = async () => json({ ok:false, description:"Bad Request: can't parse entities" }, 400);
  const result = await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, listings:[listing(6)] }, { transport });
  assert.equal(result.removed, 0);
  assert.equal(storage.data.get(KEY).lastRunAt, NOW);
  assert.deepEqual(storage.data.get(KEY).seen, []);
});

test('#060 review: the listings the user was just shown are never sent; nor is the same flat from another portal', async () => {
  const storage = memoryStorage([[`telegram-jobcenter-search-state:v1:${USER}:${USER}`, { signature:'s', seen:[listing(7).key, 'x:abc@kleinanzeigen'], districtBaseline:[], updatedAt:NOW - 10 * MINUTE }]]);
  const messages = [];
  const transport = async (url, options) => { messages.push(JSON.parse(options.body)); return json({ ok:true, result:{} }); };
  await call(storage, { op:'set', chatId:USER, userId:USER, criteria:TRITTAU });
  const key = `${HOUSING_WATCH_PREFIX}${USER}:${USER}`;
  // Past the warm-up, so only the seeding and the portal check are tested.
  storage.data.set(key, { ...storage.data.get(key), baseline:true });
  const other = { ...listing(8), key:'u:https://www.wg-gesucht.de/8.html', url:'https://www.wg-gesucht.de/8.html', cross:'x:abc@wg-gesucht' };
  const result = await call(storage, { op:'deliver', group:GROUP, criteria:TRITTAU, listings:[listing(7), other, listing(9)], now:NOW + 15 * MINUTE }, { transport });
  assert.equal(result.sent, 1);
  assert.match(messages[0].text, /Wohnung 9/u);
  assert.doesNotMatch(messages[0].text, /Wohnung 7|Wohnung 8/u);
  // A stale search state (older than an hour) seeds nothing.
  const old = memoryStorage([[`telegram-jobcenter-search-state:v1:${USER}:${USER}`, { signature:'s', seen:[listing(7).key], updatedAt:NOW - 2 * 60 * MINUTE }]]);
  await call(old, { op:'set', chatId:USER, userId:USER, criteria:TRITTAU });
  assert.deepEqual(old.data.get(key).seen, []);
});
