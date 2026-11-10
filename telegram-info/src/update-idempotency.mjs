// At-most-once processing of Telegram webhook updates.
// Telegram redelivers an update when the webhook fails or times out; without a
// guard the user receives the same answer twice. Claims live in the shared
// telegram-pilot-v1 Durable Object. Any guard failure fails open: a lost
// update is worse than a duplicate.
import { pilotConfig, equalSecret } from './pilot-security.mjs';
import { JOBCENTER_BACKGROUND_TASK_HEADER } from './runtime-jobcenter.mjs';

const STATELESS_PATH = '/telegram/stateless';
const CLAIM_PATH = '/telegram-update-claim';
const KEY_PREFIX = 'telegram-update:v1:';
const STATE_OBJECT = 'telegram-pilot-v1';
const CLAIM_TIMEOUT_MS = 1500;
// A finish runs after the answer (usually in waitUntil); it may wait longer so
// a slow Durable Object still receives it.
const FINISH_TIMEOUT_MS = 10_000;
const PURGE_BATCH = 20;
export const TELEGRAM_UPDATE_PROCESSING_LEASE_MS = 90_000;
export const TELEGRAM_UPDATE_DONE_TTL_MS = 60 * 60 * 1000;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...extraHeaders }
  });
}

function updateKey(updateId) {
  return `${KEY_PREFIX}${String(updateId).padStart(20, '0')}`;
}

const validUpdateId = value => Number.isSafeInteger(value) && value >= 0;

// Keys sort by update_id, so the oldest records are listed first.
async function purgeExpired(storage, now) {
  const oldest = await storage.list({ prefix:KEY_PREFIX, limit:PURGE_BATCH });
  for (const [key, value] of oldest) {
    if (!Number.isFinite(value?.expiresAt) || value.expiresAt <= now) await storage.delete(key);
  }
}

export async function handleTelegramUpdateIdempotencyStorage(request, outbox, { now = Date.now() } = {}) {
  let url;
  try { url = new URL(request?.url || ''); } catch { return null; }
  if (request?.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== CLAIM_PATH) return null;
  const storage = outbox?.ctx?.storage;
  if (!storage || typeof storage.get !== 'function' || typeof storage.list !== 'function') return json({ status:'unavailable' }, 503);

  let value = null;
  try { value = await request.json(); } catch {}
  const updateId = Number(value?.updateId);
  if (!validUpdateId(updateId) || !['claim', 'finish'].includes(value?.op)) return json({ status:'bad_operation' }, 400);
  const key = updateKey(updateId);

  if (value.op === 'finish') {
    if (value.ok === true) await storage.put(key, { state:'done', expiresAt:now + TELEGRAM_UPDATE_DONE_TTL_MS });
    else await storage.delete(key);
    return json({ status:'ok' });
  }

  await purgeExpired(storage, now);
  const existing = await storage.get(key);
  if (existing && Number.isFinite(existing.expiresAt) && existing.expiresAt > now) {
    if (existing.state === 'done') return json({ status:'duplicate' });
    return json({ status:'in_flight', retryAfterMs:existing.expiresAt - now });
  }
  await storage.put(key, { state:'processing', expiresAt:now + TELEGRAM_UPDATE_PROCESSING_LEASE_MS });
  return json({ status:'claimed' });
}

async function updateIdForGuard(request, env) {
  let url;
  try { url = new URL(request?.url || ''); } catch { return null; }
  if (request?.method !== 'POST' || url.pathname !== STATELESS_PATH || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  if (request.headers.get(JOBCENTER_BACKGROUND_TASK_HEADER) === '1' || !env?.OUTBOX) return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  try {
    const update = await request.clone().json();
    return validUpdateId(update?.update_id) ? update.update_id : null;
  } catch {
    return null;
  }
}

async function claimCall(env, body, timeoutMs = body?.op === 'finish' ? FINISH_TIMEOUT_MS : CLAIM_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const stub = env.OUTBOX.get(env.OUTBOX.idFromName(STATE_OBJECT));
        const response = await stub.fetch(`https://outbox.internal${CLAIM_PATH}`, {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          body:JSON.stringify(body)
        });
        return response.ok ? await response.json() : { status:'unavailable' };
      })(),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status:'unavailable', timedOut:true }), timeoutMs); })
    ]);
  } catch {
    return { status:'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

function settle(ctx, promise) {
  const guarded = promise.catch(() => {});
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(guarded);
  return guarded;
}

export async function withTelegramUpdateIdempotency(request, env, ctx, run) {
  const updateId = await updateIdForGuard(request, env);
  if (updateId === null) return run();

  const claim = await claimCall(env, { op:'claim', updateId });
  if (claim?.status === 'duplicate') return json({ ok:true, duplicate:true, state:claim.status });
  if (claim?.status === 'in_flight') {
    // The first attempt may have been killed and will never finish. A 2xx here
    // would make Telegram drop the update; a 503 makes it redeliver, and once
    // the lease ends the redelivery is either a done duplicate or reclaimed.
    const seconds = Math.max(1, Math.min(Math.ceil(TELEGRAM_UPDATE_PROCESSING_LEASE_MS / 1000), Math.ceil(Number(claim.retryAfterMs) / 1000) || 0));
    return json({ ok:false, duplicate:true, state:'in_flight' }, 503, { 'retry-after':String(seconds) });
  }
  // A timed-out claim may still have stored a processing lease in the Durable
  // Object; it is settled like a claimed attempt so a Telegram retry is not
  // held back by it.
  if (claim?.status !== 'claimed' && !claim?.timedOut) return run();

  let response;
  try {
    response = await run();
  } catch (error) {
    // Release before the error response reaches Telegram, still bounded.
    await settle(ctx, claimCall(env, { op:'finish', updateId, ok:false }, CLAIM_TIMEOUT_MS));
    throw error;
  }
  const finished = claimCall(env, { op:'finish', updateId, ok:!!response?.ok });
  if (typeof ctx?.waitUntil === 'function') settle(ctx, finished);
  else await finished.catch(() => {});
  return response;
}
