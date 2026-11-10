import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWebhookSecret,
  classifyPresence,
  classifyTelemetry,
  checkSecretConfiguration
} from '../scripts/check-secret-config.mjs';

const valid = 'A'.repeat(48);
const completeEnv = {
  TELEGRAM_WEBHOOK_SECRET: valid,
  BUG_BRIDGE_HMAC_SECRET: 'never-output-this-value',
  TELEGRAM_TELEMETRY_ENABLED: 'true',
  POSTHOG_PROJECT_KEY: 'never-output-this-key',
  POSTHOG_HOST: 'https://eu.i.posthog.com'
};

test('classifies webhook secret without disclosure', () => {
  const cases = [
    [undefined, 'missing'],
    ['', 'missing'],
    ['A'.repeat(31), 'too_short'],
    ['A'.repeat(257), 'too_long'],
    ['A'.repeat(47) + '!', 'unsupported_characters'],
    ['A'.repeat(47) + '\n', 'unsupported_characters'],
    ['A'.repeat(47) + ' ', 'unsupported_characters'],
    [valid, 'valid'],
    ['A'.repeat(32), 'valid'],
    ['A'.repeat(256), 'valid'],
    ['A'.repeat(46) + '_-', 'valid']
  ];
  for (const [value, expected] of cases) {
    assert.equal(classifyWebhookSecret(value), expected);
  }
});

test('classifies HMAC presence and telemetry readiness without returning values', () => {
  assert.equal(classifyPresence(undefined), 'missing');
  assert.equal(classifyPresence(''), 'missing');
  assert.equal(classifyPresence('secret-value'), 'present');

  assert.equal(classifyTelemetry({}), 'disabled');
  assert.equal(classifyTelemetry({ TELEGRAM_TELEMETRY_ENABLED: 'false' }), 'disabled');
  assert.equal(classifyTelemetry({ TELEGRAM_TELEMETRY_ENABLED: 'true' }), 'missing_project_key');
  assert.equal(classifyTelemetry({
    TELEGRAM_TELEMETRY_ENABLED: 'true',
    POSTHOG_PROJECT_KEY: 'project-key',
    POSTHOG_HOST: 'https://example.invalid'
  }), 'invalid_host');
  assert.equal(classifyTelemetry({
    TELEGRAM_TELEMETRY_ENABLED: 'true',
    POSTHOG_PROJECT_KEY: 'project-key',
    POSTHOG_HOST: 'https://eu.i.posthog.com'
  }), 'ready');
  assert.equal(classifyTelemetry({
    TELEGRAM_TELEMETRY_ENABLED: 'true',
    POSTHOG_PROJECT_KEY: 'project-key',
    POSTHOG_HOST: 'https://us.i.posthog.com'
  }), 'ready');

  const result = checkSecretConfiguration(completeEnv);
  assert.deepEqual(result, {
    webhookSecret: 'valid',
    bugBridgeHmacSecret: 'present',
    telemetry: 'ready'
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /never-output|project-key|posthog\.com/);
  assert.equal(Object.isFrozen(result), true);
});

test('diagnostics read only the approved environment keys and perform no network calls', () => {
  const allowed = new Set([
    'TELEGRAM_WEBHOOK_SECRET',
    'BUG_BRIDGE_HMAC_SECRET',
    'TELEGRAM_TELEMETRY_ENABLED',
    'POSTHOG_PROJECT_KEY',
    'POSTHOG_HOST'
  ]);
  const reads = new Map();
  const env = new Proxy(completeEnv, {
    get(target, key) {
      if (typeof key !== 'string' || !allowed.has(key)) throw new Error('Unexpected environment access');
      reads.set(key, (reads.get(key) || 0) + 1);
      return target[key];
    }
  });
  assert.deepEqual(checkSecretConfiguration(env), {
    webhookSecret: 'valid',
    bugBridgeHmacSecret: 'present',
    telemetry: 'ready'
  });
  for (const key of allowed) assert.ok((reads.get(key) || 0) >= 1, `Expected ${key} to be read`);
});
