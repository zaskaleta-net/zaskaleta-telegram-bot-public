import test from 'node:test';
import assert from 'node:assert/strict';

import { housingListingMedia } from '../src/housing-provider.mjs';
import { sendHousingMediaReply } from '../src/telegram-media.mjs';
import {
  finalSearchControlsMarkup,
  deliverDistrictTerminal
} from '../src/runtime-jobcenter.mjs';
import { normalizeStandaloneHouseholdRequest } from '../src/runtime-housing-search.mjs';
import { knownHousingLocation, parseHouseholdSize } from '../src/housing-language.mjs';

const config = { chatId:321, token:'12345:' + 'A'.repeat(30) };
const jpeg = new Uint8Array([0xff,0xd8,0xff,0xd9]);

function ok(result, status = 200) {
  return new Response(JSON.stringify({ ok:true, result }), {
    status,
    headers:{ 'content-type':'application/json' }
  });
}

test('60414 listing media preserves a no-photo result at its original index', () => {
  const cards = housingListingMedia({
    criteria:{ location:'Itzehoe', rooms:'3-4', amount:900, type:'Bruttokaltmiete', radiusKm:15 },
    listings:[
      {
        title:'Ohne Foto',
        price:700,
        location:'Itzehoe',
        rooms:3,
        areaSqm:70,
        url:'https://www.kleinanzeigen.de/s-anzeige/ohne-foto/3506905001-203-1'
      },
      {
        title:'Mit Foto',
        price:750,
        location:'Itzehoe',
        rooms:3,
        areaSqm:72,
        imageUrl:'https://img.example.test/a.jpg',
        url:'https://www.kleinanzeigen.de/s-anzeige/mit-foto/3506905002-203-1'
      }
    ]
  });

  assert.equal(cards.length,2);
  assert.equal(cards[0].type,'text');
  assert.equal(cards[0].media,null);
  assert.match(cards[0].caption,/^<b>1\. Ohne Foto/u);
  assert.equal(cards[1].type,'photo');
  assert.equal(cards[1].media,'https://img.example.test/a.jpg');
  assert.match(cards[1].caption,/^<b>2\. Mit Foto/u);
});

test('60414 mixed photo availability still delivers every listing and a terminal control panel last', async () => {
  const calls = [];
  const media = [
    {
      type:'text',
      media:null,
      caption:'<b>1. Ohne Foto</b>\n<a href="https://www.kleinanzeigen.de/s-anzeige/ohne-foto/3506905001-203-1">🔗 Відкрити оголошення</a>',
      parse_mode:'HTML'
    },
    {
      type:'photo',
      media:'https://img.example.test/a.jpg',
      caption:'<b>2. Mit Foto</b>\n<a href="https://www.kleinanzeigen.de/s-anzeige/mit-foto/3506905002-203-1">🔗 Відкрити оголошення</a>',
      parse_mode:'HTML'
    }
  ];
  const controls = finalSearchControlsMarkup({
    location:'Itzehoe',
    rooms:'3-4',
    persons:3,
    radius:15,
    page:0,
    hasMore:true
  });

  const transport = async (url, options = {}) => {
    if (url === 'https://img.example.test/a.jpg') {
      return new Response(jpeg,{ status:200, headers:{ 'content-type':'image/jpeg' } });
    }
    const method = String(url).split('/').at(-1);
    calls.push(method);
    if (method === 'sendMessage') {
      const body = JSON.parse(options.body);
      return ok({ message_id:100 + calls.length, chat:{ id:321 }, text:body.text });
    }
    if (method === 'sendPhoto') {
      return ok({ message_id:100 + calls.length, chat:{ id:321 } });
    }
    throw new Error('unexpected transport ' + url);
  };

  const result = await sendHousingMediaReply({
    config,
    media,
    text:'fallback',
    replyMarkup:null,
    transport,
    separateItems:true,
    postText:delivery => `Підсумок: ${delivery.sent}/${delivery.requested}`,
    postReplyMarkup:controls
  });

  assert.equal(result.status,'sent');
  assert.equal(result.mediaCount,2);
  assert.equal(result.requestedCount,2);
  assert.equal(result.partial,undefined);
  assert.deepEqual(calls,['sendMessage','sendPhoto','sendMessage']);
  assert.equal(result.postTextDelivered,true);
});

test('60414 final local controls keep pagination below listings together with radius and whole-Kreis', () => {
  const markup = finalSearchControlsMarkup({
    location:'Itzehoe',
    rooms:'3-4',
    persons:3,
    radius:15,
    page:0,
    hasMore:true
  });
  assert.equal(markup.inline_keyboard[0][0].text,'➡️ Наступні оголошення');
  assert.equal(markup.inline_keyboard[0][0].callback_data,'jrp:1');
  assert.deepEqual(markup.inline_keyboard[1].map(button => button.text),['✅ 15 км','20 км','25 км']);
  assert.match(markup.inline_keyboard[2][0].text,/Шукати весь район/u);
});

test('60414 final district controls keep next-page self-contained and whole-Kreis selected', () => {
  const markup = finalSearchControlsMarkup({
    location:'Itzehoe',
    rooms:'3-4',
    persons:3,
    districtSelected:true,
    page:0,
    hasMore:true
  });
  assert.equal(markup.inline_keyboard[0][0].callback_data,'jcp:1:3:3-4:Itzehoe');
  assert.match(markup.inline_keyboard.at(-1)[0].text,/✅ .*Шукати весь район/u);
});

test('60414 whole-Kreis terminal is a new visible message after progress is closed', async () => {
  const calls = [];
  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === 'editMessageText') {
      return ok({ message_id:77, chat:{ id:321 }, text:body.text });
    }
    if (method === 'sendMessage') {
      return ok({ message_id:78, chat:{ id:321 }, text:body.text });
    }
    throw new Error('unexpected ' + url);
  };

  const controls = finalSearchControlsMarkup({
    location:'Wentorf bei Hamburg',
    rooms:'3-4',
    persons:4,
    districtSelected:true,
    hasMore:false
  });
  const result = await deliverDistrictTerminal({
    config,
    chatId:321,
    progressMessageId:77,
    text:'✅ Пошук по всьому Jobcenter/Kreis Herzogtum Lauenburg завершено.',
    replyMarkup:controls,
    transport,
    visibleNewMessage:true
  });

  assert.equal(result.ok,true);
  assert.equal(result.mode,'sent-visible');
  assert.deepEqual(calls.map(call => call.method),['editMessageText','sendMessage']);
  assert.match(calls[0].body.text,/Результат і керування нижче/u);
  assert.match(calls[1].body.text,/Herzogtum Lauenburg/u);
  assert.match(calls[1].body.reply_markup.inline_keyboard.at(-1)[0].text,/Шукати весь район/u);
});

test('60414 Norderstedt compact household phrase preserves both city and five people', async () => {
  const text="Norderstedt: Сім'я 5 людей!";
  assert.equal(knownHousingLocation(text),'Norderstedt');
  assert.equal(parseHouseholdSize(text),5);

  const update = {
    update_id:60414001,
    message:{
      message_id:1,
      date:1700000000,
      chat:{ id:123, type:'private' },
      from:{ id:123, is_bot:false },
      text
    }
  };
  const request = new Request('https://worker.example/telegram/stateless',{
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(update)
  });
  const normalized = await normalizeStandaloneHouseholdRequest(request);
  const body = await normalized.json();
  assert.equal(body.message.text,'Norderstedt житло для 5 осіб');
  assert.equal(parseHouseholdSize(body.message.text),5);
  assert.equal(knownHousingLocation(body.message.text),'Norderstedt');
});
