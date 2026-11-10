import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateStableBaseline, verifyStableBaseline } from '../scripts/verify-stable-baseline.mjs';

const release = JSON.parse(await readFile(new URL('../STABLE_RELEASE.json', import.meta.url), 'utf8'));

function matchingWrangler(overrides = {}) {
  return {
    name:release.worker,
    main:release.entrypoint,
    ...overrides
  };
}

test('current repository stable baseline passes guard', () => {
  const result = verifyStableBaseline();
  assert.equal(result.baseline, release.baseline);
  assert.equal(result.entrypoint, release.entrypoint);
  assert.equal(result.worker, release.worker);
});

test('guard fails when wrangler entrypoint drifts from verified release', () => {
  const errors = validateStableBaseline({
    release,
    wrangler:matchingWrangler({ main:'src/worker-entry-pilot-v999.mjs' }),
    fileExists:() => true,
    root:'/tmp'
  });
  assert.ok(errors.some((value) => value.includes('must match verified entrypoint')));
});

test('guard fails when verified commit is not fully pinned', () => {
  const unpinned = {
    ...release,
    verified_commit:String(release.verified_commit || '').slice(0, 8)
  };
  const errors = validateStableBaseline({
    release:unpinned,
    wrangler:matchingWrangler(),
    fileExists:() => true,
    root:'/tmp'
  });
  assert.ok(errors.some((value) => value.includes('40-character verified_commit')));
});
