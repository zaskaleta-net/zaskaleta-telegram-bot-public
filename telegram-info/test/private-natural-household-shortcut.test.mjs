import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';

const NOW = 1700000000000;
const TOKEN = '12345:' + 'A'.repeat(30);
const SECRET = 'B'.repeat(32);

function env() {
  return {
    TELEGRAM_ALLOWED_CHAT_IDS:'123',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_DELIVERY_ENABLED:'false'
  };
}

function request(text) {
  const update = {
    update_id:1,
    message:{
      message_id:2,
      date:NOW / 1000,
      chat:{ id:123, type:'private' },
      from:{ id:123, is_bot:false },
      text
    }
  };
  return new Request('https://pilot.example/telegram/stateless', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-telegram-bot-api-secret-token':SECRET
    },
    body:JSON.stringify(update)
  });
}

test('standalone Trittau household composition continues into housing instead of generic fallback', async () => {
  let payload = null;
  const transport = async (url, options = {}) => {
    assert.match(String(url), /\/sendMessage$/u);
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok:true, result:{ message_id:99, chat:{ id:123 } } }), {
      status:200,
      headers:{ 'content-type':'application/json' }
    });
  };

  const response = await handle(request('Тріттау двоє дорослих і двоє дітей'), env(), NOW, transport);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.delivered, true);
  assert.ok(payload);
  assert.match(payload.text, /Тема: житло — Trittau/u);
  assert.match(payload.text, /Осіб: 4/u);
  assert.doesNotMatch(payload.text, /База перевірених офіційних джерел ще готується/u);
});
