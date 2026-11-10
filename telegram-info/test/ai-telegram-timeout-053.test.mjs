import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW, USER, SECRET } from './runtime-fixture.mjs';
import { handle } from '../src/runtime.mjs';
import { AI_LETTER_CALLBACK } from '../src/ai-commands.mjs';

// TG-RUNTIME-053: the AI paths called Telegram (answerCallbackQuery,
// sendChatAction, getFile, sendMessage) without a time limit. One hanging
// call could hold the background task past its 30 s window, so the user got
// no letter and lost a daily unit (security review of TG-RUNTIME-047, note 3).

test('#053 a hanging Telegram call does not hold the landlord letter', { timeout:15000 }, async () => {
  const f = await fixture({ AI_ASSISTANT_ENABLED:'true', AI:{ async run() { return { response:'Sehr geehrte Damen und Herren, …' }; } } });
  try {
    const transport = (url, options = {}) => {
      if (String(url).endsWith('/sendChatAction')) {
        // Never answers unless aborted.
        return new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return f.transport(url, options);
    };
    const id = 9101;
    const update = { update_id:id, callback_query:{ id:`q-${id}`, from:{ id:USER, is_bot:false }, data:AI_LETTER_CALLBACK, message:{ message_id:id, date:NOW / 1000, chat:{ id:USER, type:'private' }, text:'🏠 1/1 · Wohnung\n💶 650,00 € · Trittau', reply_markup:{ inline_keyboard:[[{ text:'🔗 Відкрити оголошення', url:'https://www.kleinanzeigen.de/s-anzeige/x/1' }]] } } } };
    const request = new Request('https://fixture.example/telegram/stateless', { method:'POST', headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET }, body:JSON.stringify(update) });
    const started = Date.now();
    const body = await (await handle(request, f.env, NOW, transport)).json();
    assert.equal(body.source, 'ai', JSON.stringify(body));
    assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
    assert.ok(f.calls.some(call => call.method === 'sendMessage' && /Sehr geehrte/u.test(call.body.text)), 'the letter is still sent');
  } finally { f.close(); }
});
