import { budgetLineOfPrompt, withBudgetLine } from './housing-budget-line.mjs';
import { pilotConfig, equalSecret, readBoundedJSON } from './pilot-security.mjs';
import { privatePilotAccessAllowed } from './runtime-access.mjs';
import { resolveSchleswigHolsteinMunicipalityText } from './municipality-directory.mjs';
import { normalizeHousingLocation, parseHouseholdSize } from './housing-language.mjs';
import { parseRoomSpec, roomsWord } from './rooms.mjs';

const STATELESS_PATH = '/telegram/stateless';
const TELEGRAM_TIMEOUT_MS = 8000;
const ROOM_PROMPT = /^Тема: житло\s*[—–-]\s*([^\n]{1,100}?)\s*\.{1,3}\s*Локацію вже визначено\.[\s\S]*?кількість кімнат/iu;
const ROOM_RETRY_PROMPT = /^Для житла\s*[—–-]\s*([^\n]{1,80}?)\s+вкажіть кількість кімнат/iu;
const PEOPLE_PROMPT = /^🏠 Дані пошуку житла збережено\.\n📍 Локація: ([^\n]{1,80})\n🛏 Кімнат: (\d{1,2}(?:-\d{1,2})?)\n👥 Вкажіть кількість людей/iu;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function cleanPromptLocation(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(/^(?:місто|город|city|stadt)\s+/iu, '')
    .replace(/[.\s]+$/gu, '')
    .trim();
}

function canonicalLocation(value) {
  const supplied = cleanPromptLocation(value);
  if (!supplied) return null;
  if (/^любік(?:а|у|ом|ові|і|е)?$/iu.test(supplied)) return 'Lübeck';
  return normalizeHousingLocation(supplied);
}

function promptLocationRaw(previous) {
  const match = ROOM_PROMPT.exec(previous) || ROOM_RETRY_PROMPT.exec(previous);
  return match ? cleanPromptLocation(match[1]) : null;
}

function promptLocation(previous) {
  const raw = promptLocationRaw(previous);
  return raw ? canonicalLocation(raw) : null;
}

function promptKnownPersons(previous) {
  const value = Number(/^Осіб:\s*(\d{1,2})\s*$/mu.exec(String(previous || ''))?.[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 20 ? value : null;
}

function householdCount(text) {
  const source = String(text || '').trim();
  const direct = /^\d{1,2}$/u.test(source) ? Number(source) : null;
  if (Number.isSafeInteger(direct) && direct >= 1 && direct <= 20) return direct;
  return parseHouseholdSize(source);
}

function naturalRoomSpec(text) {
  const source = String(text || '');
  const match = /(?:^|[^\p{N}])(\d{1,2}(?:\s*[-–—/]\s*\d{1,2})?)\s*(?:кімнат[\p{L}\p{M}]*|кімн\.?|zimmer|rooms?)(?=$|[^\p{L}])/iu.exec(source);
  return parseRoomSpec(match?.[1]);
}

function housingAction(text) {
  const source = String(text || '');
  if (/(?:пошук\s+житла|шук(?:аю|ати|аємо|аєте)?\s+(?:житло|квартир)|wohnung\s+suchen|wohnungssuche)/iu.test(source)) return 'пошук житла';
  if (/(?:job[\s-]*center|джоб[\s-]*[цс][еэ]нт[еэ]?р)/iu.test(source)) return 'житло під Jobcenter';
  if (/(?:перевірк[аи]?\s+оренд|miete\s+prüfen|mietprüfung)/iu.test(source)) return 'перевірка оренди';
  if (/(?:відповід[ьи]?\s+орендодавц|vermieter.*antwort)/iu.test(source)) return 'відповідь орендодавцю';
  return null;
}

async function resolvedPromptMunicipality(raw, transport) {
  const supplied = cleanPromptLocation(raw);
  if (!supplied) return null;
  const resolved = await resolveSchleswigHolsteinMunicipalityText(supplied, transport);
  if (resolved?.canonical) return resolved;
  const canonical = canonicalLocation(supplied);
  if (canonical && canonical !== supplied) {
    const retry = await resolveSchleswigHolsteinMunicipalityText(canonical, transport);
    if (retry?.canonical) return retry;
  }
  return null;
}

function clarificationText(raw) {
  const supplied = cleanPromptLocation(raw) || 'цю назву';
  const lines = [
    `📍 Не вдалося однозначно визначити «${supplied}» як місто або громаду Schleswig-Holstein.`
  ];
  if (/^(?:рейнсберг|райнсберг|reinsberg|rheinsberg)$/iu.test(supplied)) {
    lines.push('Можливо, ви мали на увазі Rendsburg. Якщо так — напишіть: Rendsburg.');
  }
  lines.push('Інакше надішліть точну назву міста/громади або поштовий індекс.');
  return lines.join('\n');
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

async function sendPrivate(config, chatId, text, transport, placeholder) {
  const result = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text,
    disable_notification:true,
    link_preview_options:{ is_disabled:true },
    reply_markup:{
      force_reply:true,
      input_field_placeholder:String(placeholder || 'Введіть відповідь').slice(0, 64)
    }
  }, transport);
  return result.ok && Number.isSafeInteger(result.data?.result?.message_id) && result.data.result.message_id > 0 && result.data.result?.chat?.id === chatId;
}

async function securedPrivateMessage(request, env, transport) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const update = parsed.value;
  const message = update?.message;
  const chatId = Number(message?.chat?.id);
  const userId = Number(message?.from?.id);
  if (message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || message?.from?.is_bot === true) return null;
  if (!(await privatePilotAccessAllowed(update, config, transport))) return null;
  return { config, update, message, chatId };
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

export async function normalizePrivateHousingContextRequest(request, env = {}, transport = fetch) {
  const secured = await securedPrivateMessage(request, env, transport);
  if (!secured) return { request, response:null };
  const { config, update, message, chatId } = secured;
  const previous = String(message?.reply_to_message?.text || '').trim();
  const text = String(message?.text || '').trim();
  const rawLocation = promptLocationRaw(previous);
  if (!rawLocation || !text) return { request, response:null };

  const rooms = naturalRoomSpec(text);
  const persons = householdCount(text);
  const action = housingAction(text);
  if (!rooms || !Number.isSafeInteger(persons) || persons < 1 || persons > 20 || !action) {
    return { request, response:null };
  }

  const municipality = await resolvedPromptMunicipality(rawLocation, transport);
  if (!municipality) {
    const delivered = await sendPrivate(config, chatId, clarificationText(rawLocation), transport, 'Напр.: Rendsburg');
    return {
      request,
      response:json({ ok:true, mode:'private-housing-location-clarification', delivered, location:rawLocation })
    };
  }

  const copy = JSON.parse(JSON.stringify(update));
  copy.message.text = `${municipality.canonical}. ${action}. Для ${persons} осіб. ${rooms.label} ${roomsWord(rooms.label)}.`;
  delete copy.message.reply_to_message;
  return { request:requestFromUpdate(request, copy), response:null };
}

export async function handlePrivateHousingContinuity(request, env = {}, transport = fetch) {
  const secured = await securedPrivateMessage(request, env, transport);
  if (!secured) return null;
  const { config, message, chatId } = secured;
  const previous = String(message?.reply_to_message?.text || '').trim();
  const text = String(message?.text || '').trim();
  if (!previous || !text) return null;

  // Generic housing: after city -> rooms, keep the city. If household size was
  // already parsed in the previous step, do not ask for it a second time.
  // Jobcenter has its own verified household-size step and must remain untouched.
  if (!previous.includes('Для нормативів Jobcenter вкажіть кількість осіб')) {
    const rawLocation = promptLocationRaw(previous);
    const rooms = parseRoomSpec(text);
    if (rawLocation && rooms) {
      const municipality = await resolvedPromptMunicipality(rawLocation, transport);
      if (!municipality) {
        const delivered = await sendPrivate(config, chatId, clarificationText(rawLocation), transport, 'Напр.: Rendsburg');
        return json({ ok:true, mode:'private-housing-location-clarification', delivered, location:rawLocation });
      }
      const location = municipality.canonical || promptLocation(previous);
      const knownPersons = promptKnownPersons(previous);
      if (knownPersons) {
        const next = [
          `Житло — ${location}, ${rooms.label} ${roomsWord(rooms.label)}.`,
          `Осіб: ${knownPersons}`,
          '',
          '✅ Дані збережено.',
          'Що саме потрібно?',
          'Напишіть один варіант: пошук житла, житло під Jobcenter, перевірка оренди або відповідь орендодавцю.'
        ].join('\n');
        const delivered = await sendPrivate(config, chatId, withBudgetLine(next, budgetLineOfPrompt(previous)), transport, 'Напр.: пошук житла');
        return json({ ok:true, mode:'private-housing-household-preserved', delivered, location, rooms:rooms.label, persons:knownPersons });
      }
      const reply = [
        '🏠 Дані пошуку житла збережено.',
        `📍 Локація: ${location}`,
        `🛏 Кімнат: ${rooms.label}`,
        '👥 Вкажіть кількість людей, які житимуть у квартирі (1–20).'
      ].join('\n');
      const delivered = await sendPrivate(config, chatId, withBudgetLine(reply, budgetLineOfPrompt(previous)), transport, 'Напр.: 2');
      return json({ ok:true, mode:'private-housing-household-step', delivered, location, rooms:rooms.label });
    }
  }

  const peopleMatch = PEOPLE_PROMPT.exec(previous);
  if (!peopleMatch) return null;
  const location = canonicalLocation(peopleMatch[1]);
  const rooms = parseRoomSpec(peopleMatch[2]);
  if (!location || !rooms) return null;
  const persons = householdCount(text);
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20) {
    const retry = [
      '🏠 Дані пошуку житла збережено.',
      `📍 Локація: ${location}`,
      `🛏 Кімнат: ${rooms.label}`,
      '👥 Вкажіть кількість людей числом від 1 до 20.'
    ].join('\n');
    const delivered = await sendPrivate(config, chatId, withBudgetLine(retry, budgetLineOfPrompt(previous)), transport, 'Напр.: 2');
    return json({ ok:true, mode:'private-housing-household-step', delivered, valid:false });
  }

  const next = [
    `Житло — ${location}, ${rooms.label} ${roomsWord(rooms.label)}.`,
    `Осіб: ${persons}`,
    '',
    '✅ Дані збережено.',
    'Що саме потрібно?',
    'Напишіть один варіант: пошук житла, житло під Jobcenter, перевірка оренди або відповідь орендодавцю.'
  ].join('\n');
  const delivered = await sendPrivate(config, chatId, withBudgetLine(next, budgetLineOfPrompt(previous)), transport, 'Напр.: пошук житла');
  return json({ ok:true, mode:'private-housing-household-saved', delivered, location, rooms:rooms.label, persons });
}
