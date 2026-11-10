import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/worker-entry-pilot-v21.mjs';

const NOW = Date.UTC(2026, 8, 26, 21, 35, 0);
const USER = 777777777;
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);

function liveEnv() {
  return {
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_ALLOWED_CHAT_IDS:String(USER),
    TELEGRAM_ADMIN_USER_IDS:String(USER),
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_DELIVERY_ENABLED:'true',
    TELEGRAM_MAINTENANCE_MODE:'false'
  };
}

function startRequest() {
  return new Request('https://staging.example/telegram/stateless', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-telegram-bot-api-secret-token':SECRET
    },
    body:JSON.stringify({
      update_id:900001,
      message:{
        message_id:1001,
        date:NOW / 1000,
        chat:{ id:USER, type:'private' },
        from:{ id:USER, is_bot:false },
        text:'/start'
      }
    })
  });
}

test('live v21 canonical stateless ingress handles /start without falling into disabled legacy gate', async () => {
  const calls=[];
  const transport=async (url, options={})=>{
    const target=String(url);
    if (!target.startsWith('https://api.telegram.org/')) {
      return new Response('unavailable',{status:503});
    }
    const method=target.split('/').at(-1);
    const body=typeof options.body==='string' ? JSON.parse(options.body) : {};
    calls.push({method,body});
    if (method === 'sendMessage') {
      return new Response(JSON.stringify({ok:true,result:{message_id:2001,chat:{id:USER,type:'private'}}}),{
        status:200,headers:{'content-type':'application/json'}
      });
    }
    if (method === 'getChatMember') {
      return new Response(JSON.stringify({ok:true,result:{status:'member',user:{id:USER,is_bot:false}}}),{
        status:200,headers:{'content-type':'application/json'}
      });
    }
    return new Response(JSON.stringify({ok:true,result:true}),{
      status:200,headers:{'content-type':'application/json'}
    });
  };

  const response=await handle(startRequest(),liveEnv(),NOW,transport);
  assert.equal(response.status,200);
  const payload=await response.json();
  assert.equal(payload.ok,true);
  assert.notEqual(payload.error,'Not configured');
  assert.ok(calls.some(call=>call.method==='sendMessage'),'/start must deliver a Telegram message');
});
