import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomSpec } from '../src/rooms.mjs';
import { replyFor } from '../src/worker.mjs';
import { housingSearchAction, parseHousingSearchAction, searchLiveHousing } from '../src/housing-provider.mjs';

const KEY = 'klaz_live_' + 'A'.repeat(24);

test('room parser accepts common ranges and normalizes them', () => {
  for (const value of ['3-4', '3–4', '3—4', '3/4', '3 або 4', '3 чи 4', '3 oder 4', '3 bis 4']) {
    assert.deepEqual(parseRoomSpec(value), { min: 3, max: 4, label: '3-4' }, value);
  }
  assert.deepEqual(parseRoomSpec('4-3'), { min: 3, max: 4, label: '3-4' });
  assert.deepEqual(parseRoomSpec('3'), { min: 3, max: 3, label: '3' });
  assert.equal(parseRoomSpec('0-3'), null);
  assert.equal(parseRoomSpec('3-21'), null);
});

test('guided housing flow preserves a room range', () => {
  const rooms = replyFor({
    text: '3-4',
    replyToText: 'Бюджет 1000 €, місто Trittau. Вкажіть кількість кімнат.'
  });
  assert.match(rooms, /Trittau, 3-4 кімнати/);
  assert.match(rooms, /Warmmiete чи Kaltmiete/);

  const radiusPrompt = replyFor({ text: 'Warmmiete', replyToText: rooms });
  assert.match(radiusPrompt, /Оберіть радіус пошуку/);
  const finished = replyFor({ text: '15 км', replyToText: radiusPrompt });
  assert.match(finished, /Критерії пошуку зібрано: Trittau, 3-4 кімнати, до 1000 € Warmmiete, радіус 15 км/);
});

test('search action round-trips a room range', () => {
  const action = housingSearchAction({ location: 'Trittau', rooms: '3-4', amount: 1000, type: 'Warmmiete' });
  assert.equal(action, '🔎 Trittau · 3-4 · 1000 · W');
  assert.deepEqual(parseHousingSearchAction(action), {
    location: 'Trittau', rooms: '3-4', roomsMin: 3, roomsMax: 4, amount: 1000, type: 'Warmmiete'
  });
});

test('live provider accepts listings inside the room range only', async () => {
  let calls = 0;
  const transport = async (url, options = {}) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    if (url.includes('/locations?')) {
      return new Response(JSON.stringify({ success: true, data: { locations: [{ id: 77, name: 'Trittau' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const parsed = new URL(url);
    assert.equal(parsed.pathname.endsWith('/search'), true);
    assert.equal(parsed.searchParams.get('q'), null);
    assert.equal(parsed.searchParams.get('ad_type'), null);
    assert.ok(['203','205'].includes(parsed.searchParams.get('category_id')));
    assert.equal(parsed.searchParams.get('location_id'), '77');
    assert.equal(parsed.searchParams.get('distance'), '15');
    assert.equal(parsed.searchParams.get('max_price'), '1000');
    assert.equal(parsed.searchParams.get('picture_required'), 'false', 'listings without photos are shown as text cards');
    assert.equal(parsed.searchParams.get('size'), '100');
    return new Response(JSON.stringify({
      success: true,
      data: {
        ads: [
          { ad_id: 1, status: 'ACTIVE', title: 'Schöne Wohnung in Trittau', description: '', price: { amount: 900, price_type: 'SPECIFIED_AMOUNT' }, ad_url: 'https://www.kleinanzeigen.de/s-anzeige/a/1', location: { name: 'Trittau' }, details: { Zimmer: '3' }, attributes: [{ name: 'wohnung_mieten.zimmer', label: 'Zimmer', values: [{ value: '3', label: '3' }] }] },
          { ad_id: 2, status: 'ACTIVE', title: 'Große Wohnung in Trittau', description: '', price: { amount: 950, price_type: 'SPECIFIED_AMOUNT' }, ad_url: 'https://www.kleinanzeigen.de/s-anzeige/b/2', location: { name: 'Trittau' }, details: { Zimmer: '4' }, attributes: [{ name: 'wohnung_mieten.zimmer', label: 'Zimmer', values: [{ value: '4', label: '4' }] }] },
          { ad_id: 3, status: 'ACTIVE', title: 'Kleine Wohnung in Trittau', description: '', price: { amount: 700, price_type: 'SPECIFIED_AMOUNT' }, ad_url: 'https://www.kleinanzeigen.de/s-anzeige/c/3', location: { name: 'Trittau' }, details: { Zimmer: '2' }, attributes: [{ name: 'wohnung_mieten.zimmer', label: 'Zimmer', values: [{ value: '2', label: '2' }] }] }
        ]
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await searchLiveHousing({ location: 'Trittau', rooms: '3-4', amount: 1000, type: 'Warmmiete' }, KEY, transport);
  assert.equal(result.status, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(result.listings.map(item => item.id), ['1', '2']);
});
