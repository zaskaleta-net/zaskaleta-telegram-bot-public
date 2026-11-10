import test from 'node:test';
import assert from 'node:assert/strict';
import { wgSearchUrl } from '../src/housing-wg-gesucht.mjs';
import { searchLiveHousing } from '../src/housing-provider.mjs';
import { filterPrimaryListings } from '../src/housing-primary-search.mjs';

// TG-RUNTIME-051: portals take a whole-euro price limit. Rounding a KdU
// limit such as 943,80 € down to 943 € hid every listing between 943,01 and
// 943,80 €, although it fits the limit. The limit is rounded up; the bot's own
// filter then drops anything above the exact limit (as TG-RUNTIME-044 did for
// the public Kleinanzeigen pages).

const KEY = 'klaz_live_' + 'A'.repeat(24);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers:{ 'content-type':'application/json' } });

test('#051 WG-Gesucht gets the limit rounded up to the next whole euro', () => {
  const rMax = maxRent => new URL(wgSearchUrl({ cityId:1366, cityName:'Trittau', lat:53.6, lon:10.4, radiusKm:15, maxRent })).searchParams.get('rMax');
  assert.equal(rMax(943.8), '944');
  assert.equal(rMax(645.75), '646');
  assert.equal(rMax(950), '950', 'a whole-euro limit stays as it is');
});

test('#051 the Kleinanzeigen API gets the limit rounded up to the next whole euro', async () => {
  const prices = [];
  const transport = async url => {
    if (url.includes('/locations?')) return json({ success:true, data:{ locations:[{ id:'1', name:'Trittau', city:'Trittau' }] } });
    prices.push(new URL(url).searchParams.get('max_price'));
    return json({ success:true, data:{ ads:[] } });
  };
  await searchLiveHousing({ location:'Trittau', rooms:'3-4', amount:943.8, type:'Bruttokaltmiete' }, KEY, transport, { includePublic:false });
  assert.ok(prices.length >= 1);
  assert.ok(prices.every(value => value === '944'), prices.join(','));
});

test('#051 the bot still drops a listing above the exact limit and keeps one just inside it', () => {
  const listing = (id, price) => ({ id, sourceId:'wg-gesucht', source:'WG-Gesucht', title:'3-Zimmer-Wohnung', price, rooms:'3', location:'Trittau', distanceKm:2, url:`https://www.wg-gesucht.de/${id}.html` });
  const kept = filterPrimaryListings([listing('a', 943.5), listing('b', 943.9), listing('c', 944)], { location:'Trittau', rooms:'3-4', amount:943.8, type:'Bruttokaltmiete', radiusKm:15 });
  assert.deepEqual(kept.map(item => item.id), ['a']);
});
