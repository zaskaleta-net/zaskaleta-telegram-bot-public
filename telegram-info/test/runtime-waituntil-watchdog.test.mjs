import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BACKGROUND_JOBCENTER_WAITUNTIL_WATCHDOG_MS,
  BACKGROUND_JOBCENTER_FAILURE_NOTICE_TIMEOUT_MS
} from '../src/runtime.mjs';
import { JOBCENTER_SEARCH_TIMINGS } from '../src/runtime-jobcenter-base.mjs';
import { adCostsTimeLeft } from '../src/kleinanzeigen-ad-costs.mjs';

// Cloudflare Workers: ctx.waitUntil() extends execution for at most 30 seconds
// after the response is sent. A watchdog longer than that never fires: the
// runtime cancels the task first and the user keeps a dead "searching" message.
const WAIT_UNTIL_LIMIT_MS = 30000;

test('TG-RUNTIME-002 waitUntil watchdog and failure notice finish inside the 30s waitUntil window', () => {
  assert.ok(Number.isSafeInteger(BACKGROUND_JOBCENTER_WAITUNTIL_WATCHDOG_MS));
  assert.ok(Number.isSafeInteger(BACKGROUND_JOBCENTER_FAILURE_NOTICE_TIMEOUT_MS));
  assert.ok(
    BACKGROUND_JOBCENTER_WAITUNTIL_WATCHDOG_MS + BACKGROUND_JOBCENTER_FAILURE_NOTICE_TIMEOUT_MS <= WAIT_UNTIL_LIMIT_MS - 2000,
    'watchdog plus failure notice must leave at least 2s of headroom before Cloudflare cancels waitUntil'
  );
  // Inner local search (12s) plus media delivery (8s) must still fit.
  assert.ok(BACKGROUND_JOBCENTER_WAITUNTIL_WATCHDOG_MS >= 20000);
  // TG-RUNTIME-064: the Kleinanzeigen ad pages only use time left inside the
  // search window, so they add nothing to the sum.
  assert.ok(JOBCENTER_SEARCH_TIMINGS.search + JOBCENTER_SEARCH_TIMINGS.media <= BACKGROUND_JOBCENTER_WAITUNTIL_WATCHDOG_MS - 2000);
  assert.equal(adCostsTimeLeft(0, JOBCENTER_SEARCH_TIMINGS.search, JOBCENTER_SEARCH_TIMINGS.search), 0);
});

test('TG-RUNTIME-002 the waitUntil background path uses the bounded watchdog, not the Durable Object one', () => {
  const source = readFileSync(new URL('../src/runtime.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const taskController = new AbortController();');
  const end = source.indexOf('ctx.waitUntil(task);', start);
  assert.ok(start >= 0 && end > start, 'waitUntil background task block must be present');
  const block = source.slice(start, end);
  assert.match(block, /timeoutMs:\s*BACKGROUND_JOBCENTER_WAITUNTIL_WATCHDOG_MS/u);
});
