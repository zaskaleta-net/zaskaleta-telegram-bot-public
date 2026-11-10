import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKipHousingPage, searchKipHousing, searchImmoScout24Housing
} from '../src/housing-expanded-v22.mjs';
import { handle } from '../src/runtime.mjs';
import { fixture, NOW, USER, SECRET } from './runtime-fixture.mjs';

const criteria = { location:'Trittau', rooms:'3-4', amount:943.8, radiusKm:15 };
const html = text => new Response(text, { headers:{ 'content-type':'text/html; charset=UTF-8' } });
const immoCard = '<a href="/expose/1002">Wohnung mit Balkon 735 € 75 m² 3 Zi. Trittau</a>';

// Synthetic data with the actual KIP layout: duplicate links, nested columns,
// and a numeric euro entity well beyond the old 1,800-character window.
function kipCard(id, { city='Trittau', price='735,00 &#128;', rooms='3' } = {}) {
  const url = `/schleswig-holstein/trittau/mieten/Wohnung_${id}`;
  return `<div class="bgSecondaryLight b-grey hover m-b-30 list-element">
    <h3><a href="${url}">Wohnung mit Balkon</a></h3>
    <div><a href="${url}"><img alt="Wohnung" src="/photo.jpg"></a></div>
    <div class="col-md-8 col-sm-12 p-h-15"><div class="row">
    <h4>22946 ${city}</h4>
    <dl><dt>75 m&sup2;</dt><dd><small>Wohnfläche</small></dd></dl>
    ${'<div class="col-xs-12 col-md-6"> </div>\n'.repeat(60)}
    <dl><dt>${rooms}</dt><dd><small>Anzahl Zimmer</small></dd></dl>
    ${price ? `<dl><dt>${price}</dt><dd><small>Kaltmiete</small></dd></dl>` : ''}
    </div></div><a href="${url}" title="Exposé öffnen"><i></i></a></div>`;
}

test('current KIP card boundaries and euro entities yield complete, distinct candidates', () => {
  const page = kipCard('W1001') + kipCard('W1002', { price:'800,00 &#x80;' })
    + kipCard('W1003', { city:'Koberg' }) + kipCard('W1004', { price:'1.600,00 &#128;' })
    + kipCard('W1005', { price:null }) + kipCard('W1006', { rooms:'2' });
  const found = parseKipHousingPage(page, criteria);
  assert.deepEqual(found.map(item => item.id), ['W1001', 'W1002']);
  assert.deepEqual(found.map(item => item.price), [735, 800]);
  assert.ok(found.every(item => item.priceType === 'Kaltmiete' && item.areaSqm === 75 && item.location === '22946 Trittau'));
  assert.ok(found.every(item => item.url.includes('/mieten/Wohnung_')));
});

test('KIP reports parsed but filtered cards separately from HTTP and layout failures', async () => {
  const result = await searchKipHousing(criteria, async url => {
    const value = String(url);
    if (value.includes('/kreis-stormarn/')) return new Response('missing', { status:404 });
    return html(kipCard('W1001', { price:'1.600,00 &#128;' }));
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.listings.length, 0);
  assert.equal(result.pages[0].reason, 'parsed');
  assert.equal(result.pages[0].parsedCount, 1);
  assert.equal(result.pages[0].matchedCount, 0);
  assert.equal(result.pages[1].reason, 'parsed');
  assert.equal(result.pages[2].reason, 'http_error');
  assert.equal(result.pages[2].httpStatus, 404);
  assert.equal(result.pages[3].reason, 'http_error');
  assert.equal(result.pages[3].httpStatus, 404);
  assert.deepEqual(result.searchUrls, [
    'https://www.kip.net/schleswig-holstein/trittau/mieten/wohnungen',
    'https://www.kip.net/schleswig-holstein/trittau/mieten/haeuser'
  ]);
  const changed = await searchKipHousing(criteria, async () => html('<h1>New layout</h1>'));
  assert.equal(changed.status, 'unavailable');
  assert.ok(changed.pages.every(page => page.reason === 'unrecognized_html'));
  const gone = await searchImmoScout24Housing(criteria, async () => new Response('Gone', { status:410 }));
  assert.equal(gone.searchUrl, null);
});

test('a response completing after the old 6.5-second limit still yields its listing', async t => {
  t.mock.timers.enable({ apis:['setTimeout', 'Date'], now:0 });
  const pending = searchImmoScout24Housing(criteria, (_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(html(immoCard)), 9000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once:true });
  }));
  t.mock.timers.tick(9001);
  const result = await pending;
  assert.equal(result.status, 'ok');
  assert.equal(result.listings[0].id, '1002');
  assert.equal(result.pages[0].httpStatus, 200);
  assert.equal(result.pages[0].reason, 'parsed');
  assert.ok(result.pages[0].durationMs >= 9000);
});

test('the deadline covers a stalled body and preserves HTTP evidence', async t => {
  t.mock.timers.enable({ apis:['setTimeout', 'Date'], now:0 });
  const pending = searchImmoScout24Housing(criteria, async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once:true }); }
  }), { headers:{ 'content-type':'text/html' } }));
  await Promise.resolve();
  t.mock.timers.tick(12001);
  const result = await pending;
  assert.equal(result.status, 'unavailable');
  assert.equal(result.pages[0].reason, 'timeout');
  assert.equal(result.pages[0].httpStatus, 200);
  assert.equal(result.pages[0].bytesReceived, 0);
});

test('rejected responses release the body and retain distinct failure reasons', async () => {
  for (const [kind, status, headers, reason] of [
    ['http', 503, {}, 'http_error'],
    ['type', 200, { 'content-type':'application/json' }, 'unsupported_content_type'],
    ['large', 200, { 'content-type':'text/html', 'content-length':String(3 * 1024 * 1024) }, 'response_too_large'],
    ['redirect', 200, { 'content-type':'text/html' }, 'rejected_redirect']
  ]) {
    let cancelled = false;
    const result = await searchImmoScout24Housing(criteria, async () => {
      const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers });
      if (kind === 'redirect') Object.defineProperty(response, 'url', { value:'https://other.example/' });
      return response;
    });
    assert.equal(cancelled, true, kind);
    assert.equal(result.pages[0].reason, reason, kind);
    assert.equal(result.pages[0].httpStatus, status, kind);
  }
});

test('a recovered KIP listing reaches the dispatcher output; diagnostics contain no private context', async t => {
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  const f = await fixture();
  try {
    const transport = async (url, options) => String(url).includes('kip.net') ? html(kipCard('W1001')) : f.transport(url, options);
    const response = await handle(f.request('', { callback:'jcr:15:4:3-4:Trittau' }), f.env, NOW, transport);
    assert.equal((await response.json()).delivered, true);
    const sent = f.calls.filter(call => call.method === 'sendMessage').map(call => call.body);
    const result = sent.find(message => message.text.includes('Wohnung mit Balkon'));
    assert.ok(result);
    assert.match(JSON.stringify(result.reply_markup), /Wohnung_W1001/u);
    assert.match(result.text, /943,80 € Bruttokaltmiete/u);
    assert.equal(result.reply_markup.keyboard, undefined);
    assert.equal(result.reply_markup.force_reply, undefined);
    assert.equal(result.reply_markup.remove_keyboard, undefined);
    const diagnostic = logs.find(args => args[0] === 'housing_search_sources');
    assert.ok(diagnostic);
    const serialized = diagnostic[1];
    for (const privateValue of [String(USER), SECRET, f.env.TELEGRAM_BOT_TOKEN, 'Trittau', 'Wohnung_W1001', 'https://']) {
      assert.equal(serialized.includes(privateValue), false, privateValue);
    }
    const sources = JSON.parse(serialized);
    assert.equal(sources.find(item => item.source === 'KIP Schleswig-Holstein').count, 1);
    assert.equal(f.env.TELEGRAM_MAINTENANCE_MODE, 'true');
  } finally { f.close(); }
});
