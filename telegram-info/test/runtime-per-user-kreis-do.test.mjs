import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wholeKreisDurableObjectName } from '../src/runtime.mjs';

function districtUpdate(chatId, userId = chatId) {
  return {
    update_id:70001,
    callback_query:{
      id:'cb-1',
      data:'jcd:2:3:Trittau',
      from:{ id:userId, is_bot:false },
      message:{ message_id:5, chat:{ id:chatId, type:'private' } }
    }
  };
}

test('TG-RUNTIME-003 each private user gets an own whole-Kreis Durable Object', () => {
  const first = wholeKreisDurableObjectName(districtUpdate(1001));
  const second = wholeKreisDurableObjectName(districtUpdate(2002));
  assert.match(first, /^jobcenter-district-search:v2:1001$/u);
  assert.match(second, /^jobcenter-district-search:v2:2002$/u);
  assert.notEqual(first, second, 'concurrent users must not share one serial task queue');
  assert.equal(wholeKreisDurableObjectName(districtUpdate(1001)), first, 'one user keeps one stable object');
});

test('TG-RUNTIME-003 unverifiable identities fall back to the shared object', () => {
  const shared = 'jobcenter-district-search';
  assert.equal(wholeKreisDurableObjectName(null), shared);
  assert.equal(wholeKreisDurableObjectName({}), shared);
  assert.equal(wholeKreisDurableObjectName(districtUpdate(1001, 3003)), shared, 'chat and user must match');
  assert.equal(wholeKreisDurableObjectName(districtUpdate(-100123)), shared, 'groups are not private users');
  const groupChat = districtUpdate(1001);
  groupChat.callback_query.message.chat.type = 'group';
  assert.equal(wholeKreisDurableObjectName(groupChat), shared);
});

test('TG-RUNTIME-003 whole-Kreis delegation routes by the per-user object name', () => {
  const source = readFileSync(new URL('../src/runtime.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('if (shouldDelegateWholeKreisBackground(');
  const end = source.indexOf('env.OUTBOX.get(doId)', start);
  assert.ok(start >= 0 && end > start, 'whole-Kreis delegation block must be present');
  const block = source.slice(start, end);
  assert.match(block, /idFromName\(wholeKreisDurableObjectName\(/u);
  assert.doesNotMatch(block, /idFromName\('jobcenter-district-search'\)/u);
});
