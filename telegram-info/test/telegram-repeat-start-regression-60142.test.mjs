import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/worker-entry-pilot-v21.mjs';

const NOW = Date.UTC(2026,8,29,12,0,0);
const USER = 777777777;
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);

function env(){
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

function req(updateId){
  return new Request('https://staging.example/telegram/stateless',{
    method:'POST',
    headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':SECRET},
    body:JSON.stringify({
      update_id:updateId,
      message:{message_id:updateId,date:NOW/1000,chat:{id:USER,type:'private'},from:{id:USER,is_bot:false},text:'/start'}
    })
  });
}

test('repeated /start is answered immediately and independently of housing state', async () => {
  const calls=[];
  const transport=async (url,options={})=>{
    const method=String(url).split('/').at(-1);
    if(method==='getChatMember') return new Response(JSON.stringify({ok:true,result:{status:'member',user:{id:USER,is_bot:false}}}),{status:200,headers:{'content-type':'application/json'}});
    if(method==='sendMessage'){
      calls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ok:true,result:{message_id:900+calls.length,chat:{id:USER,type:'private'}}}),{status:200,headers:{'content-type':'application/json'}});
    }
    return new Response(JSON.stringify({ok:true,result:true}),{status:200,headers:{'content-type':'application/json'}});
  };

  for(const id of [5001,5002]){
    const response=await handle(req(id),env(),NOW,transport);
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.mode,'private-start-fast-v22');
    assert.equal(body.delivered,true);
  }
  const menus=calls.filter(call=>Array.isArray(call.reply_markup?.inline_keyboard));
  assert.equal(menus.length,2);
  assert.ok(calls.every(call=>call.reply_markup?.force_reply!==true));
  assert.equal(calls.some(call=>call.reply_markup?.input_field_placeholder!=null),false);
});
