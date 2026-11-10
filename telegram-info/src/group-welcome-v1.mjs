import { pilotConfig, equalSecret, isListedGroupChat, readBoundedJSON } from './pilot-security.mjs';

const BOT_USERNAME = 'ZaskaletaInfoBot';
const STATELESS_PATH = '/telegram/stateless';
const TELEGRAM_TIMEOUT_MS = 8000;
const ASSISTANT_URL = `https://t.me/${BOT_USERNAME}?start=welcome`;
const HELP_URL = `https://t.me/${BOT_USERNAME}?start=help`;
const GROUP_DISPLAY_NAME = 'Українці Schleswig-Holstein';
const ROOM_RETRY = /^Для житла\s*[—–-]\s*([^\n]{1,80}?)\s+вкажіть кількість кімнат(?:\s|$)/iu;
const ROOM_VALUE = /^\s*\d{1,2}(?:\s*[-–—/]\s*\d{1,2})?\s*$/u;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function cleanText(value, max = 80) {
  return String(value || '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

export function humanNewMembers(update) {
  const members = Array.isArray(update?.message?.new_chat_members) ? update.message.new_chat_members : [];
  return members.filter(member => {
    const id = Number(member?.id);
    return Number.isSafeInteger(id) && id > 0 && member?.is_bot !== true && String(member?.username || '') !== BOT_USERNAME;
  });
}

function memberLabel(member) {
  // Use only Telegram first_name in the public welcome. It is shorter and avoids
  // exposing/stale-surfacing a surname when the member's visible profile label differs.
  return cleanText(member?.first_name, 48) || 'новий учасник';
}

function joinedNames(members) {
  const labels = members.slice(0, 5).map(memberLabel);
  if (members.length > 5) labels.push(`ще ${members.length - 5}`);
  if (labels.length <= 1) return labels[0] || 'нові учасники';
  if (labels.length === 2) return `${labels[0]} та ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} та ${labels.at(-1)}`;
}

export function buildWelcomeText(update, members = humanNewMembers(update)) {
  const people = joinedNames(members);
  return [
    `👋 Вітаємо, ${people}!`,
    '',
    `🇺🇦 Раді бачити вас у групі «${GROUP_DISPLAY_NAME}».`,
    '',
    'Тут: житло, Jobcenter, документи, курси, школа / Kita, транспорт, новини та події.',
    '',
    '🤖 Персональні запити — у Schleswig-Holstein Помічнику.',
    '📌 Спочатку перегляньте закріплене повідомлення.',
    '🐞 Помилка? Надішліть скріншот через кнопку в боті.',
    '',
    '🧪 BETA-режим.'
  ].join('\n');
}

async function telegramJSON(config, method, payload, transport = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/${method}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(payload),
      signal:controller.signal
    });
    const parsed = await readBoundedJSON(response, 32768);
    return { ok:response.ok && !parsed.error && parsed.value?.ok === true, data:parsed.error ? null : parsed.value };
  } catch {
    return { ok:false, data:null };
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleGroupWelcomeRequest(request, env = {}, transport = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;

  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const update = parsed.value;
  const message = update?.message;
  const chatId = Number(message?.chat?.id);
  if (!['group','supergroup'].includes(message?.chat?.type) || !isListedGroupChat(config, chatId)) return null;

  const members = humanNewMembers(update);
  if (!members.length) {
    if (Array.isArray(message?.new_chat_members) && message.new_chat_members.length) {
      return json({ ok:true, mode:'group-welcome', ignored:true, reason:'no_human_members' });
    }
    return null;
  }

  const result = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text:buildWelcomeText(update, members),
    disable_notification:true,
    link_preview_options:{ is_disabled:true },
    reply_markup:{
      inline_keyboard:[
        [{ text:'🤖 Відкрити помічник', url:ASSISTANT_URL }],
        [{ text:'📌 Як користуватися', url:HELP_URL }]
      ]
    }
  }, transport);

  return json({
    ok:true,
    mode:'group-welcome',
    delivered:result.ok,
    memberCount:members.length
  });
}

export async function normalizeWelcomeDeepLinkRequest(request) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST') return request;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return request;
  const message = parsed.value?.message;
  if (message?.chat?.type !== 'private') return request;

  const text = String(message?.text || '').trim();
  const previous = String(message?.reply_to_message?.text || '').trim();
  const roomRetry = ROOM_VALUE.test(text) ? ROOM_RETRY.exec(previous) : null;
  if (roomRetry) {
    const location = String(roomRetry[1] || '').replace(/\s+/gu, ' ').trim();
    if (location) {
      const copy = JSON.parse(JSON.stringify(parsed.value));
      copy.message.reply_to_message.text = `Тема: житло — ${location}. Локацію вже визначено.\nВкажіть кількість кімнат, наприклад: 3 або 3-4.`;
      const headers = new Headers(request.headers);
      headers.delete('content-length');
      return new Request(request.url, { method:'POST', headers, body:JSON.stringify(copy) });
    }
  }

  const match = /^\/start(?:@ZaskaletaInfoBot)?\s+(welcome|help)\s*$/iu.exec(text);
  if (!match) return request;

  const copy = JSON.parse(JSON.stringify(parsed.value));
  copy.message.text = match[1].toLowerCase() === 'help' ? '/help' : '/start';
  delete copy.message.reply_to_message;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method:'POST', headers, body:JSON.stringify(copy) });
}
