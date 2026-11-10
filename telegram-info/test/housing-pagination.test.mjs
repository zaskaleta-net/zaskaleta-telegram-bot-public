import test from 'node:test';
import assert from 'node:assert/strict';
import { maybeHandleNextHousingPage, housingPaginationFinalNotice } from '../src/runtime-housing-search.mjs';

const USER=777777777;
const SECRET='B'.repeat(40);
const KEY='klaz_live_'+'A'.repeat(24);
const contextText=[
  '🔎 Автопошук житла під Jobcenter — Trittau',
  'Осіб: 4',
  'Кімнати: 3-4',
  'Територія Jobcenter/Kreis: Stormarn.'
].join('\n');

function request(callback) {
  return new Request('https://fixture.example/telegram/stateless',{
    method:'POST',
    headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':SECRET},
    body:JSON.stringify({update_id:1,callback_query:{
      id:'q1',from:{id:USER,is_bot:false},data:callback,
      message:{message_id:9,date:1,chat:{id:USER,type:'private'},text:contextText}
    }})
  });
}

function ad(id, category) {
  const house=category==='205';
  return {
    ad_id:String(id),
    title:house?`Haus ${id} in Trittau`:`Wohnung ${id} in Trittau`,
    description:'Langfristig zu vermieten.',
    price:{amount:700+id,price_type:'SPECIFIED_AMOUNT'},
    status:'ACTIVE',deleted:false,
    ad_url:`https://www.kleinanzeigen.de/s-anzeige/housing/${id}`,
    location:{name:'Trittau'},
    details:{Zimmer:id%2?'3':'4'},
    images:[`https://img.example.test/${id}.jpg`],
    attributes:[{name:'wohnung_mieten.zimmer',label:'Zimmer',values:[{value:id%2?'3':'4',label:id%2?'3':'4'}]}]
  };
}

test('local housing next-page callback returns five items and preserves a further-page control', async () => {
  const sent=[];
  const transport=async (url,options={})=>{
    const target=String(url);
    if(target.startsWith('https://img.example.test/')) return new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg','content-length':'4'}});
    if(target.startsWith('https://api.telegram.org/')){
      const method=target.split('/').at(-1);
      let body;
      if(options.body instanceof FormData){
        body={};
        for(const [key,value] of options.body.entries()) body[key]=typeof value==='string'?value:`[Blob ${value.size}]`;
      } else body=JSON.parse(options.body);
      sent.push({method,body});
      return new Response(JSON.stringify({ok:true,result:{message_id:sent.length,chat:{id:USER,type:'private'}}}),{headers:{'content-type':'application/json'}});
    }
    if(target.includes('/locations?')) return new Response(JSON.stringify({success:true,data:{locations:[{id:'10410',name:'Trittau',city:'Trittau'}]}}),{headers:{'content-type':'application/json'}});
    if(target.includes('/search?')){
      const category=new URL(target).searchParams.get('category_id');
      const start=category==='203'?1:7;
      return new Response(JSON.stringify({success:true,data:{ads:Array.from({length:6},(_,i)=>ad(start+i,category))}}),{headers:{'content-type':'application/json'}});
    }
    return new Response('unavailable',{status:503});
  };
  const env={
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_ALLOWED_CHAT_IDS:String(USER),TELEGRAM_ADMIN_USER_IDS:String(USER),
    TELEGRAM_BOT_TOKEN:`123456789:${'A'.repeat(35)}`,TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',TELEGRAM_DELIVERY_ENABLED:'false',
    KLAZ_API_KEY:KEY
  };
  const response=await maybeHandleNextHousingPage(request(`jcn:l:5:u${USER}`),env,transport);
  assert.ok(response);
  const payload=await response.json();
  assert.equal(payload.mode,'private-jobcenter-housing-next-page');
  assert.equal(payload.offset,5);
  assert.equal(payload.mediaCount,5);
  const photos=sent.filter(call=>call.method==='sendPhoto');
  assert.equal(photos.length,5);
  const serialized=JSON.stringify(sent);
  assert.match(serialized,/Наступні оголошення/u);
  assert.match(serialized,/jcn:l:10:u777777777/u);
  for(const id of [6,7,8,9,10]) assert.match(serialized,new RegExp(`housing\\/${id}`));
  for(const id of [1,2,3,4,5]) assert.doesNotMatch(serialized,new RegExp(`housing\\/${id}(?:\\D|$)`));
});

test('housing next-page callback is owner-bound', async () => {
  const foreign=JSON.parse(await request(`jcn:l:5:u${USER+1}`).text());
  const bad=new Request('https://fixture.example/telegram/stateless',{
    method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':SECRET},
    body:JSON.stringify(foreign)
  });
  const result=await maybeHandleNextHousingPage(bad,{
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_ALLOWED_CHAT_IDS:String(USER),TELEGRAM_ADMIN_USER_IDS:String(USER),
    TELEGRAM_BOT_TOKEN:`123456789:${'A'.repeat(35)}`,TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',TELEGRAM_DELIVERY_ENABLED:'false',KLAZ_API_KEY:KEY
  },async()=>{throw new Error('must not fetch');});
  assert.equal(result,null);
});


test('final housing page explicitly says there are no more listings and has no next control', async () => {
  const sent=[];
  const transport=async (url,options={})=>{
    const target=String(url);
    if(target.startsWith('https://img.example.test/')) return new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg','content-length':'4'}});
    if(target.startsWith('https://api.telegram.org/')){
      const method=target.split('/').at(-1);
      let body;
      if(options.body instanceof FormData){
        body={};
        for(const [key,value] of options.body.entries()) body[key]=typeof value==='string'?value:`[Blob ${value.size}]`;
      } else body=JSON.parse(options.body);
      sent.push({method,body});
      return new Response(JSON.stringify({ok:true,result:{message_id:sent.length,chat:{id:USER,type:'private'}}}),{headers:{'content-type':'application/json'}});
    }
    if(target.includes('/locations?')) return new Response(JSON.stringify({success:true,data:{locations:[{id:'10410',name:'Trittau',city:'Trittau'}]}}),{headers:{'content-type':'application/json'}});
    if(target.includes('/search?')){
      const category=new URL(target).searchParams.get('category_id');
      const start=category==='203'?1:5;
      return new Response(JSON.stringify({success:true,data:{ads:Array.from({length:4},(_,i)=>ad(start+i,category))}}),{headers:{'content-type':'application/json'}});
    }
    return new Response('unavailable',{status:503});
  };
  const env={
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_ALLOWED_CHAT_IDS:String(USER),TELEGRAM_ADMIN_USER_IDS:String(USER),
    TELEGRAM_BOT_TOKEN:`123456789:${'A'.repeat(35)}`,TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',TELEGRAM_DELIVERY_ENABLED:'false',
    KLAZ_API_KEY:KEY
  };
  const response=await maybeHandleNextHousingPage(request(`jcn:l:5:u${USER}`),env,transport);
  assert.ok(response);
  const payload=await response.json();
  assert.equal(payload.mode,'private-jobcenter-housing-next-page');
  assert.equal(payload.offset,5);
  assert.equal(payload.mediaCount,3);
  const serialized=JSON.stringify(sent);
  assert.match(serialized,/Оголошень більше немає/u);
  assert.doesNotMatch(serialized,/Наступні оголошення/u);
  for(const id of [6,7,8]) assert.match(serialized,new RegExp(`housing\\/${id}`));
});


test('pagination final notice is explicit only when no further page exists', () => {
  assert.equal(housingPaginationFinalNotice(true), '');
  assert.equal(housingPaginationFinalNotice(false), '\n\nℹ️ Оголошень більше немає.');
});
