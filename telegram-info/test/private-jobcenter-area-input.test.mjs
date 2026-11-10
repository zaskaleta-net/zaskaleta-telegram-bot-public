import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/worker-entry-beta.mjs';

const NOW = Date.UTC(2026, 8, 11, 17, 45, 0);
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const USER = 777;

const env = {
  TELEGRAM_RELEASE_APPROVED:'pilot-v1',
  TELEGRAM_PILOT_MODE:'allowlist',
  TELEGRAM_ALLOWED_CHAT_IDS:String(USER),
  TELEGRAM_ADMIN_USER_IDS:String(USER),
  TELEGRAM_BOT_TOKEN:TOKEN,
  TELEGRAM_WEBHOOK_SECRET:SECRET,
  TELEGRAM_INGRESS_ENABLED:'true',
  TELEGRAM_DELIVERY_ENABLED:'false'
};

test('concrete Jobcenter check parses area ending in Unicode square metres', async () => {
  const update = {
    update_id:91,
    message:{
      message_id:191,
      date:NOW / 1000,
      chat:{ id:USER, type:'private' },
      from:{ id:USER, is_bot:false },
      text:'Kaltmiete 500, Betriebskosten 100, Heizkosten 80, 72 м²',
      reply_to_message:{
        message_id:190,
        chat:{ id:USER, type:'private' },
        from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
        text:'🏛 Перевірити під Jobcenter — крок 3/3\nЛокація: Plön\nДомогосподарство: 3\n\nНадішліть суми конкретного житла окремо:'
      }
    }
  };

  let sent = null;
  const transport = async (url, options) => {
    assert.match(url, /\/sendMessage$/u);
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok:true, result:{ message_id:999, chat:{ id:USER } } }), {
      status:200,
      headers:{ 'content-type':'application/json' }
    });
  };

  const response = await handle(new Request('https://pilot.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
    body:JSON.stringify(update)
  }), env, NOW, transport);

  const result = await response.json();
  assert.equal(result.mode, 'private-explicit-intent');
  assert.equal(result.delivered, true);
  assert.ok(sent);
  assert.match(sent.text, /Площа житла: 72 м²\./u);
  assert.match(sent.text, /Фактично без опалення: 600 €/u);
});
