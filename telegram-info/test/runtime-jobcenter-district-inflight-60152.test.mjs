import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleJobcenterSearchStorage,
  districtSearchUnavailableText
} from '../src/runtime-jobcenter.mjs';

class MemoryStorage {
  constructor(){ this.map=new Map(); }
  async get(key){ return this.map.get(key); }
  async put(key,value){ this.map.set(key,value); }
  async delete(key){ this.map.delete(key); }
}

function storageRequest(body) {
  return new Request('https://outbox.internal/jobcenter-search-state', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body)
  });
}

test('60152 district in-flight lock suppresses webhook retries and repeated taps', async () => {
  const storage = new MemoryStorage();
  const outbox = { householdContextStorage:storage };
  const base = {
    chatId:777,
    userId:777,
    signature:'nordfriesland|husum|2|3',
    now:100000
  };

  let response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    op:'district_acquire',
    token:'callback-a'
  }), outbox);
  let payload = await response.json();
  assert.equal(payload.status,'ok');
  assert.equal(payload.acquired,true);

  response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    now:100001,
    op:'district_acquire',
    token:'callback-a'
  }), outbox);
  payload = await response.json();
  assert.equal(payload.acquired,false);
  assert.equal(payload.duplicate,true);

  response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    now:100002,
    op:'district_acquire',
    token:'callback-b'
  }), outbox);
  payload = await response.json();
  assert.equal(payload.acquired,false);
  assert.equal(payload.duplicate,false);

  response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    now:100003,
    op:'district_release',
    token:'callback-b'
  }), outbox);
  payload = await response.json();
  assert.equal(payload.released,false);

  response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    now:100004,
    op:'district_release',
    token:'callback-a'
  }), outbox);
  payload = await response.json();
  assert.equal(payload.released,true);

  response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    now:100005,
    op:'district_acquire',
    token:'callback-b'
  }), outbox);
  payload = await response.json();
  assert.equal(payload.acquired,true);
});

test('60152 stale district in-flight lock expires instead of blocking future searches', async () => {
  const storage = new MemoryStorage();
  const outbox = { householdContextStorage:storage };
  const base = {
    chatId:888,
    userId:888,
    signature:'nordfriesland|husum|2|3',
    now:200000
  };

  let response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    op:'district_acquire',
    token:'old-callback'
  }), outbox);
  assert.equal((await response.json()).acquired,true);

  response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    now:260000,
    op:'district_acquire',
    token:'new-callback'
  }), outbox);
  const payload = await response.json();
  assert.equal(payload.acquired,true);
});

test('60152 district timeout always has explicit final user-facing copy', () => {
  const text = districtSearchUnavailableText('Nordfriesland');
  assert.match(text, /Nordfriesland/u);
  assert.match(text, /не завершився вчасно/u);
  assert.match(text, /не буде залишати вас лише з повідомленням «Шукаю…»/u);
});
