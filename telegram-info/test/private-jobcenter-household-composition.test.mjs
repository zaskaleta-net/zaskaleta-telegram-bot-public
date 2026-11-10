import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';

const NOW = Date.UTC(2026, 8, 12, 9, 50, 0);
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const USER = 777;
const GROUP = -1001234567890;
const JOBCENTER_PROMPT = 'Тема: Jobcenter. Вкажіть місто або район і що саме потрібно: Bürgergeld, Bescheid, Mitwirkung, оренда/житло, строк або підготовка листа. Не надсилайте номер клієнта чи повні копії документів.';

function env() {
  return {
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_ALLOWED_CHAT_IDS:String(GROUP),
    TELEGRAM_ADMIN_USER_IDS:String(USER),
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_DELIVERY_ENABLED:'false'
  };
}

function request(text) {
  return new Request('https://pilot.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
    body:JSON.stringify({
      update_id:1,
      message:{
        message_id:101,
        date:NOW / 1000,
        chat:{ id:USER, type:'private' },
        from:{ id:USER, is_bot:false },
        text,
        reply_to_message:{
          message_id:50,
          chat:{ id:USER, type:'private' },
          from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
          text:JOBCENTER_PROMPT
        }
      }
    })
  });
}

function capture() {
  const calls = [];
  return {
    calls,
    transport:async (url, options) => {
      const method = url.split('/').at(-1);
      const body = JSON.parse(options.body);
      calls.push({ method, body });
      return new Response(JSON.stringify({ ok:true, result:{ message_id:901, chat:{ id:USER } } }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
  };
}

test('Jobcenter reply with Plön and two adults plus two children reuses all four persons', async () => {
  const c = capture();
  const response = await handle(request("Житло для сім'ї двоє дітей та двоє дорослих плен"), env(), NOW, c.transport);
  const result = await response.json();

  assert.equal(result.delivered, true);
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].method, 'sendMessage');
  assert.match(c.calls[0].body.text, /Тема: житло — Plön\./u);
  assert.match(c.calls[0].body.text, /^Осіб: 4$/mu);
  assert.match(c.calls[0].body.text, /Jobcenter/u);
  assert.doesNotMatch(c.calls[0].body.text, /вкажіть кількість осіб \(1–20\)/iu);
});
