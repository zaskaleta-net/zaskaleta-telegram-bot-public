import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/worker-entry-beta.mjs';

const NOW = 1700000000000;
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const GROUP = -1001234567890;
const USER = 702;

const telegram = result => new Response(JSON.stringify({ ok:true, result }), {
  status:200,
  headers:{ 'content-type':'application/json' }
});

function request(update) {
  return new Request('https://pilot.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
    body:JSON.stringify(update)
  });
}

function env(fetchInternal) {
  return {
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_ALLOWED_CHAT_IDS:String(GROUP),
    TELEGRAM_ADMIN_USER_IDS:'777',
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_DELIVERY_ENABLED:'false', TELEGRAM_GROUP_PRIVATE_ONLY:'false',
    OUTBOX:{
      idFromName(name){ assert.equal(name, 'telegram-pilot-v1'); return name; },
      get(){ return { fetch:fetchInternal }; }
    }
  };
}

function callback(caption) {
  return {
    update_id:500,
    callback_query:{
      id:'cb-reuse-household',
      from:{ id:USER, is_bot:false },
      data:`jc:3506905833:u${USER}`,
      message:{
        message_id:88,
        chat:{ id:GROUP, type:'supergroup' },
        from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
        caption
      }
    }
  };
}

test('Jobcenter listing check reuses household size carried by the active search card', async () => {
  const operations = [];
  const internal = async (_url, options) => {
    const body = JSON.parse(options.body);
    operations.push(body.op);
    if (body.op === 'jc_start') {
      assert.equal(body.context.location, '22946 Trittau');
      return new Response(JSON.stringify({ status:'ok' }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    if (body.op === 'jc_persons') {
      assert.equal(body.persons, 4);
      return new Response(JSON.stringify({ status:'ok', state:{ step:'rent', persons:4 } }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    throw new Error(`Unexpected internal operation: ${body.op}`);
  };

  const methods = [];
  let prompt;
  const transport = async (url, options) => {
    const method = url.split('/').at(-1);
    methods.push(method);
    if (method === 'answerCallbackQuery') return telegram(true);
    if (method === 'sendMessage') {
      prompt = JSON.parse(options.body);
      return telegram({ message_id:901, chat:{ id:GROUP } });
    }
    throw new Error(`Unexpected Telegram method: ${method}`);
  };

  const caption = [
    '1. Wohnung in Trittau',
    '💶 850 € · 22946 Trittau',
    '🛏 3 кімн. · 📐 90 м²',
    '👥 4 осіб'
  ].join('\n');

  const response = await handle(request(callback(caption)), env(internal), NOW, transport);
  const body = await response.json();

  assert.deepEqual(operations, ['jc_start', 'jc_persons']);
  assert.deepEqual(methods, ['answerCallbackQuery', 'sendMessage']);
  assert.equal(body.delivered, true);
  assert.match(prompt.text, /👥 4 осіб/u);
  assert.match(prompt.text, /Крок 2\/2/u);
  assert.doesNotMatch(prompt.text, /Крок 1\/2|вкажіть кількість осіб/iu);
  assert.equal(prompt.reply_markup.force_reply, true);
});

test('standalone old listing card still asks household size when the search context is absent', async () => {
  const operations = [];
  const internal = async (_url, options) => {
    const body = JSON.parse(options.body);
    operations.push(body.op);
    if (body.op === 'flow_read') {
      return new Response(JSON.stringify({ status:'ok', state:null }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    assert.equal(body.op, 'jc_start');
    return new Response(JSON.stringify({ status:'ok' }), { status:200, headers:{ 'content-type':'application/json' } });
  };
  let prompt;
  const transport = async (url, options) => {
    const method = url.split('/').at(-1);
    if (method === 'answerCallbackQuery') return telegram(true);
    prompt = JSON.parse(options.body);
    return telegram({ message_id:902, chat:{ id:GROUP } });
  };

  const response = await handle(request(callback('1. Wohnung\n💶 850 € · 22946 Trittau\n🛏 3 кімн. · 📐 90 м²')), env(internal), NOW, transport);
  assert.equal((await response.json()).delivered, true);
  assert.deepEqual(operations, ['flow_read', 'jc_start']);
  assert.match(prompt.text, /Крок 1\/2/u);
  assert.match(prompt.text, /кількість осіб/u);
});