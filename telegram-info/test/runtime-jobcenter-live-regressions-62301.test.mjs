import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleJobcenterSearchStorage,
  localSearchSummaryPayload
} from '../src/runtime-jobcenter.mjs';
import { housingListingMedia } from '../src/housing-provider.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { return values.delete(key); }
  };
}

async function storageCall(outbox, payload) {
  const request = new Request('https://outbox.internal/jobcenter-search-state', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(payload)
  });
  const response = await handleJobcenterSearchStorage(request, outbox);
  assert.ok(response instanceof Response);
  return { response, body:await response.json() };
}

test('expired district lease still belongs to the same durable task until replaced or cancelled', async () => {
  const storage = memoryStorage();
  const outbox = { householdContextStorage:storage };
  const chatId = 123456;
  const userId = 123456;
  const token = 'district-callback-62301';
  const signature = 'stormarn|trittau|2|2';

  const acquired = await storageCall(outbox, {
    op:'district_acquire', chatId, userId, signature, token, now:1_000
  });
  assert.equal(acquired.body.status, 'ok');
  assert.equal(acquired.body.acquired, true);

  const checkedAfterLease = await storageCall(outbox, {
    op:'district_check', chatId, userId, token, now:1_000 + 45_001
  });

  assert.equal(checkedAfterLease.body.status, 'ok');
  assert.equal(checkedAfterLease.body.owned, true,
    'the same durable task must not silently lose ownership merely because its anti-duplicate lease expired');
});

test('every counted listing renders a card while unsafe URLs are never exposed', () => {
  const listings = [
    { id:'1', title:'One', price:500, location:'Trittau', url:'https://www.kleinanzeigen.de/s-anzeige/one/100000001-203-1' },
    { id:'2', title:'Two', price:510, location:'Trittau', url:'https://www.kleinanzeigen.de/s-anzeige/two/100000002-203-1' },
    { id:'3', title:'Three', price:520, location:'Ahrensburg', url:'https://www.kleinanzeigen.de/s-anzeige/three/100000003-203-1' },
    { id:'4', title:'Unsafe', price:530, location:'Ahrensburg', url:'https://example.invalid/listing/4' }
  ];

  const media = housingListingMedia({ status:'ok', listings });
  assert.equal(media.length, 4, 'summary count and rendered-card count must stay identical');
  assert.doesNotMatch(media[3].caption, /example\.invalid/u,
    'an unapproved listing URL may not be exposed as a Telegram link');

  const summary = localSearchSummaryPayload({
    location:'Trittau', rooms:'2', persons:2, radius:15, jurisdiction:'Stormarn',
    page:0, total:listings.length, visible:media.length
  });
  assert.match(summary.text, /Показано 1–4 із 4 знайдених оголошень\./u);
});
