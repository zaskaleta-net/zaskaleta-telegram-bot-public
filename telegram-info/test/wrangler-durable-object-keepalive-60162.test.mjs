import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

test('60162 Durable Object detached tasks cannot rely on pre-2026-10-01 compatibility semantics', () => {
  const date = String(config.compatibility_date || '');
  const flags = Array.isArray(config.compatibility_flags) ? config.compatibility_flags : [];
  const nativeKeepalive = /^\d{4}-\d{2}-\d{2}$/u.test(date) && date >= '2026-10-01';
  assert.equal(
    nativeKeepalive || flags.includes('durable_object_io_tasks_prevent_eviction'),
    true,
    'whole-Kreis Durable Object background work requires compatibility_date >= 2026-10-01 or durable_object_io_tasks_prevent_eviction'
  );
});
