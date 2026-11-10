import test from 'node:test';
import assert from 'node:assert/strict';
import { aiCardButtonTransport, AI_LETTER_CALLBACK } from '../src/ai-commands.mjs';

// TG-RUNTIME-052: with separate text cards the last card reuses the search
// keyboard, whose link reads "5. Відкрити оголошення", so it got no letter
// button (QA finding A of TG-RUNTIME-047). A card is now told by its price
// line ("💶 …") plus exactly one listing link; a search summary has no 💶 line.

const USER = 777;
const json = value => new Response(JSON.stringify(value), { status:200, headers:{ 'content-type':'application/json' } });

async function sentMarkup(text, markup) {
  let body;
  const transport = aiCardButtonTransport(async (url, options) => { body = JSON.parse(options.body); return json({ ok:true }); }, { AI_ASSISTANT_ENABLED:'true' });
  await transport('https://api.telegram.org/bot1:x/sendMessage', { method:'POST', body:JSON.stringify({ chat_id:USER, text, reply_markup:markup }) });
  return body.reply_markup;
}

test('#052 the last text card with a numbered link gets the letter button', async () => {
  const card = '5. Helle Wohnung\n💶 650,00 € Warmmiete · Trittau\n🛏 3 кімн. · 📐 70 м²';
  const markup = { inline_keyboard:[[{ text:'5. Відкрити оголошення', url:'https://www.kleinanzeigen.de/s-anzeige/x/5' }], [{ text:'➡️ Ще оголошення', callback_data:'jcn:l:5:u777' }]] };
  const next = await sentMarkup(card, markup);
  assert.ok(next.inline_keyboard.flat().some(button => button.callback_data === AI_LETTER_CALLBACK), JSON.stringify(next));
  assert.equal(next.inline_keyboard.at(-1)[0].text, '➡️ Ще оголошення', 'navigation stays last');
});

test('#052 a search summary with one numbered link still gets no button', async () => {
  const summary = '🔎 Пошук автоматично продовжено…\n\n1. Helle Wohnung\n650 € · Trittau';
  const markup = { inline_keyboard:[[{ text:'1. Відкрити оголошення', url:'https://www.kleinanzeigen.de/s-anzeige/x/1' }]] };
  assert.deepEqual(await sentMarkup(summary, markup), markup);
});

test('#052 a Jobcenter limit line ("💶 Ліміт") is not a listing price', async () => {
  const text = 'Jobcenter Stormarn\n💶 Ліміт: до 943,80 € · Bruttokaltmiete';
  const markup = { inline_keyboard:[[{ text:'1. Відкрити оголошення', url:'https://www.kleinanzeigen.de/s-anzeige/x/1' }]] };
  assert.deepEqual(await sentMarkup(text, markup), markup);
});

test('#052 pressing the letter button on that last card writes the letter', async () => {
  const { fixture, NOW, USER:ME, SECRET } = await import('./runtime-fixture.mjs');
  const { handle } = await import('../src/runtime.mjs');
  const calls = [];
  const f = await fixture({ AI_ASSISTANT_ENABLED:'true', AI:{ async run(model, input) { calls.push(input); return { response:'Sehr geehrte Damen und Herren, …' }; } } });
  try {
    const id = 9001;
    const text = '5. Helle Wohnung\n💶 650,00 € Warmmiete · Trittau\n🛏 3 кімн.';
    const reply_markup = { inline_keyboard:[[{ text:'5. Відкрити оголошення', url:'https://www.kleinanzeigen.de/s-anzeige/x/5' }], [{ text:'🤖 Написати орендодавцю (ШІ)', callback_data:AI_LETTER_CALLBACK }]] };
    const update = { update_id:id, callback_query:{ id:`q-${id}`, from:{ id:ME, is_bot:false }, data:AI_LETTER_CALLBACK, message:{ message_id:id, date:NOW / 1000, chat:{ id:ME, type:'private' }, text, reply_markup } } };
    const request = new Request('https://fixture.example/telegram/stateless', { method:'POST', headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET }, body:JSON.stringify(update) });
    const body = await (await handle(request, f.env, NOW, f.transport)).json();
    assert.equal(body.source, 'ai', JSON.stringify(body));
    assert.match(calls[0].messages.at(-1).content, /650,00 €/u);
  } finally { f.close(); }
});
