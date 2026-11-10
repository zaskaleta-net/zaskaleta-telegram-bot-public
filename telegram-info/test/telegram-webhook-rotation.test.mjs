// TG-RELEASE-118: the guarded webhook-secret rotation must keep every update
// type the Worker needs. The rotation script embedded in the workflow is run
// here against a mocked fetch only; no Telegram or Cloudflare call is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflowPath = new URL('../../.github/workflows/telegram-webhook-secret-rotate.yml', import.meta.url);
const workflow = readFileSync(workflowPath, 'utf8');
const REQUIRED_UPDATES = ['message', 'callback_query', 'chat_join_request'];
const WEBHOOK_URL = 'https://bot.zaskaleta.net/telegram/stateless';
const token = '123456789:' + 'A'.repeat(35);
const secret = 'B'.repeat(48);

function rotationScript() {
  const step = workflow.indexOf('- name: Rotate Telegram webhook secret and verify');
  assert.ok(step > 0, 'rotation step is present');
  const open = "node --input-type=module <<'NODE'\n";
  const start = workflow.indexOf(open, step);
  assert.ok(start > step, 'rotation step runs an inline Node module');
  const end = workflow.indexOf('\n          NODE', start + open.length);
  assert.ok(end > start, 'inline Node module is terminated');
  const body = workflow.slice(start + open.length, end).split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  const importLine = "import assert from 'node:assert/strict';";
  assert.ok(body.includes(importLine));
  return body.replace(importLine, '');
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function runRotation({ reportedUpdates = null, failSetAttempts = 0, unauthStatus = 401 } = {}) {
  const calls = [];
  const logs = [];
  let allowed = [];
  let setAttempts = 0;
  const fetchImpl = async (url, options = {}) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal, 'every request is time-bounded');
    const method = url.startsWith('https://api.telegram.org/') ? url.split('/').pop() : 'probe';
    calls.push({ method, url, options, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'setWebhook') {
      setAttempts += 1;
      if (setAttempts <= failSetAttempts) return json({ ok: false }, 500);
      allowed = calls.at(-1).body.allowed_updates;
      return json({ ok: true, result: true });
    }
    if (method === 'getWebhookInfo') {
      return json({ ok: true, result: { url: WEBHOOK_URL, max_connections: 1, pending_update_count: 2, allowed_updates: reportedUpdates || allowed } });
    }
    if (method === 'probe') {
      const authenticated = options.headers?.['x-telegram-bot-api-secret-token'] === secret;
      return authenticated ? json({ ok: true }) : json({ error: 'Unauthorized' }, unauthStatus);
    }
    throw new Error('Unexpected request');
  };
  const fakeProcess = { env: { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, WEBHOOK_URL } };
  const fakeConsole = { log: line => logs.push(String(line)) };
  const fastTimeout = (fn) => setTimeout(fn, 0);
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const script = new AsyncFunction('assert', 'fetch', 'process', 'console', 'setTimeout', rotationScript());
  let error = null;
  try { await script(assert, fetchImpl, fakeProcess, fakeConsole, fastTimeout); } catch (caught) { error = caught; }
  return { calls, logs, error };
}

test('TG-RELEASE-118 rotation setWebhook subscribes message, callback_query and chat_join_request', async () => {
  const { calls, logs, error } = await runRotation();
  assert.equal(error, null);
  const writes = calls.filter(c => c.method === 'setWebhook');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, {
    url: WEBHOOK_URL,
    secret_token: secret,
    allowed_updates: REQUIRED_UPDATES,
    max_connections: 1,
    drop_pending_updates: false
  });
  assert.deepEqual(calls.map(c => c.method), ['setWebhook', 'getWebhookInfo', 'probe', 'probe']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^TELEGRAM_WEBHOOK_ROTATION_OK /);
  assert.ok(!logs[0].includes(token) && !logs[0].includes(secret));
});

test('TG-RELEASE-118 rotation fails closed when Telegram does not confirm every required update type', async () => {
  for (const reportedUpdates of [['message', 'callback_query'], ['message', 'chat_join_request'], ['callback_query', 'chat_join_request']]) {
    const { calls, logs, error } = await runRotation({ reportedUpdates });
    assert.ok(error, 'verification must reject ' + reportedUpdates.join(','));
    assert.equal(logs.length, 0);
    assert.equal(calls.some(c => c.method === 'probe'), false);
  }
});

test('TG-RELEASE-118 rotation keeps bounded retries, wrong-secret fail-closed probe and the reviewed destination', async () => {
  const retried = await runRotation({ failSetAttempts: 2 });
  assert.equal(retried.error, null);
  const writes = retried.calls.filter(c => c.method === 'setWebhook');
  assert.equal(writes.length, 3);
  for (const write of writes) {
    assert.deepEqual(write.body.allowed_updates, REQUIRED_UPDATES);
    assert.equal(write.body.drop_pending_updates, false);
    assert.equal(write.body.max_connections, 1);
    assert.equal(write.body.url, WEBHOOK_URL);
  }

  const exhausted = await runRotation({ failSetAttempts: 5 });
  assert.ok(exhausted.error);
  assert.equal(exhausted.calls.filter(c => c.method === 'setWebhook').length, 5);
  assert.equal(exhausted.calls.some(c => c.method === 'getWebhookInfo'), false);

  const open = await runRotation({ unauthStatus: 200 });
  assert.ok(open.error, 'a webhook that accepts a wrong secret must fail the rotation');
  assert.equal(open.logs.length, 0);
  const probe = open.calls.find(c => c.method === 'probe');
  assert.equal(probe.url, WEBHOOK_URL);
  assert.equal(probe.options.headers['x-telegram-bot-api-secret-token'], 'invalid-rotation-probe-secret');
});

test('TG-RELEASE-118 workflow keeps its reviewed safeguards and has no narrower allowed_updates list', () => {
  assert.match(workflow, /^ {2}WEBHOOK_URL: https:\/\/bot\.zaskaleta\.net\/telegram\/stateless$/m);
  assert.match(workflow, /^ {2}EXPECTED_TELEGRAM_INFO_TREE: [0-9a-f]{40}$/m);
  assert.match(workflow, /test "\$\(git rev-parse HEAD:telegram-info\)" = "\$EXPECTED_TELEGRAM_INFO_TREE"/);
  assert.match(workflow, /inputs\.approval == 'ROTATE-TELEGRAM-WEBHOOK-SECRET'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  const lists = [...workflow.matchAll(/allowed_updates:\s*\[([^\]]*)\]/g)].map(match => match[1].split(',').map(value => value.trim().replace(/^'|'$/g, '')));
  assert.ok(lists.length >= 1);
  for (const list of lists) assert.deepEqual(list, REQUIRED_UPDATES);
  assert.doesNotMatch(workflow, /drop_pending_updates:\s*true/);
  assert.doesNotMatch(workflow, /deleteWebhook/);
});

// TG-RELEASE-121: the reviewed-tree guard. The exact guard lines of every
// guarded workflow are run in bash with a stub `git`, so the test proves that
// a different telegram-info tree or a non-main ref is rejected and only the
// pinned tree on main is accepted. No network, no Cloudflare, no Telegram.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PIN = /EXPECTED_TELEGRAM_INFO_TREE:\s*([0-9a-f]{40})\b/gu;
const REF_LINE = 'test "${GITHUB_REF}" = "refs/heads/main"';
const TREE_LINE = 'test "$(git rev-parse HEAD:telegram-info)" = "$EXPECTED_TELEGRAM_INFO_TREE"';
// The four guarded workflows (TG-RELEASE-121 amended contract), and how many
// guarded jobs each has.
const PINNED = { 'telegram-staging-deploy.yml':1, 'telegram-webhook-migrate.yml':1, 'telegram-webhook-secret-rotate.yml':4, 'telegram-live-verify.yml':1 };

function guarded(name) {
  const text = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
  const pins = [...text.matchAll(PIN)].map(match => match[1]);
  const guards = text.split('\n').map((line, index, lines) => line.trim() === TREE_LINE ? lines[index - 1].trim() : null).filter(line => line !== null);
  return { pins, guards };
}

function runGuard(expected, actualTree, ref = 'refs/heads/main') {
  const dir = mkdtempSync(join(tmpdir(), 'tree-guard-'));
  try {
    const git = join(dir, 'git');
    writeFileSync(git, `#!/usr/bin/env bash\n[ "$1 $2" = "rev-parse HEAD:telegram-info" ] || exit 64\necho "${actualTree}"\n`);
    chmodSync(git, 0o755);
    const script = `set -euo pipefail\n${REF_LINE}\n${TREE_LINE}\n`;
    return spawnSync('bash', ['-c', script], { env:{ PATH:`${dir}:/usr/bin:/bin`, GITHUB_REF:ref, EXPECTED_TELEGRAM_INFO_TREE:expected } }).status;
  } finally {
    rmSync(dir, { recursive:true, force:true });
  }
}

test('TG-RELEASE-121 every guarded job keeps the main-ref and reviewed-tree checks', () => {
  for (const [name, jobs] of Object.entries(PINNED)) {
    const { pins, guards } = guarded(name);
    assert.equal(guards.length, jobs, `${name}: one tree check per guarded job`);
    assert.ok(guards.every(line => line === REF_LINE), `${name}: the main-ref check directly precedes each tree check`);
    assert.ok(pins.length >= 1, `${name}: a pinned tree`);
  }
});

test('TG-RELEASE-121 all four guarded workflows carry one and the same reviewed tree', () => {
  const pins = new Set(Object.keys(PINNED).flatMap(name => guarded(name).pins));
  assert.equal(pins.size, 1, `one reviewed tree, got ${[...pins].join(', ')}`);
});

test('TG-RELEASE-121 the guard accepts only the pinned tree on main', () => {
  const [pin] = guarded('telegram-staging-deploy.yml').pins;
  const other = pin.replace(/^./u, c => (c === '0' ? '1' : '0'));
  assert.equal(runGuard(pin, pin), 0, 'the pinned tree on main is accepted');
  assert.notEqual(runGuard(pin, other), 0, 'a different tree is rejected');
  assert.notEqual(runGuard(pin, ''), 0, 'an empty tree is rejected');
  assert.notEqual(runGuard('', pin), 0, 'a missing pin is rejected');
  assert.notEqual(runGuard(pin, pin, 'refs/heads/agent/release-agent/x'), 0, 'a non-main ref is rejected');
});


// Security review #121 (F1): ways to defeat a guard that the line check alone
// does not see. Each guard step must stay a plain fail-closed step.
function guardSteps(text) {
  const lines = text.split('\n');
  const steps = [];
  lines.forEach((line, index) => {
    if (line.trim() !== TREE_LINE) return;
    let start = index;
    while (start > 0 && !/^\s*- name:/u.test(lines[start])) start -= 1;
    let end = index + 1;
    while (end < lines.length && !/^\s*- (?:name|uses):/u.test(lines[end]) && !/^\S/u.test(lines[end]) && !/^ {2}\S/u.test(lines[end])) end += 1;
    steps.push(lines.slice(start, end).join('\n'));
  });
  return steps;
}

test('TG-RELEASE-121 guard steps cannot be softened (continue-on-error, set +e, an expression as the pin)', () => {
  for (const name of Object.keys(PINNED)) {
    const text = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
    for (const step of guardSteps(text)) {
      assert.doesNotMatch(step, /continue-on-error/u, `${name}: a guard step never continues on error`);
      assert.doesNotMatch(step, /\bset\s+\+[a-z]*e/u, `${name}: errexit stays on in a guard step`);
      assert.match(step, /set -euo pipefail/u, `${name}: the guard step runs with set -euo pipefail`);
      // Security review #121 round 2: other ways to skip or neutralise a guard step.
      assert.doesNotMatch(step, /^\s*if:/mu, `${name}: a guard step has no step-level if`);
      assert.doesNotMatch(step, /\bset\s+\+o\b/u, `${name}: no set +o in a guard step`);
      assert.doesNotMatch(step, /\btrap\b/u, `${name}: no trap in a guard step`);
      assert.doesNotMatch(step, /(?:^|[\s;&|(])(?:export\s+)?(?:GITHUB_REF|EXPECTED_TELEGRAM_INFO_TREE)=/mu, `${name}: the guard does not reassign its inputs`);
      assert.doesNotMatch(step, /^\s*env:/mu, `${name}: the guard step does not override env`);
    }
    const definitions = text.split('\n').filter(line => /^\s*EXPECTED_TELEGRAM_INFO_TREE\s*:/u.test(line));
    assert.ok(definitions.length >= 1, `${name}: the pin is defined`);
    for (const line of definitions) assert.match(line, /^\s*EXPECTED_TELEGRAM_INFO_TREE:\s*[0-9a-f]{40}\s*$/u, `${name}: the pin is a literal 40-hex tree, never an expression`);
    assert.doesNotMatch(text, /^\s{4}continue-on-error:\s*true/mu, `${name}: no job continues on error`);
    for (const condition of text.split('\n').filter(line => /^\s{4}if:/u.test(line))) {
      assert.match(condition, /github\.ref == 'refs\/heads\/main'/u, `${name}: every job runs on main only`);
    }
  }
});
