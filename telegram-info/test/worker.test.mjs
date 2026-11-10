import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, { handle, replyFor, createOutboxRuntime, sendStatelessPilotReply } from '../src/worker.mjs';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const NOW = 1700000000000;
const enabled = () => ({ TELEGRAM_RELEASE_APPROVED: 'pilot-v1', TELEGRAM_PILOT_MODE: 'allowlist', TELEGRAM_ALLOWED_CHAT_IDS: '321', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_INGRESS_ENABLED: 'true', TELEGRAM_DELIVERY_ENABLED: 'true' });
const update = (id = 1, text = '/start') => ({ update_id: id, message: { message_id: id + 1, date: NOW / 1000, chat: { id: 321, type: 'private' }, from: { id: 321, is_bot: false }, text } });
const request = (value, secret = SECRET) => new Request('https://pilot.example/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(value) });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function harness() {
  let time = NOW, alarm = null, sends = 0, failAlarm = false;
  const rows = new Map();
  const ctx = { storage: { getAlarm: async () => alarm, setAlarm: async at => { if (failAlarm) throw Error('storage failure'); alarm = at; } } };
  const outbox = {
    enqueue(message, reply) {
      if (rows.has(message.id)) return { accepted: false, reason: 'duplicate' };
      rows.set(message.id, { ...message, reply, state: 'queued', due: time });
      return { accepted: true };
    },
    reconcile() {}, purge() {},
    claim() {
      const row = [...rows.values()].find(r => r.state === 'queued' && r.due <= time);
      if (!row) return null;
      row.state = 'sending'; row.token = String(row.id);
      return { id: row.id, chatId: row.chatId, text: row.reply, token: row.token };
    },
    complete(id, token, result) {
      const row = rows.get(id);
      if (row?.state !== 'sending' || row.token !== token) return false;
      row.state = result.status; row.reply = null;
      if (result.status === 'rate_limited') { row.state = 'queued'; row.reply = 'retry'; row.due = time + result.retryAfter * 1000; }
      return true;
    },
    nextDue() { const due = [...rows.values()].filter(r => r.state === 'queued').map(r => r.due); return due.length ? Math.min(...due) : null; },
    eraseChat(chatId) { for (const r of rows.values()) if (r.chatId === chatId && r.state === 'queued') r.state = 'rejected'; return true; }
  };
  const transport = async (_url, options) => { sends++; return response({ ok: true, result: { message_id: 50 + sends, chat: { id: JSON.parse(options.body).chat_id } } }); };
  const runtime = createOutboxRuntime(ctx, enabled(), outbox, transport, () => time);
  const namespace = { idFromName(name) { assert.equal(name, 'telegram-pilot-v1'); return name; }, get() { return { fetch: async (_url, options) => {
    const p = JSON.parse(options.body);
    const r = await runtime.enqueue(p.message, p.reply);
    return response(r.accepted ? { accepted: true } : { accepted: false, reason: 'duplicate' });
  } }; } };
  return { runtime, rows, ctx, namespace, outbox, transport, get sends() { return sends; }, get alarm() { return alarm; }, set time(value) { time = value; }, set failAlarm(value) { failAlarm = value; } };
}

test('commands are deterministic and do not invent answers', () => {
  assert.match(replyFor({ text: '/start' }), /Schleswig-Holstein Помічник/);
  assert.match(replyFor({ text: '/help@ZaskaletaInfoBot' }), /Команди/);
  assert.match(replyFor({ text: 'Який мій Bescheid?' }), /Тема: Jobcenter/);
  assert.match(replyFor({ text: 'Квартира' }), /Тема: житло/);
  assert.match(replyFor({ text: 'Ищу квартиру в Trittau' }), /Тема: житло — Trittau/);
});

test('default Worker export exposes health without revealing secrets', async () => {
  const r = await worker.fetch(new Request('https://pilot.example/health'), {});
  assert.equal(r.status, 200);
  assert.doesNotMatch(await r.text(), /123456789|BBBBBBBB/);
});

test('health exposes the reviewed candidate marker only on an explicit probe request', async () => {
  const normal = await worker.fetch(new Request('https://pilot.example/health'), {});
  assert.equal(normal.status, 200);
  assert.equal(normal.headers.get('x-zaskaleta-release'), 'stormarn-hardening-v2');
  assert.deepEqual(await normal.json(), { ok: true, service: 'zaskaleta-info-telegram', delivery: false, versionId: null });

  const probe = await worker.fetch(new Request('https://pilot.example/health?probe=release'), {});
  assert.equal(probe.status, 200);
  assert.deepEqual(await probe.json(), { ok: true, service: 'zaskaleta-info-telegram', delivery: false, versionId: null, release: 'stormarn-hardening-v2' });
});

test('health returns the bound Cloudflare version id', async () => {
  const versionId = '11111111-1111-4111-8111-111111111111';
  const response = await worker.fetch(new Request('https://pilot.example/health'), { CF_VERSION_METADATA: { id: versionId } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).versionId, versionId);
});

test('webhook fails closed before storage and rejects unauthorized or oversized bodies', async () => {
  let called = 0;
  const env = { ...enabled(), OUTBOX: { idFromName() { called++; throw Error('unexpected'); } } };
  assert.equal((await handle(request(update()), { ...env, TELEGRAM_INGRESS_ENABLED: 'false' }, NOW)).status, 503);
  assert.equal((await handle(request(update(), 'wrong'), env, NOW)).status, 401);
  assert.equal((await handle(new Request('https://pilot.example/telegram/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': SECRET }, body: 'x'.repeat(65537) }), env, NOW)).status, 413);
  assert.equal(called, 0);
});

test('webhook filters foreign chats and old updates, and does not persist incoming text', async () => {
  const h = harness(), seen = [];
  const env = { ...enabled(), OUTBOX: { idFromName: h.namespace.idFromName, get() { return { fetch: async (_url, opts) => { seen.push(JSON.parse(opts.body)); return response({ accepted: true }); } }; } } };
  const wrong = update(); wrong.message.chat.id = 322; wrong.message.from.id = 322;
  const group = update(); group.message.chat.type = 'group';
  const old = update(); old.message.date -= 400;
  for (const p of [wrong, group, old]) assert.equal((await handle(request(p), env, NOW)).status, 200);
  assert.equal(seen.length, 0);
  assert.equal((await handle(request(update(7, 'Приватний текст')), env, NOW)).status, 200);
  assert.deepEqual(Object.keys(seen[0].message).sort(), ['chatId', 'id', 'messageId']);
  assert.doesNotMatch(JSON.stringify(seen[0]), /Приватний текст/);
});

test('synthetic webhook to outbox to transport delivers once and deduplicates', async () => {
  const h = harness(), env = { ...enabled(), OUTBOX: h.namespace };
  assert.equal((await handle(request(update()), env, NOW)).status, 200);
  assert.equal((await handle(request(update()), env, NOW)).status, 200);
  assert.equal(h.rows.size, 1);
  await h.runtime.drain(); await h.runtime.drain();
  assert.equal(h.sends, 1);
  assert.equal(h.rows.get(1).state, 'sent');
});

test('concurrent drains share one in-flight network attempt', async () => {
  const h = harness(); let resolve; let calls = 0;
  const pending = new Promise(r => { resolve = r; });
  const runtime = createOutboxRuntime(h.ctx, enabled(), h.outbox, async () => { calls++; await pending; return response({ ok: true, result: { message_id: 99, chat: { id: 321 } } }); }, () => NOW);
  await runtime.enqueue({ id: 1, chatId: 321, messageId: 2 }, 'A');
  const a = runtime.drain(), b = runtime.drain(); resolve();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
});

test('network ambiguity does not retry and disabled delivery never claims', async () => {
  const h = harness();
  const runtime = createOutboxRuntime(h.ctx, enabled(), h.outbox, async () => { throw Error('timeout'); }, () => NOW);
  await runtime.enqueue({ id: 1, chatId: 321, messageId: 2 }, 'A');
  await runtime.drain(); await runtime.drain();
  assert.equal(h.rows.get(1).state, 'uncertain');
  const disabled = createOutboxRuntime(h.ctx, { ...enabled(), TELEGRAM_DELIVERY_ENABLED: 'false' }, h.outbox, h.transport, () => NOW);
  await disabled.enqueue({ id: 2, chatId: 321, messageId: 3 }, 'B');
  await disabled.drain();
  assert.equal(h.rows.get(2).state, 'queued');
  assert.equal(h.sends, 0);
});

test('alarm storage failure rejects enqueue rather than falsely acknowledging it', async () => {
  const h = harness(); h.failAlarm = true;
  await assert.rejects(h.runtime.enqueue({ id: 1, chatId: 321, messageId: 2 }, 'A'), /storage failure/);
  assert.equal(h.rows.get(1).state, 'queued');
});

test('stateless live housing results proxy photos as separate linked listing cards', async () => {
  const message = { chatId: 123, text: '🔎 Hamburg · 2 · 950 · W · 15km' };
  const env = {
    TELEGRAM_ALLOWED_CHAT_IDS: '123', TELEGRAM_PILOT_MODE: 'allowlist', TELEGRAM_RELEASE_APPROVED: 'pilot-v1',
    TELEGRAM_BOT_TOKEN: '12345:' + 'A'.repeat(30), TELEGRAM_WEBHOOK_SECRET: 'B'.repeat(32), TELEGRAM_DELIVERY_ENABLED: 'false', KLAZ_API_KEY: 'klaz_live_' + 'C'.repeat(24)
  };
  const calls = [];
  let photoSends = 0;
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const transport = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/locations?')) return new Response(JSON.stringify({ success:true, data:{ locations:[{id:'9409',name:'Hamburg'}] } }), {status:200,headers:{'content-type':'application/json'}});
    if (url.includes('api.kleinanzeigen-agent.de') && url.includes('/search?')) return new Response(JSON.stringify({ success:true, data:{ ads:[
      {ad_id:'1',title:'Wohnung A',description:'',price:{amount:800,price_type:'FIXED'},status:'ACTIVE',deleted:false,ad_url:'https://www.kleinanzeigen.de/s-anzeige/a/1',images:['https://img.example.test/a.jpg'],location:{name:'Hamburg'},details:{Zimmer:'2'}},
      {ad_id:'2',title:'Wohnung B',description:'',price:{amount:850,price_type:'FIXED'},status:'ACTIVE',deleted:false,ad_url:'https://www.kleinanzeigen.de/s-anzeige/b/2',images:['https://img.example.test/b.jpg'],location:{name:'Hamburg'},details:{Zimmer:'2'}}
    ] } }), {status:200,headers:{'content-type':'application/json'}});
    if (url.startsWith('https://img.example.test/')) return new Response(jpeg, {status:200,headers:{'content-type':'image/jpeg'}});
    if (url.endsWith('/sendPhoto')) {
      photoSends++;
      assert.ok(options.body instanceof FormData);
      assert.ok(options.body.get('photo') instanceof Blob);
      assert.match(String(options.body.get('caption')), /🔗 Відкрити оголошення/u);
      const markup = JSON.parse(options.body.get('reply_markup'));
      assert.equal(markup.inline_keyboard[0][0].text, '🔗 Відкрити оголошення');
      assert.match(markup.inline_keyboard[0][0].url, /^https:\/\/www\.kleinanzeigen\.de\//);
      return new Response(JSON.stringify({ok:true,result:{message_id:10 + photoSends,chat:{id:123}}}), {status:200,headers:{'content-type':'application/json'}});
    }
    throw new Error('unexpected transport: ' + url);
  };
  const result = await sendStatelessPilotReply(message, env, transport);
  assert.equal(result.status, 'sent');
  assert.equal(photoSends, 2);
  assert.equal(calls.filter(c => c.url.endsWith('/sendMediaGroup')).length, 0);
  assert.equal(calls.filter(c => c.url.endsWith('/sendPhoto')).length, 2);
  assert.equal(calls.filter(c => c.url.startsWith('https://img.example.test/')).length, 2);
});


test('start exposes a topic keyboard for natural navigation', async () => {
  const message = { chatId: 123, text: '/start' };
  const env = {
    TELEGRAM_ALLOWED_CHAT_IDS: '123', TELEGRAM_PILOT_MODE: 'allowlist', TELEGRAM_RELEASE_APPROVED: 'pilot-v1',
    TELEGRAM_BOT_TOKEN: '12345:' + 'A'.repeat(30), TELEGRAM_WEBHOOK_SECRET: 'B'.repeat(32), TELEGRAM_DELIVERY_ENABLED: 'false'
  };
  let payload;
  const transport = async (url, options = {}) => {
    if (!url.includes('/sendMessage')) throw new Error('unexpected transport');
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ok:true,result:{message_id:10,chat:{id:123}}}), {status:200,headers:{'content-type':'application/json'}});
  };
  const result = await sendStatelessPilotReply(message, env, transport);
  assert.equal(result.status, 'sent');
  assert.equal(payload.reply_markup.keyboard[0][0].text, '🏠 Житло');
  assert.equal(payload.reply_markup.keyboard[0][1].text, '🏛 Jobcenter');
});


test('housing topic accepts a city as the next guided step', () => {
  const previous = 'Тема: житло. Вкажіть місто або район.';
  const city = replyFor({ text: 'Гамбург', replyToText: previous });
  assert.match(city, /Тема: житло — Hamburg\./);
  assert.match(city, /Локацію вже визначено/);
  const kiel = replyFor({ text: 'Кіль', replyToText: previous });
  assert.match(kiel, /Тема: житло — Kiel\./);
  const rendsburg = replyFor({ text: 'Рендсбург', replyToText: previous });
  assert.match(rendsburg, /Тема: житло — Rendsburg\./);
  const arbitrary = replyFor({ text: 'Neumünster', replyToText: previous });
  assert.match(arbitrary, /Тема: житло — Neumünster\./);
  const rooms = replyFor({ text: '3-4', replyToText: city });
  assert.match(rooms, /Житло — Hamburg, 3-4 кімнати/);
});


test('housing topic forces the next city reply so stateless context is preserved', async () => {
  const message = { chatId: 123, text: '🏠 Житло' };
  const env = {
    TELEGRAM_ALLOWED_CHAT_IDS: '123', TELEGRAM_PILOT_MODE: 'allowlist', TELEGRAM_RELEASE_APPROVED: 'pilot-v1',
    TELEGRAM_BOT_TOKEN: '12345:' + 'A'.repeat(30), TELEGRAM_WEBHOOK_SECRET: 'B'.repeat(32), TELEGRAM_DELIVERY_ENABLED: 'false'
  };
  let payload;
  const transport = async (url, options = {}) => {
    if (!url.includes('/sendMessage')) throw new Error('unexpected transport');
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ok:true,result:{message_id:12,chat:{id:123}}}), {status:200,headers:{'content-type':'application/json'}});
  };
  const result = await sendStatelessPilotReply(message, env, transport);
  assert.equal(result.status, 'sent');
  assert.match(payload.text, /Вкажіть місто або район/);
  assert.equal(payload.reply_markup.force_reply, true);
  assert.match(payload.reply_markup.input_field_placeholder, /Kiel/);
});



test('privacy command reflects current Telegram privacy setup', () => {
  const privacy = replyFor({ text: '/privacy' });
  assert.match(privacy, /Конфіденційність/);
  // TG-RUNTIME-066: Telegram's own policy does not cover the bot's processing;
  // while the policy is unpublished the text says so and offers /forget.
  assert.doesNotMatch(privacy, /Privacy Policy for Bots and Mini Apps/);
  assert.match(privacy, /ще готуються/);
  assert.match(privacy, /\/forget/);
  assert.doesNotMatch(privacy, /До публічного запуску/);
  assert.match(replyFor({ text: '/help' }), /Команди/);
  assert.match(replyFor({ text: '/topics' }), /Теми/);
});


test('Jobcenter topic housing reply preserves Jobcenter context', () => {
  const jobcenter = replyFor({ text: '🏛 Jobcenter' });
  assert.match(jobcenter, /Тема: Jobcenter/);
  const housing = replyFor({ text: 'Любек оренда\/житло', replyToText: jobcenter });
  assert.match(housing, /Тема: житло — Lübeck/);
  assert.match(housing, /Для нормативів Jobcenter вкажіть кількість осіб \(1–20\)/);
  assert.doesNotMatch(housing, /Уточніть кількість кімнат/);
  const household = replyFor({ text: '3', replyToText: housing });
  assert.match(household, /Lübeck/);
  assert.match(household, /Осіб: 3/);
  assert.match(household, /Jobcenter/);
});
