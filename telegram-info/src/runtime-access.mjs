// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { isAllowedPilotChat, isPilotAdmin, readBoundedJSON } from './pilot-security.mjs';
const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);

export function privateIdentity(update) {
  const message = update?.message;
  if (message?.chat?.type === 'private') {
    const chatId = Number(message.chat.id);
    const userId = Number(message.from?.id);
    if (Number.isSafeInteger(chatId) && chatId > 0 && chatId === userId) return { chatId, userId };
  }

  const query = update?.callback_query;
  if (query?.message?.chat?.type === 'private') {
    const chatId = Number(query.message.chat.id);
    const userId = Number(query.from?.id);
    if (Number.isSafeInteger(chatId) && chatId > 0 && chatId === userId) return { chatId, userId };
  }
  return null;
}

async function telegramGroupMembership(config, groupId, userId, transport = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/getChatMember`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ chat_id:groupId, user_id:userId }),
      signal:controller.signal
    });
    if (!response?.ok) return false;
    const parsed = await readBoundedJSON(response, 16384);
    if (parsed.error || parsed.value?.ok !== true) return false;
    const member = parsed.value?.result;
    if (MEMBER_STATUSES.has(member?.status)) return true;
    return member?.status === 'restricted' && member?.is_member === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function privatePilotAccessAllowed(update, config, transport = fetch) {
  const identity = privateIdentity(update);
  if (!identity) return true;
  if (isAllowedPilotChat(config, identity.chatId) || isPilotAdmin(config, identity.userId)) return true;

  const pilotGroups = Array.isArray(config?.chatIds)
    ? config.chatIds.filter(id => Number.isSafeInteger(id) && id < 0)
    : [];
  for (const groupId of pilotGroups) {
    if (await telegramGroupMembership(config, groupId, identity.userId, transport)) return true;
  }
  return false;
}

export async function sendPilotAccessNotice(config, chatId, transport = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        chat_id:chatId,
        text:'🔒 Доступ до тестової версії відкритий учасникам пілотної групи. Якщо ви вже приєдналися до групи через запрошення, відкрийте бота з групи та натисніть Start ще раз. Якщо доступ не з’явився — повідомте адміністратору групи.',
        disable_notification:true
      }),
      signal:controller.signal
    });
    const parsed = await readBoundedJSON(response, 16384);
    return response.ok && !parsed.error && parsed.value?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
