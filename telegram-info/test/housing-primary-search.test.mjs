import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker-entry-pilot-v21.mjs';
import { searchPrimaryHousing, housingOfferTitleAllowed } from '../src/housing-primary-search.mjs';
import { searchLiveHousing } from '../src/housing-provider-base.mjs';
import { parseKleinanzeigenPublicPage } from '../src/housing-kleinanzeigen-public-recovery-base.mjs';
import { filterHousingListingsToJurisdiction, jurisdictionForHousingLocation } from '../src/housing-jurisdiction-scope.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const KLEINANZEIGEN = fixture('kleinanzeigen-trittau-radius15.html');
const OHNE_MAKLER_SIMILAR = fixture('ohne-makler-trittau-similar.html');
// Immowelt answers Cloudflare with 403 (staging log 2026-10-12) and is no longer
// fetched. The public card path is exercised with the real Ohne-Makler capture,
// one card moved to Großensee (Stormarn, 620 €) so it fits Trittau's 2-person limit.
const OHNE_MAKLER_STORMARN = fixture('ohne-makler-trittau-radius25.html')
  .replace('772 €', '620 €')
  .replace(/23858 Reinfeld\s*\(Reinfeld \(Holstein\)\)/u, '22946 Großensee')
  .replace('{"id":498456,"type":"Feature","geometry":{"type":"Point","coordinates":[10.50257,53.82654]}', '{"id":498456,"type":"Feature","geometry":{"type":"Point","coordinates":[10.3383,53.6106]}');
const USER = 123456;
const SECRET = 's'.repeat(32);
const TOKEN = `12345:${'A'.repeat(32)}`;
const KEY = 'klaz_live_' + 'A'.repeat(24);
const html = body => new Response(body, { status:200, headers:{ 'content-type':'text/html; charset=utf-8' } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json' } });

// Production 2026-10-11: Trittau, 2 persons (680,90 €), 15 km. The public
// Kleinanzeigen strict page returned 2 matching candidates and the user got
// none. Real capture: both are in Herzogtum Lauenburg (Dassendorf, Wentorf),
// i.e. outside the Stormarn Jobcenter — the drop is correct and must stay.
test('the two Trittau Kleinanzeigen candidates from production are Lauenburg offers and stay dropped', () => {
  const criteria = { location:'Trittau', rooms:'1-2', amount:680.9, radiusKm:15, jobcenterJurisdiction:'Stormarn' };
  const parsed = parseKleinanzeigenPublicPage(KLEINANZEIGEN, criteria, { locationScoped:true });
  assert.deepEqual(parsed.map(item => [item.location, item.price, item.distanceKm]), [['21521 Dassendorf', 600, 14], ['21465 Wentorf', 630, 15]]);
  assert.equal(jurisdictionForHousingLocation('21521 Dassendorf'), 'Herzogtum Lauenburg');
  assert.deepEqual(filterHousingListingsToJurisdiction(parsed, 'Stormarn', 'Trittau'), []);
  // A Stormarn town in the same "PLZ Ort (km)" format passes.
  const local = KLEINANZEIGEN.replace('21521 Dassendorf', '22946 Trittau');
  assert.deepEqual(filterHousingListingsToJurisdiction(parseKleinanzeigenPublicPage(local, criteria, { locationScoped:true }), 'Stormarn', 'Trittau').map(item => item.location), ['22946 Trittau']);
});

test('portal locations without the official qualifier still resolve (Reinfeld (Holstein) -> Stormarn)', () => {
  assert.equal(jurisdictionForHousingLocation('23858 Reinfeld'), 'Stormarn');
  assert.equal(jurisdictionForHousingLocation('23858 Reinfeld (Holstein)'), 'Stormarn');
  assert.equal(jurisdictionForHousingLocation('22929 Hamfelde'), null, 'Hamfelde exists in Stormarn and Lauenburg');
});

test('offer wording filter keeps Nachmieter offers and drops wanted, swap and WG ads', () => {
  assert.equal(housingOfferTitleAllowed('Nachmieter gesucht, 2-Zimmer Wohnung in Dassendorf ab Dezember.'), true);
  assert.equal(housingOfferTitleAllowed('Wohnung zur Miete - Ahrensburg - 399 € - 1 Zimmer'), true);
  for (const title of ['Suche Hamburg Rahlstedt sofort eine Wohnung', '2,5 ZIMMER GESUCHT', 'Zuverlässige Familie sucht eine 3–4-Zimmer-Wohnung', 'WG-Zimmer zur Miete auf Zeit - Hoisdorf', 'Tauschwohnung 2 Zimmer']) {
    assert.equal(housingOfferTitleAllowed(title), false, title);
  }
});

function portalRouter({ api = 'credits', empty = false } = {}) {
  const calls = { api:0, apiLocations:0, providers:0, byHost:{} };
  const route = async (url, options = {}) => {
    const target = String(url?.url || url);
    const host = new URL(target).hostname;
    calls.byHost[host] = (calls.byHost[host] || 0) + 1;
    if (host === 'api.kleinanzeigen-agent.de') {
      calls.api += 1;
      if (target.includes('/locations?')) calls.apiLocations += 1;
      if (api === 'credits') return json({ success:false, error_code:'INSUFFICIENT_CREDITS' }, 402);
      if (api === 'rate') return json({ success:false, error_code:'RATE_LIMITED' }, 429);
      if (target.includes('/locations?')) return json({ success:true, data:{ locations:[{ id:'10410', name:'Trittau', city:'Trittau' }] } });
      return json({ success:true, data:{ ads:[] } });
    }
    if (host === 'www.kleinanzeigen.de') return html(KLEINANZEIGEN);
    if (host === 'www.ohne-makler.net') return target.includes('/wohnung-mieten/') ? html(empty ? OHNE_MAKLER_SIMILAR : OHNE_MAKLER_STORMARN) : new Response('nf', { status:404, headers:{ 'content-type':'text/html' } });
    if (/^(?:media\.ohne-makler\.net|img\.kleinanzeigen\.de)$/u.test(host)) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status:200, headers:{ 'content-type':'image/jpeg' } });
    }
    return new Response('unavailable', { status:503, headers:{ 'content-type':'text/plain' } });
  };
  return { calls, route };
}

for (const api of ['credits', 'rate']) {
  test(`primary search answers from public portals while the KLAZ API fails (${api})`, async () => {
    const { calls, route } = portalRouter({ api });
    const logged = [];
    const original = console.info;
    console.info = (...args) => logged.push(args);
    let result;
    try {
      result = await searchPrimaryHousing({ location:'Trittau', rooms:'1-2', amount:680.9, type:'Bruttokaltmiete', radiusKm:15, jobcenterJurisdiction:'Stormarn' }, KEY, route);
    } finally { console.info = original; }
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.listings.map(item => item.url), ['https://www.ohne-makler.net/immobilie/498456/']);
    assert.equal(calls.byHost['www.immowelt.de'] || 0, 0, 'Immowelt is not fetched');
    assert.equal(calls.apiLocations, 1);
    assert.equal(calls.api, 1, 'no /search after an account failure');
    const sources = JSON.parse(logged.find(([event]) => event === 'housing_search_sources')[1]);
    assert.deepEqual(sources.map(source => source.source), ['Kleinanzeigen API', 'Kleinanzeigen public', 'Ohne-Makler', 'KIP Schleswig-Holstein', 'Housing companies', 'Immomio', 'WG-Gesucht', 'Vonovia', 'primary-merge']);
    assert.equal(sources[0].status, api === 'credits' ? 'insufficient_credits' : 'rate_limited');
    assert.ok(sources[2].count >= 1, 'Ohne-Makler answers the search');
    assert.ok(sources[1].pages.every(page => 'httpStatus' in page && 'bytes' in page && 'durationMs' in page));
  });
}

test('without any answering source the result is unavailable, never the provider credits status', async () => {
  const result = await searchPrimaryHousing({ location:'Trittau', rooms:'2', amount:680, type:'Kaltmiete', radiusKm:15 }, KEY, async url => String(url).includes('kleinanzeigen-agent')
    ? json({ success:false, error_code:'INSUFFICIENT_CREDITS' }, 402)
    : new Response('down', { status:503 }));
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.listings, []);
});

test('after a 402 the KLAZ API is not called again on the same transport (whole-Kreis anchors)', async () => {
  let locations = 0, searches = 0;
  const transport = async url => {
    if (String(url).includes('/locations?')) { locations += 1; await new Promise(resolve => setTimeout(resolve, 5)); }
    else searches += 1;
    return json({ success:false, error_code:'INSUFFICIENT_CREDITS' }, 402);
  };
  const anchors = ['Trittau', 'Ahrensburg', 'Bad Oldesloe', 'Reinbek', 'Bargteheide'];
  const results = await Promise.all(anchors.map(location => searchLiveHousing({ location, rooms:'2', amount:700, type:'Kaltmiete', radiusKm:15 }, KEY, transport, { includePublic:false })));
  assert.equal(locations, 1);
  assert.equal(searches, 0);
  assert.ok(results.every(result => result.status === 'insufficient_credits'));
  // A fresh invocation (new transport) tries again.
  await searchLiveHousing({ location:'Trittau', rooms:'2', amount:700, type:'Kaltmiete' }, KEY, async () => { locations += 1; return json({ success:false, error_code:'INSUFFICIENT_CREDITS' }, 402); });
  assert.equal(locations, 2);
});

function workerEnv() {
  return {
    TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1',
    TELEGRAM_BOT_TOKEN:TOKEN, TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true', TELEGRAM_DELIVERY_ENABLED:'true',
    KLAZ_API_KEY:KEY
  };
}

async function runRadiusSearch({ api = 'credits', callback = 'jcr:15:2:1-2:Trittau', updateId = 914001, empty = false } = {}) {
  const { calls, route } = portalRouter({ api, empty });
  const telegram = [];
  let external = 0;
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  console.info = () => {};
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url?.url || url);
    external += 1;
    if (external > 50) throw new Error('Too many subrequests.');
    if (target.startsWith('https://api.telegram.org/')) {
      let body = {};
      if (typeof options.body === 'string') { try { body = JSON.parse(options.body); } catch {} }
      else if (options.body instanceof FormData) body = { caption:String(options.body.get('caption') || '') };
      telegram.push({ method:target.split('/').at(-1), text:String(body.text || body.caption || ''), markup:JSON.stringify(body.reply_markup || '') });
      return json({ ok:true, result:{ message_id:300 + telegram.length, chat:{ id:USER, type:'private' } } });
    }
    const accept = String(options?.headers?.accept || '');
    if (!/^\s*image\//iu.test(accept)) providerCalls += 1;
    return route(url, options);
  };
  try {
    const request = new Request('https://x.example/telegram/stateless', {
      method:'POST',
      headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
      body:JSON.stringify({ update_id:updateId, callback_query:{
        id:`cbq-${updateId}`, from:{ id:USER, is_bot:false }, data:callback,
        message:{ message_id:46, date:Math.floor(Date.now() / 1000), chat:{ id:USER, type:'private' }, text:'🏛 Jobcenter' }
      } })
    });
    const waits = [];
    const response = await worker.fetch(request, workerEnv(), { waitUntil:promise => waits.push(promise) });
    await Promise.allSettled(waits);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
  }
  return { telegram, external, providerCalls, calls };
}

test('Trittau 15 km Jobcenter search with KLAZ 402 delivers public listing cards to Telegram', async () => {
  const { telegram, calls } = await runRadiusSearch({ api:'credits' });
  const all = telegram.map(call => call.text).join('\n');
  assert.match(all, /Großensee/u);
  assert.ok(telegram.some(call => /ohne-makler\.net\/immobilie\/498456\//u.test(call.text + call.markup)), JSON.stringify(telegram).slice(0, 2000));
  assert.doesNotMatch(all, /credits|Не вдалося отримати оголошення|Провайдер/u);
  assert.doesNotMatch(all, /Hamburg|Lübeck|Dassendorf|Wentorf|Mölln/u, 'other Kreise and Hamburg are filtered');
  assert.equal(calls.apiLocations, 1);
  assert.equal(calls.byHost['www.immobilienscout24.de'] || 0, 0, 'ImmoScout24 is not fetched');
});

test('Trittau Jobcenter search with KLAZ 429 still delivers public listing cards', async () => {
  const { telegram } = await runRadiusSearch({ api:'rate', updateId:914002 });
  assert.ok(telegram.some(call => /ohne-makler\.net\/immobilie\/498456\//u.test(call.text + call.markup)));
  assert.doesNotMatch(telegram.map(call => call.text).join('\n'), /обмежив частоту|Не вдалося отримати оголошення/u);
});

// Workers Free: 50 subrequests per invocation, providers get 32.
for (const [label, api, callback, empty] of [
  ['KLAZ 402, public listings found', 'credits', 'jcr:15:2:1-2:Trittau', false],
  ['KLAZ working, public listings found', 'ok', 'jcr:15:2:1-2:Trittau', false],
  ['KLAZ 402, 20 km', 'credits', 'jcr:20:2:1-2:Trittau', false],
  ['KLAZ 402, 25 km', 'credits', 'jcr:25:2:1-2:Trittau', false],
  ['KLAZ 402, nothing fits so the delivery fallback layers run', 'credits', 'jcr:15:2:1-2:Trittau', true]
]) {
  test(`subrequest budget: one radius search stays within 32 provider and 50 total calls (${label})`, async () => {
    const run = await runRadiusSearch({ api, callback, empty, updateId:915000 + Math.floor(Math.random() * 1000) });
    console.log(`budget ${label}: provider=${run.providerCalls} total=${run.external} telegram=${run.telegram.length}`);
    assert.ok(run.providerCalls <= 32, `provider calls ${run.providerCalls}`);
    assert.ok(run.external <= 50, `total calls ${run.external}`);
    assert.ok(run.telegram.some(call => call.method === 'sendMessage' || call.method === 'editMessageText'));
  });
}

test('a listing with both rents is compared by the limit type: Kaltmiete limit with Kaltmiete, others with Warmmiete', async () => {
  const { filterPrimaryListings } = await import('../src/housing-primary-search.mjs');
  const item = { title:'2-Zimmer Wohnung', price:797.5, priceType:'Warmmiete', coldPrice:500, rooms:'2', location:'24159 Kiel', town:'Kiel', distanceKm:2, sourceId:'big-verwaltung', url:'https://big-verwaltung.de/immobilien/x/' };
  const base = { location:'Kiel', rooms:'2', amount:600, radiusKm:10 };
  assert.equal(filterPrimaryListings([item], { ...base, type:'Kaltmiete' }).length, 1);
  assert.equal(filterPrimaryListings([item], { ...base, type:'Warmmiete' }).length, 0);
  assert.equal(filterPrimaryListings([item], { ...base, type:'Bruttokaltmiete' }).length, 0, 'the warm price never passes a Bruttokalt limit it exceeds');
});
