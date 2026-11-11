import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePullRequestContext,
  dryRunArguments,
  forbiddenLocalEnvironmentFilename,
} from './premerge-staging-readiness.mjs';

const REPO = 'zaskaleta-net/zaskaleta-telegram-bot-public';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const BRANCH = 'agent/release-agent/TG-PUBLIC-010-premerge-candidate-gate';

function candidate() {
  return {
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: REPO,
      GITHUB_REF: 'refs/pull/42/merge',
      GITHUB_SHA: MERGE,
      GITHUB_HEAD_REF: BRANCH,
      GITHUB_BASE_REF: 'main',
    },
    event: {
      number: 42,
      repository: { full_name: REPO },
      pull_request: {
        number: 42,
        head: { sha: HEAD, ref: BRANCH, repo: { full_name: REPO } },
        base: { sha: BASE, ref: 'main', repo: { full_name: REPO } },
      },
    },
    checkoutSha: MERGE,
    mergeParents: [BASE, HEAD],
  };
}

test('accepts precisely the same-repository PR synthetic merge checkout', () => {
  assert.deepEqual(validatePullRequestContext(candidate()), {
    pullRequestNumber: 42,
    headSha: HEAD,
    baseSha: BASE,
    checkoutSha: MERGE,
  });
});

const badCases = [
  ['push event', ({ env }) => { env.GITHUB_EVENT_NAME = 'push'; }],
  ['manual workflow dispatch', ({ env }) => { env.GITHUB_EVENT_NAME = 'workflow_dispatch'; }],
  ['wrong repository', ({ env }) => { env.GITHUB_REPOSITORY = 'other/repo'; }],
  ['event repository mismatch', ({ event }) => { event.repository.full_name = 'other/repo'; }],
  ['fork head', ({ event }) => { event.pull_request.head.repo.full_name = 'someone/fork'; }],
  ['foreign base repository', ({ event }) => { event.pull_request.base.repo.full_name = 'someone/fork'; }],
  ['wrong base', ({ env }) => { env.GITHUB_BASE_REF = 'production'; }],
  ['wrong PR base branch', ({ event }) => { event.pull_request.base.ref = 'release'; }],
  ['head branch mismatch', ({ env }) => { env.GITHUB_HEAD_REF = 'somewhere-else'; }],
  ['wrong merge ref', ({ env }) => { env.GITHUB_REF = 'refs/heads/main'; }],
  ['PR number mismatch', ({ event }) => { event.number = 43; }],
  ['PR merge ref number mismatch', ({ env }) => { env.GITHUB_REF = 'refs/pull/43/merge'; }],
  ['invalid PR number', ({ event }) => { event.pull_request.number = -1; }],
  ['malformed head SHA', ({ event }) => { event.pull_request.head.sha = 'not-a-sha'; }],
  ['malformed base SHA', ({ event }) => { event.pull_request.base.sha = 'not-a-sha'; }],
  ['malformed event SHA', ({ env }) => { env.GITHUB_SHA = 'not-a-sha'; }],
  ['different checked out commit', (context) => { context.checkoutSha = 'd'.repeat(40); }],
  ['missing merge parents', (context) => { context.mergeParents = []; }],
  ['incorrect merge parent order', (context) => { context.mergeParents = [HEAD, BASE]; }],
  ['unrelated merge parent', (context) => { context.mergeParents = [BASE, 'd'.repeat(40)]; }],
  ['missing event metadata', (context) => { context.event = null; }],
  ['missing PR head identity', ({ event }) => { delete event.pull_request.head.repo; }],
  ['credentials in environment', ({ env }) => { env.CLOUDFLARE_API_TOKEN = 'redacted'; }],
  ['Telegram webhook secret in environment', ({ env }) => { env.TELEGRAM_WEBHOOK_SECRET = 'redacted'; }],
  ['GitHub token in environment', ({ env }) => { env.GITHUB_TOKEN = 'redacted'; }],
];

for (const [label, mutate] of badCases) {
  test(`rejects ${label}`, () => {
    const context = candidate();
    mutate(context);
    assert.throws(() => validatePullRequestContext(context), /PR candidate preflight rejected/);
  });
}

test('constructs fixed offline staging dry-run arguments only', () => {
  const args = dryRunArguments('/tmp/telegram-pr-candidate-123');
  assert.deepEqual(args, [
    'deploy', '--dry-run', '--env', 'staging', '--outdir', '/tmp/telegram-pr-candidate-123',
  ]);
  assert.ok(!args.includes('--upload'));
  assert.ok(!args.includes('--remote'));
});

test('rejects an unsafe output directory', () => {
  assert.throws(() => dryRunArguments(''), /PR candidate preflight rejected/);
  assert.throws(() => dryRunArguments('.'), /PR candidate preflight rejected/);
  assert.throws(() => dryRunArguments('/'), /PR candidate preflight rejected/);
});

test('detects all local environment file variants before Wrangler can read them', () => {
  for (const name of ['.env', '.env.local', '.env.staging', '.env.staging.local',
    '.dev.vars', '.dev.vars.staging', '.dev.vars.staging.local']) {
    assert.equal(forbiddenLocalEnvironmentFilename(name), true, name);
  }
  for (const name of ['.gitignore', 'wrangler.jsonc', 'environment.test.mjs']) {
    assert.equal(forbiddenLocalEnvironmentFilename(name), false, name);
  }
});
