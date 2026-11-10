import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, NOW, USER, GROUP } from './runtime-fixture.mjs';
import { scheduled } from '../src/runtime.mjs';

test('active dispatcher imports no historical pilot or persistent-menu version chain',()=>{
  const seen=new Set();
  function visit(file){
    if(seen.has(file))return;seen.add(file);
    assert.doesNotMatch(path.basename(file),/^worker-entry-(?:pilot-v\d+|persistent-menu)/u);
    const source=fs.readFileSync(file,'utf8');
    for(const match of source.matchAll(/(?:from\s*|import\s*)['"](\.\.?\/[^'"]+)['"]/gu))visit(path.resolve(path.dirname(file),match[1]));
  }
  visit(fileURLToPath(new URL('../src/runtime.mjs',import.meta.url)));
});

test('active menu and housing callbacks use one final keyboard policy during maintenance for admin',async()=>{
  const f=await fixture();try{
    const start=await f.send('/start');
    assert.ok(start.messages.length);
    const cleanupDeletes=f.calls.filter(c=>c.method==='deleteMessage').length;
    assert.equal(f.calls.some(c=>c.method==='sendMessage' && c.body.reply_markup?.force_reply===true),false,'/start migration must never emit ForceReply');
    assert.equal(cleanupDeletes,0,'legacy keyboard migration must remain through the originating /start update');
    const pulse=f.calls.find(c=>c.method==='sendMessage' && Array.isArray(c.body.reply_markup?.keyboard));
    assert.ok(pulse);
    assert.equal(pulse.body.reply_markup.one_time_keyboard,true);
    assert.equal(pulse.body.reply_markup.is_persistent,false);
    assert.equal(pulse.body.reply_markup.input_field_placeholder,undefined);
    assert.notEqual(pulse.body.reply_markup.force_reply,true);
    assert.ok(f.calls.some(c=>c.method==='sendMessage' && c.body.reply_markup?.remove_keyboard===true));
    const menu=start.messages.find(m=>Array.isArray(m.reply_markup?.inline_keyboard));
    assert.ok(menu);
    assert.equal(menu.reply_markup?.keyboard,undefined);
    assert.equal(menu.reply_markup.inline_keyboard.flat().filter(b=>b.callback_data==='nav:housing').length,1);
    const rooms=await f.send('',{callback:'hkr:3:L%C3%BCbeck'});
    assert.equal(f.calls.filter(c=>c.method==='deleteMessage').length,cleanupDeletes+1,'next user update must retire only the temporary pulse and keep the remove-keyboard anchor');
    assert.equal(rooms.body.mode,'housing-keyboard-people');
    assert.match(rooms.last.text,/Lübeck/u);
    assert.ok(rooms.last.reply_markup.inline_keyboard);
    assert.equal(rooms.last.reply_markup.keyboard,undefined);
    const people=await f.send('',{callback:'hkp:4:3:L%C3%BCbeck'});
    assert.equal(people.body.mode,'housing-keyboard-action');
    assert.match(people.last.text,/Осіб: 4/u);
    assert.equal(f.calls.filter(c=>c.method==='deleteMessage').length,cleanupDeletes+1);
  }finally{f.close();}
});

test('city and household survive natural Ukrainian messages on the active entrypoint',async()=>{
  const f=await fixture();try{
    for(const [text,city,persons] of [['Любек дві жінки','Lübeck',2],["Ренсберг для сім’ї 3",'Rendsburg',3],['Бюзум житло для 4 осіб','Büsum',4]]) {
      const result=await f.send(text);
      assert.ok(result.last,`${text}: reply missing`);
      assert.match(result.last.text,new RegExp(city));
      assert.match(result.last.text,new RegExp(`Осіб: ${persons}`));
      assert.ok(result.last.reply_markup.inline_keyboard);
    }
  }finally{f.close();}
});

test('Jobcenter callback shows verified guideline once and waits before provider search',async()=>{
  const f=await fixture();try{
    const result=await f.send('',{callback:'hka:j:4:3-4:Trittau'});
    assert.equal(result.body.mode,'jobcenter-guideline-awaiting-search');
    assert.equal(result.messages.length,1);
    assert.match(result.last.text,/Bruttokaltmiete/u);
    assert.match(result.last.text,/Heizkosten/u);
    assert.match(JSON.stringify(result.last.reply_markup),/jcr:15:4:3-4:Trittau/u);
    assert.equal(f.sourceCalls.length,0);
  }finally{f.close();}
});

test('housing search handles unavailable providers through active fallback without billing text',async()=>{
  const f=await fixture();try{
    const result=await f.send('',{callback:'jcr:15:4:3-4:Trittau'});
    assert.equal(result.body.mode,'private-jobcenter-radius-search');
    assert.ok(result.messages.length>=2);
    assert.doesNotMatch(result.messages.map(m=>m.text).join('\n'),/credits|Поповніть|API-авторизац/iu);
    assert.match(result.messages[0].text,/Trittau/u);
    assert.ok(result.last.reply_markup.inline_keyboard);
  }finally{f.close();}
});

test('maintenance blocks non-admin private and group requests without housing source calls',async()=>{
  const f=await fixture();try{
    const privateResult=await f.send('житло Witzwort',{user:USER+1});
    assert.equal(privateResult.body.mode,'maintenance');assert.match(privateResult.last.text,/обслуговуванні/u);
    const group=await f.send('@ZaskaletaInfoBot житло Witzwort',{user:USER+1,chat:GROUP,type:'supergroup'});
    assert.equal(group.body.mode,'maintenance');assert.equal(group.messages.length,0);
    assert.equal(f.sourceCalls.length,0);
  }finally{f.close();}
});

test('invalid webhook secret cannot reach city lookup, state operations or Telegram',async()=>{
  const f=await fixture();try{
    await f.send('житло Witzwort',{secret:'incorrect'});
    assert.equal(f.sourceCalls.length,0);assert.equal(f.calls.length,0);assert.equal(f.internal.length,0);
  }finally{f.close();}
});

test('housing pending amounts remain isolated by user and expire',async()=>{
  const f=await fixture();try{
    const call=(payload)=>f.object.fetch(new Request('https://outbox.internal/housing-cost-state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).then(r=>r.json());
    const base={chatId:USER,userId:USER,context:'Перевірка оренди|Trittau|3-4',now:NOW};
    assert.equal((await call({...base,op:'cost_pending_put',amount:900})).status,'ok');
    assert.equal((await call({...base,op:'cost_pending_read'})).state.amount,900);
    assert.equal((await call({...base,chatId:USER+1,userId:USER+1,op:'cost_pending_read'})).state,null);
    assert.equal((await call({...base,now:NOW+16*60*1000,op:'cost_pending_read'})).state,null);
  }finally{f.close();}
});

test('maintenance scheduled event reaches the active durable news owner and publishes fallback',async()=>{
  // TG-RUNTIME-115: the daily review goes to the news channel only.
  const CHANNEL=-1004480749326;
  const f=await fixture({TELEGRAM_ALLOWED_CHAT_IDS:`${GROUP},${USER},${CHANNEL}`,TELEGRAM_NEWS_CHAT_IDS:String(CHANNEL)});const original=globalThis.fetch;try{
    globalThis.fetch=f.transport;
    await f.storage.put(`maintenance-announcement:v1:${GROUP}`,{state:'sent',sentAt:NOW-1000});
    await f.storage.put(`maintenance-announcement:v1:${CHANNEL}`,{state:'sent',sentAt:NOW-1000});
    const pending=[];await scheduled({scheduledTime:NOW},f.env,{waitUntil(p){pending.push(p);}});await Promise.all(pending);
    const messages=f.calls.filter(c=>c.method==='sendMessage');
    assert.equal(messages.length,1);assert.equal(messages[0].body.chat_id,CHANNEL);assert.match(messages[0].body.text,/Ранковий огляд — 15.09.2026/u);
    assert.equal(await f.storage.get(`telegram-daily-news:v2:${CHANNEL}`),'2026-09-15');
    assert.equal(await f.storage.get(`telegram-daily-news:v2:${GROUP}`),undefined);
  }finally{globalThis.fetch=original;f.close();}
});
