import { handle as baseHandle, STATELESS_PATH, TelegramOutbox } from './worker.mjs';
import { telegramTextStyle } from './telegram-text-style.mjs';
import { pilotConfig, equalSecret, normalizePilotUpdate, readBoundedJSON, statelessDirectReplyEnabled } from './pilot-security.mjs';
import { formatEuro, parseRentBreakdown } from './jobcenter-rules.mjs';
import { heatingRuleText } from './housing-cost-dialogue.mjs';
import { evaluateJobcenterHousing, resolveJobcenterRule } from './jobcenter-registry-statewide.mjs';

export { TelegramOutbox };

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const CALLBACK = /^jc:(\d{6,20})$/;
const BOT_USERNAME = 'ZaskaletaInfoBot';

function cleanLine(value, max = 160) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function listingContext(caption, listingId) {
  const text = String(caption || '');
  const location = /(?:^|\n)💶[^\n]*?·\s*([^\n]{2,120})/u.exec(text)?.[1];
  const area = /📐\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*м²/u.exec(text)?.[1];
  return {
    listingId,
    location: cleanLine(location || 'невідома'),
    areaSqm: area ? Number(area.replace(',', '.')) : null
  };
}

function normalizeJobcenterCallback(update, config) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return null;
  const q = update?.callback_query;
  const match = CALLBACK.exec(String(q?.data || ''));
  if (!match || typeof q?.id !== 'string' || !q.id || q.id.length > 256) return null;
  const m = q.message;
  const username = m?.from?.username;
  if (!m || m.chat?.type !== 'private' || m.chat?.id !== config.chatId || q.from?.id !== config.chatId || q.from?.is_bot === true || m.from?.is_bot !== true) return null;
  if (username !== undefined && username !== BOT_USERNAME) return null;
  return { updateId: update.update_id, callbackId: q.id, chatId: config.chatId, ...listingContext(m.caption, match[1]) };
}

function stepOnePrompt(context) {
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

function stepTwoPrompt(context, persons, resolved, prefix = '') {
  const { module, rule } = resolved;
  return [
    ...(prefix ? [prefix, ''] : []),
    `🏛 ${module.authority}`,
    `Реєстр: ${module.id}`,
    `Оголошення: #${context.listingId}`,
    `Локація: ${context.location}`,
    `Домогосподарство: ${persons}`,
    ...(Number.isFinite(context.areaSqm) ? [`Площа оголошення: ${String(context.areaSqm).replace('.', ',')} м²`] : []),
    `Перевірений орієнтир ${validityLabel(rule)}: до ${formatEuro(rule.grossColdLimit)} — ${costLabel(rule)}${areaPart(rule)}.`,
    '',
    'Крок 2/2: надішліть три суми, наприклад:',
    'Kaltmiete 700, Betriebskosten 150, Heizkosten 100'
  ].join('\n');
}

function parseContextFromPrompt(text) {
  const listingId = /Оголошення: #(\d{6,20})/u.exec(text)?.[1];
  const location = /(?:^|\n)Локація: ([^\n]{1,160})/u.exec(text)?.[1];
  const area = /(?:^|\n)(?:Площа|Площа оголошення): (\d{1,4}(?:[.,]\d{1,2})?) м²/u.exec(text)?.[1];
  if (!listingId || !location) return null;
  return { listingId, location: cleanLine(location), areaSqm: area ? Number(area.replace(',', '.')) : null };
}

function parsePersonsFromPrompt(text) {
  const value = Number(/(?:^|\n)Домогосподарство: (\d{1,2})/u.exec(String(text || ''))?.[1]);
  return Number.isSafeInteger(value) ? value : null;
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
      'До прямої верифікації числових значень бот не підставляє ліміт іншого Kreis і не ставить автоматичне ✅.'
    ].join('\n');
  }

  const area = resolved.jurisdiction ? ` (${resolved.jurisdiction})` : '';
  return [
    `⚠️ Для локації «${context.location}»${area} критерії Jobcenter ще не верифіковані або локацію неможливо однозначно віднести до перевіреної зони.`,
    'Автоматичне ✅ не ставлю.'
  ].join('\n');
}

// TG-RUNTIME-078 review: Hamburg publishes no area; "до null м²" is left out.
function areaPart(rule) {
  const area = Number(rule?.maxAreaSqm);
  return rule?.maxAreaSqm != null && Number.isFinite(area) && area > 0 ? `; площа-орієнтир до ${rule.maxAreaSqm} м²` : '';
}

function finalAssessment(context, persons, assessment) {
  const { module, rule } = assessment;
  const common = [
    `Локація: ${context.location} · домогосподарство: ${persons}`,
    `Фактично: ${formatEuro(assessment.grossCold)} Kaltmiete + Betriebskosten; Heizkosten ${formatEuro(assessment.heizkosten)}.`,
    `Орієнтир ${module.authority}: ${formatEuro(rule.grossColdLimit)}${areaPart(rule)}.`,
    heatingRuleText(rule.heatingRule),
    '',
    `Остаточну перевірку та погодження нової оренди робить ${module.authority}. Ця автоматична перевірка не є Zusicherung.`
  ];
  if (assessment.status === 'over_limit') return [`❌ Перевищення опублікованого орієнтира ${module.authority}.`, ...common].join('\n');
  if (assessment.status === 'needs_review') {
    const reason = assessment.reason === 'betriebskosten_below_published_minimum'
      ? 'заявлені Betriebskosten нижчі за опублікований мінімум для цієї території'
      : assessment.reason === 'area_required_for_betriebskosten_check'
        ? 'без площі неможливо перевірити локальну вимогу до Betriebskosten'
        : 'площа або інший локальний параметр потребує індивідуальної перевірки';
    return [`⚠️ Потрібна індивідуальна перевірка: ${reason}.`, ...common].join('\n');
  }
  return ['✅ За перевіреними опублікованими критеріями сума Kaltmiete + Betriebskosten не перевищує орієнтир.', ...common].join('\n');
}

function pendingReply(context, persons, resolved) {
  const pending = resolved.pending;
  return {
    text: pendingText(context, persons, resolved),
    forceReply: false,
    ...(pending?.sourceUrl ? {
      sourceUrl: pending.sourceUrl,
      authority: pending.authority,
      sourceButtonText: '↗ Офіційне джерело'
    } : {})
  };
}

function jobcenterFollowup(message) {
  const previous = String(message?.replyToText || '');
  const text = String(message?.text || '').trim();
  if (previous.startsWith('🏛 Перевірка під Jobcenter\n') && previous.includes('\nКрок 1/2:')) {
    const context = parseContextFromPrompt(previous);
    if (!context) return null;
    const persons = Number(text);
    if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20) return { text: stepOnePrompt(context), forceReply: true };
    const resolved = resolveJobcenterRule(context.location, persons);
    if (resolved.status !== 'verified') return pendingReply(context, persons, resolved);
    return { text: stepTwoPrompt(context, persons, resolved), forceReply: true };
  }

  if (previous.includes('\nРеєстр: ') && previous.includes('\nКрок 2/2:')) {
    const context = parseContextFromPrompt(previous);
    const persons = parsePersonsFromPrompt(previous);
    const resolved = context && persons ? resolveJobcenterRule(context.location, persons) : null;
    if (!context || !resolved || resolved.status !== 'verified') return null;

    const breakdown = parseRentBreakdown(text);
    const assessment = evaluateJobcenterHousing({ ...context, householdSize: persons, ...breakdown });
    if (assessment.status === 'insufficient_data') {
      return { text: stepTwoPrompt(context, persons, resolved, '⚠️ Недостатньо даних для автоматичного висновку. Потрібні всі три окремі суми.'), forceReply: true };
    }
    if (!['within_guideline', 'over_limit', 'needs_review'].includes(assessment.status)) {
      return pendingReply(context, persons, assessment);
    }
    return {
      text: finalAssessment(context, persons, assessment),
      forceReply: false,
      sourceUrl: assessment.module.sources[0].url,
      authority: assessment.module.authority
    };
  }
  return null;
}

async function telegramJSON(config, method, payload, transport, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    clearTimeout(timer);
  }
}

async function sendJobcenterText(config, reply, transport) {
  const payload = {
    chat_id: config.chatId,
    ...telegramTextStyle(reply.text),
    disable_notification: true,
    link_preview_options: { is_disabled: true }
  };
  if (reply.forceReply) {
    payload.reply_markup = {
      force_reply: true,
      selective: true,
      input_field_placeholder: reply.text.includes('Крок 1/2') ? 'Напр.: 4' : 'Kaltmiete 700, Betriebskosten 150, Heizkosten 100'
    };
  } else if (reply.sourceUrl) {
    payload.reply_markup = {
      inline_keyboard: [[{
        text: reply.sourceButtonText || `↗ Офіційні критерії ${reply.authority}`,
        url: reply.sourceUrl
      }]]
    };
  }
  const result = await telegramJSON(config, 'sendMessage', payload, transport);
  return result.ok && Number.isSafeInteger(result.data?.result?.message_id) && result.data.result?.chat?.id === config.chatId;
}

async function handleJobcenterCallback(callback, config, transport) {
  await telegramJSON(config, 'answerCallbackQuery', { callback_query_id: callback.callbackId, text: 'Перевірка під Jobcenter' }, transport, 5000);
  return sendJobcenterText(config, { text: stepOnePrompt(callback), forceReply: true }, transport);
}

export async function handle(request, env = {}, now = Date.now(), transport = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST') return baseHandle(request, env, now, transport);
  const fallback = request.clone();
  const config = pilotConfig(env);
  if (!config || env.TELEGRAM_INGRESS_ENABLED !== 'true' || !statelessDirectReplyEnabled(env)) return baseHandle(fallback, env, now, transport);
  if (!equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return baseHandle(fallback, env, now, transport);
  const parsed = await readBoundedJSON(request);
  if (parsed.error) return baseHandle(fallback, env, now, transport);

  const callback = normalizeJobcenterCallback(parsed.value, config);
  if (callback) {
    const delivered = await handleJobcenterCallback(callback, config, transport);
    return json({ ok: true, mode: 'stateless', delivered });
  }

  const message = normalizePilotUpdate(parsed.value, now);
  const reply = jobcenterFollowup(message);
  if (reply) {
    const delivered = await sendJobcenterText(config, reply, transport);
    return json({ ok: true, mode: 'stateless', delivered });
  }
  return baseHandle(fallback, env, now, transport);
}

export default { fetch(request, env) { return handle(request, env); } };
