import test from 'node:test';
import assert from 'node:assert/strict';
import { searchLiveHousing } from '../src/housing-provider.mjs';
import { handle } from '../src/runtime.mjs';

const KEY = 'klaz_live_' + 'A'.repeat(24);
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const USER = 777777777;
const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers:{ 'content-type':'application/json' } });
}

test('native provider radii are sent unchanged as the Kleinanzeigen distance parameter', async () => {
  for (const radiusKm of [5, 10, 15, 25]) {
    let searchUrl = null;
    const result = await searchLiveHousing(
      { location:'Trittau', rooms:'3', amount:1000, type:'Bruttokaltmiete', radiusKm },
      KEY,
      async url => {
        if (String(url).includes('/locations?')) {
          return json({ success:true, data:{ locations:[{ id:'10410', name:'Trittau', latitude:53.61, longitude:10.40 }] } });
        }
        searchUrl = String(url);
        return json({ success:true, data:{ ads:[] } });
      },
      { includePublic:false }
    );

    assert.ok(searchUrl, `search request missing for ${radiusKm} km`);
    assert.equal(new URL(searchUrl).searchParams.get('distance'), String(radiusKm));
    assert.equal(result.radiusKm, radiusKm);
    assert.equal(result.criteria.radiusKm, radiusKm);
  }
});

function env() {
  return {
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_ALLOWED_CHAT_IDS:String(USER),
    TELEGRAM_ADMIN_USER_IDS:String(USER),
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_DELIVERY_ENABLED:'false',
    KLAZ_API_KEY:KEY
  };
}

function request20() {
  return new Request('https://pilot.example/telegram/stateless', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-telegram-bot-api-secret-token':SECRET
    },
    body:JSON.stringify({
      update_id:51829001,
      callback_query:{
        id:'radius-contract-20',
        from:{ id:USER, is_bot:false },
        data:'jcr:20:4:3-4:Husum',
        message:{
          message_id:1201,
          date:NOW / 1000,
          chat:{ id:USER, type:'private' },
          text:'📍 Радіус пошуку: 15 км\nЗмінити радіус пошуку житла під Jobcenter:'
        }
      }
    })
  });
}

