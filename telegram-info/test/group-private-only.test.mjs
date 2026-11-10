import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/worker-entry-beta.mjs';

const NOW = 1700000000000;
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const GROUP = -1001234567890;
const USER = 702;

function env() {
  return {
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_ALLOWED_CHAT_IDS:String(GROUP),
    TELEGRAM_ADMIN_USER_IDS:'777',
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_DELIVERY_ENABLED:'false'
  };
}

function request(update) {
  return new Request('https://pilot.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
    body:JSON.stringify(update)
  });
}

function groupMessage(text, id = 1) {
  return {
    update_id:id,
    message:{
      message_id:100 + id,
      date:NOW / 1000,
      chat:{ id:GROUP, type:'supergroup' },
      from:{ id:USER, is_bot:false },
      text
    }
  };
}

function telegram(result, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { ok:true, result } : { ok:false, error_code:status }), {
    status,
    headers:{ 'content-type':'application/json' }
  });
}

test('group start continues privately and publishes nothing in the group when DM is available', async () => {
  const calls = [];
  const response = await handle(request(groupMessage('/start@ZaskaletaInfoBot')), env(), NOW, async (url, options) => {
    const method = url.split('/').at(-1);
    const payload = JSON.parse(options.body);
    calls.push({ method, payload });
    assert.equal(method, 'sendMessage');
    assert.equal(payload.chat_id, USER);
    return telegram({ message_id:501, chat:{ id:USER, type:'private' } });
  });
  const body = await response.json();
  assert.equal(body.private, true);
  assert.equal(body.delivered, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].payload.text, /Вітаємо/u);
  assert.notEqual(calls[0].payload.chat_id, GROUP);
});

test('when Telegram blocks a first DM, group receives only one neutral assistant navigation button', async () => {
  const calls = [];
  const personal = "@ZaskaletaInfoBot Житло для сім'ї 4 людини під Джобцентер в Hamburg";
  const response = await handle(request(groupMessage(personal, 2)), env(), NOW, async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    if (payload.chat_id === USER) return telegram(null, 403);
    assert.equal(payload.chat_id, GROUP);
    return telegram({ message_id:502, chat:{ id:GROUP, type:'supergroup' } });
  });
  const body = await response.json();
  assert.equal(body.private, false);
  assert.equal(body.delivered, true);
  assert.equal(calls.length, 2);
  const publicPayload = calls[1];
  assert.match(publicPayload.text, /приватності/u);
  assert.doesNotMatch(publicPayload.text, /Hamburg|4 людини|Джобцентер/u);
  const rows = publicPayload.reply_markup.inline_keyboard;
  assert.equal(rows.length,1);
  assert.equal(rows[0].length,1);
  assert.equal(rows[0][0].text,'🤖 Відкрити помічник');
  assert.match(rows[0][0].url,/start=assistant$/u);
});

test('legacy Jobcenter button from a group card is transformed into a private callback for its owner', async () => {
  const update = {
    update_id:3,
    callback_query:{
      id:'cb-private-handoff',
      from:{ id:USER, is_bot:false },
      data:`jc:3506905833:u${USER}`,
      message:{
        message_id:88,
        chat:{ id:GROUP, type:'supergroup' },
        from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
        caption:'1. Wohnung\n💶 850 € · 22946 Trittau\n🛏 3 кімн. · 📐 90 м²'
      }
    }
  };
  const calls = [];
  const response = await handle(request(update), env(), NOW, async (url, options) => {
    const method = url.split('/').at(-1);
    const payload = JSON.parse(options.body);
    calls.push({ method, payload });
    if (method === 'answerCallbackQuery') return telegram(true);
    assert.equal(method, 'sendMessage');
    assert.equal(payload.chat_id, USER);
    return telegram({ message_id:503, chat:{ id:USER, type:'private' } });
  });
  const body = await response.json();
  assert.equal(body.private, true);
  assert.deepEqual(calls.map(item => item.method), ['answerCallbackQuery','sendMessage']);
  assert.equal(calls[1].payload.chat_id, USER);
  assert.match(calls[1].payload.text, /Перевірка під Jobcenter/u);
  assert.match(calls[1].payload.text, /Крок 1\/2/u);
});

test('another participant cannot use the owner-bound legacy Jobcenter button', async () => {
  const update = {
    update_id:4,
    callback_query:{
      id:'cb-foreign',
      from:{ id:USER + 1, is_bot:false },
      data:`jc:3506905833:u${USER}`,
      message:{
        message_id:88,
        chat:{ id:GROUP, type:'supergroup' },
        from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
        caption:'1. Wohnung\n💶 850 € · 22946 Trittau\n🛏 3 кімн. · 📐 90 м²'
      }
    }
  };
  const calls = [];
  const response = await handle(request(update), env(), NOW, async (url, options) => {
    calls.push({ method:url.split('/').at(-1), payload:JSON.parse(options.body) });
    return telegram(true);
  });
  const body = await response.json();
  assert.equal(body.delivered, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'answerCallbackQuery');
  assert.match(calls[0].payload.text, /іншому учаснику/u);
});
