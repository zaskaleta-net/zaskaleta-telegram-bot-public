import test from 'node:test';
import assert from 'node:assert/strict';
import { housingActiveTransport } from '../src/housing-active-v22.mjs';

// TG-RUNTIME-014: ImmoScout24 answers every Cloudflare Workers request with
// HTTP 401, so the room-scoped ImmoScout recovery (video 57229 Kappeln and
// Lübeck exact-room cases) is no longer fetched automatically. These tests
// previously asserted that the fallback fetched /3-zimmer-wohnung-mieten pages;
// they now assert that the fallback stays off ImmoScout and still answers.
const TELEGRAM_URL = 'https://api.telegram.org/bot123:TEST/sendMessage';

function jobcenterPayload({ location, rooms, amount }) {
  return {
    chat_id:321,
    text:[
      `🔎 Автопошук житла під Jobcenter — ${location}`,
      'Осіб: 3',
      `Кімнати: ${rooms}`,
      `Орієнтир Jobcenter: до ${amount} € Bruttokaltmiete; площа-орієнтир до 75 м².`,
      'Heizkosten перевіряються окремо.',
      'Радіус пошуку: 15 км.',
      '',
      'Живий пошук оголошень підготовлено, але провайдер ще не підключено.'
    ].join('\n')
  };
}

for (const [location, rooms, amount] of [['Kappeln', '3', '669'], ['Lübeck', '3', '700'], ['Rendsburg', '3-4', '800']]) {
  test(`${location} Jobcenter fallback no longer fetches ImmoScout24 and still sends a final answer`, async () => {
    const fetched = [];
    const sent = [];
    const transport = async (url, options = {}) => {
      const target = String(url);
      if (target.startsWith('https://api.telegram.org/')) {
        sent.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ ok:true, result:{ message_id:sent.length, chat:{ id:321 } } }), {
          status:200,
          headers:{ 'content-type':'application/json' }
        });
      }
      fetched.push(target);
      return new Response('unavailable', { status:503, headers:{ 'content-type':'text/plain' } });
    };

    await housingActiveTransport(transport, { keyboardPolicy:false })(TELEGRAM_URL, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(jobcenterPayload({ location, rooms, amount }))
    });

    assert.ok(fetched.length > 0, 'the fallback still reads the public sources');
    assert.equal(fetched.some(url => /immobilienscout24\.de/u.test(url)), false);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Не вдалося отримати оголошення з підключених джерел/u);
  });
}
