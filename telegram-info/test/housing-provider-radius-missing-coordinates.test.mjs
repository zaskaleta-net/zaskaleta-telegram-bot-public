import test from 'node:test';
import assert from 'node:assert/strict';
import { searchLiveHousing } from '../src/housing-provider.mjs';

const KEY = 'klaz_live_' + 'A'.repeat(24);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers:{ 'content-type':'application/json' } });
}

test('provider distance scope is trusted when origin has coordinates but an otherwise valid ad omits coordinates', async () => {
  const criteria = { location:'Ahrensburg', rooms:'3-4', amount:1138.5, type:'Bruttokaltmiete', radiusKm:15 };
  const result = await searchLiveHousing(criteria, KEY, async url => {
    if (String(url).includes('/locations?')) {
      return json({ success:true, data:{ locations:[{
        id:'920', name:'Ahrensburg', latitude:53.675, longitude:10.241
      }] } });
    }
    return json({ success:true, data:{ ads:[{
      ad_id:'123456789',
      title:'Attraktive 3-Zimmer-Einliegerwohnung in Ahrensburg',
      description:'Zur Vermietung steht eine attraktive 3-Zimmer-Wohnung.',
      price:{ amount:930, price_type:'SPECIFIED_AMOUNT' },
      status:'ACTIVE',
      deleted:false,
      ad_url:'https://www.kleinanzeigen.de/s-anzeige/attraktive-3-zimmer-einliegerwohnung/123456789',
      location:{ name:'22926 Ahrensburg' },
      details:{ Zimmer:'3', Wohnfläche:'66,4 m²' },
      images:[{ url:'https://img.kleinanzeigen.de/api/v1/prod-ads/images/test.jpg' }],
      created_at:'2026-09-13T12:00:00Z'
    }] } });
  }, { includePublic:false });

  assert.equal(result.status, 'ok');
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].id, '123456789');
  assert.equal(result.listings[0].rooms, '3');
  assert.equal(result.listings[0].areaSqm, 66.4);
  assert.equal(result.listings[0].price, 930);
  assert.equal(result.listings[0].distanceKm, null);
});
