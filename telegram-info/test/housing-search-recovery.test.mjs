import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImmoScout24SearchPage, searchImmoScout24Housing } from '../src/housing-expanded-v22.mjs';
import { housingOutputTransport } from '../src/runtime-housing-output.mjs';
import { handle } from '../src/runtime.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

const criteria = { location:'Trittau', rooms:'3-4', amount:943.8, radiusKm:15 };
// Synthetic fixture matching visible portal card structure; no live ads in tests.
function card(id, { city='Trittau', price='665–735', rooms='3', inactive=false } = {}) {
  return `<div class="listing-card card-listing-S">
    ${inactive ? '<span>Deaktiviert vor 2 Tagen</span>' : ''}
    <a href="/expose/${id}"><img alt="" src="/preview.jpg"></a>
    <div class="card-attributes"><a href="/expose/${id}">
      <h2 data-testid="headline">Wohnung mit Balkon</h2>
      <div data-testid="attributes"><dl><dd>${price} €</dd></dl>
      <dl><dd>75 m²</dd></dl><dl><dd>${rooms}<!-- --> <!-- -->Zi.</dd></dl></div>
      <div data-testid="hybridViewAddress">${city}, Stormarn (Kreis)</div>
    </a></div></div>`;
}
const htmlResponse = html => new Response(html, { headers:{ 'content-type':'text/html; charset=utf-8' } });
// KIP card layout (see housing-source-retrieval.test.mjs). ImmoScout24 is no
// longer fetched automatically, so recovery candidates come from KIP here.
function kipCard(id, { price='735,00 &#128;', rooms='3' } = {}) {
  const url = `/schleswig-holstein/trittau/mieten/Wohnung_${id}`;
  return `<div class="list-element"><h3><a href="${url}">Wohnung mit Balkon</a></h3>
    <h4>22946 Trittau</h4><dl><dt>75 m&sup2;</dt><dd>Wohnfläche</dd></dl>
    <dl><dt>${rooms}</dt><dd>Anzahl Zimmer</dd></dl><dl><dt>${price}</dt><dd>Kaltmiete</dd></dl></div>`;
}
const header = [
  '🔎 Автопошук житла під Jobcenter — Trittau', 'Осіб: 4', 'Кімнати: 3-4',
  'Орієнтир Jobcenter Stormarn: до 943,8 € Bruttokaltmiete; площа-орієнтир до 90 м².',
  'Heizkosten перевіряються окремо.', 'Радіус пошуку: 15 км.'
].join('\n') + '\n\n';
const failure = 'Живий пошук оголошень підготовлено, але провайдер ще не підключено.';

async function outgoing(text, sources, reply_markup) {
  const sent = [], fetched = [];
  const transport = async (url, options) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      sent.push(JSON.parse(options.body));
      return new Response('{"ok":true,"result":{"message_id":1}}');
    }
    fetched.push(String(url));
    return sources(url, options);
  };
  await housingOutputTransport(transport)('https://api.telegram.org/bot123:TEST/sendMessage', {
    method:'POST', body:JSON.stringify({ chat_id:123, text:header + text, reply_markup })
  });
  return { payload:sent[0], fetched };
}

test('current cards retain title, upper price and real town without inactive or nearby ads', () => {
  const html = [card('1001', { inactive:true }), card('1002'), card('1003', { rooms:'3,5' }),
    card('1004', { city:'Koberg' }), card('1005', { price:'900–980' }), card('1006', { rooms:'2' })].join('');
  const listings = parseImmoScout24SearchPage(html, criteria);
  assert.deepEqual(listings.map(item => item.id), ['1002', '1003']);
  assert.equal(listings[0].title, 'Wohnung mit Balkon');
  assert.equal(listings[0].price, 735);
  assert.equal(listings[0].location, 'Trittau, Stormarn (Kreis)');
  assert.equal(listings[1].rooms, 3.5);
  assert.match(listings[0].summaryUk, /Betriebskosten, Heizkosten/u);
  assert.equal(parseImmoScout24SearchPage(card('1002').replaceAll('href="/expose/', 'href="https://other.example/expose/'), criteria).length, 0);
});

test('a result page above the previous 768 KiB cap is read without losing listings', async () => {
  const html = '<!--' + 'x'.repeat(1024 * 1024) + '-->' + card('1002');
  const result = await searchImmoScout24Housing(criteria, async () => new Response(html, {
    headers:{ 'content-type':'text/html', 'content-length':String(new TextEncoder().encode(html).length) }
  }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.listings.map(item => item.id), ['1002']);
});

test('undeclared oversized response is cancelled at the bound and reported unavailable', async () => {
  let cancelled = false, pulls = 0;
  const result = await searchImmoScout24Housing(criteria, async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(256 * 1024)); },
    cancel() { cancelled = true; }
  }), { headers:{ 'content-type':'text/html' } }));
  assert.equal(result.status, 'unavailable');
  assert.equal(cancelled, true);
  assert.ok(pulls <= 11, `Unbounded stream: ${pulls} chunks`);
});

test('challenge, changed markup and failed HTTP are not successful empty searches', async () => {
  for (const makeResponse of [
    () => htmlResponse('<h1>Verify you are human</h1><p>CAPTCHA required</p>'),
    () => htmlResponse('<h1>Unexpected page layout</h1>'),
    () => new Response('unavailable', { status:503 }),
    () => new Response('{}', { headers:{ 'content-type':'application/json' } }),
    () => { const response = htmlResponse(card('1002')); Object.defineProperty(response, 'url', { value:'https://other.example/' }); return response; }
  ]) {
    const result = await searchImmoScout24Housing(criteria, async () => makeResponse());
    assert.equal(result.status, 'unavailable');
    assert.equal(result.listings.length, 0);
  }
  const filtered = await searchImmoScout24Housing(criteria, async () => htmlResponse(card('1002', { price:'1500' })));
  assert.equal(filtered.status, 'ok');
  assert.equal(filtered.listings.length, 0);
});

test('unavailable sources produce honest copy and distinct town/district search links', async () => {
  const { payload } = await outgoing(failure, async () => new Response('unavailable', { status:503 }));
  assert.match(payload.text, /Не вдалося отримати оголошення/u);
  assert.match(payload.text, /Це не означає, що пропозицій немає/u);
  assert.doesNotMatch(payload.text, /лише перевірені|Активний пошук виконано/u);
  const links = payload.reply_markup.inline_keyboard.flat();
  assert.ok(links.some(link => link.text === '↗ KIP · Trittau'));
  assert.ok(links.some(link => link.text === '↗ KIP · Kreis Stormarn'));
  assert.equal(new Set(links.map(link => link.url)).size, links.length);
});

test('partial coverage is distinguished from a fully read empty result', async () => {
  for (const kreisAvailable of [false, true]) {
    const { payload, fetched } = await outgoing(failure, async url => String(url).includes('kip.net/schleswig-holstein/trittau/')
      || (kreisAvailable && String(url).includes('kip.net'))
      ? htmlResponse('<p>Keine Wohnungen gefunden</p>')
      : new Response('unavailable', { status:503 }));
    assert.match(payload.text, kreisAvailable ? /У прочитаних джерелах не знайдено/u : /Пошук виконано частково/u);
    assert.equal(fetched.some(url => url.includes('immobilienscout24.de')), false);
  }
});

test('successful existing public candidates are preserved instead of overwritten by another fallback', async () => {
  for (const prefix of [
    '🔎 Пошук автоматично продовжено через доступні відкриті житлові джерела.',
    'Kleinanzeigen не дав придатних результатів. Знайдено пропозиції у відкритих житлових джерелах'
  ]) {
    const markup = { inline_keyboard:[[{ text:'1. Пряма пропозиція', url:'https://www.trave.de/wohnung/test' }]] };
    const { payload, fetched } = await outgoing(`${prefix}\n1. Wohnung mit Balkon\n700 €`, async () => {
      throw new Error('A successful fallback must not start another search');
    }, markup);
    assert.match(payload.text, /Wohnung mit Balkon/u);
    assert.deepEqual(payload.reply_markup, markup);
    assert.equal(fetched.length, 0);
  }
});

test('a successful but empty provider response continues to the public sources', async () => {
  const empty = 'За фільтром Trittau, 3-4 кімнати, до 943.8 € зараз не знайдено надійно відфільтрованих пропозицій. Розширте бюджет/радіус або перевірте зовнішній пошук.';
  const { payload } = await outgoing(empty, async url => String(url).includes('kip.net/schleswig-holstein/trittau/mieten/wohnungen')
    ? htmlResponse(kipCard('W1002')) : new Response('unavailable', { status:503 }));
  assert.match(payload.text, /Wohnung mit Balkon/u);
  assert.match(JSON.stringify(payload.reply_markup), /Wohnung_W1002/u);
});

test('Trittau runtime delivers a recovered direct candidate and radius controls without disturbing typing', async () => {
  const f = await fixture();
  try {
    const transport = async (url, options) => String(url).includes('kip.net/schleswig-holstein/trittau/mieten/wohnungen')
      ? htmlResponse('<!--' + 'x'.repeat(1024 * 1024) + '-->' + kipCard('W1002')) : f.transport(url, options);
    const response = await handle(f.request('', { callback:'jcr:15:4:3-4:Trittau' }), f.env, NOW, transport);
    assert.equal((await response.json()).mode, 'private-jobcenter-radius-search');
    const messages = f.calls.filter(call => call.method === 'sendMessage').map(call => call.body);
    const result = messages.find(message => message.text.includes('Wohnung mit Balkon'));
    assert.ok(result, 'The direct candidate must reach the Telegram sendMessage payload');
    assert.match(result.text, /943,80 € Bruttokaltmiete/u);
    assert.match(result.text, /Heizkosten/u);
    assert.match(JSON.stringify(result.reply_markup), /Wohnung_W1002/u);
    assert.ok(
      messages.some(message => /jcr:15:4:3-4:Trittau/u.test(JSON.stringify(message.reply_markup || {}))),
      'Radius controls must be delivered even when cards and chooser are sent concurrently'
    );
    for (const message of messages) {
      assert.equal(message.reply_markup?.keyboard, undefined);
      assert.notEqual(message.reply_markup?.remove_keyboard, true);
      assert.notEqual(message.reply_markup?.force_reply, true);
    }
    assert.equal(f.env.TELEGRAM_MAINTENANCE_MODE, 'true');
  } finally { f.close(); }
});

// Staging 13.10.2026: Trittau, 4 persons, 3–4 rooms. The progress line was
// edited to "Пошук завершено", then the recovery search ran inside the final
// sendMessage and used up its 8 s Telegram timeout: the answer was aborted and
// the chat ended without a result. The final send now has its own timeout.
test('a recovery search that outlasts the caller timeout still delivers the final answer', async () => {
  const caller = new AbortController();
  const sent = [];
  const transport = async (url, options = {}) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      sent.push(JSON.parse(options.body));
      return new Response('{"ok":true,"result":{"message_id":1}}');
    }
    // The caller's Telegram timer fires while the portals are still answering.
    caller.abort();
    return htmlResponse('<html><body></body></html>');
  };
  const response = await housingOutputTransport(transport)('https://api.telegram.org/bot123:TEST/sendMessage', {
    method:'POST', signal:caller.signal, body:JSON.stringify({ chat_id:123, text:header + failure })
  });
  assert.equal(response.ok, true);
  assert.equal(sent.length, 1, 'the final answer reaches Telegram');
  assert.match(sent[0].text, /Автопошук житла під Jobcenter — Trittau/u);
});
