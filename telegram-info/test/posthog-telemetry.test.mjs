import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPosthogEvent,
  capturePosthogEvent,
  classifyTelegramTelemetry,
  posthogTelemetryConfig,
  sanitizePosthogProperties
} from '../src/telemetry-posthog.mjs';

const ENABLED_ENV = Object.freeze({
  POSTHOG_ENABLED:'true',
  POSTHOG_PROJECT_TOKEN:'phc_test_project_token_123456',
  POSTHOG_HOST:'https://eu.i.posthog.com'
});

test('PostHog telemetry is disabled by default and requires explicit host + token', () => {
  assert.equal(posthogTelemetryConfig({}), null);
  assert.equal(posthogTelemetryConfig({ POSTHOG_ENABLED:'true' }), null);
  assert.equal(posthogTelemetryConfig({
    POSTHOG_ENABLED:'true',
    POSTHOG_PROJECT_TOKEN:'phc_test_project_token_123456',
    POSTHOG_HOST:'http://eu.i.posthog.com'
  }), null);
  assert.deepEqual(posthogTelemetryConfig(ENABLED_ENV), {
    apiKey:'phc_test_project_token_123456',
    endpoint:'https://eu.i.posthog.com/i/v0/e/'
  });
});

test('PostHog payload is personless and only whitelisted operational properties survive', () => {
  const built = buildPosthogEvent(ENABLED_ENV, 'telegram webhook processed', {
    update_type:'message',
    feature:'housing',
    outcome:'success',
    http_status:200,
    duration_ms:123,
    worker_version:'7508b651-883a-4085-95f9-22c4180c22ce',
    release:'public-v1',
    source:'user_input',
    telegram_id:123456789,
    chat_id:123456789,
    username:'example-user',
    message_text:'private housing request',
    location:'Trittau'
  });

  assert.equal(built.endpoint, 'https://eu.i.posthog.com/i/v0/e/');
  assert.equal(built.payload.event, 'telegram webhook processed');
  assert.equal(built.payload.distinct_id, 'zaskaleta-telegram-worker');
  assert.equal(built.payload.properties.$process_person_profile, false);
  assert.equal(built.payload.properties.service, 'zaskaleta-telegram');
  assert.equal(built.payload.properties.feature, 'housing');
  assert.equal(built.payload.properties.http_status, 200);
  assert.equal(built.payload.properties.duration_ms, 123);

  for (const forbidden of ['telegram_id','chat_id','username','message_text','location']) {
    assert.equal(Object.hasOwn(built.payload.properties, forbidden), false);
  }
  const serialized = JSON.stringify(built.payload);
  assert.doesNotMatch(serialized, /private housing request|example-user|Trittau|123456789/u);
});

test('property sanitizer rejects unknown, malformed, and unbounded values', () => {
  assert.deepEqual(sanitizePosthogProperties({
    feature:'jobcenter',
    outcome:'success',
    http_status:200,
    duration_ms:10,
    source:'inline_action',
    unknown:'nope'
  }), {
    feature:'jobcenter',
    outcome:'success',
    http_status:200,
    duration_ms:10,
    source:'inline_action'
  });

  assert.deepEqual(sanitizePosthogProperties({
    feature:'contains\nnewline',
    http_status:999,
    duration_ms:-1
  }), {});
});

test('Telegram classification returns categories only, never raw text or ids', () => {
  const freeText = classifyTelegramTelemetry({
    message:{
      text:'Шукаю квартиру у приватній локації для родини',
      chat:{ id:123456789 },
      from:{ id:123456789, username:'private-user' }
    }
  });
  assert.deepEqual(freeText, {
    update_type:'message',
    feature:'free_text',
    source:'user_input'
  });

  const callback = classifyTelegramTelemetry({
    callback_query:{
      data:'jcr:15:2:u123456789:opaque',
      from:{ id:123456789 },
      message:{ chat:{ id:123456789 } }
    }
  });
  assert.deepEqual(callback, {
    update_type:'callback',
    feature:'housing_jobcenter',
    source:'inline_action'
  });

  const serialized = JSON.stringify([freeText, callback]);
  assert.doesNotMatch(serialized, /123456789|private-user|приватній/u);
});

test('capture is non-blocking by contract and does not throw on telemetry transport failure', async () => {
  assert.deepEqual(
    await capturePosthogEvent({}, 'telegram webhook processed', {}, async () => {
      throw new Error('must not be called');
    }),
    { status:'disabled' }
  );

  const sentBodies = [];
  const sent = await capturePosthogEvent(
    ENABLED_ENV,
    'telegram webhook processed',
    { feature:'menu', outcome:'success', http_status:200 },
    async (_url, options) => {
      sentBodies.push(JSON.parse(options.body));
      return new Response('{}', { status:200 });
    }
  );
  assert.deepEqual(sent, { status:'sent', httpStatus:200 });
  assert.equal(sentBodies.length, 1);

  const unavailable = await capturePosthogEvent(
    ENABLED_ENV,
    'telegram webhook processed',
    { feature:'menu' },
    async () => { throw new Error('offline'); }
  );
  assert.deepEqual(unavailable, { status:'unavailable' });
});
