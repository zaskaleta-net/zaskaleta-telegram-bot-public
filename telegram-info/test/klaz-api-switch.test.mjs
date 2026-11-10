import test from 'node:test';
import assert from 'node:assert/strict';
import { klazApiKey } from '../src/housing-provider-base.mjs';
import { searchPrimaryHousing } from '../src/housing-primary-search.mjs';

const KEY = `klaz_live_${'a'.repeat(40)}`;

test('KLAZ_API_ENABLED "false" withholds the key; otherwise the configured key is used', () => {
  assert.equal(klazApiKey({ KLAZ_API_KEY:KEY, KLAZ_API_ENABLED:'false' }), '');
  assert.equal(klazApiKey({ KLAZ_API_KEY:KEY }), KEY);
  assert.equal(klazApiKey({}), '');
});

test('with the API switched off a search sends no Kleinanzeigen API request and reports no API failure', async () => {
  const urls = [];
  const transport = async url => { urls.push(String(url)); return new Response('unavailable', { status:503 }); };
  const result = await searchPrimaryHousing({ location:'Kiel', rooms:'2', amount:600, type:'Warmmiete', radiusKm:10 }, klazApiKey({ KLAZ_API_KEY:KEY, KLAZ_API_ENABLED:'false' }), transport, { sourceTimeoutMs:2000 });
  assert.equal(urls.some(url => url.startsWith('https://api.kleinanzeigen-agent.de/')), false);
  const api = result.sources?.find(source => source.source === 'Kleinanzeigen API');
  assert.equal(api?.status, 'not_configured');
});
