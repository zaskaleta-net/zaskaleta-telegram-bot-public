import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';

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

function callbackRequest(data, text, updateId = 1) {
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
          date:Math.floor(Date.now() / 1000),
          chat:{ id:userId, type:'private' },
          text
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

test('shared 1x3 choice preserves household size and reaches action buttons', async () => {
  const calls = [];
  const choiceText = [
    '🏠 Зрозумів запит.',
    '📍 Trittau',
    '👥 4 особи',
    '',
    'Можемо шукати:',
    '1️⃣ одну 3-кімнатну квартиру;',
    '2️⃣ дві окремі 1-кімнатні квартири поруч.',
    '',
    'Оберіть, з якого варіанта почати.'
  ].join('\n');

  const response = await handle(callbackRequest('sh:3:Trittau', choiceText), env(), Date.now(), telegramTransport(calls));
  assert.ok(response);
  const sent = calls.find(call => call.method === 'sendMessage');
  assert.ok(sent);
  assert.match(sent.body.text, /^Житло — Trittau, 3 кімнати\./u);
  assert.match(sent.body.text, /Осіб: 4/u);
  assert.ok(Array.isArray(sent.body.reply_markup?.inline_keyboard));
  assert.match(JSON.stringify(sent.body.reply_markup), /Житло під Jobcenter/u);
  assert.equal(sent.body.reply_markup?.force_reply, undefined);
});

