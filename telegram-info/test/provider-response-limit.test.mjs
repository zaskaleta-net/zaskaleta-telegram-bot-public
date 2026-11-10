import test from 'node:test';
import assert from 'node:assert/strict';
import { searchLiveHousing } from '../src/housing-provider.mjs';

const KEY = 'klaz_live_' + 'A'.repeat(24);
const criteria = { location: 'Trittau', rooms: '3-4', roomsMin: 3, roomsMax: 4, amount: 1000, type: 'Warmmiete' };

const locationResponse = () => new Response(JSON.stringify({
  success: true,
  data: { locations: [{ id: '10410', name: 'Trittau' }] }
}), { status: 200, headers: { 'content-type': 'application/json' } });

const listing = {
  ad_id: '1',
  title: '3-Zimmer-Wohnung zur Miete',
  description: 'Langfristig zu vermieten.',
  price: { amount: 850, price_type: 'SPECIFIED_AMOUNT' },
  status: 'ACTIVE',
  deleted: false,
  ad_url: 'https://www.kleinanzeigen.de/s-anzeige/wohnung/1',
  location: { name: '22926 Ahrensburg' },
  details: { Zimmer: '3' }
};

function payload(paddingBytes) {
  return new Response(JSON.stringify({
    success: true,
    data: { ads: [listing], padding: 'x'.repeat(paddingBytes) }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('provider accepts a normal live payload above the old 256 KiB ceiling', async () => {
  let calls = 0;
  const result = await searchLiveHousing(criteria, KEY, async url => {
    calls++;
    return url.includes('/locations?') ? locationResponse() : payload(300000);
  });
  assert.equal(calls, 3);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.listings.map(item => item.id), ['1']);
});

test('provider still fails closed above the 512 KiB ceiling', async () => {
  const result = await searchLiveHousing(criteria, KEY, async url =>
    url.includes('/locations?') ? locationResponse() : payload(540000)
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(result.providerError, 'too_large');
  assert.deepEqual(result.listings, []);
});
