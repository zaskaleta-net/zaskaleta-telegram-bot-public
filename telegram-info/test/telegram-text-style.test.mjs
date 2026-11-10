import test from 'node:test';
import assert from 'node:assert/strict';
import { BOT_DISPLAY_NAME, telegramTextStyle } from '../src/telegram-text-style.mjs';
import { replyFor, sendStatelessPilotReply } from '../src/worker.mjs';

test('styling keeps quoted text and HTML-like user content literal, with valid UTF-16 spans after emoji', () => {
  const text = '🏛 Перевірка житла\n\nЛокація: A&B <b>центр</b>\nKaltmiete 900,50 €\nBetriebskosten 150 €';
  const styled = telegramTextStyle(text);
  assert.equal(styled.text, text);
  assert.equal(styled.parse_mode, undefined);
  const selections = styled.entities.map(e => styled.text.slice(e.offset, e.offset + e.length));
  assert.ok(selections.includes('900,50 €'));
  assert.ok(selections.includes('Kaltmiete'));
  assert.ok(selections.includes('Локація:'));
  for (const [i, e] of styled.entities.entries()) {
    assert.equal(e.type, 'bold');
    assert.ok(e.length > 0 && e.offset + e.length <= text.length);
    if (i) assert.ok(styled.entities[i - 1].offset + styled.entities[i - 1].length <= e.offset);
  }
});

test('formatted housing messages retain city, rooms and rent context across replies', () => {
  let previous = 'Jobcenter-погодження житла — Kiel, 3-4 кімнати. Вкажіть Kaltmiete, Betriebskosten та Heizkosten.';
  for (const input of ['900', 'Kaltmiete', 'Betriebskosten 150', 'Heizkosten 100']) {
    previous = telegramTextStyle(replyFor({ text: input, replyToText: previous })).text;
    assert.match(previous, /^Jobcenter-погодження житла — Kiel, 3-4 кімнати\./u);
  }
  assert.match(previous, /Зібрано: Kaltmiete 900 €; Betriebskosten 150 €; Heizkosten 100 €/u);
  assert.match(previous, /Вкажіть кількість осіб/u);
});

test('private greeting sends the new brand and Telegram entities while keeping its keyboard', async () => {
  const env = {
    TELEGRAM_RELEASE_APPROVED: 'pilot-v1', TELEGRAM_PILOT_MODE: 'allowlist', TELEGRAM_ALLOWED_CHAT_IDS: '321',
    TELEGRAM_BOT_TOKEN: '123456789:' + 'A'.repeat(35), TELEGRAM_WEBHOOK_SECRET: 'B'.repeat(40),
    TELEGRAM_INGRESS_ENABLED: 'true', TELEGRAM_DELIVERY_ENABLED: 'false'
  };
  let payload;
  const result = await sendStatelessPilotReply({ chatId: 321, text: '/start' }, env, async (url, options) => {
    assert.match(url, /\/sendMessage$/);
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 55, chat: { id: 321 } } }));
  });
  assert.equal(result.status, 'sent');
  assert.equal(payload.text, replyFor({ text: '/start' }));
  assert.doesNotMatch(payload.text, /Zaskaleta Info/);
  assert.ok(payload.entities.some(e => payload.text.slice(e.offset, e.offset + e.length) === BOT_DISPLAY_NAME));
  assert.ok(payload.reply_markup.keyboard.length);
  assert.equal(payload.parse_mode, undefined);
});

test('dense messages produce bounded non-overlapping formatting without deleting content', () => {
  const text = 'Вартість\n' + 'Kaltmiete 900 €\n'.repeat(150);
  const styled = telegramTextStyle(text);
  assert.equal(styled.text, text);
  assert.ok(styled.entities.length <= 60);
  for (const [i, e] of styled.entities.entries()) {
    if (i) assert.ok(styled.entities[i - 1].offset + styled.entities[i - 1].length <= e.offset);
  }
});
