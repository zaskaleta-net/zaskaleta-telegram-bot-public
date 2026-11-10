import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const releaseSource = await readFile(new URL('../scripts/cloudflare-candidate-slot.mjs', import.meta.url), 'utf8');

test('npm prepare is deterministic QA only and never mutates Cloudflare deployment state', () => {
  assert.equal(pkg.scripts.prepare, 'node scripts/cloudflare-build-qa.mjs');
  assert.doesNotMatch(pkg.scripts.prepare, /candidate-slot|wrangler|deploy|versions/u);
});

test('staging promotion is an explicit release action, separate from dependency installation', () => {
  assert.equal(pkg.scripts['release:staging'], 'node scripts/cloudflare-candidate-slot.mjs');
});


test('guarded staging release preserves reviewed public release flags', () => {
  assert.match(releaseSource, /\['TELEGRAM_PILOT_MODE', 'public'\]/u);
  assert.match(releaseSource, /\['TELEGRAM_RELEASE_APPROVED', 'public-v1'\]/u);
  assert.match(releaseSource, /\['TELEGRAM_MAINTENANCE_MODE', 'false'\]/u);
  assert.doesNotMatch(releaseSource, /\['TELEGRAM_PILOT_MODE', 'allowlist'\]/u);
  assert.doesNotMatch(releaseSource, /\['TELEGRAM_RELEASE_APPROVED', 'pilot-v1'\]/u);
});


test('guarded staging release keeps PostHog analytics switched off', () => {
  assert.match(releaseSource, /\['POSTHOG_ENABLED', 'false'\]/u);
  assert.doesNotMatch(releaseSource, /\['POSTHOG_ENABLED', 'true'\]/u);
  assert.match(releaseSource, /\['POSTHOG_HOST', 'https:\/\/us\.i\.posthog\.com'\]/u);
  assert.match(releaseSource, /'POSTHOG_PROJECT_TOKEN'/u);
  assert.match(releaseSource, /'BUG_BRIDGE_HMAC_SECRET'/u);
});

test('TG-RUNTIME-059: the guarded release applies the Cron Triggers from wrangler.jsonc after promotion', () => {
  assert.match(releaseSource, /wrangler\(\['triggers', 'deploy', '--env', 'staging'\]\)/u);
  assert.ok(releaseSource.indexOf("'triggers', 'deploy'") > releaseSource.indexOf('CLOUDFLARE_STAGING_REPAIR_OK'), 'only after the new version is live');
});

test('TG-RUNTIME-077: only the read-only `versions view` is retried, a bounded number of times, before anything is deployed', () => {
  assert.match(releaseSource, /const VERSION_VIEW_RETRY_DELAYS_MS = \[3000, 6000, 12000\];/u);
  assert.match(releaseSource, /function viewVersionWithRetry\(versionId\) \{[\s\S]*?wrangler\(\['versions', 'view', versionId, '--env', 'staging', '--json'\]\)[\s\S]*?if \(delay === undefined\) throw error;/u);
  assert.match(releaseSource, /parseJson\(viewVersionWithRetry\(versionId\), 'versions view'\)/u);
  // No other wrangler command is wrapped in the retry.
  const body = /function viewVersionWithRetry[\s\S]*?\n\}\n/u.exec(releaseSource)[0];
  assert.equal((body.match(/wrangler\(/gu) || []).length, 1);
  assert.doesNotMatch(body, /'deploy'|'upload'|'rollback'/u);
  // The binding check still runs before the deployment is changed.
  assert.ok(releaseSource.indexOf('validateCandidateBindings(candidateId);') < releaseSource.indexOf('deploymentChanged = true;'));
});
