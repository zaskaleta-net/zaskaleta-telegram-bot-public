import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker-entry-pilot-v21.mjs';
import { replyFor } from '../src/worker.mjs';
import {
  PRIVACY_CONTROLLER, PRIVACY_POLICY_URL, privacyPolicyPublished, privacyPolicyHtml,
  handlePrivacyPolicyRequest, privacyCommandText
} from '../src/privacy-policy.mjs';

const FILLED = { name:'Max Muster', address:'Musterweg 1, 24103 Kiel', email:'bot@example.org' };

test('the policy is not published while the controller still holds placeholders', async () => {
  assert.equal(privacyPolicyPublished(PRIVACY_CONTROLLER), false);
  assert.equal(handlePrivacyPolicyRequest(new Request('https://x.test/datenschutz')), null);
  const response = await worker.fetch(new Request('https://zaskaleta-info-telegram-staging.zaskaleta86.workers.dev/datenschutz'), {}, { waitUntil() {} });
  assert.notEqual(response.status, 200, 'an incomplete policy page is never served');
  assert.doesNotMatch(replyFor({ text:'/privacy' }), /datenschutz/u);
});

test('a complete controller publishes the page in German and Ukrainian', async () => {
  assert.equal(privacyPolicyPublished(FILLED), true);
  const response = handlePrivacyPolicyRequest(new Request('https://x.test/datenschutz'), FILLED);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/u);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/u);
  const html = await response.text();
  for (const fragment of ['Datenschutzerklärung', 'Політика конфіденційності', 'Max Muster', 'mailto:bot@example.org', 'Cloudflare, Inc.', 'Supabase Inc.', 'Art. 77 DSGVO', '15 Minuten', '2 Stunden', '1 Stunde']) {
    assert.ok(html.includes(fragment), fragment);
  }
  assert.doesNotMatch(html, /\[[^\]]*\]/u, 'no placeholder survives');
  assert.doesNotMatch(html, /PostHog/u);
  assert.equal(handlePrivacyPolicyRequest(new Request('https://x.test/datenschutz', { method:'POST' }), FILLED), null);
  assert.equal(handlePrivacyPolicyRequest(new Request('https://x.test/health'), FILLED), null);
});

test('controller values are escaped in the page', () => {
  const html = privacyPolicyHtml({ ...FILLED, name:'<script>x</script>' });
  assert.doesNotMatch(html, /<script>x/u);
  assert.match(html, /&lt;script&gt;x/u);
});

test('/privacy links the full policy once it is published', () => {
  const text = privacyCommandText(FILLED);
  assert.ok(text.includes(PRIVACY_POLICY_URL));
  assert.match(text, /bot@example\.org/u);
  assert.doesNotMatch(text, /стандартна Privacy Policy/u);
});

test('the policy link uses the bot domain in the zaskaleta.net ecosystem', () => {
  assert.equal(PRIVACY_POLICY_URL, 'https://bot.zaskaleta.net/datenschutz');
});
