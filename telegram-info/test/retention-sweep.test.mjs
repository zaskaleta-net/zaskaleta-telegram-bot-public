import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepExpiredState, handleRetentionSweepStorage, RETENTION_SWEEP_PATH, RETENTION_RULES } from '../src/retention-sweep.mjs';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60 * 1000;

function storage(initial) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async list({ prefix }) { return new Map([...data].filter(([key]) => key.startsWith(prefix))); },
    async delete(keys) { for (const key of [].concat(keys)) data.delete(key); }
  };
}

test('expired per-user state is deleted, live state and unrelated keys stay', async () => {
  const box = storage({
    'telegram-household-context:v1:1:1': { persons:3, updatedAt:NOW - 121 * MIN },
    'telegram-household-context:v1:2:2': { persons:2, updatedAt:NOW - 30 * MIN },
    'telegram-private-prompt:v1:1:1': { prompt:'x', updatedAt:NOW - 16 * MIN },
    'telegram-private-prompt:v1:2:2': { prompt:'x', updatedAt:NOW - 5 * MIN },
    'housing-cost-active:v14:1': { prompt:'x', updatedAt:NOW - 20 * MIN },
    'telegram-housing-cost-pending:v1:1:1': { amount:500, updatedAt:NOW - 20 * MIN },
    'telegram-report-pending:v1:1:1': { updatedAt:NOW - 20 * MIN },
    'telegram-jobcenter-search-state:v1:1:1': { signature:'Kiel|Kiel|4|3-4', seen:['a'], updatedAt:NOW - 61 * MIN },
    'telegram-jobcenter-search-state:v1:2:2': { signature:'Kiel|Kiel|4|3-4', seen:['a'], updatedAt:NOW - 10 * MIN },
    'telegram-jobcenter-district-inflight:v1:1:1': { token:'t', expiresAt:NOW - 1 },
    'telegram-update:v1:100': { state:'done', expiresAt:NOW - 1 },
    'telegram-update:v1:101': { state:'done', expiresAt:NOW + 10 * MIN },
    'telegram-keyboard-reset:v6:1:1': { phase:'complete', updatedAt:NOW - 181 * 24 * 60 * MIN },
    'telegram-keyboard-reset:v6:2:2': { phase:'complete', updatedAt:NOW - 10 * 24 * 60 * MIN },
    'telegram-household-context:v1:3:3': { persons:2 },
    'telegram-news-publication-cache:v1': { createdAt:0 },
    'kdu-source-monitor:state:v1': { day:'2026-01-01' }
  });
  const result = await sweepExpiredState(box, NOW);
  assert.equal(result.total, 10);
  assert.deepEqual([...box.data.keys()].sort(), [
    'kdu-source-monitor:state:v1',
    'telegram-household-context:v1:2:2',
    'telegram-jobcenter-search-state:v1:2:2',
    'telegram-keyboard-reset:v6:2:2',
    'telegram-news-publication-cache:v1',
    'telegram-private-prompt:v1:2:2',
    'telegram-update:v1:101'
  ]);
});

test('every rule has either an age or an expiry field', () => {
  for (const rule of RETENTION_RULES) assert.ok(rule.expiresField || rule.maxAgeMs > 0, rule.prefix);
});

test('the Durable Object endpoint runs the sweep only for its own internal path', async () => {
  const box = storage({ 'telegram-report-pending:v1:1:1': { updatedAt:NOW - 20 * MIN } });
  const outbox = { householdContextStorage:box };
  const request = body => new Request(`https://outbox.internal${RETENTION_SWEEP_PATH}`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
  const ok = await handleRetentionSweepStorage(request({ now:NOW }), outbox);
  assert.deepEqual(await ok.json(), { status:'ok', total:1 });
  assert.equal(box.data.size, 0);
  assert.equal((await handleRetentionSweepStorage(request({ now:'x' }), outbox)).status, 400);
  assert.equal(await handleRetentionSweepStorage(new Request('https://outbox.internal/other', { method:'POST', body:'{}' }), outbox), null);
});
