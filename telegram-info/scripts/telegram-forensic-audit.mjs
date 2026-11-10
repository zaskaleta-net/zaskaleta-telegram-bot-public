import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INFO = path.resolve(SCRIPT_DIR, '..');
const ROOT = path.resolve(INFO, '..');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes:true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function lineHits(content, re) {
  const hits = [];
  content.split(/\r?\n/u).forEach((line, index) => {
    re.lastIndex = 0;
    if (re.test(line)) hits.push({ line:index + 1, text:line.trim().slice(0, 260) });
  });
  return hits;
}

function resolveLocal(from, spec) {
  let target = path.resolve(path.dirname(from), spec);
  if (!path.extname(target)) target += '.mjs';
  return target;
}

const wranglerPath = path.join(INFO, 'wrangler.jsonc');
const wrangler = read(wranglerPath);
const mainMatch = /"main"\s*:\s*"([^"]+)"/u.exec(wrangler);
if (!mainMatch) throw new Error('wrangler main entrypoint not found');
const entrypoint = path.resolve(INFO, mainMatch[1]);

const importRe = /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+)['"](\.[^'"]+)['"]/gu;
const active = new Set();
const edges = [];
const queue = [entrypoint];

while (queue.length) {
  const file = queue.shift();
  if (active.has(file) || !fs.existsSync(file)) continue;
  active.add(file);
  const source = read(file);
  for (const match of source.matchAll(importRe)) {
    const target = resolveLocal(file, match[1]);
    edges.push({ from:rel(file), to:rel(target) });
    if (target.startsWith(path.join(INFO, 'src')) && fs.existsSync(target) && !active.has(target)) queue.push(target);
  }
}

const allSrc = walk(path.join(INFO, 'src')).filter(f => /\.mjs$/u.test(f));
const allTests = walk(path.join(INFO, 'test')).filter(f => /\.test\.mjs$/u.test(f));
const findings = [];

function add(severity, code, file, line, detail) {
  findings.push({ severity, code, file:rel(file), line, detail:String(detail || '').trim().slice(0, 300) });
}

for (const file of active) {
  const source = read(file);
  for (const hit of lineHits(source, /\bforce_reply\s*:\s*true\b/u)) add('P1','ACTIVE_FORCE_REPLY_PRODUCER',file,hit.line,hit.text);
  for (const hit of lineHits(source, /\bforceReply\s*:\s*true\b/u)) add('P1','ACTIVE_FORCE_REPLY_INTERNAL',file,hit.line,hit.text);
  for (const hit of lineHits(source, /\binput_field_placeholder\s*:/u)) add('P1','ACTIVE_INPUT_PLACEHOLDER_PRODUCER',file,hit.line,hit.text);
  for (const hit of lineHits(source, /\bremove_keyboard\s*:\s*true\b/u)) add('P1','ACTIVE_REMOVE_KEYBOARD',file,hit.line,hit.text);
  for (const hit of lineHits(source, /(^|[^_])\bkeyboard\s*:\s*\[/u)) add('P1','ACTIVE_REPLY_KEYBOARD_LITERAL',file,hit.line,hit.text);
}

const activeNames = new Set([...active].map(rel));
const legacyChain = [
  'telegram-info/src/worker-entry-beta.mjs',
  'telegram-info/src/worker-entry.mjs',
  'telegram-info/src/worker.mjs'
];
if (legacyChain.every(p => activeNames.has(p))) {
  add('P1','ACTIVE_LEGACY_FALLBACK_CHAIN',entrypoint,1,legacyChain.join(' -> '));
}

const runtimePath = path.join(INFO,'src','runtime.mjs');
const runtimeSource = read(runtimePath);
if (!/privatePrompt=privateChat\s*&&\s*payload\?\.reply_markup\?\.force_reply===true/u.test(runtimeSource)
    || !/rememberPrivatePrompt\(env,chatId,privatePrompt,now\)/u.test(runtimeSource)
    || !/preparePrivatePromptContext\(request,env,now\)/u.test(runtimeSource)) {
  add('P0','PRIVATE_FORCE_REPLY_BOUNDARY_MISSING',runtimePath,1,'consolidated runtime must virtualize private ForceReply into durable prompt state before delivery');
}
if (/async function route\(request,env,now,transport,rawTransport=transport\)/u.test(runtimeSource)
    || /handleNavigation\(request,env,now,rawTransport\)/u.test(runtimeSource)) {
  add('P0','PRIVATE_FORCE_REPLY_BOUNDARY_BYPASS',runtimePath,1,'private navigation/reset traffic must not bypass the consolidated outbound ForceReply suppression boundary');
}

const jobcenterRuntimePath = path.join(INFO,'src','runtime-jobcenter.mjs');
const jobcenterRuntimeSource = read(jobcenterRuntimePath);
if (!/JOBCENTER_SEARCH_STATE_PATH\s*=\s*'\/jobcenter-search-state'/u.test(jobcenterRuntimeSource)
    || !/filterUnseenDistrictListings\(rawListings, districtBaseline\)/u.test(jobcenterRuntimeSource)
    || !/districtNoNewMessage\(districtJurisdiction/u.test(jobcenterRuntimeSource)
    || !/handleJobcenterSearchStorage/u.test(runtimeSource)) {
  add('P0','STATEWIDE_DISTRICT_DEDUP_MISSING',jobcenterRuntimePath,1,'all Schleswig-Holstein Jobcenter/Kreis district searches must filter already-shown listings through durable per-user state and emit an explicit no-new result');
}

const keyboardPath = path.join(INFO,'src','runtime-keyboard.mjs');
const keyboardSource = read(keyboardPath);
if (!/telegram-keyboard-reset:v6:/u.test(keyboardSource)) {
  add('P0','ANDROID_KEYBOARD_MIGRATION_V6_MISSING',keyboardPath,1,'v6 migration namespace is required after retiring the failed ForceReply reset strategy');
}
if (/Оновлення режиму відповіді/u.test(keyboardSource) && /reply_markup:\{ force_reply:true \}/u.test(keyboardSource)) {
  add('P0','RESET_EMITS_FORCE_REPLY',keyboardPath,1,'migration/reset code must never emit ForceReply; stale client reply state is dismissed once on the affected client and cannot be cancelled by ReplyKeyboardRemove');
}

const compat = path.join(INFO,'src','runtime-compatibility.mjs');
if (active.has(compat)) {
  const source = read(compat);
  if (/markup\?\.remove_keyboard\s*===\s*true/u.test(source) && /return\s+telegramOk\(/u.test(source)) {
    const line = source.split(/\r?\n/u).findIndex(x => /markup\?\.remove_keyboard\s*===\s*true/u.test(x)) + 1;
    add('P1','REMOVE_KEYBOARD_SWALLOWED_COMPAT',compat,line,'compatibility helper synthesizes success for remove_keyboard; active consolidated runtime does not use this helper as its outbound transport');
  }
}

const contradictionPatterns = [
  /pending keyboard reset should retire both migration messages/iu,
  /clean start leaves a non-selective ForceReply/iu,
  /housing flow uses Telegram ForceReply/iu,
  /start exposes a topic keyboard/iu,
  /private reply keyboard remains persistent/iu,
  /legacy remove_keyboard cleanup is swallowed/iu
];

for (const file of allTests) {
  const source = read(file);
  const lines = source.split(/\r?\n/u);
  lines.forEach((line,index) => {
    if (contradictionPatterns.some(re => re.test(line))) add('P2','LEGACY_TEST_CONTRACT',file,index+1,line.trim());
    if (/assert\.(?:equal|deepEqual)\([^\n;]*(?:force_reply|forceReply)[^\n;]*true/iu.test(line)) {
      add('P2','TEST_EXPECTS_FORCE_REPLY_TRUE',file,index+1,line.trim());
    }
  });
}

const historical = allSrc.filter(f => /worker-entry-(?:pilot-v\d+|persistent-menu)/u.test(path.basename(f)));
if (historical.length) {
  add('P2','HISTORICAL_ENTRYPOINTS_PRESENT',historical[0],1,`${historical.length} historical worker entrypoint files remain in telegram-info/src`);
}

// The forensic gate has two strictly different trust contexts:
// 1. a reviewed main checkout used by guarded manual release/verification;
// 2. a read-only GitHub pull_request merge checkout used to validate proposed code.
// A source PR must never inherit release authorization from the approved main pin.
const REPO = 'zaskaleta-net/zaskaleta-telegram-bot';
const SHA40 = /^[0-9a-f]{40}$/u;
const GUARDED_WORKFLOWS = [
  '.github/workflows/telegram-staging-deploy.yml',
  '.github/workflows/telegram-live-verify.yml',
  '.github/workflows/telegram-webhook-migrate.yml',
  '.github/workflows/telegram-webhook-secret-rotate.yml'
];
const mainGuardedPath = path.join(ROOT, GUARDED_WORKFLOWS[0]);

// Public source validation never grants guarded release authority.
const PUBLIC_REPO = 'zaskaleta-net/zaskaleta-telegram-bot-public';
const PUBLIC_BASELINE = 'ops/public-source-baseline.json';
const PUBLIC_BOOTSTRAP = 'd2dd4c57ffddf4a0ef5848dc0131ae524d91fa32';
const PUBLIC_BOOTSTRAP_TREE = '36b6fbbd87b71649dd4ff6536249350155135ed6';
const PUBLIC_GUARDED_BLOBS = {
  ".github/workflows/telegram-staging-deploy.yml": "c44c1a53ba9bc2d0066510db01dc517ebe2cdea6",
  ".github/workflows/telegram-live-verify.yml": "f449c6d834fed8275e97c3bac730962b6e345fb3",
  ".github/workflows/telegram-webhook-migrate.yml": "42399516ad952de6cf25d42807e1ffda9099d03a",
  ".github/workflows/telegram-webhook-secret-rotate.yml": "21f0d15b76b06a7a736d614480b3a95473aaa275"
};


function gitTrusted(args) {
  const output = execFileSync('git', args, {
    cwd:ROOT, encoding:'utf8', stdio:['ignore','pipe','pipe']
  });
  // Git blobs are compared byte-for-byte; Git rev-parse outputs a line.
  return args[0] === 'show' ? output : output.trim();
}

function singlePin(content) {
  const pins = [...content.matchAll(/^[ \t]*EXPECTED_TELEGRAM_INFO_TREE:[ \t]*([0-9a-f]{40})[ \t]*$/gmu)];
  return pins.length === 1 ? pins[0][1] : null;
}

function sourcePrContext() {
  const ref = String(process.env.GITHUB_REF || '');
  const refMatch = /^refs\/pull\/([1-9][0-9]*)\/merge$/u.exec(ref);
  if (!refMatch || !process.env.GITHUB_EVENT_PATH) return false;
  try {
    const event = JSON.parse(read(process.env.GITHUB_EVENT_PATH));
    const pull = event?.pull_request;
    const base = pull?.base;
    const head = pull?.head;
    const number = Number(refMatch[1]);
    if (event?.repository?.full_name !== REPO
        || event?.number !== number
        || pull?.number !== number
        || base?.repo?.full_name !== REPO
        || head?.repo?.full_name !== REPO
        || base?.ref !== process.env.GITHUB_BASE_REF
        || head?.ref !== process.env.GITHUB_HEAD_REF
        || !SHA40.test(String(base?.sha || ''))
        || !SHA40.test(String(head?.sha || ''))
        || !(/^(?:main|agent\/[a-z-]+\/[A-Za-z0-9._/-]+)$/u.test(base.ref))
        || !(/^agent\/[a-z-]+\/[A-Za-z0-9._/-]+$/u.test(head.ref))) return false;
    return true;
  } catch {
    return false;
  }
}


function publicSourceContext() {
  if (process.env.GITHUB_ACTIONS !== 'true'
      || process.env.GITHUB_REPOSITORY !== PUBLIC_REPO
      || !SHA40.test(String(process.env.GITHUB_SHA || ''))
      || process.env.GITHUB_SHA !== headSha) return 'INVALID';
  try {
    const event = JSON.parse(read(process.env.GITHUB_EVENT_PATH));
    if (event?.repository?.full_name !== PUBLIC_REPO) return 'INVALID';
    if (process.env.GITHUB_EVENT_NAME === 'push'
        && process.env.GITHUB_REF === 'refs/heads/main'
        && event.ref === 'refs/heads/main' && event.after === headSha
        && !process.env.GITHUB_BASE_REF && !process.env.GITHUB_HEAD_REF) {
      return 'PUBLIC_SOURCE_MAIN_READ_ONLY';
    }
    const match = /^refs\/pull\/([1-9][0-9]*)\/merge$/u.exec(process.env.GITHUB_REF || '');
    const pull = event.pull_request;
    if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || !match
        || event.number !== Number(match[1]) || pull?.number !== Number(match[1])
        || pull?.base?.repo?.full_name !== PUBLIC_REPO
        || pull?.head?.repo?.full_name !== PUBLIC_REPO
        || pull.base.ref !== 'main' || process.env.GITHUB_BASE_REF !== 'main'
        || pull.head.ref !== process.env.GITHUB_HEAD_REF
        || !/^agent\/[a-z-]+\/[A-Za-z0-9._/-]+$/u.test(pull.head.ref)
        || !SHA40.test(String(pull.base.sha || ''))
        || !SHA40.test(String(pull.head.sha || ''))
        || gitTrusted(['rev-parse','refs/remotes/origin/main']) !== pull.base.sha
        || gitTrusted(['rev-list','--parents','-n','1','HEAD']) !==
          `${headSha} ${pull.base.sha} ${pull.head.sha}`) return 'INVALID';
    return 'PUBLIC_SOURCE_PR_READ_ONLY';
  } catch {
    return 'INVALID';
  }
}

function publicBaseline(ref) {
  const raw = gitTrusted(['show',ref + ':' + PUBLIC_BASELINE]);
  const baseline = JSON.parse(raw);
  if (baseline.version !== 1 || baseline.repository !== PUBLIC_REPO
      || !SHA40.test(String(baseline.telegramInfoTree || ''))
      || Object.keys(baseline.guardedWorkflows || {}).length !== GUARDED_WORKFLOWS.length
      || GUARDED_WORKFLOWS.some(p => baseline.guardedWorkflows[p] !== PUBLIC_GUARDED_BLOBS[p])) {
    throw new Error('invalid public source baseline');
  }
  if (ref === 'HEAD' && read(path.join(ROOT,PUBLIC_BASELINE)) !== raw) {
    throw new Error('public source baseline has uncommitted changes');
  }
  return baseline;
}

function verifyPublicSource() {
  try {
    const proposed = publicBaseline('HEAD');
    if (proposed.telegramInfoTree !== currentTree) throw new Error('proposed source baseline is stale');
    if (forensicContext === 'PUBLIC_SOURCE_PR_READ_ONLY') {
      const mainRef = 'refs/remotes/origin/main';
      trustedMainTree = gitTrusted(['rev-parse',mainRef + ':telegram-info']);
      // Only the exact independently reviewed import can bootstrap a missing manifest.
      if (gitTrusted(['rev-parse',mainRef]) === PUBLIC_BOOTSTRAP) {
        if (trustedMainTree !== PUBLIC_BOOTSTRAP_TREE) throw new Error('bootstrap source tree mismatch');
      } else if (publicBaseline(mainRef).telegramInfoTree !== trustedMainTree) {
        throw new Error('trusted main source baseline is stale');
      }
      for (const p of GUARDED_WORKFLOWS) {
        if (gitTrusted(['rev-parse',mainRef + ':' + p]) !== PUBLIC_GUARDED_BLOBS[p]) {
          throw new Error('trusted main protected workflow changed');
        }
      }
    }
    for (const p of GUARDED_WORKFLOWS) {
      if (gitTrusted(['rev-parse','HEAD:' + p]) !== PUBLIC_GUARDED_BLOBS[p]) {
        throw new Error('public source must preserve protected workflows');
      }
    }
  } catch (error) {
    add('P0','PUBLIC_SOURCE_BASELINE_INVALID',path.join(ROOT,PUBLIC_BASELINE),1,error.message);
  }
}

let headSha = null;
let currentTree = null;
let trustedMainTree = null;
let expectedTree = null;
let forensicContext = 'INVALID';

try {
  headSha = gitTrusted(['rev-parse','HEAD']);
  currentTree = gitTrusted(['rev-parse','HEAD:telegram-info']);
} catch {
  add('P0','GUARDED_TREE_GIT_UNAVAILABLE',mainGuardedPath,1,
    'cannot resolve checked-out HEAD and telegram-info Git tree');
}

const githubTrusted = process.env.GITHUB_ACTIONS === 'true'
  && process.env.GITHUB_REPOSITORY === REPO
  && SHA40.test(String(process.env.GITHUB_SHA || ''))
  && process.env.GITHUB_SHA === headSha;
if (githubTrusted) {
  if (process.env.GITHUB_EVENT_NAME === 'pull_request' && sourcePrContext()) {
    forensicContext = 'SOURCE_PR_READ_ONLY';
  } else if ((process.env.GITHUB_EVENT_NAME === 'push'
          || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch')
          && process.env.GITHUB_REF === 'refs/heads/main'
          && !process.env.GITHUB_BASE_REF
          && !process.env.GITHUB_HEAD_REF) {
    forensicContext = 'PROTECTED_MAIN';
  }
}
if (forensicContext === 'INVALID') forensicContext = publicSourceContext();
if (forensicContext.startsWith('PUBLIC_SOURCE_')) verifyPublicSource();
if (forensicContext === 'INVALID') {
  add('P0','GUARDED_TREE_CONTEXT_INVALID',mainGuardedPath,1,
    'forensic validation requires verified GitHub PR merge context or checked-out main');
}

const pins = [];
for (const relPath of GUARDED_WORKFLOWS) {
  const file = path.join(ROOT, relPath);
  let content = null;
  try {
    const committed = gitTrusted(['show','HEAD:' + relPath]);
    if (read(file) !== committed) {
      add('P0','GUARDED_WORKFLOW_CHECKOUT_MODIFIED',file,1,
        'checked-out protected workflow content differs from committed Git blob');
    }
    // A source PR must read pins from original main, not a proposed edit.
    // Protected main must read its committed Git blob, not mutable worktree.
    content = forensicContext === 'SOURCE_PR_READ_ONLY'
      ? gitTrusted(['show','refs/remotes/origin/main:' + relPath])
      : committed;
  } catch {
    add('P0','GUARDED_WORKFLOW_UNAVAILABLE',file,1,
      'cannot read protected workflow from trusted Git ref');
    continue;
  }
  const pin = singlePin(content);
  if (!pin) {
    add('P0','GUARDED_WORKFLOW_PIN_MISSING',file,1,
      'protected workflow must contain exactly one well-formed approved tree pin');
  } else {
    pins.push({ path:relPath, pin });
  }

  if (forensicContext === 'SOURCE_PR_READ_ONLY') {
    try {
      const proposedBlob = gitTrusted(['rev-parse','HEAD:' + relPath]);
      const trustedBlob = gitTrusted(['rev-parse','refs/remotes/origin/main:' + relPath]);
      if (!SHA40.test(proposedBlob) || !SHA40.test(trustedBlob)
          || proposedBlob !== trustedBlob) {
        add('P0','GUARDED_WORKFLOW_MODIFIED',file,1,
          'a source PR must not modify protected release workflows');
      }
    } catch {
      add('P0','GUARDED_WORKFLOW_UNAVAILABLE',file,1,
        'cannot verify protected workflow blobs against trusted main');
    }
  }
}
if (pins.length === GUARDED_WORKFLOWS.length) {
  expectedTree = pins[0].pin;
  for (const pin of pins.slice(1)) {
    if (pin.pin !== expectedTree) {
      add('P0','GUARDED_WORKFLOW_PIN_MISMATCH',path.join(ROOT,pin.path),1,
        'protected workflow pins disagree with approved main pin');
    }
  }
}

if (forensicContext === 'SOURCE_PR_READ_ONLY') {
  try {
    // The read-only CI workflow must checkout with fetch-depth: 0, making
    // GitHub's origin/main Git tree available without a token or network call.
    trustedMainTree = gitTrusted(['rev-parse','refs/remotes/origin/main:telegram-info']);
    if (!SHA40.test(trustedMainTree)) throw new Error('invalid trusted main tree');
  } catch {
    add('P0','GUARDED_MAIN_TREE_UNAVAILABLE',mainGuardedPath,1,
      'trusted origin/main tree unavailable; no environment SHA fallback allowed');
  }
  if (expectedTree && trustedMainTree && expectedTree !== trustedMainTree) {
    add('P0','GUARDED_MAIN_TREE_STALE',mainGuardedPath,1,
      'trusted main telegram-info tree disagrees with protected workflow pin');
  }
} else if (forensicContext === 'PROTECTED_MAIN'
           && expectedTree && currentTree && expectedTree !== currentTree) {
  const guarded = read(mainGuardedPath);
  const line = guarded.split(/\r?\n/u).findIndex(x => x.includes('EXPECTED_TELEGRAM_INFO_TREE')) + 1;
  add('P0','GUARDED_TREE_STALE',mainGuardedPath,line,
    'main telegram-info tree does not match approved protected pin');
}

const ciPath = path.join(ROOT,'.github','workflows','standalone-telegram-ci.yml');
const ci = read(ciPath);
if (!/npm\s+test/u.test(ci)) add('P0','CI_FULL_TEST_MISSING',ciPath,1,'telegram CI does not run npm test');
if (!/verify:baseline/u.test(ci)) add('P1','CI_BASELINE_GUARD_MISSING',ciPath,1,'telegram CI does not run verify:baseline');

const p0 = findings.filter(x => x.severity === 'P0');
const p1 = findings.filter(x => x.severity === 'P1');
const p2 = findings.filter(x => x.severity === 'P2');

console.log('TELEGRAM_FORENSIC_AUDIT_BEGIN');
console.log(JSON.stringify({
  head:headSha,
  forensicContext,
  trustedMainTelegramInfoTree:trustedMainTree,
  entrypoint:rel(entrypoint),
  activeFiles:active.size,
  allSourceFiles:allSrc.length,
  testFiles:allTests.length,
  currentTelegramInfoTree:currentTree,
  expectedGuardedTree:expectedTree,
  severity:{P0:p0.length,P1:p1.length,P2:p2.length}
}));

for (const item of findings.sort((a,b) => a.severity.localeCompare(b.severity) || a.file.localeCompare(b.file) || a.line-b.line)) {
  console.log(`${item.severity} ${item.code} ${item.file}:${item.line} :: ${item.detail}`);
}

console.log('ACTIVE_IMPORT_EDGES_BEGIN');
for (const edge of edges) {
  if (/worker-entry|runtime-keyboard|runtime-compatibility|worker\.mjs$/u.test(edge.from + ' ' + edge.to)) {
    console.log(`${edge.from} -> ${edge.to}`);
  }
}
console.log('ACTIVE_IMPORT_EDGES_END');
console.log('TELEGRAM_FORENSIC_AUDIT_END');

if (p0.length) process.exitCode = 2;
