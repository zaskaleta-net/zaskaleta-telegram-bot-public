import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statelessDirectReplyEnabled, withStatelessDirectReply } from '../src/pilot-security.mjs';

test('TG-CLEANUP-005 direct-reply ownership is an explicit marker, not a rewritten delivery flag', () => {
  const live = { TELEGRAM_DELIVERY_ENABLED:'true' };
  assert.equal(statelessDirectReplyEnabled(live), false);
  const routed = withStatelessDirectReply(live);
  assert.equal(statelessDirectReplyEnabled(routed), true);
  assert.equal(routed.TELEGRAM_DELIVERY_ENABLED, 'true', 'the real delivery configuration must stay untouched');
  assert.equal(statelessDirectReplyEnabled({ ...routed }), true, 'the marker survives env spreads');
  assert.equal(statelessDirectReplyEnabled({}), false);
  assert.equal(statelessDirectReplyEnabled({ TELEGRAM_DELIVERY_ENABLED:'false' }), true, 'standalone legacy stateless mode still works');
});

test('TG-CLEANUP-005 the live runtime no longer rewrites TELEGRAM_DELIVERY_ENABLED', () => {
  for (const file of ['runtime.mjs', 'worker-entry-pilot-v21.mjs']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /TELEGRAM_DELIVERY_ENABLED\s*:\s*'false'/u, file);
    assert.match(source, /withStatelessDirectReply\(env\)/u, file);
  }
});
