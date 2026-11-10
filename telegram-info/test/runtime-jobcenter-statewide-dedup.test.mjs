import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listingStateKey,
  filterUnseenDistrictListings,
  jobcenterSearchSignature,
  districtNoNewMessage,
  handleJobcenterSearchStorage
} from '../src/runtime-jobcenter.mjs';
import { SH_RUNTIME_MUNICIPALITY_ROWS } from '../src/sh-municipality-jurisdiction-runtime.mjs';

const JURISDICTIONS = [...new Set(SH_RUNTIME_MUNICIPALITY_ROWS.map(row => row.jurisdiction))].sort();
const representative = new Map();
for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
  if (!representative.has(row.jurisdiction)) representative.set(row.jurisdiction, row.canonical);
}

test('statewide district dedup covers all 15 Schleswig-Holstein Jobcenter/Kreis territories', () => {
  assert.equal(JURISDICTIONS.length, 15);
  for (const jurisdiction of JURISDICTIONS) {
    const location = representative.get(jurisdiction);
    const oldListing = {
      id:`${jurisdiction}-old`,
      url:`https://example.invalid/${encodeURIComponent(jurisdiction)}/old`,
      title:`Wohnung alt ${jurisdiction}`,
      location,
      price:600,
      rooms:3,
      areaSqm:65
    };
    const newListing = {
      id:`${jurisdiction}-new`,
      url:`https://example.invalid/${encodeURIComponent(jurisdiction)}/new`,
      title:`Wohnung neu ${jurisdiction}`,
      location,
      price:610,
      rooms:3,
      areaSqm:66
    };
    const seen = [listingStateKey(oldListing)];
    const filtered = filterUnseenDistrictListings([oldListing, newListing], seen);
    assert.deepEqual(filtered.map(item => item.id), [newListing.id], jurisdiction);
    const signature = jobcenterSearchSignature({ location, persons:3, rooms:'3-4', jurisdiction });
    assert.ok(signature?.startsWith(jurisdiction.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/gu,'' ).replace(/ß/gu,'ss').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(' ')[0]), jurisdiction);
    assert.match(districtNoNewMessage(jurisdiction, 3, 3), /Нових оголошень не знайдено/u);
  }
});

test('listing identity ignores URL tracking/query noise', () => {
  const a = listingStateKey({ url:'https://example.invalid/ad/123?utm_source=x#photo' });
  const b = listingStateKey({ url:'https://example.invalid/ad/123?foo=bar' });
  assert.equal(a, b);
});

class MemoryStorage {
  constructor(){ this.map=new Map(); }
  async get(key){ return this.map.get(key); }
  async put(key,value){ this.map.set(key,value); }
  async delete(key){ this.map.delete(key); }
}

function storageRequest(body) {
  return new Request('https://outbox.internal/jobcenter-search-state', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body)
  });
}

test('district pagination keeps a fixed baseline while a later district session includes newly shown cards', async () => {
  const storage = new MemoryStorage();
  const outbox = { householdContextStorage:storage };
  const base = {
    chatId:777,
    userId:777,
    signature:'stormarn|trittau|4|3-4',
    now:100000
  };

  let response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    op:'record_seen',
    reset:true,
    keys:['u:https://example.invalid/a']
  }), outbox);
  assert.equal((await response.json()).status,'ok');

  response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    op:'district_baseline',
    initialize:true
  }), outbox);
  assert.deepEqual((await response.json()).baseline,['u:https://example.invalid/a']);

  response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    op:'record_seen',
    reset:false,
    keys:['u:https://example.invalid/b']
  }), outbox);
  assert.equal((await response.json()).status,'ok');

  response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    op:'district_baseline',
    initialize:false
  }), outbox);
  assert.deepEqual((await response.json()).baseline,['u:https://example.invalid/a'], 'same district session keeps page-0 baseline');

  response = await handleJobcenterSearchStorage(storageRequest({
    ...base,
    op:'district_baseline',
    initialize:true
  }), outbox);
  assert.deepEqual((await response.json()).baseline,[
    'u:https://example.invalid/a',
    'u:https://example.invalid/b'
  ], 'new district session excludes everything already shown before it starts');
});

test('expired statewide dedup state is not reused', async () => {
  const storage = new MemoryStorage();
  const outbox = { householdContextStorage:storage };
  const signature='lubeck|lubeck|2|3';
  await handleJobcenterSearchStorage(storageRequest({
    op:'record_seen', chatId:555, userId:555, signature, now:1000, reset:true,
    keys:['u:https://example.invalid/old']
  }), outbox);
  const response = await handleJobcenterSearchStorage(storageRequest({
    op:'district_baseline', chatId:555, userId:555, signature,
    now:1000 + 60*60*1000 + 1, initialize:true
  }), outbox);
  const payload=await response.json();
  assert.deepEqual(payload.baseline,[]);
});
