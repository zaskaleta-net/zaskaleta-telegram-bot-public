import test from 'node:test';
import assert from 'node:assert/strict';
import { signBugBridgeBody, verifyBugBridgeSignature, bugBridgeSecretIsValid } from '../src/bug-bridge-auth.mjs';

const SECRET = 'A'.repeat(48);
const NOW = Date.parse('2026-09-14T12:00:00Z');

test('signs deterministically and verifies exact body', async () => {
  const body = JSON.stringify({ report_id:'R-20260914-1', description:'test' });
  const signed = await signBugBridgeBody(SECRET, body, NOW);
  assert.equal(signed.timestamp, String(Math.floor(NOW / 1000)));
  assert.match(signed.signature, /^v1=[0-9a-f]{64}$/u);
  assert.equal(await verifyBugBridgeSignature(SECRET, body, signed.timestamp, signed.signature, NOW), true);
  assert.equal(await verifyBugBridgeSignature(SECRET, body + ' ', signed.timestamp, signed.signature, NOW), false);
});

test('rejects stale timestamps and malformed secrets', async () => {
  const body = '{}';
  const signed = await signBugBridgeBody(SECRET, body, NOW);
  assert.equal(await verifyBugBridgeSignature(SECRET, body, signed.timestamp, signed.signature, NOW + 301000), false);
  assert.equal(bugBridgeSecretIsValid('short'), false);
  assert.equal(await signBugBridgeBody('short', body, NOW), null);
});
