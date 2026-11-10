import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliverDistrictTerminal,
  districtSummaryPayload,
  districtSearchStateUnavailableText
} from '../src/runtime-jobcenter.mjs';

const TOKEN = '123456789:' + 'A'.repeat(35);
const USER = 777777777;

function config() {
  return { token:TOKEN, chatId:USER };
}

test('60160 whole-Kreis terminal edits the visible searching message instead of appending another progress line', async () => {
  const calls = [];
  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    calls.push({ method, body });
    if (method === 'editMessageText') {
      return new Response(JSON.stringify({ ok:true, result:{ message_id:321, chat:{ id:USER } } }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    throw new Error(`unexpected network call: ${url}`);
  };

  const terminal = await deliverDistrictTerminal({
    config:config(),
    chatId:USER,
    progressMessageId:321,
    text:'✅ Пошук по всьому Jobcenter/Kreis Dithmarschen завершено.',
    transport
  });

  assert.equal(terminal.ok,true);
  assert.equal(terminal.mode,'edited');
  assert.deepEqual(calls.map(call => call.method), ['editMessageText']);
  assert.equal(calls[0].body.message_id,321);
  assert.match(calls[0].body.text,/завершено/u);
});

test('60160 terminal falls back to one final sendMessage when progress edit is rejected', async () => {
  const calls = [];
  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    calls.push({ method, body });
    if (method === 'editMessageText') {
      return new Response(JSON.stringify({ ok:false, description:'message unavailable' }), {
        status:400,
        headers:{ 'content-type':'application/json' }
      });
    }
    if (method === 'sendMessage') {
      return new Response(JSON.stringify({ ok:true, result:{ message_id:322, chat:{ id:USER } } }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    throw new Error(`unexpected network call: ${url}`);
  };

  const terminal = await deliverDistrictTerminal({
    config:config(),
    chatId:USER,
    progressMessageId:321,
    text:'✅ Пошук по всьому Jobcenter/Kreis Herzogtum Lauenburg завершено.',
    transport
  });

  assert.equal(terminal.ok,true);
  assert.equal(terminal.mode,'sent');
  assert.deepEqual(calls.map(call => call.method), ['editMessageText','sendMessage']);
  assert.match(calls[1].body.text,/завершено/u);
});

test('60160 district summary is terminal before cards and carries pagination when more results exist', () => {
  const payload = districtSummaryPayload({
    jurisdiction:'Herzogtum Lauenburg',
    listings:[
      { location:'23881 Bälau' },
      { location:'23879 Mölln' },
      { location:'23909 Ratzeburg' }
    ],
    pageStart:0,
    total:8,
    hasMore:true,
    location:'Ratzeburg',
    persons:4,
    rooms:'3-4'
  });

  assert.match(payload.text,/Пошук по всьому Jobcenter\/Kreis Herzogtum Lauenburg завершено/u);
  assert.match(payload.text,/Показано 1–3 із 8/u);
  assert.deepEqual(payload.reply_markup.inline_keyboard[0][0], {
    text:'➡️ Наступні оголошення',
    callback_data:'jcp:1:4:3-4:Ratzeburg'
  });
});

test('60160 lock outage is explicit instead of starting an unprotected duplicate-prone search', () => {
  const text = districtSearchStateUnavailableText('Dithmarschen');
  assert.match(text,/не запущено/u);
  assert.match(text,/Захист від дубльованого паралельного запуску тимчасово недоступний/u);
});
