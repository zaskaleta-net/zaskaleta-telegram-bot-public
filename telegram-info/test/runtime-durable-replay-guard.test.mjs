import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { JOBCENTER_BACKGROUND_TASK_HEADER } from '../src/runtime-jobcenter.mjs';
import {
  queueDurableJobcenterBackgroundTask,
  runQueuedDurableJobcenterBackgroundTask
} from '../src/durable-jobcenter-alarm.mjs';

const SECRET = 's'.repeat(32);
const env = {
  TELEGRAM_PILOT_MODE:'public',
  TELEGRAM_RELEASE_APPROVED:'public-v1',
  TELEGRAM_BOT_TOKEN:`12345:${'A'.repeat(32)}`,
  TELEGRAM_WEBHOOK_SECRET:SECRET,
  TELEGRAM_INGRESS_ENABLED:'true',
  TELEGRAM_DELIVERY_ENABLED:'true'
};

function memoryStorage() {
  const values = new Map();
  let alarm = null;
  return {
    values,
    async put(key, value) { values.set(key, structuredClone(value)); },
    async get(key) { return values.get(key); },
    async delete(key) { return values.delete(key); },
    async list({ prefix } = {}) { return new Map([...values].filter(([key]) => !prefix || key.startsWith(prefix))); },
    async getAlarm() { return alarm; },
    async setAlarm(value) { alarm = Number(value); }
  };
}

function districtRequest(updateId) {
  return new Request('https://outbox.internal/jobcenter-background-task', {
    method:'POST',
    headers:{ 'content-type':'application/json', [JOBCENTER_BACKGROUND_TASK_HEADER]:'1' },
    body:JSON.stringify({
      update_id:updateId,
      callback_query:{
        id:`district-${updateId}`,
        from:{ id:123456, is_bot:false },
        message:{ message_id:44, chat:{ id:123456, type:'private' } },
        data:'jcd:4:3-4:Trittau'
      }
    })
  });
}

const tasks = storage => [...storage.values.entries()].filter(([key]) => key.startsWith('telegram-jobcenter-district-task:'));

test('TG-RUNTIME-004 an interrupted durable task is not re-run on alarm replay; the user gets the failure notice instead', async () => {
  const storage = memoryStorage();
  const outbox = { env, ctx:{ storage } };
  await queueDurableJobcenterBackgroundTask(districtRequest(80001), outbox, { now:1_000 });

  // First attempt: the Durable Object is evicted mid-search (the alarm throws).
  let runs = 0;
  await assert.rejects(runQueuedDurableJobcenterBackgroundTask(outbox, {
    runTask:async () => { runs += 1; throw new Error('evicted mid-search'); },
    onReplay:async () => { throw new Error('first attempt is not a replay'); }
  }), /evicted mid-search/);
  assert.equal(runs, 1);
  assert.equal(tasks(storage).length, 1);
  assert.ok(Number.isFinite(tasks(storage)[0][1].startedAt), 'start must be persisted before the search runs');

  // Cloudflare retries the alarm: cards may already be delivered, so the search must not run again.
  let replayed = null;
  const result = await runQueuedDurableJobcenterBackgroundTask(outbox, {
    runTask:async () => { runs += 1; return new Response('{}'); },
    onReplay:async request => { replayed = request; return new Response('{}', { status:500 }); }
  });
  assert.equal(runs, 1, 'replay must not re-send listing cards');
  assert.ok(replayed instanceof Request, 'replay must route to the failure notice path');
  assert.equal(replayed.headers.get(JOBCENTER_BACKGROUND_TASK_HEADER), '1');
  assert.equal(result.replayed, true);
  assert.equal(tasks(storage).length, 0, 'replayed task is removed so the queue continues');
});

test('TG-RUNTIME-004 a first attempt still runs the search normally', async () => {
  const storage = memoryStorage();
  const outbox = { env, ctx:{ storage } };
  await queueDurableJobcenterBackgroundTask(districtRequest(80002), outbox, { now:2_000 });
  let runs = 0;
  const result = await runQueuedDurableJobcenterBackgroundTask(outbox, {
    runTask:async () => { runs += 1; return new Response('{}'); },
    onReplay:async () => { throw new Error('must not be called'); }
  });
  assert.equal(runs, 1);
  assert.equal(result.completed, true);
  assert.equal(tasks(storage).length, 0);
});

test('TG-RUNTIME-004 the Durable Object alarm wires replay to the bounded failure path', () => {
  const source = readFileSync(new URL('../src/worker-entry-pilot-v21.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async alarm(alarmInfo)');
  const block = source.slice(start, source.indexOf('\n  }\n', start));
  assert.match(block, /onReplay:/u);
  assert.match(block, /superviseBackgroundJobcenterTask\(\s*Promise\.reject\(/u);
});
