import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/worker-entry-beta.mjs';

const NOW = 1700000000000;
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const GROUP = -1001234567890;
const USER = 702;

function request(update) {
  return new Request('https://pilot.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
    body:JSON.stringify(update)
  });
}

function environment(fetchInternal) {
  return {
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_ALLOWED_CHAT_IDS:String(GROUP),
    TELEGRAM_ADMIN_USER_IDS:String(USER),
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_DELIVERY_ENABLED:'false', TELEGRAM_GROUP_PRIVATE_ONLY:'false',
    OUTBOX:{
      idFromName(){ return 'telegram-pilot-v1'; },
      get(){ return { fetch:fetchInternal }; }
    }
  };
}

function telegram(result) {
  return new Response(JSON.stringify({ ok:true, result }), { status:200, headers:{ 'content-type':'application/json' } });
}

test('complete new Trittau request clears stale Jobcenter listing before reply routing', async () => {
  let staleJobcenter = { step:'persons', listingId:'3508825573', location:'22147 Hamburg Rahlstedt', areaSqm:98 };
  const operations = [];
  const internal = async (_url, options) => {
    const body = JSON.parse(options.body);
    operations.push(body.op);
    if (body.op === 'conversation_reset') {
      staleJobcenter = null;
      return new Response(JSON.stringify({ status:'ok' }), { headers:{ 'content-type':'application/json' } });
    }
    if (body.op === 'flow_context') return new Response(JSON.stringify({ status:'ok' }), { headers:{ 'content-type':'application/json' } });
    if (body.op === 'message') return new Response(JSON.stringify({ status:'ok', handled:false }), { headers:{ 'content-type':'application/json' } });
    if (body.op === 'jc_read') return new Response(JSON.stringify({ status:'ok', state:staleJobcenter }), { headers:{ 'content-type':'application/json' } });
    throw Error(`unexpected operation ${body.op}`);
  };

  const update = {
    update_id:501,
    message:{
      message_id:601,
      date:NOW / 1000,
      chat:{ id:GROUP, type:'supergroup' },
      from:{ id:USER, is_bot:false },
      text:"Тріттау житло для сім'ї 4 людини Для Джобцентер",
      reply_to_message:{
        message_id:500,
        chat:{ id:GROUP, type:'supergroup' },
        from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
        text:'Вітаємо! Schleswig-Holstein Помічник 🇺🇦🇩🇪'
      }
    }
  };

  let sent;
  const response = await handle(request(update), environment(internal), NOW, async (_url, options) => {
    sent = JSON.parse(options.body);
    return telegram({ message_id:700, chat:{ id:GROUP } });
  });

  assert.equal((await response.json()).delivered, true);
  assert.deepEqual(operations, ['conversation_reset','flow_context','message','jc_read']);
  assert.match(sent.text, /Trittau/u);
  assert.match(sent.text, /^Осіб: 4$/mu);
  assert.doesNotMatch(sent.text, /3508825573|Крок 1\/2|Hamburg Rahlstedt/u);
});

test('old listing callback uses household from its original replied request and skips Step 1', async () => {
  const operations = [];
  const internal = async (_url, options) => {
    const body = JSON.parse(options.body);
    operations.push(body.op);
    if (body.op === 'jc_start') return new Response(JSON.stringify({ status:'ok' }), { headers:{ 'content-type':'application/json' } });
    if (body.op === 'jc_persons') return new Response(JSON.stringify({ status:'ok', state:{ step:'rent', persons:4 } }), { headers:{ 'content-type':'application/json' } });
    throw Error(`unexpected operation ${body.op}`);
  };

  const update = {
    update_id:502,
    callback_query:{
      id:'cb-old-card',
      from:{ id:USER, is_bot:false },
      data:`jc:3506905833:u${USER}`,
      message:{
        message_id:88,
        chat:{ id:GROUP, type:'supergroup' },
        from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
        caption:'1. Wohnung in Trittau\n💶 850 € · 22946 Trittau\n🛏 3 кімн. · 📐 90 м²',
        reply_to_message:{
          message_id:77,
          chat:{ id:GROUP, type:'supergroup' },
          from:{ id:USER, is_bot:false },
          text:"Тріттау житло для сім'ї 4 людини Для Джобцентер"
        }
      }
    }
  };

  const sent = [];
  const response = await handle(request(update), environment(internal), NOW, async (url, options) => {
    const method = url.split('/').at(-1);
    if (method === 'answerCallbackQuery') return telegram(true);
    const payload = JSON.parse(options.body);
    sent.push(payload);
    return telegram({ message_id:701, chat:{ id:GROUP } });
  });

  assert.equal((await response.json()).delivered, true);
  assert.deepEqual(operations, ['jc_start','jc_persons']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /👥 4 осіб/u);
  assert.match(sent[0].text, /Крок 2\/2/u);
  assert.doesNotMatch(sent[0].text, /Крок 1\/2/u);
});
