import { handle as legacyHandle } from './worker-entry.mjs';
import { topicGuidance, placeFromText } from './topic-guidance.mjs';
import { STATELESS_PATH } from './worker.mjs';
import { handleGroupBetaUpdate } from './group-beta-runtime.mjs';
import { GroupTelegramOutbox, enrichCallbackHouseholdFromActiveFlow, normalizeJobcenterPersonsReply, rememberNaturalJobcenterContext } from './active-household-context.mjs';
import { pilotConfig, equalSecret, readBoundedJSON, isAllowedPilotChat, isPilotAdmin, normalizePilotUpdate, statelessDirectReplyEnabled } from './pilot-security.mjs';
import { syncBotCommandMetadata, botCommandsFor } from './bot-command-sync.mjs';
import { jobcenterSearchRoomFit } from './jobcenter-search-fit.mjs';
import { compactJobcenterStepTwo } from './jobcenter-compact-message.mjs';
import { telegramTextStyle } from './telegram-text-style.mjs';
import { housingJobcenterOverview } from './housing-jobcenter-overview.mjs';
import { normalizeHousingLocation, knownHousingLocation } from './housing-language.mjs';
import { evaluateJobcenterHousing, resolveJobcenterRule } from './jobcenter-registry-statewide.mjs';
import { formatEuro, parseRentBreakdown } from './jobcenter-rules.mjs';
import { parseRoomSpec, roomsWord } from './rooms.mjs';

export { GroupTelegramOutbox as TelegramOutbox };

const BOT_USERNAME = 'ZaskaletaInfoBot';
const GROUP_JC_CALLBACK = /^jc:(\d{6,20}):u(\d{1,20})$/;
const PRIVATE_HANDOFF_TEXT = '🔐 Для приватності персональні запити обробляються тільки в особистому чаті з ботом. У групі більше не публікуються результати пошуку житла, суми оренди або Jobcenter-перевірки.';
const GROUP_PANEL_TEXT = `🤖 Schleswig-Holstein Помічник 🇺🇦🇩🇪\n\nПерсональні запити працюють у приватному чаті.\nНатисніть «Відкрити помічник» — нічого додатково писати в групі не потрібно.\n\n🔐 Результати пошуку житла, Jobcenter-перевірки та персональні дані не публікуються в групі.`;
const GROUP_PANEL_COMMAND = /^\/(?:panel|menu)(?:@ZaskaletaInfoBot)?$/i;
const PRIVATE_START_ACTIONS = new Map([
  ['housing', 'Житло'],
  ['jobcenter_check', 'Житло під Jobcenter'],
  ['jobcenter_norms', 'Jobcenter житло'],
  ['assistant', '/start'],
  ['private', '/start']
]);
const NORMS_LOCATION_PROMPT = '📋 Норми Jobcenter — крок 1/2\n\nВкажіть місто або громаду у Schleswig-Holstein. Якщо знаєте лише Kreis, напишіть Kreis — бот уточнить громаду, коли це потрібно.';
const CHECK_LOCATION_PROMPT = '🏛 Перевірити під Jobcenter — крок 1/3\n\nПеревіримо конкретне житло. Вкажіть місто або громаду, де знаходиться квартира/будинок.';

const JOBCENTER_TOPIC_PROMPT = 'Тема: Jobcenter. Вкажіть місто або район і що саме потрібно: Bürgergeld, Bescheid, Mitwirkung, оренда/житло, строк або підготовка листа. Не надсилайте номер клієнта чи повні копії документів.';

function recognizedJobcenterLocation(text) {
  const source = cleanIntentLine(text, 160);
  const embedded = knownHousingLocation(source);
  if (embedded) return embedded;
  if (!/^[\p{L}\p{M}.'’ -]{2,100}$/u.test(source)) return null;
  const exact = normalizeHousingLocation(source);
  const resolved = exact ? resolveJobcenterRule(exact, 1) : null;
  return resolved?.jurisdiction ? exact : null;
}

function jobcenterHousingTopicReply(location) {
  return {
    text:`Тема: житло — ${location}. Локацію вже визначено.\nДля нормативів Jobcenter вкажіть кількість осіб (1–20).`,
    forceReply:true,
    placeholder:'Напр.: 3 особи'
  };
}

function groupNavigationKeyboard() {
  return { inline_keyboard:[
    [{ text:'🤖 Відкрити помічник', url:`https://t.me/${BOT_USERNAME}?start=assistant` }]
  ] };
}

export function privateDeepLinkAction(text) {
  const match = /^\/start(?:@ZaskaletaInfoBot)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/i.exec(String(text || '').trim());
  if (!match?.[1]) return null;
  return PRIVATE_START_ACTIONS.get(match[1].toLowerCase()) || null;
}

function cleanIntentLine(value, max = 120) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function promptLocation(text) {
  return cleanIntentLine(/(?:^|\n)Локація:\s*([^\n]{2,120})/u.exec(String(text || ''))?.[1]);
}

function promptPersons(text) {
  const value = Number(/(?:^|\n)(?:Осіб|Домогосподарство):\s*(\d{1,2})/u.exec(String(text || ''))?.[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 20 ? value : null;
}

function personsInput(text) {
  const source = String(text || '').trim();
  const match = /^(\d{1,2})(?:\s*(?:осіб|особи|особа|людей|людини|людина|personen?))?$/iu.exec(source);
  const value = Number(match?.[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 20 ? value : null;
}

function areaInput(text) {
  const match = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:м²|m²|m2|qm)(?=\s|[.,;:!?)]|$)/iu.exec(String(text || ''));
  const value = match ? Number(match[1].replace(',', '.')) : null;
  return Number.isFinite(value) && value > 0 && value <= 2000 ? value : null;
}

function sourceUrlFromText(text) {
  const value = /(?:^|\n)Джерело:\s*(https:\/\/[^\s]+)/u.exec(String(text || ''))?.[1];
  return value ? value.replace(/[),.;]+$/u, '') : null;
}

function normsFinal(location, persons) {
  const overview = housingJobcenterOverview(location, persons);
  if (overview.needsLocation) {
    return {
      text:`📋 Норми Jobcenter — уточнення\nОсіб: ${persons}\n\n${overview.text}\n\nНапишіть конкретне місто або громаду.`,
      forceReply:true,
      placeholder:'Напр.: Plön, Trittau або Norderstedt'
    };
  }
  return {
    text:`📋 Норми Jobcenter\nЛокація: ${location}\nДомогосподарство: ${persons}\n\n${overview.text}`,
    forceReply:false,
    sourceUrl:sourceUrlFromText(overview.text)
  };
}

function checkRentPrompt(location, persons) {
  return {
    text:[
      '🏛 Перевірити під Jobcenter — крок 3/3',
      `Локація: ${location}`,
      `Домогосподарство: ${persons}`,
      '',
      'Надішліть суми конкретного житла окремо:',
      'Kaltmiete 700, Betriebskosten 150, Heizkosten 100',
      'Якщо площа відома, додайте її, наприклад: 72 м².'
    ].join('\n'),
    forceReply:true,
    placeholder:'Kaltmiete 700, Betriebskosten 150, Heizkosten 100, 72 м²'
  };
}

function unresolvedCheckReply(location, persons) {
  const overview = housingJobcenterOverview(location, persons);
  if (overview.needsLocation) {
    return {
      text:`🏛 Перевірити під Jobcenter — уточнення\nОсіб: ${persons}\n\n${overview.text}\n\nНапишіть конкретне місто або громаду, де знаходиться житло.`,
      forceReply:true,
      placeholder:'Напр.: Plön, Trittau або Norderstedt'
    };
  }
  return {
    text:`⚠️ Автоматичну перевірку конкретного житла зараз не формую, тому що для цієї локації немає однозначного чинного автоматичного ліміту.\n\n${overview.text}`,
    forceReply:false,
    sourceUrl:sourceUrlFromText(overview.text)
  };
}

function checkAssessmentReply(location, persons, text) {
  const breakdown = parseRentBreakdown(text);
  const areaSqm = areaInput(text);
  const assessment = evaluateJobcenterHousing({ location, householdSize:persons, ...breakdown, ...(areaSqm ? { areaSqm } : {}) });
  if (assessment.status === 'insufficient_data') {
    return {
      ...checkRentPrompt(location, persons),
      text:`⚠️ Недостатньо даних. Потрібні три окремі суми: Kaltmiete, Betriebskosten без опалення та Heizkosten.\n\n${checkRentPrompt(location, persons).text}`
    };
  }
  if (!['within_guideline','over_limit','needs_review'].includes(assessment.status)) {
    return unresolvedCheckReply(location, persons);
  }

  const rule = assessment.rule;
  const authority = assessment.module?.authority || rule?.authority || 'Jobcenter';
  const headline = assessment.status === 'within_guideline'
    ? '✅ Kaltmiete + Betriebskosten не перевищують перевірений опублікований орієнтир.'
    : assessment.status === 'over_limit'
      ? '❌ Kaltmiete + Betriebskosten перевищують перевірений опублікований орієнтир.'
      : '⚠️ Потрібна індивідуальна перевірка Jobcenter.';
  const reason = assessment.status === 'needs_review'
    ? assessment.reason === 'betriebskosten_below_published_minimum'
      ? 'Причина: заявлені Betriebskosten нижчі за опублікований мінімум для цієї території.'
      : assessment.reason === 'area_required_for_betriebskosten_check'
        ? 'Причина: для локальної перевірки Betriebskosten потрібна площа житла.'
        : 'Причина: площа або інший локальний параметр потребує індивідуальної перевірки.'
    : null;
  const areaLine = areaSqm ? `Площа житла: ${String(areaSqm).replace('.', ',')} м².` : null;
  const sourceUrl = rule?.sourceUrl || assessment.module?.sources?.[0]?.url || null;
  return {
    text:[
      headline,
      `Локація: ${location} · домогосподарство: ${persons}.`,
      areaLine,
      `Фактично без опалення: ${formatEuro(assessment.grossCold)} (Kaltmiete + Betriebskosten).`,
      `Heizkosten: ${formatEuro(assessment.heizkosten)} — оцінюються окремо.`,
      `Орієнтир ${authority}: до ${formatEuro(rule.grossColdLimit)} Bruttokaltmiete${Number.isFinite(rule.maxAreaSqm) ? `; площа-орієнтир до ${rule.maxAreaSqm} м²` : ''}.`,
      reason,
      '',
      `Остаточне погодження конкретного житла надає ${authority}. Ця автоматична перевірка не є Zusicherung.`
    ].filter(Boolean).join('\n'),
    forceReply:false,
    sourceUrl
  };
}

function privateExplicitIntentReply(update) {
  const message = update?.message;
  if (!message) return null;
  const directText = cleanIntentLine(message.text, 160);
  if (/^(?:🏛\s*)?Jobcenter$/iu.test(directText)) {
    return { text:JOBCENTER_TOPIC_PROMPT, forceReply:true, placeholder:'Напр.: Lübeck, оренда/житло' };
  }
  const action = privateDeepLinkAction(message.text);
  if (action === 'Jobcenter житло') {
    return { text:NORMS_LOCATION_PROMPT, forceReply:true, placeholder:'Напр.: Plön або Kreis Plön' };
  }
  if (action === 'Житло під Jobcenter') {
    return { text:CHECK_LOCATION_PROMPT, forceReply:true, placeholder:'Напр.: Plön' };
  }

  const previous = String(message.reply_to_message?.text || '');
  const text = cleanIntentLine(message.text, 500);
  if (!previous || !text) return null;

  if (previous === JOBCENTER_TOPIC_PROMPT) {
    const location = recognizedJobcenterLocation(text) || placeFromText(text);
    const housing = /оренд|житл|wohnung|miete/iu.test(text);
    // A general question (Mitwirkung, Bescheid, …) is answered without a town.
    if (!location && /bürgergeld|buergergeld|bescheid|mitwirkung|widerspruch|frist|строк|рішенн|лист/iu.test(text)) {
      const guided = topicGuidance('jobcenter', text);
      if (guided && !guided.needsPlace) return { text:guided.text, forceReply:false };
    }
    if (!location) {
      return {
        text:'🏛 Jobcenter: не вдалося однозначно визначити місто або громаду. Вкажіть населений пункт, наприклад: Lübeck, Kiel, Trittau або Norderstedt.',
        forceReply:true,
        placeholder:'Напр.: Lübeck'
      };
    }
    if (housing) return jobcenterHousingTopicReply(location);
    // A concrete question (Bescheid, Mitwirkung, …) gets next steps right away.
    if (/bürgergeld|buergergeld|bescheid|mitwirkung|widerspruch|frist|строк|рішенн|лист/iu.test(text)) {
      const guided = topicGuidance('jobcenter', `${location}, ${text}`);
      if (guided && !guided.needsPlace) return { text:guided.text, forceReply:false };
    }
    return {
      text:`🏛 Jobcenter — ${location}\n\nЩо саме потрібно: Bürgergeld, Bescheid, Mitwirkung, оренда/житло, строк або підготовка листа?`,
      forceReply:true,
      placeholder:'Напр.: оренда/житло'
    };
  }

  const jobcenterLocationPrompt = /^🏛 Jobcenter — ([^\n]{2,120})/u.exec(previous);
  if (jobcenterLocationPrompt) {
    const location = jobcenterLocationPrompt[1].trim();
    if (/оренд|житл|wohnung|miete/iu.test(text)) return jobcenterHousingTopicReply(location);
    // The topic used to loop on "describe your question"; answer it instead.
    const guided = topicGuidance('jobcenter', `${location}, ${text}`);
    if (guided && !guided.needsPlace) return { text:guided.text, forceReply:false };
  }

  const privateJobcenterRoomPrompt = /^Тема: житло — ([^.\n]{2,120})\. Локацію вже визначено\./u.exec(previous);
  if (privateJobcenterRoomPrompt && previous.includes('Умова: житло під Jobcenter.') && previous.includes('Для пошуку підтвердьте кількість кімнат')) {
    const location = privateJobcenterRoomPrompt[1].trim();
    const persons = promptPersons(previous);
    const rooms = parseRoomSpec(text);
    // TG-RUNTIME-078: a new housing request ("Житло в Elmschorn під Jobcenter
    // для 2 осіб") is not a wrong rooms answer; the main reply handles it.
    if (!rooms && /житл|квартир|wohnung|wohnraum/iu.test(text)) return null;
    if (!rooms) {
      return {
        text:`Для пошуку житла — ${location} вкажіть кількість кімнат числом або діапазоном, наприклад: 2 або 2-3.`,
        forceReply:true,
        placeholder:'Напр.: 2'
      };
    }
    return {
      text:[
        `Пошук житла — ${location}, ${rooms.label} ${roomsWord(rooms.label)}. Уточніть максимальний місячний бюджет і, якщо знаєте, чи це Warmmiete або Kaltmiete.`,
        ...(persons ? [`Осіб: ${persons}`] : []),
        'Умова: житло під Jobcenter.',
        '⚠️ Опублікований ліміт Jobcenter вище є Bruttokaltmiete (Kaltmiete + Betriebskosten без Heizkosten). Я не підміняю його автоматично Kaltmiete або Warmmiete.'
      ].join('\n'),
      forceReply:true,
      placeholder:'Напр.: 700 € Kaltmiete або 900 € Warmmiete'
    };
  }

  if (previous.startsWith('📋 Норми Jobcenter — крок 1/2')) {
    const location = text;
    return {
      text:`📋 Норми Jobcenter — крок 2/2\nЛокація: ${location}\n\nВкажіть кількість осіб у домогосподарстві (1–20).`,
      forceReply:true,
      placeholder:'Напр.: 3 особи'
    };
  }
  if (previous.startsWith('📋 Норми Jobcenter — крок 2/2')) {
    const location = promptLocation(previous);
    const persons = personsInput(text);
    if (!location) return { text:NORMS_LOCATION_PROMPT, forceReply:true, placeholder:'Напр.: Plön' };
    if (!persons) return {
      text:`📋 Норми Jobcenter — крок 2/2\nЛокація: ${location}\n\nВкажіть кількість осіб числом від 1 до 20.`,
      forceReply:true,
      placeholder:'Напр.: 3 особи'
    };
    return normsFinal(location, persons);
  }
  if (previous.startsWith('📋 Норми Jobcenter — уточнення')) {
    const persons = promptPersons(previous);
    if (!persons) return null;
    return normsFinal(text, persons);
  }

  if (previous.startsWith('🏛 Перевірити під Jobcenter — крок 1/3')) {
    const location = text;
    return {
      text:`🏛 Перевірити під Jobcenter — крок 2/3\nЛокація: ${location}\n\nВкажіть кількість осіб у домогосподарстві (1–20).`,
      forceReply:true,
      placeholder:'Напр.: 3 особи'
    };
  }
  if (previous.startsWith('🏛 Перевірити під Jobcenter — крок 2/3')) {
    const location = promptLocation(previous);
    const persons = personsInput(text);
    if (!location) return { text:CHECK_LOCATION_PROMPT, forceReply:true, placeholder:'Напр.: Plön' };
    if (!persons) return {
      text:`🏛 Перевірити під Jobcenter — крок 2/3\nЛокація: ${location}\n\nВкажіть кількість осіб числом від 1 до 20.`,
      forceReply:true,
      placeholder:'Напр.: 3 особи'
    };
    const resolved = resolveJobcenterRule(location, persons);
    if (resolved.status !== 'verified') return unresolvedCheckReply(location, persons);
    return checkRentPrompt(location, persons);
  }
  if (previous.startsWith('🏛 Перевірити під Jobcenter — уточнення')) {
    const persons = promptPersons(previous);
    if (!persons) return null;
    const resolved = resolveJobcenterRule(text, persons);
    if (resolved.status !== 'verified') return unresolvedCheckReply(text, persons);
    return checkRentPrompt(text, persons);
  }
  if (previous.startsWith('🏛 Перевірити під Jobcenter — крок 3/3')) {
    const location = promptLocation(previous);
    const persons = promptPersons(previous);
    if (!location || !persons) return null;
    return checkAssessmentReply(location, persons, message.text);
  }
  return null;
}

function callbackRoomFit(update) {
  const query = update?.callback_query;
  if (!query || !/^jc:/u.test(String(query.data || ''))) return null;
  const caption = String(query.message?.caption || '');
  const persons = Number(/(?:^|\n)👥\s*(\d{1,2})\s+осіб(?:\s|$)/u.exec(caption)?.[1]);
  const listingRooms = /🛏\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:кімн\.?|кімнат|Zimmer|Zi\.?)/iu.exec(caption)?.[1];
  const targetRooms = /(?:^|\n)🎯\s*Пошук:\s*(\d{1,2}(?:\s*[-–—]\s*\d{1,2})?)\s+кімнат/iu.exec(caption)?.[1];
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20 || !listingRooms) return null;
  return jobcenterSearchRoomFit({ listingRooms, targetRooms, persons });
}

function compactingTransport(transport, fit) {
  return async (url, options = {}) => {
    if (/\/sendMessage$/u.test(String(url || '')) && typeof options.body === 'string') {
      try {
        const payload = JSON.parse(options.body);
        if (typeof payload.text === 'string' && /Крок\s*2\/2:/u.test(payload.text)) {
          const compact = compactJobcenterStepTwo(payload.text, fit);
          const styled = telegramTextStyle(compact);
          payload.text = styled.text;
          payload.entities = styled.entities;
          delete payload.parse_mode;
          return transport(url, { ...options, body:JSON.stringify(payload) });
        }
      } catch {}
    }
    return transport(url, options);
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function groupPrivateOnlyEnabled(env = {}) {
  return env.TELEGRAM_GROUP_PRIVATE_ONLY !== 'false';
}

function privateEnvForUser(env, userId) {
  const original = String(env.TELEGRAM_ALLOWED_CHAT_IDS || '').trim();
  const ids = original ? `${userId},${original}` : String(userId);
  return { ...env, TELEGRAM_ALLOWED_CHAT_IDS:ids };
}

function cloneAsPrivate(update) {
  const copy = JSON.parse(JSON.stringify(update || {}));
  if (copy?.message) {
    const userId = copy.message?.from?.id;
    if (!Number.isSafeInteger(userId) || userId <= 0) return { update:null, userId:null, ownerMismatch:false };
    copy.message.chat = { id:userId, type:'private' };
    if (copy.message.reply_to_message) {
      copy.message.reply_to_message.chat = { id:userId, type:'private' };
    }
    return { update:copy, userId, ownerMismatch:false };
  }

  const query = copy?.callback_query;
  if (query) {
    const userId = query?.from?.id;
    if (!Number.isSafeInteger(userId) || userId <= 0) return { update:null, userId:null, ownerMismatch:false };
    const match = GROUP_JC_CALLBACK.exec(String(query.data || ''));
    if (match) {
      const ownerUserId = Number(match[2]);
      if (ownerUserId !== userId) return { update:null, userId, ownerMismatch:true };
      query.data = `jc:${match[1]}`;
    }
    if (!query.message) return { update:null, userId, ownerMismatch:false };
    query.message.chat = { id:userId, type:'private' };
    if (query.message.reply_to_message) {
      query.message.reply_to_message.chat = { id:userId, type:'private' };
    }
    return { update:copy, userId, ownerMismatch:false };
  }
  return { update:null, userId:null, ownerMismatch:false };
}

async function telegramJSON(config, method, payload, transport, timeoutMs = 8000) {
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
    return { ok:response.ok && !parsed.error && parsed.value?.ok === true, data:parsed.error ? null : parsed.value };
  } catch {
    return { ok:false, data:null };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendPrivateIntentReply(config, chatId, reply, transport) {
  const payload = {
    chat_id:chatId,
    ...telegramTextStyle(reply.text),
    disable_notification:true,
    link_preview_options:{ is_disabled:true }
  };
  if (reply.forceReply) {
    payload.reply_markup = {
      force_reply:true,
      selective:true,
      input_field_placeholder:reply.placeholder || 'Введіть відповідь'
    };
  } else if (reply.sourceUrl) {
    payload.reply_markup = { inline_keyboard:[[{ text:'↗ Офіційне джерело', url:reply.sourceUrl }]] };
  }
  const result = await telegramJSON(config, 'sendMessage', payload, transport);
  return result.ok && Number.isSafeInteger(result.data?.result?.message_id) && result.data.result?.chat?.id === chatId;
}

async function isAuthorizedGroupAdmin(config, chatId, userId, transport) {
  if (isPilotAdmin(config, userId)) return true;
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const admins = await telegramJSON(config, 'getChatAdministrators', { chat_id:chatId }, transport, 5000);
  const members = admins.data?.result;
  if (!admins.ok || !Array.isArray(members)) return false;
  return members.some(member => member?.user?.id === userId && ['creator','administrator'].includes(member?.status));
}

async function publishAndPinGroupPanel(config, chatId, transport) {
  const sent = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    ...telegramTextStyle(GROUP_PANEL_TEXT),
    disable_notification:true,
    link_preview_options:{ is_disabled:true },
    reply_markup:groupNavigationKeyboard()
  }, transport);
  const messageId = sent.data?.result?.message_id;
  if (!sent.ok || !Number.isSafeInteger(messageId) || sent.data?.result?.chat?.id !== chatId) return { sent:false, pinned:false };
  const pinned = await telegramJSON(config, 'pinChatMessage', { chat_id:chatId, message_id:messageId, disable_notification:true }, transport, 5000);
  return { sent:true, pinned:pinned.ok, messageId };
}

export function privateDeepLinkRequest(request, update) {
  const action = privateDeepLinkAction(update?.message?.text);
  if (!action) return request;
  const copy = JSON.parse(JSON.stringify(update));
  copy.message.text = action;
  delete copy.message.reply_to_message;
  return new Request(request.url, { method:'POST', headers:request.headers, body:JSON.stringify(copy) });
}

// Private listing cards carry jc:<id>:u<owner>; the legacy Jobcenter check
// understands only jc:<id>. Convert it for the owner's own private chat only.
export function privateOwnedCallbackRequest(request, update) {
  const query = update?.callback_query;
  const match = GROUP_JC_CALLBACK.exec(String(query?.data || ''));
  const userId = query?.from?.id;
  if (!match || Number(match[2]) !== userId || query?.message?.chat?.id !== userId) return request;
  const copy = JSON.parse(JSON.stringify(update));
  copy.callback_query.data = `jc:${match[1]}`;
  return new Request(request.url, { method:'POST', headers:request.headers, body:JSON.stringify(copy) });
}

async function sendGroupPrivateHandoff(config, chatId, transport) {
  const result = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    ...telegramTextStyle(PRIVATE_HANDOFF_TEXT),
    disable_notification:true,
    link_preview_options:{ is_disabled:true },
    reply_markup:groupNavigationKeyboard()
  }, transport);
  return result.ok && Number.isSafeInteger(result.data?.result?.message_id) && result.data.result?.chat?.id === chatId;
}

async function answerForeignGroupCallback(config, update, transport) {
  const callbackId = update?.callback_query?.id;
  if (typeof callbackId !== 'string' || !callbackId) return false;
  const result = await telegramJSON(config, 'answerCallbackQuery', {
    callback_query_id:callbackId,
    text:'Ця кнопка належить іншому учаснику.'
  }, transport, 5000);
  return result.ok;
}

async function handleGroupPrivateOnly(request, update, config, env, now, transport) {
  const chat = update?.message?.chat || update?.callback_query?.message?.chat;
  if (!chat || !['group','supergroup'].includes(chat.type) || !isAllowedPilotChat(config, chat.id)) {
    return json({ ok:true, ignored:true });
  }

  const normalized = update?.message ? normalizePilotUpdate(update, now) : null;
  if (update?.message && !normalized) return json({ ok:true, ignored:true });

  if (update?.message && GROUP_PANEL_COMMAND.test(String(update.message.text || '').trim())) {
    if (!(await isAuthorizedGroupAdmin(config, chat.id, update.message.from?.id, transport))) return json({ ok:true, mode:'group-private-only', ignored:true });
    const panel = await publishAndPinGroupPanel(config, chat.id, transport);
    return json({ ok:true, mode:'group-private-only', delivered:panel.sent, pinned:panel.pinned });
  }

  const privateCopy = cloneAsPrivate(update);
  if (privateCopy.ownerMismatch) {
    await answerForeignGroupCallback(config, update, transport);
    return json({ ok:true, mode:'group-private-only', delivered:false });
  }
  if (!privateCopy.update || !Number.isSafeInteger(privateCopy.userId)) return json({ ok:true, ignored:true });

  const privateRequest = new Request(request.url, {
    method:'POST',
    headers:request.headers,
    body:JSON.stringify(privateCopy.update)
  });
  const privateEnv = privateEnvForUser(env, privateCopy.userId);
  let deliveredPrivate = false;
  try {
    const response = await legacyHandle(privateRequest, privateEnv, now, transport);
    const body = await response.clone().json().catch(() => null);
    deliveredPrivate = response.ok && body?.delivered === true;
  } catch {}

  if (deliveredPrivate) {
    return json({ ok:true, mode:'group-private-only', delivered:true, private:true });
  }

  const delivered = await sendGroupPrivateHandoff(config, chat.id, transport);
  return json({ ok:true, mode:'group-private-only', delivered, private:false });
}

export async function handle(request, env = {}, now = Date.now(), transport = fetch) {
  const url = new URL(request.url);
  if (url.pathname === STATELESS_PATH && request.method === 'POST') {
    const config = pilotConfig(env);
    if (config && env.TELEGRAM_INGRESS_ENABLED === 'true' && statelessDirectReplyEnabled(env) &&
        equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) {
      const inspected = request.clone();
      const parsed = await readBoundedJSON(inspected);
      if (!parsed.error) {
        let update = parsed.value;
        const chat = update?.message?.chat || update?.callback_query?.message?.chat;
        const isGroup = chat?.type === 'group' || chat?.type === 'supergroup';
        const isPrivate = chat?.type === 'private' && Number.isSafeInteger(chat?.id) && chat.id > 0;
        const isStart = /^\/start(?:@ZaskaletaInfoBot)?(?:\s|$)/i.test(String(update?.message?.text || '').trim());
        if (isStart && transport === fetch) {
          const commandSync = await syncBotCommandMetadata(config, transport, Number.isSafeInteger(chat?.id) ? chat.id : null, { commands:botCommandsFor(env) });
          console.info('TELEGRAM_COMMAND_SYNC', JSON.stringify({ status:commandSync.status }));
        }

        if (isPrivate) {
          const explicitReply = privateExplicitIntentReply(update);
          if (explicitReply) {
            const delivered = await sendPrivateIntentReply(config, chat.id, explicitReply, transport);
            return json({ ok:true, mode:'private-explicit-intent', delivered });
          }
          return legacyHandle(privateOwnedCallbackRequest(privateDeepLinkRequest(request, update), update), privateEnvForUser(env, chat.id), now, transport);
        }

        if (isGroup) {
          const normalized = normalizePilotUpdate(update, now);
          if (normalized && isAllowedPilotChat(config, normalized.userId) && /^\/chatid(?:@ZaskaletaInfoBot)?$/i.test(normalized.text.trim())) {
            // TG-RUNTIME-065: logs are kept 3 days; no chat IDs in them.
            const configured = config.chatIds.includes(normalized.chatId);
            console.info('TELEGRAM_GROUP_ID_CHECK', JSON.stringify({ configured }));
          }
          const date = update?.message?.date;
          const age = Number.isSafeInteger(date) ? now - date * 1000 : null;
          console.info('TELEGRAM_GROUP_GATE', JSON.stringify({ allowed:isAllowedPilotChat(config, chat.id), callback:!!update?.callback_query, normalized:!!normalizePilotUpdate(update, now), age:age === null ? 'missing' : age > 300000 ? 'expired' : age < -60000 ? 'future' : 'fresh' }));

          if (groupPrivateOnlyEnabled(env)) {
            const response = await handleGroupPrivateOnly(request, update, config, env, now, transport);
            try {
              const result = await response.clone().json();
              console.info('TELEGRAM_GROUP_RESULT', JSON.stringify({ status:response.status, ignored:result.ignored === true, delivered:typeof result.delivered === 'boolean' ? result.delivered : null, private:result.private === true }));
            } catch {}
            return response;
          }
        }

        if (update?.message) {
          await rememberNaturalJobcenterContext(update, env, now);
          update = normalizeJobcenterPersonsReply(update);
        }
        const enrichedUpdate = await enrichCallbackHouseholdFromActiveFlow(update, env, now);
        const fit = callbackRoomFit(enrichedUpdate);
        const group = await handleGroupBetaUpdate(enrichedUpdate, env, now, compactingTransport(transport, fit), config);
        if (group.handled) {
          try {
            const result = await group.response.clone().json();
            console.info('TELEGRAM_GROUP_RESULT', JSON.stringify({ status:group.response.status, ignored:result.ignored === true, delivered:typeof result.delivered === 'boolean' ? result.delivered : null }));
          } catch {}
          return group.response;
        }
      }
    }
  }
  return legacyHandle(request, env, now, transport);
}

export default { fetch(request, env) { return handle(request, env); } };
