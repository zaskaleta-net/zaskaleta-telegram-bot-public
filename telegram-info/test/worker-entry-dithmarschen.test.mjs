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
  OUTBOX: { idFromName() { throw Error('Dithmarschen stateless Jobcenter flow must not touch Durable Objects'); } }
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

test('Heide listing uses Dithmarschen Nord limit and product-theory area handling', async () => {
  const step1 = '🏛 Перевірка під Jobcenter\nОголошення: #3506905901\nЛокація: 25746 Heide\nПлоща: 100 м²\n\nКрок 1/2: вкажіть кількість осіб у домогосподарстві (1–20).';
  let step2;
  const firstTransport = async (_url, options) => {
    const body = JSON.parse(options.body);
    step2 = body.text;
    assert.match(step2, /Jobcenter Dithmarschen/);
    assert.match(step2, /751,50 €/);
    assert.match(step2, /jobcenter-dithmarschen-kdu-2025-01-01/);
    return telegramOK({ message_id: 90, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(30, '4', step1)), env(), NOW, firstTransport);

  const completeTransport = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.text, /^✅/);
    assert.match(body.text, /Jobcenter Dithmarschen/);
    assert.match(body.text, /більшої Wohnfläche|größere Wohnfläche|більшої площі|größeren Wohnungen/u);
    assert.equal(body.reply_markup.inline_keyboard[0][0].url, 'https://www.jobcenter-dithmarschen.de/fileadmin/user_upload/Richtlinie_Kosten_der_Unterkunft.pdf');
    return telegramOK({ message_id: 91, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(31, 'Kaltmiete 550, Betriebskosten 140, Heizkosten 150', step2)), env(), NOW, completeTransport);
});

test('ambiguous bare Quickborn location gets warning instead of Dithmarschen green result', async () => {
  const step1 = '🏛 Перевірка під Jobcenter\nОголошення: #3506905902\nЛокація: Quickborn\nПлоща: 80 м²\n\nКрок 1/2: вкажіть кількість осіб у домогосподарстві (1–20).';
  const transport = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.text, /^⚠️/);
    assert.match(body.text, /не верифіковані|неможливо однозначно/u);
    assert.doesNotMatch(body.text, /^✅/);
    return telegramOK({ message_id: 92, chat: { id: 321 } });
  };
  await handle(request(messageUpdate(32, '4', step1)), env(), NOW, transport);
});
