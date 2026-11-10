import test from 'node:test';
import assert from 'node:assert/strict';
import { searchPrimaryHousing } from '../src/housing-primary-search.mjs';

test('TG-RUNTIME-014 keeps an explicit 20 km radius instead of falling back to 15 km', async () => {
  const result = await searchPrimaryHousing({
    location:'Trittau',
    rooms:'1-2',
    amount:680.9,
    type:'Bruttokaltmiete',
    radiusKm:20,
    jobcenterJurisdiction:'Stormarn'
  }, '', async () => new Response('unavailable', { status:503 }), {
    includeApi:false,
    sourceTimeoutMs:250
  });

  assert.equal(result.radiusKm, 20);
  assert.equal(result.criteria.radiusKm, 20);
});
