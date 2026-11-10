import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, USER } from './runtime-fixture.mjs';
import { housingCostFollowup } from '../src/housing-cost-dialogue.mjs';

// Staging-like private runtime: public pilot, maintenance off, stateless replies.
const STAGING={
  TELEGRAM_PILOT_MODE:'public',
  TELEGRAM_RELEASE_APPROVED:'public-v1',
  TELEGRAM_MAINTENANCE_MODE:'false',
  TELEGRAM_DELIVERY_ENABLED:'false'
};
const STALE='Ця кнопка застаріла. Відкрийте ☰ Меню.';

function lastText(result) {
  return String(result.last?.text || '');
}

function callbackAnswers(f, before) {
  return f.calls.slice(before).filter(call=>call.method==='answerCallbackQuery');
}

test('search-housing button flow completes past the radius step', async()=>{
  const f=await fixture(STAGING);
  try{
    await f.send('🔎 Пошук житла');
    const budget=await f.send('',{callback:'hka:s:4:3:Trittau',previous:{message_id:9,text:'Житло — Trittau, 3 кімнати.\nОсіб: 4\n\n✅ Дані збережено.\nЩо саме потрібно?'}});
    assert.match(lastText(budget),/^Пошук житла — Trittau, 3 кімнати\. Уточніть/u);
    assert.match(lastText(await f.send('900')),/Це Warmmiete чи Kaltmiete\?/u);
    const radius=await f.send('Warmmiete');
    assert.match(lastText(radius),/^Параметри житла: Trittau, 3 кімнати, до 900 € Warmmiete\. Оберіть радіус пошуку/u);
    // TG-RUNTIME-079: the radius answer starts the search at once (it was a
    // "Критерії пошуку зібрано" message with a 🔎 keyboard button).
    const criteria=await f.send('10 км');
    assert.match(lastText(criteria),/^(?:Знайдено|За фільтром|Сервіс актуальних оголошень|Kleinanzeigen не дав)/u);
    assert.doesNotMatch(lastText(criteria),/Не вдалося однозначно зрозуміти запит|Критерії пошуку зібрано/u);
    assert.ok(criteria.last.reply_markup?.inline_keyboard?.length,'the search reply has its buttons');
  }finally{f.close();}
});

test('a housing button press retires an older saved text prompt', async()=>{
  const f=await fixture(STAGING);
  try{
    const first=await f.send('Житло Kiel 2 кімнати 2 особи');
    assert.match(lastText(first),/^Житло — Kiel, 2 кімнати\./u);
    await f.send('',{callback:'hka:s:2:2:Kiel',previous:{message_id:9,text:'Житло — Kiel, 2 кімнати.\nОсіб: 2\n\n✅ Дані збережено.\nЩо саме потрібно?'}});
    const next=await f.send('800 Warmmiete');
    assert.doesNotMatch(lastText(next),/^Перевірка оренди/u);
    assert.match(lastText(next),/^Параметри житла: Kiel, 2 кімнати, до 800 € Warmmiete\./u);
  }finally{f.close();}
});

test('rent check accepts Nebenkosten as Betriebskosten', async()=>{
  const prompt='Перевірка оренди — Kiel, 2 кімнати.\nЗібрано: Kaltmiete 500 €\nОсіб: 2\nЩе потрібні: Betriebskosten, Heizkosten.';
  assert.match(housingCostFollowup(prompt,'Nebenkosten 120'),/Зібрано: Kaltmiete 500 €; Betriebskosten 120 €/u);
  const f=await fixture(STAGING);
  try{
    await f.send('Житло Kiel 2 кімнати 2 особи');
    await f.send('',{callback:'hka:r:2:2:Kiel',previous:{message_id:9,text:'Житло — Kiel, 2 кімнати.\nОсіб: 2\n\n✅ Дані збережено.\nЩо саме потрібно?'}});
    await f.send('Kaltmiete 500');
    const neben=await f.send('Nebenkosten 120');
    assert.match(lastText(neben),/Betriebskosten 120 €/u);
    await f.send('90');
    const label=await f.send('Heizkosten');
    assert.match(lastText(label),/Heizkosten 90 €/u);
  }finally{f.close();}
});

test('municipalities containing "in" keep their full name', async()=>{
  const f=await fixture(STAGING);
  try{
    for(const [text,place] of [['Житло в Neustadt in Holstein','Neustadt in Holstein'],['Житло в Oldenburg in Holstein','Oldenburg in Holstein'],['Житло Neustadt in Holstein 2 кімнати','Neustadt in Holstein']]){
      const result=await f.send(text);
      // TG-RUNTIME-070: with rooms the reply is the button flow's step ("📍 Локація: …").
      assert.ok(lastText(result).includes(`— ${place}`) || lastText(result).includes(`📍 Локація: ${place}\n`),`${text} -> ${lastText(result)}`);
    }
  }finally{f.close();}
});

test('typed "☰ Меню" opens the inline menu without sync messages or fallback', async()=>{
  const f=await fixture(STAGING);
  try{
    const result=await f.send('☰ Меню');
    assert.deepEqual(result.messages.map(m=>m.text),['Оберіть потрібний розділ:']);
    assert.ok(result.last.reply_markup.inline_keyboard.flat().some(button=>button.callback_data==='nav:housing'));
  }finally{f.close();}
});

test('unknown or stale private callbacks are answered exactly once', async()=>{
  const f=await fixture(STAGING);
  try{
    for(const data of ['jc:12345','hkr:9:Trittau',`jcn:l:5:u${USER}`,'zz:unknown']){
      const before=f.calls.length;
      await f.send('',{callback:data});
      const answers=callbackAnswers(f,before);
      assert.equal(answers.length,1,data);
      assert.equal(answers[0].body.text,STALE,data);
    }
    for(const data of ['nav:menu','hkr:x:Trittau','hkr:3:Trittau']){
      const before=f.calls.length;
      await f.send('',{callback:data});
      const answers=callbackAnswers(f,before);
      assert.equal(answers.length,1,data);
      assert.equal(answers[0].body.text,undefined,data);
    }
  }finally{f.close();}
});

test('manual room entry keeps the household size from the source message', async()=>{
  const f=await fixture(STAGING);
  try{
    const first=await f.send('Тріттау сімʼя 4 людини');
    assert.match(lastText(first),/^Осіб: 4$/mu);
    const manual=await f.send('',{callback:'hkr:x:Trittau',previous:{message_id:9,text:lastText(first)}});
    assert.match(lastText(manual),/^Осіб: 4$/mu);
    const rooms=await f.send('3');
    assert.match(lastText(rooms),/^Житло — Trittau, 3 кімнати\.\nОсіб: 4/u);
  }finally{f.close();}
});

test('maintenance answers a non-admin private callback', async()=>{
  const f=await fixture({...STAGING,TELEGRAM_MAINTENANCE_MODE:'true'});
  try{
    const before=f.calls.length;
    const result=await f.send('',{user:555555,callback:'nav:housing'});
    assert.equal(result.body.mode,'maintenance');
    const answers=callbackAnswers(f,before);
    assert.equal(answers.length,1);
    assert.equal(answers[0].body.text,undefined);
  }finally{f.close();}
});

test('the private listing card "Перевірити під Jobcenter" button starts the Jobcenter check', async()=>{
  const f=await fixture(STAGING);
  try{
    // Telegram delivers a photo card's caption as plain text.
    const caption=['1. Gemütliche 2-Zimmer-Dachgeschosswohnung in Rendsburg','💶 375 € · 24768 Rendsburg','🛏 2 кімн. · 📐 35.48 м² · 📍 ≈2.0 км','🔗 Відкрити оголошення'].join('\n');
    const update={update_id:880001,callback_query:{id:'query-880001',from:{id:USER,is_bot:false},chat_instance:'1',data:`jc:3539020756:u${USER}`,
      message:{message_id:880,date:Math.floor(Date.now()/1000),chat:{id:USER,type:'private'},from:{id:999999999,is_bot:true,username:'ZaskaletaInfoBot'},photo:[{file_id:'x',file_unique_id:'x',width:1,height:1}],caption}}};
    const before=f.calls.length;
    const { handle }=await import('../src/runtime.mjs');
    await handle(new Request('https://fixture.example/telegram/stateless',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':f.env.TELEGRAM_WEBHOOK_SECRET},body:JSON.stringify(update)}),f.env,Date.now(),f.transport);
    const answers=callbackAnswers(f,before);
    assert.equal(answers.length,1);
    assert.notEqual(answers[0].body.text,STALE);
    const prompt=f.calls.slice(before).find(call=>call.method==='sendMessage');
    assert.match(String(prompt?.body?.text||''),/Перевірка під Jobcenter/u);
    assert.match(String(prompt.body.text),/Локація: 24768 Rendsburg/u);
    assert.match(String(prompt.body.text),/Крок 1\/2/u);
    // Another user's card stays stale.
    const foreign=JSON.parse(JSON.stringify(update));
    foreign.update_id=880002; foreign.callback_query.id='query-880002'; foreign.callback_query.data='jc:3539020756:u4242';
    const beforeForeign=f.calls.length;
    await handle(new Request('https://fixture.example/telegram/stateless',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':f.env.TELEGRAM_WEBHOOK_SECRET},body:JSON.stringify(foreign)}),f.env,Date.now(),f.transport);
    assert.equal(f.calls.slice(beforeForeign).filter(call=>call.method==='sendMessage').length,0);
  }finally{f.close();}
});

test('rent check accepts all three sums in one message, as its prompt offers', async()=>{
  const f=await fixture(STAGING);
  try{
    const prompt=await f.send('',{callback:'hka:r:2:2:Rendsburg',previous:{message_id:9,text:'Житло — Rendsburg, 2 кімнати.\nОсіб: 2\n\n✅ Дані збережено.\nЩо саме потрібно?'}});
    assert.match(lastText(prompt),/^Перевірка оренди — Rendsburg, 2 кімнати\./u);
    const result=await f.send('Kaltmiete 450, Nebenkosten 90, Heizkosten 70');
    assert.match(lastText(result),/^Перевірка оренди — Rendsburg, 2 кімнати\./u);
    assert.match(lastText(result),/Kaltmiete \+ Betriebskosten: 540 €/u);
    assert.doesNotMatch(lastText(result),/Вкажіть місто або район/u);
  }finally{f.close();}
});
