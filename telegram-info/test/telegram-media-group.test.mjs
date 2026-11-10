import test from 'node:test';
import assert from 'node:assert/strict';
import { sendHousingMediaReply } from '../src/telegram-media.mjs';

const GROUP = -1001234567890;
const config = { chatId:GROUP, token:'12345:' + 'A'.repeat(30) };
const jpeg = new Uint8Array([0xff,0xd8,0xff,0xd9]);
const media = [
  { media:'https://img.example.test/a.jpg', caption:'<b>1. A</b>\n<a href="https://www.kleinanzeigen.de/s-anzeige/a/3506905833-203-1">🔗 Відкрити оголошення</a>', parse_mode:'HTML' },
  { media:'https://img.example.test/b.jpg', caption:'<b>2. B</b>\n<a href="https://www.kleinanzeigen.de/s-anzeige/b/3506905999-203-1">🔗 Відкрити оголошення</a>', parse_mode:'HTML' }
];
const ok = result => new Response(JSON.stringify({ok:true,result}), {status:200,headers:{'content-type':'application/json'}});

test('separate group listing cards keep the first reply target and every Jobcenter callback is owner-bound', async () => {
  const cards=[];
  const transport=async(url,options={})=>{
    if(url.startsWith('https://img.example.test/')) return new Response(jpeg,{status:200,headers:{'content-type':'image/jpeg'}});
    assert.match(url,/sendPhoto$/);
    const reply=options.body.get('reply_parameters');
    if(cards.length===0) assert.deepEqual(JSON.parse(reply),{message_id:77,allow_sending_without_reply:false});
    else assert.equal(reply,null);
    const markup=JSON.parse(options.body.get('reply_markup'));
    assert.equal(markup.inline_keyboard[0][0].text,'🔗 Відкрити оголошення');
    assert.match(markup.inline_keyboard[1][0].callback_data,/^jc:\d+:u702$/);
    cards.push(markup);
    return ok({message_id:100+cards.length,chat:{id:GROUP}});
  };
  const result=await sendHousingMediaReply({config,media,text:'fallback',replyMarkup:null,transport,replyToMessageId:77,ownerUserId:702});
  assert.equal(result.status,'sent');
  assert.equal(result.mediaCount,2);
  assert.equal(result.separateCards,true);
  assert.equal(cards.length,2);
});

test('legacy group album replies to the triggering message and Jobcenter callbacks are owner-bound', async () => {
  const callbacks = [];
  const transport = async (url, options={}) => {
    if (url.startsWith('https://img.example.test/')) return new Response(jpeg,{status:200,headers:{'content-type':'image/jpeg'}});
    if (url.endsWith('/sendMediaGroup')) {
      assert.equal(options.body.get('chat_id'), String(GROUP));
      assert.deepEqual(JSON.parse(options.body.get('reply_parameters')), { message_id:77, allow_sending_without_reply:false });
      return ok([{message_id:100,chat:{id:GROUP}},{message_id:101,chat:{id:GROUP}}]);
    }
    if (url.endsWith('/editMessageReplyMarkup')) {
      const body=JSON.parse(options.body);
      assert.equal(body.chat_id,GROUP);
      const callback=body.reply_markup.inline_keyboard[1][0].callback_data;
      callbacks.push(callback);
      assert.match(callback,/^jc:\d+:u702$/);
      return ok({message_id:body.message_id,chat:{id:GROUP}});
    }
    throw new Error('unexpected '+url);
  };
  const result=await sendHousingMediaReply({config,media,text:'fallback',replyMarkup:null,transport,replyToMessageId:77,ownerUserId:702,separateItems:false});
  assert.equal(result.status,'sent');
  assert.equal(result.mediaCount,2);
  assert.deepEqual(callbacks,['jc:3506905833:u702','jc:3506905999:u702']);
});

test('text fallback keeps both reply targeting and owner-bound Jobcenter action', async () => {
  const replyMarkup={inline_keyboard:[[{text:'1. Відкрити оголошення',url:'https://www.kleinanzeigen.de/s-anzeige/a/3506905833-203-1'}]]};
  const expectedCallbacks=['jc:3506905833:u702','jc:3506905999:u702'];
  const cards=[];
  const transport=async(url,options={})=>{
    if(url.startsWith('https://img.example.test/')) return new Response('blocked',{status:403});
    assert.match(url,/sendMessage$/);
    const body=JSON.parse(options.body);
    assert.equal(body.chat_id,GROUP);
    if(cards.length===0) assert.deepEqual(body.reply_parameters,{message_id:88,allow_sending_without_reply:false});
    else assert.equal(body.reply_parameters,undefined);
    const callbacks=body.reply_markup.inline_keyboard.flat().map(button=>button.callback_data).filter(Boolean);
    assert.ok(callbacks.includes(expectedCallbacks[cards.length]));
    assert.equal(new Set(callbacks).size,callbacks.length,'a Jobcenter callback must not be duplicated on one card');
    cards.push(callbacks);
    return ok({message_id:102+cards.length,chat:{id:GROUP}});
  };
  const result=await sendHousingMediaReply({config,media,text:'fallback',replyMarkup,transport,replyToMessageId:88,ownerUserId:702});
  assert.equal(result.status,'sent');
  assert.equal(result.mediaFallback,true);
  assert.equal(result.mediaCount,2);
  assert.equal(result.partial,undefined);
  assert.equal(cards.length,2);
});


test('single photo and legacy album preserve complete long HTML links through Telegram transport', async () => {
  const caption = '<b>1. A &amp; B</b>\n<a href="https://www.kleinanzeigen.de/s-anzeige/a/3506905833-203-1">Відкрити</a>\n<a href="https://www.google.com/search?q=' + 'x'.repeat(1200) + '">Інші джерела</a>';
  for (const count of [1, 2]) {
    let sends = 0;
    const result = await sendHousingMediaReply({config, media:media.slice(0,count).map(item=>({...item,caption})), text:'fallback', separateItems:false, transport:async(url,options={})=>{
      if(url.startsWith('https://img.example.test/'))return new Response(jpeg,{headers:{'content-type':'image/jpeg'}});
      if(url.endsWith('/editMessageReplyMarkup'))return ok({message_id:100,chat:{id:GROUP}});
      sends++;
      const captions = count === 1 ? [options.body.get('caption')] : JSON.parse(options.body.get('media')).map(item=>item.caption);
      for(const [index,actual] of captions.entries()) {
        assert.equal(actual,caption.replace('<b>1.',`<b>${index+1}.`));
        assert.equal((actual.match(/<a /g)||[]).length,2);
        assert.equal((actual.match(/<\/a>/g)||[]).length,2);
      }
      return count===1 ? ok({message_id:100,chat:{id:GROUP}}) : ok([{message_id:100,chat:{id:GROUP}},{message_id:101,chat:{id:GROUP}}]);
    }});
    assert.equal(result.status,'sent');
    assert.equal(sends,1);
  }
});
