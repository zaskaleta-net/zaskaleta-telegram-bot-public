import test from 'node:test';
import assert from 'node:assert/strict';
import { registerWebhook, STAGING_URL, LEGACY_STAGING_URL, STAGING_WEBHOOK_PATH, ALLOWED_UPDATES } from '../scripts/register-webhook.mjs';

const token = '123456789:' + 'A'.repeat(35);
const secret = 'B'.repeat(48);
const target = STAGING_URL + STAGING_WEBHOOK_PATH;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const ok = result => json({ ok: true, result });

function harness({ existing = '', healthDelivery = false, bot = {}, fail = '', oversized = false, allowedUpdates = ['message'] } = {}) {
  const calls = [];
  let currentAllowed = [...allowedUpdates];
  const transport = async (url, options) => {
    const method = url.split('/').pop();
    calls.push({ method, url, body: options.body && JSON.parse(options.body), options });
    assert.equal(options.redirect, 'error');
    if (method === 'health') return json({ ok: true, service: 'zaskaleta-info-telegram', delivery: healthDelivery });
    assert.ok(url.startsWith('https://api.telegram.org/bot' + token + '/'));
    assert.equal(options.method, 'POST');
    if (method === fail) return oversized ? new Response('x'.repeat(20000), { headers: { 'content-type': 'application/json' } }) : json({ ok: false, description: token + secret }, 401);
    if (method === 'getMe') return ok({ id: 123456789, username: 'ZaskaletaInfoBot', is_bot: true, ...bot });
    if (method === 'getWebhookInfo') return ok({ url: existing, max_connections: 1, pending_update_count: 0, allowed_updates: currentAllowed });
    if (method === 'setWebhook') {
      const body = options.body && JSON.parse(options.body);
      existing = body.url;
      currentAllowed = Array.isArray(body.allowed_updates) ? [...body.allowed_updates] : [];
      return ok(true);
    }
    throw new Error('Unexpected method');
  };
  return { calls, transport };
}
const run = (h, options = {}) => registerWebhook({ token, secret, fetchImpl: h.transport, confirm: true, ...options });
const expectStage = stage => error => { assert.equal(error.stage, stage); assert.doesNotMatch(error.message, new RegExp(token + '|' + secret)); return true; };

test('requires explicit approval and valid credentials before network access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw Error('unexpected'); };
  await assert.rejects(registerWebhook({ token, secret, fetchImpl }), expectStage('approval'));
  await assert.rejects(registerWebhook({ token: 'bad', secret, fetchImpl, confirm: true }), expectStage('token_config'));
  await assert.rejects(registerWebhook({ token, secret: 'bad', fetchImpl, confirm: true }), expectStage('secret_config'));
  await assert.rejects(registerWebhook({ token, secret, fetchImpl, confirm: true, mode: 'unknown' }), expectStage('approval'));
  assert.equal(calls, 0);
});

test('registers the active stateless staging URL with message, callback_query and chat_join_request updates', async () => {
  const h = harness();
  assert.equal(STAGING_WEBHOOK_PATH, '/telegram/stateless');
  assert.deepEqual(await run(h), { registered: true, alreadyConfigured: false, callbackQueriesEnabled: true, joinRequestsEnabled: true, pending: 0 });
  assert.deepEqual(h.calls.map(c => c.method), ['health', 'getMe', 'getWebhookInfo', 'setWebhook', 'getWebhookInfo']);
  assert.deepEqual(h.calls[3].body, { url: target, secret_token: secret, allowed_updates: [...ALLOWED_UPDATES], max_connections: 1, drop_pending_updates: true });
  assert.deepEqual(ALLOWED_UPDATES, ['message', 'callback_query', 'chat_join_request']);
  assert.ok(Object.isFrozen(ALLOWED_UPDATES));
  assert.ok(h.calls.every(c => c.options.redirect === 'error'));
  assert.ok(h.calls.every(c => c.method !== 'sendMessage'));
});

test('existing stateless target refreshes callback subscription without dropping pending updates', async () => {
  const h = harness({ existing: target, allowedUpdates: ['message'] });
  assert.deepEqual(await run(h), { registered: true, alreadyConfigured: true, callbackQueriesEnabled: true, joinRequestsEnabled: true, pending: 0 });
  assert.equal(h.calls[3].body.drop_pending_updates, false);
  assert.deepEqual(h.calls[3].body.allowed_updates, ['message', 'callback_query', 'chat_join_request']);
});

test('read-only inspection reports callback and join-request subscriptions separately without mutating anything', async () => {
  for (const [allowedUpdates, callbacks, joins] of [
    [['message'], false, false],
    [['message', 'callback_query'], true, false],
    [['message', 'chat_join_request'], false, true],
    [['message', 'callback_query', 'chat_join_request'], true, true]
  ]) {
    const h = harness({ existing: target, allowedUpdates });
    const stages = [];
    assert.deepEqual(await run(h, { mode: 'inspect', onStage: value => stages.push(value) }), { checked: true, alreadyConfigured: true, callbackQueriesEnabled: callbacks, joinRequestsEnabled: joins, updatesConfigured: callbacks && joins, pending: 0 });
    assert.deepEqual(h.calls.map(c => c.method), ['health', 'getMe', 'getWebhookInfo']);
    assert.equal(stages.at(-1), 'complete');
    assert.ok(h.calls.every(c => c.method !== 'setWebhook' && c.method !== 'sendMessage'));
  }
});

test('does not overwrite a different existing webhook', async () => {
  for (const mode of ['register', 'inspect']) {
    const h = harness({ existing: 'https://other.example/webhook' });
    await assert.rejects(run(h, { mode }), expectStage('webhook_read'));
    assert.equal(h.calls.some(c => c.method === 'setWebhook'), false);
  }
});

test('rejects unexpected bot identity before registration', async () => {
  const h = harness({ bot: { username: 'AnotherBot' } });
  await assert.rejects(run(h), expectStage('identity'));
  assert.equal(h.calls.some(c => c.method === 'setWebhook'), false);
});

test('does not register if staging is missing or delivery is enabled', async () => {
  const h = harness({ healthDelivery: true });
  await assert.rejects(run(h), expectStage('health'));
  assert.deepEqual(h.calls.map(c => c.method), ['health']);
});

test('rejects invalid upstream responses without leaking credentials', async () => {
  for (const oversized of [false, true]) {
    const h = harness({ fail: 'getMe', oversized });
    await assert.rejects(run(h), expectStage('identity'));
    assert.equal(h.calls.some(c => c.method === 'setWebhook'), false);
  }
});

test('redacted stages distinguish read and write failures', async () => {
  for (const [fail, stage] of [['getWebhookInfo', 'webhook_read'], ['setWebhook', 'webhook_write']]) {
    const h = harness({ fail });
    await assert.rejects(run(h), expectStage(stage));
    assert.equal(h.calls.some(c => c.method === 'sendMessage'), false);
  }
});

// TG-RELEASE-044: move the live webhook between the reviewed hosts only.
const legacy = LEGACY_STAGING_URL + STAGING_WEBHOOK_PATH;

function liveHarness({ existing = legacy, targetUnauth = 401, targetAuth = 200, delivery = true, service = 'zaskaleta-info-telegram', fail = '', verifyUrl = null, allowed = ['message', 'callback_query'], verifyAllowed = null } = {}) {
  const calls = [];
  let currentUrl = existing;
  let currentAllowed = [...allowed];
  const transport = async (url, options = {}) => {
    calls.push({ url, method: url.startsWith('https://api.telegram.org/') ? url.split('/').pop() : (options.method || 'GET') + ' ' + new URL(url).origin + new URL(url).pathname, body: options.body, headers: options.headers || {} });
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/health')) return json({ ok: true, service, delivery });
    if (url.endsWith(STAGING_WEBHOOK_PATH)) {
      const authenticated = options.headers?.['x-telegram-bot-api-secret-token'] === secret;
      return authenticated ? json({ ok: targetAuth === 200 }, targetAuth) : json({ error: 'Unauthorized' }, targetUnauth);
    }
    const method = url.split('/').pop();
    assert.ok(url.startsWith('https://api.telegram.org/bot' + token + '/'));
    if (method === fail) return json({ ok: false, description: token + secret }, 400);
    if (method === 'getMe') return ok({ id: 123456789, username: 'ZaskaletaInfoBot', is_bot: true });
    if (method === 'getWebhookInfo') {
      const written = calls.some(c => c.method === 'setWebhook');
      return ok({ url: verifyUrl && written ? verifyUrl : currentUrl, max_connections: 1, pending_update_count: 3, allowed_updates: verifyAllowed && written ? verifyAllowed : currentAllowed });
    }
    if (method === 'setWebhook') {
      const body = JSON.parse(options.body);
      currentUrl = body.url;
      currentAllowed = [...body.allowed_updates];
      return ok(true);
    }
    throw new Error('Unexpected method');
  };
  return { calls, transport };
}
const telegramCalls = h => h.calls.filter(c => c.url.startsWith('https://api.telegram.org/')).map(c => c.method);

test('TG-RELEASE-044 registration targets the bot.zaskaleta.net host; workers.dev is the known legacy host', () => {
  assert.equal(STAGING_URL, 'https://bot.zaskaleta.net');
  assert.equal(LEGACY_STAGING_URL, 'https://zaskaleta-info-telegram-staging.zaskaleta86.workers.dev');
});

test('TG-RELEASE-044 migrate moves the live webhook from workers.dev to bot.zaskaleta.net without dropping updates', async () => {
  const h = liveHarness();
  const stages = [];
  assert.deepEqual(await run(h, { mode: 'migrate', onStage: value => stages.push(value) }), { migrated: true, alreadyConfigured: false, callbackQueriesEnabled: true, joinRequestsEnabled: true, pending: 3 });
  assert.deepEqual(telegramCalls(h), ['getMe', 'getWebhookInfo', 'setWebhook', 'getWebhookInfo']);
  const set = JSON.parse(h.calls.find(c => c.method === 'setWebhook').body);
  assert.deepEqual(set, { url: target, secret_token: secret, allowed_updates: [...ALLOWED_UPDATES], max_connections: 1, drop_pending_updates: false });
  // The target host is proven healthy, fail-closed and holding the same secret before Telegram is touched.
  const firstTelegram = h.calls.findIndex(c => c.url.startsWith('https://api.telegram.org/'));
  const probes = h.calls.slice(0, firstTelegram).map(c => c.method);
  assert.deepEqual(probes, ['GET https://bot.zaskaleta.net/health', 'POST https://bot.zaskaleta.net/telegram/stateless', 'POST https://bot.zaskaleta.net/telegram/stateless']);
  assert.equal(h.calls[1].headers['x-telegram-bot-api-secret-token'], 'invalid-migration-probe-secret');
  assert.ok(h.calls.every(c => c.method !== 'sendMessage' && c.method !== 'deleteWebhook'));
  assert.equal(stages.at(-1), 'complete');
});

test('TG-RELEASE-044 migrate is idempotent when the webhook already points at bot.zaskaleta.net', async () => {
  const h = liveHarness({ existing: target, allowed: [...ALLOWED_UPDATES] });
  assert.deepEqual(await run(h, { mode: 'migrate' }), { migrated: true, alreadyConfigured: true, callbackQueriesEnabled: true, joinRequestsEnabled: true, pending: 3 });
  assert.deepEqual(telegramCalls(h), ['getMe', 'getWebhookInfo']);
});

test('TG-RELEASE-044 rollback moves the webhook back to the workers.dev host only from bot.zaskaleta.net', async () => {
  const h = liveHarness({ existing: target });
  assert.deepEqual(await run(h, { mode: 'rollback' }), { migrated: true, alreadyConfigured: false, callbackQueriesEnabled: true, joinRequestsEnabled: true, pending: 3 });
  assert.equal(JSON.parse(h.calls.find(c => c.method === 'setWebhook').body).url, legacy);
  assert.ok(h.calls.some(c => c.url === LEGACY_STAGING_URL + '/health'));
  assert.ok(h.calls.every(c => !c.url.startsWith(STAGING_URL)));
});

test('TG-RELEASE-044 migrate refuses an unknown current webhook, an empty one, or a non-delivering target', async () => {
  for (const [options, stage] of [
    [{ existing: 'https://other.example/telegram/stateless' }, 'webhook_read'],
    [{ existing: '' }, 'webhook_read'],
    [{ delivery: false }, 'health'],
    [{ service: 'something-else' }, 'health']
  ]) {
    const h = liveHarness(options);
    await assert.rejects(run(h, { mode: 'migrate' }), expectStage(stage));
    assert.equal(h.calls.some(c => c.method === 'setWebhook'), false);
  }
});

test('TG-RELEASE-044 migrate refuses a target that is not fail-closed or does not accept the configured secret', async () => {
  for (const options of [{ targetUnauth: 200 }, { targetUnauth: 404 }, { targetAuth: 401 }, { targetAuth: 500 }]) {
    const h = liveHarness(options);
    await assert.rejects(run(h, { mode: 'migrate' }), expectStage('target_probe'));
    assert.equal(h.calls.some(c => c.url.startsWith('https://api.telegram.org/')), false);
  }
});

test('TG-RELEASE-044 migrate reports an unverified switch without leaking credentials', async () => {
  const h = liveHarness({ verifyUrl: legacy });
  await assert.rejects(run(h, { mode: 'migrate' }), expectStage('webhook_verify'));
  const w = liveHarness({ fail: 'setWebhook' });
  await assert.rejects(run(w, { mode: 'migrate' }), expectStage('webhook_write'));
});

test('TG-RELEASE-044 register keeps its original guards on the new host', async () => {
  const h = harness({ existing: legacy });
  await assert.rejects(run(h), expectStage('webhook_read'));
  assert.equal(h.calls.some(c => c.method === 'setWebhook'), false);
  assert.ok(h.calls[0].url.startsWith(STAGING_URL + '/health'));
});

// TG-RELEASE-117: chat_join_request must reach the Worker for the group subscription gate.
test('TG-RELEASE-117 a reviewed-host webhook missing chat_join_request is not treated as configured', async () => {
  for (const mode of ['migrate', 'rollback']) {
    const existing = mode === 'migrate' ? target : legacy;
    const h = liveHarness({ existing, allowed: ['message', 'callback_query'] });
    const result = await run(h, { mode });
    assert.equal(result.joinRequestsEnabled, true);
    const writes = h.calls.filter(c => c.method === 'setWebhook');
    assert.equal(writes.length, 1);
    const body = JSON.parse(writes[0].body);
    assert.deepEqual(body.allowed_updates, ['message', 'callback_query', 'chat_join_request']);
    assert.equal(body.max_connections, 1);
    assert.equal(body.drop_pending_updates, false);
    assert.equal(body.secret_token, secret);
  }
  const inspected = harness({ existing: target, allowedUpdates: ['message', 'callback_query'] });
  const report = await run(inspected, { mode: 'inspect' });
  assert.equal(report.joinRequestsEnabled, false);
  assert.equal(report.updatesConfigured, false);
  assert.equal(inspected.calls.some(c => c.method === 'setWebhook'), false);
});

test('TG-RELEASE-117 an existing target is refreshed with all three updates without dropping pending updates', async () => {
  const h = harness({ existing: target, allowedUpdates: ['message', 'callback_query'] });
  assert.deepEqual(await run(h), { registered: true, alreadyConfigured: true, callbackQueriesEnabled: true, joinRequestsEnabled: true, pending: 0 });
  assert.deepEqual(h.calls[3].body, { url: target, secret_token: secret, allowed_updates: ['message', 'callback_query', 'chat_join_request'], max_connections: 1, drop_pending_updates: false });
});

test('TG-RELEASE-117 verification fails closed when Telegram does not confirm chat_join_request', async () => {
  for (const mode of ['migrate', 'rollback']) {
    const h = liveHarness({ existing: mode === 'migrate' ? legacy : target, verifyAllowed: ['message', 'callback_query'] });
    await assert.rejects(run(h, { mode }), expectStage('webhook_verify'));
  }
});

test('TG-RELEASE-117 a repeated migrate after a verified write is idempotent and writes nothing', async () => {
  const h = liveHarness({ existing: legacy, allowed: ['message', 'callback_query'] });
  const first = await run(h, { mode: 'migrate' });
  assert.equal(first.alreadyConfigured, false);
  const before = h.calls.filter(c => c.method === 'setWebhook').length;
  const again = await run(h, { mode: 'migrate' });
  assert.deepEqual(again, { migrated: true, alreadyConfigured: true, callbackQueriesEnabled: true, joinRequestsEnabled: true, pending: 3 });
  assert.equal(h.calls.filter(c => c.method === 'setWebhook').length, before);
});

test('TG-RELEASE-117 failures never disclose the token, secret or webhook URL', async () => {
  for (const options of [{ fail: 'setWebhook' }, { verifyAllowed: ['message'] }]) {
    const h = liveHarness(options);
    await assert.rejects(run(h, { mode: 'migrate' }), error => {
      assert.ok(!error.message.includes(token) && !error.message.includes(secret) && !error.message.includes(STAGING_WEBHOOK_PATH));
      assert.match(error.message, /^Registration failed safely at [a-z_]+$/);
      return true;
    });
  }
});
