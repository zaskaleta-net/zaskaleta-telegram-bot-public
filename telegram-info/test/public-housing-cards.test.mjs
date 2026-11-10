import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicListingCardText,
  publicListingCardMedia,
  publicListingCardMarkup,
  sendPublicHousingCards
} from '../src/public-housing-cards.mjs';
import { housingOutputTransport } from '../src/runtime-housing-output.mjs';

const criteria = { location:'Lübeck', rooms:'3', amount:1000, type:'Kaltmiete', radiusKm:15 };

function telegramOK(chatId, messageId) {
  return new Response(JSON.stringify({ ok:true, result:{ message_id:messageId, chat:{ id:chatId } } }), {
    status:200,
    headers:{ 'content-type':'application/json' }
  });
}

test('public card copy states that listing price is not proven Bruttokaltmiete compliance', () => {
  const text = publicListingCardText(criteria, {
    title:'Wohnung in Lübeck', price:850, priceType:'Kaltmiete', location:'Lübeck', rooms:'3', source:'Kleinanzeigen'
  });
  assert.match(text, /Kaltmiete/u);
  assert.match(text, /Bruttokaltmiete/u);
  assert.match(text, /Nebenkosten/u);
  assert.doesNotMatch(text, /Zusicherung erteilt|Jobcenter genehmigt/iu);
});

test('direct multi-source listings become cards while generic catalog pages never masquerade as apartment cards', async () => {
  const calls = [];
  const transport = async (url, options={}) => {
    calls.push({ url:String(url), options });
    if (url === 'https://img.example/listing.jpg') {
      return new Response(new Uint8Array([1,2,3,4]), { status:200, headers:{ 'content-type':'image/jpeg', 'content-length':'4' } });
    }
    if (String(url).endsWith('/sendPhoto')) return telegramOK(123, 501);
    if (String(url).endsWith('/sendMessage')) return telegramOK(123, 502);
    throw new Error(`unexpected URL ${url}`);
  };

  const result = {
    listings:[
      {
        title:'Helle 3 Zimmer Wohnung', price:900, priceType:'Kaltmiete', location:'Lübeck', rooms:'3', areaSqm:75,
        source:'Kleinanzeigen', url:'https://www.kleinanzeigen.de/s-anzeige/helle-wohnung/1234567890', imageUrl:'https://img.example/listing.jpg'
      },
      {
        title:'3 Zimmer Wohnung nahe Zentrum', price:880, priceType:'Kaltmiete', location:'Lübeck', rooms:'3', areaSqm:72,
        source:'ImmoScout24', url:'https://www.immobilienscout24.de/expose/987654321', imageUrl:null
      },
      {
        title:'Genossenschaftswohnung', price:780, priceType:'Gesamtmiete', location:'Lübeck', rooms:'3', areaSqm:68,
        source:'TRAVE Lübeck', url:'https://www.trave.de/interessenten/wohnung-mieten', imageUrl:null
      }
    ]
  };

  assert.equal(publicListingCardMedia(criteria, result.listings[0], 0, 2).length, 1);
  assert.deepEqual(publicListingCardMedia(criteria, result.listings[1], 1, 2), []);
  assert.equal(publicListingCardMarkup(result.listings[2]), null);

  const response = await sendPublicHousingCards({
    url:'https://api.telegram.org/botTEST_TOKEN/sendMessage',
    payload:{ chat_id:123, text:'original list', reply_parameters:{ message_id:77 } },
    criteria,
    result,
    transport
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.result.message_id, 501);
  assert.equal(calls.filter(call => call.url.endsWith('/sendPhoto')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/sendMessage')).length, 1);

  const textSend = calls.find(call => call.url.endsWith('/sendMessage'));
  const textPayload = JSON.parse(textSend.options.body);
  assert.match(textPayload.text, /2\/2/u);
  assert.match(textPayload.text, /ImmoScout24/u);
  assert.match(textPayload.text, /Bruttokaltmiete/u);
  assert.equal(textPayload.reply_markup.inline_keyboard[0][0].url, 'https://www.immobilienscout24.de/expose/987654321');

  const photoSend = calls.find(call => call.url.endsWith('/sendPhoto'));
  assert.match(String(photoSend.options.body.get('caption')), /1\/2/u);
  assert.match(String(photoSend.options.body.get('caption')), /Bruttokaltmiete/u);
  assert.equal(JSON.parse(photoSend.options.body.get('reply_parameters')).message_id, 77);
});


test('runtime fallback recovers a Kiel district listing with image into Telegram sendPhoto', async () => {
  const calls = [];
  const listingHtml = `
    <article class="aditem" data-adid="3513576572">
      <div class="aditem-image">
        <a href="/s-anzeige/kaiserstrasse-3-zimmerwohnung-einbaukueche-zu-vermieten-/3513576572-203-702">
          <img src="https://img.kleinanzeigen.de/api/v1/prod-ads/images/kiel-card.jpg">
        </a>
      </div>
      <div class="aditem-main">
        <div>24143 Gaarden(1 km)</div>
        <h2><a href="/s-anzeige/kaiserstrasse-3-zimmerwohnung-einbaukueche-zu-vermieten-/3513576572-203-702">Kaiserstraße: 3 Zimmerwohnung, Einbauküche zu vermieten!</a></h2>
        <p>53 m² · 3 Zi.</p>
        <p>600 €</p>
      </div>
    </article>`;

  const transport = async (url, options={}) => {
    const target = String(url);
    calls.push({ target, options });

    if (target === 'https://img.kleinanzeigen.de/api/v1/prod-ads/images/kiel-card.jpg') {
      return new Response(new Uint8Array([1,2,3,4]), {
        status:200,
        headers:{ 'content-type':'image/jpeg', 'content-length':'4' }
      });
    }
    if (/kleinanzeigen\.de\/s-suchanfrage\.html/iu.test(target)) {
      return new Response(listingHtml, {
        status:200,
        headers:{ 'content-type':'text/html; charset=utf-8' }
      });
    }
    if (/kleinanzeigen\.de/iu.test(target)) {
      return new Response('<html><body>Keine weiteren Treffer</body></html>', {
        status:200,
        headers:{ 'content-type':'text/html; charset=utf-8' }
      });
    }
    if (/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendPhoto$/u.test(target)) {
      return telegramOK(123, 700);
    }
    if (/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/u.test(target)) {
      return telegramOK(123, 701);
    }
    return new Response('<html><body>Немає оголошень</body></html>', {
      status:200,
      headers:{ 'content-type':'text/html; charset=utf-8' }
    });
  };

  const wrapped = housingOutputTransport(transport);
  const response = await wrapped('https://api.telegram.org/botTEST_TOKEN/sendMessage', {
    method:'POST',
    body:JSON.stringify({
      chat_id:123,
      text:[
        '🔎 Автопошук житла під Jobcenter — Kiel',
        'Осіб: 3',
        'Кімнати: 3',
        'Орієнтир Jobcenter Kiel: до 679 € Bruttokaltmiete; площа-орієнтир до 75 м².',
        'Heizkosten перевіряються окремо.',
        'Радіус пошуку: 15 км.',
        '',
        'Сервіс актуальних оголошень тимчасово недоступний.'
      ].join('\n')
    })
  });

  const body = await response.json();
  assert.equal(body.ok, true);
  const photoCalls = calls.filter(call => /\/sendPhoto$/u.test(call.target));
  assert.equal(photoCalls.length, 1);
  const form = photoCalls[0].options.body;
  assert.match(String(form.get('caption')), /600/u);
  assert.match(String(form.get('caption')), /Gaarden/u);
  assert.match(String(form.get('caption')), /Bruttokaltmiete/u);
  assert.match(String(form.get('reply_markup')), /3513576572/u);
  assert.equal(
    calls.some(call => /s-suchanfrage\.html/iu.test(call.target) && /locationId=663(?:&|$)/u.test(call.target)),
    true
  );
});
