import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, USER, GROUP } from './runtime-fixture.mjs';
import { normalizeKeyboardPayload } from '../src/runtime-keyboard.mjs';

const menuCount=message=>(message.reply_markup?.inline_keyboard||[]).flat().filter(button=>button.callback_data==='nav:menu').length;
function doesNotReplaceTypingKeyboard(messages) {
  assert.ok(messages.length);
  for(const message of messages) {
    assert.equal(message.reply_markup?.keyboard,undefined,`Reply keyboard resent with: ${message.text?.slice(0,60)}`);
    assert.notEqual(message.reply_markup?.remove_keyboard,true);
    assert.notEqual(message.reply_markup?.force_reply,true);
    assert.equal(menuCount(message),1);
  }
}

test('typing after inline menu and receiving an ordinary reply does not reopen a reply keyboard',async()=>{
  const f=await fixture();try {
    const opened=await f.send('/menu');
    const resetMessages=()=>f.calls.filter(call=>call.method==='sendMessage' && call.body.reply_markup?.remove_keyboard===true);
    const resetPulses=()=>f.calls.filter(call=>call.method==='sendMessage' && Array.isArray(call.body.reply_markup?.keyboard));
    const resetForceReplies=()=>f.calls.filter(call=>call.method==='sendMessage' && call.body.reply_markup?.force_reply===true);
    const cleanupDeletes=f.calls.filter(call=>call.method==='deleteMessage').length;
    assert.equal(resetForceReplies().length,0,'migration/reset must never create a new private ForceReply');
    assert.equal(resetPulses().length,1);
    assert.equal(resetMessages().length,1);
    const pulse=resetPulses()[0].body.reply_markup;
    assert.equal(pulse.one_time_keyboard,true);
    assert.equal(pulse.is_persistent,false);
    assert.equal(pulse.input_field_placeholder,undefined);
    assert.notEqual(pulse.force_reply,true);
    assert.equal(cleanupDeletes,0,'keyboard reset messages must survive the same update so Telegram Android can persist the replacement keyboard state');
    assert.ok(Array.isArray(opened.last.reply_markup?.inline_keyboard));
    assert.equal(opened.last.reply_markup?.keyboard,undefined);
    assert.ok(opened.last.reply_markup.inline_keyboard.flat().some(button=>button.callback_data==='nav:housing'));

    const ordinary=await f.send('дякую');
    doesNotReplaceTypingKeyboard(ordinary.messages);
    assert.equal(f.calls.filter(call=>call.method==='deleteMessage').length,cleanupDeletes+1,'pending keyboard reset should retire only the temporary pulse and retain the remove-keyboard anchor');
    assert.equal(resetForceReplies().length,0,'completed migration must still never emit ForceReply');
    assert.equal(resetPulses().length,1,'completed migration must not resend the one-time keyboard pulse');
    assert.equal(resetMessages().length,1,'completed migration must not resend the keyboard removal');

    const reopen=await f.send('',{callback:'nav:menu'});
    assert.ok(Array.isArray(reopen.last.reply_markup?.inline_keyboard));
    assert.equal(reopen.last.reply_markup?.keyboard,undefined);
    assert.ok(reopen.last.reply_markup.inline_keyboard.flat().some(button=>button.callback_data==='nav:jobcenter'));
    assert.equal(resetPulses().length,1,'nav:menu must not restart a completed legacy pulse');
    assert.equal(resetMessages().length,1,'nav:menu must not restart a completed legacy reset');
    doesNotReplaceTypingKeyboard((await f.send('дякую')).messages);
  } finally {f.close();}
});

test('legacy private ForceReply is virtualized into durable server prompt context',async()=>{
  const f=await fixture();try {
    const prompt=await f.send('/start jobcenter_norms');
    assert.match(prompt.last.text,/Норми Jobcenter — крок 1\/2/u);
    assert.notEqual(prompt.last.reply_markup?.force_reply,true);
    assert.equal(prompt.last.reply_markup?.input_field_placeholder,undefined);

    const city=await f.send('Lübeck');
    assert.match(city.last.text,/Норми Jobcenter — крок 2\/2/u);
    assert.match(city.last.text,/Lübeck/u);
    assert.notEqual(city.last.reply_markup?.force_reply,true);
    assert.equal(city.last.reply_markup?.input_field_placeholder,undefined);
  } finally {f.close();}
});

test('Lübeck housing and radius responses retain inline controls without replacing the typing keyboard',async()=>{
  const f=await fixture();try {
    await f.send('/start');
    const city=await f.send('Любек дві жінки');
    doesNotReplaceTypingKeyboard(city.messages);
    const rooms=await f.send('',{callback:'hkr:3:L%C3%BCbeck',previous:city.last});
    doesNotReplaceTypingKeyboard(rooms.messages);
    const guideline=await f.send('',{callback:'hka:j:2:3:L%C3%BCbeck',previous:rooms.last});
    doesNotReplaceTypingKeyboard(guideline.messages);
    const search=await f.send('',{callback:'jcr:15:2:3:L%C3%BCbeck',previous:guideline.last});
    doesNotReplaceTypingKeyboard(search.messages);
    assert.ok(search.messages.some(message=>/Lübeck/u.test(String(message.text||''))));
    const callbacks=search.messages.flatMap(message=>(message.reply_markup?.inline_keyboard||[]).flat().map(button=>button.callback_data));
    assert.ok(callbacks.includes('jcr:15:2:3:L%C3%BCbeck'));
    assert.ok(callbacks.includes('jcr:20:2:3:L%C3%BCbeck'));
  } finally {f.close();}
});

test('manual housing room and people input never activates Telegram ForceReply',async()=>{
  const f=await fixture();try {
    await f.send('/start');
    const city=await f.send('Любек дві жінки');
    const manualRooms=await f.send('',{callback:'hkr:x:L%C3%BCbeck',previous:city.last});
    assert.match(manualRooms.last.text,/кількість кімнат/iu);
    assert.notEqual(manualRooms.last.reply_markup?.force_reply,true);
    assert.equal(manualRooms.last.reply_markup?.keyboard,undefined);

    const rooms=await f.send('',{callback:'hkr:3:L%C3%BCbeck',previous:city.last});
    const manualPeople=await f.send('',{callback:'hkp:x:3:L%C3%BCbeck',previous:rooms.last});
    assert.match(manualPeople.last.text,/кількість людей/iu);
    assert.notEqual(manualPeople.last.reply_markup?.force_reply,true);
    assert.equal(manualPeople.last.reply_markup?.keyboard,undefined);
  } finally {f.close();}
});

test('cost input retains durable follow-up state without reinstalling the main keyboard',async()=>{
  const f=await fixture();try {
    const prompt=await f.send('',{callback:'hka:r:2:3:L%C3%BCbeck'});
    doesNotReplaceTypingKeyboard(prompt.messages);
    const amount=await f.send('700');
    doesNotReplaceTypingKeyboard(amount.messages);
    assert.match(amount.last.text,/Kaltmiete|Warmmiete/u);
    const label=await f.send('Kaltmiete');
    doesNotReplaceTypingKeyboard(label.messages);
    assert.match(label.last.text,/700/u);
    assert.match(label.last.text,/Betriebskosten/u);
    await f.send('/menu');
    const afterMenu=await f.send('800');
    assert.match(afterMenu.last.text,/Вкажіть місто або район/u);
    assert.doesNotMatch(afterMenu.last.text,/Перевірка оренди — Lübeck/u);
    await f.send('',{callback:'hka:r:2:3:L%C3%BCbeck'});
    await f.send('900');
    await f.send('/menu');
    await f.send('',{callback:'hka:r:2:3:L%C3%BCbeck'});
    const freshLabel=await f.send('Kaltmiete');
    assert.doesNotMatch(freshLabel.last.text,/900/u);
    assert.match(freshLabel.last.text,/Ще потрібні: Kaltmiete/u);
  } finally {f.close();}
});

test('explicit menu permission is limited to the requesting private chat and renders inline navigation',()=>{
  const plain={chat_id:USER,text:'Вітаємо!'};
  const own=normalizeKeyboardPayload(plain,{mainMenuChatId:USER});
  assert.ok(Array.isArray(own.reply_markup?.inline_keyboard));
  assert.equal(own.reply_markup?.keyboard,undefined);
  assert.ok(own.reply_markup.inline_keyboard.flat().some(button=>button.callback_data==='nav:housing'));
  doesNotReplaceTypingKeyboard([normalizeKeyboardPayload({...plain,chat_id:USER+1},{mainMenuChatId:USER})]);
  const group={chat_id:GROUP,text:'Групове повідомлення'};
  assert.deepEqual(normalizeKeyboardPayload(group,{mainMenuChatId:USER}),group);
  const report={chat_id:USER,text:'Надішліть опис помилки',reply_markup:{force_reply:true}};
  assert.deepEqual(normalizeKeyboardPayload(report),report);
});


test('Jobcenter action callback keeps Eutin rooms and household instead of asking twice',async()=>{
  const f=await fixture();try {
    await f.send('/start');
    const city=await f.send('Eutin 4 особи');
    const rooms=await f.send('',{callback:'hkr:4:Eutin',previous:city.last});
    assert.match(rooms.last.text,/Житло — Eutin, 4 кімнати/u);
    assert.match(rooms.last.text,/Осіб: 4/u);
    const guideline=await f.send('',{callback:'hka:j:4:4:Eutin',previous:rooms.last});
    const text=guideline.messages.map(message=>String(message.text||'')).join('\n');
    assert.doesNotMatch(text,/Вкажіть кількість кімнат|Вкажіть кількість людей/iu);
    // The guideline response may identify the jurisdiction (Kreis Ostholstein)
    // rather than repeat the municipality name. The regression contract is
    // preserved criteria + no duplicate prompts + fail-closed jurisdiction.
    assert.match(text,/Ostholstein/u);
    assert.match(rooms.last.text,/Осіб:\s*4/iu);
  } finally {f.close();}
});
