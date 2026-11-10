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
  OUTBOX: { idFromName() { throw Error('statewide stateless Jobcenter flow must not touch Durable Objects'); } }
});
const request = value => new Request('https://pilot.example/telegram/stateless', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify(value)
});
const telegramOK = result => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type':'application/json' } });
const messageUpdate = (id, text, replyText) => ({
  update_id: id,
  message: {
    message_id: id + 1, date: NOW / 1000, chat: { id: 321, type: 'private' }, from: { id: 321, is_bot: false }, text,
    reply_to_message: { message_id: id, date: NOW / 1000 - 1, chat: { id: 321, type: 'private' }, from: { id: 999, is_bot: true, username: 'ZaskaletaInfoBot' }, text: replyText }
  }
});

test('Kiel listing uses Kiel verified module end-to-end without Durable Objects', async () => {
  const step1 = '🏛 Перевірка під Jobcenter\nОголошення: #3506905833\nЛокація: 24103 Kiel\nПлоща: 90 м²\n\nКрок 1/2: вкажіть кількість осіб у домогосподарстві (1–20).';
  let step2;
  const firstTransport = async (_url, options) => {
    const body = JSON.parse(options.body);
    step2 = body.text;
    assert.match(step2, /Jobcenter Kiel/);
    assert.match(step2, /815,50 €/);
    assert.match(step2, /jobcenter-kiel-kdu-2025-01-01/);
    return telegramOK({ message_id: 80, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(20, '4', step1)), env(), NOW, firstTransport);

  const completeTransport = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.text, /^✅/);
    assert.match(body.text, /Jobcenter Kiel/);
    assert.match(body.text, /не є Zusicherung/);
    assert.equal(body.reply_markup.inline_keyboard[0][0].url, 'https://www.jobcenter-kiel.de/geldleistungen/');
    return telegramOK({ message_id: 81, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(21, 'Kaltmiete 600, Betriebskosten 100, Heizkosten 80', step2)), env(), NOW, completeTransport);
});

test('Lübeck household above published table is routed to individual review, never green', async () => {
  const step1 = '🏛 Перевірка під Jobcenter\nОголошення: #3506905834\nЛокація: 23552 Lübeck\nПлоща: 120 м²\n\nКрок 1/2: вкажіть кількість осіб у домогосподарстві (1–20).';
  const transport = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.text, /^⚠️ Jobcenter Lübeck/);
    assert.match(body.text, /індивідуальна перевірка/);
    assert.doesNotMatch(body.text, /^✅/);
    return telegramOK({ message_id: 82, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(22, '7', step1)), env(), NOW, transport);
});

test('Ostholstein Eutin uses the verified comparison-zone limit end-to-end', async () => {
  const step1 = '🏛 Перевірка під Jobcenter\nОголошення: #3506905835\nЛокація: 23701 Eutin\nПлоща: 70 м²\n\nКрок 1/2: вкажіть кількість осіб у домогосподарстві (1–20).';
  let step2;
  const firstTransport = async (_url, options) => {
    const body = JSON.parse(options.body);
    step2 = body.text;
    assert.match(step2, /Jobcenter Ostholstein/);
    assert.match(step2, /679,50 €/);
    assert.match(step2, /jobcenter-ostholstein-kdu-2025-05-01/);
    assert.match(step2, /Крок 2\/2:/);
    assert.doesNotMatch(step2, /^✅/);
    return telegramOK({ message_id: 83, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(23, '3', step1)), env(), NOW, firstTransport);

  const completeTransport = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.text, /^✅/);
    assert.match(body.text, /Jobcenter Ostholstein/);
    assert.match(body.text, /не є Zusicherung/);
    return telegramOK({ message_id: 84, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(24, 'Kaltmiete 500, Betriebskosten 100, Heizkosten 80', step2)), env(), NOW, completeTransport);
});

test('Neumünster pending numeric coverage fails closed end-to-end', async () => {
  const step1 = '🏛 Перевірка під Jobcenter\nОголошення: #3506905836\nЛокація: 24534 Neumünster\nПлоща: 78 м²\n\nКрок 1/2: вкажіть кількість осіб у домогосподарстві (1–20).';
  const transport = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.text, /^⚠️/);
    assert.match(body.text, /24534 Neumünster/);
    assert.match(body.text, /не підставляє ліміт іншого Kreis/);
    assert.match(body.text, /не ставить автоматичне ✅/);
    assert.doesNotMatch(body.text, /Крок 2\/2:/);
    assert.doesNotMatch(body.text, /^✅/);
    return telegramOK({ message_id: 85, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(25, '3', step1)), env(), NOW, transport);
});
