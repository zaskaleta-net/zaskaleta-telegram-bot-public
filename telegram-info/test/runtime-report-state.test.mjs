import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './runtime-fixture.mjs';

test('private bug report flow accepts the next message without Telegram reply state', async () => {
  const f = await fixture();
  try {
    const prompt = await f.send('/report');
    assert.equal(prompt.body.mode, 'pilot-report-prompt');
    assert.match(prompt.last.text, /Відповісти.*не потрібно/u);
    assert.notEqual(prompt.last.reply_markup?.force_reply, true);

    const submission = await f.send('Після натискання кнопки нічого не сталося');
    assert.equal(submission.body.mode, 'pilot-report-submit');
    assert.equal(submission.body.delivered || submission.body.queued, true);
    assert.equal(
      f.calls.some(call => call.method === 'sendMessage' && /Дякуємо/u.test(String(call.body?.text || ''))),
      true
    );
  } finally {
    f.close();
  }
});

test('/start cancels pending report mode and strips stale report reply context', async () => {
  const f = await fixture();
  try {
    await f.send('/report');
    const stalePrompt = {
      message_id:42,
      date:Math.floor((Date.UTC(2026,8,13,8,0,0))/1000),
      chat:{ id:777777777, type:'private' },
      from:{ id:999999999, is_bot:true, username:'ZaskaletaInfoBot' },
      text:'🐞 Повідомлення про помилку\n\nНадішліть скріншот'
    };

    const start = await f.send('/start', { previous:stalePrompt });
    assert.notEqual(start.body.mode, 'pilot-report-submit');
    assert.ok(f.calls.some(call => call.method === 'deleteMessage' && call.body?.chat_id === 777777777 && call.body?.message_id === 42));

    const ordinary = await f.send('дякую');
    assert.notEqual(ordinary.body.mode, 'pilot-report-submit');
  } finally {
    f.close();
  }
});
