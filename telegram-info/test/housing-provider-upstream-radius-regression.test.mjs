import test from 'node:test';
import assert from 'node:assert/strict';
import { searchLiveHousing } from '../src/housing-provider.mjs';

const KEY = 'klaz_live_' + 'A'.repeat(24);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers:{ 'content-type':'application/json' } });
}

test('live provider keeps valid upstream-radius listing when ad-level coordinates are absent', async () => {
  const criteria = { location:'Niebüll', rooms:1, amount:495, type:'Kaltmiete', radiusKm:15 };
  const calls = [];
  const result = await searchLiveHousing(criteria, KEY, async url => {
    calls.push(String(url));
    if (String(url).includes('/locations?')) {
      return json({ success:true, data:{ locations:[{
        id:'12891', name:'Niebüll', city:'Niebüll', latitude:54.7866, longitude:8.8285
      }] } });
    }
    return json({ success:true, data:{ ads:[{
      ad_id:'niebuell-1',
      title:'Schöne 1-Zimmerwohnung in Niebüll zu vergeben.',
      description:'Mietshaus mit 6 Wohnungen.',
      price:{ amount:290, price_type:'FIXED' },
      status:'ACTIVE',
      deleted:false,
      ad_url:'https://www.kleinanzeigen.de/s-anzeige/schoene-1-zimmerwohnung/123',
      location:{ name:'25899 Niebüll' },
      details:{ Zimmer:'1', 'Wohnfläche':'30 m²' },
      images:[{ url:'https://img.example.test/niebuell.jpg' }]
    }] } });
  }, { includePublic:false });

  assert.equal(result.status, 'ok');
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].id, 'niebuell-1');
  assert.equal(result.listings[0].price, 290);
  assert.equal(result.listings[0].distanceKm, null);
  assert.ok(calls.some(url => /distance=15/u.test(url)));
});
