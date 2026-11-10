import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePrivateHousingContinuity, normalizePrivateHousingContextRequest } from '../src/private-housing-continuity-v1.mjs';

const token = '123456789:' + 'a'.repeat(40);
const secret = 's'.repeat(40);
const userId = 111111111;
const groupId = -1001234567890;

function env() {
  return {
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_ALLOWED_CHAT_IDS:`${groupId}`,
    TELEGRAM_ADMIN_USER_IDS:String(userId),
    TELEGRAM_BOT_TOKEN:token,
    TELEGRAM_WEBHOOK_SECRET:secret
  };
}

function request(text, previous, updateId = 1) {
  return new Request('https://example.test/telegram/stateless', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-telegram-bot-api-secret-token':secret
    },
    body:JSON.stringify({
      update_id:updateId,
      message:{
        message_id:100 + updateId,
        date:1,
        chat:{ id:userId, type:'private' },
        from:{ id:userId, is_bot:false },
        text,
        reply_to_message:{
          message_id:99 + updateId,
          chat:{ id:userId, type:'private' },
          from:{ id:999999999, is_bot:true, username:'ZaskaletaInfoBot' },
          text:previous
        }
      }
    })
  });
}

function transportWith(sent) {
  return async (url, options) => {
    const method = url.split('/').at(-1);
    assert.equal(method, 'sendMessage');
    const body = JSON.parse(options.body);
    sent.push(body);
    return new Response(JSON.stringify({ ok:true, result:{ message_id:700 + sent.length, chat:{ id:userId } } }), {
      status:200,
      headers:{ 'content-type':'application/json' }
    });
  };
}

test('room answer keeps Lübeck and asks household size instead of resetting', async () => {
  const sent = [];
  const previous = 'Тема: житло — Любік. Локацію вже визначено.\nВкажіть кількість кімнат, наприклад: 3 або 3-4.';
  const response = await handlePrivateHousingContinuity(request('3', previous), env(), transportWith(sent));
  assert.ok(response);
  const data = await response.json();
  assert.equal(data.mode, 'private-housing-household-step');
  assert.equal(data.location, 'Lübeck');
  assert.equal(data.rooms, '3');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /📍 Локація: Lübeck/u);
  assert.match(sent[0].text, /🛏 Кімнат: 3/u);
  assert.match(sent[0].text, /кількість людей/u);
  assert.doesNotMatch(sent[0].text, /вкажіть місто/u);
});

test('known household size is not asked a second time after rooms are confirmed', async () => {
  const sent = [];
  const previous = 'Тема: житло — Trittau. Локацію вже визначено.\nВкажіть кількість кімнат, наприклад: 3 або 3-4.\nОсіб: 4';
  const response = await handlePrivateHousingContinuity(request('3-4', previous, 7), env(), transportWith(sent));
  assert.ok(response);
  const data = await response.json();
  assert.equal(data.mode, 'private-housing-household-preserved');
  assert.equal(data.location, 'Trittau');
  assert.equal(data.rooms, '3-4');
  assert.equal(data.persons, 4);
  assert.match(sent[0].text, /Житло — Trittau, 3-4 кімнати/u);
  assert.match(sent[0].text, /Осіб: 4/u);
  assert.match(sent[0].text, /Що саме потрібно/u);
  assert.doesNotMatch(sent[0].text, /Вкажіть кількість людей/u);
});

test('household answer keeps location, rooms and people in the next step', async () => {
  const sent = [];
  const previous = '🏠 Дані пошуку житла збережено.\n📍 Локація: Lübeck\n🛏 Кімнат: 3\n👥 Вкажіть кількість людей, які житимуть у квартирі (1–20).';
  const response = await handlePrivateHousingContinuity(request('2', previous, 2), env(), transportWith(sent));
  assert.ok(response);
  const data = await response.json();
  assert.equal(data.mode, 'private-housing-household-saved');
  assert.equal(data.location, 'Lübeck');
  assert.equal(data.rooms, '3');
  assert.equal(data.persons, 2);
  assert.match(sent[0].text, /^Житло — Lübeck, 3 кімнати\./u);
  assert.match(sent[0].text, /Осіб: 2/u);
  assert.match(sent[0].text, /✅ Дані збережено/u);
  assert.doesNotMatch(sent[0].text, /вкажіть місто/u);
});

test('invalid household answer retries without losing location or rooms', async () => {
  const sent = [];
  const previous = '🏠 Дані пошуку житла збережено.\n📍 Локація: Lübeck\n🛏 Кімнат: 3-4\n👥 Вкажіть кількість людей, які житимуть у квартирі (1–20).';
  const response = await handlePrivateHousingContinuity(request('не знаю', previous, 3), env(), transportWith(sent));
  assert.ok(response);
  const data = await response.json();
  assert.equal(data.mode, 'private-housing-household-step');
  assert.equal(data.valid, false);
  assert.match(sent[0].text, /📍 Локація: Lübeck/u);
  assert.match(sent[0].text, /🛏 Кімнат: 3-4/u);
  assert.match(sent[0].text, /від 1 до 20/u);
});

test('Jobcenter-specific household prompt is left to the verified Jobcenter flow', async () => {
  const previous = 'Тема: житло — Lübeck. Локацію вже визначено.\nДля нормативів Jobcenter вкажіть кількість осіб (1–20).';
  const response = await handlePrivateHousingContinuity(request('2', previous, 4), env(), async () => {
    throw new Error('transport must not be called');
  });
  assert.equal(response, null);
});

test('natural follow-up keeps a valid prompt location with people, rooms and search action', async () => {
  const previous = 'Тема: житло — Lübeck. Локацію вже визначено. Уточніть кількість кімнат і що потрібно: пошук житла, перевірка оренди, Jobcenter-погодження або відповідь орендодавцю.';
  const normalized = await normalizePrivateHousingContextRequest(
    request('Пошук житла, на 3 чоловік 3 кімнати', previous, 5),
    env(),
    async () => { throw new Error('local Lübeck resolution must not call transport'); }
  );
  assert.equal(normalized.response, null);
  const body = await normalized.request.json();
  assert.equal(body.message.text, 'Lübeck. пошук житла. Для 3 осіб. 3 кімнати.');
  assert.equal('reply_to_message' in body.message, false);
});

test('ambiguous tester spelling is clarified instead of being treated as a confirmed SH location', async () => {
  const sent = [];
  const previous = 'Тема: житло — Місто рейнсберг .. Локацію вже визначено. Уточніть кількість кімнат і що потрібно: пошук житла, перевірка оренди, Jobcenter-погодження або відповідь орендодавцю.';
  const transport = async (url, options = {}) => {
    if (String(url).startsWith('https://www.gemeindeverzeichnis.de/api/gemeinden')) {
      return new Response(JSON.stringify([]), { status:200, headers:{ 'content-type':'application/json' } });
    }
    const method = String(url).split('/').at(-1);
    if (method === 'sendMessage') {
      const body = JSON.parse(options.body);
      sent.push(body);
      return new Response(JSON.stringify({ ok:true, result:{ message_id:800, chat:{ id:userId } } }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    throw new Error(`unexpected transport call: ${url}`);
  };

  const normalized = await normalizePrivateHousingContextRequest(
    request('Пошук житла ,на 3 чоловік 3 кімнати', previous, 6),
    env(),
    transport
  );
  assert.ok(normalized.response);
  const data = await normalized.response.json();
  assert.equal(data.mode, 'private-housing-location-clarification');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /рейнсберг/u);
  assert.match(sent[0].text, /Rendsburg/u);
  assert.match(sent[0].text, /Schleswig-Holstein/u);
  assert.doesNotMatch(sent[0].text, /Локацію вже визначено/u);
});
