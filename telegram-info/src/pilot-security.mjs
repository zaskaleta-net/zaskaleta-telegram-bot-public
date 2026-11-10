// Telegram pilot security boundaries. No secrets or network calls on import.
const TOKEN = /^[0-9]{5,20}:[A-Za-z0-9_-]{30,}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const BOT_USERNAME = 'ZaskaletaInfoBot';
const validUserId = n => Number.isSafeInteger(n) && n > 0;
const validChatId = n => Number.isSafeInteger(n) && n !== 0;
const encoder = new TextEncoder();
const STATELESS_DIRECT_REPLY = Symbol.for('zaskaleta.telegram.statelessDirectReply');

// Legacy stateless handlers reply directly only when the live runtime routes an
// authenticated update to them. They used to infer that from a rewritten
// TELEGRAM_DELIVERY_ENABLED='false'; the explicit marker keeps the real
// delivery configuration untouched. 'false' is still honoured for the
// standalone legacy stateless mode.
export function withStatelessDirectReply(env = {}) {
  return { ...env, [STATELESS_DIRECT_REPLY]: true };
}

export function statelessDirectReplyEnabled(env = {}) {
  return env?.[STATELESS_DIRECT_REPLY] === true || env?.TELEGRAM_DELIVERY_ENABLED === 'false';
}

function parseIdList(value, validator, max = 32) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const parts = raw.split(',').map(item => item.trim());
  if (!parts.length || parts.length > max || parts.some(item => !/^-?[0-9]+$/.test(item))) return null;
  const ids = parts.map(Number);
  if (ids.some(id => !validator(id))) return null;
  return [...new Set(ids)];
}

export function pilotConfig(env = {}) {
  const mode = env.TELEGRAM_PILOT_MODE;
  if (!['allowlist', 'public'].includes(mode)) return null;

  const chatIds = parseIdList(env.TELEGRAM_ALLOWED_CHAT_IDS, validChatId, 32);
  if (chatIds === null || (mode === 'allowlist' && !chatIds.length)) return null;

  const requiredRelease = mode === 'public' ? 'public-v1' : 'pilot-v1';
  if (env.TELEGRAM_RELEASE_APPROVED !== requiredRelease || !TOKEN.test(env.TELEGRAM_BOT_TOKEN || '') || !SECRET.test(env.TELEGRAM_WEBHOOK_SECRET || '')) return null;

  const adminUserIds = parseIdList(env.TELEGRAM_ADMIN_USER_IDS, validUserId, 64);
  if (adminUserIds === null) return null;
  const bugBridgeHmacSecret = String(env.BUG_BRIDGE_HMAC_SECRET || '').trim();
  if (bugBridgeHmacSecret && !SECRET.test(bugBridgeHmacSecret)) return null;

  return {
    mode,
    chatId: chatIds[0] ?? null,
    chatIds,
    adminUserIds,
    token: env.TELEGRAM_BOT_TOKEN,
    secret: env.TELEGRAM_WEBHOOK_SECRET,
    bugBridgeHmacSecret: bugBridgeHmacSecret || null
  };
}

export function isAllowedPilotChat(config, chatId) {
  if (!config || !validChatId(chatId)) return false;
  if (config.mode === 'public') return chatId > 0;
  return Array.isArray(config.chatIds) && config.chatIds.includes(chatId);
}

// TG-RUNTIME-082: the group features (welcome, /panel) run only in a group
// named in TELEGRAM_ALLOWED_CHAT_IDS, in both modes. Public mode still refuses
// every other group and all ordinary group replies (isAllowedPilotChat).
export function isListedGroupChat(config, chatId) {
  return !!config && validChatId(chatId) && chatId < 0 && Array.isArray(config.chatIds) && config.chatIds.includes(chatId);
}

export function isPilotAdmin(config, userId) {
  return !!config && validUserId(userId) && Array.isArray(config.adminUserIds) && config.adminUserIds.includes(userId);
}

export function isAdminCommand(text) {
  return /^\/(?:admin|debug|health|queue|audit|stats|status)(?:@ZaskaletaInfoBot)?(?:\s|$)/i.test(String(text || '').trim());
}

export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > 256) return false;
  const x = encoder.encode(a), y = encoder.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

function trustedBotReply(m) {
  const replied = m?.reply_to_message;
  const repliedUsername = replied?.from?.username;
  const trusted = replied && replied.chat?.id === m.chat?.id && replied.from?.is_bot === true && (repliedUsername === undefined || repliedUsername === BOT_USERNAME);
  if (!trusted) return { text: '', messageId: null };
  return {
    text: typeof replied.text === 'string' ? replied.text.slice(0, 4000) : typeof replied.caption === 'string' ? replied.caption.slice(0, 4000) : '',
    messageId: validUserId(replied.message_id) ? replied.message_id : null
  };
}

function groupTrigger(text, reply) {
  const source = String(text || '').trim();
  if (!source) return null;
  const command = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(source);
  if (command) {
    if (command[2] && command[2].toLowerCase() !== BOT_USERNAME.toLowerCase()) return null;
    return 'command';
  }
  if (reply.messageId) return 'reply';
  if (new RegExp(`@${BOT_USERNAME}\\b`, 'i').test(source)) return 'mention';
  if (/^(?:🏠 Житло|🏛 Jobcenter|💼 Робота|🎓 Курси|👨‍👩‍👧 Школа \/ Kita|🚌 Транспорт|📄 Документи|👶 Kindergeld|5 км|10 км|15 км|25 км|50 км|🔎\s+)/u.test(source)) return 'button';
  // Natural group requests are deliberately narrow to avoid reacting to ordinary conversation.
  if (/^(?:житло|квартира|wohnung|jobcenter)\s*[:—-]\s*\S/iu.test(source)) return 'natural';
  return null;
}

function stripDirectMention(text) {
  return String(text || '').replace(new RegExp(`@${BOT_USERNAME}\\b[:,]?\\s*`, 'ig'), '').trim();
}

export function normalizePilotUpdate(p, now = Date.now()) {
  if (!Number.isFinite(now) || now < 0 || !Number.isSafeInteger(p?.update_id) || p.update_id < 0) return null;
  const m = p.message;
  if (!m || !validChatId(m.chat?.id) || !validUserId(m.from?.id) || !validUserId(m.message_id) || m.from.is_bot === true || !Number.isSafeInteger(m.date) || m.date < 0) return null;
  const chatType = m.chat?.type;
  if (!['private', 'group', 'supergroup'].includes(chatType)) return null;
  if (chatType === 'private') {
    if (m.chat.id !== m.from.id || m.chat.id < 1) return null;
  } else if (m.chat.id >= 0) return null;

  const age = now - m.date * 1000;
  if (age < -60000 || age > 300000) return null;
  const reply = trustedBotReply(m);
  const rawText = typeof m.text === 'string' ? m.text.slice(0, 4000) : '';
  const trigger = chatType === 'private' ? 'private' : groupTrigger(rawText, reply);
  if (!trigger) return null;
  const text = trigger === 'mention' ? stripDirectMention(rawText) : rawText;
  if (!text.trim()) return null;
  return {
    id: p.update_id,
    chatId: m.chat.id,
    chatType,
    userId: m.from.id,
    messageId: m.message_id,
    text,
    replyToText: reply.text,
    replyToMessageId: reply.messageId,
    trigger
  };
}

export async function readBoundedJSON(request, maxBytes = 65536) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > maxBytes)) return { error: 'too_large' };
  const reader = request.body?.getReader();
  if (!reader) return { error: 'invalid' };
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => {}); return { error: 'too_large' }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch { return { error: 'invalid' }; }
}

export async function sendPilotMessage(claim, env = {}, transport = fetch) {
  const config = pilotConfig(env);
  if (env.TELEGRAM_DELIVERY_ENABLED !== 'true' || !config || !isAllowedPilotChat(config, claim?.chatId) || typeof claim.text !== 'string' || !claim.text.trim() || claim.text.length > 4096) return { status: 'disabled' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: claim.chatId, text: claim.text, disable_notification: true, link_preview_options: { is_disabled: true } }),
      signal: controller.signal
    });
    const parsed = await readBoundedJSON(response, 16384);
    if (parsed.error) return { status: 'uncertain' };
    const data = parsed.value;
    if (response.ok && data?.ok === true && validUserId(data.result?.message_id) && data.result?.chat?.id === claim.chatId) return { status: 'sent', messageId: data.result.message_id };
    if (response.status === 429 && data?.ok === false && data.error_code === 429) {
      const seconds = Number(data.parameters?.retry_after);
      return { status: 'rate_limited', retryAfter: Number.isFinite(seconds) ? Math.max(1, Math.min(3600, Math.ceil(seconds))) : 60 };
    }
    if (response.status >= 500 || response.ok) return { status: 'uncertain' };
    return { status: 'rejected', errorCode: response.status };
  } catch { return { status: 'uncertain' }; }
  finally { clearTimeout(timeout); }
}
