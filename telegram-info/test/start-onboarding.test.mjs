import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './runtime-fixture.mjs';

test('/start introduces the bot in four short steps above the main menu', async () => {
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1' });
  try {
    const result = await f.send('/start');
    const text = String(result.last?.text || '');
    assert.match(text, /^Вітаємо!\nSchleswig-Holstein Помічник/u);
    assert.match(text, /Що вміє бот — коротко:\n1️⃣ 🏠 Житло[^\n]+\n2️⃣ 🏛 Jobcenter[^\n]+\n3️⃣ 🤝 Консультації[^\n]+\n4️⃣ 🎉 Куди піти/u);
    assert.match(text, /Не надсилайте паролі/u);
    const callbacks = (result.last?.reply_markup?.inline_keyboard || []).flat().map(button => button.callback_data);
    for (const key of ['nav:housing', 'nav:jobcenter', 'nav:events', 'nav:advice']) assert.ok(callbacks.includes(key), key);
  } finally { f.close(); }
});

test('the legacy /start reply is the same greeting as the fast start', async () => {
  const { replyFor } = await import('../src/worker.mjs');
  const { START_TEXT } = await import('../src/start-text.mjs');
  assert.equal(replyFor({ text:'/start' }), START_TEXT);
  assert.equal(replyFor({ text:'/start@ZaskaletaInfoBot' }), START_TEXT);
  assert.doesNotMatch(START_TEXT, /З чого почнемо/u);
});
