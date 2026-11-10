import test from 'node:test';
import assert from 'node:assert/strict';
import { collapsiblePrivateKeyboardTransport } from '../src/worker-entry-pilot-v21.mjs';
import { sendSafeNewsDigestToChatV2, NEWS_BUILD_NOTICE } from '../src/news-quality-v2.mjs';

const OLD_TEXT = 'У провайдера недостатньо credits для live-пошуку. Поповніть або дочекайтеся доступного безкоштовного ліміту.';
const TELEGRAM_URL = 'https://api.telegram.org/bottest/sendMessage';

function json(value, status=200) {
  return new Response(JSON.stringify(value), { status, headers:{ 'content-type':'application/json' } });
}

function html(value, url='') {
  const response = new Response(value, { status:200, headers:{ 'content-type':'text/html; charset=utf-8' } });
  if (url) Object.defineProperty(response, 'url', { value:url });
  return response;
}

test('housing provider billing details are never exposed to Telegram users', async () => {
  let captured = null;
  const transport = collapsiblePrivateKeyboardTransport(async (url, options = {}) => {
    captured = { url, options };
    return json({ ok:true });
  });

  await transport(TELEGRAM_URL, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ chat_id:123, text:OLD_TEXT })
  });

  const payload = JSON.parse(captured.options.body);
  assert.doesNotMatch(payload.text, /credits|поповніть|безкоштовного ліміту/iu);
  assert.match(payload.text, /Автоматичний пошук оголошень зараз тимчасово недоступний/u);
});

test('provider credit failure automatically falls back to public housing sources', async () => {
  const wankendorfer = `
  <article>
    <h4>Helle Wohnung in attraktiver Lage</h4>
    <div>Stettiner Str. 18, 25524 Itzehoe</div>
    <div>Gesamtmiete</div><div>620,76 €</div>
    <div>Fläche</div><div>56,68 m²</div>
    <div>Zimmer</div><div>2,5</div>
  </article>`;
  let telegramPayload = null;
  const calls = [];
  const transport = collapsiblePrivateKeyboardTransport(async (url, options = {}) => {
    calls.push(String(url));
    if (url === 'https://www.wankendorfer.de/wohnungssuche/') return html(wankendorfer, url);
    if (String(url).startsWith('https://api.telegram.org/')) {
      telegramPayload = JSON.parse(options.body);
      return json({ ok:true });
    }
    return html('', String(url));
  });

  const text = [
    '🔎 Автопошук житла під Jobcenter — Itzehoe',
    'Осіб: 2',
    'Кімнати: 2-3',
    'Орієнтир Jobcenter: до 800 € Bruttokaltmiete; площа-орієнтир до 65 м².',
    'Heizkosten перевіряються окремо.',
    'Радіус пошуку: 15 км.',
    '',
    '⚠️ Це автоматичний пошук кандидатів, а не Zusicherung.',
    '',
    OLD_TEXT
  ].join('\n');

  await transport(TELEGRAM_URL, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      chat_id:123,
      text,
      reply_markup:{ inline_keyboard:[[{ text:'↗ Kleinanzeigen', url:'https://www.kleinanzeigen.de/' }]] }
    })
  });

  assert.ok(calls.includes('https://www.wankendorfer.de/wohnungssuche/'));
  assert.ok(telegramPayload);
  assert.doesNotMatch(telegramPayload.text, /credits|поповніть|безкоштовного ліміту/iu);
  assert.match(telegramPayload.text, /Пошук автоматично продовжено через доступні відкриті житлові джерела/u);
  assert.match(telegramPayload.text, /Helle Wohnung in attraktiver Lage/u);
  assert.match(telegramPayload.text, /Wankendorfer/u);
  assert.equal(telegramPayload.reply_markup.inline_keyboard[0][0].text, '1. Wankendorfer');
  assert.equal(telegramPayload.reply_markup.inline_keyboard[0][0].url, 'https://www.wankendorfer.de/wohnungssuche/');
  assert.match(JSON.stringify(telegramPayload.reply_markup), /nav:menu/u);
});

test('main private reply keyboard becomes inline navigation instead of occupying the typing area', async () => {
  let body = null;
  const transport = collapsiblePrivateKeyboardTransport(async (_url, options = {}) => {
    body = options.body;
    return json({ ok:true });
  });

  await transport(TELEGRAM_URL, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      chat_id:123,
      text:'Оберіть тему або напишіть запитання',
      reply_markup:{
        keyboard:[
          [{ text:'🏠 Житло' }, { text:'🏛 Jobcenter' }],
          [{ text:'📄 Документи' }, { text:'👶 Kindergeld' }]
        ],
        resize_keyboard:true,
        one_time_keyboard:false,
        is_persistent:true
      }
    })
  });

  const payload = JSON.parse(body);
  assert.ok(Array.isArray(payload.reply_markup.inline_keyboard));
  assert.equal(payload.reply_markup.keyboard, undefined);
  assert.match(JSON.stringify(payload.reply_markup), /nav:housing/u);
  assert.match(JSON.stringify(payload.reply_markup), /nav:jobcenter/u);
});

test('specialized private reply keyboards stay collapsible and reopenable', async () => {
  let body = null;
  const transport = collapsiblePrivateKeyboardTransport(async (_url, options = {}) => {
    body = options.body;
    return json({ ok:true });
  });

  await transport(TELEGRAM_URL, {
    method:'POST',
    body:JSON.stringify({
      chat_id:123,
      text:'Оберіть варіант',
      reply_markup:{ keyboard:[[{ text:'A' }]], is_persistent:true, one_time_keyboard:true }
    })
  });

  const payload = JSON.parse(body);
  assert.equal(payload.reply_markup.resize_keyboard, true);
  assert.equal(payload.reply_markup.one_time_keyboard, false);
  assert.equal(payload.reply_markup.is_persistent, false);
});

test('morning digest still sends a truthful brief when quality cards are unavailable', async () => {
  const telegramPayloads = [];
  const notices = [];
  const transport = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/deleteMessage')) {
      notices.push(['deleted', JSON.parse(options.body).message_id]);
      return json({ ok:true, result:true });
    }
    if (target.endsWith('/sendMessage') && JSON.parse(options.body).text === NEWS_BUILD_NOTICE) {
      notices.push(['sent', 900]);
      return json({ ok:true, result:{ message_id:900, chat:{ id:JSON.parse(options.body).chat_id } } });
    }
    if (target.includes('api.telegram.org')) {
      telegramPayloads.push(JSON.parse(options.body));
      return json({ ok:true, result:{ message_id:77, chat:{ id:-100 } } });
    }
    return new Response('unavailable', { status:503 });
  };

  const result = await sendSafeNewsDigestToChatV2(
    { token:'test', chatIds:[-100] },
    -100,
    {},
    Date.UTC(2026, 8, 14, 8, 0, 0),
    transport
  );

  assert.deepEqual(notices, [['sent', 900], ['deleted', 900]], 'a notice is shown while the digest is built, then removed');
  assert.equal(result.ok, true);
  assert.equal(result.sent, 1);
  assert.equal(result.cardSent, 0);
  assert.equal(result.reason, 'brief_only');
  assert.equal(telegramPayloads.length, 1);
  assert.match(telegramPayloads[0].text, /Ранковий огляд/u);
  assert.match(telegramPayloads[0].text, /не знайдено/u);
});

test('unrelated Telegram messages stay unchanged', async () => {
  const original = JSON.stringify({ chat_id:123, text:'Звичайне повідомлення' });
  let body = null;
  const transport = collapsiblePrivateKeyboardTransport(async (_url, options = {}) => {
    body = options.body;
    return json({ ok:true });
  });

  await transport(TELEGRAM_URL, {
    method:'POST',
    body:original
  });

  assert.equal(body, original);
});
