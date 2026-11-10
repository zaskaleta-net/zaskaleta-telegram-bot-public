import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW, USER, GROUP } from './runtime-fixture.mjs';
import { handle } from '../src/runtime.mjs';
import { normalizeKeyboardPayload } from '../src/runtime-keyboard.mjs';

function ordinaryInput(messages) {
  assert.ok(messages.length);
  for (const message of messages) {
    assert.notEqual(message.reply_markup?.force_reply, true);
    assert.notEqual(message.reply_markup?.remove_keyboard, true);
    assert.equal(message.reply_markup?.keyboard, undefined);
    assert.ok(message.reply_markup?.inline_keyboard.flat().some(button => button.callback_data === 'nav:menu'));
  }
}

test('video 57220 flow keeps ordinary input from the initial city prompt through Jobcenter search', async () => {
  const f = await fixture();
  try {
    await f.send('/start');
    ordinaryInput((await f.send('🏠 Житло')).messages);
    const city = await f.send("Житло для сім'ї двоє дітей та двоє дорослих у Тріттау");
    ordinaryInput(city.messages);
    assert.match(city.last.text, /Trittau/u);
    assert.match(city.last.text, /Осіб: 4/u);
    const rooms = await f.send('', { callback:'hkr:3-4:Trittau', previous:city.last });
    ordinaryInput(rooms.messages);
    assert.match(rooms.last.text, /Осіб: 4/u);
    const guideline = await f.send('', { callback:'hka:j:4:3-4:Trittau', previous:rooms.last });
    ordinaryInput(guideline.messages);
    const result = await f.send('', { callback:'jcr:15:4:3-4:Trittau', previous:guideline.last });
    ordinaryInput(result.messages);
    const final = result.messages.find(message => /Не вдалося отримати оголошення/u.test(String(message.text || '')));
    assert.ok(final, 'Jobcenter search must finish after the visible progress message');
    assert.match(final.text, /Не вдалося отримати оголошення/u);
    assert.equal(f.env.TELEGRAM_MAINTENANCE_MODE, 'true');
  } finally { f.close(); }
});

test('bare city, rooms and household are retained across unquoted private messages', async () => {
  const f = await fixture();
  try {
    ordinaryInput((await f.send('🏠 Житло')).messages);
    const city = await f.send('Trittau');
    assert.match(city.last.text, /Тема: житло — Trittau/u);
    ordinaryInput(city.messages);
    const rooms = await f.send('3-4');
    assert.match(rooms.last.text, /Кімнат: 3-4/u);
    ordinaryInput(rooms.messages);
    const people = await f.send('4');
    assert.match(people.last.text, /Житло — Trittau, 3-4 кімнати/u);
    assert.match(people.last.text, /Осіб: 4/u);
    ordinaryInput(people.messages);
    const action = await f.send('перевірка оренди');
    assert.match(action.last.text, /Перевірка оренди — Trittau, 3-4 кімнати/u);
    ordinaryInput(action.messages);
    ordinaryInput((await f.send('700')).messages);
    const cost = await f.send('Kaltmiete');
    assert.match(cost.last.text, /700/u);
    ordinaryInput(cost.messages);
  } finally { f.close(); }
});

test('unquoted budget and price type continue the existing housing search dialogue', async () => {
  const f = await fixture();
  try {
    await f.send('Trittau житло для 4 осіб');
    await f.send('3-4');
    const budget = await f.send('пошук житла');
    ordinaryInput(budget.messages);
    assert.match(budget.last.text, /Пошук житла — Trittau, 3-4 кімнати/u);
    const amount = await f.send('900');
    ordinaryInput(amount.messages);
    assert.match(amount.last.text, /900/u);
    const kind = await f.send('Kaltmiete');
    assert.match(kind.last.text, /Trittau/u);
    assert.match(kind.last.text, /900/u);
    assert.match(kind.last.text, /Kaltmiete/u);
    assert.notEqual(kind.last.reply_markup?.force_reply, true);
  } finally { f.close(); }
});

test('video 57229 keeps housing context after a retry prompt so a standalone Kappeln reply is accepted', async () => {
  const f = await fixture();
  try {
    ordinaryInput((await f.send('🏠 Житло')).messages);
    const retry = await f.send("Лек сім'я 3");
    ordinaryInput(retry.messages);
    assert.match(retry.last.text, /Вкажіть місто або район у Schleswig-Holstein/u);

    const city = await f.send('Каппельн');
    ordinaryInput(city.messages);
    assert.match(city.last.text, /Тема: житло — Kappeln/u);
    assert.doesNotMatch(city.last.text, /Не вдалося однозначно зрозуміти запит/u);
  } finally { f.close(); }
});

test('menu and another topic end the saved city prompt without changing unrelated ForceReply', async () => {
  const f = await fixture();
  try {
    for (const reset of ['/menu', '🚌 Транспорт']) {
      await f.send('🏠 Житло');
      await f.send(reset);
      const after = await f.send('Trittau');
      assert.doesNotMatch(after.last.text, /Тема: житло — Trittau/u);
    }
    const report = { chat_id:USER, text:'Надішліть опис помилки', reply_markup:{ force_reply:true } };
    assert.deepEqual(normalizeKeyboardPayload(report), report);
    const group = { chat_id:GROUP, text:'Тема: житло. Вкажіть місто або район.', reply_markup:{ force_reply:true } };
    assert.deepEqual(normalizeKeyboardPayload(group, { housingDialogue:true }), group);
  } finally { f.close(); }
});

test('saved input expires, is isolated by chat and never overrides an explicit reply', async () => {
  const f = await fixture();
  try {
    await f.send('🏠 Житло');
    const read = async (chatId, now) => f.object.fetch(new Request('https://outbox.internal/housing-cost-active-v14', {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ op:'read', chatId, now })
    })).then(response => response.json());
    assert.match((await read(USER, NOW)).prompt, /Вкажіть місто/u);
    assert.equal((await read(USER + 1, NOW)).prompt, null);
    assert.equal((await read(USER, NOW + 16 * 60 * 1000)).prompt, null);
    const response = await handle(f.request('Trittau'), f.env, NOW + 16 * 60 * 1000, f.transport);
    assert.equal(response.status, 200);
    assert.doesNotMatch(f.calls.filter(call => call.method === 'sendMessage').at(-1).body.text, /Тема: житло — Trittau/u);
    const explicit = await f.send('Kiel житло для 2 осіб');
    await f.send('Trittau житло для 4 осіб');
    const reply = await f.send('3', { previous:explicit.last });
    assert.match(reply.last.text, /Kiel/u);
    assert.doesNotMatch(reply.last.text, /Trittau/u);
  } finally { f.close(); }
});
