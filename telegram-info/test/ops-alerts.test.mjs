import test from 'node:test';
import assert from 'node:assert/strict';
import { opsAlertsFor, sendOpsAlert, handleOpsMetricsStorage, OPS_METRICS_PATH } from '../src/ops-metrics.mjs';

// 14.10.2026 12:00 Berlin, and 23:30 Berlin.
const NOON = Date.UTC(2026, 9, 14, 10, 0, 0);
const NIGHT = Date.UTC(2026, 9, 14, 21, 30, 0);
const config = { token:`123456789:${'A'.repeat(35)}` };
const recipients = async () => [111, 222];

function storage() {
  const data = new Map();
  return { data, async get(key) { return structuredClone(data.get(key)); }, async put(key, value) { data.set(key, structuredClone(value)); }, async list() { return new Map(); }, async delete() { return 0; } };
}
function telegram(sent) {
  return async (url, options) => { sent.push(JSON.parse(options.body)); return new Response('{"ok":true,"result":{"message_id":1}}', { status:200 }); };
}

test('alert rules: a silent source after 3 failures, 5 request errors, 3 failed district searches', () => {
  assert.deepEqual(opsAlertsFor({ 'src_fail:trave':2 }, ['src_fail:trave']), []);
  assert.deepEqual(opsAlertsFor({ 'src_fail:trave':3, 'src_ok:trave':1 }, ['src_fail:trave']), [], 'it answered today');
  const [source] = opsAlertsFor({ 'src_fail:trave':3 }, ['src_fail:trave']);
  assert.equal(source.id, 'src:trave');
  assert.match(source.text, /Джерело житла TRAVE не відповідає: 3 спроби сьогодні/u);
  assert.equal(opsAlertsFor({ 'request:exception':5 }, ['request:exception'])[0].id, 'request_exception');
  assert.equal(opsAlertsFor({ 'search:error':1, 'search:timeout':2 }, ['search:timeout'])[0].id, 'search');
  assert.deepEqual(opsAlertsFor({ 'search:completed':9 }, ['search:completed']), []);
});

test('an alert reaches every admin once a day, silently at night', async () => {
  const box = storage();
  const sent = [];
  const alert = { id:'src:trave', text:'⚠️ test' };
  assert.equal(await sendOpsAlert(box, NOON, alert, { config, recipients, transport:telegram(sent) }), 'sent');
  assert.deepEqual(sent.map(body => [body.chat_id, body.disable_notification]), [[111, false], [222, false]]);
  assert.match(sent[0].text, /^⚠️ test\n\n12:00 · 14\.10\.2026$/u);
  assert.equal(await sendOpsAlert(box, NOON + 60000, alert, { config, recipients, transport:telegram(sent) }), 'already_sent');
  assert.equal(sent.length, 2);
  const night = [];
  await sendOpsAlert(box, NIGHT, { id:'news', text:'⚠️ n' }, { config, recipients, transport:telegram(night) });
  assert.equal(night[0].disable_notification, true);
  assert.equal(await sendOpsAlert(storage(), NOON, alert, { config:null, recipients, transport:telegram([]) }), 'disabled');
});

test('the counter path sends the alert as the third failure arrives, and keeps the counts', async () => {
  const box = storage();
  const sent = [];
  const call = () => handleOpsMetricsStorage(new Request(`https://outbox.internal${OPS_METRICS_PATH}`, { method:'POST', body:JSON.stringify({ now:NOON, keys:['src_fail:vonovia'] }) }), { householdContextStorage:box }, { config, recipients, transport:telegram(sent) });
  await call(); await call();
  assert.equal(sent.length, 0);
  await call();
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Vonovia не відповідає/u);
  await call();
  assert.equal(sent.length, 2, 'once a day');
  const day = [...box.data.values()][0];
  assert.equal(day.counts['src_fail:vonovia'], 4);
  assert.deepEqual(day.alerts, ['src:vonovia']);
});
