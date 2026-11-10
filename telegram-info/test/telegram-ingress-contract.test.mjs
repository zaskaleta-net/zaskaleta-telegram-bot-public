import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('v21 release tooling agrees on the canonical Telegram stateless ingress', async () => {
  const [runtime, entry, registration, verifier, liveVerify] = await Promise.all([
    read('../src/runtime.mjs'),
    read('../src/worker-entry-pilot-v21.mjs'),
    read('../scripts/register-webhook.mjs'),
    read('../scripts/verify-live-staging.mjs'),
    read('../../.github/workflows/telegram-live-verify.yml')
  ]);

  assert.match(runtime, /const STATELESS_PATH='\/telegram\/stateless'/u);
  assert.match(entry, /url\.pathname !== '\/telegram\/stateless'/u);
  assert.match(registration, /STAGING_WEBHOOK_PATH = '\/telegram\/stateless'/u);
  assert.match(verifier, /path: '\/telegram\/stateless'/u);
  assert.doesNotMatch(verifier, /path: '\/telegram\/webhook'/u);
  assert.match(liveVerify, /const WEBHOOK\s*=\s*STAGING\s*\+\s*'\/telegram\/stateless'/u);
  assert.doesNotMatch(liveVerify, /const WEBHOOK\s*=\s*STAGING\s*\+\s*'\/telegram\/webhook'/u);
});

test('TG-RELEASE-044 webhook host migration is manual, guarded and points every webhook check at bot.zaskaleta.net', async () => {
  const [migrate, liveVerify, rotate] = await Promise.all([
    read('../../.github/workflows/telegram-webhook-migrate.yml'),
    read('../../.github/workflows/telegram-live-verify.yml'),
    read('../../.github/workflows/telegram-webhook-secret-rotate.yml')
  ]);
  assert.match(migrate, /^on:\n  workflow_dispatch:\n/mu);
  assert.doesNotMatch(migrate, /^\s+(push|pull_request|schedule):/mu);
  assert.match(migrate, /github\.repository == 'zaskaleta-net\/zaskaleta-telegram-bot' && github\.ref == 'refs\/heads\/main'/u);
  assert.match(migrate, /environment: telegram-registration/u);
  assert.match(migrate, /test "\$\(git rev-parse HEAD:telegram-info\)" = "\$EXPECTED_TELEGRAM_INFO_TREE"/u);
  assert.match(migrate, /EXPECTED_TELEGRAM_INFO_TREE: [0-9a-f]{40}\n/u);
  assert.match(migrate, /group: telegram-webhook-secret-rotation\n\s+cancel-in-progress: false/u);
  assert.match(rotate, /group: telegram-webhook-secret-rotation/u);
  // The dispatch input reaches the shell only through an environment variable.
  const lines = migrate.split('\n');
  const runBodies = [];
  lines.forEach((line, index) => {
    const head = /^(\s*)run: \|$/u.exec(line);
    if (!head) return;
    const body = [];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() && next.search(/\S/u) <= head[1].length) break;
      body.push(next);
    }
    runBodies.push(body.join('\n'));
  });
  assert.equal(runBodies.length, 2);
  assert.ok(runBodies.every(body => !body.includes('${{')), 'no expression is interpolated into a shell script');
  assert.match(migrate, /APPROVAL_INPUT: \$\{\{ inputs\.approval \}\}/u);
  assert.match(liveVerify, /const STAGING = 'https:\/\/bot\.zaskaleta\.net';/u);
  assert.match(rotate, /WEBHOOK_URL: https:\/\/bot\.zaskaleta\.net\/telegram\/stateless\n/u);
  assert.doesNotMatch(liveVerify + rotate, /workers\.dev\/telegram\/stateless/u);
});
