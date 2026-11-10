import test from 'node:test';
import assert from 'node:assert/strict';
import { persistentPrivateKeyboardFinalTransport } from '../src/worker-entry-pilot-v21.mjs';

const SEND = 'https://api.telegram.org/bot123:ABC/sendMessage';
const DELETE = 'https://api.telegram.org/bot123:ABC/deleteMessage';

function ok(result = { message_id:1, chat:{ id:123, type:'private' } }) {
  return new Response(JSON.stringify({ ok:true, result }), {
    status:200,
    headers:{ 'content-type':'application/json' }
  });
}

test('final transport keeps the main menu inline so Telegram cannot persist an input placeholder', async () => {
  let captured = null;
  const wrapped = persistentPrivateKeyboardFinalTransport(async (_url, options = {}) => {
    captured = JSON.parse(options.body);
    return ok();
  });

  await wrapped(SEND, {
    method:'POST',
    body:JSON.stringify({
      chat_id:123,
      text:'Оберіть потрібний розділ:',
      reply_markup:{
        inline_keyboard:[
          [{ text:'🏠 Житло', callback_data:'nav:housing' }, { text:'🏛 Jobcenter', callback_data:'nav:jobcenter' }],
          [{ text:'💼 Робота', callback_data:'nav:work' }, { text:'🎓 Курси', callback_data:'nav:courses' }],
          [{ text:'📄 Документи', callback_data:'nav:documents' }, { text:'👶 Kindergeld', callback_data:'nav:kindergeld' }]
        ]
      }
    })
  });

  assert.equal(captured.reply_markup.keyboard, undefined);
  assert.ok(Array.isArray(captured.reply_markup.inline_keyboard));
  assert.equal(captured.reply_markup.input_field_placeholder, undefined);
  assert.match(JSON.stringify(captured.reply_markup), /🏠 Житло/u);
  assert.match(JSON.stringify(captured.reply_markup), /🐞 Помилка/u);
});

test('final transport keeps specialized reply keyboards collapsible and reopenable', async () => {
  let captured = null;
  const wrapped = persistentPrivateKeyboardFinalTransport(async (_url, options = {}) => {
    captured = JSON.parse(options.body);
    return ok();
  });

  await wrapped(SEND, {
    method:'POST',
    body:JSON.stringify({
      chat_id:123,
      text:'Оберіть варіант',
      reply_markup:{
        keyboard:[[{ text:'2-3 кімн.' }, { text:'3-4 кімн.' }]],
        one_time_keyboard:true,
        is_persistent:true,
        selective:true
      }
    })
  });

  assert.ok(Array.isArray(captured.reply_markup.keyboard));
  assert.equal(captured.reply_markup.resize_keyboard, true);
  assert.equal(captured.reply_markup.one_time_keyboard, false);
  assert.equal(captured.reply_markup.is_persistent, false);
  assert.equal(captured.reply_markup.selective, undefined);
});

test('legacy remove_keyboard cleanup is swallowed in private chats', async () => {
  const downstream = [];
  const wrapped = persistentPrivateKeyboardFinalTransport(async (url, options = {}) => {
    downstream.push({ url:String(url), body:options.body });
    return ok();
  });

  const removal = await wrapped(SEND, {
    method:'POST',
    body:JSON.stringify({
      chat_id:123,
      text:'⌨️ Меню оновлено',
      reply_markup:{ remove_keyboard:true }
    })
  });
  const removalPayload = await removal.json();
  assert.equal(removalPayload.ok, true);
  assert.equal(downstream.length, 0);

  const guardedMessageId = removalPayload.result.message_id;
  const deletion = await wrapped(DELETE, {
    method:'POST',
    body:JSON.stringify({ chat_id:123, message_id:guardedMessageId })
  });
  const deletionPayload = await deletion.json();
  assert.equal(deletionPayload.ok, true);
  assert.equal(downstream.length, 0);
});

test('ordinary inline action keyboards remain inline', async () => {
  let captured = null;
  const wrapped = persistentPrivateKeyboardFinalTransport(async (_url, options = {}) => {
    captured = JSON.parse(options.body);
    return ok();
  });
  const inline = { inline_keyboard:[[{ text:'5 км', callback_data:'jcr:5:3:2-3:Rendsburg' }]] };

  await wrapped(SEND, {
    method:'POST',
    body:JSON.stringify({ chat_id:123, text:'Радіус', reply_markup:inline })
  });

  assert.deepEqual(captured.reply_markup, inline);
});
