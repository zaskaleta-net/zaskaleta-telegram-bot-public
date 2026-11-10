import { readBoundedJSON } from './pilot-security.mjs';

const BOT_USERNAME = 'ZaskaletaInfoBot';
const TELEGRAM_TIMEOUT_MS = 8000;

// TG-RUNTIME-082: short pinned panel with big buttons.
export const GROUP_LAUNCH_PANEL_TEXT = [
  '🤖 Schleswig-Holstein Помічник 🇺🇦🇩🇪',
  '',
  'Житло, Jobcenter, документи, курси, школа / Kita — в особистому чаті з ботом.',
  '🔐 Ваші запити й результати в групі не публікуються.',
  '',
  '🧪 Beta. Помітили помилку — натисніть кнопку нижче.'
].join('\n');

export const GROUP_MEMBER_PANEL_TEXT = '🤖 Помічник відповідає в особистому чаті. Натисніть кнопку нижче.';

export function groupLaunchPanelKeyboard() {
  return {
    inline_keyboard:[
      [{ text:'🤖 Відкрити помічник', url:`https://t.me/${BOT_USERNAME}?start=assistant` }],
      [{ text:'🐞 Повідомити про помилку', url:`https://t.me/${BOT_USERNAME}?start=report` }]
    ]
  };
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

export async function sendGroupMemberPanel(config, chatId, replyTo, transport = fetch) {
  if (!config || !Number.isSafeInteger(chatId) || chatId >= 0) return false;
  const payload = {
    chat_id:chatId,
    text:GROUP_MEMBER_PANEL_TEXT,
    disable_notification:true,
    link_preview_options:{ is_disabled:true },
    reply_markup:{ inline_keyboard:[[{ text:'🤖 Відкрити помічник', url:`https://t.me/${BOT_USERNAME}?start=assistant` }]] }
  };
  if (Number.isSafeInteger(replyTo) && replyTo > 0) payload.reply_parameters = { message_id:replyTo, allow_sending_without_reply:true };
  return (await telegramJSON(config, 'sendMessage', payload, transport)).ok;
}

export async function isGroupAdministrator(config, chatId, userId, transport = fetch) {
  if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0) return false;
  const admins = await telegramJSON(config, 'getChatAdministrators', { chat_id:chatId }, transport, 5000);
  const members = admins.data?.result;
  if (!admins.ok || !Array.isArray(members)) return false;
  return members.some(member => member?.user?.id === userId && ['creator','administrator'].includes(member?.status));
}

export async function publishAndPinGroupLaunchPanel(config, chatId, transport = fetch) {
  if (!config || !Number.isSafeInteger(chatId) || chatId >= 0) return { sent:false, pinned:false, reason:'invalid_chat' };

  const sent = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text:GROUP_LAUNCH_PANEL_TEXT,
    disable_notification:true,
    link_preview_options:{ is_disabled:true },
    reply_markup:groupLaunchPanelKeyboard()
  }, transport);

  const messageId = Number(sent.data?.result?.message_id);
  if (!sent.ok || !Number.isSafeInteger(messageId) || messageId <= 0 || sent.data?.result?.chat?.id !== chatId) {
    return { sent:false, pinned:false, reason:'send_failed' };
  }

  const pinned = await telegramJSON(config, 'pinChatMessage', {
    chat_id:chatId,
    message_id:messageId,
    disable_notification:true
  }, transport, 5000);

  return {
    sent:true,
    pinned:pinned.ok,
    messageId,
    reason:pinned.ok ? 'pinned' : 'pin_failed'
  };
}
