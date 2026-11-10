import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW, USER, SECRET, json } from './runtime-fixture.mjs';
import runtime, { handle } from '../src/runtime.mjs';
import { aiCardButtonTransport, AI_LETTER_CALLBACK, AI_LETTER_BUTTON_TEXT, SCANNER_PROMPT, PREMIUM_PAYLOAD } from '../src/ai-commands.mjs';
import { AI_MODEL, SYSTEM_INSTRUCTION, LETTER_HEADER, SCAN_HEADER, AI_ANSWER_HEADER, generate, listingFromCard } from '../src/ai-assistant.mjs';
import { handleAiStateStorage, AI_STATE_PATH } from '../src/ai-state.mjs';
import { forgetKeys } from '../src/forget-command.mjs';
import { handleRetentionSweepStorage, RETENTION_SWEEP_PATH } from '../src/retention-sweep.mjs';
import { BRANDED_BOT_COMMANDS } from '../src/bot-command-sync.mjs';
import { privacyPolicyHtml } from '../src/privacy-policy.mjs';

// TG-RUNTIME-047: the AI module (owner request 18.10.2026): a letter to the
// landlord under every listing card, /scanner for official letters, an AI
// answer for questions the menu cannot route, /premium via Telegram Stars.

const CARD = [
  '🏠 1/3 · Helle 3-Zimmer-Wohnung mit Balkon',
  '💶 943,80 € · Warmmiete',
  '📍 Trittau',
  '🛏 3 кімн.',
  '📐 72 м²',
  'Джерело: Kleinanzeigen',
  '',
  '⚠️ Це кандидат для перевірки, не Zusicherung.',
  'Ціна з оголошення не підтверджує відповідність Bruttokaltmiete; Nebenkosten потрібно перевіряти окремо.'
].join('\n');

const CARD_MARKUP = { inline_keyboard:[[{ text:'🔗 Відкрити оголошення', url:'https://www.kleinanzeigen.de/s-anzeige/x/1234567' }], [{ text:AI_LETTER_BUTTON_TEXT, callback_data:AI_LETTER_CALLBACK }]] };

function fakeAi(reply = 'Sehr geehrte Damen und Herren,\n\nich interessiere mich für Ihre Wohnung.\n\nMit freundlichen Grüßen\n[Vor- und Nachname]') {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (typeof reply === 'function') return reply(model, input);
      if (reply instanceof Error) throw reply;
      return { response:reply };
    }
  };
}

async function aiFixture(overrides = {}) {
  const ai = overrides.AI || fakeAi();
  const f = await fixture({ AI_ASSISTANT_ENABLED:'true', AI:ai, ...overrides });
  return { ...f, ai };
}

const sent = (f, before = 0) => f.calls.slice(before).filter(call => call.method === 'sendMessage');

function rawUpdate(message, id) {
  return new Request('https://fixture.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
    body:JSON.stringify({ update_id:id, ...message })
  });
}

let ids = 5000;
function privateMessage(fields) {
  const id = ++ids;
  return { id, message:{ message_id:id, date:NOW / 1000, chat:{ id:USER, type:'private' }, from:{ id:USER, is_bot:false }, ...fields } };
}

// The button pressed on a message: by default a listing card.
async function press(f, { text = CARD, markup = CARD_MARKUP } = {}) {
  const id = ++ids;
  const before = f.calls.length;
  const update = { callback_query:{ id:`query-${id}`, from:{ id:USER, is_bot:false }, data:AI_LETTER_CALLBACK, message:{ message_id:id, date:NOW / 1000, chat:{ id:USER, type:'private' }, text, reply_markup:markup } } };
  const response = await handle(rawUpdate(update, id), f.env, NOW, f.transport);
  const body = await response.json();
  return { body, last:sent(f, before).at(-1)?.body };
}

// --- Card button --------------------------------------------------------------

test('#047 every private listing card gets the AI letter button under its own buttons', async () => {
  const seen = [];
  const transport = aiCardButtonTransport(async (url, options) => { seen.push(JSON.parse(options.body)); return json({ ok:true }); }, { AI_ASSISTANT_ENABLED:'true' });
  const card = { inline_keyboard:[[{ text:'🔗 Відкрити оголошення', url:'https://www.kleinanzeigen.de/s-anzeige/x/1234567' }], [{ text:'🏛 Перевірити під Jobcenter', callback_data:'jc:1234567:u7' }], [{ text:'➡️ Далі', callback_data:'jcn:l:5:u7' }]] };
  await transport('https://api.telegram.org/bot1:x/sendMessage', { method:'POST', body:JSON.stringify({ chat_id:USER, text:'card', reply_markup:card }) });
  assert.deepEqual(seen[0].reply_markup.inline_keyboard.map(row => row.map(button => button.text)), [
    ['🔗 Відкрити оголошення'], ['🏛 Перевірити під Jobcenter'], [AI_LETTER_BUTTON_TEXT], ['➡️ Далі']
  ]);
  assert.equal(seen[0].reply_markup.inline_keyboard[2][0].callback_data, AI_LETTER_CALLBACK);
});

test('#047 the button is added to photo cards (multipart) and never twice', async () => {
  const forms = [];
  const transport = aiCardButtonTransport(async (url, options) => { forms.push(options.body); return json({ ok:true }); }, { AI_ASSISTANT_ENABLED:'true' });
  const form = new FormData();
  form.append('chat_id', String(USER));
  form.append('photo', new Blob([new Uint8Array([1, 2, 3])], { type:'image/jpeg' }), 'listing-1.jpg');
  form.append('reply_markup', JSON.stringify({ inline_keyboard:[[{ text:'🔗 Відкрити оголошення', url:'https://www.kleinanzeigen.de/s-anzeige/x/1' }]] }));
  await transport('https://api.telegram.org/bot1:x/sendPhoto', { method:'POST', body:form });
  const markup = JSON.parse(forms[0].get('reply_markup'));
  assert.equal(markup.inline_keyboard[1][0].callback_data, AI_LETTER_CALLBACK);
  assert.equal(forms[0].get('photo').name, 'listing-1.jpg', 'the photo survives');
  await transport('https://api.telegram.org/bot1:x/sendPhoto', { method:'POST', body:forms[0] });
  assert.equal(JSON.parse(forms[1].get('reply_markup')).inline_keyboard.length, 2, 'no second AI row');
});

test('#047 no button when the AI is off, in groups, or on a message with several listings', async () => {
  const card = { inline_keyboard:[[{ text:'🔗 Відкрити оголошення', url:'https://www.kleinanzeigen.de/s-anzeige/x/1' }]] };
  const two = { inline_keyboard:[[{ text:'🔗 Відкрити оголошення', url:'https://a.example/1' }], [{ text:'🔗 Відкрити оголошення', url:'https://a.example/2' }]] };
  for (const [env, chat, markup] of [[{}, USER, card], [{ AI_ASSISTANT_ENABLED:'true' }, -100123, card], [{ AI_ASSISTANT_ENABLED:'true' }, USER, two]]) {
    let body;
    const transport = aiCardButtonTransport(async (url, options) => { body = JSON.parse(options.body); return json({ ok:true }); }, env);
    await transport('https://api.telegram.org/bot1:x/sendMessage', { method:'POST', body:JSON.stringify({ chat_id:chat, text:'x', reply_markup:markup }) });
    assert.deepEqual(body.reply_markup, markup);
  }
});

// --- Landlord letter ------------------------------------------------------------

test('#047 the letter button answers with a German draft built only from the card', async () => {
  const f = await aiFixture();
  try {
    const result = await press(f);
    assert.equal(result.body.mode, 'ai-letter-v1', JSON.stringify(result.body));
    assert.equal(result.body.source, 'ai');
    const reply = result.last.text;
    assert.ok(reply.startsWith(LETTER_HEADER), reply);
    assert.match(reply, /Sehr geehrte Damen und Herren/u);
    assert.match(reply, /не підтверджує, що квартира відповідає нормам Jobcenter/u);
    assert.ok(f.calls.some(call => call.method === 'answerCallbackQuery'), 'the spinner ends');
    const prompt = f.ai.calls[0].input.messages.at(-1).content;
    assert.equal(f.ai.calls[0].model, AI_MODEL);
    assert.match(prompt, /943,80 €/u);
    assert.match(prompt, /Trittau/u);
    assert.doesNotMatch(prompt, /https?:\/\/|Zusicherung|Джерело/u, 'no links or bot warnings go to the model');
    assert.match(f.ai.calls[0].input.messages[0].content, /Behaupte NICHT, dass die Wohnung den Richtwerten des Jobcenters entspricht/u);
  } finally { f.close(); }
});

test('#047 the same card twice is answered from the cache without a second model call or quota', async () => {
  const f = await aiFixture({ AI_FREE_DAILY_LIMIT:'1' });
  try {
    await press(f);
    const again = await press(f);
    assert.equal(again.body.source, 'cache');
    assert.equal(f.ai.calls.length, 1);
  } finally { f.close(); }
});

test('#047 without the model, or over the limit, the button still gives a template letter', async () => {
  const down = await aiFixture({ AI:fakeAi(new Error('down')) });
  try {
    const result = await press(down);
    assert.equal(result.body.source, 'template');
    assert.match(result.last.text, /Helle 3-Zimmer-Wohnung mit Balkon/u);
    assert.match(result.last.text, /schriftliches Mietangebot/u);
  } finally { down.close(); }
  const limited = await aiFixture({ AI_FREE_DAILY_LIMIT:'0' });
  try {
    const result = await press(limited);
    assert.equal(result.body.source, 'template');
    assert.match(result.last.text, /денний ліміт ШІ вичерпано/u);
    assert.equal(limited.ai.calls.length, 0);
  } finally { limited.close(); }
});

test('#047 the slow AI paths answer after the webhook returns, so the update queue is not held', async () => {
  const f = await aiFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = f.transport;
  try {
    const pending = [];
    const ctx = { waitUntil(promise) { pending.push(promise); } };
    const id = ++ids;
    const update = { update_id:id, callback_query:{ id:`query-${id}`, from:{ id:USER, is_bot:false }, data:AI_LETTER_CALLBACK, message:{ message_id:id, date:NOW / 1000, chat:{ id:USER, type:'private' }, text:CARD, reply_markup:CARD_MARKUP } } };
    const response = await runtime.fetch(rawUpdate(update, id).clone(), f.env, ctx);
    assert.equal((await response.json()).mode, 'telegram-ai-background-accepted');
    await Promise.all(pending);
    assert.ok(sent(f).at(-1).body.text.startsWith(LETTER_HEADER));
  } finally { globalThis.fetch = originalFetch; f.close(); }
});

test('#047 review: the letter button on anything but a listing card does not reach the model', async () => {
  const f = await aiFixture();
  try {
    const result = await press(f, { text:'🔎 Розбір листа (ШІ)\n\nJobcenter Stormarn, Frist 31.10.', markup:{ inline_keyboard:[[{ text:AI_LETTER_BUTTON_TEXT, callback_data:AI_LETTER_CALLBACK }]] } });
    assert.equal(result.body.source, 'no_card');
    assert.equal(f.ai.calls.length, 0);
    assert.equal([...f.data.keys()].some(key => key.startsWith('telegram-ai-cache:v1:')), false);
  } finally { f.close(); }
});

// --- Free-text questions ----------------------------------------------------------

test('#047 a question the menu cannot route gets an AI answer instead of the fallback', async () => {
  const f = await aiFixture({ AI:fakeAi('Зверніться до Hausarzt (сімейного лікаря).') });
  try {
    const result = await f.send('Як мені записатися до лікаря?');
    assert.ok(result.last.text.startsWith(AI_ANSWER_HEADER), result.last.text);
    assert.match(result.last.text, /Hausarzt/u);
    assert.match(result.last.text, /\/beratung/u);
    assert.doesNotMatch(result.last.text, /Не вдалося однозначно зрозуміти/u);
    assert.equal(f.ai.calls[0].input.messages[0].content, SYSTEM_INSTRUCTION);
  } finally { f.close(); }
});

test('#047 menu routing is unchanged: housing text, typos and the AI-off bot keep their replies', async () => {
  const f = await aiFixture();
  try {
    const housing = await f.send('Шукаю житло в Trittau');
    assert.match(housing.last.text, /Trittau/u);
    const typo = await f.send('Trittaau');
    assert.doesNotMatch(String(typo.last?.text || ''), new RegExp(AI_ANSWER_HEADER), 'a single word is not sent to the model');
    assert.equal(f.ai.calls.length, 0);
  } finally { f.close(); }
  const off = await fixture({ AI:fakeAi() });
  try {
    const result = await off.send('Як мені записатися до лікаря?');
    assert.match(result.last.text, /^Не вдалося однозначно зрозуміти запит\./u);
  } finally { off.close(); }
});

test('#047 the daily limit holds, cached general questions do not count, failures give the unit back', async () => {
  const f = await aiFixture({ AI_FREE_DAILY_LIMIT:'2' });
  try {
    await f.send('Що таке Anmeldung у Bürgeramt?');
    await f.send('Що таке Anmeldung у Bürgeramt?');
    assert.equal(f.ai.calls.length, 1, 'the second, identical question came from the cache');
    await f.send('Скільки коштує квиток 49 євро для дитини?');
    const over = await f.send('Що робити, якщо 2 дні болить зуб?');
    assert.match(over.last.text, /Безкоштовний денний ліміт ШІ вичерпано \(2 запити\)/u);
    assert.match(over.last.text, /працюють без ШІ: \/menu/u, 'TG-RUNTIME-054: the limit is no dead end');
    assert.equal(f.ai.calls.length, 2);
  } finally { f.close(); }
  const failing = await aiFixture({ AI:fakeAi(new Error('down')), AI_FREE_DAILY_LIMIT:'1' });
  try {
    await failing.send('Скільки коштує квиток 49 євро?');
    await failing.send('Скільки коштує квиток 49 євро для дитини?');
    assert.equal(failing.ai.calls.length, 2, 'a failed call did not use up the only unit');
  } finally { failing.close(); }
});

test('#047 questions with digits or a name are not cached; the cache holds no personal case', async () => {
  const f = await aiFixture();
  try {
    await f.send('Мій Bescheid від 12.10 — що робити?');
    await f.send('Мій чоловік Oleh Petrenko не має Aufenthaltstitel, що робити?');
    assert.equal([...f.data.keys()].some(key => key.startsWith('telegram-ai-cache:v1:')), false);
  } finally { f.close(); }
});

// --- Scanner ----------------------------------------------------------------------

function photoTransport(f, { bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), path = 'photos/file_1.jpg' } = {}) {
  return async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/getFile')) {
      f.calls.push({ method:'getFile', body:JSON.parse(options.body) });
      return json({ ok:true, result:{ file_id:'big', file_path:path, file_size:bytes.length } });
    }
    if (target.startsWith('https://api.telegram.org/file/bot')) {
      f.calls.push({ method:'file', body:{} });
      return new Response(bytes, { status:200 });
    }
    return f.transport(url, options);
  };
}

test('#047 /scanner, then a photo: the largest photo goes to Workers AI and the answer has the warning', async () => {
  const f = await aiFixture({ AI:fakeAi('1. Jobcenter Stormarn — Bescheid.\n4. Frist: 31.10.2026 — перевірте в оригіналі листа.') });
  try {
    const prompt = await f.send('/scanner');
    assert.equal(prompt.last.text, SCANNER_PROMPT);
    const photo = privateMessage({ photo:[{ file_id:'small', width:90, height:90, file_size:900 }, { file_id:'big', width:1280, height:960, file_size:180000 }, { file_id:'huge', width:2560, height:1920, file_size:3000000 }] });
    const response = await handle(rawUpdate({ message:photo.message }, photo.id), f.env, NOW, photoTransport(f));
    const body = await response.json();
    assert.equal(body.mode, 'ai-scan-v1', JSON.stringify(body));
    assert.equal(f.calls.find(call => call.method === 'getFile').body.file_id, 'big', 'the largest photo under 1.5 MB');
    const content = f.ai.calls[0].input.messages.at(-1).content;
    assert.equal(content[1].type, 'image_url');
    assert.match(content[1].image_url.url, /^data:image\/jpeg;base64,/u);
    const reply = sent(f).at(-1).body.text;
    assert.ok(reply.startsWith(SCAN_HEADER), reply);
    assert.match(reply, /Перевірте точні дані в оригіналі вашого листа/u);
    assert.match(reply, /\/beratung/u);
    assert.equal([...f.data.keys()].some(key => key.startsWith('telegram-ai-cache:v1:')), false, 'a letter is never cached');
    assert.equal([...f.data.keys()].some(key => key.startsWith('telegram-private-prompt:v1:')), false, 'the prompt is used up');
  } finally { f.close(); }
});

test('#047 the text of a letter after /scanner is analysed with the scan rules', async () => {
  const f = await aiFixture({ AI:fakeAi('Розбір.') });
  try {
    await f.send('/scanner');
    const result = await f.send('Sehr geehrte Frau K., hiermit fordern wir Sie auf, bis zum 30.10. Unterlagen einzureichen.');
    assert.equal(result.body.mode, 'ai-scan-v1', JSON.stringify(result.body));
    const prompt = f.ai.calls[0].input.messages.at(-1).content;
    assert.match(prompt, /Строки \(Frist\)/u);
    assert.match(prompt, /Unterlagen einzureichen/u);
  } finally { f.close(); }
});

test('#047 a photo without /scanner is not sent to the model; a PDF gets a clear notice', async () => {
  const f = await aiFixture();
  try {
    const photo = privateMessage({ photo:[{ file_id:'p', width:800, height:600, file_size:50000 }] });
    await handle(rawUpdate({ message:photo.message }, photo.id), f.env, NOW, photoTransport(f));
    assert.equal(f.ai.calls.length, 0);
    assert.equal(f.calls.some(call => call.method === 'getFile'), false);
    await f.send('/scanner');
    const pdf = privateMessage({ document:{ file_id:'d', mime_type:'application/pdf', file_size:20000 } });
    const response = await handle(rawUpdate({ message:pdf.message }, pdf.id), f.env, NOW, photoTransport(f));
    assert.equal((await response.json()).source, 'not_image');
    assert.match(sent(f).at(-1).body.text, /PDF-файли не підтримуються/u);
    assert.equal(f.ai.calls.length, 0);
  } finally { f.close(); }
});

// --- Premium ----------------------------------------------------------------------

test('#047 /premium before payments are open explains the free tier and sends no invoice', async () => {
  const f = await aiFixture();
  try {
    const result = await f.send('/premium');
    assert.match(result.last.text, /Оплата Premium ще не відкрита/u);
    assert.equal(f.calls.some(call => call.method === 'sendInvoice'), false);
  } finally { f.close(); }
});

test('#047 /premium sends a 250 Stars invoice; pre-checkout is validated; payment grants 30 days once', async () => {
  const f = await aiFixture({ AI_PREMIUM_ENABLED:'true', AI_FREE_DAILY_LIMIT:'0' });
  try {
    await f.send('/premium');
    const invoice = f.calls.find(call => call.method === 'sendInvoice').body;
    assert.equal(invoice.currency, 'XTR');
    assert.equal(invoice.provider_token, '');
    assert.deepEqual(invoice.prices, [{ label:'Premium 30 днів', amount:250 }]);
    assert.equal(invoice.payload, PREMIUM_PAYLOAD);

    for (const [amount, ok] of [[250, true], [1, false]]) {
      const id = ++ids;
      await handle(rawUpdate({ pre_checkout_query:{ id:`pcq-${id}`, from:{ id:USER, is_bot:false }, currency:'XTR', total_amount:amount, invoice_payload:PREMIUM_PAYLOAD } }, id), f.env, NOW, f.transport);
      assert.equal(f.calls.filter(call => call.method === 'answerPreCheckoutQuery').at(-1).body.ok, ok, `amount ${amount}`);
    }

    const payment = { currency:'XTR', total_amount:250, invoice_payload:PREMIUM_PAYLOAD, telegram_payment_charge_id:'charge_1' };
    for (let index = 0; index < 2; index++) {
      const paid = privateMessage({ successful_payment:payment });
      await handle(rawUpdate({ message:paid.message }, paid.id), f.env, NOW, f.transport);
    }
    assert.match(sent(f).at(-1).body.text, /Premium активовано до 15\.10\.2026/u);
    const record = f.data.get(`telegram-ai-premium:v1:${USER}:${USER}`);
    assert.equal(record.until, NOW + 30 * 24 * 60 * 60 * 1000, 'one charge extends once');

    const question = await f.send('Як мені записатися до лікаря?');
    assert.ok(question.last.text.startsWith(AI_ANSWER_HEADER), 'Premium lifts the free limit');
  } finally { f.close(); }
});

test('#047 /forget deletes the AI counter and the Premium record', () => {
  const keys = forgetKeys(USER, USER);
  assert.ok(keys.includes(`telegram-ai-usage:v1:${USER}:${USER}`));
  assert.ok(keys.includes(`telegram-ai-premium:v1:${USER}:${USER}`));
});

// --- Providers, state, texts --------------------------------------------------------

test('#047 external providers are used only when enabled, only for text, and a 429 moves on', async () => {
  const urls = [];
  const transport = async url => {
    urls.push(String(url));
    if (/groq/u.test(String(url))) return new Response('{}', { status:429 });
    return json({ choices:[{ message:{ content:'Відповідь.' } }] });
  };
  const env = { AI:fakeAi(new Error('down')), GROQ_API_KEY:'k1', GEMINI_API_KEY:'k3', AI_GROQ_ENABLED:'true' };
  assert.equal((await generate(env, { system:'s', user:'u' }, transport)).status, 'unavailable', 'off by default');
  assert.equal(urls.length, 0);
  const on = { ...env, AI_EXTERNAL_ENABLED:'true' };
  const result = await generate(on, { system:'s', user:'u' }, transport);
  assert.equal(result.status, 'rate_limited', 'TG-RUNTIME-054: no paid provider after Groq');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/api\.groq\.com\//u);
  assert.equal(urls.some(url => /github/u.test(url)), false, 'GitHub Models is retired');
  urls.length = 0;
  assert.equal((await generate(on, { system:'s', user:'u', imageDataUrl:'data:image/jpeg;base64,AA==' }, transport)).status, 'unavailable');
  assert.equal(urls.length, 0, 'a photo never leaves Workers AI');
});

test('#047 the system instruction fixes the RDG and privacy rules; the model is not Llama 4', () => {
  assert.match(SYSTEM_INSTRUCTION, /не надаєш індивідуальної правової допомоги/u);
  assert.match(SYSTEM_INSTRUCTION, /\/beratung/u);
  assert.match(SYSTEM_INSTRUCTION, /MBE/u);
  assert.match(SYSTEM_INSTRUCTION, /JMD/u);
  assert.match(SYSTEM_INSTRUCTION, /Kundennummer/u);
  assert.match(SYSTEM_INSTRUCTION, /Не можу це підтвердити/u);
  assert.match(SYSTEM_INSTRUCTION, /українською/u);
  assert.doesNotMatch(AI_MODEL, /llama-4/iu);
});

test('#047 the state object rejects bad operations and enforces the global limit', async () => {
  const data = new Map();
  const outbox = { householdContextStorage:{ async get(key) { return structuredClone(data.get(key)); }, async put(key, value) { data.set(key, structuredClone(value)); }, async delete(key) { return data.delete(key); } } };
  const call = async body => (await handleAiStateStorage(new Request(`https://outbox.internal${AI_STATE_PATH}`, { method:'POST', body:JSON.stringify({ now:NOW, ...body }) }), outbox)).json();
  assert.equal((await call({ op:'consume', chatId:-5, userId:-5 })).status, 'bad_operation');
  assert.equal((await call({ op:'cache-put', key:'not-a-hash', text:'x' })).status, 'bad_operation');
  assert.equal((await call({ op:'premium-grant', chatId:1, userId:1, chargeId:'bad id!' })).status, 'bad_operation');
  assert.equal((await call({ op:'consume', chatId:1, userId:1, freeLimit:5, globalLimit:1 })).allowed, true);
  const second = await call({ op:'consume', chatId:2, userId:2, freeLimit:5, globalLimit:1 });
  assert.deepEqual([second.allowed, second.reason], [false, 'global_limit']);
});

test('#047 commands, card helper and the privacy policy describe the module', () => {
  const names = BRANDED_BOT_COMMANDS.map(item => item.command);
  assert.ok(names.includes('scanner') && names.includes('premium'));
  assert.equal(listingFromCard(CARD).includes('Zusicherung'), false);
  const html = privacyPolicyHtml({ name:'A B', address:'Str. 1, 00000 Musterstadt', email:'a@example.org' });
  assert.match(html, /KI-Assistent/u);
  assert.match(html, /Mistral Small 3\.1/u);
  assert.match(html, /Telegram Stars/u);
  assert.match(html, /Cloudflare, Inc\. ist nach dem EU-US Data Privacy Framework zertifiziert/u);
  assert.match(html, /werden nie an Groq übermittelt/u);
  assert.match(html, /ersatzweise an Groq, Inc\. \(USA\) übermittelt werden/u);
  assert.match(html, /für Supabase und Groq gelten die Standardvertragsklauseln/u);
  assert.doesNotMatch(html, /Mistral AI|Gemini/u, 'TG-RUNTIME-054: only providers the bot can use are named');
  // TG-RUNTIME-066: Google appears only in the paragraphs on the Google search
  // buttons (the device opens google.com), never as a processor of the bot.
  const withoutSearchButtons = html.replace(/<p>Einige Schaltflächen öffnen eine Google-Suche[^<]*<\/p>/u, '').replace(/<p>Деякі кнопки відкривають пошук оголошень у Google[^<]*<\/p>/u, '');
  assert.doesNotMatch(withoutSearchButtons, /Google/u, 'TG-RUNTIME-054: only providers the bot can use are named');
  assert.doesNotMatch(html, /GitHub Models/u);
});

test('#047 review: inside a housing step the retry prompt is not replaced by an AI answer', async () => {
  const { aiFreeTextTransport } = await import('../src/ai-commands.mjs');
  const fallback = 'Не вдалося однозначно зрозуміти запит.\n\nНапишіть коротко тему та що саме потрібно або відкрийте /menu.';
  for (const [pending, replaced] of [[true, false], [false, true]]) {
    const f = await aiFixture();
    try {
      if (pending) f.data.set(`housing-cost-active:v14:${USER}`, { prompt:'Тема: житло. Вкажіть місто або район.', updatedAt:NOW });
      const seen = [];
      const transport = await aiFreeTextTransport(f.request('Я не знаю, яке місто мені краще обрати'), f.env, NOW, async (url, options) => { seen.push(JSON.parse(options.body).text); return json({ ok:true }); });
      await transport('https://api.telegram.org/bot1:x/sendMessage', { method:'POST', body:JSON.stringify({ chat_id:USER, text:fallback }) });
      assert.equal(seen[0].startsWith(AI_ANSWER_HEADER), replaced, `housing step pending=${pending}`);
      assert.equal(f.ai.calls.length, replaced ? 1 : 0);
    } finally { f.close(); }
  }
});

test('#047 review: a payment is granted even while maintenance answers everyone else', async () => {
  const f = await aiFixture({ AI_PREMIUM_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'true' });
  try {
    const other = 888888888;
    const id = ++ids;
    const message = { message_id:id, date:NOW / 1000, chat:{ id:other, type:'private' }, from:{ id:other, is_bot:false }, successful_payment:{ currency:'XTR', total_amount:250, invoice_payload:PREMIUM_PAYLOAD, telegram_payment_charge_id:'charge_m' } };
    const response = await handle(rawUpdate({ message }, id), f.env, NOW, f.transport);
    assert.equal((await response.json()).source, 'granted');
    assert.ok(f.data.get(`telegram-ai-premium:v1:${other}:${other}`)?.until > NOW);
  } finally { f.close(); }
});

test('#047 review: the hourly sweep deletes expired cache entries', async () => {
  const data = new Map([
    ['telegram-ai-cache:v1:' + 'a'.repeat(64), { text:'old', expiresAt:NOW - 1 }],
    ['telegram-ai-cache:v1:' + 'b'.repeat(64), { text:'fresh', expiresAt:NOW + 1000 }]
  ]);
  const storage = {
    async list({ prefix }) { return new Map([...data].filter(([key]) => key.startsWith(prefix))); },
    async delete(keys) { let n = 0; for (const key of [].concat(keys)) n += data.delete(key) ? 1 : 0; return n; },
    async get(key) { return data.get(key); },
    async put(key, value) { data.set(key, value); }
  };
  const response = await handleRetentionSweepStorage(new Request(`https://outbox.internal${RETENTION_SWEEP_PATH}`, { method:'POST', body:JSON.stringify({ now:NOW }) }), { householdContextStorage:storage });
  assert.equal((await response.json()).status, 'ok');
  assert.deepEqual([...data.keys()].filter(key => key.startsWith('telegram-ai-cache:v1:')), ['telegram-ai-cache:v1:' + 'b'.repeat(64)]);
});

test('#047 review: a pasted letter never goes to an external provider', async () => {
  const urls = [];
  const { scanLetter } = await import('../src/ai-assistant.mjs');
  const env = { AI:fakeAi(new Error('down')), AI_EXTERNAL_ENABLED:'true', GROQ_API_KEY:'k1' };
  const result = await scanLetter(env, { text:'Sehr geehrte Frau K., Ihr Bescheid …' }, async url => { urls.push(String(url)); return json({}); });
  assert.equal(result.status, 'unavailable');
  assert.equal(urls.length, 0);
});

test('#047 review: in allowlist mode a non-pilot user does not reach the model', async () => {
  const f = await aiFixture({ TELEGRAM_ADMIN_USER_IDS:'', TELEGRAM_MAINTENANCE_MODE:'false' });
  try {
    const stranger = 555555555;
    const result = await f.send('Як мені записатися до лікаря?', { user:stranger });
    assert.doesNotMatch(String(result.last?.text || ''), new RegExp(AI_ANSWER_HEADER));
    await f.send('/scanner', { user:stranger });
    assert.equal(f.ai.calls.length, 0);
  } finally { f.close(); }
});

test('#047 qa: the rent-check amount step is never answered by the AI', async () => {
  const f = await aiFixture();
  try {
    for (const text of ['🏠 Житло', 'Trittau', '3-4', '4', 'перевірка оренди']) await f.send(text);
    const step = await f.send('я не знаю скільки там коштує точно');
    assert.match(step.last.text, /^Не вдалося однозначно зрозуміти запит\./u);
    assert.equal(f.ai.calls.length, 0);
  } finally { f.close(); }
});

test('#047 qa: a search summary with a numbered link gets no letter button', async () => {
  let body;
  const transport = aiCardButtonTransport(async (url, options) => { body = JSON.parse(options.body); return json({ ok:true }); }, { AI_ASSISTANT_ENABLED:'true' });
  const summary = { inline_keyboard:[[{ text:'1. Відкрити оголошення', url:'https://www.kleinanzeigen.de/s-anzeige/x/1' }]] };
  await transport('https://api.telegram.org/bot1:x/sendMessage', { method:'POST', body:JSON.stringify({ chat_id:USER, text:'🔎 Пошук автоматично продовжено…', reply_markup:summary }) });
  assert.deepEqual(body.reply_markup, summary);
});

test('#047 qa: with the AI off, /scanner and /premium explain that the AI is off', async () => {
  const f = await fixture({ AI:fakeAi() });
  try {
    for (const command of ['/scanner', '/premium']) {
      const result = await f.send(command);
      assert.match(result.last.text, /ШІ-функції бота .* зараз вимкнені/u, command);
    }
    assert.equal(f.calls.some(call => call.method === 'sendInvoice'), false);
  } finally { f.close(); }
});

test('#048 review: only a short general question may reach an external provider; letters never do', async () => {
  const { answerQuestion } = await import('../src/ai-assistant.mjs');
  const urls = [];
  const transport = async url => { urls.push(String(url)); return json({ choices:[{ message:{ content:'Відповідь.' } }] }); };
  const env = { AI:fakeAi(new Error('down')), AI_EXTERNAL_ENABLED:'true', GEMINI_API_KEY:'k', GROQ_API_KEY:'g' };
  for (const text of [
    'Sehr geehrte Frau K., hiermit fordern wir Sie auf, Unterlagen einzureichen.',
    'Мій Bescheid від 12.10.2026, Steuer-ID 12345678901, що робити?',
    'Мій чоловік Oleh Petrenko не має Aufenthaltstitel, що робити?',
    'Jobcenter просить Kontoauszüge, моя Kundennummer така, що робити?',
    'Що робити? '.repeat(40)
  ]) {
    assert.equal((await answerQuestion(env, text, transport)).status, 'unavailable', text.slice(0, 40));
  }
  assert.equal(urls.length, 0, 'nothing personal left Workers AI');
  const general = await answerQuestion(env, 'Що таке Anmeldung у Bürgeramt?', transport);
  assert.deepEqual([general.status, general.provider], ['ok', 'groq'], 'TG-RUNTIME-050: free Groq before paid Gemini');
});

test('#048 review: a letter pasted without /scanner, as free text, stays inside Workers AI', async () => {
  const f = await aiFixture({ AI:fakeAi(new Error('down')), AI_EXTERNAL_ENABLED:'true', GROQ_API_KEY:'k' });
  try {
    await f.send('Sehr geehrte Frau K., Ihr Antrag auf Bürgergeld vom 01.10. ist unvollständig. Bitte reichen Sie bis 30.10. ein.');
    assert.equal(f.sourceCalls.some(url => /googleapis|groq/u.test(url)), false, f.sourceCalls.join(','));
  } finally { f.close(); }
});

test('#049 review: names written with apostrophes, commas, capitals or initials never leave Workers AI', async () => {
  const { externalSafe } = await import('../src/ai-assistant.mjs');
  for (const text of ["Мій чоловік Дар'я Коваль не має Aufenthaltstitel, що робити?", 'Petrenko, Oleh не має документів', 'OLEH PETRENKO не має документів', 'О. Петренко не має документів', 'Мій чоловік Дарʼя Коваль, що робити?', 'Що сказала Олена про Jobcenter?']) {
    assert.equal(externalSafe(text), false, text);
  }
  for (const text of ['Що таке Anmeldung у Bürgeramt?', 'Як записатися до лікаря?', 'Що таке Kaltmiete?']) assert.equal(externalSafe(text), true, text);
});

test('#049 review: outside Workers AI a landlord letter carries only price, place, rooms and area', async () => {
  const { writeLandlordLetter } = await import('../src/ai-assistant.mjs');
  const bodies = [];
  const transport = async (url, options) => { bodies.push(JSON.parse(options.body)); return json({ choices:[{ message:{ content:'Sehr geehrte Damen und Herren …' } }] }); };
  const env = { AI:fakeAi(new Error('down')), AI_EXTERNAL_ENABLED:'true', GROQ_API_KEY:'k' };
  const card = '🏠 1/3 · Wohnung, Anbieter Max Mustermann Tel 0151 2345678\n💶 943,80 € · Warmmiete\n📍 Trittau\n🛏 3 кімн.\n📐 72 м²';
  assert.equal((await writeLandlordLetter(env, card, transport)).status, 'ok');
  const sentText = bodies[0].messages.at(-1).content;
  assert.match(sentText, /943,80 €/u);
  assert.doesNotMatch(sentText, /Mustermann|0151|Anbieter/u);
  bodies.length = 0;
  assert.equal((await writeLandlordLetter(env, '🏠 1/3 · Wohnung von Max Mustermann', transport)).status, 'unavailable', 'no facts, no external call');
  assert.equal(bodies.length, 0);
});

test('#049 review: all model calls of one request stay inside one time budget', async () => {
  const { generate } = await import('../src/ai-assistant.mjs');
  const urls = [];
  const transport = async url => { urls.push(String(url)); return json({ choices:[{ message:{ content:'x' } }] }); };
  const env = { AI:fakeAi(new Error('down')), AI_EXTERNAL_ENABLED:'true', GROQ_API_KEY:'k' };
  // Workers AI used up the budget: no external call starts after it.
  const times = [0, 21000];
  const clock = () => times.length ? times.shift() : 21000;
  assert.equal((await generate(env, { system:'s', user:'Що таке Kaltmiete?' }, transport, clock)).status, 'unavailable');
  assert.equal(urls.length, 0);
});

test('#049 review 2: non-ASCII digits, other Cyrillic capitals and street addresses are handled', async () => {
  const { externalSafe, listingFacts } = await import('../src/ai-assistant.mjs');
  for (const text of ['Мій номер １７６ ５５５, що робити?', 'Пишіть на olena＠mail', 'Що сказав Ёжиков?']) assert.equal(externalSafe(text), false, text);
  for (const text of ['Чи можна працювати в Німеччині без мови?', 'Як перевезти авто з України?']) assert.equal(externalSafe(text), true, text);
  assert.equal(listingFacts('📍 Musterstraße 5, 22946 Trittau\n💶 650 €'), '📍 22946 Trittau\n💶 650 €');
});

test('#054 only the free Groq fallback is used; Mistral and Gemini keys are ignored', async () => {
  const { generate } = await import('../src/ai-assistant.mjs');
  const urls = [];
  const transport = async url => { urls.push(String(url)); return json({ choices:[{ message:{ content:'Відповідь.' } }] }); };
  const keys = { MISTRAL_API_KEY:'m', AI_MISTRAL_TRAINING_OFF:'true', GEMINI_API_KEY:'k' };
  const env = { AI:fakeAi(new Error('down')), AI_EXTERNAL_ENABLED:'true', ...keys };
  assert.equal((await generate(env, { system:'s', user:'u' }, transport)).status, 'unavailable');
  assert.equal(urls.length, 0);
  const result = await generate({ ...env, GROQ_API_KEY:'g' }, { system:'s', user:'u' }, transport);
  assert.deepEqual([result.status, result.provider], ['ok', 'groq']);
  assert.deepEqual(urls.map(url => new URL(url).host), ['api.groq.com']);
});

test('#050 news are translated with the AI module model, not Llama 4', async () => {
  const { LLM_TRANSLATION_MODEL } = await import('../src/news-translation.mjs');
  assert.equal(LLM_TRANSLATION_MODEL, AI_MODEL);
  assert.doesNotMatch(LLM_TRANSLATION_MODEL, /llama-4/iu);
});

test('#050 review: Mistral is skipped until the owner confirms the training opt-out', async () => {
  const { generate } = await import('../src/ai-assistant.mjs');
  const urls = [];
  const transport = async url => { urls.push(String(url)); return json({ choices:[{ message:{ content:'x' } }] }); };
  const env = { AI:fakeAi(new Error('down')), AI_EXTERNAL_ENABLED:'true', MISTRAL_API_KEY:'m' };
  assert.equal((await generate(env, { system:'s', user:'u' }, transport)).status, 'unavailable');
  assert.equal(urls.length, 0);
});

test('#050 review: a "Переклад:" prefix from the model is not published', async () => {
  const { cleanTranslation } = await import('../src/news-translation.mjs');
  assert.equal(cleanTranslation('Ось переклад: Новий розклад поїздів'), 'Новий розклад поїздів');
  assert.equal(cleanTranslation('Переклад українською — Новий розклад поїздів'), 'Новий розклад поїздів');
  assert.equal(cleanTranslation('Переклад документів для біженців тепер безкоштовний'), 'Переклад документів для біженців тепер безкоштовний');
  assert.equal(cleanTranslation('Translation services for Ukrainians in Kiel'), 'Translation services for Ukrainians in Kiel');
});
