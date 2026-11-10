import test from 'node:test';
import assert from 'node:assert/strict';
import { housingActiveTransport } from '../src/housing-active-v21.mjs';
import { handle } from '../src/runtime.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// TG-RUNTIME-043: phone smoke 17.10.2026 (Trittau, 4 persons) showed the
// Stormarn norm as "943,8 €" in the radius header and the empty-result
// line, but "943,80 €" elsewhere. A euro amount always has two decimals.

test('TG-RUNTIME-043 the empty radius result states the norm with cents', async () => {
  let sent = null;
  const transport = async (url, options = {}) => {
    if (/api\.telegram\.org/u.test(String(url))) {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ ok:true, result:{ message_id:1 } }), { headers:{ 'content-type':'application/json' } });
    }
    return new Response('not found', { status:404 });
  };
  const text = [
    '🔎 Автопошук житла під Jobcenter — Trittau', 'Осіб: 4', 'Кімнати: 3-4',
    'Орієнтир Jobcenter Stormarn: до 943,80 € Bruttokaltmiete; площа-орієнтир до 90 м².',
    'Heizkosten перевіряються окремо.', 'Радіус пошуку: 15 км.', '',
    'Живий пошук оголошень підготовлено, але провайдер ще не підключено.'
  ].join('\n');
  await housingActiveTransport(transport)('https://api.telegram.org/bot123:ABC/sendMessage', {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ chat_id:1, text })
  });
  assert.ok(sent, 'the message reaches Telegram');
  assert.match(sent.text, /^Параметри: Trittau, 3-4 кімнати, до 943,80 €\.$/mu);
  assert.doesNotMatch(sent.text, /943,8 €/u);
});

test('TG-RUNTIME-043 the radius search header states the norm with cents', async () => {
  const f = await fixture();
  try {
    const response = await handle(f.request('', { callback:'jcr:15:4:3-4:Trittau' }), f.env, NOW, f.transport);
    assert.equal((await response.json()).mode, 'private-jobcenter-radius-search');
    const texts = f.calls.filter(call => call.method === 'sendMessage').map(call => call.body.text);
    const header = texts.find(text => /Автопошук житла під Jobcenter — Trittau/u.test(text));
    assert.ok(header, JSON.stringify(texts).slice(0, 800));
    assert.match(header, /Орієнтир Jobcenter Stormarn: до 943,80 € Bruttokaltmiete/u);
    assert.doesNotMatch(texts.join('\n'), /943,8 €/u);
  } finally {
    await f.close?.();
  }
});

test('TG-RUNTIME-043 a plain listing line shows price and distance in German format', async () => {
  const { formatHousingListings } = await import('../src/housing-provider-base.mjs');
  const text = formatHousingListings({ location:'Trittau', rooms:'3', amount:943.8, type:'Bruttokaltmiete' },
    { status:'ok', listings:[{ title:'Wohnung', price:471.98, location:'Trittau', distanceKm:7 }] });
  assert.match(text, /до 943,80 €/u);
  assert.match(text, /471,98 € · Trittau · ≈7 км/u);
  assert.doesNotMatch(text, /\d\.\d/u, 'no decimal point in amounts or distances');
});

test('TG-RUNTIME-043 photo and text listing cards show the same euro format', async () => {
  const { publicListingCardMedia, publicListingCardText } = await import('../src/public-housing-cards.mjs');
  const criteria = { location:'Trittau', rooms:'3-4', amount:943.8 };
  for (const [price, shown] of [[943.8, '943,80'], [1092.5, '1092,50'], [750, '750']]) {
    const item = {
      title:'Wohnung', price, location:'22946 Trittau', rooms:'3', areaSqm:71, source:'KIP',
      url:'https://www.kip.net/schleswig-holstein/trittau/mieten/Wohnung_W1', imageUrl:'https://img.example.test/a.jpg'
    };
    const [media] = publicListingCardMedia(criteria, item, 0, 1);
    assert.ok(media, 'a listing with a safe image becomes a photo card');
    assert.match(media.caption, new RegExp(`💶 ${shown} €`, 'u'));
    assert.match(publicListingCardText(criteria, item, 0, 1), new RegExp(`${shown} €`, 'u'));
  }
});
