import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROVIDER_SUBREQUEST_BUDGET,
  providerSubrequestBudget,
  subrequestBudgetTransport
} from '../src/subrequest-budget.mjs';
import worker, { TelegramOutbox } from '../src/worker-entry-pilot-v21.mjs';

const USER = 123456;
const SECRET = 's'.repeat(32);
const TOKEN = `12345:${'A'.repeat(32)}`;

function ok() {
  return new Response('{}', { status:200, headers:{ 'content-type':'application/json' } });
}

test('TG-RUNTIME-006 provider calls stop at the budget; Telegram and card images keep the reserve', async () => {
  const calls = [];
  const budgeted = subrequestBudgetTransport(async url => { calls.push(String(url)); return ok(); }, {}, { budget:3 });
  for (let i = 0; i < 3; i++) await budgeted(`https://www.kleinanzeigen.de/s-${i}`);
  await assert.rejects(budgeted('https://www.kleinanzeigen.de/s-over'), /subrequest budget/u);
  await budgeted(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method:'POST' });
  await budgeted('https://img.example.test/1.jpg', { headers:{ accept:'image/jpeg,image/*;q=0.8' } });
  await budgeted('https://img.example.test/2.jpg', { headers:new Headers({ accept:'image/webp' }) });
  assert.equal(calls.filter(url => url.includes('kleinanzeigen')).length, 3);
  assert.equal(calls.length, 6);
});

test('TG-RUNTIME-006 budget defaults to the Workers Free reserve and is configurable', () => {
  assert.equal(providerSubrequestBudget({}), DEFAULT_PROVIDER_SUBREQUEST_BUDGET);
  assert.ok(DEFAULT_PROVIDER_SUBREQUEST_BUDGET <= 32, 'leaves at least 18 of the 50 Free subrequests for delivery');
  assert.equal(providerSubrequestBudget({ TELEGRAM_PROVIDER_SUBREQUEST_BUDGET:'900' }), 900);
  assert.equal(providerSubrequestBudget({ TELEGRAM_PROVIDER_SUBREQUEST_BUDGET:'junk' }), DEFAULT_PROVIDER_SUBREQUEST_BUDGET);
  assert.equal(providerSubrequestBudget({ TELEGRAM_PROVIDER_SUBREQUEST_BUDGET:'0' }), DEFAULT_PROVIDER_SUBREQUEST_BUDGET);
});

test('TG-RUNTIME-006 the real failure reason is logged once instead of a silent network_error', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const budgeted = subrequestBudgetTransport(async () => { throw new Error(`Too many subrequests. https://api.telegram.org/bot${TOKEN}/sendMessage`); }, {}, { budget:5 });
    await assert.rejects(budgeted('https://www.kleinanzeigen.de/a'), /Too many subrequests/u);
    await assert.rejects(budgeted('https://www.kleinanzeigen.de/b'), /Too many subrequests/u);
  } finally {
    console.error = original;
  }
  const failures = logged.filter(([event]) => event === 'telegram_subrequest_failed');
  assert.equal(failures.length, 1);
  assert.match(failures[0][1].message, /Too many subrequests/u);
  assert.doesNotMatch(failures[0][1].message, /AAAAAAAA/u, 'the bot token never reaches the log');
});

function memoryStorage() {
  const values = new Map();
  let alarm = null;
  return {
    async put(key, value) { values.set(key, structuredClone(value)); },
    async get(key) { return values.get(key); },
    async delete(key) { return values.delete(key); },
    async list({ prefix } = {}) {
      return new Map([...values].filter(([key]) => !prefix || key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)));
    },
    async getAlarm() { return alarm; },
    async setAlarm(value) { alarm = Number(value); },
    async deleteAlarm() { alarm = null; },
    alarmValue() { return alarm; },
    sql:{ exec() { return { toArray() { return []; }, one() { return {}; }, *[Symbol.iterator]() {} }; } },
    transactionSync:fn => fn()
  };
}

function listing(id) {
  return {
    ad_id:String(id), title:`Wohnung ${id} in Trittau`, description:'x',
    price:{ amount:600 + id, price_type:'SPECIFIED_AMOUNT' }, status:'ACTIVE', deleted:false,
    ad_url:`https://www.kleinanzeigen.de/s-anzeige/housing/${id}`, location:{ name:'Trittau' },
    details:{ Zimmer:'3' }, images:[],
    attributes:[{ name:'wohnung_mieten.zimmer', label:'Zimmer', values:[{ value:'3', label:'3' }] }]
  };
}

test('TG-RUNTIME-006 a whole-Kreis search on Workers Free stays within 50 subrequests and still answers', async () => {
  const objects = new Map();
  const env = {
    TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1',
    TELEGRAM_BOT_TOKEN:TOKEN, TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true', TELEGRAM_DELIVERY_ENABLED:'true',
    KLAZ_API_KEY:'klaz_live_' + 'A'.repeat(24)
  };
  env.OUTBOX = {
    idFromName:name => ({ name, toString() { return name; } }),
    get(id) {
      if (!objects.has(id.name)) {
        const storage = memoryStorage();
        const ctx = { storage, id, waitUntil() {}, blockConcurrencyWhile:fn => Promise.resolve().then(fn) };
        objects.set(id.name, { storage, outbox:new TelegramOutbox(ctx, env) });
      }
      const entry = objects.get(id.name);
      return { fetch:(url, init) => entry.outbox.fetch(url instanceof Request ? url : new Request(url, init)) };
    }
  };

  let phase = 'webhook';
  const external = { webhook:0, alarm:0 };
  const telegram = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url?.url || url);
    external[phase] += 1;
    if (external[phase] > 50) throw new Error('Too many subrequests.');
    if (target.startsWith('https://api.telegram.org/')) {
      let text = '';
      let markup = null;
      try { const body = JSON.parse(options.body); text = body.text || body.caption || ''; markup = body.reply_markup || null; } catch {
        if (options.body instanceof FormData) {
          text = String(options.body.get('caption') || '');
          try { markup = JSON.parse(String(options.body.get('reply_markup') || 'null')); } catch {}
        }
      }
      telegram.push({ phase, method:target.split('/').at(-1), text, markup });
      return new Response(JSON.stringify({ ok:true, result:{ message_id:100 + telegram.length, chat:{ id:USER, type:'private' } } }), { headers:{ 'content-type':'application/json' } });
    }
    if (target.includes('/locations?')) return new Response(JSON.stringify({ success:true, data:{ locations:[{ id:'10410', name:'Trittau', city:'Trittau' }] } }), { headers:{ 'content-type':'application/json' } });
    if (target.includes('/search?')) return new Response(JSON.stringify({ success:true, data:{ ads:Array.from({ length:8 }, (_, i) => listing(i + 1)) } }), { headers:{ 'content-type':'application/json' } });
    return new Response('{}', { status:503 });
  };

  try {
    const text = ['🔎 Автопошук житла під Jobcenter — Trittau', 'Осіб: 4', 'Кімнати: 3-4', 'Jobcenter/Kreis: Stormarn.', '📍 Радіус пошуку: 15 км'].join('\n');
    const request = new Request('https://x.example/telegram/stateless', {
      method:'POST',
      headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
      body:JSON.stringify({ update_id:900006, callback_query:{
        id:'cbq-006', from:{ id:USER, is_bot:false }, data:'jcd:4:3-4:Trittau',
        message:{ message_id:44, date:Math.floor(Date.now() / 1000), chat:{ id:USER, type:'private' }, text }
      } })
    });
    const waits = [];
    const response = await worker.fetch(request, env, { waitUntil:promise => waits.push(promise) });
    await Promise.allSettled(waits);
    assert.equal(response.status, 200);

    phase = 'alarm';
    const kreis = objects.get(`jobcenter-district-search:v2:${USER}`);
    assert.ok(Number.isFinite(kreis.storage.alarmValue()), 'whole-Kreis task is queued');
    await kreis.outbox.alarm({});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(external.alarm <= 50, `alarm used ${external.alarm} subrequests`);
  // Without the budget the alarm needed 100 subrequests, so its final Telegram
  // message failed and the user was left with "Шукаю…". The API returned
  // listings, so the answer must deliver them, not a "не завершився" notice.
  const finalAnswer = telegram.filter(call => call.phase === 'alarm' && call.method === 'sendMessage');
  const delivered = finalAnswer.find(call => /Пошук по всьому Jobcenter\/Kreis Stormarn завершено/u.test(call.text));
  assert.ok(delivered, JSON.stringify(telegram));
  // Whole-Kreis listings arrive as cards before the summary, each with its link.
  const cards = telegram.filter(call => call.phase === 'alarm' && ['sendPhoto', 'sendMessage'].includes(call.method) && /Wohnung \d in Trittau/u.test(call.text));
  assert.equal(cards.length, 5, JSON.stringify(telegram).slice(0, 1500));
  assert.ok(cards.every(card => (card.markup?.inline_keyboard || []).flat().some(button => String(button.url || '').startsWith('https://www.kleinanzeigen.de/s-anzeige/'))), JSON.stringify(cards.map(card => card.markup)));
});

test('TG-RUNTIME-006 a radius search under a tight budget still delivers listing cards', async () => {
  const env = {
    TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1',
    TELEGRAM_BOT_TOKEN:TOKEN, TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true', TELEGRAM_DELIVERY_ENABLED:'true',
    KLAZ_API_KEY:'klaz_live_' + 'A'.repeat(24),
    TELEGRAM_PROVIDER_SUBREQUEST_BUDGET:'3'
  };
  let external = 0;
  const telegram = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url?.url || url);
    external += 1;
    // Simulate a hard platform limit just above the provider share.
    if (external > 15) throw new Error('Too many subrequests.');
    if (target.startsWith('https://api.telegram.org/')) {
      let text = '';
      try { text = JSON.parse(options.body).text || ''; } catch {}
      telegram.push({ method:target.split('/').at(-1), text });
      return new Response(JSON.stringify({ ok:true, result:{ message_id:200 + telegram.length, chat:{ id:USER, type:'private' } } }), { headers:{ 'content-type':'application/json' } });
    }
    if (target.includes('/locations?')) return new Response(JSON.stringify({ success:true, data:{ locations:[{ id:'24768', name:'Rendsburg', city:'Rendsburg' }] } }), { headers:{ 'content-type':'application/json' } });
    if (target.includes('/search?')) {
      const ads = Array.from({ length:8 }, (_, i) => ({ ...listing(i + 1), title:`Wohnung ${i + 1} in Rendsburg`, location:{ name:'Rendsburg' } }));
      return new Response(JSON.stringify({ success:true, data:{ ads } }), { headers:{ 'content-type':'application/json' } });
    }
    return new Response('{}', { status:503 });
  };
  try {
    const text = ['🔎 Автопошук житла під Jobcenter — Rendsburg', 'Осіб: 3', 'Кімнати: 3', 'Jobcenter/Kreis: Rendsburg-Eckernförde.', '📍 Радіус пошуку: 15 км', '✅ Показано 1–5 із 8 знайдених оголошень.'].join('\n');
    const request = new Request('https://x.example/telegram/stateless', {
      method:'POST',
      headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
      body:JSON.stringify({ update_id:900007, callback_query:{
        id:'cbq-007', from:{ id:USER, is_bot:false }, data:'jrp:1',
        message:{ message_id:45, date:Math.floor(Date.now() / 1000), chat:{ id:USER, type:'private' }, text }
      } })
    });
    const waits = [];
    const response = await worker.fetch(request, env, { waitUntil:promise => waits.push(promise) });
    await Promise.allSettled(waits);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(external <= 15, `used ${external} subrequests`);
  assert.ok(telegram.some(call => /Wohnung \d in Rendsburg/u.test(call.text)), JSON.stringify(telegram));
  assert.ok(telegram.some(call => /Автопошук житла під Jobcenter — Rendsburg/u.test(call.text)), JSON.stringify(telegram));
});

test('TG-RUNTIME-007 a repeated provider page is fetched once per invocation and does not use budget twice', async () => {
  const calls = [];
  const budgeted = subrequestBudgetTransport(async url => {
    calls.push(String(url));
    return new Response(`<html>${String(url)}</html>`, { status:200, headers:{ 'content-type':'text/html' } });
  }, {}, { budget:2 });
  const page = 'https://www.kleinanzeigen.de/s-wohnung-mieten-trittau/k0';
  const first = await budgeted(page, { headers:{ accept:'text/html' } });
  const second = await budgeted(page, { headers:{ accept:'text/html' } });
  assert.equal(await first.text(), `<html>${page}</html>`);
  assert.equal(await second.text(), `<html>${page}</html>`);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('content-type'), 'text/html');
  await budgeted('https://www.kleinanzeigen.de/s-haus-mieten-trittau/k0');
  assert.equal(calls.length, 2, 'the duplicate page is served from the invocation cache');
});

test('TG-RUNTIME-007 failures and non-GET requests are never reused', async () => {
  let attempt = 0;
  const budgeted = subrequestBudgetTransport(async (url, options = {}) => {
    attempt += 1;
    if (attempt === 1) throw new Error('reset');
    return new Response(String(options.method || 'GET'), { status:200 });
  }, {}, { budget:10 });
  const page = 'https://www.immobilienscout24.de/Suche/x';
  await assert.rejects(budgeted(page), /reset/u);
  assert.equal(await (await budgeted(page)).text(), 'GET');
  assert.equal(await (await budgeted(page, { method:'POST', body:'a' })).text(), 'POST');
  assert.equal(await (await budgeted(page, { method:'POST', body:'a' })).text(), 'POST');
  assert.equal(attempt, 4);
});

test('TG-RUNTIME-007 replayed pages keep the final redirect URL and the size cap', async () => {
  const final = 'https://evil.example/landing';
  const budgeted = subrequestBudgetTransport(async () => {
    const response = new Response('<html>x</html>', { status:200 });
    Object.defineProperty(response, 'url', { value:final });
    return response;
  }, {}, { budget:5 });
  const page = 'https://www.kleinanzeigen.de/s-wohnung-mieten-trittau/k0';
  assert.equal((await budgeted(page)).url, final, 'redirect host checks still see the final URL');
  assert.equal((await budgeted(page)).url, final);

  const huge = 3 * 1024 * 1024;
  let streamed = 0;
  const big = subrequestBudgetTransport(async () => new Response(new ReadableStream({
    pull(controller) {
      if (streamed >= huge) return controller.close();
      streamed += 65536;
      controller.enqueue(new Uint8Array(65536));
    }
  }), { status:200 }), {}, { budget:5 });
  const body = await (await big('https://www.kleinanzeigen.de/huge')).arrayBuffer();
  assert.ok(body.byteLength > 2 * 1024 * 1024, 'oversized pages still look oversized to the provider cap');
  assert.ok(streamed < huge, 'the oversized stream is not read to the end');
});
