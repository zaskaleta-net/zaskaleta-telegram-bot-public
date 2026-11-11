// Fail-closed PR candidate Cloudflare bundle preflight. Never deploys or uses credentials.
import { readFileSync, mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY = 'zaskaleta-net/zaskaleta-telegram-bot-public';
const FORBIDDEN_ENV = [
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'GH_TOKEN',
];
const SHA_PATTERN = /^[a-f0-9]{40}$/i;

function reject(reason) {
  throw new Error(`PR candidate preflight rejected: ${reason}`);
}

export function validatePullRequestContext({ env, event, checkoutSha, mergeParents } = {}) {
  if (!env || typeof env !== 'object') reject('missing environment');
  if (FORBIDDEN_ENV.some((name) => Object.hasOwn(env, name) && env[name])) {
    reject('credential-bearing environment');
  }
  if (env.GITHUB_EVENT_NAME !== 'pull_request') reject('wrong event');
  if (env.GITHUB_REPOSITORY !== REPOSITORY) reject('wrong checkout repository');
  if (!event || event.repository?.full_name !== REPOSITORY) reject('wrong event repository');

  const pr = event.pull_request;
  const number = pr?.number;
  if (!Number.isSafeInteger(number) || number <= 0 || event.number !== number) {
    reject('invalid pull request number');
  }
  if (pr.head?.repo?.full_name !== REPOSITORY || pr.base?.repo?.full_name !== REPOSITORY) {
    reject('fork or unexpected pull request repository');
  }
  if (pr.base?.ref !== 'main' || env.GITHUB_BASE_REF !== 'main') reject('wrong base branch');
  if (!pr.head?.ref || pr.head.ref !== env.GITHUB_HEAD_REF) reject('head branch mismatch');
  if (env.GITHUB_REF !== `refs/pull/${number}/merge`) reject('wrong merge ref');
  for (const sha of [pr.head.sha, pr.base.sha, env.GITHUB_SHA, checkoutSha]) {
    if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) reject('malformed commit SHA');
  }
  if (env.GITHUB_SHA !== checkoutSha) reject('checked-out commit differs from GitHub merge SHA');
  if (pr.head.sha === checkoutSha || pr.base.sha === checkoutSha) {
    reject('not a PR synthetic merge checkout');
  }
  if (!Array.isArray(mergeParents) || mergeParents.length !== 2 ||
      mergeParents[0] !== pr.base.sha || mergeParents[1] !== pr.head.sha) {
    reject('merge commit parents differ from the reviewed PR base/head');
  }

  return {
    pullRequestNumber: number,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    checkoutSha,
  };
}

export function dryRunArguments(outdir) {
  if (typeof outdir !== 'string' || !isAbsolute(outdir) ||
      normalize(outdir) !== outdir || outdir === sep) {
    reject('unsafe output directory');
  }
  return ['deploy', '--dry-run', '--env', 'staging', '--outdir', outdir];
}

export function forbiddenLocalEnvironmentFilename(filename) {
  return filename === '.env' || filename.startsWith('.env.') ||
    filename === '.dev.vars' || filename.startsWith('.dev.vars.');
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectDir = resolve(scriptDir, '..', '..', 'telegram-info');
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !isAbsolute(eventPath)) reject('missing PR event path');

  // Verify the real checkout SHA, not only the CI-supplied environment.
  const git = spawnSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], {
    cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (git.status !== 0) reject('cannot verify checkout merge parentage');
  const [checkoutSha, ...mergeParents] = git.stdout.trim().split(/\s+/u);
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const context = validatePullRequestContext({ env: process.env, event, checkoutSha, mergeParents });

  const cli = join(projectDir, 'node_modules', '.bin', 'wrangler');
  if (!existsSync(cli)) reject('local Wrangler dependency not installed');
  // A dry-run must not load local developer or runner environment files either.
  if (readdirSync(projectDir).some(forbiddenLocalEnvironmentFilename)) {
    reject('local environment file present');
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'telegram-pr-candidate-'));
  try {
    const outdir = join(tempDir, 'bundle');
    // No CF/GitHub/Telegram credentials are forwarded to Wrangler.
    const safeEnv = {
      PATH: process.env.PATH,
      HOME: tempDir,
      XDG_CONFIG_HOME: tempDir,
      TMPDIR: tempDir,
      CI: 'true',
      NO_COLOR: '1',
      WRANGLER_SEND_METRICS: 'false',
    };
    const bundled = spawnSync(cli, dryRunArguments(outdir), {
      cwd: projectDir,
      env: safeEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    // Do not echo Wrangler stdout/stderr: bundle diagnostics can include source details.
    if (bundled.error || bundled.status !== 0) reject('offline Wrangler dry-run failed');
    if (!existsSync(outdir) || readdirSync(outdir).length === 0) {
      reject('offline Wrangler dry-run produced no bundle');
    }
    console.log(`PR #${context.pullRequestNumber}: checked-out merge ${context.checkoutSha.slice(0, 12)} bundled locally`);
    console.log('CANDIDATE_BUNDLE=PASS; STAGING_STATUS=NOT_RUN; DEPLOYMENT=NOT_RUN');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error.message.startsWith('PR candidate preflight rejected:')
      ? error.message : 'PR candidate preflight rejected: unexpected failure');
    process.exitCode = 1;
  }
}
