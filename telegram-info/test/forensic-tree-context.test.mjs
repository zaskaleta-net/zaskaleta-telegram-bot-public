import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUDIT = path.join(ROOT, 'telegram-info/scripts/telegram-forensic-audit.mjs');
const WORKFLOW = path.join(ROOT, '.github/workflows/telegram-staging-deploy.yml');
const PIN = /EXPECTED_TELEGRAM_INFO_TREE:\s*([0-9a-f]{40})/u.exec(fs.readFileSync(WORKFLOW, 'utf8'))?.[1];
assert.match(PIN, /^[0-9a-f]{40}$/u);

const REPO = 'zaskaleta-net/zaskaleta-telegram-bot';
const HEAD = 'f'.repeat(40);
const BASE = 'c'.repeat(40);
const PR_HEAD = 'd'.repeat(40);
const BRANCH = 'agent/release-agent/TG-RELEASE-137-forensic-source-ci';

const fakeGit = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const repo = process.env.FAKE_REPO_ROOT;
const pin = process.env.FAKE_PIN;
const mode = process.env.FAKE_MODE || '';
const name = args[args.length - 1] || '';
const paths = [
  '.github/workflows/telegram-staging-deploy.yml',
  '.github/workflows/telegram-live-verify.yml',
  '.github/workflows/telegram-webhook-migrate.yml',
  '.github/workflows/telegram-webhook-secret-rotate.yml'
];
function fail() { process.stderr.write('FAKE_GIT_REF_MISSING\n'); process.exit(65); }
function emit(value) { process.stdout.write(value + '\n'); process.exit(0); }
if (args[0] === 'rev-parse') {
  if (name === 'HEAD') emit(process.env.FAKE_HEAD_SHA || 'f'.repeat(40));
  if (name === 'HEAD:telegram-info') emit(process.env.FAKE_HEAD_TREE || pin);
  if (name === 'refs/remotes/origin/main:telegram-info') {
    if (mode === 'missing-main') fail();
    emit(process.env.FAKE_MAIN_TREE || pin);
  }
  if (name === 'refs/remotes/origin/main') {
    if (mode === 'missing-main') fail();
    emit('c'.repeat(40));
  }
  for (const candidate of paths) {
    if (name === 'HEAD:' + candidate) {
      emit(mode === 'changed-protected-file' && candidate === paths[0] ? 'b'.repeat(40) : 'a'.repeat(40));
    }
    if (name === 'refs/remotes/origin/main:' + candidate) {
      if (mode === 'missing-main') fail();
      emit('a'.repeat(40));
    }
  }
}
if (args[0] === 'show'
    && (name.startsWith('refs/remotes/origin/main:') || name.startsWith('HEAD:'))) {
  const fromMain = name.startsWith('refs/remotes/origin/main:');
  if (fromMain && mode === 'missing-main') fail();
  const candidate = name.slice(fromMain ? 'refs/remotes/origin/main:'.length : 'HEAD:'.length);
  if (!paths.includes(candidate)) fail();
  let source = fs.readFileSync(path.join(repo, candidate), 'utf8');
  if (fromMain && mode === 'divergent-pin' && candidate === paths[1]) {
    source = source.replace(/EXPECTED_TELEGRAM_INFO_TREE:\s*[0-9a-f]{40}/u,
      'EXPECTED_TELEGRAM_INFO_TREE: ' + 'e'.repeat(40));
  }
  if (fromMain && mode === 'missing-pin' && candidate === paths[1]) {
    source = source.replace(/EXPECTED_TELEGRAM_INFO_TREE:\s*[0-9a-f]{40}/u,
      'GUARDED_PIN_MISSING: ' + pin);
  }
  if (!fromMain && mode === 'uncommitted-workflow' && candidate === paths[0]) {
    source = source.replace(/^name:/mu, 'name: Modified committed');
  }
  process.stdout.write(source);
  process.exit(0);
}
fail();
`;

function makeEvent(baseRef = 'main', overrides = {}) {
  return {
    repository: { full_name: REPO },
    number: 137,
    pull_request: {
      number: 137,
      base: { ref: baseRef, sha: BASE, repo: { full_name: REPO } },
      head: { ref: BRANCH, sha: PR_HEAD, repo: { full_name: REPO } }
    },
    ...overrides
  };
}

function runAudit(options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-forensic-tree-'));
  try {
    const fake = path.join(tmp, 'git');
    fs.writeFileSync(fake, fakeGit, { mode: 0o755 });
    const eventFile = path.join(tmp, 'event.json');
    fs.writeFileSync(eventFile, JSON.stringify(options.event || makeEvent()));
    const mode = options.mode || '';
    const env = {
      ...process.env,
      PATH: tmp + path.delimiter + process.env.PATH,
      FAKE_REPO_ROOT: ROOT,
      FAKE_PIN: PIN,
      FAKE_MODE: mode,
      FAKE_HEAD_SHA: HEAD,
      FAKE_HEAD_TREE: options.headTree || (options.kind === 'pr' ? PR_HEAD : PIN),
      FAKE_MAIN_TREE: options.mainTree || PIN,
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: REPO,
      GITHUB_EVENT_NAME: options.kind === 'pr' ? 'pull_request' : 'workflow_dispatch',
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_REF: options.kind === 'pr' ? 'refs/pull/137/merge' : 'refs/heads/main',
      GITHUB_BASE_REF: options.kind === 'pr' ? (options.baseRef || 'main') : '',
      GITHUB_HEAD_REF: options.kind === 'pr' ? BRANCH : '',
      GITHUB_SHA: HEAD,
      ...options.env
    };
    const run = spawnSync(process.execPath, [AUDIT], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 30000
    });
    assert.equal(run.error, undefined, String(run.error));
    assert.match(run.stdout, /TELEGRAM_FORENSIC_AUDIT_BEGIN/u, run.stderr);
    return run;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function pass(run) {
  assert.equal(run.status, 0, run.stdout + '\n' + run.stderr);
  assert.doesNotMatch(run.stdout, /^P0 /mu);
}

function failClosed(run, code) {
  assert.equal(run.status, 2, run.stdout + '\n' + run.stderr);
  assert.match(run.stdout, new RegExp('^P0 ' + code, 'mu'), run.stdout);
}

test('approved main workflow_dispatch tree remains valid with shallow checkout', () => {
  pass(runAudit());
});

test('approved main push tree remains valid', () => {
  pass(runAudit({ env: { GITHUB_EVENT_NAME: 'push' } }));
});

test('main rejects an unapproved checked-out Telegram tree', () => {
  failClosed(runAudit({ headTree: 'e'.repeat(40) }), 'GUARDED_TREE_STALE');
});

test('verified source PR accepts changed HEAD tree with trusted pinned main', () => {
  pass(runAudit({ kind: 'pr' }));
});

test('verified stacked PR accepts an agent base branch with unchanged protected main', () => {
  const baseRef = 'agent/runtime-agent/TG-RUNTIME-132-delivery-regressions';
  pass(runAudit({ kind: 'pr', baseRef, event: makeEvent(baseRef) }));
});

test('source PR fails when trusted main tree differs from guarded pins', () => {
  failClosed(runAudit({ kind: 'pr', mainTree: 'e'.repeat(40) }), 'GUARDED_MAIN_TREE_STALE');
});

test('source PR fails on divergent pin among four protected workflows', () => {
  failClosed(runAudit({ kind: 'pr', mode: 'divergent-pin' }), 'GUARDED_WORKFLOW_PIN_MISMATCH');
});

test('source PR fails when a protected workflow is missing a pin', () => {
  failClosed(runAudit({ kind: 'pr', mode: 'missing-pin' }), 'GUARDED_WORKFLOW_PIN_MISSING');
});

test('main rejects protected workflow worktree differing from committed HEAD', () => {
  failClosed(runAudit({ mode: 'uncommitted-workflow' }), 'GUARDED_WORKFLOW_CHECKOUT_MODIFIED');
});

test('source PR fails when PR modifies a protected workflow file', () => {
  failClosed(runAudit({ kind: 'pr', mode: 'changed-protected-file' }), 'GUARDED_WORKFLOW_MODIFIED');
});

test('source PR fails if trusted main ref is not available, even with env SHA fallback', () => {
  failClosed(runAudit({
    kind: 'pr',
    mode: 'missing-main',
    env: { TELEGRAM_QA_TELEGRAM_INFO_TREE: PIN, TELEGRAM_QA_HEAD_SHA: HEAD }
  }), 'GUARDED_MAIN_TREE_UNAVAILABLE');
});

test('manual workflow dispatch on agent branch cannot impersonate source PR', () => {
  failClosed(runAudit({
    env: { GITHUB_REF: 'refs/heads/agent/runtime-agent/example' },
    headTree: 'e'.repeat(40)
  }), 'GUARDED_TREE_CONTEXT_INVALID');
});

test('source PR refuses mismatched refs/pull number', () => {
  failClosed(runAudit({
    kind: 'pr',
    env: { GITHUB_REF: 'refs/pull/999/merge' }
  }), 'GUARDED_TREE_CONTEXT_INVALID');
});

test('source PR refuses forged repository identity', () => {
  failClosed(runAudit({
    kind: 'pr',
    env: { GITHUB_REPOSITORY: 'attacker/fork' }
  }), 'GUARDED_TREE_CONTEXT_INVALID');
});

test('source PR refuses missing GitHub Actions runner trust marker', () => {
  failClosed(runAudit({ kind: 'pr', env: { GITHUB_ACTIONS: 'false' } }), 'GUARDED_TREE_CONTEXT_INVALID');
});

test('source PR refuses unsupported pull_request_target event', () => {
  failClosed(runAudit({ kind: 'pr', env: { GITHUB_EVENT_NAME: 'pull_request_target' } }), 'GUARDED_TREE_CONTEXT_INVALID');
});

test('source PR refuses an event with conflicting PR number', () => {
  failClosed(runAudit({
    kind: 'pr', event: makeEvent('main', { number: 999 })
  }), 'GUARDED_TREE_CONTEXT_INVALID');
});
