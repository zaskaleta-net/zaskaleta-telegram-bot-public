import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handle, STATELESS_PATH } from '../src/worker.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const NOW = 1700000000000;
const KLAZ_KEY = 'klaz_live_' + 'A'.repeat(24);
const env = () => ({
  TELEGRAM_RELEASE_APPROVED: 'pilot-v1',
  TELEGRAM_PILOT_MODE: 'allowlist',
  TELEGRAM_ALLOWED_CHAT_IDS: '321',
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  TELEGRAM_INGRESS_ENABLED: 'true',
  TELEGRAM_DELIVERY_ENABLED: 'false',
  OUTBOX: { idFromName() { throw Error('stateless path must not touch DO'); } }
});
const update = (id = 1, text = '/start', replyText = '') => ({
  update_id: id,
  message: {
    message_id: id + 1,
    date: NOW / 1000,
    chat: { id: 321, type: 'private' },
    from: { id: 321, is_bot: false },
    text,
    ...(replyText ? { reply_to_message: { message_id: id, date: NOW / 1000 - 1, chat: { id: 321, type: 'private' }, from: { id: 999, is_bot: true, username: 'ZaskaletaInfoBot' }, text: replyText } } : {})
  }
});
const request = (value, secret = SECRET) => new Request('https://pilot.example' + STATELESS_PATH, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
  body: JSON.stringify(value)
});
const telegramOK = body => new Response(JSON.stringify({ ok: true, result: { message_id: 77, chat: { id: JSON.parse(body).chat_id } } }), { status: 200, headers: { 'content-type': 'application/json' } });

async function sendAndCapture(id, text, replyText = '') {
  let body;
  let calls = 0;
  const transport = async (url, options) => {
    calls++;
    assert.match(url, /api\.telegram\.org\/bot/);
    body = JSON.parse(options.body);
    return telegramOK(options.body);
  };
  const response = await handle(request(update(id, text, replyText)), env(), NOW, transport);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, mode: 'stateless', delivered: true });
  return { ...body, _calls: calls };
}

function assertListingSearchAction(body, { location, rooms, amount, type, radius = 15 }) {
  const button = body.reply_markup?.keyboard?.[0]?.[0];
  const code = type === 'Warmmiete' ? 'W' : 'K';
  assert.equal(button?.text, `🔎 ${location} · ${rooms} · ${amount} · ${code} · ${radius}km`);
  assert.equal(body.reply_markup?.one_time_keyboard, true);
  assert.equal(body.reply_markup?.resize_keyboard, true);
}

test('stateless path sends one deterministic reply without touching Durable Objects', async () => {
  const body = await sendAndCapture(1, '/start');
  assert.equal(body.chat_id, 321);
  assert.match(body.text, /Schleswig-Holstein Помічник/);
  assert.equal(body._calls, 1);
});

test('housing flow uses Telegram ForceReply as stateless conversation context', async () => {
  const firstBody = await sendAndCapture(10, 'Шукаю житло в Hamburg');
  assert.match(firstBody.text, /житло — Hamburg/);
  assert.equal(firstBody.reply_markup?.force_reply, true);
  assert.match(firstBody.reply_markup?.input_field_placeholder || '', /3/);

  const secondBody = await sendAndCapture(11, '3', firstBody.text);
  assert.match(secondBody.text, /Hamburg, 3 кімнати/);
  assert.match(secondBody.text, /пошук житла/);
  assert.equal(secondBody.reply_markup?.force_reply, true);

  const thirdBody = await sendAndCapture(12, 'Пошук житла', secondBody.text);
  assert.match(thirdBody.text, /Пошук житла — Hamburg, 3 кімнати/);
  assert.match(thirdBody.text, /бюджет/);
  assert.equal(thirdBody.reply_markup?.force_reply, true);

  const fourthBody = await sendAndCapture(13, '950', thirdBody.text);
  assert.match(fourthBody.text, /бюджет до 950 €/);
  assert.match(fourthBody.text, /Warmmiete чи Kaltmiete/);
  assert.equal(fourthBody.reply_markup?.force_reply, true);

  const fifthBody = await sendAndCapture(14, 'Warmmiete', fourthBody.text);
  assert.match(fifthBody.text, /Оберіть радіус пошуку/);
  assert.ok(fifthBody.reply_markup?.keyboard?.flat().some(button => button.text === '15 км'));
  const sixthBody = await sendAndCapture(15, '15 км', fifthBody.text);
  assert.match(sixthBody.text, /Критерії пошуку зібрано/);
  assert.match(sixthBody.text, /Hamburg, 3 кімнати, до 950 € Warmmiete, радіус 15 км/);
  assertListingSearchAction(sixthBody, { location: 'Hamburg', rooms: 3, amount: '950', type: 'Warmmiete' });

  const directBudgetBody = await sendAndCapture(16, '1200 € Kaltmiete', thirdBody.text);
  assert.match(directBudgetBody.text, /Оберіть радіус пошуку/);
  const directBudgetFinal = await sendAndCapture(17, '25 км', directBudgetBody.text);
  assert.match(directBudgetFinal.text, /Hamburg, 3 кімнати, до 1200 € Kaltmiete, радіус 25 км/);
  assertListingSearchAction(directBudgetFinal, { location: 'Hamburg', rooms: 3, amount: '1200', type: 'Kaltmiete', radius: 25 });
});

test('standalone budget continues as a guided conversation without durable state', async () => {
  const budgetOnly = await sendAndCapture(20, '950');
  assert.match(budgetOnly.text, /Бюджет 950 € розпізнано/);
  assert.match(budgetOnly.text, /Вкажіть місто або район/);
  assert.equal(budgetOnly.reply_markup?.force_reply, true);
  assert.match(budgetOnly.reply_markup?.input_field_placeholder || '', /Hamburg/);

  const city = await sendAndCapture(21, 'Hamburg', budgetOnly.text);
  assert.match(city.text, /Бюджет 950 €, місто Hamburg/);
  assert.match(city.text, /кількість кімнат/);
  assert.equal(city.reply_markup?.force_reply, true);
  assert.match(city.reply_markup?.input_field_placeholder || '', /3/);

  const rooms = await sendAndCapture(22, '3', city.text);
  assert.match(rooms.text, /Бюджет 950 €, місто Hamburg, 3 кімнати/);
  assert.match(rooms.text, /Warmmiete чи Kaltmiete/);
  assert.equal(rooms.reply_markup?.force_reply, true);

  const type = await sendAndCapture(23, 'Warmmiete', rooms.text);
  assert.match(type.text, /Оберіть радіус пошуку/);
  const radius = await sendAndCapture(24, '10 км', type.text);
  assert.match(radius.text, /Критерії пошуку зібрано/);
  assert.match(radius.text, /Hamburg, 3 кімнати, до 950 € Warmmiete, радіус 10 км/);
  assertListingSearchAction(radius, { location: 'Hamburg', rooms: 3, amount: '950', type: 'Warmmiete', radius: 10 });

  const budgetWithType = await sendAndCapture(25, '1100 € Kaltmiete');
  assert.match(budgetWithType.text, /1100 € Kaltmiete розпізнано/);
  const typedCity = await sendAndCapture(26, 'Trittau', budgetWithType.text);
  assert.match(typedCity.text, /місто Trittau/);
  const typedRooms = await sendAndCapture(27, '3', typedCity.text);
  assert.match(typedRooms.text, /Оберіть радіус пошуку/);
  const typedFinal = await sendAndCapture(28, '50 км', typedRooms.text);
  assert.match(typedFinal.text, /Trittau, 3 кімнати, до 1100 € Kaltmiete, радіус 50 км/);
  assertListingSearchAction(typedFinal, { location: 'Trittau', rooms: 3, amount: '1100', type: 'Kaltmiete', radius: 50 });
});

test('compact housing criteria still recover without reply context', async () => {
  const compact = await sendAndCapture(30, 'Hamburg, 3 кімнати, 950 € Warmmiete');
  assert.match(compact.text, /Оберіть радіус пошуку/);
  const compactFinal = await sendAndCapture(32, '15 км', compact.text);
  assert.match(compactFinal.text, /Критерії пошуку зібрано/);
  assert.match(compactFinal.text, /Hamburg, 3 кімнати, до 950 € Warmmiete, радіус 15 км/);
  assertListingSearchAction(compactFinal, { location: 'Hamburg', rooms: 3, amount: '950', type: 'Warmmiete' });

  const compactWithoutType = await sendAndCapture(31, 'Hamburg 3 950');
  assert.match(compactWithoutType.text, /Hamburg, 3 кімнати, бюджет до 950 €/);
  assert.match(compactWithoutType.text, /Warmmiete чи Kaltmiete/);
  assert.equal(compactWithoutType.reply_markup?.force_reply, true);
});

test('housing search action falls back safely when no key is set and every source is down', async () => {
  // TG-RUNTIME-067: the plain search asks the public sources too (it used to
  // stop at "провайдер ще не підключено"). With all of them down the user
  // gets one clear message with the external search buttons.
  let body;
  let telegramCalls = 0;
  const transport = async (url, options = {}) => {
    if (!/api\.telegram\.org\/bot/.test(String(url))) throw new TypeError('network down');
    telegramCalls++;
    body = JSON.parse(options.body);
    return telegramOK(options.body);
  };
  const response = await handle(request(update(35, '🔎 Hamburg · 2 · 950 · W')), env(), NOW, transport);
  assert.deepEqual(await response.json(), { ok: true, mode: 'stateless', delivered: true });
  assert.equal(telegramCalls, 1);
  assert.doesNotMatch(body.text, /провайдер ще не підключено/);
  assert.match(body.text, /тимчасово недоступний/);
  assert.equal(body.reply_markup?.inline_keyboard?.length, 12);
  for (const row of body.reply_markup.inline_keyboard) assert.match(row[0]?.url || '', /^https:\/\//);
});

test('housing search action calls provider read-only and returns filtered listing without Durable Objects', async () => {
  const calls = [];
  const transport = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('api.kleinanzeigen-agent.de') && url.includes('/locations?')) {
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers?.klaz_key, KLAZ_KEY);
      assert.ok(!url.includes(KLAZ_KEY));
      return new Response(JSON.stringify({ success: true, data: { locations: [{ id: '9409', name: 'Hamburg', city: 'Hamburg' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('api.kleinanzeigen-agent.de') && url.includes('/search?')) {
      const parsed = new URL(url);
      assert.equal(options.redirect, 'manual');
      assert.equal(parsed.searchParams.get('category_id'), '203');
      assert.equal(parsed.searchParams.get('location_id'), '9409');
      assert.equal(parsed.searchParams.get('max_price'), '950');
      assert.equal(parsed.searchParams.get('picture_required'), 'false', 'listings without photos are shown as text cards');
      assert.equal(parsed.searchParams.get('size'), '100');
      assert.equal(parsed.searchParams.get('q'), null);
      assert.equal(parsed.searchParams.get('ad_type'), null);
      assert.ok(!url.includes(KLAZ_KEY));
      return new Response(JSON.stringify({ success: true, data: { ads: [{
        ad_id: '3506905833', title: 'Tolle Wohnung in Farmsen zu vermieten!', description: '',
        price: { amount: 617, price_type: 'SPECIFIED_AMOUNT' }, status: 'ACTIVE', deleted: false,
        ad_url: 'https://www.kleinanzeigen.de/s-anzeige/tolle-2-zimmer-wohnung/3506905833',
        location: { name: 'Hamburg Farmsen-Berne' }, details: { Zimmer: '2' },
        attributes: [{ name: 'wohnung_mieten.zimmer', label: 'Zimmer', values: [{ value: '2', label: '2' }] }]
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // TG-RUNTIME-067: the public sources are asked too; here they are down.
    if (!/api\.telegram\.org\/bot/.test(String(url))) {
      assert.ok(!String(url).includes(KLAZ_KEY));
      throw new TypeError('network down');
    }
    assert.ok(!String(options.body || '').includes(KLAZ_KEY));
    return telegramOK(options.body);
  };

  const response = await handle(request(update(36, '🔎 Hamburg · 2 · 950 · W')), { ...env(), KLAZ_API_KEY: KLAZ_KEY }, NOW, transport);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, mode: 'stateless', delivered: true });
  const apiCalls = calls.filter(call => String(call.url).includes('api.kleinanzeigen-agent.de'));
  // The API answers location lookups and exactly one search per category
  // (203 flats, 205 houses; searchLiveHousing), read-only.
  const searchCategories = apiCalls.filter(call => String(call.url).includes('/search?'))
    .map(call => new URL(String(call.url)).searchParams.get('category_id')).sort();
  assert.deepEqual(searchCategories, ['203', '205']);
  assert.ok(apiCalls.every(call => /\/(?:locations|search)\?/.test(String(call.url))), apiCalls.map(call => String(call.url).split('?')[0]).join(','));
  for (const call of apiCalls) assert.equal(call.options.method || 'GET', 'GET', 'read-only');
  const telegramCalls = calls.filter(call => /api\.telegram\.org\/bot/.test(String(call.url)));
  assert.equal(telegramCalls.length, 1);
  const telegramCall = telegramCalls[0];
  const body = JSON.parse(telegramCall.options.body);
  assert.match(body.text, /Tolle Wohnung in Farmsen/);
  assert.match(body.text, /617 €/);
  assert.doesNotMatch(body.text, /https?:\/\//);
  assert.equal(body.reply_markup?.inline_keyboard?.length, 13);
  assert.equal(body.reply_markup.inline_keyboard[0][0].text, '1. Відкрити оголошення');
  assert.match(body.reply_markup.inline_keyboard[0][0].url, /^https:\/\/www\.kleinanzeigen\.de\/s-anzeige\//);
});

test('stateless path is available only while queued delivery is explicitly disabled', async () => {
  let calls = 0;
  const transport = async () => { calls++; throw Error('must not send'); };
  assert.equal((await handle(request(update()), { ...env(), TELEGRAM_DELIVERY_ENABLED: 'true' }, NOW, transport)).status, 503);
  assert.equal((await handle(request(update()), { ...env(), TELEGRAM_DELIVERY_ENABLED: undefined }, NOW, transport)).status, 503);
  assert.equal(calls, 0);
});

test('stateless path authenticates, filters foreign or stale updates and never sends them', async () => {
  let calls = 0;
  const transport = async () => { calls++; throw Error('must not send'); };
  assert.equal((await handle(request(update(), 'wrong'), env(), NOW, transport)).status, 401);
  const foreign = update(2); foreign.message.chat.id = 999; foreign.message.from.id = 999;
  assert.deepEqual(await (await handle(request(foreign), env(), NOW, transport)).json(), { ok: true, ignored: true });
  const old = update(3); old.message.date -= 400;
  assert.deepEqual(await (await handle(request(old), env(), NOW, transport)).json(), { ok: true, ignored: true });
  assert.equal(calls, 0);
});

test('uncertain stateless send is acknowledged once and is never retried', async () => {
  let calls = 0;
  const transport = async () => { calls++; throw Error('timeout'); };
  const r = await handle(request(update(4, '/help')), env(), NOW, transport);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, mode: 'stateless', delivered: false });
  assert.equal(calls, 1);
});


const multiEnv = () => ({ ...env(), TELEGRAM_ALLOWED_CHAT_IDS: '321,-100123' });
function groupUpdate(id, text, replyText = '', type = 'supergroup') {
  const value = update(id, text, replyText);
  value.message.chat = { id: -100123, type };
  if (value.message.reply_to_message) value.message.reply_to_message.chat = value.message.chat;
  return value;
}

test('stateless multi-chat commands, mentions and full housing replies stay in their requesting chat', async () => {
  for (const type of ['group', 'supergroup']) {
    let id = 100;
    async function send(text, previous = '') {
      let body;
      const response = await handle(request(groupUpdate(id++, text, previous, type)), multiEnv(), NOW, async (_url, options) => {
        body = JSON.parse(options.body);
        assert.equal(body.chat_id, -100123);
        return telegramOK(options.body);
      });
      assert.equal((await response.json()).delivered, true);
      return body;
    }
    assert.match((await send('/start@ZaskaletaInfoBot')).text, /Вітаємо/);
    let body = await send('@ZaskaletaInfoBot Житло');
    body = await send('Trittau', body.text);
    body = await send('3-4', body.text);
    body = await send('Пошук житла', body.text);
    body = await send('950', body.text);
    body = await send('Kaltmiete', body.text);
    body = await send('15 км', body.text);
    assertListingSearchAction(body, { location: 'Trittau', rooms: '3-4', amount: '950', type: 'Kaltmiete' });
    const result = await send(body.reply_markup.keyboard[0][0].text);
    // TG-RUNTIME-067: all sources down in this test → a clear unavailable text.
    assert.doesNotMatch(result.text, /провайдер ще не підключено/);
    assert.match(result.text, /тимчасово недоступний/);
  }
  const response = await handle(request(update(200)), multiEnv(), NOW, async (_url, options) => {
    assert.equal(JSON.parse(options.body).chat_id, 321);
    return telegramOK(options.body);
  });
  assert.equal((await response.json()).delivered, true);
});

test('multi-chat ignores unlisted groups and ordinary conversation', async () => {
  for (const value of [groupUpdate(210, 'Привіт усім'), groupUpdate(211, '/start@AnotherBot'), groupUpdate(212, '/start')]) {
    if (value.update_id === 212) value.message.chat.id = -100999;
    const response = await handle(request(value), multiEnv(), NOW, async () => assert.fail('must not send'));
    assert.deepEqual(await response.json(), { ok: true, ignored: true });
  }
});

test('multi-chat treats a Telegram response for another chat as uncertain without replay', async () => {
  let calls = 0;
  const response = await handle(request(groupUpdate(220, '/start')), multiEnv(), NOW, async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77, chat: { id: 321 } } }));
  });
  assert.equal((await response.json()).delivered, false);
  assert.equal(calls, 1);
});
