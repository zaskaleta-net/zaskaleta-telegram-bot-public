import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';

const GROUP = -1001234567890;
const OWNER = 111111111;
const USER = 222222222;
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'abcdefghijklmnopqrstuvwxyzABCDEFGH_1234567890';

function env() {
  return {
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_DELIVERY_ENABLED:'true',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_ALLOWED_CHAT_IDS:String(GROUP),
    TELEGRAM_ADMIN_USER_IDS:'',
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET
  };
}

test('private screenshot report falls back to the owner of an allowlisted pilot group', async () => {
  const calls = [];
  const update = {
    update_id:77,
    message:{
      message_id:12,
      chat:{ id:USER, type:'private' },
      from:{ id:USER, is_bot:false },
      caption:'Після натискання кнопки нічого не сталося',
      photo:[{ file_id:'screen' }],
      reply_to_message:{ text:'🐞 Повідомлення про помилку\n\nНадішліть скріншот неправильної роботи як відповідь на це повідомлення.' }
    }
  };

  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ method, body });

    if (method === 'getChatAdministrators') {
      assert.equal(body.chat_id, GROUP);
      return new Response(JSON.stringify({
        ok:true,
        result:[
          { status:'creator', user:{ id:OWNER, is_bot:false } },
          { status:'administrator', user:{ id:999999999, is_bot:true } }
        ]
      }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    if (method === 'getChatMember') {
      assert.equal(body.chat_id, GROUP);
      assert.equal(body.user_id, USER);
      return new Response(JSON.stringify({ ok:true, result:{ status:'member' } }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    if (method === 'copyMessage') {
      assert.equal(body.chat_id, OWNER);
      assert.equal(body.from_chat_id, USER);
      assert.equal(body.message_id, 12);
      return new Response(JSON.stringify({ ok:true, result:{ message_id:501 } }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    if (method === 'sendMessage') {
      return new Response(JSON.stringify({ ok:true, result:{ message_id:500, chat:{ id:body.chat_id } } }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    throw new Error(`unexpected Telegram method ${method}`);
  };

  const request = new Request('https://worker.test/telegram/stateless', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-telegram-bot-api-secret-token':SECRET
    },
    body:JSON.stringify(update)
  });

  const response = await handle(request, env(), Date.parse('2026-09-13T00:25:00+02:00'), transport);
  const result = await response.json();
  assert.equal(result.mode, 'pilot-report-submit');
  assert.equal(result.delivered, true);
  assert.equal(calls.some(call => call.method === 'sendMessage' && call.body.chat_id === OWNER && /Опис:/u.test(call.body.text)), true);
  assert.equal(calls.some(call => call.method === 'copyMessage' && call.body.chat_id === OWNER), true);
  assert.equal(calls.some(call => call.method === 'sendMessage' && call.body.chat_id === USER && /Дякуємо/u.test(call.body.text)), true);
});
