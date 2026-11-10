import test from 'node:test';
import assert from 'node:assert/strict';
import { addOpsCount, handleOpsMetricsStorage, opsReportText, OPS_METRICS_PATH, OPS_REPORT_PATH, opsMetricKey } from '../src/ops-metrics.mjs';

// 14.10.2026 21:05 Berlin (CEST, UTC+2).
const EVENING = Date.UTC(2026, 9, 14, 19, 5, 0);
const MORNING = Date.UTC(2026, 9, 14, 7, 0, 0);

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(key) { return structuredClone(data.get(key)); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async list({ prefix }) { return new Map([...data].filter(([key]) => key.startsWith(prefix))); },
    async delete(keys) { for (const key of [].concat(keys)) data.delete(key); }
  };
}

const call = (path, body) => new Request(`https://outbox.internal${path}`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });

test('only fixed aggregate keys are counted', async () => {
  const box = storage();
  assert.equal(opsMetricKey('feature', 'housing'), 'feature:housing');
  assert.equal(opsMetricKey('feature', 'Kiel 24103'), null);
  assert.equal(opsMetricKey('feature', undefined), null);
  const outbox = { householdContextStorage:box };
  assert.equal((await handleOpsMetricsStorage(call(OPS_METRICS_PATH, { now:EVENING, key:'feature:housing' }), outbox)).status, 200);
  assert.equal((await handleOpsMetricsStorage(call(OPS_METRICS_PATH, { now:EVENING, key:'user:726209831' }), outbox)).status, 400);
  assert.equal((await handleOpsMetricsStorage(call(OPS_METRICS_PATH, { now:EVENING, key:'feature:housing' }), outbox)).status, 200);
  assert.deepEqual(box.data.get('ops-metrics:v1:2026-10-14'), { counts:{ 'feature:housing':2 } });
});

test('the report reads like a short status and flags problems', () => {
  const text = opsReportText({
    day:'2026-10-14',
    counts:{ 'feature:housing':12, 'feature:news':3, 'feature:menu':5, 'request:rejected':4, 'search:completed':1, 'search:timeout':2, 'retention:deleted':7 },
    newsCache:{ createdAt:EVENING - 60 * 60 * 1000, cardCount:4 },
    memoSize:21
  });
  assert.match(text, /^📊 Звіт бота за 14\.10\.2026/u);
  assert.match(text, /Запити: 20 · з помилкою: 4/u);
  assert.match(text, /Розділи: Житло 12 · Меню 5 · Новини 3/u);
  assert.match(text, /Пошук по району: завершено 1 · таймаут 2/u);
  assert.match(text, /Новини: останній огляд о 20:05, карток 4/u);
  assert.match(text, /Видалено прострочених записів: 7/u);
  assert.match(text, /⚠️ Помилок більше 10 %/u);
  assert.match(text, /⚠️ Пошук по району часто не завершується \(2 з 3\)/u);
  assert.doesNotMatch(text, /\d{6,}/u, 'no ids');
  assert.match(opsReportText({ day:'2026-10-14', counts:{ 'feature:menu':2 }, newsCache:{ createdAt:EVENING, cardCount:3 } }), /✅ Відхилень не виявлено/u);
});

test('the report goes out once after 21:00 Berlin, only when someone received it', async () => {
  const box = storage({
    'ops-metrics:v1:2026-10-14': { counts:{ 'feature:housing':3 } },
    'ops-metrics:v1:2026-09-30': { counts:{ 'feature:menu':1 } },
    'telegram-news-publication-cache:v1': { publication:{ createdAt:EVENING - 30 * 60 * 1000, cardCount:4 } }
  });
  const sent = [];
  const transport = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok:true, result:{ message_id:1 } })); };
  const config = { token:'123:abc' };
  const outbox = { householdContextStorage:box };

  assert.equal((await (await handleOpsMetricsStorage(call(OPS_REPORT_PATH, { now:MORNING }), outbox, { config, recipients:async () => [5], transport })).json()).status, 'not_yet');
  assert.equal((await (await handleOpsMetricsStorage(call(OPS_REPORT_PATH, { now:EVENING }), outbox, { config, recipients:async () => [], transport })).json()).status, 'not_sent');
  const first = await (await handleOpsMetricsStorage(call(OPS_REPORT_PATH, { now:EVENING }), outbox, { config, recipients:async () => [5, 5], transport })).json();
  assert.deepEqual(first, { status:'sent', sent:1 });
  assert.equal(sent[0].chat_id, 5);
  assert.match(sent[0].text, /Житло 3/u);
  assert.equal(box.data.has('ops-metrics:v1:2026-09-30'), false, 'counters older than 8 days are removed');
  const again = await (await handleOpsMetricsStorage(call(OPS_REPORT_PATH, { now:EVENING + 60 * 60 * 1000 }), outbox, { config, recipients:async () => [5], transport })).json();
  assert.equal(again.status, 'already_sent');
  assert.equal(sent.length, 1);
});

test('addOpsCount refuses free-form keys', async () => {
  const box = storage();
  assert.equal(await addOpsCount(box, EVENING, 'retention:deleted', 3), true);
  assert.equal(await addOpsCount(box, EVENING, 'Kiel:Gaarden 24143', 1), false);
  assert.deepEqual(box.data.get('ops-metrics:v1:2026-10-14').counts, { 'retention:deleted':3 });
});

test('housing sources are counted per portal and per company; a silent source is flagged', async () => {
  const { opsSourceKeys } = await import('../src/ops-metrics.mjs');
  const keys = opsSourceKeys([
    { source:'Kleinanzeigen API', status:'not_configured', pages:[] },
    // Skipped after an earlier account failure: no request was sent.
    { source:'Kleinanzeigen API', status:'insufficient_credits', notSent:true, pages:[{ reason:'account_failure_seen', httpStatus:0 }] },
    { source:'Kleinanzeigen public', status:'ok', pages:[{ httpStatus:200 }] },
    { source:'Ohne-Makler', status:'unavailable', pages:[{ httpStatus:403 }] },
    { source:'Housing companies', status:'ok', pages:[{ step:'wankendorfer', httpStatus:200 }, { step:'trave', httpStatus:0 }] },
    { source:'WG-Gesucht', status:'ok', pages:[{ step:'city', httpStatus:200 }, { step:'list', httpStatus:200 }] },
    { source:'primary-merge', status:'ok', pages:[] }
  ]);
  assert.deepEqual(keys, ['src_ok:kleinanzeigen_public', 'src_fail:ohne_makler', 'src_ok:wankendorfer', 'src_fail:trave', 'src_ok:wg_gesucht']);
  const text = opsReportText({ day:'2026-10-14', counts:{ 'feature:housing':5, 'src_ok:wankendorfer':4, 'src_fail:trave':4, 'src_ok:wg_gesucht':2, 'src_fail:wg_gesucht':1 }, newsCache:{ createdAt:EVENING, cardCount:3 } });
  assert.match(text, /Джерела житла \(відповіли\/збої\): TRAVE 0\/4 ⚠️ · Wankendorfer 4\/0 · WG-Gesucht 2\/1/u);
  assert.match(text, /⚠️ Джерело TRAVE не відповідає \(4 спроби\)/u);
});

test('several counters arrive in one call', async () => {
  const box = storage();
  const outbox = { householdContextStorage:box };
  const response = await handleOpsMetricsStorage(call(OPS_METRICS_PATH, { now:EVENING, keys:['src_ok:wankendorfer', 'src_fail:trave'] }), outbox);
  assert.equal(response.status, 200);
  assert.deepEqual(box.data.get('ops-metrics:v1:2026-10-14').counts, { 'src_ok:wankendorfer':1, 'src_fail:trave':1 });
  assert.equal((await handleOpsMetricsStorage(call(OPS_METRICS_PATH, { now:EVENING, keys:['src_ok:x', 'Kiel 24103'] }), outbox)).status, 400);
});
