// Durable private bug-report state: accept the next message after /report without Telegram ForceReply.
import { pilotConfig, equalSecret, readBoundedJSON } from './pilot-security.mjs';
import { privatePilotAccessAllowed } from './runtime-access.mjs';

const STATELESS_PATH = '/telegram/stateless';
const REPORT_STATE_PATH = '/report-state';
const REPORT_STATE_PREFIX = 'telegram-report-pending:v1:';
const REPORT_STATE_TTL_MS = 15 * 60 * 1000;
const REPORT_PROMPT_PREFIX = '🐞 Повідомлення про помилку';
const REPORT_BUTTON = '🐞 Повідомити про помилку';
const TELEGRAM_TIMEOUT_MS = 8000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function validPrivateIdentity(chatId, userId) {
  return Number.isSafeInteger(chatId) && chatId > 0 && chatId === userId;
}

function key(chatId, userId) {
  return `${REPORT_STATE_PREFIX}${chatId}:${userId}`;
}

function reportAction(text) {
  const source = String(text || '').trim();
  return /^\/report(?:@ZaskaletaInfoBot)?\s*$/iu.test(source)
    || /^\/start(?:@ZaskaletaInfoBot)?\s+report\s*$/iu.test(source)
    || source === REPORT_BUTTON;
}

function navigationAction(text) {
  const source = String(text || '').trim();
  return /^(?:\/start(?:@ZaskaletaInfoBot)?|\/(?:menu|panel)(?:@ZaskaletaInfoBot)?|☰\s*Меню)\s*$/iu.test(source)
    || /^(?:🏠 Житло|🏛 Jobcenter|💼 Робота|🎓 Курси|👨‍👩‍👧 Школа \/ Kita|🚌 Транспорт|📄 Документи|👶 Kindergeld|🗞 Новини)$/u.test(source);
}

function isReportReply(message) {
  return String(message?.reply_to_message?.text || '').startsWith(REPORT_PROMPT_PREFIX);
}

function reportPromptMessageId(message, chatId) {
  const prompt = message?.reply_to_message;
  if (!String(prompt?.text || '').startsWith(REPORT_PROMPT_PREFIX)) return null;
  if (prompt?.from?.is_bot !== true || Number(prompt?.chat?.id) !== chatId) return null;
  const messageId = Number(prompt?.message_id);
  return Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
}

async function deleteReportPromptOnNavigation(config, message, chatId, transport) {
  const messageId = reportPromptMessageId(message, chatId);
  if (!messageId) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/deleteMessage`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ chat_id:chatId, message_id:messageId }),
      signal:controller.signal
    });
    const parsed = await readBoundedJSON(response, 8192);
    return response.ok && !parsed.error && parsed.value?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function hasReportContent(message) {
  return Array.isArray(message?.photo)
    || !!message?.document
    || !!String(message?.text || message?.caption || '').trim();
}

async function stateCall(env, payload) {
  if (!env?.OUTBOX) return { status:'unavailable' };
  try {
    const id = env.OUTBOX.idFromName('telegram-pilot-v1');
    const response = await env.OUTBOX.get(id).fetch(`https://outbox.internal${REPORT_STATE_PATH}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(payload)
    });
    if (!response.ok) return { status:'unavailable' };
    const parsed = await readBoundedJSON(response, 8192);
    return parsed.error ? { status:'unavailable' } : parsed.value;
  } catch {
    return { status:'unavailable' };
  }
}

function rebuildRequest(request, update) {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, {
    method:'POST',
    headers,
    body:JSON.stringify(update)
  });
}

export async function prepareReportState(request, env = {}, now = Date.now(), transport = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') {
    return { request, clearAfter:null };
  }

  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) {
    return { request, clearAfter:null };
  }

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return { request, clearAfter:null };
  const update = parsed.value;
  const message = update?.message;
  const chatId = Number(message?.chat?.id);
  const userId = Number(message?.from?.id);

  if (message?.chat?.type !== 'private' || !validPrivateIdentity(chatId, userId) || message?.from?.is_bot === true) {
    return { request, clearAfter:null };
  }
  if (!(await privatePilotAccessAllowed(update, config, transport))) return { request, clearAfter:null };
  if (!Number.isSafeInteger(now) || now < 0) return { request, clearAfter:null };

  const text = String(message?.text || '').trim();

  if (reportAction(text)) {
    await stateCall(env, { op:'put', chatId, userId, now });
    return { request, clearAfter:null };
  }

  if (navigationAction(text)) {
    await stateCall(env, { op:'clear', chatId, userId, now });
    if (!isReportReply(message)) return { request, clearAfter:null };
    await deleteReportPromptOnNavigation(config, message, chatId, transport);
    const copy = JSON.parse(JSON.stringify(update));
    delete copy.message.reply_to_message;
    return { request:rebuildRequest(request, copy), clearAfter:null };
  }

  if (isReportReply(message) && hasReportContent(message)) {
    return { request, clearAfter:{ chatId, userId, now } };
  }

  if (!hasReportContent(message) || text.startsWith('/')) return { request, clearAfter:null };

  const pending = await stateCall(env, { op:'read', chatId, userId, now });
  if (pending?.status !== 'ok' || pending?.active !== true) return { request, clearAfter:null };

  const copy = JSON.parse(JSON.stringify(update));
  copy.message.reply_to_message = {
    text:REPORT_PROMPT_PREFIX,
    chat:{ id:chatId, type:'private' },
    from:{ id:999999999, is_bot:true, username:'ZaskaletaInfoBot' }
  };
  return {
    request:rebuildRequest(request, copy),
    clearAfter:{ chatId, userId, now }
  };
}

export async function finishReportState(clearAfter, response, env = {}) {
  if (!clearAfter || !(response instanceof Response) || response.status >= 500) return false;
  const result = await stateCall(env, { op:'clear', ...clearAfter });
  return result?.status === 'ok';
}

export async function handleReportStorage(request, outbox) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== REPORT_STATE_PATH) return null;

  const parsed = await readBoundedJSON(request.clone(), 8192);
  const value = parsed.error ? null : parsed.value;
  const chatId = Number(value?.chatId);
  const userId = Number(value?.userId);
  const now = Number(value?.now);
  if (!validPrivateIdentity(chatId, userId) || !Number.isSafeInteger(now) || now < 0) {
    return json({ status:'bad_operation' }, 400);
  }

  const storageKey = key(chatId, userId);
  try {
    if (value.op === 'clear') {
      await outbox.householdContextStorage.delete(storageKey);
      return json({ status:'ok' });
    }
    if (value.op === 'put') {
      await outbox.householdContextStorage.put(storageKey, { updatedAt:now });
      return json({ status:'ok' });
    }
    if (value.op === 'read') {
      const stored = await outbox.householdContextStorage.get(storageKey);
      if (!stored || !Number.isSafeInteger(stored.updatedAt) || stored.updatedAt < now - REPORT_STATE_TTL_MS) {
        if (stored) await outbox.householdContextStorage.delete(storageKey);
        return json({ status:'ok', active:false });
      }
      return json({ status:'ok', active:true });
    }
    return json({ status:'bad_operation' }, 400);
  } catch {
    return json({ status:'unavailable' }, 503);
  }
}
