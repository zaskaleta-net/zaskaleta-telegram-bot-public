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
const publicRun = process.env.GITHUB_REPOSITORY === 'zaskaleta-net/zaskaleta-telegram-bot-public';
const baseline = publicRun ? JSON.parse(fs.readFileSync(path.join(repo,'ops/public-source-baseline.json'),'utf8')) : null;
if (args[0] === 'rev-list') {
  process.stdout.write((process.env.FAKE_PARENTS || 'f'.repeat(40) + ' ' + (process.env.FAKE_MAIN_SHA || 'c'.repeat(40)) + ' ' + 'd'.repeat(40)) + '\n');
  process.exit(0);
}
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
    emit(process.env.FAKE_MAIN_SHA || 'c'.repeat(40));
  }
  for (const candidate of paths) {
    if (name === 'HEAD:' + candidate) {
      emit(mode === 'changed-protected-file' && candidate === paths[0] ? 'b'.repeat(40) : (publicRun ? baseline.guardedWorkflows[candidate] : 'a'.repeat(40)));
    }
    if (name === 'refs/remotes/origin/main:' + candidate) {
      if (mode === 'missing-main') fail();
      emit(publicRun ? baseline.guardedWorkflows[candidate] : 'a'.repeat(40));
    }
  }
}
if (args[0] === 'show'
    && (name.startsWith('refs/remotes/origin/main:') || name.startsWith('HEAD:'))) {
  const fromMain = name.startsWith('refs/remotes/origin/main:');
  if (fromMain && mode === 'missing-main') fail();
  const candidate = name.slice(fromMain ? 'refs/remotes/origin/main:'.length : 'HEAD:'.length);
  if (candidate === 'ops/public-source-baseline.json' && publicRun) {
    if (mode === 'missing-baseline' || (fromMain && mode === 'missing-main-baseline')) fail();
    let raw = fs.readFileSync(path.join(repo,candidate),'utf8');
    if (mode === 'dirty-baseline' && !fromMain) raw += ' ';
    if (mode === 'invalid-baseline') raw = raw.replace(baseline.repository,'attacker/fork');
    process.stdout.write(raw); process.exit(0);
  }
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

const PUBLIC_REPO = REPO + '-public';
const publicPin = () => JSON.parse(fs.readFileSync(path.join(ROOT,'ops/public-source-baseline.json'),'utf8')).telegramInfoTree;
function publicAudit(options = {}) {
  const pr = options.kind === 'pr';
  const event = pr ? makeEvent() : { repository: { full_name: PUBLIC_REPO }, ref: 'refs/heads/main', after: HEAD };
  if (pr) {
    event.repository.full_name = PUBLIC_REPO;
    event.pull_request.base.repo.full_name = PUBLIC_REPO;
    event.pull_request.head.repo.full_name = PUBLIC_REPO;
    if (options.bootstrap) event.pull_request.base.sha = 'd2dd4c57ffddf4a0ef5848dc0131ae524d91fa32';
  }
  options.mutateEvent?.(event);
  return runAudit({ ...options, event, headTree: options.headTree || publicPin(), mainTree: options.mainTree || publicPin(),
    env: { GITHUB_REPOSITORY: PUBLIC_REPO, GITHUB_EVENT_NAME: pr ? 'pull_request' : 'push',
      ...(options.bootstrap ? { FAKE_MAIN_SHA: 'd2dd4c57ffddf4a0ef5848dc0131ae524d91fa32' } : {}), ...options.env } });
}
test('public main push validates source without release authority', () => {
  const run = publicAudit(); pass(run);
  assert.match(run.stdout, /PUBLIC_SOURCE_MAIN_READ_ONLY/u);
  assert.doesNotMatch(run.stdout, /"forensicContext":"PROTECTED_MAIN"/u);
});
test('public same-repository PR validates source', () => {
  const run = publicAudit({kind:'pr'}); pass(run);
  assert.match(run.stdout, /PUBLIC_SOURCE_PR_READ_ONLY/u);
});
test('public initial import bootstrap accepts only exact reviewed tree', () => {
  pass(publicAudit({kind:'pr',bootstrap:true,mainTree:'36b6fbbd87b71649dd4ff6536249350155135ed6',mode:'missing-main-baseline'}));
  failClosed(publicAudit({kind:'pr',bootstrap:true,mainTree:BASE}), 'PUBLIC_SOURCE_BASELINE_INVALID');
});
for (const mode of ['missing-baseline','dirty-baseline','invalid-baseline','changed-protected-file']) {
  test('public main rejects ' + mode, () => failClosed(publicAudit({mode}), 'PUBLIC_SOURCE_BASELINE_INVALID'));
}
for (const mode of ['missing-main-baseline','missing-main']) {
  test('public PR rejects ' + mode, () => {
    const run = publicAudit({kind:'pr',mode});
    failClosed(run, mode === 'missing-main' ? 'GUARDED_TREE_CONTEXT_INVALID' : 'PUBLIC_SOURCE_BASELINE_INVALID');
  });
}
test('public source rejects stale proposed or trusted source pins', () => {
  failClosed(publicAudit({headTree:BASE}), 'PUBLIC_SOURCE_BASELINE_INVALID');
  failClosed(publicAudit({kind:'pr',mainTree:BASE}), 'PUBLIC_SOURCE_BASELINE_INVALID');
});
for (const [label, env] of Object.entries({
  dispatch:{GITHUB_EVENT_NAME:'workflow_dispatch'}, target:{GITHUB_EVENT_NAME:'pull_request_target'},
  unknownRepo:{GITHUB_REPOSITORY:'attacker/fork'}, missingRunner:{GITHUB_ACTIONS:'false'},
  mismatchedSha:{GITHUB_SHA:BASE}, wrongRef:{GITHUB_REF:'refs/heads/other'},
  wrongParents:{FAKE_PARENTS:HEAD+' '+PR_HEAD+' '+BASE}, wrongNumber:{GITHUB_REF:'refs/pull/999/merge'},
  wrongBase:{GITHUB_BASE_REF:'other'}, wrongHead:{GITHUB_HEAD_REF:'other'}
})) {
  test('public PR rejects ' + label, () => failClosed(publicAudit({kind:'pr',env}), 'GUARDED_TREE_CONTEXT_INVALID'));
}
for (const [label, mutateEvent] of Object.entries({
  repo:e=>{e.repository.full_name='attacker/fork';},
  fork:e=>{e.pull_request.head.repo.full_name='attacker/fork';},
  baseRepo:e=>{e.pull_request.base.repo.full_name='attacker/fork';},
  baseSha:e=>{e.pull_request.base.sha=PR_HEAD;},
  headSha:e=>{e.pull_request.head.sha='bad';},
  number:e=>{e.pull_request.number=999;}
})) {
  test('public PR rejects event ' + label, () => failClosed(publicAudit({kind:'pr',mutateEvent}), 'GUARDED_TREE_CONTEXT_INVALID'));
}
test('public push rejects mismatched event ref and after SHA', () => {
  failClosed(publicAudit({mutateEvent:e=>{e.ref='refs/heads/other';}}), 'GUARDED_TREE_CONTEXT_INVALID');
  failClosed(publicAudit({mutateEvent:e=>{e.after=BASE;}}), 'GUARDED_TREE_CONTEXT_INVALID');
});
test('public source rejects dirty protected workflow', () => {
  failClosed(publicAudit({mode:'uncommitted-workflow'}), 'GUARDED_WORKFLOW_CHECKOUT_MODIFIED');
});
