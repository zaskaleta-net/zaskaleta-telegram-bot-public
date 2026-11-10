// One-shot server-side registration and read-only diagnostics.
// Credentials and raw upstream responses must never be written to logs.
import { pathToFileURL } from 'node:url';

// The Worker answers on both hosts; bot.zaskaleta.net (Cloudflare Custom
// Domain since 17.10.2026) is the reviewed webhook host, workers.dev the
// legacy one that migrate leaves and rollback returns to.
export const STAGING_URL = 'https://bot.zaskaleta.net';
export const LEGACY_STAGING_URL = 'https://zaskaleta-info-telegram-staging.zaskaleta86.workers.dev';
export const STAGING_WEBHOOK_PATH = '/telegram/stateless';
// chat_join_request feeds the group subscription gate (TG-RUNTIME-115).
export const ALLOWED_UPDATES = Object.freeze(['message', 'callback_query', 'chat_join_request']);
const EXPECTED_BOT = 'ZaskaletaInfoBot';
const TOKEN = /^[0-9]{5,20}:[A-Za-z0-9_-]{30,}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const STAGES = new Set(['approval', 'token_config', 'secret_config', 'health', 'target_probe', 'identity', 'webhook_read', 'webhook_write', 'webhook_verify', 'complete']);
const MODES = new Set(['register', 'inspect', 'migrate', 'rollback']);
// migrate/rollback switch the delivering bot between exactly these two hosts.
const MOVES = Object.freeze({
  migrate: { from: LEGACY_STAGING_URL, to: STAGING_URL },
  rollback: { from: STAGING_URL, to: LEGACY_STAGING_URL }
});

async function boundedJSON(response) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) throw new Error('Unexpected content type');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty API response');
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 16384) { await reader.cancel().catch(() => {}); throw new Error('Oversized API response'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function registerWebhook({ token, secret, fetchImpl = fetch, confirm = false, mode = 'register', onStage = () => {} } = {}) {
  let stage = 'approval';
  const mark = value => { stage = value; onStage(value); };
  try {
    mark('approval');
    if (confirm !== true || !MODES.has(mode)) throw new Error('Explicit approval is required');
    mark('token_config');
    if (!TOKEN.test(token || '')) throw new Error('Invalid bot token configuration');
    mark('secret_config');
    if (!SECRET.test(secret || '')) throw new Error('Invalid webhook secret configuration');
    const move = MOVES[mode] || null;
    const host = move ? move.to : STAGING_URL;
    const webhook = host + STAGING_WEBHOOK_PATH;
    async function api(method, body = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetchImpl('https://api.telegram.org/bot' + token + '/' + method, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body), redirect: 'error', signal: controller.signal
        });
        const data = await boundedJSON(response);
        if (!response.ok || data?.ok !== true) throw new Error('API rejection');
        return data.result;
      } catch {
        throw new Error('Telegram API request could not be verified');
      } finally { clearTimeout(timeout); }
    }
    mark('health');
    let health;
    try {
      const response = await fetchImpl(host + '/health', { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (response.status !== 200) throw new Error('Unexpected status');
      health = await boundedJSON(response);
    } catch { throw new Error('Staging health could not be verified'); }
    // First registration needs a non-delivering Worker; a move keeps the live bot delivering.
    if (health?.ok !== true || health.service !== 'zaskaleta-info-telegram' || health.delivery !== Boolean(move)) throw new Error('Staging is not in the required delivery state');
    if (move) {
      mark('target_probe');
      // Before Telegram is touched, the target must reject a wrong secret and accept the configured one.
      const probe = async probeSecret => {
        try {
          const response = await fetchImpl(webhook, {
            method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-telegram-bot-api-secret-token': probeSecret },
            body: '{}', redirect: 'error', signal: AbortSignal.timeout(10000)
          });
          const body = await boundedJSON(response).catch(() => null);
          return { status: response.status, ok: body?.ok === true };
        } catch { return { status: 0, ok: false }; }
      };
      const invalid = await probe('invalid-migration-probe-secret');
      if (invalid.status !== 401) throw new Error('Target webhook is not fail-closed');
      const valid = await probe(secret);
      if (valid.status !== 200 || !valid.ok) throw new Error('Target webhook does not accept the configured secret');
    }
    mark('identity');
    const me = await api('getMe');
    if (me?.username !== EXPECTED_BOT || me.is_bot !== true || me.id !== Number(token.split(':')[0])) throw new Error('Unexpected bot identity');
    mark('webhook_read');
    const before = await api('getWebhookInfo');
    if (typeof before?.url !== 'string') throw new Error('Invalid webhook information');
    if (move) {
      if (before.url !== move.from + STAGING_WEBHOOK_PATH && before.url !== webhook) throw new Error('The current webhook is not one of the reviewed hosts; refusing to move it');
    } else if (before.url && before.url !== webhook) throw new Error('A different webhook is already configured; refusing to overwrite it');
    const alreadyConfigured = before.url === webhook;
    const pendingOf = info => Number.isSafeInteger(info?.pending_update_count) ? info.pending_update_count : null;
    const allows = (info, values) => Array.isArray(info?.allowed_updates) && values.every(value => info.allowed_updates.includes(value));
    const subscribedOf = info => allows(info, ALLOWED_UPDATES);
    if (move && alreadyConfigured && before.max_connections === 1 && subscribedOf(before)) {
      mark('complete');
      return { migrated: true, alreadyConfigured: true, callbackQueriesEnabled: true, joinRequestsEnabled: true, pending: pendingOf(before) };
    }
    if (mode === 'inspect') {
      mark('complete');
      const callbackQueriesEnabled = allows(before, ['message', 'callback_query']);
      const joinRequestsEnabled = allows(before, ['chat_join_request']);
      return {
        checked: true,
        alreadyConfigured,
        callbackQueriesEnabled,
        joinRequestsEnabled,
        // The reviewed URL alone is not enough: every required update type must be subscribed too.
        updatesConfigured: alreadyConfigured && callbackQueriesEnabled && joinRequestsEnabled,
        pending: pendingOf(before)
      };
    }
    mark('webhook_write');
    await api('setWebhook', {
      url: webhook, secret_token: secret, allowed_updates: [...ALLOWED_UPDATES],
      max_connections: 1, drop_pending_updates: !move && !alreadyConfigured
    });
    mark('webhook_verify');
    const after = await api('getWebhookInfo');
    if (after?.url !== webhook || after.max_connections !== 1 || !subscribedOf(after)) throw new Error('Webhook registration could not be verified');
    mark('complete');
    return { [move ? 'migrated' : 'registered']: true, alreadyConfigured, callbackQueriesEnabled: true, joinRequestsEnabled: true, pending: pendingOf(after) };
  } catch {
    // Fixed stage codes only. Never include a token, secret, URL, or upstream error.
    const error = new Error('Registration failed safely at ' + (STAGES.has(stage) ? stage : 'approval'));
    error.stage = STAGES.has(stage) ? stage : 'approval';
    throw error;
  }
}

const APPROVALS = Object.freeze({ 'CHECK-STAGING': 'inspect', 'REGISTER-STAGING': 'register', 'MIGRATE-STAGING': 'migrate', 'ROLLBACK-STAGING': 'rollback' });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const approval = process.env.TELEGRAM_REGISTRATION_APPROVAL;
  let stage = 'approval';
  try {
    const result = await registerWebhook({
      token: process.env.TELEGRAM_BOT_TOKEN,
      secret: process.env.TELEGRAM_WEBHOOK_SECRET,
      confirm: Object.hasOwn(APPROVALS, approval || ''),
      mode: APPROVALS[approval] || 'approval',
      onStage: value => { stage = value; }
    });
    console.log('REGISTRATION ' + JSON.stringify(result));
  } catch {
    console.error('Registration failed safely at stage: ' + (STAGES.has(stage) ? stage : 'approval'));
    process.exitCode = 1;
  }
}
