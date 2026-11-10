import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { retryHealthProbe } from './cloudflare-health-retry.mjs';

const WORKER = 'zaskaleta-info-telegram-staging';
const HEALTH_URL = 'https://zaskaleta-info-telegram-staging.zaskaleta86.workers.dev/health';
const OUTPUT_PATH = '/tmp/wrangler-staging-repair.ndjson';
const REPAIR_VARS = [
  ['TELEGRAM_INGRESS_ENABLED', 'true'],
  ['TELEGRAM_DELIVERY_ENABLED', 'true'],
  ['TELEGRAM_DAILY_NEWS_ENABLED', 'true'],
  ['TELEGRAM_PILOT_MODE', 'public'],
  ['TELEGRAM_RELEASE_APPROVED', 'public-v1'],
  ['TELEGRAM_MAINTENANCE_MODE', 'false'],
  // Kleinanzeigen API off (owner decision 2026-10-17); the key stays set.
  ['KLAZ_API_ENABLED', 'false'],
  // Product analytics is off (owner decision 2026-10-14); the bot works
  // without it and sends nothing to PostHog.
  ['POSTHOG_ENABLED', 'false'],
  ['POSTHOG_HOST', 'https://us.i.posthog.com'],
];

if (process.env.WORKERS_CI !== '1') {
  console.log('CLOUDFLARE_STAGING_REPAIR_SKIP reason=not-workers-ci');
  process.exit(0);
}

assert.equal(
  process.env.WORKERS_CI_BRANCH,
  'main',
  'staging repair may run only on main',
);

function wrangler(args, extraEnv = {}) {
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  try {
    return execFileSync(cmd, ['wrangler', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        ...extraEnv,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim().slice(-4000);
    const stdout = String(error?.stdout || '').trim().slice(-4000);
    console.error(
      `CLOUDFLARE_STAGING_REPAIR_WRANGLER_FAIL command=${args.slice(0, 2).join(' ')}`,
    );
    if (stderr) console.error(stderr);
    if (stdout) console.error(stdout);
    throw new Error(`Wrangler command failed: ${args.slice(0, 2).join(' ')}`);
  }
}

function parseJson(raw, label) {
  const text = String(raw || '').trim();
  try {
    return JSON.parse(text);
  } catch {}
  const starts = [text.indexOf('['), text.indexOf('{')].filter((n) => n >= 0);
  for (const start of starts.sort((a, b) => a - b)) {
    for (let end = text.length; end > start; end -= 1) {
      const tail = text.slice(start, end).trim();
      if (!tail || !['}', ']'].includes(tail.at(-1))) continue;
      try {
        return JSON.parse(tail);
      } catch {}
    }
  }
  throw new Error(`${label}: Wrangler did not return parseable JSON`);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    ...options,
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body };
}

async function liveHealth(expectedVersionId = null) {
  const { health, lastError } = await retryHealthProbe({
    requestJson,
    url: HEALTH_URL,
    expectedVersionId,
    // Cloudflare may accept the deployment before workers.dev begins
    // serving the promoted version globally. Preserve exact-version safety,
    // but allow up to ~3 minutes for propagation before rollback.
    attempts: expectedVersionId === null ? 12 : 60,
    delayMs: expectedVersionId === null ? 1000 : 3000,
  });

  if (!health && lastError) {
    throw new Error(
      `live health unavailable after retries: ${String(lastError?.name || lastError?.message || lastError)}`,
      { cause:lastError },
    );
  }

  assert.equal(health?.status, 200, 'live health must be HTTP 200');
  assert.equal(health?.body?.ok, true, 'live health must report ok=true');
  assert.equal(health?.body?.delivery, true, 'live health must report delivery=true');
  if (expectedVersionId !== null) {
    assert.equal(
      health?.body?.versionId,
      expectedVersionId,
      'live health returned wrong versionId',
    );
  }
  return health;
}

function deploymentList(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.deployments)) return value.deployments;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && value.result) return deploymentList(value.result);
  if (value && Array.isArray(value.versions)) return [value];
  return [];
}

function currentDeployment() {
  const data = parseJson(
    wrangler(['deployments', 'list', '--env', 'staging', '--json']),
    'deployments list',
  );
  const list = deploymentList(data);
  assert.ok(list.length > 0, 'no deployments returned');
  return [...list].sort((a, b) => {
    const ta = Date.parse(a?.created_on || a?.createdOn || '') || 0;
    const tb = Date.parse(b?.created_on || b?.createdOn || '') || 0;
    return tb - ta;
  })[0];
}

function normalizeVersions(deployment) {
  const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
  return versions.map((v) => ({
    id: String(v?.version_id || v?.versionId || v?.id || ''),
    percentage: Number(v?.percentage),
  }));
}

function assertSafeCurrent(versions) {
  assert.ok(
    versions.length >= 1 && versions.length <= 2,
    'active deployment must contain one or two versions',
  );
  for (const version of versions) {
    assert.match(version.id, /^[0-9a-f-]{36}$/i, 'invalid active version id');
    assert.ok(Number.isFinite(version.percentage), 'invalid traffic percentage');
    assert.ok(
      [0, 0.01, 99.99, 100].includes(version.percentage),
      'refusing to alter unexpected gradual deployment',
    );
  }
  const active = versions.filter((version) => version.percentage === 100 || version.percentage === 99.99);
  assert.equal(active.length, 1, 'expected exactly one healthy version at 100% or 99.99%');
  assert.equal(
    versions.reduce((sum, version) => sum + version.percentage, 0),
    100,
    'deployment percentages must total 100',
  );
  return active[0].id;
}

function readVersionUploadId() {
  const lines = readFileSync(OUTPUT_PATH, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const uploads = lines.filter(
    (entry) => entry?.type === 'version-upload' && entry?.version_id,
  );
  assert.ok(
    uploads.length > 0,
    'structured Wrangler output did not contain a version upload',
  );
  return String(uploads.at(-1).version_id);
}

function uploadRepairVersion() {
  rmSync(OUTPUT_PATH, { force: true });
  const args = [
    'versions',
    'upload',
    '--env',
    'staging',
    '--keep-vars',
    '--message',
    'Guarded staging repair candidate',
  ];
  for (const [name, value] of REPAIR_VARS) {
    args.push('--var', `${name}:${value}`);
  }
  wrangler(args, { WRANGLER_OUTPUT_FILE_PATH: OUTPUT_PATH });
  const versionId = readVersionUploadId();
  assert.match(versionId, /^[0-9a-f-]{36}$/i, 'invalid repaired version id');
  return versionId;
}

function collectBindings(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    value.name.length > 0
  ) {
    out.push(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBindings(item, out);
    return out;
  }
  for (const nested of Object.values(value)) collectBindings(nested, out);
  return out;
}

// TG-RUNTIME-077: right after `versions upload` Cloudflare can still answer
// 100146 "version not found" for the new id (seen on the 074 release). The
// read-only `versions view` is retried a few times before the release fails;
// nothing is deployed yet at this point.
const VERSION_VIEW_RETRY_DELAYS_MS = [3000, 6000, 12000];

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function viewVersionWithRetry(versionId) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return wrangler(['versions', 'view', versionId, '--env', 'staging', '--json']);
    } catch (error) {
      const delay = VERSION_VIEW_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      console.error(`CLOUDFLARE_STAGING_VERSION_VIEW_RETRY attempt=${attempt + 1} delayMs=${delay}`);
      pause(delay);
    }
  }
}

function validateCandidateBindings(versionId) {
  const version = parseJson(viewVersionWithRetry(versionId), 'versions view');
  const bindings = collectBindings(version);
  const names = new Set(bindings.map((binding) => binding.name));

  for (const required of [
    'TELEGRAM_INGRESS_ENABLED',
    'TELEGRAM_DELIVERY_ENABLED',
    'TELEGRAM_PILOT_MODE',
    'TELEGRAM_RELEASE_APPROVED',
    'TELEGRAM_ALLOWED_CHAT_IDS',
    'TELEGRAM_NEWS_CHAT_IDS',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET',
    'BUG_BRIDGE_HMAC_SECRET',
    'POSTHOG_PROJECT_TOKEN',
    'POSTHOG_ENABLED',
    'POSTHOG_HOST',
    'OUTBOX',
    'CF_VERSION_METADATA',
  ]) {
    assert.ok(names.has(required), `candidate binding missing: ${required}`);
  }

  const plain = new Map();
  for (const binding of bindings) {
    if (binding.type === 'plain_text') {
      const value = binding.text ?? binding.value;
      if (typeof value === 'string') plain.set(binding.name, value);
    }
  }

  for (const [name, expected] of REPAIR_VARS) {
    if (plain.has(name)) {
      assert.equal(plain.get(name), expected, `candidate var mismatch: ${name}`);
    }
  }
  if (plain.has('TELEGRAM_ALLOWED_CHAT_IDS')) {
    assert.match(
      plain.get('TELEGRAM_ALLOWED_CHAT_IDS'),
      /^-?[1-9][0-9]*(?:,-?[1-9][0-9]*)*$/,
      'candidate allowlist is empty or invalid',
    );
  }
  if (plain.has('TELEGRAM_NEWS_CHAT_IDS')) {
    assert.match(
      plain.get('TELEGRAM_NEWS_CHAT_IDS'),
      /^-[1-9][0-9]*(?:,-[1-9][0-9]*)*$/,
      'candidate news target list is empty or invalid',
    );
  }
}

function deployVersions(healthyId, candidateId) {
  wrangler([
    'versions',
    'deploy',
    `${healthyId}@99.99%`,
    `${candidateId}@0.01%`,
    '--env',
    'staging',
    '-y',
    '--message',
    'Guarded staging candidate at 0.01%',
  ]);
  const current = normalizeVersions(currentDeployment());
  assertSafeCurrent(current);
  assert.ok(
    current.some((version) => version.id === healthyId && version.percentage === 99.99),
    'healthy version not preserved at 99.99%',
  );
  assert.ok(
    current.some((version) => version.id === candidateId && version.percentage === 0.01),
    'candidate not present at 0.01%',
  );
}

async function exactCandidateSmoke(versionId) {
  const { health:response, lastError } = await retryHealthProbe({
    requestJson,
    url: HEALTH_URL,
    expectedVersionId: versionId,
    headers: {
      'Cloudflare-Workers-Version-Overrides': `${WORKER}="${versionId}"`,
    },
    attempts: 6,
    delayMs: 1000,
  });
  if (!response && lastError) {
    throw new Error(
      `candidate health unavailable after retries: ${String(lastError?.name || lastError?.message || lastError)}`,
      { cause:lastError },
    );
  }
  assert.equal(response?.status, 200, 'candidate health must be HTTP 200');
  assert.equal(response?.body?.ok, true, 'candidate health must report ok=true');
  assert.equal(response?.body?.delivery, true, 'candidate health must report delivery=true');
  assert.equal(response?.body?.versionId, versionId, 'candidate health returned wrong versionId');
}

function promoteCandidate(candidateId) {
  wrangler([
    'versions',
    'deploy',
    `${candidateId}@100%`,
    '--env',
    'staging',
    '-y',
    '--message',
    'Promote guarded staging candidate',
  ]);
}

function rollback(healthyId) {
  wrangler([
    'versions',
    'deploy',
    `${healthyId}@100%`,
    '--env',
    'staging',
    '-y',
    '--message',
    'Automatic rollback after failed staging health verification',
  ]);
}

const initialHealth = await liveHealth();
const before = normalizeVersions(currentDeployment());
const healthyId = assertSafeCurrent(before);

let candidateId = null;
let deploymentChanged = false;
let promotionAttempted = false;

try {
  candidateId = uploadRepairVersion();
  assert.notEqual(candidateId, healthyId, 'repair upload reused healthy version id');
  validateCandidateBindings(candidateId);
  deploymentChanged = true;
  deployVersions(healthyId, candidateId);
  await exactCandidateSmoke(candidateId);

  promotionAttempted = true;
  promoteCandidate(candidateId);
  await liveHealth(candidateId);
} catch (error) {
  console.error(
    `CLOUDFLARE_STAGING_REPAIR_FAIL healthy=${healthyId} candidate=${candidateId || 'unknown'} deploymentChanged=${deploymentChanged} promoted=${promotionAttempted}`,
  );
  if (deploymentChanged) {
    try {
      rollback(healthyId);
      await liveHealth();
      console.error(`CLOUDFLARE_STAGING_ROLLBACK_OK active=${healthyId}`);
    } catch (rollbackError) {
      console.error(
        `CLOUDFLARE_STAGING_ROLLBACK_FAIL active=${healthyId} error=${String(rollbackError?.message || rollbackError)}`,
      );
    }
  }
  throw error;
}

console.log(
  `CLOUDFLARE_STAGING_REPAIR_OK previous=${healthyId} active=${candidateId} exactLiveHealth=true rollbackArmed=true`,
);

// TG-RUNTIME-059: `versions upload/deploy` leave the Cron Triggers as they
// were; they are applied from wrangler.jsonc with `triggers deploy`. The
// code runs on the old and the new schedule, so a failure here fails the
// release without a rollback.
try {
  wrangler(['triggers', 'deploy', '--env', 'staging']);
  console.log('CLOUDFLARE_STAGING_TRIGGERS_OK');
} catch (error) {
  console.error('CLOUDFLARE_STAGING_TRIGGERS_FAIL');
  throw error;
}
