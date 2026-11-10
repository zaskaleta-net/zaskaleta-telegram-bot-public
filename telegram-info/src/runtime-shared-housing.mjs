// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { pilotConfig, equalSecret, readBoundedJSON } from './pilot-security.mjs';
import { privatePilotAccessAllowed } from './runtime-access.mjs';
import { knownHousingLocation, parseHouseholdSize } from './housing-language.mjs';
const STATELESS_PATH = '/telegram/stateless';
const TELEGRAM_TIMEOUT_MS = 8000;
const SHARED_CHOICE = /^sh:(3|1x2):(.{1,48})$/u;
const SHARED_RADIUS = /^shr:(5|10|15|25|50):(\d{2,5}(?:[.,]\d{1,2})?):([WK]):(.{1,48})$/u;
const TWO_ONE_PROMPT = /^Пошук двох 1-кімнатних квартир поруч\s*[—–-]\s*([^\n.]{2,80})\./u;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function canonicalSharedLocation(text) {
  const known = knownHousingLocation(text);
  if (known) return known;
  return /(?:^|[^\p{L}])любік(?:а|у|ом|ові|і|е)?(?=$|[^\p{L}])/iu.test(String(text || '')) ? 'Lübeck' : null;
}

function callbackLocation(value) {
  try {
    const decoded = decodeURIComponent(String(value || ''));
    if (!/^[\p{L}\p{M}.'’ -]{2,40}$/u.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function encodedLocation(value) {
  const encoded = encodeURIComponent(String(value || ''));
  return new TextEncoder().encode(encoded).byteLength <= 40 ? encoded : null;
}

function callbackPersons(query) {
  const value = Number(/(?:^|\n)👥\s*(\d{1,2})\s+(?:особи|осіб|людини|людей)(?=\s|$)/iu.exec(String(query?.message?.text || ''))?.[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 20 ? value : null;
}

function parseSharedHousingIntent(text) {
  const source = String(text || '').normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!/(?:житл|квартир|wohnung|wohnraum|оренд|miete)/iu.test(source)) return null;
  const location = canonicalSharedLocation(source);
  const persons = parseHouseholdSize(source);
  const hasThreeRoom = /(?:^|[^\p{L}])(?:3|три)[-\s]*кімнат(?:н?[\p{L}\p{M}]*)/iu.test(source);
  const hasTwoOneRoom = /(?:^|[^\p{L}])(?:2|дві|два)\s+(?:окрем[\p{L}\p{M}]*\s+)?(?:1|одно)[-\s]*кімнатн[\p{L}\p{M}]*/iu.test(source);
  if (!location || !hasThreeRoom || !hasTwoOneRoom) return null;
  return {
    location,
    persons:Number.isSafeInteger(persons) && persons >= 1 && persons <= 20 ? persons : null,
    nearby:/(?:^|[^\p{L}])(?:поруч|рядом|nearby)(?=$|[^\p{L}])|in\s+der\s+n[aä]he/iu.test(source)
  };
}

function parsePerApartmentBudget(text) {
  const match = /^(?:до\s*)?(\d{2,5})(?:[.,](\d{1,2}))?\s*(?:€|eur|euro|євро)?\s*(warmmiete|kaltmiete|warm|kalt)?\s*$/iu.exec(String(text || '').trim());
  if (!match) return null;
  const amount = Number(match[1] + (match[2] ? `.${match[2]}` : ''));
  if (!Number.isFinite(amount) || amount < 100 || amount > 50000 || !match[3]) return null;
  const type = /^warm/iu.test(match[3]) ? 'Warmmiete' : 'Kaltmiete';
  return { amount:Math.round(amount * 100) / 100, type };
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

async function sendPrivate(config, chatId, text, transport, replyMarkup) {
  const payload = {
    chat_id:chatId,
    text,
    disable_notification:true,
    link_preview_options:{ is_disabled:true }
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramJSON(config, 'sendMessage', payload, transport);
}

async function answerCallback(config, id, transport) {
  if (typeof id !== 'string' || !id) return;
  await telegramJSON(config, 'answerCallbackQuery', { callback_query_id:id }, transport);
}

function sharedChoiceText(intent) {
  return [
    '🏠 Зрозумів запит.',
    `📍 ${intent.location}`,
    ...(intent.persons ? [`👥 ${intent.persons} особи`] : []),
    '',
    'Можемо шукати:',
    '1️⃣ одну 3-кімнатну квартиру;',
    `2️⃣ дві окремі 1-кімнатні квартири${intent.nearby ? ' поруч' : ''}.`,
    '',
    'Оберіть, з якого варіанта почати.'
  ].join('\n');
}

function sharedChoiceMarkup(location) {
  const encoded = encodedLocation(location);
  if (!encoded) return null;
  return {
    inline_keyboard:[
      [{ text:'1️⃣ 1× 3-кімнатна', callback_data:`sh:3:${encoded}` }],
      [{ text:'2️⃣ 2× 1-кімнатні поруч', callback_data:`sh:1x2:${encoded}` }]
    ]
  };
}

function radiusMarkup(location, amount, type) {
  const encoded = encodedLocation(location);
  if (!encoded) return null;
  const typeCode = type === 'Warmmiete' ? 'W' : 'K';
  const shown = Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace('.', ',');
  const button = radius => ({ text:`${radius} км`, callback_data:`shr:${radius}:${shown}:${typeCode}:${encoded}` });
  return { inline_keyboard:[[button(5), button(10), button(15)], [button(25), button(50)]] };
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

function syntheticSearchRequest(request, update, location, amount, typeCode, radius) {
  const query = update.callback_query;
  const copy = {
    update_id:update.update_id,
    message:{
      message_id:query.message.message_id,
      date:query.message.date || Math.floor(Date.now() / 1000),
      chat:query.message.chat,
      from:query.from,
      text:`🔎 ${location} · 1 · ${amount} · ${typeCode} · ${radius}km`
    }
  };
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method:'POST', headers, body:JSON.stringify(copy) });
}

export async function handleSharedHousingRequest(request, env = {}, now = Date.now(), transport = fetch) {
  const secured = await securedPrivateUpdate(request, env, transport);
  if (!secured) return null;
  const { config, update, chatId } = secured;

  const message = update?.message;
  if (message) {
    const previous = String(message?.reply_to_message?.text || '').trim();
    const twoOne = TWO_ONE_PROMPT.exec(previous);
    if (twoOne) {
      const location = twoOne[1].replace(/\s+/gu, ' ').trim();
      const budget = parsePerApartmentBudget(message.text);
      if (!budget) {
        const sent = await sendPrivate(config, chatId,
          `Для двох 1-кімнатних квартир у ${location} вкажіть бюджет на ОДНУ квартиру разом із типом оренди, наприклад: 700 € Warmmiete.`,
          transport,
          { force_reply:true, input_field_placeholder:'Напр.: 700 € Warmmiete' });
        return json({ ok:true, mode:'shared-housing-budget', delivered:sent.ok, valid:false });
      }
      const shown = Number.isInteger(budget.amount) ? String(budget.amount) : budget.amount.toFixed(2).replace('.', ',');
      const markup = radiusMarkup(location, budget.amount, budget.type);
      if (!markup) return null;
      const sent = await sendPrivate(config, chatId,
        [`Пошук двох 1-кімнатних квартир поруч — ${location}.`, `Бюджет на одну: до ${shown} € ${budget.type}.`, '', 'Оберіть радіус пошуку.'].join('\n'),
        transport,
        markup);
      return json({ ok:true, mode:'shared-housing-radius', delivered:sent.ok });
    }

    const intent = parseSharedHousingIntent(message.text);
    if (intent) {
      const markup = sharedChoiceMarkup(intent.location);
      if (!markup) return null;
      const sent = await sendPrivate(config, chatId, sharedChoiceText(intent), transport, markup);
      return json({ ok:true, mode:'shared-housing-choice', delivered:sent.ok, location:intent.location, persons:intent.persons });
    }
    return null;
  }

  const query = update?.callback_query;
  const choice = SHARED_CHOICE.exec(String(query?.data || ''));
  if (choice) {
    const location = callbackLocation(choice[2]);
    if (!location) return null;
    const persons = callbackPersons(query);
    await answerCallback(config, query.id, transport);
    if (choice[1] === '3') {
      const text = persons
        ? [
            `Житло — ${location}, 3 кімнати.`,
            `Осіб: ${persons}`,
            '',
            '✅ Дані збережено.',
            'Що саме потрібно?',
            'Оберіть дію нижче або напишіть її своїми словами.'
          ].join('\n')
        : `Житло — ${location}, 3 кімнати. Що саме потрібно?\nНапишіть один варіант: пошук житла, перевірка оренди, Jobcenter-погодження або відповідь орендодавцю.`;
      const sent = await sendPrivate(config, chatId,
        text,
        transport,
        { force_reply:true, input_field_placeholder:'Напр.: пошук житла' });
      return json({ ok:true, mode:'shared-housing-three-room', delivered:sent.ok, persons });
    }
    const sent = await sendPrivate(config, chatId,
      [`Пошук двох 1-кімнатних квартир поруч — ${location}.`, ...(persons ? [`Осіб: ${persons}`] : []), 'Вкажіть максимальний бюджет на ОДНУ квартиру та тип оренди: Warmmiete або Kaltmiete.', 'Наприклад: 700 € Warmmiete.'].join('\n'),
      transport,
      { force_reply:true, input_field_placeholder:'Напр.: 700 € Warmmiete' });
    return json({ ok:true, mode:'shared-housing-two-one-room', delivered:sent.ok, persons });
  }

  const radius = SHARED_RADIUS.exec(String(query?.data || ''));
  if (radius) {
    const location = callbackLocation(radius[4]);
    if (!location) return null;
    const amount = Number(radius[2].replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 100 || amount > 50000) return null;
    await answerCallback(config, query.id, transport);
    await sendPrivate(config, chatId,
      `🔎 Шукаю 1-кімнатні варіанти у ${location}. Із результатів потрібно буде вибрати дві квартири, розташовані найближче одна до одної.`,
      transport);
    return { request:syntheticSearchRequest(request, update, location, radius[2], radius[3], radius[1]) };
  }

  return null;
}
