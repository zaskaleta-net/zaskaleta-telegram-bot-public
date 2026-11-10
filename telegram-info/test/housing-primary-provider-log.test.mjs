import test from 'node:test';
import assert from 'node:assert/strict';
import { searchLiveHousing } from '../src/housing-provider-base.mjs';

const KEY = 'klaz_live_' + 'A'.repeat(24);
const criteria = { location:'Trittau', rooms:'3-4', amount:943.8, type:'Bruttokaltmiete', radiusKm:15 };

async function captureLogs(run) {
  const logged = [];
  const original = console.info;
  console.info = (...args) => logged.push(args);
  try { await run(); } finally { console.info = original; }
  return logged.filter(([event]) => event === 'housing_primary_provider');
}

test('TG-RUNTIME-013 a failing Kleinanzeigen API reports its status without the key or query', async () => {
  for (const [httpStatus, errorCode, expected] of [[429, 'RATE_LIMITED', 'rate_limited'], [402, 'INSUFFICIENT_CREDITS', 'insufficient_credits'], [401, 'API_KEY_INVALID', 'auth_error']]) {
    const logs = await captureLogs(() => searchLiveHousing(criteria, KEY, async () => new Response(
      JSON.stringify({ success:false, error_code:errorCode, request_id:'req-1' }),
      { status:httpStatus, headers:{ 'content-type':'application/json' } }
    ), { includePublic:false }));
    assert.equal(logs.length, 1, `one log line for ${httpStatus}`);
    const entry = logs[0][1];
    assert.equal(entry.status, expected);
    assert.equal(entry.httpStatus, httpStatus);
    assert.equal(entry.endpoint, '/locations');
    assert.doesNotMatch(JSON.stringify(entry), /klaz_live|Trittau|q=/u, 'no key, location or query in the log');
  }
});

test('TG-RUNTIME-013 a successful Kleinanzeigen API search logs nothing', async () => {
  const logs = await captureLogs(() => searchLiveHousing(criteria, KEY, async url => {
    const target = String(url);
    const body = target.includes('/locations?')
      ? { success:true, data:{ locations:[{ id:'1', name:'Trittau', city:'Trittau' }] } }
      : { success:true, data:{ ads:[] } };
    return new Response(JSON.stringify(body), { status:200, headers:{ 'content-type':'application/json' } });
  }, { includePublic:false }));
  assert.equal(logs.length, 0);
});
