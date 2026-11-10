import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';

const SECRET = 'S'.repeat(32);
const TOKEN = '123456:' + 'A'.repeat(30);

function env() {
  return {
    TELEGRAM_ALLOWED_CHAT_IDS:'123456789',
    TELEGRAM_ADMIN_USER_IDS:'123456789',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_DELIVERY_ENABLED:'true'
  };
}

test('live consolidated webhook rejects an invalid secret with 401 before legacy delivery gates', async () => {
  const request = new Request('https://pilot.example/telegram/stateless', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-telegram-bot-api-secret-token':'wrong-secret'
    },
    body:'{}'
  });

  const transport = async () => {
    throw new Error('invalid webhook secret must fail before network access');
  };

  const response = await handle(request, env(), Date.now(), transport);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error:'Unauthorized' });
});
