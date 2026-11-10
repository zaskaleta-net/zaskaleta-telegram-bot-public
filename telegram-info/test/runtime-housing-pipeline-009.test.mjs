import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker-entry-pilot-v21.mjs';
import { finalSearchControlsMarkup, localSearchSummaryPayload } from '../src/runtime-jobcenter-base.mjs';
import { formatHousingListings } from '../src/housing-provider.mjs';

const USER = 123456;
const SECRET = 's'.repeat(32);
const TOKEN = `12345:${'A'.repeat(32)}`;

function baseEnv(extra = {}) {
  return {
    TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1',
    TELEGRAM_BOT_TOKEN:TOKEN, TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true', TELEGRAM_DELIVERY_ENABLED:'true',
    KLAZ_API_KEY:'klaz_live_' + 'A'.repeat(24),
    ...extra
  };
}

let messageId = 1000;

async function run(handler, data, message, { env = baseEnv(), id = `cbq-${Math.random()}` } = {}) {
  const log = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url?.url || url);
    const entry = { target };
    log.push(entry);
    if (log.length > 50) throw new Error('Too many subrequests.');
    if (target.startsWith('https://api.telegram.org/')) {
      let body = {};
      try { body = JSON.parse(options.body); } catch {
        if (options.body instanceof FormData) body = Object.fromEntries([...options.body].filter(([key]) => key !== 'photo'));
      }
      entry.telegram = { method:target.split('/').at(-1), body };
      messageId += 1;
      return new Response(JSON.stringify({ ok:true, result:{ message_id:messageId, chat:{ id:USER, type:'private' } } }), { headers:{ 'content-type':'application/json' } });
    }
    return (await handler(target, options)) || new Response('{}', { status:503 });
  };
  try {
    const request = new Request('https://x.example/telegram/stateless', {
      method:'POST',
      headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
      body:JSON.stringify({ update_id:Math.floor(Math.random() * 1e9), callback_query:{
        id, from:{ id:USER, is_bot:false }, data,
        message:{ message_id:44, date:Math.floor(Date.now() / 1000), chat:{ id:USER, type:'private' }, ...message }
      } })
    });
    const waits = [];
    const response = await worker.fetch(request, env, { waitUntil:promise => waits.push(promise) });
    await Promise.allSettled(waits);
    return { response, log, telegram:log.filter(entry => entry.telegram).map(entry => entry.telegram) };
  } finally {
    globalThis.fetch = original;
  }
}

function ad(id, price, name, extra = {}) {
  return {
    ad_id:String(id), title:`Wohnung ${id} ${name}`, description:'x',
    price:{ amount:price, price_type:'SPECIFIED_AMOUNT' }, status:'ACTIVE',
    ad_url:`https://www.kleinanzeigen.de/s-anzeige/w/${2000000 + id}`, location:{ name, ...(extra.location || {}) },
    details:{ Zimmer:'2' }, images:[]
  };
}

const PUBLIC_HTML = '<html><body><article class="aditem"><a href="/s-anzeige/x/1">x</a></article></body></html>';

function districtProvider(ads) {
  return async target => {
    if (target.includes('/locations?')) {
      const q = new URL(target).searchParams.get('q');
      return Response.json({ success:true, data:{ locations:[{ id:String(1000 + q.length * 31 + q.charCodeAt(0)), name:q }] } });
    }
    if (target.includes('/search?')) return Response.json({ success:true, data:{ ads } });
    if (target.includes('kleinanzeigen.de')) return new Response(PUBLIC_HTML, { headers:{ 'content-type':'text/html' } });
    return null;
  };
}

function classify(log) {
  const counts = { telegram:0, apiSearch:0, apiLocations:0, publicPage:0 };
  for (const entry of log) {
    if (entry.telegram) counts.telegram += 1;
    else if (entry.target.includes('/search?')) counts.apiSearch += 1;
    else if (entry.target.includes('/locations?')) counts.apiLocations += 1;
    else counts.publicPage += 1;
  }
  return counts;
}

// Whole-Kreis results arrive as listing cards (photo or text) followed by one
// summary message; read every delivered message, captions included.
function delivered(telegram) {
  return telegram
    .filter(call => ['sendMessage', 'sendPhoto'].includes(call.method))
    .map(call => String(call.body.text || call.body.caption || ''))
    .join('\n');
}

const RATZEBURG_ADS = [
  ad(1, 790, 'Ratzeburg'),
  ad(2, 650, 'Mölln'),
  ad(3, 600, 'Ratzeburg'),
  ad(4, 700, 'Geesthacht'),
  ad(5, 500, 'Mölln')
];

for (const data of ['jcd:2:2:Ratzeburg', 'jcp:1:2:2:Ratzeburg']) {
  test(`TG-RUNTIME-009 ${data}: every anchor gets its Kleinanzeigen API search within 50 subrequests`, async () => {
    const ads = Array.from({ length:12 }, (_, i) => ad(100 + i, 400 + i, i % 2 ? 'Mölln' : 'Ratzeburg'));
    const { log, telegram } = await run(districtProvider(ads), data, { text:'📍 Радіус пошуку: 15 км' });
    const counts = classify(log);
    assert.ok(log.length <= 50, `used ${log.length} subrequests`);
    assert.ok(log.length - counts.telegram <= 32, `providers used ${log.length - counts.telegram}`);
    assert.equal(counts.apiSearch, 10, `API searches: ${JSON.stringify(counts)}`);
    const final = telegram.filter(call => call.method === 'sendMessage').at(-1);
    assert.match(final.body.text, /Пошук по всьому Jobcenter\/Kreis Herzogtum Lauenburg завершено/u);
    assert.match(delivered(telegram), /Wohnung 1\d\d (?:Ratzeburg|Mölln)/u);
  });
}

test('TG-RUNTIME-009 whole-Kreis listings are checked against their own municipality limit', async () => {
  const { telegram } = await run(districtProvider(RATZEBURG_ADS), 'jcd:2:2:Ratzeburg', { text:'📍 Радіус пошуку: 15 км' });
  const final = telegram.filter(call => call.method === 'sendMessage').at(-1).body.text;
  const all = delivered(telegram);
  assert.match(all, /Wohnung 3 Ratzeburg/u, 'Ratzeburg 600 € is within 606,10 €');
  assert.match(all, /Wohnung 4 Geesthacht/u, 'Geesthacht 700 € is within 748 €');
  assert.match(all, /Wohnung 5 Mölln/u);
  assert.doesNotMatch(all, /Wohnung 1 Ratzeburg/u, 'Ratzeburg 790 € exceeds the Ratzeburg limit');
  assert.doesNotMatch(all, /Wohnung 2 Mölln/u, 'Mölln 650 € exceeds the Mölln limit');
  assert.match(final, /606,10 €/u, 'the user\'s own limit is named');
  assert.match(final, /норм\S* своєї громади/u, 'the per-municipality caveat is part of the reply');
  assert.doesNotMatch(final, /\d\.\d €/u, 'amounts use a decimal comma');
});

test('TG-RUNTIME-009 listing header amounts use a decimal comma', () => {
  const text = formatHousingListings({ location:'Trittau', rooms:'3', amount:1138.5, type:'Bruttokaltmiete' },
    { status:'ok', listings:[{ title:'Wohnung', price:900, location:'Trittau' }] });
  assert.match(text, /до 1138,50 €/u);
  const empty = formatHousingListings({ location:'Trittau', rooms:'3', amount:943.8, type:'Bruttokaltmiete' }, { status:'ok', listings:[] });
  assert.match(empty, /до 943,80 €/u);
});

function ringAds() {
  const origin = { lat:54.30, lon:9.66 };
  const at = (id, km) => ({
    ...ad(id, 400 + id, 'Rendsburg'),
    title:`Wohnung ${id} ${km}km`,
    location:{ name:'Rendsburg', latitude:origin.lat + km / 111.2, longitude:origin.lon }
  });
  return {
    origin,
    ads:[...[1, 2, 3, 4, 5, 6].map(i => at(i, i)), ...[11, 12, 13, 14, 15, 16, 17].map((i, k) => at(i, 16 + k * 0.5))]
  };
}

function ringProvider() {
  const { origin, ads } = ringAds();
  return async target => {
    if (target.includes('/locations?')) return Response.json({ success:true, data:{ locations:[{ id:'1', name:'Rendsburg', latitude:origin.lat, longitude:origin.lon }] } });
    if (target.includes('/search?')) return Response.json({ success:true, data:{ ads:new URL(target).searchParams.get('category_id') === '203' ? ads : [] } });
    return null;
  };
}

function cardIds(telegram) {
  return telegram
    .filter(call => /Wohnung \d+ [\d.]+km/u.test(String(call.body.text || call.body.caption || '')))
    .map(call => Number(/Wohnung (\d+) /u.exec(String(call.body.text || call.body.caption))[1]));
}

test('TG-RUNTIME-009 next page after widening to 20 km keeps the 15–20 km ring', async () => {
  const summary15 = ['🔎 Автопошук житла під Jobcenter — Rendsburg', 'Осіб: 2', 'Кімнати: 2', 'Jobcenter/Kreis: Rendsburg-Eckernförde.', '📍 Радіус пошуку: 15 км', '✅ Показано 1–5 із 6 знайдених оголошень.'].join('\n');
  const first = await run(ringProvider(), 'jcr:20:2:2:Rendsburg', { text:summary15 });
  const firstIds = cardIds(first.telegram);
  assert.deepEqual(firstIds, [11, 12, 13, 14, 15]);
  const summary = first.telegram.filter(call => call.method === 'sendMessage' && /Показано/u.test(call.body.text || '')).at(-1);
  const next = summary.body.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(next, 'jrp:1:15');
  assert.ok(new TextEncoder().encode(next).byteLength <= 64);

  const second = await run(ringProvider(), next, { text:summary.body.text });
  assert.deepEqual(cardIds(second.telegram), [16, 17], 'only the rest of the 15–20 km ring, no repeats, no inner listings');
});

test('TG-RUNTIME-009 old jrp:<page> buttons still work and new callbacks fit Telegram limits', async () => {
  const text = ['🔎 Автопошук житла під Jobcenter — Rendsburg', 'Осіб: 2', 'Кімнати: 2', 'Jobcenter/Kreis: Rendsburg-Eckernförde.', '📍 Радіус пошуку: 15 км', '✅ Показано 1–5 із 6 знайдених оголошень.'].join('\n');
  const legacy = await run(ringProvider(), 'jrp:1', { text });
  assert.ok(legacy.telegram.some(call => call.method === 'answerCallbackQuery'));
  assert.ok(cardIds(legacy.telegram).length > 0);

  const controls = finalSearchControlsMarkup({ location:'Rendsburg', rooms:'2', persons:2, radius:25, previousRadius:20, page:3, hasMore:true });
  assert.equal(controls.inline_keyboard[0][0].callback_data, 'jrp:4:20');
  const payload = localSearchSummaryPayload({ location:'Rendsburg', rooms:'2', persons:2, radius:25, previousRadius:20, page:0, total:12, visible:5 });
  assert.equal(payload.reply_markup.inline_keyboard[0][0].callback_data, 'jrp:1:20');
  const plain = finalSearchControlsMarkup({ location:'Rendsburg', rooms:'2', persons:2, radius:15, page:0, hasMore:true });
  assert.equal(plain.inline_keyboard[0][0].callback_data, 'jrp:1');
});

for (const place of ['Lauenburg/Elbe', 'Reinfeld (Holstein)', 'Glücksburg (Ostsee)', 'Marne (Holstein)']) {
  test(`TG-RUNTIME-009 ${place} buttons answer and reply`, async () => {
    const encoded = encodeURIComponent(place);
    const rooms = await run(async () => null, `hkr:2:${encoded}`, { text:`Тема: житло — ${place}. Локацію вже визначено.\nВкажіть кількість кімнат, наприклад: 3 або 3-4.\nОсіб: 2` });
    assert.ok(rooms.telegram.some(call => call.method === 'answerCallbackQuery'), JSON.stringify(rooms.telegram));
    assert.ok(rooms.telegram.some(call => call.method === 'sendMessage'), JSON.stringify(rooms.telegram));

    const guideline = await run(async () => null, `hka:j:2:2:${encoded}`, { text:`Житло — ${place}, 2 кімнати.\nОсіб: 2` });
    assert.ok(guideline.telegram.some(call => call.method === 'sendMessage' && call.body.text.includes(place)), JSON.stringify(guideline.telegram));
  });
}

test('TG-RUNTIME-009 hka:j shows the guideline without a dangling progress message and answers once', async () => {
  const { telegram } = await run(async () => null, 'hka:j:2:2:Rendsburg', { text:'Житло — Rendsburg, 2 кімнати.\nОсіб: 2' });
  assert.equal(telegram.filter(call => call.method === 'answerCallbackQuery').length, 1, JSON.stringify(telegram));
  assert.ok(!telegram.some(call => /Шукаю житло/u.test(String(call.body.text || ''))), JSON.stringify(telegram));
  assert.ok(telegram.some(call => call.method === 'sendMessage' && /Почати пошук/u.test(call.body.text || '')));
});

function nextPageProvider() {
  const ads = Array.from({ length:12 }, (_, i) => ({ ...ad(i + 1, 401 + i, 'Rendsburg'), title:`Wohnung ${i + 1}` }));
  return async target => {
    if (target.includes('/locations?')) return Response.json({ success:true, data:{ locations:[{ id:'1', name:'Rendsburg' }] } });
    if (target.includes('/search?')) return Response.json({ success:true, data:{ ads } });
    return null;
  };
}

const CARD_CAPTION = ['1. Wohnung 5', '💶 405 € · Rendsburg', '', 'Стартова точка: Rendsburg', "Склад сім'ї: 2", 'Кімнати: 2', 'Територія Jobcenter/Kreis: Rendsburg-Eckernförde.', '🏛 x'].join('\n');

test('TG-RUNTIME-009 jcn: answers the callback and numbers page 2 from 6', async () => {
  const { telegram } = await run(nextPageProvider(), `jcn:l:5:u${USER}`, { caption:CARD_CAPTION, photo:[{ file_id:'x' }] });
  assert.equal(telegram.filter(call => call.method === 'answerCallbackQuery').length, 1, JSON.stringify(telegram));
  const numbers = telegram
    .map(call => String(call.body.text || call.body.caption || ''))
    .filter(text => /^(?:<b>)?\d+\. Wohnung/u.test(text))
    .map(text => Number(/^(?:<b>)?(\d+)\./u.exec(text)[1]));
  assert.deepEqual(numbers, [6, 7, 8, 9, 10]);
});

test('TG-RUNTIME-009 jcd:u answers the callback', async () => {
  const { telegram } = await run(nextPageProvider(), `jcd:u${USER}`, { caption:CARD_CAPTION, photo:[{ file_id:'x' }] });
  assert.equal(telegram.filter(call => call.method === 'answerCallbackQuery').length, 1, JSON.stringify(telegram.map(call => call.method)));
});
