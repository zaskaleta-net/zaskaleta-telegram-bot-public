import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker-entry-pilot-v21.mjs';

const USER = 424242;
const SECRET = 'q'.repeat(32);
const TOKEN = `12345:${'B'.repeat(32)}`;
const KEY = 'klaz_live_' + 'B'.repeat(24);

// User request 2026-10-13: for a Jobcenter search the price decides. A flat with
// more rooms than the household guideline, or without a photo, is still a
// candidate when its Bruttokaltmiete fits.
function apiAd(id, rooms, price) {
  return {
    ad_id:String(id), title:`Wohnung ${id} in Trittau`, description:'Mietwohnung',
    price:{ amount:price, price_type:'SPECIFIED_AMOUNT' }, status:'ACTIVE',
    ad_url:`https://www.kleinanzeigen.de/s-anzeige/w/${3000000 + id}`,
    location:{ name:'Trittau' }, details:{ Zimmer:String(rooms) }, images:[]
  };
}

test('Jobcenter radius search keeps a larger flat without a photo when the price fits', async () => {
  const telegram = [];
  const searches = [];
  const original = globalThis.fetch;
  const originalInfo = console.info;
  console.info = () => {};
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url?.url || url);
    if (target.startsWith('https://api.telegram.org/')) {
      let body = {};
      try { body = JSON.parse(options.body); } catch {}
      telegram.push({ method:target.split('/').at(-1), text:String(body.text || body.caption || ''), markup:JSON.stringify(body.reply_markup || '') });
      return Response.json({ ok:true, result:{ message_id:500 + telegram.length, chat:{ id:USER, type:'private' } } });
    }
    if (target.includes('/locations?')) return Response.json({ success:true, data:{ locations:[{ id:'10410', name:'Trittau', city:'Trittau' }] } });
    if (target.includes('/search?')) {
      searches.push(new URL(target).searchParams);
      return Response.json({ success:true, data:{ ads:[apiAd(1, 4, 650), apiAd(2, 2, 600), apiAd(3, 4, 900)] } });
    }
    return new Response('unavailable', { status:503 });
  };
  try {
    const env = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_BOT_TOKEN:TOKEN, TELEGRAM_WEBHOOK_SECRET:SECRET, TELEGRAM_INGRESS_ENABLED:'true', TELEGRAM_DELIVERY_ENABLED:'true', KLAZ_API_KEY:KEY };
    const request = new Request('https://x.example/telegram/stateless', {
      method:'POST',
      headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
      body:JSON.stringify({ update_id:930001, callback_query:{ id:'cbq-930001', from:{ id:USER, is_bot:false }, data:'jcr:15:2:1-2:Trittau',
        message:{ message_id:61, date:Math.floor(Date.now() / 1000), chat:{ id:USER, type:'private' }, text:'🏛 Jobcenter' } } })
    });
    const waits = [];
    await worker.fetch(request, env, { waitUntil:promise => waits.push(promise) });
    await Promise.allSettled(waits);
  } finally {
    globalThis.fetch = original;
    console.info = originalInfo;
  }
  assert.ok(searches.length >= 1);
  assert.ok(searches.every(params => params.get('picture_required') === 'false'));
  const all = telegram.map(call => `${call.text}\n${call.markup}`).join('\n');
  assert.match(all, /Wohnung 1 in Trittau/u, '4 rooms for 2 persons at 650 € is within 680,90 €');
  assert.match(all, /Wohnung 2 in Trittau/u);
  assert.doesNotMatch(all, /Wohnung 3 in Trittau/u, '900 € is above the limit');
  // The household guideline is still what the user sees.
  assert.match(all, /Кімнати: 1-2/u);
});
