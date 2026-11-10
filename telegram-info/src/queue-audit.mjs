// Read-only, single-chat staging diagnostics. No network calls or state changes on import.
// The webhook secret is used only as an HMAC key with a distinct audit purpose.
import { pilotConfig, equalSecret, readBoundedJSON } from './pilot-security.mjs';

export const AUDIT_PATH = '/telegram/internal/audit';
const PURPOSE = 'zaskaleta-telegram-queue-audit-v1';
const encoder = new TextEncoder();
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const validTime = n => Number.isSafeInteger(n) && n >= 0;
const validChatId = n => Number.isSafeInteger(n) && n !== 0;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

async function signature(secret, timestamp) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${PURPOSE}\nPOST\n${AUDIT_PATH}\n${timestamp}`)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export async function auditHeaders(secret, now = Date.now()) {
  if (typeof secret !== 'string' || !SECRET.test(secret) || !validTime(now)) throw Error('Invalid audit configuration');
  const timestamp = String(Math.floor(now / 1000));
  return { 'x-telegram-audit-time': timestamp, 'x-telegram-audit-signature': await signature(secret, timestamp) };
}

export async function verifyAudit(request, secret, now = Date.now()) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== AUDIT_PATH || typeof secret !== 'string' || !SECRET.test(secret) || !validTime(now)) return false;
  const timestamp = request.headers.get('x-telegram-audit-time') || '';
  const supplied = request.headers.get('x-telegram-audit-signature') || '';
  if (!/^[0-9]{10,11}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  const millis = Number(timestamp) * 1000;
  if (!validTime(millis) || Math.abs(now - millis) > 60000) return false;
  return equalSecret(supplied, await signature(secret, timestamp));
}

// Cloudflare may expose a POST body stream even when the request contains zero bytes.
// Accept zero bytes only; reject any declared or streamed payload without buffering it.
async function hasNonEmptyBody(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared)) return true;
    if (Number(declared) !== 0) return true;
  }
  if (!request.body) return false;
  const reader = request.body.getReader();
  try {
    for (let i = 0; i < 4; i++) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value?.byteLength > 0) {
        await reader.cancel().catch(() => {});
        return true;
      }
    }
    await reader.cancel().catch(() => {});
    return true;
  } catch {
    return true;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// Fixed aggregate projection: never select reply, identifiers, claim tokens or message content.
export function readQueueSnapshot(storage, chatId, now = Date.now()) {
  if (!validChatId(chatId) || !validTime(now)) throw Error('Invalid audit scope');
  const rows = storage.sql.exec(`SELECT
    COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN state='queued' THEN 1 ELSE 0 END),0) AS queued,
    COALESCE(SUM(CASE WHEN state='sending' THEN 1 ELSE 0 END),0) AS sending,
    COALESCE(SUM(CASE WHEN state='sent' THEN 1 ELSE 0 END),0) AS sent,
    COALESCE(SUM(CASE WHEN state='uncertain' THEN 1 ELSE 0 END),0) AS uncertain,
    COALESCE(SUM(CASE WHEN state='rejected' THEN 1 ELSE 0 END),0) AS rejected,
    COALESCE(SUM(CASE WHEN state='queued' AND created_at<? THEN 1 ELSE 0 END),0) AS expiredQueued,
    MIN(CASE WHEN state='queued' THEN created_at END) AS oldestQueuedAt,
    MAX(created_at) AS lastRecordedAt
    FROM telegram_outbox WHERE chat_id=?`, now - 86400000, chatId).toArray();
  const row = rows[0];
  if (!row) throw Error('Audit storage unavailable');
  const count = key => {
    const n = Number(row[key]);
    if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid audit aggregate');
    return n;
  };
  const time = key => row[key] == null ? null : validTime(Number(row[key])) ? Number(row[key]) : (() => { throw Error('Invalid audit timestamp'); })();
  const result = {
    schema: 'queue-audit-v1', asOf: now,
    total: count('total'), queued: count('queued'), sending: count('sending'),
    sent: count('sent'), uncertain: count('uncertain'), rejected: count('rejected'),
    expiredQueued: count('expiredQueued'), oldestQueuedAt: time('oldestQueuedAt'),
    lastRecordedAt: time('lastRecordedAt')
  };
  if (result.total !== result.queued + result.sending + result.sent + result.uncertain + result.rejected || result.expiredQueued > result.queued) throw Error('Inconsistent audit aggregate');
  return result;
}

const FIELDS = ['total','queued','sending','sent','uncertain','rejected','expiredQueued'];
export function validateQueueSnapshot(value) {
  if (!value || value.schema !== 'queue-audit-v1' || !validTime(value.asOf)) return false;
  if (!FIELDS.every(k => Number.isSafeInteger(value[k]) && value[k] >= 0)) return false;
  if (!['oldestQueuedAt','lastRecordedAt'].every(k => value[k] === null || validTime(value[k]))) return false;
  return value.total === value.queued + value.sending + value.sent + value.uncertain + value.rejected && value.expiredQueued <= value.queued;
}

export async function handleQueueAudit(request, env = {}, now = Date.now()) {
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
  const config = pilotConfig(env);
  // Exact false is required. Missing/unknown/true delivery is never an audit-ready state.
  if (!config || env.TELEGRAM_DELIVERY_ENABLED !== 'false') return json({ error: 'Not configured' }, 503);
  if (!await verifyAudit(request, config.secret, now)) return json({ error: 'Unauthorized' }, 401);
  if (await hasNonEmptyBody(request)) return json({ error: 'Invalid request' }, 400);
  if (!env.OUTBOX) return json({ error: 'Storage unavailable' }, 503);
  try {
    const id = env.OUTBOX.idFromName('telegram-pilot-v1');
    const response = await env.OUTBOX.get(id).fetch('https://outbox.internal/audit', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'snapshot' })
    });
    if (response.status !== 200) return json({ error: 'Storage unavailable' }, 503);
    const parsed = await readBoundedJSON(response, 4096);
    if (parsed.error || !validateQueueSnapshot(parsed.value)) return json({ error: 'Storage unavailable' }, 503);
    // Copy only the reviewed aggregate schema, never arbitrary downstream fields.
    const snapshot = parsed.value;
    return json({ schema: snapshot.schema, asOf: snapshot.asOf, total: snapshot.total,
      queued: snapshot.queued, sending: snapshot.sending, sent: snapshot.sent,
      uncertain: snapshot.uncertain, rejected: snapshot.rejected,
      expiredQueued: snapshot.expiredQueued, oldestQueuedAt: snapshot.oldestQueuedAt,
      lastRecordedAt: snapshot.lastRecordedAt });
  } catch { return json({ error: 'Storage unavailable' }, 503); }
}
