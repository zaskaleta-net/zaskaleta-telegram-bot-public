import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, privateDeepLinkAction, privateDeepLinkRequest } from '../src/worker-entry-beta.mjs';

const NOW = 1700000000000;
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const GROUP = -1001234567890;
const ADMIN = 777;

function telegram(value) { return new Response(JSON.stringify({ok:true,result:value}), {status:200,headers:{'content-type':'application/json'}}); }
function env() { return { TELEGRAM_RELEASE_APPROVED:'pilot-v1', TELEGRAM_PILOT_MODE:'allowlist', TELEGRAM_ALLOWED_CHAT_IDS:String(GROUP), TELEGRAM_ADMIN_USER_IDS:String(ADMIN), TELEGRAM_BOT_TOKEN:TOKEN, TELEGRAM_WEBHOOK_SECRET:SECRET, TELEGRAM_INGRESS_ENABLED:'true', TELEGRAM_DELIVERY_ENABLED:'false' }; }
function request(userId=ADMIN, text='/panel@ZaskaletaInfoBot') { return new Request('https://pilot.example/telegram/stateless',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':SECRET},body:JSON.stringify({update_id:10,message:{message_id:20,date:NOW/1000,chat:{id:GROUP,type:'supergroup'},from:{id:userId,is_bot:false},text}})}); }

test('admin panel publishes one private-navigation card with only the assistant button and pins it', async () => {
  const calls=[];
  const response=await handle(request(), env(), NOW, async (url,options)=>{
    const method=url.split('/').at(-1); const body=JSON.parse(options.body); calls.push([method,body]);
    if(method==='sendMessage') return telegram({message_id:501,chat:{id:GROUP}});
    if(method==='pinChatMessage') return telegram(true);
    throw Error('unexpected '+method);
  });
  const result=await response.json();
  assert.equal(result.delivered,true); assert.equal(result.pinned,true);
  assert.deepEqual(calls.map(x=>x[0]),['sendMessage','pinChatMessage']);
  const panel=calls[0][1];
  assert.match(panel.text,/Персональні запити працюють у приватному чаті/u);
  const rows=panel.reply_markup.inline_keyboard;
  assert.equal(rows.length,1);
  assert.equal(rows[0].length,1);
  assert.equal(rows[0][0].text,'🤖 Відкрити помічник');
  assert.match(rows[0][0].url,/start=assistant$/u);
  assert.equal(calls[1][1].message_id,501);
});

test('real Telegram group admin can publish even when not present in static admin allowlist', async () => {
  const calls=[];
  const response=await handle(request(701), env(), NOW, async (url,options)=>{
    const method=url.split('/').at(-1); const body=JSON.parse(options.body); calls.push([method,body]);
    if(method==='getChatAdministrators') return telegram([{status:'creator',user:{id:701,is_bot:false}}]);
    if(method==='sendMessage') return telegram({message_id:502,chat:{id:GROUP}});
    if(method==='pinChatMessage') return telegram(true);
    throw Error('unexpected '+method);
  });
  const result=await response.json();
  assert.equal(result.delivered,true); assert.equal(result.pinned,true);
  assert.deepEqual(calls.map(x=>x[0]),['getChatAdministrators','sendMessage','pinChatMessage']);
});

test('non-admin cannot publish or pin the panel', async () => {
  const calls=[];
  const response=await handle(request(701), env(), NOW, async (url,options)=>{
    const method=url.split('/').at(-1); const body=JSON.parse(options.body); calls.push([method,body]);
    if(method==='getChatAdministrators') return telegram([{status:'creator',user:{id:777,is_bot:false}}]);
    throw Error('unexpected '+method);
  });
  const result=await response.json();
  assert.equal(result.ignored,true);
  assert.deepEqual(calls.map(x=>x[0]),['getChatAdministrators']);
});

test('deep-link payloads resolve to private conversation intents', () => {
  assert.equal(privateDeepLinkAction('/start housing'),'Житло');
  assert.equal(privateDeepLinkAction('/start jobcenter_check'),'Житло під Jobcenter');
  assert.equal(privateDeepLinkAction('/start jobcenter_norms'),'Jobcenter житло');
  assert.equal(privateDeepLinkAction('/start assistant'),'/start');
  assert.equal(privateDeepLinkAction('/start private'),'/start');
  assert.equal(privateDeepLinkAction('/start'),null);
});

test('deep link starts fresh and drops stale reply context', async () => {
  const update={message:{chat:{id:ADMIN,type:'private'},from:{id:ADMIN,is_bot:false},text:'/start housing',reply_to_message:{message_id:77,text:'Тема: житло — Rendsburg. Локацію вже визначено.'}}};
  const req=new Request('https://pilot.example/telegram/stateless',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(update)});
  const rewritten=privateDeepLinkRequest(req,update);
  const body=await rewritten.json();
  assert.equal(body.message.text,'Житло');
  assert.equal(body.message.reply_to_message,undefined);
});
