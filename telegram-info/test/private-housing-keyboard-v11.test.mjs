import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { peopleQuickMarkup, roomQuickMarkup, actionQuickMarkup } from '../src/runtime-keyboard.mjs';

const token = '123456789:' + 'a'.repeat(40);
const secret = 's'.repeat(40);
const userId = 111111111;
const groupId = -1001234567890;

function env() {
  return {
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_ALLOWED_CHAT_IDS:String(groupId),
    TELEGRAM_ADMIN_USER_IDS:String(userId),
    TELEGRAM_BOT_TOKEN:token,
    TELEGRAM_WEBHOOK_SECRET:secret
  };
}

function messageRequest(text, previous, updateId = 1) {
  return new Request('https://example.test/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':secret },
    body:JSON.stringify({
      update_id:updateId,
      message:{
        message_id:100 + updateId,
        date:1,
        chat:{ id:userId, type:'private' },
        from:{ id:userId, is_bot:false },
        text,
        reply_to_message:{
          message_id:99 + updateId,
          date:1,
          chat:{ id:userId, type:'private' },
          from:{ id:999999999, is_bot:true, username:'ZaskaletaInfoBot' },
          text:previous
        }
      }
    })
  });
}

function callbackRequest(data, updateId = 10) {
  return new Request('https://example.test/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':secret },
    body:JSON.stringify({
      update_id:updateId,
      callback_query:{
        id:`cb-${updateId}`,
        from:{ id:userId, is_bot:false },
        data,
        message:{
          message_id:500,
          date:1,
          chat:{ id:userId, type:'private' },
          text:'guided housing step'
        }
      }
    })
  });
}

function telegramTransport(calls) {
  return async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ method, body });
    if (method === 'answerCallbackQuery') {
      return new Response(JSON.stringify({ ok:true, result:true }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    if (method === 'sendMessage') {
      return new Response(JSON.stringify({ ok:true, result:{ message_id:700 + calls.length, chat:{ id:userId } } }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    throw new Error(`unexpected Telegram method ${method}`);
  };
}

test('quick markups keep common housing steps on inline buttons', () => {
  const rooms = roomQuickMarkup('Trittau');
  const people = peopleQuickMarkup('Trittau', '3-4');
  const actions = actionQuickMarkup('Trittau', '3-4', 4);
  assert.ok(Array.isArray(rooms?.inline_keyboard));
  assert.ok(Array.isArray(people?.inline_keyboard));
  assert.ok(Array.isArray(actions?.inline_keyboard));
  assert.match(JSON.stringify(rooms), /3-4/u);
  assert.match(JSON.stringify(people), /hkp:4:3-4:Trittau/u);
  assert.match(JSON.stringify(actions), /Пошук житла/u);
  assert.match(JSON.stringify(actions), /Перевірка оренди/u);
});

test('room text answer produces inline people buttons instead of another ForceReply', async () => {
  const calls = [];
  const previous = 'Тема: житло — Trittau. Локацію вже визначено.\nВкажіть кількість кімнат, наприклад: 3 або 3-4.';
  const response = await handle(messageRequest('3-4', previous), env(), Date.now(), telegramTransport(calls));
  assert.ok(response);
  const sent = calls.find(call => call.method === 'sendMessage');
  assert.ok(sent);
  assert.match(sent.body.text, /📍 Локація: Trittau/u);
  assert.match(sent.body.text, /🛏 Кімнат: 3-4/u);
  assert.ok(Array.isArray(sent.body.reply_markup?.inline_keyboard));
  assert.equal(sent.body.reply_markup?.force_reply, undefined);
});

test('people button produces action buttons without opening the typing keyboard', async () => {
  const calls = [];
  const response = await handle(callbackRequest('hkp:4:3-4:Trittau'), env(), Date.now(), telegramTransport(calls));
  assert.ok(response);
  const sent = calls.find(call => call.method === 'sendMessage');
  assert.ok(sent);
  assert.match(sent.body.text, /Житло — Trittau, 3-4 кімнати/u);
  assert.match(sent.body.text, /Осіб: 4/u);
  assert.ok(Array.isArray(sent.body.reply_markup?.inline_keyboard));
  assert.match(JSON.stringify(sent.body.reply_markup), /Житло під Jobcenter/u);
  assert.equal(sent.body.reply_markup?.force_reply, undefined);
});

