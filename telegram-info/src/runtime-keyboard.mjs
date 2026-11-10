// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { mainInlineMenu, PANEL_COMMAND, PANEL_TEXT } from './main-panel.mjs';
import { budgetLineOfPrompt, withBudgetLine } from './housing-budget-line.mjs';
import { START_TEXT } from './start-text.mjs';
import { pilotConfig, equalSecret, readBoundedJSON } from './pilot-security.mjs';
import { privatePilotAccessAllowed } from './runtime-access.mjs';
import { canonicalizeGuidedHousingPrompt } from './runtime-cities.mjs';
import { EVENTS_FOLLOWUP_PROMPT, eventsBarePlace } from './events-nordticker.mjs';
import { BERATUNG_FOLLOWUP_PROMPT, beratungBarePlace } from './beratung-bamf.mjs';
import { roomsWord } from './rooms.mjs';

// A section's follow-up after its list only claims a message that is just a
// place name (TG-RUNTIME-046).
const FOLLOWUP_PROMPTS = new Map([
  [EVENTS_FOLLOWUP_PROMPT, eventsBarePlace],
  [BERATUNG_FOLLOWUP_PROMPT, beratungBarePlace]
]);
const STATELESS_PATH = '/telegram/stateless';
const quick = (() => {
const STATELESS_PATH = '/telegram/stateless';
const TELEGRAM_TIMEOUT_MS = 8000;
const ROOM_CALLBACK = /^hkr:(1|2|3|4|5|2-3|3-4|x):(.{1,48})$/u;
const JOBCENTER_LINE = 'Умова: житло під Jobcenter.';
const JOBCENTER_CONDITION = /^Умова: житло під Jobcenter\.$/mu;
const TOWN_QUESTION = /^❓ Місто «[^»\n]{1,60}» не знайдено\. Можливо, ви мали на увазі /u;
const PEOPLE_CALLBACK = /^hkp:([1-6]|x):([^:]{1,8}):(.{1,48})$/u;
const ACTION_CALLBACK = /^hka:([sjrl]):(\d{1,2}):([^:]{1,8}):(.{1,48})$/u;

const ROOM_PROMPT = /^Тема: житло\s*[—–-]\s*([^\.\n]{1,80})\.\s*Локацію вже визначено\.\nВкажіть кількість кімнат/iu;
const ROOM_RETRY_PROMPT = /^Для житла\s*[—–-]\s*([^\n]{1,80}?)\s+вкажіть кількість кімнат/iu;
const PEOPLE_PROMPT = /^🏠 Дані пошуку житла збережено\.\n📍 Локація: ([^\n]{1,80})\n🛏 Кімнат: (\d{1,2}(?:-\d{1,2})?)\n👥 Вкажіть кількість людей/iu;
const FINAL_PROMPT = /^Житло\s*[—–-]\s*([^,\n]{1,80}),\s*(\d{1,2}(?:-\d{1,2})?)\s+кімнат(?:а|и)?\.\nОсіб:\s*(\d{1,2})[\s\S]*?Що саме потрібно\?/iu;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function encodeLocation(value) {
  const encoded = encodeURIComponent(String(value || '').replace(/\s+/gu, ' ').trim());
  return encoded && new TextEncoder().encode(encoded).byteLength <= 48 ? encoded : null;
}

function decodeLocation(value) {
  try {
    const decoded = decodeURIComponent(String(value || '')).replace(/\s+/gu, ' ').trim();
    // Place names such as "Lauenburg/Elbe" or "Reinfeld (Holstein)" need '/', '(' and ')'.
    return /^\p{L}[\p{L}\p{M}.'’()/ -]{1,79}$/u.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function roomPromptText(location) {
  return `Тема: житло — ${location}. Локацію вже визначено.\nВкажіть кількість кімнат, наприклад: 3 або 3-4.`;
}

function peoplePromptText(location, rooms) {
  return [
    '🏠 Дані пошуку житла збережено.',
    `📍 Локація: ${location}`,
    `🛏 Кімнат: ${rooms}`,
    '👥 Вкажіть кількість людей, які житимуть у квартирі (1–20).'
  ].join('\n');
}

function finalPromptText(location, rooms, persons) {
  return [
    `Житло — ${location}, ${rooms} ${roomsWord(rooms)}.`,
    `Осіб: ${persons}`,
    '',
    '✅ Дані збережено.',
    'Що саме потрібно?',
    'Оберіть дію нижче або напишіть її своїми словами.'
  ].join('\n');
}

function roomQuickMarkup(location) {
  const encoded = encodeLocation(location);
  if (!encoded) return null;
  const button = value => ({ text:value === 'x' ? '✍️ Інше' : `${value} кімн.`, callback_data:`hkr:${value}:${encoded}` });
  return { inline_keyboard:[
    [button('1'), button('2'), button('3')],
    [button('4'), button('5'), button('3-4')],
    [button('2-3'), button('x')]
  ] };
}

function peopleQuickMarkup(location, rooms) {
  const encoded = encodeLocation(location);
  if (!encoded) return null;
  const button = value => ({ text:value === 'x' ? '✍️ Інше' : `${value}`, callback_data:`hkp:${value}:${rooms}:${encoded}` });
  return { inline_keyboard:[
    [button('1'), button('2'), button('3')],
    [button('4'), button('5'), button('6')],
    [button('x')]
  ] };
}

function actionQuickMarkup(location, rooms, persons) {
  const encoded = encodeLocation(location);
  const people = Number(persons);
  if (!encoded || !Number.isSafeInteger(people) || people < 1 || people > 20) return null;
  const data = code => `hka:${code}:${people}:${rooms}:${encoded}`;
  return { inline_keyboard:[
    [{ text:'🔎 Пошук житла', callback_data:data('s') }],
    [{ text:'🏛 Житло під Jobcenter', callback_data:data('j') }],
    [{ text:'💶 Перевірка оренди', callback_data:data('r') }],
    [{ text:'✉️ Відповідь орендодавцю', callback_data:data('l') }]
  ] };
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

async function sendMessage(config, chatId, text, replyMarkup, transport) {
  const result = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text,
    disable_notification:true,
    link_preview_options:{ is_disabled:true },
    ...(replyMarkup ? { reply_markup:replyMarkup } : {})
  }, transport);
  return result.ok;
}

async function securedPrivateCallback(request, env, transport) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const update = parsed.value;
  const query = update?.callback_query;
  if (!query) return null;
  const chatId = Number(query?.message?.chat?.id);
  const userId = Number(query?.from?.id);
  if (query?.message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || query?.from?.is_bot === true) return null;
  if (!(await privatePilotAccessAllowed(update, config, transport))) return null;
  return { config, update, query, chatId };
}

async function answerCallback(config, query, transport) {
  if (typeof query?.id !== 'string' || !query.id) return;
  await telegramJSON(config, 'answerCallbackQuery', { callback_query_id:query.id }, transport);
}

function syntheticActionRequest(request, update, text, previous) {
  const query = update.callback_query;
  const copy = {
    update_id:update.update_id,
    message:{
      message_id:Number(query?.message?.message_id || 0) + 1,
      date:query?.message?.date || Math.floor(Date.now() / 1000),
      chat:query.message.chat,
      from:query.from,
      text,
      reply_to_message:{
        message_id:query.message.message_id,
        date:query?.message?.date || Math.floor(Date.now() / 1000),
        chat:query.message.chat,
        from:{ id:999999999, is_bot:true, username:'ZaskaletaInfoBot' },
        text:previous
      }
    }
  };
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method:'POST', headers, body:JSON.stringify(copy) });
}

async function handleHousingKeyboardCallback(request, env = {}, now = Date.now(), transport = fetch) {
  const secured = await securedPrivateCallback(request, env, transport);
  if (!secured) return null;
  const { config, update, query, chatId } = secured;
  const data = String(query?.data || '');

  const room = ROOM_CALLBACK.exec(data);
  if (room) {
    const location = decodeLocation(room[2]);
    if (!location) return null;
    await answerCallback(config, query, transport);
    if (room[1] === 'x') {
      // Keep the household size already collected on the source message.
      const source = String(query?.message?.text || '');
      const persons = Number(/^Осіб:\s*(\d{1,2})$/mu.exec(source)?.[1]);
      const condition = JOBCENTER_CONDITION.test(source) ? `\n${JOBCENTER_LINE}` : '';
      // TG-RUNTIME-077: the town question of a Jobcenter request with the
      // household size continues like the typed "так": the Jobcenter limits.
      if (condition && persons && TOWN_QUESTION.test(source)) return { request:syntheticActionRequest(request, update, 'так', source) };
      const prompt = withBudgetLine(Number.isSafeInteger(persons) && persons >= 1 && persons <= 20
        ? `${roomPromptText(location)}\nОсіб: ${persons}${condition}`
        : `${roomPromptText(location)}${condition}`, budgetLineOfPrompt(source));
      const delivered = await sendMessage(config, chatId, prompt, {
        force_reply:true,
        input_field_placeholder:'Напр.: 3 або 3-4'
      }, transport);
      return json({ ok:true, mode:'housing-keyboard-room-manual', delivered });
    }
    const rooms = room[1];
    const delivered = await sendMessage(config, chatId, withBudgetLine(peoplePromptText(location, rooms), budgetLineOfPrompt(query?.message?.text)), peopleQuickMarkup(location, rooms), transport);
    return json({ ok:true, mode:'housing-keyboard-people', delivered, location, rooms });
  }

  const people = PEOPLE_CALLBACK.exec(data);
  if (people) {
    const location = decodeLocation(people[3]);
    const rooms = people[2];
    if (!location) return null;
    await answerCallback(config, query, transport);
    if (people[1] === 'x') {
      const delivered = await sendMessage(config, chatId, withBudgetLine(peoplePromptText(location, rooms), budgetLineOfPrompt(query?.message?.text)), {
        force_reply:true,
        input_field_placeholder:'Напр.: 4'
      }, transport);
      return json({ ok:true, mode:'housing-keyboard-people-manual', delivered });
    }
    const persons = Number(people[1]);
    const delivered = await sendMessage(config, chatId, withBudgetLine(finalPromptText(location, rooms, persons), budgetLineOfPrompt(query?.message?.text)), actionQuickMarkup(location, rooms, persons), transport);
    return json({ ok:true, mode:'housing-keyboard-action', delivered, location, rooms, persons });
  }

  const action = ACTION_CALLBACK.exec(data);
  if (action) {
    const location = decodeLocation(action[4]);
    const persons = Number(action[2]);
    const rooms = action[3];
    if (!location || !Number.isSafeInteger(persons) || persons < 1 || persons > 20) return null;
    const text = ({ s:'пошук житла', j:'житло під Jobcenter', r:'перевірка оренди', l:'відповідь орендодавцю' })[action[1]];
    if (!text) return null;
    await answerCallback(config, query, transport);
    // Make the action request self-contained. The callback already carries the
    // authoritative location, room spec and household size; passing only the
    // action label makes the legacy router ask for rooms/persons again.
    const complete = `${location}. ${text}. Для ${persons} осіб. ${rooms} ${roomsWord(rooms)}.`;
    const synthetic = syntheticActionRequest(request, update, complete, withBudgetLine(finalPromptText(location, rooms, persons), budgetLineOfPrompt(query?.message?.text)));
    return { request:synthetic };
  }

  return null;
}
return { roomQuickMarkup, peopleQuickMarkup, actionQuickMarkup, handleHousingKeyboardCallback };
})();
const { roomQuickMarkup, peopleQuickMarkup, actionQuickMarkup } = quick;
export { roomQuickMarkup, peopleQuickMarkup, actionQuickMarkup };
const known = (() => {
const STATELESS_PATH = '/telegram/stateless';

const TELEGRAM_TIMEOUT_MS = 8000;

const ROOM_CALLBACK = /^hkr:(1|2|3|4|5|2-3|3-4|x):(.{1,48})$/u;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function decodeLocation(value) {
  try {
    const decoded = decodeURIComponent(String(value || '')).replace(/\s+/gu, ' ').trim();
    // Place names such as "Lauenburg/Elbe" or "Reinfeld (Holstein)" need '/', '(' and ')'.
    return /^\p{L}[\p{L}\p{M}.'’()/ -]{1,79}$/u.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function knownPersonsFromPrompt(text) {
  const value = Number(/^Осіб:\s*(\d{1,2})\s*$/mu.exec(String(text || ''))?.[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 20 ? value : null;
}

function finalPromptText(location, rooms, persons) {
  return [
    `Житло — ${location}, ${rooms} ${roomsWord(rooms)}.`,
    `Осіб: ${persons}`,
    '',
    '✅ Дані збережено.',
    'Що саме потрібно?',
    'Оберіть дію нижче або напишіть її своїми словами.'
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

async function maybeHandleKnownHouseholdRoomButton(request, env, transport) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const update = parsed.value;
  const query = update?.callback_query;
  const match = ROOM_CALLBACK.exec(String(query?.data || ''));
  if (!match || match[1] === 'x') return null;

  const chatId = Number(query?.message?.chat?.id);
  const userId = Number(query?.from?.id);
  const location = decodeLocation(match[2]);
  const persons = knownPersonsFromPrompt(query?.message?.text);
  if (!location || !persons || query?.message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || query?.from?.is_bot === true) return null;
  if (!(await privatePilotAccessAllowed(update, config, transport))) return null;

  if (typeof query?.id === 'string' && query.id) {
    await telegramJSON(config, 'answerCallbackQuery', { callback_query_id:query.id }, transport);
  }
  const rooms = match[1];
  const text = withBudgetLine(finalPromptText(location, rooms, persons), budgetLineOfPrompt(query?.message?.text));
  const sent = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text,
    disable_notification:true,
    link_preview_options:{ is_disabled:true },
    reply_markup:actionQuickMarkup(location, rooms, persons)
  }, transport);
  return json({ ok:true, mode:'housing-keyboard-known-household', delivered:sent.ok, location, rooms, persons });
}
return { maybeHandleKnownHouseholdRoomButton };
})();
const navigation = (() => {
const STATELESS_PATH = '/telegram/stateless';

const TELEGRAM_TIMEOUT_MS = 8000;

const NAVIGATION = Object.freeze({
  housing:'🏠 Житло',
  jobcenter:'🏛 Jobcenter',
  work:'💼 Робота',
  courses:'🎓 Курси',
  school:'👨‍👩‍👧 Школа / Kita',
  transport:'🚌 Транспорт',
  documents:'📄 Документи',
  kindergeld:'👶 Kindergeld',
  news:'🗞 Новини',
  report:'🐞 Повідомити про помилку'
});

const NAVIGATION_TEXTS = new Set(Object.values(NAVIGATION));

const START_OR_MENU_COMMAND = /^(?:\/start(?:@ZaskaletaInfoBot)?|\/(?:menu|panel)(?:@ZaskaletaInfoBot)?|☰\s*Меню)\s*$/iu;

const MAIN_NAV_CALLBACK = /^nav:(?:menu|housing|jobcenter|work|courses|school|transport|documents|kindergeld|news|report)$/u;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}


function isMainReplyKeyboard(rows) {
  const texts = new Set((Array.isArray(rows) ? rows : []).flatMap(row => Array.isArray(row) ? row.map(button => String(button?.text || '')) : []));
  return texts.has('🏠 Житло') && texts.has('🏛 Jobcenter') && texts.has('📄 Документи');
}

function hasInlineMenuButton(rows) {
  return Array.isArray(rows) && rows.some(row => Array.isArray(row) && row.some(button => button?.callback_data === 'nav:menu'));
}

function appendMenuButton(markup) {
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : [];
  if (hasInlineMenuButton(rows)) return markup;
  return { ...markup, inline_keyboard:[...rows, [{ text:'☰ Меню', callback_data:'nav:menu' }]] };
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

async function securedPrivateUpdate(request, env, transport) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const update = parsed.value;
  const chat = update?.message?.chat || update?.callback_query?.message?.chat;
  const from = update?.message?.from || update?.callback_query?.from;
  const chatId = Number(chat?.id);
  const userId = Number(from?.id);
  if (chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || from?.is_bot === true) return null;
  if (!(await privatePilotAccessAllowed(update, config, transport))) return null;
  return { config, update, chatId, userId };
}

function shouldClearLegacyReplyKeyboard(update) {
  const text = String(update?.message?.text || '').trim();
  if (START_OR_MENU_COMMAND.test(text) || NAVIGATION_TEXTS.has(text)) return true;
  return MAIN_NAV_CALLBACK.test(String(update?.callback_query?.data || ''));
}

function shouldResetLegacyInputPlaceholder(update) {
  const text = String(update?.message?.text || '').trim();
  if (START_OR_MENU_COMMAND.test(text)) return true;
  return String(update?.callback_query?.data || '') === 'nav:menu';
}

async function clearLegacyReplyKeyboard(config, chatId, transport) {
  // ReplyKeyboardRemove can retire an old custom keyboard, but Telegram exposes
  // no Bot API operation that cancels an already-active ForceReply composer.
  // Never send a new ForceReply as a migration/reset mechanism: that can only
  // create another client-side reply target. Existing stale ForceReply state
  // must be dismissed once by the affected client; the private outbound
  // boundary prevents it from being created again.
  const pulse = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text:'⌨️ Синхронізація поля вводу',
    disable_notification:true,
    reply_markup:{
      keyboard:[[{ text:'☰ Меню' }]],
      resize_keyboard:true,
      one_time_keyboard:true,
      is_persistent:false
    }
  }, transport);
  if (!pulse.ok) return null;

  const removed = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text:'⌨️ Поле вводу оновлено',
    disable_notification:true,
    reply_markup:{ remove_keyboard:true }
  }, transport);
  if (!removed.ok) {
    const pulseId = Number(pulse.data?.result?.message_id);
    if (Number.isSafeInteger(pulseId) && pulseId > 0) {
      await telegramJSON(config, 'deleteMessage', { chat_id:chatId, message_id:pulseId }, transport);
    }
    return null;
  }

  const messageIds = [pulse, removed]
    .map(result => Number(result.data?.result?.message_id))
    .filter(messageId => Number.isSafeInteger(messageId) && messageId > 0);
  return messageIds.length === 2 ? messageIds : null;
}

async function deleteLegacyReplyKeyboardReset(config, chatId, messageId, transport) {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return false;
  const deleted = await telegramJSON(config, 'deleteMessage', {
    chat_id:chatId,
    message_id:messageId
  }, transport);
  return deleted.ok;
}

async function answerCallback(config, query, transport) {
  if (typeof query?.id !== 'string' || !query.id) return;
  await telegramJSON(config, 'answerCallbackQuery', { callback_query_id:query.id }, transport);
}

function syntheticNavigationRequest(request, secured, text, now) {
  const query = secured.update.callback_query;
  const messageId = Number(query?.message?.message_id);
  const copy = {
    update_id:secured.update.update_id,
    message:{
      message_id:Number.isSafeInteger(messageId) && messageId > 0 ? messageId : 1,
      date:Math.floor(now / 1000),
      chat:query.message.chat,
      from:query.from,
      text
    }
  };
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method:'POST', headers, body:JSON.stringify(copy) });
}

async function sendInlineMenu(secured, transport) {
  const sent = await telegramJSON(secured.config, 'sendMessage', {
    chat_id:secured.chatId,
    text:'Оберіть потрібний розділ:',
    disable_notification:true,
    reply_markup:mainInlineMenu()
  }, transport);
  return json({ ok:true, mode:'private-inline-menu-v21', delivered:sent.ok });
}

// The bot's own reply-keyboard button "☰ Меню" sends plain text; it must open
// the same inline menu as the nav:menu callback.
function isMenuButtonText(update) {
  return !update?.callback_query && /^☰\s*Меню$/u.test(String(update?.message?.text || '').trim());
}

async function handleNavigationCallback(request, secured, env, now, transport) {
  const query = secured.update?.callback_query;
  const match = /^nav:(menu|housing|jobcenter|work|courses|school|transport|documents|kindergeld|news|report)$/u.exec(String(query?.data || ''));
  if (!match) return null;
  await answerCallback(secured.config, query, transport);

  if (match[1] === 'menu') return sendInlineMenu(secured, transport);

  const text = NAVIGATION[match[1]];
  if (!text) return null;
  return { request:syntheticNavigationRequest(request, secured, text, now) };
}
return { handleNavigationCallback, sendInlineMenu, isMenuButtonText, securedPrivateUpdate, shouldClearLegacyReplyKeyboard, shouldResetLegacyInputPlaceholder, clearLegacyReplyKeyboard, deleteLegacyReplyKeyboardReset, appendMenuButton, isMainReplyKeyboard, mainInlineMenu, telegramJSON };
})();

const KEYBOARD_RESET_STATE_PATH = '/keyboard-reset-state';
const KEYBOARD_RESET_STATE_PREFIX = 'telegram-keyboard-reset:v6:';

function keyboardResetKey(chatId, userId) {
  return `${KEYBOARD_RESET_STATE_PREFIX}${chatId}:${userId}`;
}

function keyboardResetJSON(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

async function keyboardResetStateCall(env, payload) {
  if (!env?.OUTBOX) return { status:'unavailable' };
  try {
    const id = env.OUTBOX.idFromName('telegram-pilot-v1');
    const response = await env.OUTBOX.get(id).fetch(`https://outbox.internal${KEYBOARD_RESET_STATE_PATH}`, {
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

const PRIVATE_PROMPT_STATE_PATH = '/private-prompt-state';
const PRIVATE_PROMPT_STATE_PREFIX = 'telegram-private-prompt:v1:';
const PRIVATE_PROMPT_TTL_MS = 15 * 60 * 1000;
// The town questions of the events and counselling sections.
const FRESH_TOWN_PROMPT = /^🔎 Напишіть назву/u;

function privatePromptKey(chatId, userId) {
  return `${PRIVATE_PROMPT_STATE_PREFIX}${chatId}:${userId}`;
}

async function privatePromptStateCall(env, payload) {
  if (!env?.OUTBOX) return { status:'unavailable' };
  try {
    const id = env.OUTBOX.idFromName('telegram-pilot-v1');
    const response = await env.OUTBOX.get(id).fetch(`https://outbox.internal${PRIVATE_PROMPT_STATE_PATH}`, {
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

export async function rememberPrivatePrompt(env, chatId, prompt, now = Date.now()) {
  const userId = Number(chatId);
  const text = String(prompt || '').trim();
  if (!Number.isSafeInteger(userId) || userId <= 0 || !text || text.length > 4096 || !Number.isSafeInteger(now) || now < 0) {
    return { status:'bad_operation' };
  }
  return privatePromptStateCall(env, { op:'put', chatId:userId, userId, prompt:text, now });
}

function rebuildPrivatePromptRequest(request, update) {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, {
    method:'POST',
    headers,
    body:JSON.stringify(update)
  });
}

// A button handled before the prompt context (events, counselling) ends any
// saved text prompt, as every other private button press does.
export async function forgetPrivatePrompt(env, chatId, now = Date.now()) {
  const userId = Number(chatId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return { status:'bad_operation' };
  return privatePromptStateCall(env, { op:'clear', chatId:userId, userId, now });
}

// The saved prompt for a message the context below does not cover (a photo
// has no text). Expired prompts read as null.
export async function readPrivatePrompt(env, chatId, now = Date.now()) {
  const userId = Number(chatId);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(now) || now < 0) return null;
  const state = await privatePromptStateCall(env, { op:'read', chatId:userId, userId, now });
  return state?.status === 'ok' && typeof state.prompt === 'string' && state.prompt ? state.prompt : null;
}

export async function preparePrivatePromptContext(request, env = {}, now = Date.now()) {
  let url;
  try { url = new URL(request.url); } catch { return request; }
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return request;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return request;
  const update = parsed.value;
  if (!Number.isSafeInteger(now) || now < 0) return request;
  const query = update?.callback_query;
  if (query) {
    // A private button press is a newer step than any previously virtualized
    // text prompt. Drop the old prompt so it cannot hijack the next text input;
    // the callback's own prompt (if any) is saved after it is sent.
    const queryChatId = Number(query?.message?.chat?.id);
    const queryUserId = Number(query?.from?.id);
    if (query?.message?.chat?.type === 'private' && Number.isSafeInteger(queryChatId) && queryChatId > 0 && queryChatId === queryUserId && query?.from?.is_bot !== true) {
      await privatePromptStateCall(env, { op:'clear', chatId:queryChatId, userId:queryUserId, now });
    }
    return request;
  }
  const message = update?.message;
  const chatId = Number(message?.chat?.id);
  const userId = Number(message?.from?.id);
  if (message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || message?.from?.is_bot === true) return request;

  const text = String(message?.text || '').trim();
  const navigationBoundary = navigation.shouldClearLegacyReplyKeyboard(update);
  if (navigationBoundary) {
    await privatePromptStateCall(env, { op:'clear', chatId, userId, now });
    return request;
  }
  if (!text) return request;
  // A command is a new request: no saved question or section follow-up
  // carries over it (review of TG-RUNTIME-046: /report, then «Kiel»).
  if (text.startsWith('/')) {
    await privatePromptStateCall(env, { op:'clear', chatId, userId, now });
    return request;
  }
  // A reply to an older bot message (a sticky reply mode from an earlier
  // question, owner screenshot 17.10.2026: "Гамбург" quoted the bug-report
  // prompt) still answers a newer town question: those prompts win.
  const quoted = message?.reply_to_message;
  if (quoted && !(quoted.from?.is_bot === true && quoted.text !== undefined)) return request;

  const state = await privatePromptStateCall(env, { op:'read', chatId, userId, now });
  if (state?.status !== 'ok' || typeof state.prompt !== 'string' || !state.prompt) return request;
  if (quoted && (!FRESH_TOWN_PROMPT.test(state.prompt) || quoted.text === state.prompt)) return request;

  await privatePromptStateCall(env, { op:'clear', chatId, userId, now });
  // A follow-up only claims a message that is just a place name; anything
  // else goes on as if no question had been asked.
  const bare = FOLLOWUP_PROMPTS.get(state.prompt);
  if (bare && (quoted || !bare(text))) return request;
  const copy = JSON.parse(JSON.stringify(update));
  copy.message.reply_to_message = {
    text:state.prompt,
    chat:{ id:chatId, type:'private' },
    from:{ id:999999999, is_bot:true, username:'ZaskaletaInfoBot' }
  };
  return rebuildPrivatePromptRequest(request, copy);
}

export async function handlePrivatePromptStorage(request, outbox) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== PRIVATE_PROMPT_STATE_PATH) return null;
  const parsed = await readBoundedJSON(request.clone(), 8192);
  const value = parsed.error ? null : parsed.value;
  const chatId = Number(value?.chatId);
  const userId = Number(value?.userId);
  const now = Number(value?.now);
  if (!Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || !Number.isSafeInteger(now) || now < 0) {
    return keyboardResetJSON({ status:'bad_operation' }, 400);
  }

  const storageKey = privatePromptKey(chatId, userId);
  try {
    if (value.op === 'put') {
      const prompt = String(value?.prompt || '').trim();
      if (!prompt || prompt.length > 4096) return keyboardResetJSON({ status:'bad_operation' }, 400);
      await outbox.householdContextStorage.put(storageKey, { prompt, updatedAt:now });
      return keyboardResetJSON({ status:'ok' });
    }
    if (value.op === 'read') {
      const stored = await outbox.householdContextStorage.get(storageKey);
      if (!stored || !Number.isSafeInteger(stored.updatedAt) || stored.updatedAt < now - PRIVATE_PROMPT_TTL_MS || typeof stored.prompt !== 'string' || !stored.prompt) {
        if (stored) await outbox.householdContextStorage.delete(storageKey);
        return keyboardResetJSON({ status:'ok', prompt:null });
      }
      return keyboardResetJSON({ status:'ok', prompt:stored.prompt });
    }
    if (value.op === 'clear') {
      await outbox.householdContextStorage.delete(storageKey);
      return keyboardResetJSON({ status:'ok' });
    }
    return keyboardResetJSON({ status:'bad_operation' }, 400);
  } catch {
    return keyboardResetJSON({ status:'unavailable' }, 503);
  }
}

async function settlePendingKeyboardReset(secured, env, now, transport, { maxCleanupWaitMs = 8000 } = {}) {
  const state = await keyboardResetStateCall(env, {
    op:'read',
    chatId:secured.chatId,
    userId:secured.userId,
    now
  });
  if (state?.status !== 'ok' || state?.phase !== 'pending') return state;
  const updateId = Number(secured.update?.update_id);
  if (Number.isSafeInteger(updateId) && updateId === Number(state.updateId)) return state;

  // Housekeeping must never hold a functional navigation callback hostage.
  // Bound the best-effort deletion; the durable ReplyKeyboardRemove anchor is
  // already the second reset message and remains intact even if the pulse is
  // cleaned up later or not at all.
  const cleanup = navigation.deleteLegacyReplyKeyboardReset(
    secured.config,
    secured.chatId,
    Number(state.messageIds[0]),
    transport
  );
  if (Number.isFinite(maxCleanupWaitMs) && maxCleanupWaitMs >= 0) {
    await Promise.race([
      cleanup,
      new Promise(resolve => setTimeout(() => resolve(false), maxCleanupWaitMs))
    ]);
  } else {
    await cleanup;
  }
  await keyboardResetStateCall(env, {
    op:'complete',
    chatId:secured.chatId,
    userId:secured.userId,
    now
  });
  return { status:'ok', phase:'complete' };
}

export async function handleKeyboardResetStorage(request, outbox) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== KEYBOARD_RESET_STATE_PATH) return null;
  const parsed = await readBoundedJSON(request.clone(), 8192);
  const value = parsed.error ? null : parsed.value;
  const chatId = Number(value?.chatId);
  const userId = Number(value?.userId);
  const now = Number(value?.now);
  if (!Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || !Number.isSafeInteger(now) || now < 0) {
    return keyboardResetJSON({ status:'bad_operation' }, 400);
  }

  const storageKey = keyboardResetKey(chatId, userId);
  try {
    if (value.op === 'read') {
      const stored = await outbox.householdContextStorage.get(storageKey);
      if (!stored) return keyboardResetJSON({ status:'ok', phase:'none' });
      if (stored.phase === 'complete') return keyboardResetJSON({ status:'ok', phase:'complete' });
      if (stored.phase === 'pending'
          && Array.isArray(stored.messageIds)
          && stored.messageIds.length === 2
          && stored.messageIds.every(messageId => Number.isSafeInteger(messageId) && messageId > 0)) {
        return keyboardResetJSON({
          status:'ok',
          phase:'pending',
          messageIds:stored.messageIds,
          updateId:Number.isSafeInteger(stored.updateId) ? stored.updateId : null
        });
      }
      await outbox.householdContextStorage.delete(storageKey);
      return keyboardResetJSON({ status:'ok', phase:'none' });
    }
    if (value.op === 'pending') {
      const messageIds = Array.isArray(value.messageIds) ? value.messageIds.map(Number) : [];
      const updateId = Number(value.updateId);
      if (messageIds.length !== 2
          || !messageIds.every(messageId => Number.isSafeInteger(messageId) && messageId > 0)
          || !Number.isSafeInteger(updateId)) {
        return keyboardResetJSON({ status:'bad_operation' }, 400);
      }
      await outbox.householdContextStorage.put(storageKey, {
        phase:'pending',
        messageIds,
        updateId,
        updatedAt:now
      });
      return keyboardResetJSON({ status:'ok', phase:'pending' });
    }
    if (value.op === 'complete') {
      await outbox.householdContextStorage.put(storageKey, { phase:'complete', updatedAt:now });
      return keyboardResetJSON({ status:'ok', phase:'complete' });
    }
    return keyboardResetJSON({ status:'bad_operation' }, 400);
  } catch {
    return keyboardResetJSON({ status:'unavailable' }, 503);
  }
}

const MAIN_REPLY_KEYBOARD = Object.freeze([
  Object.freeze([{ text:'🏠 Житло' }, { text:'🏛 Jobcenter' }]),
  Object.freeze([{ text:'💼 Робота' }, { text:'🎓 Курси' }]),
  Object.freeze([{ text:'👨‍👩‍👧 Школа / Kita' }, { text:'🚌 Транспорт' }]),
  Object.freeze([{ text:'📄 Документи' }, { text:'👶 Kindergeld' }]),
  Object.freeze([{ text:'🗞 Новини' }, { text:'🐞 Повідомити про помилку' }])
]);

function mainReplyMarkup() {
  return {
    keyboard:MAIN_REPLY_KEYBOARD.map(row => row.map(button => ({ ...button }))),
    resize_keyboard:true,
    one_time_keyboard:false,
    is_persistent:false,
    input_field_placeholder:'Оберіть тему або напишіть запитання'
  };
}

function isMainInlineMenu(markup) {
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : [];
  const callbacks = new Set(rows.flatMap(row => Array.isArray(row) ? row.map(button => String(button?.callback_data || '')) : []));
  return callbacks.has('nav:housing') && callbacks.has('nav:jobcenter') && callbacks.has('nav:documents') && callbacks.has('nav:kindergeld');
}
export const shouldClearLegacyReplyKeyboard = navigation.shouldClearLegacyReplyKeyboard;

export async function maybeHandleFastPrivateStart(request, env, transport) {
  const secured = await navigation.securedPrivateUpdate(request, env, transport);
  if (!secured) return null;
  const text = String(secured.update?.message?.text || '').trim();
  // TG-RUNTIME-082: /panel and /menu open the short panel ("Невідома команда" before).
  const panel = PANEL_COMMAND.test(text);
  if (!panel && !/^\/start(?:@ZaskaletaInfoBot)?\s*$/iu.test(text)) return null;
  const sent = await navigation.telegramJSON(secured.config, 'sendMessage', {
    chat_id:secured.chatId,
    text:panel ? PANEL_TEXT : START_TEXT,
    disable_notification:true,
    reply_markup:navigation.mainInlineMenu()
  }, transport);
  return keyboardResetJSON({ ok:true, mode:'private-start-fast-v22', delivered:sent.ok });
}

export async function handleNavigation(request, env, now, transport) {
  const secured = await navigation.securedPrivateUpdate(request, env, transport);
  if (!secured) return null;

  const navigationCallback = /^nav:(?:menu|housing|jobcenter|work|courses|school|transport|documents|kindergeld|news|report)$/u
    .test(String(secured.update?.callback_query?.data || ''));

  // Answer/translate an inline navigation callback first. Cleanup of the old
  // Android keyboard state is housekeeping and is capped at 350 ms so a stale
  // deleteMessage call cannot make "🏠 Житло" look dead after /start.
  if (navigationCallback) {
    const routed = await navigation.handleNavigationCallback(request, secured, env, now, transport);
    await settlePendingKeyboardReset(secured, env, now, transport, { maxCleanupWaitMs:350 });
    return routed;
  }
  if (navigation.isMenuButtonText(secured.update)) {
    await privatePromptStateCall(env, { op:'clear', chatId:secured.chatId, userId:secured.userId, now });
    const routed = await navigation.sendInlineMenu(secured, transport);
    await settlePendingKeyboardReset(secured, env, now, transport, { maxCleanupWaitMs:350 });
    return routed;
  }

  const resetState = await settlePendingKeyboardReset(secured, env, now, transport);
  if (navigation.shouldResetLegacyInputPlaceholder(secured.update)
      && resetState?.phase !== 'pending'
      && resetState?.phase !== 'complete') {
    const messageIds = await navigation.clearLegacyReplyKeyboard(secured.config, secured.chatId, transport);
    const updateId = Number(secured.update?.update_id);
    if (Array.isArray(messageIds) && messageIds.length === 2 && Number.isSafeInteger(updateId)) {
      await keyboardResetStateCall(env, {
        op:'pending',
        chatId:secured.chatId,
        userId:secured.userId,
        messageIds,
        updateId,
        now
      });
    }
  }
  return navigation.handleNavigationCallback(request, secured, env, now, transport);
}
export async function handleHousingKeyboard(request, env, now, transport) {
  return await known.maybeHandleKnownHouseholdRoomButton(request, env, transport) || await quick.handleHousingKeyboardCallback(request, env, now, transport);
}
// ReplyKeyboardMarkup replaces the typing keyboard in Telegram clients. Grant
// that action only to an explicit menu request, scoped to its private chat.
// Do not infer user intent from an outgoing message or persist focus state.
export async function keyboardRequestContext(request) {
  const parsed=await readBoundedJSON(request.clone(),65536);
  if(parsed.error) return {};
  const update=parsed.value;
  const query=update?.callback_query;
  const message=query?.message||update?.message;
  const from=query?.from||update?.message?.from;
  const chatId=Number(message?.chat?.id);
  if(message?.chat?.type!=='private' || !Number.isSafeInteger(chatId) || chatId<=0 || chatId!==Number(from?.id) || from?.is_bot===true) return {};
  const messageText=String(message?.text||'').trim();
  const fastStart=!query && (/^\/start(?:@ZaskaletaInfoBot)?\s*$/iu.test(messageText) || PANEL_COMMAND.test(messageText));
  const explicitMenu=query ? query.data==='nav:menu' : fastStart;
  return explicitMenu ? {mainMenuChatId:chatId,...(fastStart?{fastStart:true}:{})} : {};
}
export function normalizeKeyboardPayload(payload, {costDialogue=false,housingDialogue=false,mainMenuChatId=null} = {}) {
  const chatId=Number(payload?.chat_id);
  if (!Number.isSafeInteger(chatId) || chatId<=0) return payload;
  const next={...payload};
  if (typeof next.text==='string') next.text=canonicalizeGuidedHousingPrompt(next.text);
  const text=String(next.text||'');
  const room=/^(?:Тема: житло\s*[—–-]\s*([^\n]{1,100}?)\.\s*Локацію вже визначено\.[\s\S]*?(?:кількість кімнат)|Для житла\s*[—–-]\s*([^\n]{1,80}?)\s+вкажіть кількість кімнат)/iu.exec(text);
  const people=/^🏠 Дані пошуку житла збережено\.\n📍 Локація: ([^\n]{1,80})\n🛏 Кімнат: (\d{1,2}(?:-\d{1,2})?)\n👥 Вкажіть кількість людей/iu.exec(text);
  const final=/^Житло\s*[—–-]\s*([^,\n]{1,80}),\s*(\d{1,2}(?:-\d{1,2})?)\s+кімнат(?:а|и)?\.\nОсіб:\s*(\d{1,2})[\s\S]*?Що саме потрібно\?/iu.exec(text);
  if (room) next.reply_markup=roomQuickMarkup((room[1]||room[2]).trim())||next.reply_markup;
  else if (people) next.reply_markup=peopleQuickMarkup(people[1].trim(),people[2])||next.reply_markup;
  else if (final) next.reply_markup=actionQuickMarkup(final[1].trim(),final[2],Number(final[3]))||next.reply_markup;
  // The prompt was saved by the private housing state owner. Do not make the
  // client enter Reply mode just to preserve the next text input's context.
  else if ((housingDialogue || costDialogue) && next.reply_markup?.force_reply) delete next.reply_markup;
  const markup=next.reply_markup;
  const legacyResetPulse =
    text === '⌨️ Синхронізація поля вводу'
    && Array.isArray(markup?.keyboard)
    && markup.keyboard.length === 1
    && Array.isArray(markup.keyboard[0])
    && markup.keyboard[0].length === 1
    && markup.keyboard[0][0]?.text === '☰ Меню'
    && markup.one_time_keyboard === true
    && markup.is_persistent === false
    && markup.force_reply !== true
    && markup.input_field_placeholder == null;
  if (markup?.force_reply || markup?.remove_keyboard || legacyResetPulse) return next;
  if (isMainInlineMenu(markup) || navigation.isMainReplyKeyboard(markup?.keyboard)) {
    next.reply_markup=navigation.mainInlineMenu();
  } else if (!markup) {
    next.reply_markup=mainMenuChatId===chatId ? navigation.mainInlineMenu() : navigation.appendMenuButton({});
  } else if (Array.isArray(markup.keyboard)) {
    const {selective:_selective,input_field_placeholder:_placeholder,...rest}=markup;
    next.reply_markup={...rest,resize_keyboard:true,one_time_keyboard:false,is_persistent:false};
  } else if (Array.isArray(markup.inline_keyboard)) next.reply_markup=navigation.appendMenuButton(markup);
  return next;
}

// TG-RUNTIME-077: a rooms button under a Jobcenter prompt ("Умова: житло під
// Jobcenter.", "Осіб: N") is the Jobcenter search for those rooms, the same as
// the hka:j button; without this the condition was lost and the bot asked for
// the action again. Returns the rewritten request, or null.
export async function jobcenterRoomRequest(request) {
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const update = parsed.value;
  const query = update?.callback_query;
  const match = /^hkr:(1|2|3|4|5|2-3|3-4):(.{1,48})$/u.exec(String(query?.data || ''));
  const text = String(query?.message?.text || '');
  if (!match || !/^Умова: житло під Jobcenter\.$/mu.test(text)) return null;
  const persons = Number(/^Осіб:\s*(\d{1,2})$/mu.exec(text)?.[1]);
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20) return null;
  const copy = { ...update, callback_query:{ ...query, data:`hka:j:${persons}:${match[1]}:${match[2]}` } };
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method:'POST', headers, body:JSON.stringify(copy) });
}
