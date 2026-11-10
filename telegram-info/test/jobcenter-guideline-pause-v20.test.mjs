import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';

const TOKEN = `123456789:${'A'.repeat(35)}`;
const SECRET = 's'.repeat(40);
const USER_ID = 111111111;

function env() {
  return {
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_ALLOWED_CHAT_IDS:String(USER_ID),
    TELEGRAM_ADMIN_USER_IDS:'',
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET
  };
}

function request() {
  return new Request('https://example.test/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
    body:JSON.stringify({
      update_id:51824001,
      callback_query:{
        id:'cb-jobcenter-pause',
        from:{ id:USER_ID, is_bot:false },
        data:'hka:j:2:3:Heide',
        message:{
          message_id:500,
          date:1,
          chat:{ id:USER_ID, type:'private' },
          text:'Житло — Heide, 3 кімнати. Осіб: 2'
        }
      }
    })
  });
}

test('Jobcenter guideline pauses before listings and exposes explicit search button', async () => {
  const calls = [];
  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ method, body });
    return new Response(JSON.stringify({ ok:true, result:{ message_id:900, chat:{ id:USER_ID } } }), {
      status:200,
      headers:{ 'content-type':'application/json' }
    });
  };

  const response = await handle(request(), env(), Date.now(), transport);
  const payload = await response.json();

  assert.equal(payload.mode, 'jobcenter-guideline-awaiting-search');
  assert.deepEqual(calls.map(call => call.method), ['answerCallbackQuery', 'sendMessage']);

  const message = calls[1].body;
  assert.match(message.text, /Орієнтири Jobcenter Dithmarschen/u);
  assert.match(message.text, /514,80 €/u);
  assert.match(message.text, /Ознайомтеся з нормою Jobcenter/u);
  assert.doesNotMatch(message.text, /Починаю пошук житла під ці параметри/u);
  // The live runtime appends its persistent menu row after the search action.
  assert.deepEqual(message.reply_markup.inline_keyboard[0], [{
    text:'🔎 Почати пошук',
    callback_data:'jcr:15:2:3:Heide'
  }]);
  assert.deepEqual(message.reply_markup.inline_keyboard.slice(1), [[{ text:'☰ Меню', callback_data:'nav:menu' }]]);
  assert.equal(calls.some(call => call.method === 'sendPhoto'), false);
});
