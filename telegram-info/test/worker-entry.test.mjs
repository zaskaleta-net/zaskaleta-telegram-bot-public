import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handle } from '../src/worker-entry.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const NOW = 1700000000000;
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const env = () => ({
  TELEGRAM_RELEASE_APPROVED: 'pilot-v1',
  TELEGRAM_PILOT_MODE: 'allowlist',
  TELEGRAM_ALLOWED_CHAT_IDS: '321',
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  TELEGRAM_INGRESS_ENABLED: 'true',
  TELEGRAM_DELIVERY_ENABLED: 'false',
  OUTBOX: { idFromName() { throw Error('stateless Jobcenter flow must not touch Durable Objects'); } }
});
const request = value => new Request('https://pilot.example/telegram/stateless', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify(value)
});
const telegramOK = result => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
const messageUpdate = (id, text, replyText) => ({
  update_id: id,
  message: {
    message_id: id + 1, date: NOW / 1000, chat: { id: 321, type: 'private' }, from: { id: 321, is_bot: false }, text,
    reply_to_message: { message_id: id, date: NOW / 1000 - 1, chat: { id: 321, type: 'private' }, from: { id: 999, is_bot: true, username: 'ZaskaletaInfoBot' }, text: replyText }
  }
});

test('entrypoint delegates health to the existing Worker unchanged', async () => {
  const response = await handle(new Request('https://pilot.example/health'), env(), NOW, async () => { throw Error('no network'); });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'zaskaleta-info-telegram', delivery: false, versionId: null });
});

test('Jobcenter callback is answered and prompts for household size without Durable Objects or media resend', async () => {
  const update = {
    update_id: 2,
    callback_query: {
      id: 'cb-1', from: { id: 321, is_bot: false }, data: 'jc:3506905833',
      message: {
        message_id: 10, date: NOW / 1000 - 1000, chat: { id: 321, type: 'private' },
        from: { id: 999, is_bot: true, username: 'ZaskaletaInfoBot' },
        caption: '1. Wohnung\n💶 850 € · 22946 Trittau\n🛏 3 кімн. · 📐 90 м²'
      }
    }
  };
  const methods = [];
  const transport = async (url, options) => {
    const method = url.split('/').at(-1); methods.push(method);
    if (method === 'answerCallbackQuery') return telegramOK(true);
    assert.equal(method, 'sendMessage');
    const body = JSON.parse(options.body);
    assert.equal(body.reply_markup.force_reply, true);
    assert.match(body.text, /22946 Trittau/);
    assert.ok(body.entities.some(e => body.text.slice(e.offset, e.offset + e.length) === '🏛 Перевірка під Jobcenter'));
    assert.equal(body.parse_mode, undefined);
    return telegramOK({ message_id: 50, chat: { id: 321 } });
  };
  const response = await handle(request(update), env(), NOW, transport);
  assert.deepEqual(methods, ['answerCallbackQuery', 'sendMessage']);
  assert.deepEqual(await response.json(), { ok: true, mode: 'stateless', delivered: true });
});

test('Jobcenter flow uses verified Stormarn threshold and never auto-passes incomplete rent breakdown', async () => {
  const step1 = '🏛 Перевірка під Jobcenter\nОголошення: #3506905833\nЛокація: 22946 Trittau\nПлоща: 90 м²\n\nКрок 1/2: вкажіть кількість осіб у домогосподарстві (1–20).';
  let step2;
  const firstTransport = async (url, options) => {
    const body = JSON.parse(options.body); step2 = body.text;
    assert.match(step2, /943,80 €/);
    assert.equal(body.reply_markup.force_reply, true);
    return telegramOK({ message_id: 60, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(3, '4', step1)), env(), NOW, firstTransport);
  assert.ok(step2);

  const incompleteTransport = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.text, /⚠️ Недостатньо даних/);
    assert.equal(body.reply_markup.force_reply, true);
    return telegramOK({ message_id: 61, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(4, 'Kaltmiete 700, Betriebskosten 150', step2)), env(), NOW, incompleteTransport);

  const completeTransport = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.text, /^✅/);
    assert.match(body.text, /не є Zusicherung/);
    assert.match(body.reply_markup.inline_keyboard[0][0].url, /jobcenter-stormarn/);
    return telegramOK({ message_id: 62, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(5, 'Kaltmiete 700, Betriebskosten 150, Heizkosten 80', step2)), env(), NOW, completeTransport);
});

test('non-Stormarn listing never receives fabricated Jobcenter criteria', async () => {
  const step1 = '🏛 Перевірка під Jobcenter\nОголошення: #3506905833\nЛокація: Hamburg\n\nКрок 1/2: вкажіть кількість осіб у домогосподарстві (1–20).';
  const transport = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.text, /не можу підтвердити критерії/);
    assert.doesNotMatch(body.text, /^✅/);
    return telegramOK({ message_id: 70, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(6, '4', step1)), env(), NOW, transport);
});
