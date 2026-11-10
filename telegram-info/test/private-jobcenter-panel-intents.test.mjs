import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/worker-entry-beta.mjs';

const NOW = Date.UTC(2026, 8, 11, 17, 30, 0);
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

function request(text, replyToText = null, updateId = 1) {
  const message = {
    message_id:100 + updateId,
    date:NOW / 1000,
    chat:{ id:USER, type:'private' },
    from:{ id:USER, is_bot:false },
    text
  };
  if (replyToText) {
    message.reply_to_message = {
      message_id:50 + updateId,
      chat:{ id:USER, type:'private' },
      from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
      text:replyToText
    };
  }
  return new Request('https://pilot.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
    body:JSON.stringify({ update_id:updateId, message })
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
      assert.equal(method, 'sendMessage');
      return new Response(JSON.stringify({ ok:true, result:{ message_id:900 + calls.length, chat:{ id:USER } } }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
  };
}

async function send(text, replyToText = null, updateId = 1) {
  const c = capture();
  const response = await handle(request(text, replyToText, updateId), env(), NOW, c.transport);
  const result = await response.json();
  assert.equal(result.mode, 'private-explicit-intent');
  assert.equal(result.delivered, true);
  assert.equal(c.calls.length, 1);
  return c.calls[0].body;
}

test('panel deep links start two different private Jobcenter flows', async () => {
  const norms = await send('/start jobcenter_norms', null, 1);
  const check = await send('/start jobcenter_check', null, 2);

  assert.match(norms.text, /^📋 Норми Jobcenter — крок 1\/2/u);
  assert.match(check.text, /^🏛 Перевірити під Jobcenter — крок 1\/3/u);
  assert.notEqual(norms.text, check.text);
  assert.equal(norms.reply_markup.force_reply, true);
  assert.equal(check.reply_markup.force_reply, true);
});

test('norms-only flow returns the verified Plön three-person normative without asking for a listing', async () => {
  const start = await send('/start jobcenter_norms', null, 10);
  const location = await send('Plön', start.text, 11);
  assert.match(location.text, /крок 2\/2/u);
  assert.match(location.text, /^Локація: Plön$/mu);

  const result = await send('3 особи', location.text, 12);
  assert.match(result.text, /^📋 Норми Jobcenter$/mu);
  assert.match(result.text, /Площа-орієнтир: 75 м²/u);
  assert.match(result.text, /Оренда без опалення: до 680 € на місяць/u);
  assert.match(result.text, /Bruttokaltmiete/u);
  assert.doesNotMatch(result.text, /Kaltmiete 700, Betriebskosten/u);
  assert.equal(result.reply_markup.inline_keyboard[0][0].text, '↗ Офіційне джерело');
  assert.match(result.reply_markup.inline_keyboard[0][0].url, /jobcenter-kreis-ploen\.de/u);
});

test('concrete Jobcenter check flow asks for rent components and evaluates them against the verified rule', async () => {
  const start = await send('/start jobcenter_check', null, 20);
  const location = await send('Plön', start.text, 21);
  assert.match(location.text, /крок 2\/3/u);

  const persons = await send('3', location.text, 22);
  assert.match(persons.text, /крок 3\/3/u);
  assert.match(persons.text, /Kaltmiete 700, Betriebskosten 150, Heizkosten 100/u);

  const result = await send('Kaltmiete 500, Betriebskosten 100, Heizkosten 80', persons.text, 23);
  assert.match(result.text, /^✅/u);
  assert.match(result.text, /Фактично без опалення: 600 €/u);
  assert.match(result.text, /Heizkosten: 80 €/u);
  assert.match(result.text, /до 680 € Bruttokaltmiete/u);
  assert.match(result.text, /не є Zusicherung/u);
  assert.equal(result.reply_markup.inline_keyboard[0][0].text, '↗ Офіційне джерело');
});

test('Kreis-level ambiguity is not silently treated as the city of Plön', async () => {
  const start = await send('/start jobcenter_norms', null, 30);
  const location = await send('Kreis Plön', start.text, 31);
  const result = await send('3', location.text, 32);

  assert.match(result.text, /уточнення/u);
  assert.match(result.text, /конкретне місто або громаду/u);
  assert.doesNotMatch(result.text, /до 680 € на місяць/u);
  assert.equal(result.reply_markup.force_reply, true);
});

test('Jobcenter keyboard keeps context for a city-only reply and common Lübeck typo', async () => {
  const start = await send('🏛 Jobcenter', null, 40);
  assert.match(start.text, /^Тема: Jobcenter\./u);
  assert.equal(start.reply_markup.force_reply, true);

  const city = await send('Любек', start.text, 41);
  assert.match(city.text, /^🏛 Jobcenter — Lübeck$/mu);
  assert.match(city.text, /оренда\/житло/u);
  assert.equal(city.reply_markup.force_reply, true);

  const housing = await send('оренда/житло', city.text, 42);
  assert.match(housing.text, /^Тема: житло — Lübeck\./u);
  assert.match(housing.text, /кількість осіб \(1–20\)/u);
  assert.equal(housing.reply_markup.force_reply, true);

  const typo = await send('Любик оренда/житло', start.text, 43);
  assert.match(typo.text, /^Тема: житло — Lübeck\./u);
  assert.match(typo.text, /кількість осіб \(1–20\)/u);
});

test('private Jobcenter room confirmation skips the redundant action menu safely', async () => {
  const previous = [
    'Тема: житло — Lübeck. Локацію вже визначено.',
    'Осіб: 2',
    '',
    'Орієнтири Jobcenter Lübeck',
    'Площа: до 60 м² за опублікованою таблицею.',
    'Оренда без опалення: до 680 € на місяць.',
    'Це Bruttokaltmiete: Kaltmiete + Betriebskosten без опалення.',
    'Опалення (Heizkosten): окремо, після перевірки Jobcenter.',
    '',
    'Кімнати для пошуку: 1–2 — рекомендація, не норматив Jobcenter.',
    '',
    'Для пошуку підтвердьте кількість кімнат: 1–2 або ваш варіант.',
    'Умова: житло під Jobcenter.'
  ].join('\n');

  const result = await send('2', previous, 50);
  assert.match(result.text, /^Пошук житла — Lübeck, 2 кімнати\. Уточніть максимальний місячний бюджет/u);
  assert.match(result.text, /^Осіб: 2$/mu);
  assert.match(result.text, /^Умова: житло під Jobcenter\.$/mu);
  assert.match(result.text, /Bruttokaltmiete/u);
  assert.doesNotMatch(result.text, /Що саме потрібно\?|Оберіть дію/u);
  assert.equal(result.reply_markup.force_reply, true);
});
