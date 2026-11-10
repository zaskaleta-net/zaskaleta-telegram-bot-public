import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTelegramTelemetryPayload, captureTelegramTelemetry } from '../src/telegram-telemetry.mjs';

test('payload contains only aggregate allowlisted properties', () => {
  const payload = buildTelegramTelemetryPayload('telegram_report', {
    chat_type:'private', action:'report', outcome:'queued', user_id:123, text:'secret', chat_id:-999
  }, 'v22');
  assert.deepEqual(payload, {
    event:'telegram_report',
    properties:{
      distinct_id:'telegram-pilot-aggregate',
      $process_person_profile:false,
      channel:'telegram',
      chat_type:'private',
      action:'report',
      outcome:'queued',
      runtime:'v22'
    }
  });
  assert.equal(JSON.stringify(payload).includes('secret'), false);
  assert.equal(JSON.stringify(payload).includes('123'), false);
  assert.equal(JSON.stringify(payload).includes('-999'), false);
});

test('background search reason is privacy-safe and allowlisted', () => {
  const payload = buildTelegramTelemetryPayload('telegram_search', {
    chat_type:'private',
    action:'search',
    outcome:'failed',
    reason:'timeout',
    location:'should-not-leak',
    query_id:'secret-id'
  }, 'v21');
  assert.equal(payload.properties.reason,'timeout');
  assert.equal('location' in payload.properties,false);
  assert.equal('query_id' in payload.properties,false);

  const unknown = buildTelegramTelemetryPayload('telegram_search', {
    chat_type:'private',
    action:'search',
    outcome:'failed',
    reason:'provider-secret-code'
  }, 'v21');
  assert.equal('reason' in unknown.properties,false);
});

function opsEnv() {
  const calls = [];
  return { calls, env:{
    TELEGRAM_TELEMETRY_ENABLED:'true',
    POSTHOG_PROJECT_KEY:'phc_' + 'A'.repeat(32),
    POSTHOG_HOST:'https://eu.i.posthog.com',
    OUTBOX:{ idFromName:name => name, get:name => ({ async fetch(url, init) { calls.push({ name, url:String(url), body:JSON.parse(init.body) }); return new Response('{"status":"ok"}'); } }) }
  } };
}

test('nothing is sent to PostHog, even with the old telemetry variables set', async () => {
  const { env } = opsEnv();
  let network = 0;
  const transport = async () => { network += 1; return new Response('{}'); };
  await captureTelegramTelemetry(env, 'telegram_request', { outcome:'handled' }, 'v22', transport);
  await captureTelegramTelemetry(env, 'telegram_search', { outcome:'failed', reason:'timeout' }, 'v22', transport);
  assert.equal(network, 0);
});

test('a background search outcome becomes one aggregate counter, nothing else', async () => {
  const { env, calls } = opsEnv();
  const result = await captureTelegramTelemetry(env, 'telegram_search', {
    chat_type:'private', action:'search', outcome:'failed', reason:'timeout', message:'do not send', location:'Kiel'
  }, 'v21');
  assert.equal(result.status, 'recorded');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'telegram-pilot-v1');
  assert.equal(calls[0].body.key, 'search:timeout');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['key', 'now']);
  assert.equal((await captureTelegramTelemetry(env, 'telegram_request', { outcome:'handled' })).status, 'skipped');
  assert.equal((await captureTelegramTelemetry(env, 'telegram_search', { outcome:'failed', reason:'provider-secret' })).status, 'skipped');
  assert.equal(calls.length, 1);
});
