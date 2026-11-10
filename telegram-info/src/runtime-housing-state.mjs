// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { pilotConfig, equalSecret, readBoundedJSON } from './pilot-security.mjs';
import { privatePilotAccessAllowed } from './runtime-access.mjs';
import { knownHousingLocation, parseHouseholdSize } from './housing-language.mjs';
import { openHousingDialogue, startsNewHousingDialogue } from './housing-open-town.mjs';
import { normalizeCostLabels } from './housing-cost-dialogue.mjs';
export { handlePrivateHousingContinuity, normalizePrivateHousingContextRequest } from './private-housing-continuity-v1.mjs';
const pending = (() => {
const LEGACY_NOT_READY = 'Дякуємо за звернення. База перевірених офіційних джерел ще готується. Поки що сервіс не формує автоматичну відповідь, щоб не надати неперевірену інформацію. Напишіть /topics, щоб обрати доступну тему.';
const CLEAR_FALLBACK = [
  'Не вдалося однозначно зрозуміти запит.',
  '',
  'Напишіть коротко тему та що саме потрібно або відкрийте /menu.',
  'Наприклад: «Житло — Trittau, 4 особи, 3-4 кімнати».',
  '',
  'Якщо для відповіді потрібне перевірене офіційне джерело, бот повідомить про це окремо.'
].join('\n');

const REPORT_META = /^🐞\s+R-\d{8}-\d{1,20}[\s\S]*$/u;
const TELEGRAM_ID_LINE = /^Користувач Telegram ID:[^\r\n]*$/mu;
const STATELESS_PATH = '/telegram/stateless';
const COST_STATE_PATH = '/housing-cost-state';
const COST_STATE_PREFIX = 'telegram-housing-cost-pending:v1:';
const COST_STATE_TTL_MS = 15 * 60 * 1000;
const COST_CONTEXT = /^(Jobcenter-погодження житла|Перевірка оренди) — ([^,\n]{1,80}),\s*(\d{1,2}(?:-\d{1,2})?) кімнат(?:а|и)?\./u;
const BARE_COST = /^(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:€|eur)?$/iu;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function validPrivateIdentity(chatId, userId) {
  return Number.isSafeInteger(chatId) && chatId > 0 && chatId === userId;
}

function costContext(text) {
  const match = COST_CONTEXT.exec(String(text || '').trim());
  if (!match) return null;
  return `${match[1]}|${match[2].replace(/\s+/gu, ' ').trim()}|${match[3]}`;
}

function canonicalCostLabel(text) {
  const source = String(text || '').trim();
  if (/^kaltmiete$/iu.test(source)) return 'Kaltmiete';
  if (/^(?:betriebskosten|brtriebskosten|nebenkosten)$/iu.test(source)) return 'Betriebskosten';
  if (/^heizkosten$/iu.test(source)) return 'Heizkosten';
  return null;
}

function pendingCostKey(chatId, userId) {
  return `${COST_STATE_PREFIX}${chatId}:${userId}`;
}

async function costStorageCall(env, payload) {
  if (!env?.OUTBOX) return { status:'unavailable' };
  try {
    const id = env.OUTBOX.idFromName('telegram-pilot-v1');
    const response = await env.OUTBOX.get(id).fetch(`https://outbox.internal${COST_STATE_PATH}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(payload)
    });
    if (!response.ok) return { status:'unavailable' };
    const parsed = await readBoundedJSON(response, 16384);
    return parsed.error ? { status:'unavailable' } : parsed.value;
  } catch {
    return { status:'unavailable' };
  }
}

function requestFromUpdate(request, update) {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, {
    method:'POST',
    headers,
    body:JSON.stringify(update)
  });
}

async function normalizePrivateHousingCostStateRequest(request, env = {}, now = Date.now(), transport = fetch) {
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

  const context = costContext(message?.reply_to_message?.text);
  const text = String(message?.text || '').trim();
  if (!context || !text || !Number.isSafeInteger(now) || now < 0) return { request, clearAfter:null };

  const bare = BARE_COST.exec(text);
  if (bare) {
    const amount = Number(bare[1].replace(',', '.'));
    if (Number.isFinite(amount) && amount >= 0 && amount <= 50000) {
      await costStorageCall(env, { op:'cost_pending_put', chatId, userId, context, amount, now });
    }
    return { request, clearAfter:null };
  }

  const label = canonicalCostLabel(text);
  if (!label) return { request, clearAfter:null };
  const pending = await costStorageCall(env, { op:'cost_pending_read', chatId, userId, context, now });
  const amount = Number(pending?.state?.amount);
  if (pending?.status !== 'ok' || !Number.isFinite(amount) || amount < 0 || amount > 50000) {
    return { request, clearAfter:null };
  }

  const copy = JSON.parse(JSON.stringify(update));
  const shown = Number.isInteger(amount) ? String(amount) : String(Math.round(amount * 100) / 100).replace('.', ',');
  copy.message.text = `${label} ${shown}`;
  return {
    request:requestFromUpdate(request, copy),
    clearAfter:{ chatId, userId, context, now }
  };
}


function sanitizeTelegramPayload(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.text !== 'string') return payload;
  const next = { ...payload };
  if (next.text === LEGACY_NOT_READY) next.text = CLEAR_FALLBACK;
  if (REPORT_META.test(next.text) && TELEGRAM_ID_LINE.test(next.text)) {
    next.text = next.text
      .replace(TELEGRAM_ID_LINE, '')
      .replace(/\n{3,}/gu, '\n\n')
      .trim();
  }
  TELEGRAM_ID_LINE.lastIndex = 0;
  return next;
}

async function handleStorage(request, outbox) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.hostname === 'outbox.internal' && url.pathname === COST_STATE_PATH) {
      const parsed = await readBoundedJSON(request.clone(), 16384);
      const value = parsed.error ? null : parsed.value;
      const chatId = Number(value?.chatId);
      const userId = Number(value?.userId);
      const now = Number(value?.now);
      const context = typeof value?.context === 'string' ? value.context.slice(0, 220) : '';
      if (!validPrivateIdentity(chatId, userId) || !Number.isSafeInteger(now) || now < 0 || !context) {
        return json({ status:'bad_operation' }, 400);
      }
      const key = pendingCostKey(chatId, userId);
      try {
        if (value.op === 'cost_pending_clear') {
          await outbox.householdContextStorage.delete(key);
          return json({ status:'ok' });
        }
        if (value.op === 'cost_pending_put') {
          const amount = Number(value.amount);
          if (!Number.isFinite(amount) || amount < 0 || amount > 50000) return json({ status:'bad_operation' }, 400);
          await outbox.householdContextStorage.put(key, { amount, context, updatedAt:now });
          return json({ status:'ok' });
        }
        if (value.op === 'cost_pending_read') {
          const stored = await outbox.householdContextStorage.get(key);
          if (!stored || !Number.isSafeInteger(stored.updatedAt) || stored.updatedAt < now - COST_STATE_TTL_MS || stored.context !== context) {
            if (stored) await outbox.householdContextStorage.delete(key);
            return json({ status:'ok', state:null });
          }
          const amount = Number(stored.amount);
          if (!Number.isFinite(amount) || amount < 0 || amount > 50000) {
            await outbox.householdContextStorage.delete(key);
            return json({ status:'ok', state:null });
          }
          return json({ status:'ok', state:{ amount } });
        }
        return json({ status:'bad_operation' }, 400);
      } catch {
        return json({ status:'unavailable' }, 503);
      }
    }
    return null;
}
return { normalizePrivateHousingCostStateRequest, sanitizeTelegramPayload, costStorageCall, handleStorage };
})();
const active = (() => {
const STATELESS_PATH = '/telegram/stateless';
const ACTIVE_PATH = '/housing-cost-active-v14';
const ACTIVE_PREFIX = 'housing-cost-active:v14:';
const ACTIVE_TTL_MS = 15 * 60 * 1000;
const COST_DIALOGUE = /^(?:Jobcenter-погодження житла|Перевірка оренди) — [^,\n]{1,80},\s*\d{1,2}(?:-\d{1,2})? кімнат(?:а|и)?\./u;
const COST_LABEL = '(?:kaltmiete|betriebskosten|brtriebskosten|nebenkosten|heizkosten|warmmiete)';
// TG-RUNTIME-079: "Betriebskosten inkl. heizanteil 200" (a side cost with the
// heating included, normalised) counts as one labelled sum in a list.
const COST_LABEL_WITH_HEATING = `(?:${COST_LABEL}\\s+(?:inkl\\.?|inklusive|mit|включно\\s+з|разом\\s+з|з|із|с)\\s+heizanteil|heizanteil|${COST_LABEL})`;
// TG-RUNTIME-081: "Kaltmiete 600 inkl. heizanteil" — the heating named after the sum.
const COST_ENTRY = `(?:${COST_LABEL_WITH_HEATING}(?:\\s*[:=–—]\\s*|\\s+-\\s+|\\s*))?\\d{1,5}(?:[.,]\\d{1,2})?\\s*(?:€|eur(?:o)?|євро|евро)?(?:\\s+(?:inkl\\.?|inklusive|mit|включно\\s+з|разом\\s+з|з|із|с)\\s+heizanteil)?`;
// One sum, a bare label, "не знаю", or up to three sums in one message (the
// prompt itself says "Можна надіслати всі три суми разом").
const COST_LIKE = new RegExp(`^(?:${COST_ENTRY}(?:\\s*(?:[,;+]|і|и|und|та)?\\s*${COST_ENTRY}){0,2}|${COST_LABEL}|не\\s+знаю|не\\s+відомо)$`, 'iu');

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

function key(chatId) {
  return `${ACTIVE_PREFIX}${chatId}`;
}

function isCostDialogue(text) {
  return COST_DIALOGUE.test(String(text || '').trim());
}

function isHousingInputPrompt(text) {
  const source = String(text || '').trim();
  return needsMoreCostInput(source)
    || /^Тема: житло\. Вкажіть місто або район/u.test(source)
    || /^(?:Тема: житло\s*[—–-]\s*[^\n]{1,100}\.[\s\S]*?кількість кімнат|Для житла\s*[—–-]\s*[^\n]{1,80}\s+вкажіть кількість кімнат)/iu.test(source)
    || /^🏠 Дані пошуку житла збережено\.[\s\S]*?Вкажіть кількість людей/u.test(source)
    || /^Житло\s*[—–-]\s*[^,\n]{1,80},\s*\d{1,2}(?:-\d{1,2})?\s+кімнат(?:а|и)?\.[\s\S]*?Що саме потрібно\?/u.test(source)
    || /^Пошук житла\s*[—–-]\s*[^,\n]{1,80},\s*\d{1,2}(?:-\d{1,2})?\s+кімнат(?:а|и)?[\s\S]*?(?:Уточніть|бюджет до)/u.test(source)
    || /^Бюджет [\d.,]+ €[\s\S]*?(?:Вкажіть місто|Вкажіть кількість кімнат|Це Warmmiete)/u.test(source)
    || /^\d{1,2}(?:-\d{1,2})? кімнат(?:а|и)? розпізнано\./u.test(source)
    || /^Тип оренди розпізнано\./u.test(source)
    || /^Параметри житла: [^,\n]{1,80},\s*\d{1,2}(?:-\d{1,2})?\s+кімнат(?:а|и)?, до [\d.,]+ € (?:Warmmiete|Kaltmiete)\. Оберіть радіус пошуку:/u.test(source)
    || source.includes('\nДля нормативів Jobcenter вкажіть кількість осіб (1–20).')
    // TG-RUNTIME-074: the typo question; a typed "так" or the town answers it.
    || /^❓ Місто «[^»\n]{1,60}» не знайдено\. Можливо, ви мали на увазі /u.test(source);
}

function startsNewTopic(update) {
  if (/^nav:/u.test(String(update?.callback_query?.data || ''))) return true;
  const text = String(update?.message?.text || '').trim();
  if (text.startsWith('/')) return true;
  return /^(?:[^\p{L}\p{N}]*)(?:Меню|Житло|Jobcenter|Робота|Курси|Школа\s*\/\s*Kita|Транспорт|Документи|Kindergeld|Новини|Повідомити про помилку)$/iu.test(text);
}

// TG-RUNTIME-079 (phone smoke 27.10.2026, #25): new sums sent right after a
// finished rent check ("Kaltmiete 600 €, Nebenkosten inkl. Heizung 200 €")
// got "Тема: житло. Вкажіть місто або район". The finished check stays the
// context for 15 minutes, but only for a message with sums (a new check in
// the same town), never as an open step for other text or the AI answer.
function isFinishedCostCheck(text) {
  const source = String(text || '');
  return isCostDialogue(source) && !needsMoreCostInput(source) && /^(?:Kaltmiete \+ Betriebskosten: |Для цієї локації та кількості осіб автоматичний висновок недоступний)/mu.test(source);
}

function storablePrompt(text) {
  return isHousingInputPrompt(text) || isFinishedCostCheck(text);
}

function needsMoreCostInput(text) {
  const source = String(text || '');
  return isCostDialogue(source) && /(?:Вкажіть|Надішліть основні суми|Ще потрібні|Сума без призначення|Що означає ця сума|Надсилайте назву та суму|кількість осіб)/u.test(source);
}

async function stateCall(env, payload) {
  if (!env?.OUTBOX) return null;
  try {
    const id = env.OUTBOX.idFromName('telegram-pilot-v1');
    const response = await env.OUTBOX.get(id).fetch(`https://outbox.internal${ACTIVE_PATH}`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload)
    });
    if (!response.ok) return null;
    const parsed = await readBoundedJSON(response, 8192);
    return parsed.error ? null : parsed.value;
  } catch {
    return null;
  }
}

function rebuildRequest(request, update) {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method:'POST', headers, body:JSON.stringify(update) });
}

async function restoreActiveHousingReply(request, env = {}, now = Date.now()) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return request;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return request;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return request;
  const update = parsed.value;
  const message = update?.message || update?.callback_query?.message;
  const chatId = Number(message?.chat?.id);
  const from = update?.callback_query?.from || update?.message?.from;
  const userId = Number(from?.id);
  const text = String(update?.message?.text || '').trim();
  if (message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || from?.is_bot === true) return request;
  if (startsNewTopic(update)) {
    await stateCall(env, { op:'clear', chatId, now });
    return request;
  }
  if (update?.callback_query || message?.reply_to_message?.text || !text) return request;
  const active = await stateCall(env, { op:'read', chatId, now });
  const prompt = String(active?.prompt || '');
  // A new self-contained search must not inherit the previous town/household.
  // TG-RUNTIME-070: the same town with no other persons or rooms ("пошук
  // житла в Trittau") is the next answer in the open dialogue.
  const selfContained = knownHousingLocation(text) && (parseHouseholdSize(text) !== null || /житл|квартир|для|сім|wohnung|miete/iu.test(text));
  if (selfContained && (!openHousingDialogue(prompt) || startsNewHousingDialogue(text, prompt))) {
    await stateCall(env, { op:'clear', chatId, now });
    return request;
  }
  const costText = normalizeCostLabels(text);
  // "Nebenkosten inkl. Heizung 200" stays in the rent check, which asks for the parts separately.
  const costLike = COST_LIKE.test(costText) || /^[\p{L}.\s]{0,40}heizanteil(?:\s*[:=–—]\s*|\s+-\s+|\s*)\d{1,5}(?:[.,]\d{1,2})?\s*(?:€|eur(?:o)?|євро|евро)?$/iu.test(costText)
    || /^[\p{L}\s]{1,40}\d{1,5}(?:[.,]\d{1,2})?\s*(?:€|eur(?:o)?|євро|евро)?\s+(?:inkl\.?|inklusive|mit|включно\s+з|разом\s+з|з|із|с)\s+heizanteil$/iu.test(costText);
  // Review #079: after a finished check only labelled sums count ("3" or
  // "900" alone keep their own meaning).
  const labelledCost = costLike && /(?:kaltmiete|betriebskosten|brtriebskosten|nebenkosten|heizkosten|warmmiete)/iu.test(costText);
  if (!(isHousingInputPrompt(prompt) || (isFinishedCostCheck(prompt) && labelledCost)) || (isCostDialogue(prompt) && !costLike)) return request;
  const copy = JSON.parse(JSON.stringify(update));
  // This context comes from this bot's private durable prompt, not an incoming
  // Telegram quote. Preserve its provenance for the core reply normalizer;
  // there is no Telegram message ID to invent for a stored context.
  copy.message.reply_to_message = {
    text:prompt,
    chat:{id:chatId,type:'private'},
    from:{is_bot:true,username:'ZaskaletaInfoBot'}
  };
  return rebuildRequest(request, copy);
}

async function handleStorage(request, outbox) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.hostname === 'outbox.internal' && url.pathname === ACTIVE_PATH) {
      const parsed = await readBoundedJSON(request.clone(), 8192);
      const value = parsed.error ? null : parsed.value;
      const chatId = Number(value?.chatId);
      const now = Number(value?.now);
      if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(now) || now < 0) return json({ status:'bad_operation' }, 400);
      const storageKey = key(chatId);
      try {
        if (value.op === 'clear') {
          await outbox.householdContextStorage.delete(storageKey);
          return json({ status:'ok' });
        }
        if (value.op === 'put') {
          const prompt = String(value?.prompt || '').slice(0, 4000);
          if (!storablePrompt(prompt)) return json({ status:'bad_operation' }, 400);
          await outbox.householdContextStorage.put(storageKey, { prompt, updatedAt:now });
          return json({ status:'ok' });
        }
        if (value.op === 'read') {
          const stored = await outbox.householdContextStorage.get(storageKey);
          if (!stored || !Number.isSafeInteger(stored.updatedAt) || stored.updatedAt < now - ACTIVE_TTL_MS || !storablePrompt(stored.prompt)) {
            if (stored) await outbox.householdContextStorage.delete(storageKey);
            return json({ status:'ok', prompt:null });
          }
          return json({ status:'ok', prompt:stored.prompt });
        }
        return json({ status:'bad_operation' }, 400);
      } catch {
        return json({ status:'unavailable' }, 503);
      }
    }
    return null;
}
return { restoreActiveHousingReply, isCostDialogue, isHousingInputPrompt, isFinishedCostCheck, stateCall, handleStorage };
})();

export const sanitizeTelegramPayload = pending.sanitizeTelegramPayload;
export async function prepareHousingState(request, env, now, transport, {mainMenuChatId=null} = {}) {
  if(Number.isSafeInteger(mainMenuChatId) && mainMenuChatId>0) {
    await pending.costStorageCall(env,{op:'cost_pending_clear',chatId:mainMenuChatId,userId:mainMenuChatId,context:'menu-reset',now});
  }
  return pending.normalizePrivateHousingCostStateRequest(await active.restoreActiveHousingReply(request, env, now), env, now, transport);
}
export async function finishHousingState(clearAfter, response, env) {
  if (clearAfter && response?.status < 500) await pending.costStorageCall(env, {op:'cost_pending_clear', ...clearAfter});
}
export async function recordHousingPrompt(payload, env, now) {
  const chatId = Number(payload?.chat_id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return false;
  if (active.isHousingInputPrompt(payload?.text)) {
    const stored = await active.stateCall(env, {op:'put',chatId,prompt:payload.text,now});
    return stored?.status === 'ok';
  }

  // A failed parse is a retry, not completion. Keep the last verified housing
  // input step so a corrected municipality is still interpreted in housing.
  if (/^Не вдалося однозначно зрозуміти запит\./u.test(String(payload?.text || '').trim())) {
    const current = await active.stateCall(env, {op:'read',chatId,now});
    if (active.isHousingInputPrompt(current?.prompt)) return true;
  }

  // TG-RUNTIME-079: a finished rent check stays the context for new sums.
  if (active.isFinishedCostCheck(payload?.text)) {
    await active.stateCall(env, {op:'put',chatId,prompt:payload.text,now});
    return true;
  }
  // A completed response must not leave a previous input step active.
  await active.stateCall(env, {op:'clear',chatId,now});
  return active.isCostDialogue(payload?.text);
}
// True while a housing input step waits for an answer: its retry prompt is
// not replaced by an AI answer (ai-commands.mjs).
export async function housingInputPending(env, chatId, now) {
  const current = await active.stateCall(env, {op:'read',chatId,now});
  return active.isHousingInputPrompt(current?.prompt);
}
export async function handleHousingStorage(request, outbox) {
  return await active.handleStorage(request, outbox) || await pending.handleStorage(request, outbox);
}
