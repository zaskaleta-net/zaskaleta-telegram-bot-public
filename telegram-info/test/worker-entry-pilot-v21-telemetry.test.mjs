import test from 'node:test';
import assert from 'node:assert/strict';
import { queueAggregateRequestTelemetry } from '../src/worker-entry-pilot-v21.mjs';

const enabledEnv = {
  TELEGRAM_TELEMETRY_ENABLED:'true',
  POSTHOG_PROJECT_KEY:'phc_' + 'A'.repeat(32),
  POSTHOG_HOST:'https://eu.i.posthog.com'
};

function contextRecorder() {
  const pending = [];
  return {
    pending,
    ctx:{ waitUntil(promise) { pending.push(Promise.resolve(promise)); } }
  };
}

test('aggregate telemetry is queued only for Telegram webhook ingress', async () => {
  const { pending, ctx } = contextRecorder();
  let calls = 0;
  const ignored = queueAggregateRequestTelemetry(
    new Request('https://worker.example/health', { method:'GET' }),
    Promise.resolve(new Response('ok')),
    enabledEnv,
    ctx,
    async () => { calls += 1; return new Response('{}', { status:200 }); }
  );
  assert.equal(ignored, false);
  assert.equal(pending.length, 0);
  assert.equal(calls, 0);

  const queued = queueAggregateRequestTelemetry(
    new Request('https://worker.example/telegram/stateless', { method:'POST', body:'{"message":{"text":"private secret"}}' }),
    Promise.resolve(new Response('ok')),
    {},
    ctx,
    async () => { calls += 1; return new Response('{}', { status:200 }); }
  );
  assert.equal(queued, true);
  assert.equal(pending.length, 1);
  await pending[0];
  assert.equal(calls, 0, 'disabled telemetry must not make network calls');
});

test('webhook request telemetry makes no network call and records nothing per request', async () => {
  const { pending, ctx } = contextRecorder();
  let calls = 0;
  const transport = async () => { calls += 1; return new Response('{}', { status:200 }); };
  queueAggregateRequestTelemetry(
    new Request('https://worker.example/telegram/stateless', {
      method:'POST',
      body:JSON.stringify({ update_id:987654321, message:{ chat:{ id:-123456789, type:'supergroup' }, from:{ id:11223344, username:'sensitive-user' }, text:'дуже приватний текст' } })
    }),
    Promise.resolve(new Response('{"ok":true}', { status:200 })),
    enabledEnv,
    ctx,
    transport
  );
  queueAggregateRequestTelemetry(
    new Request('https://worker.example/telegram/stateless', { method:'POST', body:'{}' }),
    Promise.reject(new Error('synthetic handler failure')),
    enabledEnv,
    ctx,
    transport
  );
  await Promise.all(pending);
  assert.equal(calls, 0, 'PostHog is off: no telemetry request leaves the worker');
});
