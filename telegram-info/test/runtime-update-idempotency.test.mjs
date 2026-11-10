import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  handleTelegramUpdateIdempotencyStorage,
  withTelegramUpdateIdempotency,
  TELEGRAM_UPDATE_PROCESSING_LEASE_MS
} from '../src/update-idempotency.mjs';

const SECRET = 's'.repeat(32);
const env = () => ({
  TELEGRAM_PILOT_MODE:'public',
  TELEGRAM_RELEASE_APPROVED:'public-v1',
  TELEGRAM_BOT_TOKEN:`12345:${'A'.repeat(32)}`,
  TELEGRAM_WEBHOOK_SECRET:SECRET,
  TELEGRAM_INGRESS_ENABLED:'true',
  TELEGRAM_DELIVERY_ENABLED:'true'
});

function memoryStorage() {
  const values = new Map();
  return {
    values,
    async put(key, value) { values.set(key, structuredClone(value)); },
    async get(key) { return values.get(key); },
    async delete(key) { return values.delete(key); },
    async list({ prefix, limit } = {}) {
      const rows = [...values].filter(([key]) => !prefix || key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      return new Map(Number.isSafeInteger(limit) ? rows.slice(0, limit) : rows);
    }
  };
}

function outboxEnv(storage, clock) {
  const base = env();
  const outbox = { env:base, ctx:{ storage } };
  base.OUTBOX = {
    idFromName(name) { assert.equal(name, 'telegram-pilot-v1'); return name; },
    get() {
      return { fetch:async (url, options = {}) => {
        const response = await handleTelegramUpdateIdempotencyStorage(new Request(url, options), outbox, { now:clock.now });
        assert.ok(response, 'idempotency path must be handled');
        return response;
      } };
    }
  };
  return base;
}

function webhook(updateId, secret = SECRET, extraHeaders = {}) {
  return new Request('https://bot.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':secret, ...extraHeaders },
    body:JSON.stringify({ update_id:updateId, message:{ message_id:1, chat:{ id:42, type:'private' }, from:{ id:42 }, text:'/start' } })
  });
}

function waitUntilCtx() {
  const tasks = [];
  return { tasks, ctx:{ waitUntil(promise) { tasks.push(promise); } }, settle:() => Promise.all(tasks) };
}

const ok = () => new Response(JSON.stringify({ ok:true }), { status:200 });

test('TG-RUNTIME-004 a redelivered Telegram update is processed once', async () => {
  const storage = memoryStorage();
  const clock = { now:1_000 };
  const e = outboxEnv(storage, clock);
  const w = waitUntilCtx();
  let runs = 0;
  const run = async () => { runs += 1; return ok(); };

  const first = await withTelegramUpdateIdempotency(webhook(9001), e, w.ctx, run);
  await w.settle();
  clock.now += 5_000;
  const second = await withTelegramUpdateIdempotency(webhook(9001), e, w.ctx, run);
  await w.settle();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200, 'Telegram must get 2xx so it stops redelivering');
  assert.equal((await second.json()).duplicate, true);
  assert.equal(runs, 1);
});

test('TG-RUNTIME-004 a failed attempt releases the claim so Telegram retry is processed', async () => {
  const storage = memoryStorage();
  const clock = { now:2_000 };
  const e = outboxEnv(storage, clock);
  const w = waitUntilCtx();
  let runs = 0;

  await assert.rejects(withTelegramUpdateIdempotency(webhook(9002), e, w.ctx, async () => { runs += 1; throw new Error('boom'); }), /boom/);
  await w.settle();
  const retry = await withTelegramUpdateIdempotency(webhook(9002), e, w.ctx, async () => { runs += 1; return ok(); });
  await w.settle();

  assert.equal(retry.status, 200);
  assert.equal(runs, 2, 'a crashed attempt must not swallow the update');
});

test('TG-RUNTIME-004 a concurrent in-flight duplicate is deferred, a stale lease is reclaimed', async () => {
  const storage = memoryStorage();
  const clock = { now:3_000 };
  const e = outboxEnv(storage, clock);
  let runs = 0;
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const w = waitUntilCtx();

  const pending = withTelegramUpdateIdempotency(webhook(9003), e, w.ctx, async () => { runs += 1; await slow; return ok(); });
  await new Promise(resolve => setTimeout(resolve, 0));
  const duplicate = await withTelegramUpdateIdempotency(webhook(9003), e, w.ctx, async () => { runs += 1; return ok(); });
  // TG-RUNTIME-010: an in-flight duplicate is not acknowledged; Telegram retries after the lease.
  assert.equal(duplicate.status, 503);
  assert.ok(Number(duplicate.headers.get('retry-after')) > 0);
  assert.equal((await duplicate.json()).state, 'in_flight');
  release();
  await pending;
  await w.settle();
  assert.equal(runs, 1);

  // A lease left by a killed request expires and the update can be processed.
  await storage.put('telegram-update:v1:00000000000000009004', { state:'processing', expiresAt:clock.now + TELEGRAM_UPDATE_PROCESSING_LEASE_MS });
  clock.now += TELEGRAM_UPDATE_PROCESSING_LEASE_MS + 1;
  await withTelegramUpdateIdempotency(webhook(9004), e, w.ctx, async () => { runs += 1; return ok(); });
  await w.settle();
  assert.equal(runs, 2);
});

test('TG-RUNTIME-004 unauthenticated, internal and storage-less requests bypass the guard and fail open', async () => {
  let runs = 0;
  const run = async () => { runs += 1; return ok(); };
  const w = waitUntilCtx();
  const throwing = { ...env(), OUTBOX:{ idFromName() { throw new Error('must not be called'); } } };

  await withTelegramUpdateIdempotency(webhook(9005, 'wrong-secret-'.repeat(3)), throwing, w.ctx, run);
  await withTelegramUpdateIdempotency(webhook(9005, SECRET, { 'x-zaskaleta-jobcenter-background-task':'1' }), throwing, w.ctx, run);
  await withTelegramUpdateIdempotency(webhook(9005), env(), w.ctx, run);

  const broken = { ...env(), OUTBOX:{ idFromName() { return 'x'; }, get() { return { fetch:async () => { throw new Error('do down'); } }; } } };
  await withTelegramUpdateIdempotency(webhook(9006), broken, w.ctx, run);
  await withTelegramUpdateIdempotency(webhook(9006), broken, w.ctx, run);
  await w.settle();

  assert.equal(runs, 5, 'idempotency outages must never drop updates');
});

test('TG-RUNTIME-004 expired records are purged oldest-first', async () => {
  const storage = memoryStorage();
  const clock = { now:10_000_000 };
  const e = outboxEnv(storage, clock);
  for (let id = 1; id <= 5; id += 1) {
    await storage.put(`telegram-update:v1:${String(id).padStart(20, '0')}`, { state:'done', expiresAt:clock.now - 1 });
  }
  const w = waitUntilCtx();
  await withTelegramUpdateIdempotency(webhook(9100), e, w.ctx, async () => ok());
  await w.settle();
  const left = [...storage.values.keys()].filter(key => key.startsWith('telegram-update:v1:'));
  assert.deepEqual(left, ['telegram-update:v1:00000000000000009100']);
});

test('TG-RUNTIME-004 the live entry wraps webhook processing and the outbox serves the claim path', () => {
  const source = readFileSync(new URL('../src/runtime.mjs', import.meta.url), 'utf8');
  const fetchStart = source.indexOf('export default {');
  assert.match(source.slice(fetchStart), /withTelegramUpdateIdempotency\(request,env,ctx,/u);
  assert.match(source, /handleTelegramUpdateIdempotencyStorage\(request,this\)/u);
});

test('TG-RUNTIME-010 a redelivery of a killed attempt is not acknowledged and is processed after the lease', async () => {
  const storage = memoryStorage();
  const clock = { now:20_000 };
  const e = outboxEnv(storage, clock);
  const w = waitUntilCtx();
  let runs = 0;
  // The first attempt never settles: the isolate is killed, no finish is sent.
  withTelegramUpdateIdempotency(webhook(9200), e, w.ctx, () => { runs += 1; return new Promise(() => {}); });
  await new Promise(resolve => setTimeout(resolve, 0));
  clock.now += 30_000;
  const early = await withTelegramUpdateIdempotency(webhook(9200), e, w.ctx, async () => { runs += 1; return ok(); });
  assert.notEqual(early.status, 200, 'Telegram must keep the update and retry');
  assert.ok(early.status >= 500);
  clock.now += TELEGRAM_UPDATE_PROCESSING_LEASE_MS;
  const late = await withTelegramUpdateIdempotency(webhook(9200), e, w.ctx, async () => { runs += 1; return ok(); });
  assert.equal(late.status, 200);
  assert.equal(runs, 2, 'the update is processed, not lost');
});

test('TG-RUNTIME-010 a claim that times out is released so the Telegram retry is processed', async () => {
  const storage = memoryStorage();
  const clock = { now:40_000 };
  const base = outboxEnv(storage, clock);
  let delay = 1_700;
  const inner = base.OUTBOX.get();
  const e = { ...base, OUTBOX:{ idFromName:base.OUTBOX.idFromName, get:() => ({ fetch:async (url, options) => {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return inner.fetch(url, options);
  } }) } };
  const w = waitUntilCtx();
  let runs = 0;
  const first = await withTelegramUpdateIdempotency(webhook(9300), e, w.ctx, async () => { runs += 1; return new Response('err', { status:500 }); });
  assert.equal(first.status, 500);
  await new Promise(resolve => setTimeout(resolve, 400));
  await w.settle();
  delay = 0;
  const retry = await withTelegramUpdateIdempotency(webhook(9300), e, w.ctx, async () => { runs += 1; return ok(); });
  await w.settle();
  assert.equal(retry.status, 200);
  assert.equal(runs, 2, 'the retry after a fail-open attempt is processed');
});

test('TG-RUNTIME-010 a done duplicate stays acknowledged with 200', async () => {
  const storage = memoryStorage();
  const clock = { now:60_000 };
  const e = outboxEnv(storage, clock);
  const w = waitUntilCtx();
  await withTelegramUpdateIdempotency(webhook(9400), e, w.ctx, async () => ok());
  await w.settle();
  const again = await withTelegramUpdateIdempotency(webhook(9400), e, w.ctx, async () => ok());
  assert.equal(again.status, 200);
  assert.equal((await again.json()).state, 'duplicate');
});
