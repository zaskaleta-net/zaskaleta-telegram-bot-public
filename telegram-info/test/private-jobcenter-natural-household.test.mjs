import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';

const NOW = Date.UTC(2026, 8, 12, 16, 35, 0);
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const USER = 777;
const GROUP = -1001234567890;

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

const JOBCENTER_PROMPT = 'Тема: Jobcenter. Вкажіть місто або район і що саме потрібно: Bürgergeld, Bescheid, Mitwirkung, оренда/житло, строк або підготовка листа.';

function request(text, previous = JOBCENTER_PROMPT, updateId = 1) {
  const message = {
    message_id:100 + updateId,
    date:NOW / 1000,
    chat:{ id:USER, type:'private' },
    from:{ id:USER, is_bot:false },
    text,
    reply_to_message:{
      message_id:50 + updateId,
      chat:{ id:USER, type:'private' },
      from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
      text:previous
    }
  };
  return new Request('https://pilot.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
    body:JSON.stringify({ update_id:updateId, message })
  });
}

async function run(text, updateId = 1) {
  const calls = [];
  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    assert.equal(method, 'sendMessage');
    const body = JSON.parse(options.body);
    calls.push(body);
    return new Response(JSON.stringify({ ok:true, result:{ message_id:900, chat:{ id:USER } } }), {
      status:200,
      headers:{ 'content-type':'application/json' }
    });
  };
  const response = await handle(request(text, JOBCENTER_PROMPT, updateId), env(), NOW, transport);
  const result = await response.json();
  assert.equal(result.delivered, true);
  assert.equal(calls.length, 1);
  return calls[0];
}

test('Jobcenter prompt infers housing from Plön plus explicit family composition and reuses all four persons', async () => {
  const message = await run("Плен для сім'ї двоє дітей та двоє дорослих", 1);

  assert.match(message.text, /^Тема: житло — Plön\. Локацію вже визначено\./mu);
  assert.match(message.text, /^Осіб: 4$/mu);
  assert.match(message.text, /Орієнтири Jobcenter Kreis Plön/u);
  assert.match(message.text, /Площа-орієнтир: 90 м²/u);
  assert.match(message.text, /Оренда без опалення: до 800 € на місяць/u);
  assert.match(message.text, /Для пошуку підтвердьте кількість кімнат: 3–4/u);
  assert.doesNotMatch(message.text, /Що саме потрібно\?|кількість осіб \(1–20\)/u);
});

test('Rendsburg keeps the recognized city when a natural four-person Jobcenter housing request is rewritten', async () => {
  const message = await run("Рендсбург житло для сім'ї двоє дітей та двоє дорослих", 3);

  assert.match(message.text, /Rendsburg/u);
  assert.match(message.text, /^Осіб: 4$/mu);
  assert.doesNotMatch(message.text, /Вкажіть місто або район|не вдалося однозначно визначити місто|кількість осіб \(1–20\)/u);
});

test('common Ukrainian Pinneberg spelling is normalized and keeps the four-person household', async () => {
  const message = await run("Пеніберг житло для сім'ї двоє дітей та двоє дорослих", 4);

  assert.match(message.text, /Pinneberg/u);
  assert.match(message.text, /^Осіб: 4$/mu);
  assert.doesNotMatch(message.text, /Вкажіть місто або район|не вдалося однозначно визначити місто|кількість осіб \(1–20\)/u);
});

test('explicit non-housing Jobcenter intent is not rewritten just because household composition is present', async () => {
  const message = await run('Плен, двоє дорослих і двоє дітей, Bürgergeld', 2);

  assert.doesNotMatch(message.text, /^Тема: житло —/mu);
  assert.match(message.text, /Jobcenter|Bürgergeld/u);
});
