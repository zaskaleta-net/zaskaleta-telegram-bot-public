import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JOBCENTER_BACKGROUND_TASK_HEADER,
  JOBCENTER_BACKGROUND_ACK_HEADER,
  JOBCENTER_BACKGROUND_PROGRESS_HEADER,
  JOBCENTER_BACKGROUND_LOCK_HEADER
} from '../src/runtime-jobcenter.mjs';
import {
  queueDurableJobcenterBackgroundTask,
  runQueuedDurableJobcenterBackgroundTask
} from '../src/durable-jobcenter-alarm.mjs';
import { TelegramOutbox } from '../src/worker-entry-pilot-v21.mjs';

const TOKEN = `12345:${'A'.repeat(32)}`;
const SECRET = 's'.repeat(32);

function validEnv() {
  return {
    TELEGRAM_PILOT_MODE:'public',
    TELEGRAM_RELEASE_APPROVED:'public-v1',
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_DELIVERY_ENABLED:'true'
  };
}

function memoryStorage({ withSql = false } = {}) {
  const values = new Map();
  let alarm = null;
  const storage = {
    values,
    async put(key, value) { values.set(key, structuredClone(value)); },
    async get(key) { return values.get(key); },
    async delete(key) { return values.delete(key); },
    async list({ prefix } = {}) {
      return new Map([...values].filter(([key]) => !prefix || key.startsWith(prefix)));
    },
    async getAlarm() { return alarm; },
    async setAlarm(value) { alarm = Number(value); },
    alarmValue() { return alarm; }
  };
  if (withSql) {
    storage.sql = { exec(){ return { toArray(){ return []; } }; } };
    storage.transactionSync = fn => fn();
  }
  return storage;
}

function districtRequest(updateId = 60162) {
  return new Request('https://outbox.internal/jobcenter-background-task', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-telegram-bot-api-secret-token':SECRET,
      [JOBCENTER_BACKGROUND_TASK_HEADER]:'1',
      [JOBCENTER_BACKGROUND_ACK_HEADER]:'1',
      [JOBCENTER_BACKGROUND_PROGRESS_HEADER]:'777',
      [JOBCENTER_BACKGROUND_LOCK_HEADER]:'1'
    },
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

function taskEntries(storage) {
  return [...storage.values.entries()].filter(([key]) => key.startsWith('telegram-jobcenter-district-task:'));
}

test('whole-Kreis task is persisted and alarmed without persisting webhook secret', async () => {
  const storage = memoryStorage();
  const outbox = { env:validEnv(), ctx:{ storage } };

  const queued = await queueDurableJobcenterBackgroundTask(districtRequest(), outbox, { now:1_000 });

  assert.equal(queued.queued, true);
  assert.equal(taskEntries(storage).length, 1);
  assert.ok(Number.isFinite(storage.alarmValue()));
  assert.ok(storage.alarmValue() <= 1_001);
  assert.equal(JSON.stringify(taskEntries(storage)[0][1]).includes(SECRET), false);
});

test('actual Wrangler Durable Object export persists whole-Kreis task before accepting it', async () => {
  const storage = memoryStorage({ withSql:true });
  const initializers = [];
  const ctx = {
    storage,
    blockConcurrencyWhile(fn) {
      const task = Promise.resolve().then(fn);
      initializers.push(task);
      return task;
    }
  };
  const outbox = new TelegramOutbox(ctx, validEnv());
  await Promise.all(initializers);

  const response = await outbox.fetch(districtRequest(60165));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'telegram-jobcenter-search-durable-alarm-accepted');
  assert.equal(taskEntries(storage).length, 1);
  assert.ok(Number.isFinite(storage.alarmValue()));
});

test('alarm runner reconstructs the internal task, waits for completion, then removes it', async () => {
  const storage = memoryStorage();
  const env = validEnv();
  const outbox = { env, ctx:{ storage } };
  await queueDurableJobcenterBackgroundTask(districtRequest(60163), outbox, { now:2_000 });

  let observed = null;
  const result = await runQueuedDurableJobcenterBackgroundTask(outbox, {
    runTask:async request => {
      observed = request;
      return new Response(JSON.stringify({ ok:true, delivered:true, mode:'private-jobcenter-district-search' }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.completed, true);
  assert.ok(observed instanceof Request);
  assert.equal(observed.url, 'https://worker.internal/telegram/stateless');
  assert.equal(observed.headers.get('x-telegram-bot-api-secret-token'), SECRET);
  assert.equal(observed.headers.get(JOBCENTER_BACKGROUND_TASK_HEADER), '1');
  assert.equal(observed.headers.get(JOBCENTER_BACKGROUND_ACK_HEADER), '1');
  assert.equal(observed.headers.get(JOBCENTER_BACKGROUND_PROGRESS_HEADER), '777');
  assert.equal(observed.headers.get(JOBCENTER_BACKGROUND_LOCK_HEADER), '1');
  assert.equal(taskEntries(storage).length, 0);
});

test('alarm runner leaves the durable task stored when execution throws', async () => {
  const storage = memoryStorage();
  const outbox = { env:validEnv(), ctx:{ storage } };
  await queueDurableJobcenterBackgroundTask(districtRequest(60164), outbox, { now:3_000 });

  await assert.rejects(
    runQueuedDurableJobcenterBackgroundTask(outbox, {
      runTask:async () => { throw new Error('provider exploded'); }
    }),
    /provider exploded/
  );
  assert.equal(taskEntries(storage).length, 1);
});
