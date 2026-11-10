// Owner-gated one-shot Telegram transport test.
// Reads only the existing Worker settings to resolve the single allowlisted chat.
// Never touches Durable Objects, webhook configuration, deployments, R2 or billing.
// Exactly one sendMessage request is attempted; there is deliberately no retry.
import { pathToFileURL } from 'node:url';

const WORKER = 'zaskaleta-info-telegram-staging';
const EXPECTED_BOT = 'ZaskaletaInfoBot';
const CF_ROOT = 'https://api.cloudflare.com/client/v4';
const TG_ROOT = 'https://api.telegram.org';
const TOKEN = /^[0-9]{5,20}:[A-Za-z0-9_-]{30,}$/;
const ACCOUNT = /^[a-f0-9]{32}$/i;
const CHAT = /^[1-9][0-9]*$/;
const MESSAGE = '✅ Schleswig-Holstein Помічник: одноразовий тест доставки пройдено. Durable Objects і стара черга не використовувались.';

async function boundedJSON(response, limit = 16384) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) throw new Error('unexpected_content_type');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty_response');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new Error('oversized_response');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function sendOneShotTest({
  approval,
  telegramToken,
  cloudflareToken,
  accountId,
  fetchImpl = fetch
} = {}) {
  if (approval !== 'SEND-TEST') throw new Error('approval_required');
  if (!TOKEN.test(telegramToken || '')) throw new Error('telegram_config_invalid');
  if (!cloudflareToken || !ACCOUNT.test(accountId || '')) throw new Error('cloudflare_config_invalid');

  let stage = 'settings';
  try {
    const settingsResponse = await fetchImpl(`${CF_ROOT}/accounts/${accountId}/workers/scripts/${WORKER}/settings`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cloudflareToken}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    });
    const settingsData = await boundedJSON(settingsResponse);
    if (!settingsResponse.ok || settingsData?.success !== true || !Array.isArray(settingsData.result?.bindings)) throw new Error('settings_unverified');
    const bindings = new Map(settingsData.result.bindings.map(binding => [binding?.name, binding]));
    const text = name => bindings.get(name)?.text;
    if (text('TELEGRAM_DELIVERY_ENABLED') !== 'false') throw new Error('delivery_not_disabled');
    if (text('TELEGRAM_PILOT_MODE') !== 'allowlist' || text('TELEGRAM_RELEASE_APPROVED') !== 'pilot-v1') throw new Error('pilot_not_approved');
    const chatText = String(text('TELEGRAM_ALLOWED_CHAT_IDS') || '');
    if (!CHAT.test(chatText)) throw new Error('allowlist_invalid');
    const chatId = Number(chatText);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error('allowlist_invalid');

    async function telegram(method, body = {}) {
      const response = await fetchImpl(`${TG_ROOT}/bot${telegramToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10000)
      });
      const data = await boundedJSON(response);
      if (!response.ok || data?.ok !== true) throw new Error(`${method}_rejected`);
      return data.result;
    }

    stage = 'identity';
    const me = await telegram('getMe');
    if (me?.is_bot !== true || me?.username !== EXPECTED_BOT || me?.id !== Number(telegramToken.split(':')[0])) throw new Error('identity_mismatch');

    stage = 'send';
    // This is the only outgoing message request in this script. Do not add retries.
    const sent = await telegram('sendMessage', {
      chat_id: chatId,
      text: MESSAGE,
      disable_notification: true,
      link_preview_options: { is_disabled: true }
    });
    if (!Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0 || sent?.chat?.id !== chatId) throw new Error('send_unverified');
    return Object.freeze({ sent: true, messageId: sent.message_id, durableObjectsUsed: false, queueTouched: false, webhookChanged: false });
  } catch {
    throw new Error(`one_shot_failed_${stage}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await sendOneShotTest({
      approval: process.env.TELEGRAM_ONE_SHOT_APPROVAL,
      telegramToken: process.env.TELEGRAM_BOT_TOKEN,
      cloudflareToken: process.env.CLOUDFLARE_API_TOKEN,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID
    });
    console.log('ONE_SHOT ' + JSON.stringify(result));
  } catch (error) {
    // Fixed stage-only error. Never print secrets, chat IDs, settings or upstream payloads.
    console.error('ONE_SHOT_FAILED ' + String(error?.message || 'one_shot_failed'));
    process.exitCode = 1;
  }
}
