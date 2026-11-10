// Hourly deletion of expired per-user state in the shared outbox object.
//
// Readers already ignore an expired record, but nothing deleted it: the
// alarm-based sweeps only run on the legacy queue path, so a user who never
// came back kept, e.g., a household size or a search signature forever. The
// Datenschutzerklärung promises the retention below, so the hourly cron now
// deletes what has expired. Ages match the readers' TTLs.
import { readBoundedJSON } from './pilot-security.mjs';
import { addOpsCount } from './ops-metrics.mjs';

export const RETENTION_SWEEP_PATH = '/retention-sweep';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// One run stays well inside a Durable Object request.
const MAX_DELETES_PER_RUN = 2000;

export const RETENTION_RULES = Object.freeze([
  { prefix:'telegram-household-context:v1:', maxAgeMs:2 * HOUR },            // active-household-context.mjs CONTEXT_TTL_MS
  { prefix:'telegram-private-prompt:v1:', maxAgeMs:15 * MINUTE },            // runtime-keyboard.mjs PRIVATE_PROMPT_TTL_MS
  { prefix:'housing-cost-active:v14:', maxAgeMs:15 * MINUTE },               // runtime-housing-state.mjs ACTIVE_TTL_MS
  { prefix:'telegram-housing-cost-pending:v1:', maxAgeMs:15 * MINUTE },      // runtime-housing-state.mjs COST_STATE_TTL_MS
  { prefix:'telegram-report-pending:v1:', maxAgeMs:15 * MINUTE },            // runtime-report-state.mjs REPORT_STATE_TTL_MS
  { prefix:'telegram-jobcenter-search-state:v1:', maxAgeMs:HOUR },           // runtime-jobcenter-base.mjs JOBCENTER_SEARCH_STATE_TTL_MS
  { prefix:'telegram-jobcenter-district-inflight:v1:', expiresField:'expiresAt' },
  { prefix:'telegram-update:v1:', expiresField:'expiresAt' },
  // The marker only stops the one-time legacy keyboard cleanup from running
  // again; after 180 days a returning user gets that cleanup once more.
  { prefix:'telegram-keyboard-reset:v6:', maxAgeMs:180 * DAY },
  // AI module (ai-state.mjs): daily counters and Premium records 30 days
  // after they end. The answer cache prunes itself on write.
  { prefix:'telegram-ai-usage:v1:', maxAgeMs:2 * DAY },
  { prefix:'telegram-ai-premium:v1:', expiresField:'retainUntil' },
  // Housing monitor (housing-watch.mjs): 30 days after the last renewal.
  { prefix:'telegram-housing-watch:v1:', expiresField:'expiresAt' },
  // Search rate limit (search-rate-limit.mjs): 10 minutes.
  { prefix:'telegram-search-rate:v1:', expiresField:'expiresAt' }
]);

// Not per-user state, so outside /forget (forget-command.mjs): the AI answer
// cache of general questions and listing letters (ai-state.mjs).
export const SHARED_RETENTION_RULES = Object.freeze([
  { prefix:'telegram-ai-cache:v1:', expiresField:'expiresAt' }
]);

export function retentionExpired(rule, value, now) {
  if (!value || typeof value !== 'object') return true;
  if (rule.expiresField) {
    const expiresAt = Number(value[rule.expiresField]);
    return !Number.isFinite(expiresAt) || expiresAt <= now;
  }
  const updatedAt = Number(value.updatedAt);
  return !Number.isFinite(updatedAt) || updatedAt < now - rule.maxAgeMs;
}

export async function sweepExpiredState(storage, now = Date.now(), rules = RETENTION_RULES) {
  const deleted = {};
  let total = 0;
  for (const rule of rules) {
    if (total >= MAX_DELETES_PER_RUN) break;
    const entries = await storage.list({ prefix:rule.prefix });
    const expired = [];
    for (const [key, value] of entries) {
      if (total + expired.length >= MAX_DELETES_PER_RUN) break;
      if (retentionExpired(rule, value, now)) expired.push(key);
    }
    // delete() takes up to 128 keys at once.
    for (let index = 0; index < expired.length; index += 128) await storage.delete(expired.slice(index, index + 128));
    if (expired.length) deleted[rule.prefix] = expired.length;
    total += expired.length;
  }
  return { deleted, total };
}

export async function handleRetentionSweepStorage(request, outbox) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== RETENTION_SWEEP_PATH) return null;
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
  const parsed = await readBoundedJSON(request.clone(), 4096);
  const now = Number(parsed.error ? NaN : parsed.value?.now);
  if (!Number.isSafeInteger(now) || now <= 0) return reply({ status:'bad_operation' }, 400);
  const storage = outbox?.householdContextStorage;
  if (!storage || typeof storage.list !== 'function') return reply({ status:'storage_unavailable' }, 503);
  try {
    const result = await sweepExpiredState(storage, now, [...RETENTION_RULES, ...SHARED_RETENTION_RULES]);
    if (result.total > 0) await addOpsCount(storage, now, 'retention:deleted', result.total).catch(() => false);
    return reply({ status:'ok', total:result.total });
  } catch {
    return reply({ status:'unavailable' }, 503);
  }
}
