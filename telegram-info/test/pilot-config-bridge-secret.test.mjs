import test from 'node:test';
import assert from 'node:assert/strict';
import { pilotConfig } from '../src/pilot-security.mjs';

const BASE = {
  TELEGRAM_RELEASE_APPROVED:'pilot-v1',
  TELEGRAM_PILOT_MODE:'allowlist',
  TELEGRAM_ALLOWED_CHAT_IDS:'321',
  TELEGRAM_BOT_TOKEN:'123456789:' + 'A'.repeat(35),
  TELEGRAM_WEBHOOK_SECRET:'B'.repeat(40)
};

test('dedicated bridge secret is optional and does not change legacy config', () => {
  const config = pilotConfig(BASE);
  assert.ok(config);
  assert.equal(config.bugBridgeHmacSecret, null);
});

test('valid dedicated bridge secret is exposed only in runtime config', () => {
  const secret = 'C'.repeat(48);
  const config = pilotConfig({ ...BASE, BUG_BRIDGE_HMAC_SECRET:secret });
  assert.ok(config);
  assert.equal(config.bugBridgeHmacSecret, secret);
});

test('malformed configured bridge secret fails closed', () => {
  assert.equal(pilotConfig({ ...BASE, BUG_BRIDGE_HMAC_SECRET:'short' }), null);
});
