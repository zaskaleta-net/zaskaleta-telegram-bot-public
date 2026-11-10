// TG-RUNTIME-069 (full analysis 23.10.2026): one user could start any number
// of housing searches at once; each may send up to 32 requests to the
// portals (Workers Free; portals block whole IP ranges, see TG-RUNTIME-068).
// Per user: one search at a time and at most 20 in 10 minutes (paging
// re-runs the search, so it counts too). A search holds a slot until it
// ends (released in finally); the lease is only the backstop when a run
// dies without releasing. The record is in the shared Durable Object and
// kept 10 minutes (/forget deletes it). When the store cannot be reached
// the search is allowed: an outage of the counter must not lock people out.
import { readBoundedJSON } from './pilot-security.mjs';

export const SEARCH_RATE_PREFIX = 'telegram-search-rate:v1:';
export const SEARCH_RATE_PATH = '/search-rate';
export const SEARCH_WINDOW_MS = 10 * 60 * 1000;
export const SEARCH_MAX_IN_WINDOW = 20;
// Backstop only: a run that dies without releasing. Longer than the 22 s
// waitUntil watchdog and the plain search (sources + cards, about 31 s).
export const SEARCH_LEASE_MS = 90 * 1000;
const CALL_TIMEOUT_MS = 1000;

export const SEARCH_BUSY_TEXT = '⏳ Попередній пошук ще триває. Зачекайте кілька секунд — результат прийде в чат.';
export const SEARCH_LIMIT_TEXT = '⏳ Забагато пошуків поспіль. Спробуйте знову за кілька хвилин.';

function recentStarts(starts, now) {
  return (Array.isArray(starts) ? starts : []).map(Number).filter(time => Number.isFinite(time) && time <= now && now - time < SEARCH_WINDOW_MS);
}

function liveLease(active, now) {
  const until = Number(active?.until);
  return typeof active?.token === 'string' && Number.isFinite(until) && until > now && until - now <= SEARCH_LEASE_MS ? active : null;
}

// Pure decision: stored record → allowed or why not, and the record to keep.
export function decideSearchRate(record, now, token) {
  const starts = recentStarts(record?.starts, now);
  if (liveLease(record?.active, now)) return { allowed:false, reason:'busy', record:{ starts, active:record.active } };
  if (starts.length >= SEARCH_MAX_IN_WINDOW) return { allowed:false, reason:'limit', record:{ starts, active:null } };
  return { allowed:true, reason:'ok', record:{ starts:[...starts, now].slice(-SEARCH_MAX_IN_WINDOW), active:{ token, start:now, until:now + SEARCH_LEASE_MS } } };
}

// Pure release: only the holder frees the slot; refund also drops its start
// (the search never ran: skipped, hand-off failed).
export function releaseSearchRate(record, now, token, refund = false) {
  const active = record?.active;
  if (!active || active.token !== token) return null;
  const starts = recentStarts(record?.starts, now);
  if (refund) {
    const index = starts.lastIndexOf(Number(active.start));
    if (index >= 0) starts.splice(index, 1);
  }
  return { starts, active:null };
}

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

// Durable Object side.
export async function handleSearchRateStorage(request, outbox) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== SEARCH_RATE_PATH) return null;
  const parsed = await readBoundedJSON(request.clone(), 1024);
  const chatId = Number(parsed.error ? NaN : parsed.value?.chatId);
  const userId = Number(parsed.error ? NaN : parsed.value?.userId);
  const now = Number(parsed.error ? NaN : parsed.value?.now);
  if (!Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || !Number.isSafeInteger(now) || now <= 0) return reply({ status:'bad_operation' }, 400);
  const storage = outbox?.householdContextStorage || outbox?.ctx?.storage;
  if (!storage) return reply({ status:'storage_unavailable' }, 503);
  const op = parsed.value?.op === 'release' ? 'release' : 'acquire';
  const token = String(parsed.value?.token || '');
  if (!/^[0-9a-f-]{8,64}$/u.test(token)) return reply({ status:'bad_operation' }, 400);
  const key = `${SEARCH_RATE_PREFIX}${chatId}:${userId}`;
  const stored = await storage.get(key);
  if (op === 'release') {
    const record = releaseSearchRate(stored, now, token, parsed.value?.refund === true);
    if (record) await storage.put(key, { ...record, updatedAt:now, expiresAt:now + SEARCH_WINDOW_MS });
    return reply({ status:'ok', released:Boolean(record) });
  }
  const decision = decideSearchRate(stored, now, token);
  if (decision.allowed) await storage.put(key, { ...decision.record, updatedAt:now, expiresAt:now + SEARCH_WINDOW_MS });
  return reply({ status:'ok', allowed:decision.allowed, reason:decision.reason });
}

async function callSearchRate(env, body) {
  const response = await env.OUTBOX.get(env.OUTBOX.idFromName('telegram-pilot-v1')).fetch(`https://outbox.internal${SEARCH_RATE_PATH}`, {
    method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body), signal:AbortSignal.timeout(CALL_TIMEOUT_MS)
  });
  const parsed = await readBoundedJSON(response, 1024);
  return !response.ok || parsed.error || parsed.value?.status !== 'ok' ? null : parsed.value;
}

function validUser(env, chatId, userId) {
  return Boolean(env?.OUTBOX) && Number.isSafeInteger(chatId) && chatId > 0 && chatId === userId;
}

// Worker side: { allowed, reason, release(refund) }. Fails open; release
// never throws and is a no-op when nothing was taken.
export async function acquireSearchSlot(env, chatId, userId, now = Date.now()) {
  const open = { allowed:true, reason:'unchecked', release:async () => {} };
  if (!validUser(env, chatId, userId)) return open;
  const token = crypto.randomUUID();
  try {
    const answer = await callSearchRate(env, { op:'acquire', chatId, userId, now, token });
    if (!answer) return open;
    if (answer.allowed === false) return { allowed:false, reason:String(answer.reason || 'busy'), release:async () => {} };
  } catch {
    return open;
  }
  let released = false;
  return {
    allowed:true,
    reason:'ok',
    release:async (refund = false) => {
      if (released) return;
      released = true;
      try { await callSearchRate(env, { op:'release', chatId, userId, now:Date.now(), token, refund:refund === true }); } catch {}
    }
  };
}

export function searchRateText(reason) {
  return reason === 'limit' ? SEARCH_LIMIT_TEXT : SEARCH_BUSY_TEXT;
}
