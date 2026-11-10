import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const source = await readFile(new URL('../src/worker.mjs', import.meta.url), 'utf8');
const expectedBinding = [{ name: 'OUTBOX', class_name: 'TelegramOutbox' }];
const expectedAiBinding = { binding: 'AI' };
const expectedVersionMetadataBinding = { binding: 'CF_VERSION_METADATA' };
// Only the live consolidated entrypoint may be deployed.
const safeEntrypoints = new Set([
  'src/worker-entry-pilot-v21.mjs'
]);

function assertDisabled(vars) {
  assert.equal(vars.TELEGRAM_INGRESS_ENABLED, 'false');
  assert.equal(vars.TELEGRAM_DELIVERY_ENABLED, 'false');
  assert.equal(vars.TELEGRAM_RELEASE_APPROVED, '');
  assert.equal(vars.TELEGRAM_ALLOWED_CHAT_IDS, '');
  assert.equal(vars.TELEGRAM_PILOT_MODE, 'allowlist');
  assert.equal(Object.hasOwn(vars, 'TELEGRAM_' + 'BOT_TOKEN'), false);
  assert.equal(Object.hasOwn(vars, 'TELEGRAM_' + 'WEBHOOK_SECRET'), false);
  assert.equal(Object.hasOwn(vars, 'POSTHOG_PROJECT_TOKEN'), false);
  assert.equal(vars.AI_ASSISTANT_ENABLED, 'false');
  assert.equal(vars.AI_PREMIUM_ENABLED, 'false');
  assert.equal(vars.HOUSING_WATCH_ENABLED, 'false');
}

function assertSafeStagingVars(vars = {}) {
  assert.deepEqual(Object.keys(vars).sort(), [
    'AI_ASSISTANT_ENABLED',
    'AI_EXTERNAL_ENABLED',
    'AI_PREMIUM_ENABLED',
    'HOUSING_WATCH_ENABLED',
    'KLAZ_API_ENABLED',
    'POSTHOG_ENABLED',
    'POSTHOG_HOST',
    'TELEGRAM_DAILY_NEWS_ENABLED',
    'TELEGRAM_DELIVERY_ENABLED',
    'TELEGRAM_INGRESS_ENABLED',
    'TELEGRAM_MAINTENANCE_MODE',
    'TELEGRAM_PILOT_MODE',
    'TELEGRAM_RELEASE_APPROVED'
  ]);
  assert.equal(vars.TELEGRAM_INGRESS_ENABLED, 'true');
  assert.equal(vars.TELEGRAM_DELIVERY_ENABLED, 'true');
  assert.equal(vars.TELEGRAM_DAILY_NEWS_ENABLED, 'true');
  assert.equal(vars.TELEGRAM_PILOT_MODE, 'public');
  assert.equal(vars.TELEGRAM_RELEASE_APPROVED, 'public-v1');
  assert.equal(vars.TELEGRAM_MAINTENANCE_MODE, 'false');
  assert.equal(vars.KLAZ_API_ENABLED, 'false');
  assert.equal(vars.POSTHOG_ENABLED, 'false');
  assert.equal(vars.POSTHOG_HOST, 'https://us.i.posthog.com');
  // TG-RUNTIME-047/048: the AI module runs on Workers AI with the external
  // text fallback on (it only acts on a provider whose Worker secret is set);
  // payments stay off, and provider keys are never repository vars.
  assert.equal(vars.AI_ASSISTANT_ENABLED, 'true');
  assert.equal(vars.AI_PREMIUM_ENABLED, 'false');
  assert.equal(vars.AI_EXTERNAL_ENABLED, 'true');
  // TG-RUNTIME-056: the housing monitor (no AI) runs on staging.
  assert.equal(vars.HOUSING_WATCH_ENABLED, 'true');
  for (const name of ['GROQ_API_KEY', 'GITHUB_MODELS_TOKEN', 'GEMINI_API_KEY']) assert.equal(Object.hasOwn(vars, name), false, name);

  // User/chat identifiers and credentials remain dashboard-managed and must
  // never be committed as plaintext repository vars.
  assert.equal(Object.hasOwn(vars, 'TELEGRAM_ALLOWED_CHAT_IDS'), false);
  assert.equal(Object.hasOwn(vars, 'TELEGRAM_ADMIN_USER_IDS'), false);
  assert.equal(Object.hasOwn(vars, 'TELEGRAM_' + 'BOT_TOKEN'), false);
  assert.equal(Object.hasOwn(vars, 'TELEGRAM_' + 'WEBHOOK_SECRET'), false);
}

test('default config stays fail-closed while reviewed staging public flags are explicit', () => {
  assertDisabled(config.vars);
  assertSafeStagingVars(config.env.staging.vars);
  assert.equal(config.name, 'zaskaleta-info-telegram-staging');
  assert.equal(config.env.staging.name, 'zaskaleta-info-telegram-staging');
  assert.equal(safeEntrypoints.has(config.main), true, config.main);
  assert.equal(config.compatibility_date, '2026-09-08');
  assert.equal(config.env.staging.workers_dev, true);
  assert.equal(config.keep_vars, true);
  assert.equal(config.send_metrics, false);
  assert.equal(config.logpush, false);
  // TG-RUNTIME-065 (owner, 19.10.2026): Workers Logs on for diagnosing searches,
  // but only the bot's own status lines (src/log-safe.mjs keeps IDs and keys
  // out): no invocation logs (they carry request URLs), no query strings.
  const expectedObservability = { enabled:true, head_sampling_rate:1, redact_query_string:true, logs:{ enabled:true, invocation_logs:false } };
  assert.deepEqual(config.observability, expectedObservability);
  assert.deepEqual(config.env.staging.observability, expectedObservability);
  assert.deepEqual(config.ai, expectedAiBinding);
  assert.deepEqual(config.env.staging.ai, expectedAiBinding);
  assert.deepEqual(config.version_metadata, expectedVersionMetadataBinding);
  assert.deepEqual(config.env.staging.version_metadata, expectedVersionMetadataBinding);
  assert.deepEqual(config.durable_objects.bindings, expectedBinding);
  assert.deepEqual(config.env.staging.durable_objects.bindings, expectedBinding);
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['TelegramOutbox'] }]);
  assert.deepEqual(config.env.staging.migrations, [{ tag: 'v1', new_sqlite_classes: ['TelegramOutbox'] }]);
});

test('deployable entrypoint contains no test transport or inspection routes', () => {
  assert.doesNotMatch(config.main, /fixture|test|runtime\.integration/i);
  assert.doesNotMatch(source, /TEST_TRANSPORT_MODE|test\.internal/);
  assert.doesNotMatch(source, /from\s+['"]\.\.\/test\//);
  assert.equal(Object.keys(config.env).length, 1);
});
