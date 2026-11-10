// Local-only configuration diagnostics. No network calls or secret output.
// Results use fixed classifications only; never emit values, lengths, characters or hashes.
import { pathToFileURL } from 'node:url';

const WEBHOOK_ALPHABET = /^[A-Za-z0-9_-]+$/;
const WEBHOOK_MIN_LENGTH = 32;
const WEBHOOK_MAX_LENGTH = 256;
const APPROVED_POSTHOG_HOSTS = new Set([
  'https://eu.i.posthog.com',
  'https://us.i.posthog.com'
]);

export function classifyWebhookSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return 'missing';
  if (value.length < WEBHOOK_MIN_LENGTH) return 'too_short';
  if (value.length > WEBHOOK_MAX_LENGTH) return 'too_long';
  if (!WEBHOOK_ALPHABET.test(value)) return 'unsupported_characters';
  return 'valid';
}

export function classifyPresence(value) {
  return typeof value === 'string' && value.length > 0 ? 'present' : 'missing';
}

export function classifyTelemetry(env) {
  const enabled = env?.TELEGRAM_TELEMETRY_ENABLED === 'true';
  if (!enabled) return 'disabled';
  if (classifyPresence(env?.POSTHOG_PROJECT_KEY) !== 'present') return 'missing_project_key';
  if (!APPROVED_POSTHOG_HOSTS.has(env?.POSTHOG_HOST)) return 'invalid_host';
  return 'ready';
}

export function checkSecretConfiguration(env) {
  const result = Object.freeze({
    webhookSecret: classifyWebhookSecret(env?.TELEGRAM_WEBHOOK_SECRET),
    bugBridgeHmacSecret: classifyPresence(env?.BUG_BRIDGE_HMAC_SECRET),
    telemetry: classifyTelemetry(env)
  });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Do not enable environment dumps, command tracing or diagnostic payloads.
  const result = checkSecretConfiguration(process.env);
  console.log('CONFIG_CHECK ' + JSON.stringify(result));
  if (
    result.webhookSecret !== 'valid' ||
    result.bugBridgeHmacSecret !== 'present' ||
    result.telemetry !== 'ready'
  ) process.exitCode = 1;
}
