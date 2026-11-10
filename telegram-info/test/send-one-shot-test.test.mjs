import test from 'node:test';
import assert from 'node:assert/strict';
import { sendOneShotTest } from '../scripts/send-one-shot-test.mjs';

const token = '123456789:' + 'A'.repeat(35);
const accountId = 'a'.repeat(32);
const cfToken = 'cf-token-present';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function settings(delivery = 'false') {
  return json({ success: true, result: { bindings: [
    { name: 'TELEGRAM_DELIVERY_ENABLED', type: 'plain_text', text: delivery },
    { name: 'TELEGRAM_PILOT_MODE', type: 'plain_text', text: 'allowlist' },
    { name: 'TELEGRAM_RELEASE_APPROVED', type: 'plain_text', text: 'pilot-v1' },
    { name: 'TELEGRAM_ALLOWED_CHAT_IDS', type: 'plain_text', text: '123456789' }
  ] } });
}

test('performs one verified send without touching DO or webhook', async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('cloudflare.com/')) return settings();
    if (String(url).endsWith('/getMe')) return json({ ok: true, result: { id: 123456789, is_bot: true, username: 'ZaskaletaInfoBot' } });
    if (String(url).endsWith('/sendMessage')) {
      const body = JSON.parse(options.body);
      assert.equal(body.chat_id, 123456789);
      assert.match(body.text, /одноразовий тест доставки/);
      return json({ ok: true, result: { message_id: 77, chat: { id: 123456789 } } });
    }
    throw new Error('unexpected request');
  };

  const result = await sendOneShotTest({ approval: 'SEND-TEST', telegramToken: token, cloudflareToken: cfToken, accountId, fetchImpl: fakeFetch });
  assert.deepEqual(result, { sent: true, messageId: 77, durableObjectsUsed: false, queueTouched: false, webhookChanged: false });
  assert.equal(calls.filter(call => call.url.endsWith('/sendMessage')).length, 1);
  assert.equal(calls.some(call => /durable|outbox|webhook/i.test(call.url)), false);
});

test('refuses to send while normal delivery is enabled', async () => {
  let telegramCalls = 0;
  const fakeFetch = async url => {
    if (String(url).includes('cloudflare.com/')) return settings('true');
    telegramCalls += 1;
    return json({ ok: true, result: {} });
  };
  await assert.rejects(
    sendOneShotTest({ approval: 'SEND-TEST', telegramToken: token, cloudflareToken: cfToken, accountId, fetchImpl: fakeFetch }),
    /one_shot_failed_settings/
  );
  assert.equal(telegramCalls, 0);
});

test('never retries an uncertain send', async () => {
  let sends = 0;
  const fakeFetch = async url => {
    if (String(url).includes('cloudflare.com/')) return settings();
    if (String(url).endsWith('/getMe')) return json({ ok: true, result: { id: 123456789, is_bot: true, username: 'ZaskaletaInfoBot' } });
    if (String(url).endsWith('/sendMessage')) {
      sends += 1;
      throw new Error('synthetic network uncertainty');
    }
    throw new Error('unexpected request');
  };
  await assert.rejects(
    sendOneShotTest({ approval: 'SEND-TEST', telegramToken: token, cloudflareToken: cfToken, accountId, fetchImpl: fakeFetch }),
    /one_shot_failed_send/
  );
  assert.equal(sends, 1);
});
