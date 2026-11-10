// AI module state (TG-RUNTIME-047) in the shared outbox object: daily
// request counters, the answer cache and Premium entitlements.
//
// Per-user keys end in ":<chatId>:<userId>" like the other dialogue state, so
// /forget deletes them (forget-command.mjs), the Premium record included. The
// hourly retention sweep deletes old counters and Premium records 30 days
// after they end (retention-sweep.mjs). The cache holds only general
// questions and listing letters; the hourly sweep deletes it after 24 hours
// (SHARED_RETENTION_RULES) and writes also prune it.
import { readBoundedJSON } from './pilot-security.mjs';

export const AI_STATE_PATH = '/ai-state';
export const AI_USAGE_PREFIX = 'telegram-ai-usage:v1:';
export const AI_GLOBAL_KEY = 'telegram-ai-global:v1';
export const AI_CACHE_PREFIX = 'telegram-ai-cache:v1:';
export const AI_PREMIUM_PREFIX = 'telegram-ai-premium:v1:';

const DAY_MS = 24 * 60 * 60 * 1000;
export const AI_CACHE_TTL_MS = DAY_MS;
export const PREMIUM_RETAIN_MS = 30 * DAY_MS;
export const PREMIUM_DAYS = 30;
const DEFAULT_FREE_LIMIT = 3;
const DEFAULT_PREMIUM_LIMIT = 50;
const DEFAULT_GLOBAL_LIMIT = 300;
const CALL_TIMEOUT_MS = 3000;

function limitOf(value, fallback) {
  const raw = String(value ?? '').trim();
  return /^[0-9]{1,6}$/u.test(raw) ? Number(raw) : fallback;
}

export function aiLimits(env = {}) {
  return {
    free:limitOf(env.AI_FREE_DAILY_LIMIT, DEFAULT_FREE_LIMIT),
    premium:limitOf(env.AI_PREMIUM_DAILY_LIMIT, DEFAULT_PREMIUM_LIMIT),
    global:limitOf(env.AI_GLOBAL_DAILY_LIMIT, DEFAULT_GLOBAL_LIMIT)
  };
}

// The calendar day in Berlin: limits reset at local midnight.
export function berlinDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Berlin', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(now));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

const userKey = (prefix, chatId, userId) => `${prefix}${chatId}:${userId}`;
const validUser = (chatId, userId) => Number.isSafeInteger(chatId) && chatId > 0 && chatId === userId;
const CACHE_KEY = /^[0-9a-f]{64}$/u;
const CHARGE_ID = /^[A-Za-z0-9_:.-]{1,128}$/u;

function premiumActive(record, now) {
  return Number.isSafeInteger(record?.until) && record.until > now;
}

async function consume(storage, value, now) {
  const { chatId, userId } = value;
  const day = berlinDay(now);
  const limits = { free:limitOf(value.freeLimit, DEFAULT_FREE_LIMIT), premium:limitOf(value.premiumLimit, DEFAULT_PREMIUM_LIMIT), global:limitOf(value.globalLimit, DEFAULT_GLOBAL_LIMIT) };
  const premiumRecord = await storage.get(userKey(AI_PREMIUM_PREFIX, chatId, userId));
  const premium = premiumActive(premiumRecord, now);
  const limit = premium ? limits.premium : limits.free;
  const usageKey = userKey(AI_USAGE_PREFIX, chatId, userId);
  const usage = await storage.get(usageKey);
  const used = usage?.day === day && Number.isSafeInteger(usage.count) ? usage.count : 0;
  const global = await storage.get(AI_GLOBAL_KEY);
  const globalUsed = global?.day === day && Number.isSafeInteger(global.count) ? global.count : 0;
  const base = { status:'ok', premium, premiumUntil:premium ? premiumRecord.until : null, limit };
  if (used >= limit) return { ...base, allowed:false, reason:'user_limit', used };
  if (globalUsed >= limits.global) return { ...base, allowed:false, reason:'global_limit', used };
  await storage.put(usageKey, { day, count:used + 1, updatedAt:now });
  await storage.put(AI_GLOBAL_KEY, { day, count:globalUsed + 1, updatedAt:now });
  return { ...base, allowed:true, used:used + 1 };
}

// A request whose model call failed gives its unit back.
async function release(storage, value, now) {
  const day = berlinDay(now);
  const usageKey = userKey(AI_USAGE_PREFIX, value.chatId, value.userId);
  const usage = await storage.get(usageKey);
  if (usage?.day === day && usage.count > 0) await storage.put(usageKey, { day, count:usage.count - 1, updatedAt:now });
  const global = await storage.get(AI_GLOBAL_KEY);
  if (global?.day === day && global.count > 0) await storage.put(AI_GLOBAL_KEY, { day, count:global.count - 1, updatedAt:now });
  return { status:'ok' };
}

async function grantPremium(storage, value, now) {
  const chargeId = String(value.chargeId || '');
  if (!CHARGE_ID.test(chargeId)) return { status:'bad_operation' };
  const key = userKey(AI_PREMIUM_PREFIX, value.chatId, value.userId);
  const record = await storage.get(key);
  const charges = Array.isArray(record?.charges) ? record.charges : [];
  // Telegram may deliver the same payment twice; one charge extends once.
  if (charges.some(charge => charge.id === chargeId)) return { status:'ok', until:record.until, duplicate:true };
  const start = premiumActive(record, now) ? record.until : now;
  const until = start + PREMIUM_DAYS * DAY_MS;
  await storage.put(key, {
    until,
    retainUntil:until + PREMIUM_RETAIN_MS,
    charges:[...charges, { id:chargeId, at:now, amount:Number(value.amount) || 0 }].slice(-12),
    updatedAt:now
  });
  return { status:'ok', until, duplicate:false };
}

async function pruneCache(storage, now) {
  if (typeof storage.list !== 'function') return;
  const expired = [];
  for (const [key, value] of await storage.list({ prefix:AI_CACHE_PREFIX, limit:128 })) {
    if (!(Number(value?.expiresAt) > now)) expired.push(key);
  }
  if (expired.length) await storage.delete(expired);
}

export async function handleAiStateStorage(request, outbox) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== AI_STATE_PATH) return null;
  const parsed = await readBoundedJSON(request.clone(), 16384);
  const value = parsed.error ? null : parsed.value;
  const now = Number(value?.now);
  if (!value || !Number.isSafeInteger(now) || now <= 0) return json({ status:'bad_operation' }, 400);
  const storage = outbox?.householdContextStorage || outbox?.ctx?.storage;
  if (!storage || typeof storage.get !== 'function') return json({ status:'storage_unavailable' }, 503);
  const chatId = Number(value.chatId);
  const userId = Number(value.userId);
  try {
    if (value.op === 'cache-get' || value.op === 'cache-put') {
      const key = String(value.key || '');
      if (!CACHE_KEY.test(key)) return json({ status:'bad_operation' }, 400);
      if (value.op === 'cache-get') {
        const stored = await storage.get(`${AI_CACHE_PREFIX}${key}`);
        if (!stored || !(stored.expiresAt > now) || typeof stored.text !== 'string') return json({ status:'ok', text:null });
        return json({ status:'ok', text:stored.text });
      }
      const text = String(value.text || '');
      if (!text || text.length > 4000) return json({ status:'bad_operation' }, 400);
      await storage.put(`${AI_CACHE_PREFIX}${key}`, { text, expiresAt:now + AI_CACHE_TTL_MS });
      await pruneCache(storage, now);
      return json({ status:'ok' });
    }
    if (!validUser(chatId, userId)) return json({ status:'bad_operation' }, 400);
    if (value.op === 'consume') return json(await consume(storage, { ...value, chatId, userId }, now));
    if (value.op === 'release') return json(await release(storage, { chatId, userId }, now));
    if (value.op === 'premium-grant') {
      const result = await grantPremium(storage, { ...value, chatId, userId }, now);
      return json(result, result.status === 'ok' ? 200 : 400);
    }
    if (value.op === 'premium-status') {
      const record = await storage.get(userKey(AI_PREMIUM_PREFIX, chatId, userId));
      return json({ status:'ok', premium:premiumActive(record, now), until:premiumActive(record, now) ? record.until : null });
    }
    return json({ status:'bad_operation' }, 400);
  } catch {
    return json({ status:'unavailable' }, 503);
  }
}

export async function aiStateCall(env, payload) {
  if (!env?.OUTBOX) return { status:'unavailable' };
  try {
    const response = await env.OUTBOX.get(env.OUTBOX.idFromName('telegram-pilot-v1')).fetch(`https://outbox.internal${AI_STATE_PATH}`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload), signal:AbortSignal.timeout(CALL_TIMEOUT_MS)
    });
    const parsed = await readBoundedJSON(response, 16384);
    return response.ok && !parsed.error ? parsed.value : { status:'unavailable' };
  } catch {
    return { status:'unavailable' };
  }
}

export async function cacheKey(kind, text) {
  const normalized = `${kind}\n${String(text || '').toLowerCase().replace(/\s+/gu, ' ').trim()}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
