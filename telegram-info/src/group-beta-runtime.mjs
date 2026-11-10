import { TelegramOutbox as BaseTelegramOutbox, replyFor, replyMarkupFor } from './worker.mjs';
import { telegramTextStyle } from './telegram-text-style.mjs';
import { GroupBetaState } from './group-beta-state.mjs';
import { pilotConfig, isAllowedPilotChat, isPilotAdmin, isAdminCommand, normalizePilotUpdate, readBoundedJSON } from './pilot-security.mjs';
import { searchLiveHousing, formatHousingListings, housingListingMedia, housingListingsMarkup, externalHousingSearchMarkup, klazApiKey } from './housing-provider.mjs';
import { sendHousingMediaReply } from './telegram-media.mjs';
import { formatEuro, parseRentBreakdown } from './jobcenter-rules.mjs';
import { heatingRuleText } from './housing-cost-dialogue.mjs';
import { evaluateJobcenterHousing, resolveJobcenterRule } from './jobcenter-registry-statewide.mjs';

const BOT_USERNAME = 'ZaskaletaInfoBot';
const CALLBACK = /^jc:(\d{6,20}):u(\d{1,20})$/;
const INTERNAL_PATH = '/beta-group';
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const validUserId = value => Number.isSafeInteger(value) && value > 0;
const validChatId = value => Number.isSafeInteger(value) && value !== 0;
const validHouseholdSize = value => Number.isSafeInteger(value) && value >= 1 && value <= 20;

function cleanLine(value, max = 160) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function contextFromListing(caption, listingId) {
  const text = String(caption || '');
  const location = /(?:^|\n)💶[^\n]*?·\s*([^\n]{2,120})/u.exec(text)?.[1];
  const area = /📐\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*м²/u.exec(text)?.[1];
  const household = /(?:^|\n)👥\s*(\d{1,2})\s+осіб(?:\s|$)/u.exec(text)?.[1];
  const householdSize = household ? Number(household) : null;
  return {
    listingId,
    location: cleanLine(location || 'невідома'),
    areaSqm: area ? Number(area.replace(',', '.')) : null,
    ...(validHouseholdSize(householdSize) ? { householdSize } : {})
  };
}

function groupChat(update) {
  const chat = update?.message?.chat || update?.callback_query?.message?.chat;
  return chat && (chat.type === 'group' || chat.type === 'supergroup') ? chat : null;
}

function normalizeGroupCallback(update, config) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return null;
  const query = update?.callback_query;
  const match = CALLBACK.exec(String(query?.data || ''));
  if (!match || typeof query?.id !== 'string' || !query.id || query.id.length > 256 || !validUserId(query?.from?.id) || query.from.is_bot === true) return null;
  const message = query.message;
  const chat = message?.chat;
  const username = message?.from?.username;
  if (!message || !chat || !['group', 'supergroup'].includes(chat.type) || !isAllowedPilotChat(config, chat.id) || message.from?.is_bot !== true) return null;
  if (username !== undefined && username !== BOT_USERNAME) return null;
  const ownerUserId = Number(match[2]);
  if (!validUserId(ownerUserId)) return null;
  return {
    updateId: update.update_id,
    callbackId: query.id,
    chatId: chat.id,
    userId: query.from.id,
    ownerUserId,
    messageId: message.message_id,
    ...contextFromListing(message.caption, match[1])
  };
}

async function telegramJSON(config, method, payload, transport, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const parsed = await readBoundedJSON(response, 32768);
    return { ok: response.ok && !parsed.error && parsed.value?.ok === true, data: parsed.error ? null : parsed.value };
  } catch {
    return { ok: false, data: null };
  } finally {
    clearTimeout(timeout);
  }
}

function replyParameters(messageId) {
  return Number.isSafeInteger(messageId) && messageId > 0
    ? { message_id: messageId, allow_sending_without_reply: false }
    : null;
}

async function sendGroupText(config, chatId, text, transport, options = {}) {
  const payload = {
    chat_id: chatId,
    ...telegramTextStyle(String(text || '').slice(0, 4096)),
    disable_notification: true,
    link_preview_options: { is_disabled: true }
  };
  const reply = replyParameters(options.replyToMessageId);
  if (reply) payload.reply_parameters = reply;
  if (options.forceReply) {
    payload.reply_markup = {
      force_reply: true,
      selective: !!reply,
      input_field_placeholder: String(options.placeholder || 'Введіть відповідь').slice(0, 64)
    };
  } else if (options.radiusKeyboard) {
    payload.reply_markup = {
      keyboard: [
        [{ text:'5 км' }, { text:'10 км' }, { text:'15 км' }],
        [{ text:'25 км' }, { text:'50 км' }],
        [{ text:'🏘 По району' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
      selective: true,
      input_field_placeholder: 'Радіус або весь район'
    };
  } else if (options.sourceUrl) {
    payload.reply_markup = { inline_keyboard: [[{ text:'↗ Офіційне джерело', url: options.sourceUrl }]] };
  }
  const result = await telegramJSON({ ...config, chatId }, 'sendMessage', payload, transport);
  return result.ok && Number.isSafeInteger(result.data?.result?.message_id) && result.data.result.message_id > 0 && result.data.result?.chat?.id === chatId;
}

function groupStepOne(context) {
  return [
    '🏛 Перевірка під Jobcenter',
    `Оголошення: #${context.listingId}`,
    `Локація: ${context.location}`,
    ...(Number.isFinite(context.areaSqm) ? [`Площа: ${String(context.areaSqm).replace('.', ',')} м²`] : []),
    '',
    'Крок 1/2: вкажіть кількість осіб у домогосподарстві (1–20).'
  ].join('\n');
}

function costLabel(rule) {
  return rule.costMeasure || 'Bruttokaltmiete (без Heizkosten)';
}

function validityLabel(rule) {
  if (rule.validFrom) return `від ${rule.validFrom}`;
  if (rule.validityLabel && rule.verifiedCurrentOn) return `${rule.validityLabel}; актуальність перевірено ${rule.verifiedCurrentOn}`;
  if (rule.verifiedCurrentOn) return `актуальність перевірено ${rule.verifiedCurrentOn}`;
  return 'за поточною перевіреною офіційною таблицею';
}

function areaGuidelineText(rule) {
  const area = Number(rule?.maxAreaSqm);
  return Number.isFinite(area) && area > 0 ? `; площа-орієнтир до ${area} м²` : '';
}

function groupStepTwo(context, persons, resolved, prefix = '') {
  const { module, rule } = resolved;
  return [
    ...(prefix ? [prefix, ''] : []),
    `🏛 ${module.authority}`,
    `Оголошення: #${context.listingId}`,
    `Локація: ${context.location}`,
    `Домогосподарство: ${persons}`,
    ...(Number.isFinite(context.areaSqm) ? [`Площа оголошення: ${String(context.areaSqm).replace('.', ',')} м²`] : []),
    `Перевірений орієнтир ${validityLabel(rule)}: до ${formatEuro(rule.grossColdLimit)} — ${costLabel(rule)}${areaGuidelineText(rule)}.`,
    ...(!areaGuidelineText(rule) && module.areaNoteUk ? [module.areaNoteUk] : []),
    '',
    'Крок 2/2: надішліть три суми, наприклад:',
    'Kaltmiete 700, Betriebskosten 150, Heizkosten 100'
  ].join('\n');
}

function pendingText(context, persons, resolved) {
  if (resolved.status === 'individual_review') {
    return [
      `⚠️ ${resolved.module.authority}: для домогосподарства з ${persons} осіб опублікована таблиця не дає автоматичного ліміту.`,
      `Локація: ${context.location}.`,
      'Потрібна індивідуальна перевірка Jobcenter. Автоматичне ✅ не ставлю.'
    ].join('\n');
  }
  if (resolved.pending) {
    return [
      `⚠️ ${resolved.pending.authority}`,
      `Локація: ${context.location}.`,
      resolved.pending.messageUk,
      '',
      'До прямої верифікації числових значень бот не підставляє ліміт іншої території і не ставить автоматичне ✅.'
    ].join('\n');
  }
  return [
    `⚠️ Для локації «${context.location}» критерії Jobcenter ще не верифіковані або локацію неможливо однозначно віднести до перевіреної зони.`,
    'Автоматичне ✅ не ставлю.'
  ].join('\n');
}

function finalAssessment(context, persons, assessment) {
  const { module, rule } = assessment;
  const common = [
    `Локація: ${context.location} · домогосподарство: ${persons}`,
    `Фактично: ${formatEuro(assessment.grossCold)} Kaltmiete + Betriebskosten; Heizkosten ${formatEuro(assessment.heizkosten)}.`,
    `Орієнтир ${module.authority}: ${formatEuro(rule.grossColdLimit)}${areaGuidelineText(rule)}.`,
    ...(!areaGuidelineText(rule) && module.areaNoteUk ? [module.areaNoteUk] : []),
    heatingRuleText(rule.heatingRule),
    '',
    `Остаточну перевірку та погодження нової оренди робить ${module.authority}. Ця автоматична перевірка не є Zusicherung.`
  ];
  if (assessment.status === 'over_limit') return [`❌ Перевищення опублікованого орієнтира ${module.authority}.`, ...common].join('\n');
  if (assessment.status === 'needs_review') return ['⚠️ Потрібна індивідуальна перевірка площі або іншого локального параметра.', ...common].join('\n');
  return ['✅ За перевіреними опублікованими критеріями сума Kaltmiete + Betriebskosten не перевищує орієнтир.', ...common].join('\n');
}

async function betaStorage(env, payload) {
  if (!env.OUTBOX) return { status:'unavailable' };
  try {
    const id = env.OUTBOX.idFromName('telegram-pilot-v1');
    const response = await env.OUTBOX.get(id).fetch(`https://outbox.internal${INTERNAL_PATH}`, {
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

function adminReply(text) {
  const command = /^\/([a-z]+)/i.exec(String(text || '').trim())?.[1]?.toLowerCase();
  if (command === 'status' || command === 'health') return '🔐 Beta Worker відповідає. Детальні технічні дані, ID, secrets і debug у групі не публікуються.';
  return '🔐 Адміністративна функція доступна лише у безпечному режимі. Технічні ID, черги, secrets і debug-дані в групу не виводяться.';
}

async function handleGroupJobcenterMessage(message, state, config, env, now, transport) {
  const context = { listingId:state.listingId, location:state.location, areaSqm:state.areaSqm ?? null };
  if (state.step === 'persons') {
    const persons = Number(String(message.text || '').trim());
    if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20) {
      const delivered = await sendGroupText(config, message.chatId, groupStepOne(context), transport, { replyToMessageId:message.messageId, forceReply:true, placeholder:'Напр.: 4' });
      return { handled:true, delivered };
    }
    const resolved = resolveJobcenterRule(context.location, persons);
    if (resolved.status !== 'verified') {
      await betaStorage(env, { op:'jc_clear', chatId:message.chatId, userId:message.userId });
      const delivered = await sendGroupText(config, message.chatId, pendingText(context, persons, resolved), transport, { replyToMessageId:message.messageId, sourceUrl:resolved.pending?.sourceUrl });
      return { handled:true, delivered };
    }
    const stored = await betaStorage(env, { op:'jc_persons', chatId:message.chatId, userId:message.userId, persons, now });
    if (stored.status !== 'ok') return { handled:true, delivered:false };
    const delivered = await sendGroupText(config, message.chatId, groupStepTwo(context, persons, resolved), transport, { replyToMessageId:message.messageId, forceReply:true, placeholder:'Kaltmiete / Betriebskosten / Heizkosten' });
    return { handled:true, delivered };
  }

  const persons = state.persons;
  const resolved = resolveJobcenterRule(context.location, persons);
  if (resolved.status !== 'verified') {
    await betaStorage(env, { op:'jc_clear', chatId:message.chatId, userId:message.userId });
    const delivered = await sendGroupText(config, message.chatId, pendingText(context, persons, resolved), transport, { replyToMessageId:message.messageId, sourceUrl:resolved.pending?.sourceUrl });
    return { handled:true, delivered };
  }
  const breakdown = parseRentBreakdown(message.text);
  const assessment = evaluateJobcenterHousing({ ...context, householdSize:persons, ...breakdown });
  if (assessment.status === 'insufficient_data') {
    const delivered = await sendGroupText(config, message.chatId, groupStepTwo(context, persons, resolved, '⚠️ Недостатньо даних. Потрібні всі три окремі суми.'), transport, { replyToMessageId:message.messageId, forceReply:true, placeholder:'Kaltmiete / Betriebskosten / Heizkosten' });
    return { handled:true, delivered };
  }
  await betaStorage(env, { op:'jc_clear', chatId:message.chatId, userId:message.userId });
  if (!['within_guideline','over_limit','needs_review'].includes(assessment.status)) {
    const delivered = await sendGroupText(config, message.chatId, pendingText(context, persons, assessment), transport, { replyToMessageId:message.messageId, sourceUrl:assessment.pending?.sourceUrl });
    return { handled:true, delivered };
  }
  const delivered = await sendGroupText(config, message.chatId, finalAssessment(context, persons, assessment), transport, { replyToMessageId:message.messageId, sourceUrl:assessment.module.sources?.[0]?.url });
  return { handled:true, delivered };
}

async function handleGroupCallback(update, callback, config, env, now, transport) {
  const currentConfig = { ...config, chatId:callback.chatId };
  if (callback.userId !== callback.ownerUserId) {
    await telegramJSON(currentConfig, 'answerCallbackQuery', { callback_query_id:callback.callbackId, text:'Ця кнопка належить іншому пошуку.' }, transport, 5000);
    return { handled:true, response:json({ ok:true, mode:'group-beta', delivered:false }) };
  }
  const started = await betaStorage(env, {
    op:'jc_start',
    message:{ id:callback.updateId, chatId:callback.chatId, userId:callback.userId, messageId:callback.messageId },
    context:{ listingId:callback.listingId, location:callback.location, areaSqm:callback.areaSqm },
    now
  });
  if (started.status === 'rate_limited') {
    await telegramJSON(currentConfig, 'answerCallbackQuery', { callback_query_id:callback.callbackId, text:'Забагато запитів. Спробуйте трохи пізніше.' }, transport, 5000);
    return { handled:true, response:json({ ok:true, mode:'group-beta', delivered:false }) };
  }
  if (started.status !== 'ok') {
    await telegramJSON(currentConfig, 'answerCallbackQuery', { callback_query_id:callback.callbackId, text:'Запит уже оброблено або тимчасово недоступний.' }, transport, 5000);
    return { handled:true, response:json({ ok:true, mode:'group-beta', delivered:false }) };
  }
  await telegramJSON(currentConfig, 'answerCallbackQuery', { callback_query_id:callback.callbackId, text:'Перевірка під Jobcenter' }, transport, 5000);

  if (validHouseholdSize(callback.householdSize)) {
    const persons = callback.householdSize;
    const resolved = resolveJobcenterRule(callback.location, persons);
    if (resolved.status !== 'verified') {
      await betaStorage(env, { op:'jc_clear', chatId:callback.chatId, userId:callback.userId });
      const delivered = await sendGroupText(currentConfig, callback.chatId, pendingText(callback, persons, resolved), transport, { replyToMessageId:callback.messageId, sourceUrl:resolved.pending?.sourceUrl });
      return { handled:true, response:json({ ok:true, mode:'group-beta', delivered }) };
    }
    const stored = await betaStorage(env, { op:'jc_persons', chatId:callback.chatId, userId:callback.userId, persons, now });
    if (stored.status !== 'ok') return { handled:true, response:json({ ok:true, mode:'group-beta', delivered:false }) };
    const delivered = await sendGroupText(currentConfig, callback.chatId, groupStepTwo(callback, persons, resolved), transport, { replyToMessageId:callback.messageId, forceReply:true, placeholder:'Kaltmiete / Betriebskosten / Heizkosten' });
    return { handled:true, response:json({ ok:true, mode:'group-beta', delivered }) };
  }

  const delivered = await sendGroupText(currentConfig, callback.chatId, groupStepOne(callback), transport, { replyToMessageId:callback.messageId, forceReply:true, placeholder:'Напр.: 4' });
  return { handled:true, response:json({ ok:true, mode:'group-beta', delivered }) };
}

export async function handleGroupBetaUpdate(update, env = {}, now = Date.now(), transport = fetch, suppliedConfig = null) {
  const chat = groupChat(update);
  if (!chat) return { handled:false };
  const config = suppliedConfig || pilotConfig(env);
  if (!config || !isAllowedPilotChat(config, chat.id)) return { handled:true, response:json({ ok:true, ignored:true }) };

  const callback = normalizeGroupCallback(update, config);
  if (update?.callback_query) {
    if (!callback) return { handled:true, response:json({ ok:true, ignored:true }) };
    return handleGroupCallback(update, callback, config, env, now, transport);
  }

  const message = normalizePilotUpdate(update, now);
  if (!message || message.chatId !== chat.id) return { handled:true, response:json({ ok:true, ignored:true }) };
  const currentConfig = { ...config, chatId:message.chatId };
  const route = await betaStorage(env, { op:'message', message, now });
  if (route.status === 'duplicate' || route.status === 'rate_limited') return { handled:true, response:json({ ok:true, mode:'group-beta', delivered:false }) };
  if (route.status !== 'ok') return { handled:true, response:json({ error:'State unavailable' }, 503) };

  if (route.handled && route.criteria) {
    const result = await searchLiveHousing(route.criteria, klazApiKey(env), transport);
    const baseText = formatHousingListings(route.criteria, result);
    const hasListings = result.status === 'ok' && result.listings?.length;
    if (!hasListings && !route.criteria.districtSearch) {
      const currentRadius = Number(route.criteria.radiusKm) || 15;
      const bigger = [5, 10, 15, 25, 50].filter(value => value > currentRadius);
      const next = bigger.length
        ? `Спробуйте більший радіус (${bigger.join(', ')} км) або «🏘 По району».`
        : 'Максимальний радіус уже 50 км. Спробуйте «🏘 По району».';
      const delivered = await sendGroupText(currentConfig, message.chatId, `${baseText}\n\n${next}`, transport, {
        replyToMessageId:message.messageId,
        radiusKeyboard:true
      });
      return { handled:true, response:json({ ok:true, mode:'group-beta', delivered }) };
    }

    const text = route.criteria.districtSearch
      ? `${baseText}\n\nРежим пошуку: весь ${route.criteria.location}.`
      : baseText;
    const householdLine = route.criteria.jobcenter && validHouseholdSize(route.criteria.householdSize)
      ? `👥 ${route.criteria.householdSize} осіб`
      : null;
    const media = hasListings ? housingListingMedia(result).map(item => householdLine
      ? { ...item, caption:`${item.caption}\n${householdLine}` }
      : item) : [];
    const replyMarkup = hasListings ? housingListingsMarkup(result) : externalHousingSearchMarkup(route.criteria);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const sent = await sendHousingMediaReply({ config:currentConfig, media, text, replyMarkup, transport, signal:controller.signal, replyToMessageId:message.messageId, ownerUserId:message.userId });
      return { handled:true, response:json({ ok:true, mode:'group-beta', delivered:sent.status === 'sent' }) };
    } finally {
      clearTimeout(timeout);
    }
  }

  if (route.handled && route.reply) {
    const radiusKeyboard = /Оберіть радіус:/u.test(route.reply);
    const delivered = await sendGroupText(currentConfig, message.chatId, route.reply, transport, {
      replyToMessageId:message.messageId,
      forceReply:!radiusKeyboard,
      radiusKeyboard,
      placeholder:route.reply.includes('кімнат') ? 'Напр.: 3 або 3-4' : route.reply.includes('бюджет') ? 'Напр.: 950 €' : 'Введіть відповідь'
    });
    return { handled:true, response:json({ ok:true, mode:'group-beta', delivered }) };
  }

  if (message.trigger === 'reply') {
    const state = await betaStorage(env, { op:'jc_read', chatId:message.chatId, userId:message.userId, now });
    if (state.status === 'ok' && state.state) {
      const result = await handleGroupJobcenterMessage(message, state.state, currentConfig, env, now, transport);
      return { handled:true, response:json({ ok:true, mode:'group-beta', delivered:result.delivered }) };
    }
  }

  if (isAdminCommand(message.text)) {
    if (!isPilotAdmin(config, message.userId)) return { handled:true, response:json({ ok:true, mode:'group-beta', delivered:false }) };
    const delivered = await sendGroupText(currentConfig, message.chatId, adminReply(message.text), transport, { replyToMessageId:message.messageId });
    return { handled:true, response:json({ ok:true, mode:'group-beta', delivered }) };
  }

  const text = replyFor(message);
  const markup = replyMarkupFor(text);
  const entryCommand = /^\/(start|help|topics)(?:@ZaskaletaInfoBot)?(?:\s|$)/i.test(message.text);
  const delivered = await sendGroupText(currentConfig, message.chatId, text, transport, {
    replyToMessageId:entryCommand ? undefined : message.messageId,
    forceReply:entryCommand || markup?.force_reply === true,
    placeholder:entryCommand ? 'Напишіть тему, наприклад: Житло' : markup?.input_field_placeholder
  });
  return { handled:true, response:json({ ok:true, mode:'group-beta', delivered }) };
}

export class GroupTelegramOutbox extends BaseTelegramOutbox {
  constructor(ctx, env) {
    super(ctx, env);
    this.beta = new GroupBetaState(ctx.storage);
    ctx.blockConcurrencyWhile(async () => { this.beta.init(); });
  }

  async alarm() {
    await super.alarm();
    try { this.beta.purge(); } catch {}
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== INTERNAL_PATH) return super.fetch(request);
    const config = pilotConfig(this.env);
    if (!config) return json({ status:'unavailable' }, 503);
    const parsed = await readBoundedJSON(request, 16384);
    if (parsed.error) return json({ status:'unavailable' }, parsed.error === 'too_large' ? 413 : 400);
    const value = parsed.value;
    try {
      if (value?.op === 'message') {
        if (!isAllowedPilotChat(config, value.message?.chatId)) return json({ status:'forbidden' }, 403);
        return json(this.beta.process(value.message, value.now));
      }
      if (value?.op === 'jc_start') {
        if (!isAllowedPilotChat(config, value.message?.chatId)) return json({ status:'forbidden' }, 403);
        return json(this.beta.startJobcenter(value.message, value.context, value.now));
      }
      if (value?.op === 'jc_read') {
        if (!isAllowedPilotChat(config, value.chatId)) return json({ status:'forbidden' }, 403);
        return json({ status:'ok', state:this.beta.readJobcenter(value.chatId, value.userId, value.now) });
      }
      if (value?.op === 'jc_persons') {
        if (!isAllowedPilotChat(config, value.chatId)) return json({ status:'forbidden' }, 403);
        const state = this.beta.setJobcenterPersons(value.chatId, value.userId, value.persons, value.now);
        return json(state ? { status:'ok', state } : { status:'missing' });
      }
      if (value?.op === 'jc_clear') {
        if (!isAllowedPilotChat(config, value.chatId)) return json({ status:'forbidden' }, 403);
        this.beta.clearJobcenter(value.chatId, value.userId);
        return json({ status:'ok' });
      }
      return json({ status:'bad_operation' }, 400);
    } catch {
      return json({ status:'unavailable' }, 503);
    }
  }
}
