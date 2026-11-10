import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kduMonitorSources,
  runKduSourceMonitor,
  normalizedSourceText,
  handleKduMonitorStorage,
  KDU_MONITOR_PATH
} from '../src/kdu-source-monitor.mjs';
import { SH_VERIFIED_KDU_MODULES } from '../src/jobcenter-registry-statewide.mjs';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 12, 7, 0, 0);
const html = body => new Response(`<html><body>${body}</body></html>`, { status:200, headers:{ 'content-type':'text/html; charset=utf-8' } });
const SOURCES = [
  { jurisdiction:'Stormarn', authority:'Jobcenter Stormarn', url:'https://jobcenter-stormarn.de/kdu.pdf' },
  { jurisdiction:'Kiel', authority:'Jobcenter Kiel', url:'https://www.jobcenter-kiel.de/geldleistungen/' }
];

test('every verified module and the pending Neumünster source is watched', () => {
  const sources = kduMonitorSources();
  const jurisdictions = new Set(sources.map(source => source.jurisdiction));
  for (const jurisdiction of Object.keys(SH_VERIFIED_KDU_MODULES)) assert.ok(jurisdictions.has(jurisdiction), jurisdiction);
  assert.ok(jurisdictions.has('Neumünster'));
  assert.ok(sources.every(source => source.url.startsWith('https://')));
  assert.equal(new Set(sources.map(source => source.url)).size, sources.length);
});

test('page tokens and scripts do not count as a change', () => {
  assert.equal(
    normalizedSourceText('<p>1 Person: 474,50 €</p><script>var token="a1"</script><!-- 10:01 -->'),
    normalizedSourceText('<p>1 Person:  474,50 €</p><script>var token="b2"</script><!-- 10:02 -->')
  );
});

test('first run is a silent baseline; a later difference, an outage and an overdue date alert once', async () => {
  let kiel = '1 Person: 474,50 €';
  let stormarnUp = true;
  const transport = async url => {
    if (String(url).includes('stormarn')) return stormarnUp ? new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]), { headers:{ 'content-type':'application/pdf' } }) : new Response('down', { status:503 });
    return html(kiel);
  };
  const first = await runKduSourceMonitor({ state:{}, now:T0, transport, sources:SOURCES });
  assert.equal(first.skipped, false);
  // Neumünster announced new limits from 01.10.2026 without a published table.
  assert.equal(first.alerts.length, 1);
  assert.ok(first.alerts[0].startsWith('⏰'));
  assert.match(first.alerts[0], /Neumünster.*01\.10\.2026/u);

  const sameDay = await runKduSourceMonitor({ state:first.state, now:T0 + 60 * 60 * 1000, transport, sources:SOURCES });
  assert.equal(sameDay.skipped, true);

  const quiet = await runKduSourceMonitor({ state:first.state, now:T0 + DAY, transport, sources:SOURCES });
  assert.deepEqual(quiet.alerts, [], 'unchanged sources and a repeat within 7 days stay quiet');

  kiel = '1 Person: 502,50 €';
  stormarnUp = false;
  const changed = await runKduSourceMonitor({ state:quiet.state, now:T0 + 2 * DAY, transport, sources:SOURCES });
  assert.equal(changed.alerts.length, 1);
  assert.match(changed.alerts[0], /^🔄 Jobcenter Kiel: офіційне джерело змінилося\.\nhttps:\/\/www\.jobcenter-kiel\.de\/geldleistungen\/$/u);

  const day4 = await runKduSourceMonitor({ state:changed.state, now:T0 + 3 * DAY, transport, sources:SOURCES });
  assert.deepEqual(day4.alerts, []);
  const day5 = await runKduSourceMonitor({ state:day4.state, now:T0 + 4 * DAY, transport, sources:SOURCES });
  assert.equal(day5.alerts.length, 1);
  assert.match(day5.alerts[0], /^⚠️ Jobcenter Stormarn: джерело недоступне 3 дні поспіль \(http_503\)/u);
  const day6 = await runKduSourceMonitor({ state:day5.state, now:T0 + 5 * DAY, transport, sources:SOURCES });
  assert.deepEqual(day6.alerts, [], 'an outage is reported once, not every day');
  const week = await runKduSourceMonitor({ state:day6.state, now:T0 + 7 * DAY, transport, sources:SOURCES });
  assert.ok(week.alerts.some(alert => alert.startsWith('⏰')), 'the overdue reminder repeats weekly');
});

function outbox() {
  const data = new Map();
  return { data, ctx:{ storage:{ async get(key) { return structuredClone(data.get(key)); }, async put(key, value) { data.set(key, structuredClone(value)); } } } };
}

function monitorRequest(now) {
  return new Request(`https://outbox.internal${KDU_MONITOR_PATH}`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ now }) });
}

test('the Durable Object run notifies the admins once per day and keeps state only when someone was told', async () => {
  const sent = [];
  const transport = async (url, options = {}) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      sent.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok:true, result:{ message_id:1 } }), { headers:{ 'content-type':'application/json' } });
    }
    return html('stable');
  };
  const config = { token:'123:abc' };

  const unheard = outbox();
  const silent = await handleKduMonitorStorage(monitorRequest(T0), unheard, { config, recipients:async () => [], transport });
  assert.equal((await silent.json()).sent, 0);
  assert.equal(unheard.data.size, 0, 'nobody was told, so the next cron run tries again');

  const box = outbox();
  const first = await (await handleKduMonitorStorage(monitorRequest(T0), box, { config, recipients:async () => [777, 777], transport })).json();
  assert.equal(first.status, 'ran');
  assert.equal(first.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, 777);
  assert.match(sent[0].text, /^🏛 Моніторинг лімітів Jobcenter \(KdU\) — 12\.10\.2026/u);
  assert.match(sent[0].text, /Ліміти в боті автоматично не змінюються/u);

  const again = await (await handleKduMonitorStorage(monitorRequest(T0 + 60 * 1000), box, { config, recipients:async () => [777], transport })).json();
  assert.equal(again.status, 'already_ran_today');
  assert.equal(sent.length, 1);

  assert.equal(await handleKduMonitorStorage(new Request('https://outbox.internal/other', { method:'POST', body:'{}' }), box, { config }), null);
});
