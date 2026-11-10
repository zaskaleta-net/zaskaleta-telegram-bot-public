// Daily operations report for the bot admins. Counters are aggregate only:
// a fixed key such as "feature:housing" or "search:timeout" and a number per
// Berlin day — no Telegram ids, names or message text. They replace the
// former PostHog events (analytics is off), so the owner still sees whether
// the bot works: requests, failures, background search outcomes, news.
import { readBoundedJSON } from './pilot-security.mjs';
import { berlinDay } from './kdu-source-monitor.mjs';

export const OPS_METRICS_PATH = '/ops-metrics';
export const OPS_REPORT_PATH = '/ops-report';
const OPS_OBJECT = 'telegram-pilot-v1';
const DAY_PREFIX = 'ops-metrics:v1:';
const REPORT_MARKER_KEY = 'ops-report:last-day:v1';
const KEEP_DAYS = 8;
const REPORT_HOUR = 21;
const CALL_TIMEOUT_MS = 1500;
const KEY_RE = /^[a-z_]{1,24}:[a-z_]{1,24}$/u;
const NEWS_CACHE_KEY = 'telegram-news-publication-cache:v1';
const TRANSLATION_MEMO_KEY = 'telegram-news-translation-memo:v1';

const FEATURE_LABELS = Object.freeze({
  menu:'Меню', housing:'Житло', housing_jobcenter:'Пошук під Jobcenter', jobcenter:'Jobcenter', work:'Робота',
  courses:'Курси', school:'Школа/Kita', transport:'Транспорт', documents:'Документи', kindergeld:'Kindergeld',
  news:'Новини', events:'Куди піти', advice:'Консультації', report:'Помилки', free_text:'Вільний текст', other:'Інше'
});

export function opsMetricKey(group, name) {
  if (typeof group !== 'string' || typeof name !== 'string') return null;
  const key = `${group}:${name}`;
  return KEY_RE.test(key) ? key : null;
}

function berlinHour(now) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Berlin', hour:'2-digit', hourCycle:'h23' }).format(new Date(now)));
}

function shownDate(day) {
  const [year, month, date] = String(day).split('-');
  return `${date}.${month}.${year}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

export function opsDayKey(now) { return `${DAY_PREFIX}${berlinDay(now)}`; }

// Durable Object storage side: add n to one counter of today.
export async function addOpsCount(storage, now, key, n = 1) {
  if (!KEY_RE.test(String(key)) || !Number.isSafeInteger(n) || n <= 0 || typeof storage?.put !== 'function') return false;
  const dayKey = `${DAY_PREFIX}${berlinDay(now)}`;
  const current = (await storage.get(dayKey)) || { counts:{} };
  const counts = current.counts && typeof current.counts === 'object' ? current.counts : {};
  counts[key] = (Number(counts[key]) || 0) + n;
  await storage.put(dayKey, { ...current, counts });
  return true;
}

function sourceSlug(value) {
  return String(value || '').toLowerCase().replace(/ä/gu, 'ae').replace(/ö/gu, 'oe').replace(/ü/gu, 'ue').replace(/ß/gu, 'ss')
    .replace(/[^a-z]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 24);
}

// One "answered"/"failed" counter per housing source of a search. Grouped
// sources (housing companies, Immomio) are counted per company (page step).
export function opsSourceKeys(sources) {
  const keys = [];
  for (const entry of Array.isArray(sources) ? sources : []) {
    const label = String(entry?.source || '');
    if (!label || label === 'primary-merge') continue;
    const status = String(entry?.status || '');
    if (['skipped', 'not_configured'].includes(status) || entry?.notSent === true) continue;
    const steps = (Array.isArray(entry?.pages) ? entry.pages : []).filter(page => page?.step && !['city', 'list', 'wg'].includes(page.step));
    if (steps.length) {
      for (const page of steps) keys.push(opsMetricKey(Number(page.httpStatus) === 200 ? 'src_ok' : 'src_fail', sourceSlug(page.step)));
    } else {
      keys.push(opsMetricKey(['ok', 'partial'].includes(status) ? 'src_ok' : 'src_fail', sourceSlug(label)));
    }
  }
  return keys.filter(Boolean).slice(0, 20);
}

// Worker side: several counters in one Durable Object call, failures ignored.
export async function recordOpsMetrics(env, keys) {
  const valid = [...new Set((Array.isArray(keys) ? keys : []).filter(key => KEY_RE.test(String(key))))].slice(0, 20);
  if (!env?.OUTBOX || !valid.length) return { status:'disabled' };
  try {
    const response = await env.OUTBOX.get(env.OUTBOX.idFromName(OPS_OBJECT)).fetch(`https://outbox.internal${OPS_METRICS_PATH}`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ now:Date.now(), keys:valid }), signal:AbortSignal.timeout(CALL_TIMEOUT_MS)
    });
    return { status:response.ok ? 'recorded' : 'unavailable' };
  } catch {
    return { status:'unavailable' };
  }
}

// Worker side: one counter, after the response, failures ignored.
export async function recordOpsMetric(env, key) {
  if (!env?.OUTBOX || !KEY_RE.test(String(key))) return { status:'disabled' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await env.OUTBOX.get(env.OUTBOX.idFromName(OPS_OBJECT)).fetch(`https://outbox.internal${OPS_METRICS_PATH}`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ now:Date.now(), key }), signal:controller.signal
    });
    return { status:response.ok ? 'recorded' : 'unavailable' };
  } catch {
    return { status:'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

function hhmm(timestamp) {
  return new Intl.DateTimeFormat('de-DE', { timeZone:'Europe/Berlin', hour:'2-digit', minute:'2-digit' }).format(new Date(timestamp));
}

// Report names for the counter slugs; an unknown slug is shown as it is.
const SOURCE_LABELS = Object.freeze({
  kleinanzeigen_api:'Kleinanzeigen API', kleinanzeigen_public:'Kleinanzeigen', ohne_makler:'Ohne-Makler', kip_schleswig_holstein:'KIP',
  wg_gesucht:'WG-Gesucht', vonovia:'Vonovia', wankendorfer:'Wankendorfer', trave:'TRAVE', wobau_neumuenster:'WOBAU NMS', fab:'FAB',
  wbg_kiel_ost:'WBG Kiel-Ost', luebecker_bauverein:'Lüb. Bauverein', neue_luebecker:'Neue Lübecker', woge_kiel:'WOGE Kiel',
  adlershorst:'Adlershorst', big_verwaltung:'BIG', wodi_dithmarschen:'wodi', zbvv:'ZBVV', hug_kiel:'H&G Kiel',
  gewoba_nord:'GEWOBA Nord', bgs_sachsenwald:'BGS Sachsenwald', neue_gewoge:'Neue GeWoGe',
  // TG-RUNTIME-072: the report of 23.10.2026 showed the raw "housing_companies".
  housing_companies:'Житлові компанії'
});

// "3 спроби", "5 спроб", "21 спроба"; after "з" the genitive: "з 1 спроби", "з 84 спроб".
function attempts(n) {
  const tens = n % 100;
  const units = n % 10;
  if (units === 1 && tens !== 11) return `${n} спроба`;
  if (units >= 2 && units <= 4 && (tens < 12 || tens > 14)) return `${n} спроби`;
  return `${n} спроб`;
}

function ofAttempts(n) {
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'спроби' : 'спроб'}`;
}

function sourceStats(counts) {
  const names = new Set(Object.keys(counts).filter(key => /^src_(?:ok|fail):/u.test(key)).map(key => key.split(':')[1]));
  return [...names].sort().map(name => [name, Number(counts[`src_ok:${name}`]) || 0, Number(counts[`src_fail:${name}`]) || 0]);
}

function sourceLine(counts) {
  const stats = sourceStats(counts);
  return stats.length
    ? `Джерела житла (відповіли/збої): ${stats.map(([name, ok, fail]) => `${SOURCE_LABELS[name] || name} ${ok}/${fail}${!ok && fail ? ' ⚠️' : ''}`).join(' · ')}`
    : 'Джерела житла: пошуків не було';
}

export function opsReportText({ day, counts = {}, newsCache = null, memoSize = 0 }) {
  const get = key => Number(counts[key]) || 0;
  const features = Object.keys(FEATURE_LABELS)
    .map(name => [FEATURE_LABELS[name], get(`feature:${name}`)])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const requests = features.reduce((sum, [, count]) => sum + count, 0);
  const failed = get('request:rejected') + get('request:exception');
  const searchTotal = ['completed', 'timeout', 'error', 'delivery_failed'].reduce((sum, reason) => sum + get(`search:${reason}`), 0);
  const searchFailed = searchTotal - get('search:completed');
  const lines = [
    `📊 Звіт бота за ${shownDate(day)}`,
    '',
    `Запити: ${requests}${failed ? ` · з помилкою: ${failed}` : ' · без помилок'}`,
    features.length ? `Розділи: ${features.map(([label, count]) => `${label} ${count}`).join(' · ')}` : 'Розділи: запитів не було',
    searchTotal
      ? `Пошук по району: завершено ${get('search:completed')} · таймаут ${get('search:timeout')} · помилка ${get('search:error')} · не доставлено ${get('search:delivery_failed')}`
      : 'Пошук по району: не запускався',
    newsCache?.createdAt
      ? `Новини: останній огляд о ${hhmm(newsCache.createdAt)}, карток ${Number(newsCache.cardCount) || 0}`
      : 'Новини: готового огляду немає',
    sourceLine(counts),
    `Переклади в пам’яті: ${memoSize}`,
    `Видалено прострочених записів: ${get('retention:deleted')}`
  ];
  const warnings = [];
  for (const [name, ok, fail] of sourceStats(counts)) {
    // TG-RUNTIME-068: Kleinanzeigen answered 67 of 384 runs (17 %) and no
    // warning came, because the rule needed 0 answers. Mostly failing counts.
    if (!ok && fail >= 3) warnings.push(`⚠️ Джерело ${SOURCE_LABELS[name] || name} не відповідає (${attempts(fail)}) — можливо, блокує запити.`);
    else if (fail >= 5 && fail >= 4 * ok) warnings.push(`⚠️ Джерело ${SOURCE_LABELS[name] || name} відповідає рідко: ${ok} з ${ofAttempts(ok + fail)} — можливо, блокує запити.`);
  }
  if (requests >= 10 && failed / requests > 0.1) warnings.push(`⚠️ Помилок більше 10 % (${failed} з ${requests}).`);
  if (searchTotal >= 3 && searchFailed / searchTotal > 0.3) warnings.push(`⚠️ Пошук по району часто не завершується (${searchFailed} з ${searchTotal}).`);
  if (!newsCache?.createdAt || Number(newsCache.cardCount) === 0) warnings.push('⚠️ Новини без карток — перевірте джерела або ліміт Workers AI.');
  return [...lines, ...(warnings.length ? ['', ...warnings] : ['', '✅ Відхилень не виявлено.'])].join('\n').slice(0, 4000);
}

async function notifyAdmins(config, recipients, text, transport, { silent = true } = {}) {
  let sent = 0;
  for (const chatId of recipients) {
    try {
      const response = await transport(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ chat_id:chatId, text, disable_notification:silent, link_preview_options:{ is_disabled:true } })
      });
      const parsed = await readBoundedJSON(response, 16384);
      if (response.ok && !parsed.error && parsed.value?.ok === true) sent += 1;
    } catch {}
  }
  return sent;
}

// Instant alerts: the admins hear of a failure when it happens, not only in
// the evening report. Each alert is sent once per Berlin day (its id is kept
// in the day's counter record) and silently between 22:00 and 07:00.
export function opsAlertsFor(counts, keys) {
  const get = key => Number(counts?.[key]) || 0;
  const alerts = [];
  for (const key of new Set(keys)) {
    const [group, name] = String(key).split(':');
    if (group === 'src_fail' && get(key) >= 3 && get(`src_ok:${name}`) === 0) {
      alerts.push({ id:`src:${name}`, text:`⚠️ Джерело житла ${SOURCE_LABELS[name] || name} не відповідає: ${attempts(get(key))} сьогодні, жодної вдалої. Можливо, сайт змінився або блокує запити.` });
    }
    if (key === 'request:exception' && get(key) >= 5) {
      alerts.push({ id:'request_exception', text:`⚠️ Бот: ${get(key)} необроблених помилок запитів сьогодні. Перевірте журнал Cloudflare.` });
    }
    if ((key === 'search:error' || key === 'search:timeout' || key === 'search:delivery_failed') && get('search:error') + get('search:timeout') + get('search:delivery_failed') >= 3) {
      alerts.push({ id:'search', text:`⚠️ Пошук житла по району: ${get('search:error') + get('search:timeout') + get('search:delivery_failed')} незавершених пошуків сьогодні.` });
    }
  }
  return alerts;
}

export async function sendOpsAlert(storage, now, alert, { config = null, recipients = async () => [], transport = fetch } = {}) {
  if (!config?.token || !alert?.id || typeof storage?.get !== 'function') return 'disabled';
  const dayKey = `${DAY_PREFIX}${berlinDay(now)}`;
  const current = (await storage.get(dayKey)) || { counts:{} };
  const sentIds = Array.isArray(current.alerts) ? current.alerts : [];
  if (sentIds.includes(alert.id)) return 'already_sent';
  const ids = [...new Set((await recipients()).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return 'no_recipients';
  const hour = berlinHour(now);
  const sent = await notifyAdmins(config, ids, `${alert.text}\n\n${hhmm(now)} · ${shownDate(berlinDay(now))}`, transport, { silent:hour >= 22 || hour < 7 });
  if (!sent) return 'not_sent';
  const latest = (await storage.get(dayKey)) || current;
  await storage.put(dayKey, { ...latest, counts:latest.counts || {}, alerts:[...(Array.isArray(latest.alerts) ? latest.alerts : []), alert.id].slice(-50) });
  return 'sent';
}

async function purgeOldDays(storage, now) {
  const keep = new Set();
  for (let index = 0; index < KEEP_DAYS; index += 1) keep.add(`${DAY_PREFIX}${berlinDay(now - index * 24 * 60 * 60 * 1000)}`);
  const old = [...(await storage.list({ prefix:DAY_PREFIX })).keys()].filter(key => !keep.has(key));
  if (old.length) await storage.delete(old.slice(0, 128));
}

// Durable Object side for both paths.
export async function handleOpsMetricsStorage(request, outbox, { config = null, recipients = async () => [], transport = fetch } = {}) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || (url.pathname !== OPS_METRICS_PATH && url.pathname !== OPS_REPORT_PATH)) return null;
  const parsed = await readBoundedJSON(request.clone(), 4096);
  const now = Number(parsed.error ? NaN : parsed.value?.now);
  if (!Number.isSafeInteger(now) || now <= 0) return json({ status:'bad_operation' }, 400);
  const storage = outbox?.householdContextStorage;
  if (!storage || typeof storage.get !== 'function') return json({ status:'storage_unavailable' }, 503);
  try {
    if (url.pathname === OPS_METRICS_PATH) {
      const keys = Array.isArray(parsed.value?.keys) ? parsed.value.keys.slice(0, 20) : [parsed.value?.key];
      if (!keys.length || !keys.every(key => KEY_RE.test(String(key || '')))) return json({ status:'bad_operation' }, 400);
      for (const key of keys) await addOpsCount(storage, now, String(key));
      const today = await storage.get(`${DAY_PREFIX}${berlinDay(now)}`);
      for (const alert of opsAlertsFor(today?.counts || {}, keys)) await sendOpsAlert(storage, now, alert, { config, recipients, transport });
      return json({ status:'ok' });
    }
    const day = berlinDay(now);
    if (berlinHour(now) < REPORT_HOUR) return json({ status:'not_yet' });
    if ((await storage.get(REPORT_MARKER_KEY)) === day) return json({ status:'already_sent' });
    const [today, newsCache, memo] = await Promise.all([
      storage.get(`${DAY_PREFIX}${day}`), storage.get(NEWS_CACHE_KEY), storage.get(TRANSLATION_MEMO_KEY)
    ]);
    const text = opsReportText({
      day,
      counts:today?.counts || {},
      newsCache:newsCache?.publication ? { createdAt:newsCache.publication.createdAt, cardCount:newsCache.publication.cardCount } : newsCache,
      memoSize:Array.isArray(memo?.entries) ? memo.entries.length : 0
    });
    const ids = config?.token ? [...new Set((await recipients()).filter(id => Number.isSafeInteger(id) && id > 0))] : [];
    const sent = ids.length ? await notifyAdmins(config, ids, text, transport) : 0;
    // A report that reached nobody is retried at the next hourly run.
    if (sent > 0) {
      await storage.put(REPORT_MARKER_KEY, day);
      await purgeOldDays(storage, now);
    }
    return json({ status:sent > 0 ? 'sent' : 'not_sent', sent });
  } catch {
    return json({ status:'unavailable' }, 503);
  }
}
