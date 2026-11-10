// Daily watch over the official KdU sources the bot's Jobcenter limits come
// from. Limits are pinned in code and are never changed automatically: when an
// official page or PDF changes, stays unreachable, or an announced new limit
// date has passed without a verified table, the admins get one Telegram note.
import { SH_VERIFIED_KDU_MODULES, SH_PENDING_KDU_TERRITORIES } from './jobcenter-registry-statewide.mjs';
import { readBoundedJSON } from './pilot-security.mjs';

export const KDU_MONITOR_PATH = '/kdu-source-monitor';
export const KDU_MONITOR_OBJECT = 'kdu-source-monitor:v1';
const STATE_KEY = 'kdu-source-monitor:state:v1';
const FETCH_TIMEOUT_MS = 8000;
const MAX_SOURCE_BYTES = 3 * 1024 * 1024;
const FAILURE_ALERT_AFTER = 3;
const OVERDUE_REPEAT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// Several official CMS (download.php) answer 404 to self-declared bots.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export function berlinDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Berlin', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(now));
}

function shownDate(isoDay) {
  const [year, month, day] = String(isoDay || '').split('-');
  return year && month && day ? `${day}.${month}.${year}` : String(isoDay || '');
}

export function kduMonitorSources() {
  const sources = new Map();
  for (const [jurisdiction, module] of Object.entries(SH_VERIFIED_KDU_MODULES)) {
    const url = module?.sources?.[0]?.url;
    if (typeof url === 'string' && url.startsWith('https://') && !sources.has(url)) {
      sources.set(url, { jurisdiction, authority:module.authority || jurisdiction, url, validFrom:module.validFrom || null });
    }
  }
  for (const [jurisdiction, pending] of Object.entries(SH_PENDING_KDU_TERRITORIES)) {
    const url = pending?.sourceUrl;
    if (typeof url === 'string' && url.startsWith('https://') && !sources.has(url)) {
      sources.set(url, { jurisdiction, authority:pending.authority || jurisdiction, url, validFrom:null, pending:true });
    }
  }
  return [...sources.values()];
}

async function boundedBytes(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SOURCE_BYTES) { await reader.cancel().catch(() => {}); throw new Error('source too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

// HTML pages carry session tokens, dates and banners; only their visible text
// counts. PDFs are compared byte for byte.
export function normalizedSourceText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function fetchSourceFingerprint(url, transport = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await transport(url, { method:'GET', redirect:'follow', signal:controller.signal, headers:{ 'user-agent':USER_AGENT, accept:'text/html,application/pdf;q=0.9,*/*;q=0.5' } });
    if (!response?.ok) return { ok:false, reason:`http_${Number(response?.status) || 0}` };
    const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
    const bytes = await boundedBytes(response);
    const isPdf = type.includes('pdf') || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
    const material = isPdf ? bytes : new TextEncoder().encode(normalizedSourceText(new TextDecoder().decode(bytes)));
    if (!material.byteLength) return { ok:false, reason:'empty' };
    return { ok:true, hash:await sha256Hex(material), kind:isPdf ? 'pdf' : 'html' };
  } catch (error) {
    return { ok:false, reason:controller.signal.aborted ? 'timeout' : String(error?.message || 'network_error').slice(0, 60) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runKduSourceMonitor({ state = {}, now = Date.now(), transport = fetch, sources = kduMonitorSources() } = {}) {
  const day = berlinDay(now);
  if (state?.day === day) return { skipped:true, state, alerts:[] };
  const previous = state?.sources && typeof state.sources === 'object' ? state.sources : {};
  const next = {};
  const changed = [];
  const unreachable = [];
  const results = await Promise.all(sources.map(async source => ({ source, result:await fetchSourceFingerprint(source.url, transport) })));
  for (const { source, result } of results) {
    const before = previous[source.url] || {};
    if (!result.ok) {
      const failures = (Number(before.failures) || 0) + 1;
      next[source.url] = { ...before, failures, lastError:result.reason, checkedAt:now };
      if (failures === FAILURE_ALERT_AFTER) unreachable.push({ ...source, reason:result.reason });
      continue;
    }
    next[source.url] = { hash:result.hash, kind:result.kind, checkedAt:now, changedAt:before.hash && before.hash !== result.hash ? now : (before.changedAt || null), failures:0 };
    // The first sighting is the baseline; only a later difference is a change.
    if (before.hash && before.hash !== result.hash) changed.push(source);
  }

  const overdueNotified = { ...(state?.overdueNotified || {}) };
  const overdue = [];
  for (const [jurisdiction, pending] of Object.entries(SH_PENDING_KDU_TERRITORIES)) {
    const from = pending?.futureChangeFrom;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(from || '')) || from > day) continue;
    const last = overdueNotified[jurisdiction];
    if (last && Date.parse(day) - Date.parse(last) < OVERDUE_REPEAT_DAYS * DAY_MS) continue;
    overdueNotified[jurisdiction] = day;
    overdue.push({ jurisdiction, authority:pending.authority || jurisdiction, from, url:pending.sourceUrl || null });
  }

  const alerts = [
    ...changed.map(source => `🔄 ${source.authority}: офіційне джерело змінилося.\n${source.url}`),
    ...unreachable.map(source => `⚠️ ${source.authority}: джерело недоступне ${FAILURE_ALERT_AFTER} дні поспіль (${source.reason}).\n${source.url}`),
    ...overdue.map(item => `⏰ ${item.authority}: нові межі мали діяти з ${shownDate(item.from)}, але перевіреної таблиці в боті немає.${item.url ? `\n${item.url}` : ''}`)
  ];
  return { skipped:false, alerts, state:{ day, sources:next, overdueNotified } };
}

export function kduMonitorMessage(alerts, now = Date.now()) {
  return [
    `🏛 Моніторинг лімітів Jobcenter (KdU) — ${shownDate(berlinDay(now))}`,
    '',
    ...alerts.flatMap(alert => [alert, '']),
    'Ліміти в боті автоматично не змінюються. Перевірте документ і, якщо таблиця нова, оновіть модуль з посиланням на офіційне джерело.'
  ].join('\n').slice(0, 4000);
}

async function notifyAdmins(config, recipients, text, transport) {
  let sent = 0;
  for (const chatId of recipients) {
    try {
      const response = await transport(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ chat_id:chatId, text, disable_notification:false, link_preview_options:{ is_disabled:true } })
      });
      const parsed = await readBoundedJSON(response, 16384);
      if (response.ok && !parsed.error && parsed.value?.ok === true) sent += 1;
    } catch {}
  }
  return sent;
}

// Durable Object side: one run per Berlin day, state kept in the object's storage.
export async function handleKduMonitorStorage(request, outbox, { config, recipients = async () => [], transport = fetch } = {}) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== KDU_MONITOR_PATH) return null;
  const parsed = await readBoundedJSON(request.clone(), 4096);
  const now = Number(parsed.error ? NaN : parsed.value?.now);
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
  if (!Number.isSafeInteger(now) || now <= 0) return reply({ ok:false, status:'bad_operation' }, 400);
  const storage = outbox?.ctx?.storage || outbox?.householdContextStorage;
  if (!storage) return reply({ ok:false, status:'storage_unavailable' }, 503);
  const state = await storage.get(STATE_KEY) || {};
  const run = await runKduSourceMonitor({ state, now, transport });
  if (run.skipped) return reply({ ok:true, status:'already_ran_today' });
  let sent = 0;
  if (run.alerts.length && config?.token) {
    const ids = [...new Set((await recipients()).filter(id => Number.isSafeInteger(id) && id > 0))];
    sent = await notifyAdmins(config, ids, kduMonitorMessage(run.alerts, now), transport);
  }
  // A day whose alerts reached nobody is retried on the next cron run.
  if (!run.alerts.length || sent > 0) await storage.put(STATE_KEY, run.state);
  return reply({ ok:true, status:'ran', alerts:run.alerts.length, sent });
}
