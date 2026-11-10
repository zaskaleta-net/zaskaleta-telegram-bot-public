import { pilotConfig, equalSecret, isAllowedPilotChat, isPilotAdmin, readBoundedJSON } from './pilot-security.mjs';
import { isGroupAdministrator } from './group-launch-panel-v1.mjs';

const STATELESS_PATH = '/telegram/stateless';
const STATS_COMMAND = /^\/stats(?:@ZaskaletaInfoBot)?\s*$/iu;
const TELEGRAM_TIMEOUT_MS = 8000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function pilotGroups(config) {
  return [...new Set((config?.chatIds || []).filter(id => Number.isSafeInteger(id) && id < 0))];
}

async function telegramJSON(config, method, payload, transport = fetch, timeoutMs = TELEGRAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/${method}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(payload),
      signal:controller.signal
    });
    const parsed = await readBoundedJSON(response, 32768);
    return {
      ok:response.ok && !parsed.error && parsed.value?.ok === true,
      data:parsed.error ? null : parsed.value
    };
  } catch {
    return { ok:false, data:null };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendStatsMessage(config, chatId, text, transport) {
  return telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text,
    disable_notification:true,
    link_preview_options:{ is_disabled:true }
  }, transport);
}

function statsText(count) {
  return [
    '📊 Статистика групи',
    '',
    `👥 Учасників зараз: ${count}`,
    '',
    'Джерело: Telegram API · live'
  ].join('\n');
}

export async function handleGroupStatsRequest(request, env = {}, transport = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;

  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;

  const message = parsed.value?.message;
  if (!message || !STATS_COMMAND.test(String(message?.text || '').trim()) || message?.from?.is_bot === true) return null;

  const chatId = Number(message?.chat?.id);
  const userId = Number(message?.from?.id);
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(userId) || userId <= 0) return null;

  let targetGroupId = null;
  let replyChatId = null;

  if (['group','supergroup'].includes(message?.chat?.type)) {
    if (!isAllowedPilotChat(config, chatId)) return null;
    if (!(await isGroupAdministrator(config, chatId, userId, transport))) {
      return json({ ok:true, mode:'group-stats-live', ignored:true, reason:'admin_required' });
    }
    targetGroupId = chatId;
    replyChatId = chatId;
  } else if (message?.chat?.type === 'private' && chatId === userId) {
    if (!isPilotAdmin(config, userId)) {
      return json({ ok:true, mode:'group-stats-live', ignored:true, reason:'admin_required' });
    }
    const groups = pilotGroups(config);
    if (groups.length !== 1) {
      const sent = await sendStatsMessage(config, chatId, '📊 Для точної статистики введіть /stats безпосередньо в потрібній групі.', transport);
      return json({ ok:true, mode:'group-stats-live', delivered:sent.ok, reason:'group_selection_required' });
    }
    targetGroupId = groups[0];
    replyChatId = chatId;
  } else {
    return null;
  }

  const countResult = await telegramJSON(config, 'getChatMemberCount', { chat_id:targetGroupId }, transport, 5000);
  const count = Number(countResult.data?.result);
  if (!countResult.ok || !Number.isSafeInteger(count) || count < 0) {
    const sent = await sendStatsMessage(config, replyChatId, '⚠️ Не вдалося отримати live-кількість учасників від Telegram. Спробуйте /stats ще раз пізніше.', transport);
    return json({ ok:true, mode:'group-stats-live', delivered:sent.ok, reason:'telegram_count_failed' });
  }

  const sent = await sendStatsMessage(config, replyChatId, statsText(count), transport);
  return json({ ok:true, mode:'group-stats-live', delivered:sent.ok, count });
}
