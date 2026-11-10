import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';
import { decideSearchRate, releaseSearchRate, SEARCH_LEASE_MS, SEARCH_WINDOW_MS, SEARCH_MAX_IN_WINDOW, SEARCH_BUSY_TEXT, SEARCH_LIMIT_TEXT, SEARCH_RATE_PREFIX } from '../src/search-rate-limit.mjs';
import { forgetKeys } from '../src/forget-command.mjs';
import { RETENTION_RULES } from '../src/retention-sweep.mjs';
import { privacyPolicyHtml } from '../src/privacy-policy.mjs';

// TG-RUNTIME-069 (full analysis 23.10.2026): no per-user limit on housing
// searches; each may send 32 requests to portals that block IP ranges.

test('#069 one search at a time, at most 20 in 10 minutes, then free again', () => {
  const t = 1_000_000_000_000;
  const first = decideSearchRate(null, t, 'aaaaaaaa-1');
  assert.equal(first.allowed, true);
  assert.equal(decideSearchRate(first.record, t + 5000, 'bbbbbbbb-2').reason, 'busy', 'held while it runs');
  assert.equal(decideSearchRate(first.record, t + SEARCH_LEASE_MS, 'bbbbbbbb-2').allowed, true, 'the lease is only a backstop');
  assert.equal(releaseSearchRate(first.record, t + 1000, 'bbbbbbbb-2'), null, 'only the holder releases');
  const released = releaseSearchRate(first.record, t + 3000, 'aaaaaaaa-1');
  assert.deepEqual(released.starts, [t], 'a finished search still counts');
  assert.equal(decideSearchRate(released, t + 3000, 'bbbbbbbb-2').allowed, true, 'free as soon as it ends');
  assert.deepEqual(releaseSearchRate(first.record, t + 3000, 'aaaaaaaa-1', true).starts, [], 'a search that never ran is not counted');
  const full = { starts:Array.from({ length:SEARCH_MAX_IN_WINDOW }, (_, index) => t - 60_000 - index * 20_000), active:null };
  assert.equal(SEARCH_MAX_IN_WINDOW, 20);
  assert.equal(decideSearchRate(full, t, 'cccccccc-3').reason, 'limit');
  assert.equal(decideSearchRate({ starts:full.starts.map(time => time - SEARCH_WINDOW_MS) }, t, 'cccccccc-3').allowed, true, 'old starts no longer count');
  assert.equal(decideSearchRate({ starts:[t + 60_000] }, t, 'cccccccc-3').allowed, true, 'a start in the future is ignored');
  assert.equal(decideSearchRate({ starts:[], active:{ token:'x', until:t + 10 * SEARCH_LEASE_MS } }, t, 'cccccccc-3').allowed, true, 'an impossible lease is ignored');
});

const STAGING = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' };

test('#069 a second tap while the first search runs starts nothing; once it ends the next one runs', async () => {
  const f = await fixture(STAGING);
  const waits = [];
  const ctx = { waitUntil(promise) { waits.push(promise); } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.transport;
  const worker = (await import('../src/runtime.mjs')).default;
  try {
    const first = await worker.fetch(f.request('', { user:555555, callback:'jcr:15:4:3-4:Trittau' }), f.env, ctx);
    assert.equal((await first.json()).mode, 'telegram-jobcenter-search-background-accepted');
    // The first search is still in waitUntil: a radius tap and a page tap
    // (paging runs the search again) are both refused.
    for (const callback of ['jcr:20:4:3-4:Trittau', 'jrp:2:20']) {
      const before = f.calls.filter(call => call.method === 'sendMessage').length;
      const body = await (await worker.fetch(f.request('', { user:555555, callback }), f.env, ctx)).json();
      assert.equal(body.mode, 'telegram-search-rate-limited', callback);
      assert.equal(body.reason, 'busy');
      assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, before, 'no progress message, no search');
      const notice = f.calls.filter(call => call.method === 'answerCallbackQuery').at(-1);
      assert.equal(notice.body.text, SEARCH_BUSY_TEXT);
      assert.equal(notice.body.show_alert, true);
    }
    await Promise.allSettled(waits);
    const sourcesBefore = f.sourceCalls.length;
    const next = await worker.fetch(f.request('', { user:555555, callback:'jcr:20:4:3-4:Trittau' }), f.env, ctx);
    assert.equal((await next.json()).mode, 'telegram-jobcenter-search-background-accepted', 'the slot was released when the search ended');
    await Promise.allSettled(waits);
    assert.ok(f.sourceCalls.length > sourcesBefore, 'the next search ran');
  } finally {
    globalThis.fetch = realFetch;
    f.close();
  }
});

test('#069 a whole-Kreis search handed to the Durable Object does not block the next tap', async () => {
  const f = await fixture(STAGING);
  const waits = [];
  const ctx = { waitUntil(promise) { waits.push(promise); } };
  f.object.ctx.waitUntil = promise => { waits.push(promise); };
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.transport;
  const worker = (await import('../src/runtime.mjs')).default;
  try {
    const kreis = await (await worker.fetch(f.request('', { user:555555, callback:'jcd:4:3-4:Trittau' }), f.env, ctx)).json();
    assert.equal(kreis.mode, 'telegram-jobcenter-search-background-accepted');
    assert.ok(f.internal.includes('/jobcenter-background-task'), 'handed to the Durable Object');
    // Its own per-user lock keeps one whole-Kreis run at a time; the
    // user's slot is free right after the hand-off (not after a 90 s lease).
    const next = await (await worker.fetch(f.request('', { user:555555, callback:'jcr:20:4:3-4:Trittau' }), f.env, ctx)).json();
    assert.equal(next.mode, 'telegram-jobcenter-search-background-accepted');
    await Promise.allSettled(waits);
  } finally {
    globalThis.fetch = realFetch;
    f.close();
  }
});

test('#069 the plain search tells the user to wait while one runs, and searches again after it', async () => {
  const f = await fixture(STAGING);
  try {
    const text = '🔎 Trittau · 3-4 · 950 · K · 15km';
    // The portals answer only after the second message was handled, so the
    // first search is really still running.
    let open;
    const gate = new Promise(resolve => { open = resolve; });
    let reached;
    const atPortals = new Promise(resolve => { reached = resolve; });
    const held = (url, options) => {
      if (String(url).startsWith('https://api.telegram.org/')) return f.transport(url, options);
      reached();
      return gate.then(() => f.transport(url, options));
    };
    const first = handle(f.request(text, { user:555555 }), f.env, NOW, held);
    await atPortals;
    const portalsHeld = f.sourceCalls.length;
    await handle(f.request(text, { user:555555 }), f.env, NOW, f.transport);
    assert.equal(f.sourceCalls.length, portalsHeld, 'no portal request for the second search');
    open();
    await first;
    assert.ok(f.calls.some(call => String(call.body?.text || call.body?.caption || '').includes(SEARCH_BUSY_TEXT)), 'the second one waits');
    const before = f.sourceCalls.length;
    await handle(f.request(text, { user:555555 }), f.env, NOW, f.transport);
    assert.ok(f.sourceCalls.length > before, 'after the first one ended the next search runs');
    assert.ok(SEARCH_LIMIT_TEXT);
  } finally { f.close(); }
});

test('#069 the record is covered by /forget, the retention sweep and the privacy policy', () => {
  assert.ok(forgetKeys(555555, 555555).includes(`${SEARCH_RATE_PREFIX}555555:555555`));
  assert.ok(RETENTION_RULES.some(rule => rule.prefix === SEARCH_RATE_PREFIX && rule.expiresField === 'expiresAt'));
  const html = privacyPolicyHtml({ name:'A B', address:'Str. 1, 00000 Musterstadt', email:'a@example.org' });
  assert.match(html, /Zeitpunkte Ihrer letzten Wohnungssuchen[^<]*10 Minuten/u);
  assert.match(html, /Час ваших останніх пошуків житла[^<]*10 хвилин/u);
});
