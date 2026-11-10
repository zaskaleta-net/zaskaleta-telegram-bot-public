// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { pilotConfig, equalSecret, isAllowedPilotChat, isListedGroupChat, isPilotAdmin, readBoundedJSON } from './pilot-security.mjs';
import { privateIdentity, privatePilotAccessAllowed, sendPilotAccessNotice } from './runtime-access.mjs';
import { syncBotCommandMetadata, botCommandsFor } from './bot-command-sync.mjs';
import { handlePilotCommunityUpdate, isNewsCommand } from './pilot-community.mjs';
import { sendSafeNewsDigestToChatV2 } from './news-quality-v2.mjs';
import { publishAndPinGroupLaunchPanel, isGroupAdministrator, sendGroupMemberPanel } from './group-launch-panel-v1.mjs';
import { handleGroupWelcomeRequest, normalizeWelcomeDeepLinkRequest } from './group-welcome-v1.mjs';
import { groupNewsPointerPayload } from './channel-membership-gate.mjs';
const community = (() => {
const STATELESS_PATH = '/telegram/stateless';












function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function isPrivateMenuCommand(update) {
  return update?.message?.chat?.type === 'private' && /^\/menu(?:@ZaskaletaInfoBot)?\s*$/iu.test(String(update?.message?.text || '').trim());
}

function privateMenuAsStartRequest(request, update) {
  if (!isPrivateMenuCommand(update)) return request;
  const copy = JSON.parse(JSON.stringify(update));
  copy.message.text = '/start';
  delete copy.message.reply_to_message;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method:'POST', headers, body:JSON.stringify(copy) });
}





function shouldSyncCommands(update) {
  return /^\/(?:start|menu)(?:@ZaskaletaInfoBot)?(?:\s|$)/iu.test(String(update?.message?.text || '').trim());
}
async function handleCommunity(request, env = {}, now = Date.now(), transport = fetch) {
  const productTransport = transport;
  const url = new URL(request.url);
  if (url.pathname === STATELESS_PATH && request.method === 'POST') {
    const config = pilotConfig(env);
    if (config && env.TELEGRAM_INGRESS_ENABLED === 'true' &&
        equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) {
      const parsed = await readBoundedJSON(request.clone(), 65536);
      if (!parsed.error) {
        const update = parsed.value;
        const identity = privateIdentity(update);
        if (identity && !(await privatePilotAccessAllowed(update, config, transport))) {
          await sendPilotAccessNotice(config, identity.chatId, transport);
          console.info('TELEGRAM_PILOT_PRIVATE_GATE', JSON.stringify({ allowed:false, reason:'not_allowlisted_or_group_member' }));
          return json({ ok:true, ignored:true, mode:'closed-pilot' });
        }

        const message = update?.message;
        const chatId = Number(message?.chat?.id);
        const chatType = message?.chat?.type;
        const groupAllowed = ['group','supergroup'].includes(chatType) && isAllowedPilotChat(config, chatId);
        const privateAllowed = chatType === 'private' && !!identity;

        if ((privateAllowed || groupAllowed) && shouldSyncCommands(update)) {
          const commandSync = await syncBotCommandMetadata(config, transport, Number.isSafeInteger(chatId) ? chatId : null, { commands:botCommandsFor(env) });
          console.info('TELEGRAM_COMMAND_SYNC', JSON.stringify({ status:commandSync.status }));
        }

        if (privateAllowed || groupAllowed) {
          const communityResponse = await handlePilotCommunityUpdate(update, config, now, productTransport);
          if (communityResponse) return communityResponse;

          // TG-RUNTIME-115: a digest only in a private chat; a group gets the
          // pointer to the news channel (safeGroupNewsCommand answers first).
          if (isNewsCommand(update) && privateAllowed) {
            const result = await sendSafeNewsDigestToChatV2(config, chatId, env, now, productTransport);
            return json({ ok:true, mode:'pilot-news-command-v2', delivered:result.ok, sent:result.sent, reason:result.reason });
          }
        }

        if (privateAllowed && isPrivateMenuCommand(update)) {
          return { request:privateMenuAsStartRequest(request, update) };
        }
      }
    }
  }
  return null;
}
return { handleCommunity };
})();
const group = (() => {
const DAILY_NEWS_PREFIX = 'telegram-daily-news:v2:';
const STATELESS_PATH = '/telegram/stateless';
const GROUP_PANEL_COMMAND = /^\/(?:panel|menu)(?:@ZaskaletaInfoBot)?\s*$/iu;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function pilotGroups(config) {
  return [...new Set((config?.chatIds || []).filter(id => Number.isSafeInteger(id) && id < 0))];
}


async function groupNewsPointer(config, chatId, replyTo, transport) {
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(groupNewsPointerPayload(chatId, replyTo)), signal:AbortSignal.timeout(8000)
    });
    const parsed = await readBoundedJSON(response, 32768);
    return response.ok && parsed.value?.ok === true;
  } catch {
    return false;
  }
}

async function safeGroupNewsCommand(request, env, now, transport) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;

  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error || !isNewsCommand(parsed.value)) return null;

  const message = parsed.value?.message;
  const chatId = Number(message?.chat?.id);
  const chatType = message?.chat?.type;
  // A listed group gets the pointer in public mode too (isListedGroupChat).
  const groupAllowed = ['group','supergroup'].includes(chatType) && (isAllowedPilotChat(config, chatId) || isListedGroupChat(config, chatId));
  if (!groupAllowed) return null;

  // TG-RUNTIME-115: no digest in a group; news live in the channel.
  const sent = await groupNewsPointer(config, chatId, Number(message?.message_id), transport);
  return json({ ok:true, mode:'group-news-pointer', delivered:sent });
}

async function professionalGroupPanelCommand(request, env, transport) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;

  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const message = parsed.value?.message;
  if (!GROUP_PANEL_COMMAND.test(String(message?.text || '').trim())) return null;

  const chatId = Number(message?.chat?.id);
  const userId = Number(message?.from?.id);
  const groupAllowed = ['group','supergroup'].includes(message?.chat?.type) && isListedGroupChat(config, chatId);
  if (!groupAllowed) return null;

  // TG-RUNTIME-082: a member gets a short answer with the assistant button
  // (silence before); only an administrator publishes and pins the panel.
  if (!(await isGroupAdministrator(config, chatId, userId, transport))) {
    const sent = await sendGroupMemberPanel(config, chatId, Number(message?.message_id), transport);
    return json({ ok:true, mode:'group-member-panel', delivered:sent, reason:'admin_required' });
  }

  const result = await publishAndPinGroupLaunchPanel(config, chatId, transport);
  return json({ ok:true, mode:'group-launch-panel', delivered:result.sent, pinned:result.pinned, reason:result.reason });
}
async function handleGroupCommands(request, env = {}, now = Date.now(), transport = fetch) {
  const welcomeResponse = await handleGroupWelcomeRequest(request, env, transport);
  if (welcomeResponse) return welcomeResponse;

  const normalizedRequest = await normalizeWelcomeDeepLinkRequest(request);

  const panelResponse = await professionalGroupPanelCommand(normalizedRequest, env, transport);
  if (panelResponse) return panelResponse;

  const newsResponse = await safeGroupNewsCommand(normalizedRequest, env, now, transport);
  if (newsResponse) return newsResponse;

  return { request:normalizedRequest };
}
return { handleGroupCommands };
})();
const reports = (() => {
const STATELESS_PATH = '/telegram/stateless';
const REPORT_PROMPT_PREFIX = '🐞 Повідомлення про помилку';

function isReportSubmission(update) {
  const message = update?.message;
  if (message?.chat?.type !== 'private') return false;
  const replied = String(message?.reply_to_message?.text || '');
  if (!replied.startsWith(REPORT_PROMPT_PREFIX)) return false;
  return Array.isArray(message?.photo) || !!message?.document || !!String(message?.text || message?.caption || '').trim();
}

async function discoverPilotGroupOwners(config, transport = fetch) {
  const owners = new Set();
  const groups = Array.isArray(config?.chatIds)
    ? config.chatIds.filter(id => Number.isSafeInteger(id) && id < 0)
    : [];

  for (const chatId of groups) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await transport(`https://api.telegram.org/bot${config.token}/getChatAdministrators`, {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ chat_id:chatId }),
        signal:controller.signal
      });
      if (!response?.ok) continue;
      const parsed = await readBoundedJSON(response, 32768);
      if (parsed.error || parsed.value?.ok !== true || !Array.isArray(parsed.value?.result)) continue;
      for (const member of parsed.value.result) {
        const userId = Number(member?.user?.id);
        if (member?.status === 'creator' && member?.user?.is_bot !== true && Number.isSafeInteger(userId) && userId > 0) {
          owners.add(userId);
        }
      }
    } catch {
      // Keep the existing configured admin routing if owner discovery is unavailable.
    } finally {
      clearTimeout(timeout);
    }
  }

  return [...owners];
}

async function envWithReportRecipients(request, env = {}, transport = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST') return env;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error || !isReportSubmission(parsed.value)) return env;

  const config = pilotConfig(env);
  if (!config) return env;

  const owners = await discoverPilotGroupOwners(config, transport);
  const recipients = new Set([
    ...(Array.isArray(config.adminUserIds) ? config.adminUserIds : []),
    ...owners
  ]);
  if (!recipients.size) return env;

  return { ...env, TELEGRAM_ADMIN_USER_IDS:[...recipients].join(',') };
}

// Configured admins plus the owners of the configured groups.
async function reportRecipients(env = {}, transport = fetch) {
  const config = pilotConfig(env);
  if (!config) return [];
  const owners = await discoverPilotGroupOwners(config, transport);
  return [...new Set([...(Array.isArray(config.adminUserIds) ? config.adminUserIds : []), ...owners])];
}
return { envWithReportRecipients, reportRecipients };
})();

export const handleCommunity = community.handleCommunity;
export const handleGroupCommands = group.handleGroupCommands;
export const envWithReportRecipients = reports.envWithReportRecipients;
export const reportRecipients = reports.reportRecipients;
