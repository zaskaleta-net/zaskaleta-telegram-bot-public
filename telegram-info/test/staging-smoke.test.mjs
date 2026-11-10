import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLiveStaging, STAGING_URL } from '../scripts/verify-live-staging.mjs';
import { readFile } from 'node:fs/promises';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const expected = [
  [STAGING_URL + '/health', 'GET', 200, { ok: true, service: 'zaskaleta-info-telegram', delivery: true, versionId: '11111111-1111-4111-8111-111111111111' }],
  [STAGING_URL + '/not-a-route', 'GET', 404, { error: 'Not found' }],
  [STAGING_URL + '/telegram/stateless', 'GET', 404, { error: 'Not found' }],
  [STAGING_URL + '/telegram/stateless', 'POST', 401, { error: 'Unauthorized' }]
];

test('release smoke verifier performs only four fixed live-staging requests without credentials', async () => {
  let calls = 0;
  const results = await verifyLiveStaging(async (url, options) => {
    const [target, method, status, body] = expected[calls++];
    assert.equal(url, target);
    assert.equal(options.method, method);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-telegram-bot-api-secret-token'], undefined);
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.body, method === 'POST' ? '{}' : undefined);
    return json(body, status);
  });
  assert.equal(calls, 4);
  assert.equal(results.length, 4);
  assert.ok(results.every(r => r.passed));
});

test('smoke verifier refuses any other destination before network access', async () => {
  let calls = 0;
  await assert.rejects(verifyLiveStaging(async () => { calls++; }, 'https://example.com'), /Only the reviewed staging host/);
  assert.equal(calls, 0);
});

test('release smoke verifier rejects a disabled-delivery response', async () => {
  await assert.rejects(verifyLiveStaging(async () => json({ ok: true, service: 'zaskaleta-info-telegram', delivery: false })), /delivery must be enabled/);
});

test('release QA orchestration targets the live-staging verifier', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const audit = await readFile(new URL('../scripts/full-bot-audit.mjs', import.meta.url), 'utf8');
  assert.match(pkg.scripts['verify:staging'], /verify-live-staging\.mjs/);
  assert.match(audit, /verify-live-staging\.mjs/);
  assert.doesNotMatch(audit, /verify-disabled-staging\.mjs/);
});

test('smoke verifier reports non-JSON without printing the response body', async () => {
  const secret = 'DO_NOT_LEAK_SYNTHETIC_SECRET';
  await assert.rejects(verifyLiveStaging(async () => new Response('<html>' + secret + '</html>', { status: 503, headers: { 'content-type': 'text/html' } })), error => {
    assert.match(error.message, /HTTP 503, content-type text\/html/);
    assert.doesNotMatch(error.message, /DO_NOT_LEAK/);
    return true;
  });
});

test('smoke verifier rejects oversized responses and stops after the first failure', async () => {
  let calls = 0;
  await assert.rejects(verifyLiveStaging(async () => { calls++; return new Response('x'.repeat(5000), { headers: { 'content-type': 'application/json' } }); }), /exceeds 4096 bytes/);
  assert.equal(calls, 1);
});
