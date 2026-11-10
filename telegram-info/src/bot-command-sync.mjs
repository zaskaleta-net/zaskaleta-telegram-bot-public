import { readBoundedJSON } from './pilot-security.mjs';

export const BRANDED_BOT_COMMANDS = Object.freeze([
  Object.freeze({ command:'start', description:'Почати роботу з Schleswig-Holstein Помічник' }),
  Object.freeze({ command:'menu', description:'Відкрити головне меню' }),
  Object.freeze({ command:'news', description:'Показати актуальні новини Schleswig-Holstein' }),
  Object.freeze({ command:'events', description:'Куди піти: свята, ярмарки, заходи для сімей' }),
  Object.freeze({ command:'beratung', description:'Безкоштовні консультації (MBE, JMD) у вашому районі' }),
  Object.freeze({ command:'watch', description:'Моніторинг житла: сповіщення про нові оголошення, від кожних 15 хв' }),
  Object.freeze({ command:'scanner', description:'Розібрати лист (Bescheid) за фото або текстом — ШІ' }),
  Object.freeze({ command:'report', description:'Надіслати скріншот або повідомити про помилку' }),
  Object.freeze({ command:'help', description:'Допомога та доступні команди' }),
  Object.freeze({ command:'topics', description:'Теми інформаційної допомоги' }),
  Object.freeze({ command:'premium', description:'Premium: більше запитів до ШІ' }),
  Object.freeze({ command:'privacy', description:'Правила конфіденційності' }),
  Object.freeze({ command:'impressum', description:'Impressum (вихідні дані)' }),
  Object.freeze({ command:'forget', description:'Видалити мої дані в боті' })
]);

// TG-RUNTIME-057: a command whose feature is switched off is not offered in
// the menu (/premium answered "вимкнено" on the phone smoke 18.10.2026).
// Premium also needs the AI module (ai-commands.mjs premiumEnabled).
const FEATURE_FLAGS = Object.freeze({ scanner:['AI_ASSISTANT_ENABLED'], premium:['AI_ASSISTANT_ENABLED', 'AI_PREMIUM_ENABLED'], watch:['HOUSING_WATCH_ENABLED'] });

export function botCommandsFor(env = {}) {
  return BRANDED_BOT_COMMANDS.filter(item => (FEATURE_FLAGS[item.command] || []).every(flag => env?.[flag] === 'true'));
}

export const ASSISTANT_PROFILE = Object.freeze({
  name:'Schleswig-Holstein Помічник 🇺🇦🇩🇪',
  shortDescription:'Інформаційна допомога українцям у Schleswig-Holstein 🇺🇦🇩🇪',
  description:'Незалежний інформаційний помічник для українців у Schleswig-Holstein: документи, Jobcenter, Familienkasse, житло, робота, інтеграційні курси, школа, Kita та транспорт.'
});

let globalSynced = false;
const syncedChats = new Set();

async function telegramMutation(token, method, body, transport) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await transport(`https://api.telegram.org/bot${token}/${method}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(body),
      signal:controller.signal
    });
    const parsed = await readBoundedJSON(response, 16384);
    return response.ok && !parsed.error && parsed.value?.ok === true && parsed.value?.result === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function setCommands(token, scope, languageCode, transport, commands = BRANDED_BOT_COMMANDS) {
  const payload = {
    commands,
    ...(scope ? { scope } : {}),
    ...(languageCode ? { language_code:languageCode } : {})
  };
  return telegramMutation(token, 'setMyCommands', payload, transport);
}

async function setMenuButton(token, chatId, transport) {
  return telegramMutation(token, 'setChatMenuButton', {
    ...(Number.isSafeInteger(chatId) && chatId !== 0 ? { chat_id:chatId } : {}),
    menu_button:{ type:'commands' }
  }, transport);
}

async function setProfile(token, transport) {
  const updates = [
    ['setMyName', { name:ASSISTANT_PROFILE.name }],
    ['setMyShortDescription', { short_description:ASSISTANT_PROFILE.shortDescription }],
    ['setMyDescription', { description:ASSISTANT_PROFILE.description }]
  ];
  const results = await Promise.all(updates.map(([method, body]) => telegramMutation(token, method, body, transport)));
  return results.every(Boolean);
}

export async function syncBotCommandMetadata(config, transport = fetch, chatId = null, { commands = BRANDED_BOT_COMMANDS } = {}) {
  const token = String(config?.token || '');
  if (!token) return { status:'disabled' };

  const currentChatId = Number.isSafeInteger(chatId) && chatId !== 0 ? chatId : null;
  const globalTargets = globalSynced ? [] : [
    [null, null],
    [{ type:'all_group_chats' }, null],
    [{ type:'all_group_chats' }, 'uk'],
    [{ type:'all_private_chats' }, null],
    [{ type:'all_private_chats' }, 'uk']
  ];
  const chatTargets = currentChatId === null || syncedChats.has(currentChatId) ? [] : [
    [{ type:'chat', chat_id:currentChatId }, null],
    [{ type:'chat', chat_id:currentChatId }, 'uk']
  ];
  const targets = [...globalTargets, ...chatTargets];
  if (!targets.length) return { status:'already_synced' };

  const results = await Promise.all(targets.map(([scope, language]) => setCommands(token, scope, language, transport, commands)));
  const globalCount = globalTargets.length;
  const [profileOk, defaultMenuOk, chatMenuOk] = await Promise.all([
    globalCount === 0 ? true : setProfile(token, transport),
    globalCount === 0 ? true : setMenuButton(token, null, transport),
    chatTargets.length === 0 ? true : setMenuButton(token, currentChatId, transport)
  ]);
  const globalOk = (globalCount === 0 || results.slice(0, globalCount).every(Boolean)) && profileOk && defaultMenuOk;
  const chatOk = (chatTargets.length === 0 || results.slice(globalCount).every(Boolean)) && chatMenuOk;
  if (globalOk && globalCount) globalSynced = true;
  if (chatOk && currentChatId !== null && chatTargets.length) syncedChats.add(currentChatId);

  if (globalOk && chatOk) return { status:'synced' };
  if ((globalCount && globalOk) || (chatTargets.length && chatOk)) return { status:'partial' };
  return { status:'unavailable' };
}

export function resetBotCommandSyncForTests() {
  globalSynced = false;
  syncedChats.clear();
}
