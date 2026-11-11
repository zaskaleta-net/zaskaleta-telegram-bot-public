import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUDIT = path.join(ROOT, 'telegram-info/scripts/telegram-forensic-audit.mjs');
const WORKFLOW = path.join(ROOT, '.github/workflows/telegram-staging-deploy.yml');
const REPAIR_FIXTURE = path.join(ROOT, 'telegram-info/test/fixtures/telegram-webhook-options-repair.yml');
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
const legacyMain = mode === 'legacy-main' || mode === 'legacy-main-wrong-blob';
const legacyBaseline = {version:1,repository:'zaskaleta-net/zaskaleta-telegram-bot-public',telegramInfoTree:'c7e2d2b8a069a13f42ccc5cfbc1377f54358b5b4',guardedWorkflows:{
    ".github/workflows/telegram-staging-deploy.yml": "c44c1a53ba9bc2d0066510db01dc517ebe2cdea6",
    ".github/workflows/telegram-live-verify.yml": "f449c6d834fed8275e97c3bac730962b6e345fb3",
    ".github/workflows/telegram-webhook-migrate.yml": "42399516ad952de6cf25d42807e1ffda9099d03a",
    ".github/workflows/telegram-webhook-secret-rotate.yml": "21f0d15b76b06a7a736d614480b3a95473aaa275"
  }};
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
      emit(legacyMain ? (mode === 'legacy-main-wrong-blob' ? 'a'.repeat(40) : legacyBaseline.guardedWorkflows[candidate]) : publicRun ? baseline.guardedWorkflows[candidate] : 'a'.repeat(40));
    }
  }
}
if (args[0] === 'show'
    && (name.startsWith('refs/remotes/origin/main:') || name.startsWith('HEAD:'))) {
  const fromMain = name.startsWith('refs/remotes/origin/main:');
  if (fromMain && mode === 'missing-main') fail();
  const candidate = name.slice(fromMain ? 'refs/remotes/origin/main:'.length : 'HEAD:'.length);
  if (!fromMain && candidate === '.github/workflows/telegram-webhook-options-repair.yml') {
    if (mode === 'repair-missing-workflow') fail();
    let source = fs.readFileSync(path.join(repo,'telegram-info/test/fixtures/telegram-webhook-options-repair.yml'),'utf8');
    source = source.replace(/EXPECTED_TELEGRAM_INFO_TREE:\s*[0-9a-f]{40}/u,
      'EXPECTED_TELEGRAM_INFO_TREE: ' + pin);
    if (mode === 'repair-template-tamper') source = source.replace('drop_pending_updates: false', 'drop_pending_updates: true');
    if (mode === 'repair-template-approval') source = source.replace("inputs.approval == 'REPAIR-TELEGRAM-WEBHOOK-OPTIONS'", 'true');
    if (mode === 'repair-extra-pin') source += '\n      EXPECTED_TELEGRAM_INFO_TREE: ' + pin + '\n';
    if (mode === 'repair-stale-pin') source = source.replace(/EXPECTED_TELEGRAM_INFO_TREE:\s*[0-9a-f]{40}/u,
      'EXPECTED_TELEGRAM_INFO_TREE: ' + 'e'.repeat(40));
    process.stdout.write(source); process.exit(0);
  }
  if (candidate === 'ops/public-source-baseline.json' && publicRun) {
    if (mode === 'missing-baseline' || (fromMain && mode === 'missing-main-baseline')) fail();
    let raw = fromMain && legacyMain ? JSON.stringify(legacyBaseline) : fs.readFileSync(path.join(repo,candidate),'utf8');
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
  if (publicRun && !fromMain) {
    if (mode === 'template-command') source = source.replace('npm test', 'echo skipped');
    if (mode === 'template-permissions') source = source.replace('contents: read', 'contents: write');
    if (mode === 'template-repo') source = source.replace('zaskaleta-net/zaskaleta-telegram-bot-public', 'attacker/fork');
    if (mode === 'template-approval') source = source.replace("inputs.approval == 'DEPLOY-TELEGRAM-STAGING'", 'true');
    if (mode === 'template-extra-pin') source += '\n      EXPECTED_TELEGRAM_INFO_TREE: ' + pin + '\n';
    if (mode === 'template-rotator-repo' && candidate === paths[3]) source = source.replace("github.repository == 'zaskaleta-net/zaskaleta-telegram-bot-public'", "github.repository == 'attacker/fork'");
    if (mode === 'template-stale-pin') source = source.replace(/EXPECTED_TELEGRAM_INFO_TREE:\s*[0-9a-f]{40}/u, 'EXPECTED_TELEGRAM_INFO_TREE: ' + 'e'.repeat(40));
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
    if (options.migration) event.pull_request.base.sha = 'e9266851563462b7efc26161b6cc643ce7d67ab4';
  }
  options.mutateEvent?.(event);
  return runAudit({ ...options, event, headTree: options.headTree || publicPin(), mainTree: options.mainTree || publicPin(),
    env: { GITHUB_REPOSITORY: PUBLIC_REPO, GITHUB_EVENT_NAME: pr ? 'pull_request' : 'push',
      ...(options.bootstrap ? { FAKE_MAIN_SHA: 'd2dd4c57ffddf4a0ef5848dc0131ae524d91fa32' } : {}), ...(options.migration ? { FAKE_MAIN_SHA:'e9266851563462b7efc26161b6cc643ce7d67ab4' } : {}), ...options.env } });
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
test('public release transition no longer accepts old import without a baseline', () => {
  failClosed(publicAudit({kind:'pr',bootstrap:true,mainTree:'36b6fbbd87b71649dd4ff6536249350155135ed6',mode:'missing-main-baseline'}),'PUBLIC_SOURCE_BASELINE_INVALID');
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

function publicManual(options = {}) {
  const workflow = options.workflow || 'telegram-staging-deploy.yml';
  return publicAudit({
    ...options,
    mutateEvent:event => {
      delete event.after;
      event.ref = 'main';
      event.inputs = { approval:'DEPLOY-TELEGRAM-STAGING' };
      options.mutateEvent?.(event);
    },
    env:{ GITHUB_EVENT_NAME:'workflow_dispatch',
      GITHUB_WORKFLOW_REF:PUBLIC_REPO + '/.github/workflows/' + workflow + '@refs/heads/main',
      GITHUB_WORKFLOW_SHA:HEAD, ...options.env }
  });
}
test('public reviewed manual staging dispatch validates protected release context', () => {
  const run = publicManual(); pass(run);
  assert.match(run.stdout, /PUBLIC_PROTECTED_STAGING_MAIN/u);
});
test('public reviewed manual live verification validates separate non-deploy context', () => {
  const run = publicManual({workflow:'telegram-live-verify.yml',mutateEvent:e=>{delete e.inputs;}}); pass(run);
  assert.match(run.stdout, /PUBLIC_PROTECTED_LIVE_VERIFY_MAIN/u);
});
for (const [label,options] of Object.entries({
  wrongWorkflow:{workflow:'telegram-webhook-migrate.yml'},
  rotateWorkflow:{workflow:'telegram-webhook-secret-rotate.yml'},
  unknownWorkflow:{workflow:'unknown.yml'},
  wrongWorkflowSha:{env:{GITHUB_WORKFLOW_SHA:BASE}},
  wrongWorkflowRef:{env:{GITHUB_WORKFLOW_REF:PUBLIC_REPO+'/.github/workflows/telegram-staging-deploy.yml@refs/heads/agent/release-agent/x'}},
  missingApproval:{mutateEvent:e=>{delete e.inputs;}},
  wrongApproval:{mutateEvent:e=>{e.inputs.approval='DEPLOY';}},
  eventRef:{mutateEvent:e=>{e.ref='other';}},
  eventTag:{mutateEvent:e=>{e.ref='refs/tags/main';}},
  prRefs:{env:{GITHUB_HEAD_REF:BRANCH}},
  wrongRepo:{env:{GITHUB_REPOSITORY:'attacker/fork'}}
})) {
  test('public manual rejects ' + label,()=>failClosed(publicManual(options),'GUARDED_TREE_CONTEXT_INVALID'));
}

test('public migration accepts only exact reviewed source-only main and legacy blobs',()=>{
  const options={kind:'pr',migration:true,mode:'legacy-main',mainTree:'c7e2d2b8a069a13f42ccc5cfbc1377f54358b5b4'};
  pass(publicAudit(options));
  failClosed(publicAudit({...options,migration:false}),'PUBLIC_SOURCE_BASELINE_INVALID');
  failClosed(publicAudit({...options,mainTree:BASE}),'PUBLIC_SOURCE_BASELINE_INVALID');
  failClosed(publicAudit({...options,mode:'legacy-main-wrong-blob'}),'PUBLIC_SOURCE_BASELINE_INVALID');
});
for (const mode of ['template-command','template-permissions','template-repo','template-approval','template-extra-pin','template-rotator-repo','template-stale-pin']) {
  test('public immutable workflow rejects '+mode,()=>{
    failClosed(publicManual({mode}),'PUBLIC_SOURCE_BASELINE_INVALID');
  });
}

test('public manual accepts fully qualified main event ref with exact main runner ref',()=>{
  pass(publicManual({mutateEvent:e=>{e.ref='refs/heads/main';}}));
});

function rotationManual(options = {}) {
  return publicManual({...options,workflow:'telegram-webhook-secret-rotate.yml',mutateEvent:e=>{
    e.inputs={approval:'ROTATE-TELEGRAM-WEBHOOK-SECRET',expected_active_version:'ac5e41ae-c9ae-4926-af0f-557b53708b08'};
    options.mutateEvent?.(e);
  }});
}
test('public reviewed rotation requires its exact manual approval and version input',()=>{
  const run=rotationManual(); pass(run);
  assert.match(run.stdout,/PUBLIC_PROTECTED_WEBHOOK_ROTATION_MAIN/u);
});
for (const [label,options] of Object.entries({
  approval:{mutateEvent:e=>{e.inputs.approval='DEPLOY-TELEGRAM-STAGING';}},
  missingVersion:{mutateEvent:e=>{delete e.inputs.expected_active_version;}},
  malformedVersion:{mutateEvent:e=>{e.inputs.expected_active_version='not-a-version';}},
  staleWorkflow:{env:{GITHUB_WORKFLOW_SHA:BASE}},
  agentRef:{env:{GITHUB_REF:'refs/heads/'+BRANCH}},
  workflowPath:{env:{GITHUB_WORKFLOW_REF:PUBLIC_REPO+'/.github/workflows/other.yml@refs/heads/main'}}
})) test('public rotation rejects '+label,()=>failClosed(rotationManual(options),'GUARDED_TREE_CONTEXT_INVALID'));

function repairManual(options = {}) {
  return publicManual({workflow:'telegram-webhook-options-repair.yml',...options,mutateEvent:e=>{
    e.inputs={
      approval:'REPAIR-TELEGRAM-WEBHOOK-OPTIONS',
      secret_risk_acknowledgement:'I-ACCEPT-TELEGRAM-SECRET-MAY-CHANGE'
    };
    options.mutateEvent?.(e);
  }});
}
test('future repair fixture matches independently pinned reviewed SHA256',()=>{
  const source=fs.readFileSync(REPAIR_FIXTURE,'utf8');
  const pins=[...source.matchAll(/^[ \t]*EXPECTED_TELEGRAM_INFO_TREE:[ \t]*([0-9a-f]{40})[ \t]*$/gmu)];
  assert.equal(pins.length,1);
  const normalized=source.replace(/^([ \t]*EXPECTED_TELEGRAM_INFO_TREE:[ \t]*)[0-9a-f]{40}([ \t]*)$/mu,
    '$1<REVIEWED_TREE>$2');
  // The expected hash is deliberately a literal, not generated from fixture.
  assert.equal(createHash('sha256').update(normalized).digest('hex'),
    'c44b75fde7d77b4b214f4d5e30ca4b7c77ec266393045e0a27de6b9c028f0570');
});
test('future reviewed manual repair accepts exact context only',()=>{
  const run=repairManual();pass(run);
  assert.match(run.stdout,/PUBLIC_PROTECTED_WEBHOOK_OPTIONS_REPAIR_MAIN/u);
  assert.doesNotMatch(run.stdout,/"forensicContext":"PROTECTED_MAIN"/u);
});
for (const [label,options] of Object.entries({
  missingApproval:{mutateEvent:e=>{delete e.inputs.approval;}},
  wrongApproval:{mutateEvent:e=>{e.inputs.approval='DEPLOY-TELEGRAM-STAGING';}},
  missingSecretAcknowledgement:{mutateEvent:e=>{delete e.inputs.secret_risk_acknowledgement;}},
  wrongSecretAcknowledgement:{mutateEvent:e=>{e.inputs.secret_risk_acknowledgement='ACK';}},
  missingInputs:{mutateEvent:e=>{delete e.inputs;}},
  wrongWorkflowRef:{workflow:'telegram-webhook-secret-rotate.yml'},
  wrongWorkflowPath:{env:{GITHUB_WORKFLOW_REF:PUBLIC_REPO+'/.github/workflows/other.yml@refs/heads/main'}},
  wrongWorkflowBranch:{env:{GITHUB_WORKFLOW_REF:PUBLIC_REPO+'/.github/workflows/telegram-webhook-options-repair.yml@refs/heads/agent/release-agent/test'}},
  staleRunnerSha:{env:{GITHUB_WORKFLOW_SHA:BASE}},
  wrongRef:{env:{GITHUB_REF:'refs/heads/agent/release-agent/test'}},
  wrongEventRef:{mutateEvent:e=>{e.ref='refs/heads/other';}},
  wrongRepo:{env:{GITHUB_REPOSITORY:'attacker/fork'}},
  forgedEventRepo:{mutateEvent:e=>{e.repository.full_name='attacker/fork';}},
  missingCommit:{mode:'repair-missing-workflow'},
  tamperedTemplate:{mode:'repair-template-tamper'},
  weakenedTemplateApproval:{mode:'repair-template-approval'},
  extraPin:{mode:'repair-extra-pin'},
  staleTemplatePin:{mode:'repair-stale-pin'}
})) {
  test('future repair refuses '+label,()=>failClosed(repairManual(options),'GUARDED_TREE_CONTEXT_INVALID'));
}
