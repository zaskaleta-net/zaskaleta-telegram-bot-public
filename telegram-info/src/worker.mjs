import { acquireSearchSlot, searchRateText } from './search-rate-limit.mjs';
import { housingCostFollowup } from './housing-cost-dialogue.mjs';
import { START_TEXT } from './start-text.mjs';
import { normalizeHousingLocation, knownHousingLocation, parseHouseholdSize } from './housing-language.mjs';
import { housingJobcenterOverview, suggestedHousingRooms } from './housing-jobcenter-overview.mjs';
import { BOT_DISPLAY_NAME, telegramTextStyle } from './telegram-text-style.mjs';
import { Outbox } from './outbox.mjs';
import { pilotConfig, isAllowedPilotChat, equalSecret, normalizePilotUpdate, readBoundedJSON, sendPilotMessage, statelessDirectReplyEnabled } from './pilot-security.mjs';
import { AUDIT_PATH, handleQueueAudit, readQueueSnapshot } from './queue-audit.mjs';
import { planAlarm } from './alarm-policy.mjs';
import { klazApiKey, parseHousingSearchAction, housingSearchAction, formatHousingListings, housingListingMedia, housingListingsMarkup, externalHousingSearchMarkup } from './housing-provider.mjs';
import { parseRoomSpec, roomsWord } from './rooms.mjs';
import { sendHousingMediaReply } from './telegram-media.mjs';
import { searchPrimaryHousing } from './housing-primary-search.mjs';
import { topicOfPrompt, topicOfText, topicGuidance, placeFromText } from './topic-guidance.mjs';
import { privacyCommandText } from './privacy-policy.mjs';
import { impressumCommandText } from './legal-commands.mjs';
import { landlordReply, LANDLORD_PROMPT } from './landlord-reply.mjs';
import { beratungPlace } from './beratung-bamf.mjs';
import { eventsPlace } from './events-nordticker.mjs';
import { foldTown, startsNewHousingDialogue } from './housing-open-town.mjs';
import { budgetFromText, budgetLine, budgetLineOfPrompt, budgetOfPrompt, withBudgetLine } from './housing-budget-line.mjs';
import { resolveBarePlaceName } from './place-search.mjs';
import { canonicalHamburgPlace, hamburgPlaceRoute } from './hamburg-place-names.mjs';
import { SH_UKRAINIAN_PLACE_ROWS } from './schleswig-holstein-place-names.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
export const STATELESS_PATH = '/telegram/stateless';
const JOBCENTER_NAME = /job[\s-]*center|джоб[\s-]*[цс][еэ]нт[еэ]?р/iu;
const START = START_TEXT;
const HELP = 'Команди:\n\n/start — початок\n/menu — меню з темами\n/help — допомога\n/topics — теми\n/news — свіжі новини\n/events — куди піти\n/beratung — безкоштовні консультації\n/watch — моніторинг житла (нові оголошення)\n/scanner — розібрати лист за фото або текстом (ШІ)\n/report — повідомити про помилку\n/privacy — конфіденційність\n/impressum — вихідні дані (Impressum)\n/forget — видалити мої дані\n\nТакож можна відповісти боту назвою теми: Jobcenter, Familienkasse, документи, житло, робота, курси, школа, Kita або транспорт.\n\nСервіс не є державним органом.';
const TOPICS = 'Теми:\n\n• Документи та перебування\n• Jobcenter і Familienkasse\n• Житло\n• Робота\n• Інтеграційні курси\n• Школа та Kita\n• Транспорт і повсякденне життя у Schleswig-Holstein\n\nНапишіть у відповідь назву теми та місто або район.';
const PRIVACY = privacyCommandText();
const IMPRESSUM = impressumCommandText();
const NOT_READY = 'Дякуємо за звернення. База перевірених офіційних джерел ще готується. Поки що сервіс не формує автоматичну відповідь, щоб не надати неперевірену інформацію. Напишіть /topics, щоб обрати доступну тему.';

function extractLocation(text) {
  const source = String(text || '').trim();
  // Known municipalities first: "Neustadt in Holstein" must not lose its name
  // to the German preposition inside it.
  const known = knownHousingLocation(source);
  if (known) return known;
  const compound = /(?:^|[\s,])([A-ZÄÖÜ][a-zäöüß.'’-]{1,40}\s+in\s+[A-ZÄÖÜ][a-zäöüß.'’-]{1,40})(?=$|[,.!?]|\s)/u.exec(source);
  if (compound) return compound[1];
  const match = /(?:^|[\s,])(?:в|у|in)\s+([\p{Lu}][\p{L}\p{M}.'’-]{1,40}(?:\s+[\p{Lu}][\p{L}\p{M}.'’-]{1,40}){0,2})(?=$|[,.!?]|\s)/u.exec(source);
  return match?.[1] || null;
}

// TG-RUNTIME-075: the budget line belongs to the housing search only; the
// rent check, the Jobcenter approval and the landlord letter have their own
// sums, and the search parameters already state the budget.
const NO_BUDGET_LINE = /^(?:Перевірка оренди|Jobcenter-погодження житла|Відповідь орендодавцю|Параметри житла|Критерії пошуку)/u;

function housingContext(reply, previous, typed = '') {
  // These explicit lines keep family size separate from rooms in stateless replies.
  const details = [];
  const persons = Number(/^Осіб: (\d{1,2})$/mu.exec(previous)?.[1]);
  if (persons >= 1 && persons <= 20 && !/^Осіб:/mu.test(reply)) details.push(`Осіб: ${persons}`);
  const rooms = parseRoomSpec(/^Кімнат: (\d{1,2}(?:-\d{1,2})?)$/mu.exec(previous)?.[1]);
  if (rooms && !/^(?:🛏 )?Кімнат:|,\s*\d{1,2}(?:-\d{1,2})? кімнат(?:а|и)?\./mu.test(reply)) details.push(`Кімнат: ${rooms.label}`);
  // TG-RUNTIME-075: the budget rides along like the household size.
  const budget = budgetLine(budgetFromText(typed)) || budgetLineOfPrompt(previous);
  if (budget && !budgetOfPrompt(reply) && !NO_BUDGET_LINE.test(reply)) details.push(budget);
  const condition = 'Умова: житло під Jobcenter.';
  if (previous.split('\n').includes(condition) && !reply.split('\n').includes(condition)) details.push(condition);
  return details.length ? `${reply}\n${details.join('\n')}` : reply;
}

// TG-RUNTIME-070: the same texts as the button flow (runtime-keyboard.mjs), so
// a typed request gets the same buttons (persons, then the actions) and the
// next typed answer continues the same dialogue.
function housingRoomsReply(location, rooms, persons) {
  return persons
    ? [`Житло — ${location}, ${rooms} ${roomsWord(rooms)}.`, `Осіб: ${persons}`, '', '✅ Дані збережено.', 'Що саме потрібно?', 'Оберіть дію нижче або напишіть її своїми словами.'].join('\n')
    : ['🏠 Дані пошуку житла збережено.', `📍 Локація: ${location}`, `🛏 Кімнат: ${rooms}`, '👥 Вкажіть кількість людей, які житимуть у квартирі (1–20).'].join('\n');
}

function housingEntryReply({ location, persons, rooms, jobcenter }) {
  const details = [
    ...(persons ? [`Осіб: ${persons}`] : []),
    ...(rooms ? [`Кімнат: ${rooms.label}`] : []),
    ...(jobcenter ? ['Умова: житло під Jobcenter.'] : [])
  ].join('\n');
  if (jobcenter && location) {
    if (!persons) return housingContext(`Тема: житло — ${location}. Локацію вже визначено.\nДля нормативів Jobcenter вкажіть кількість осіб (1–20).`, details);
    const overview = housingJobcenterOverview(location, persons);
    if (overview.needsLocation) return housingContext(`Тема: житло. Вкажіть місто або район.\n\n${overview.text}`, details);
    const suggestion = suggestedHousingRooms(persons);
    const title = rooms ? `Житло — ${location}, ${rooms.label} ${roomsWord(rooms.label)}.` : `Тема: житло — ${location}. Локацію вже визначено.`;
    const roomLine = rooms ? `Кімнати для пошуку: ${rooms.label} (ви зазначили).`
      : suggestion ? `Кімнати для пошуку: ${suggestion} — рекомендація, не норматив Jobcenter. Потреби залежать від складу сім’ї.`
        : 'Кількість кімнат для пошуку оберемо за потребами сім’ї.';
    const question = rooms ? 'Оберіть дію: пошук житла, перевірка оренди, Jobcenter-погодження або відповідь орендодавцю.'
      : `Для пошуку підтвердьте кількість кімнат${suggestion ? `: ${suggestion} або ваш варіант` : ''}.`;
    return housingContext(`${title}\nОсіб: ${persons}\n\n${overview.text}\n\n${roomLine}\n\n${question}`, details);
  }
  if (location && rooms) return housingRoomsReply(location, rooms.label, persons);
  const prompt = !location ? 'Тема: житло. Вкажіть місто або район.'
    : `Тема: житло — ${location}. Локацію вже визначено.\nВкажіть кількість кімнат, наприклад: 3 або 3-4.`;
  return housingContext(prompt, details);
}

function naturalHousingEntry(raw, inPrivate = true, openStep = false) {
  if (!/житл|квартир|wohnung|wohnraum/iu.test(raw)) return null;
  // An explicit administrative question remains in its own topic.
  if (/bescheid|mitwirkung|bürgergeld|buergergeld|widerspruch|kindergeld|familienkasse/iu.test(raw)) return null;
  const persons = parseHouseholdSize(raw);
  const jobcenter = JOBCENTER_NAME.test(raw);
  const roomMatch = /(?:^|[\s,])(\d{1,2}(?:\s*[-–—/]\s*\d{1,2})?)\s*(?:кімнат(?:а|и)?|кімн\.?|zimmer|rooms?)(?=$|[^\p{L}])/iu.exec(raw);
  const rooms = parseRoomSpec(roomMatch?.[1]);
  const typed = extractLocation(raw);
  // A budget with a town opens the housing dialogue ("Житло в Kiel до 900 €"),
  // unless the compact form ("Kiel 3 900 € kalt") reads the whole request; a
  // budget alone is the answer to an open step ("пошук житла до 1000 €").
  if (!persons && !jobcenter && !rooms) {
    const budgetOnly = budgetFromText(raw);
    if (!budgetOnly || parseCompactHousingCriteria(raw)) return null;
    // No town and no open step: ask for the town and keep the budget.
    if (!typed) return openStep ? null : withBudgetLine('Тема: житло. Вкажіть місто або район.', budgetLine(budgetOnly));
  }
  // TG-RUNTIME-074: an unknown town one letter off a registered one gets the
  // question; the household size rides along for the rooms step (hkr:x).
  // The Jobcenter limit, not a budget, decides there (review #075).
  const budget = jobcenter ? null : budgetLine(budgetFromText(raw));
  const details = [...(persons ? [`Осіб: ${persons}`] : []), ...(rooms ? [`Кімнат: ${rooms.label}`] : []), ...(jobcenter ? ['Умова: житло під Jobcenter.'] : []), ...(budget ? [budget] : [])].join('\n');
  const spelled = typed && !knownHousingLocation(typed) ? umlautTown(typed) : null;
  const question = typed && !spelled && inPrivate ? townSuggestionText(typed, details) : null;
  if (question) return question;
  return withBudgetLine(housingEntryReply({ location: spelled || normalizeHousingLocation(typed), persons, rooms, jobcenter }), budget);
}

function parseBudget(text) {
  const match = /^(\d{2,5})(?:[.,](\d{1,2}))?\s*(?:€|eur|euro|євро)?(?:\s*(warmmiete|kaltmiete|warm|kalt))?$/iu.exec(String(text || '').trim());
  if (!match) return null;
  const amount = Number(match[1] + (match[2] ? '.' + match[2] : ''));
  if (!Number.isFinite(amount) || amount < 100 || amount > 50000) return null;
  const rawType = String(match[3] || '').toLowerCase();
  const type = rawType.startsWith('warm') ? 'Warmmiete' : rawType.startsWith('kalt') ? 'Kaltmiete' : null;
  return { amount: Math.round(amount * 100) / 100, type };
}

function formatAmount(amount) {
  return Number.isInteger(amount) ? String(amount) : Number(amount).toFixed(2).replace('.', ',');
}

// TG-RUNTIME-082: "Kiel 2 кімнати до 900 € warm" (the panel example) is
// the compact form too; "до" / "bis" before the sum was not understood.
function parseCompactHousingCriteria(text) {
  const source = String(text || '').trim();
  const match = /^([\p{L}\p{M}.'’ -]{2,80}?)[,\s]+(\d{1,2}(?:\s*(?:[-–—/]|або|чи|oder|bis|to)\s*\d{1,2})?)\s*(?:кімнат(?:а|и)?|кімн\.?|zimmer|rooms?)?[,\s]+((?:до|bis|max\.?|maximal|макс\.?)\s+)?(\d{2,5})(?:[.,](\d{1,2}))?\s*(?:€|eur|euro|євро)?(?:[,\s]+(warmmiete|kaltmiete|warm|kalt))?$/iu.exec(source);
  if (!match) return null;
  // Review #082: with "до" / "bis" the first words must be a known town
  // ("Шукаю 2 кімнати до 900 warm" is no search in "Шукаю").
  if (match[3] && !knownHousingLocation(match[1])) return null;
  const location = normalizeHousingLocation(match[1]);
  const roomSpec = parseRoomSpec(match[2]);
  const amount = Number(match[4] + (match[5] ? '.' + match[5] : ''));
  if (!location || !roomSpec || !Number.isFinite(amount) || amount < 100 || amount > 50000) return null;
  const rawType = String(match[6] || '').toLowerCase();
  const type = rawType.startsWith('warm') ? 'Warmmiete' : rawType.startsWith('kalt') ? 'Kaltmiete' : null;
  return { location, rooms: roomSpec.label, amount: Math.round(amount * 100) / 100, type };
}

function standaloneHousingRecovery(text) {
  const compact = parseCompactHousingCriteria(text);
  if (compact) {
    const amount = formatAmount(compact.amount);
    if (compact.type) return `Параметри житла: ${compact.location}, ${compact.rooms} ${roomsWord(compact.rooms)}, до ${amount} € ${compact.type}. Оберіть радіус пошуку: 5, 10, 15, 25 або 50 км.`;
    return `Пошук житла — ${compact.location}, ${compact.rooms} ${roomsWord(compact.rooms)}, бюджет до ${amount} €. Це Warmmiete чи Kaltmiete? Напишіть один варіант.`;
  }

  const budget = parseBudget(text);
  if (budget) {
    const amount = formatAmount(budget.amount);
    if (budget.type) return `Бюджет ${amount} € ${budget.type} розпізнано. Вкажіть місто або район.`;
    return `Бюджет ${amount} € розпізнано. Вкажіть місто або район.`;
  }

  const roomSpec = parseRoomSpec(text);
  if (roomSpec) {
    return `${roomSpec.label} ${roomsWord(roomSpec.label)} розпізнано. Додайте місто, бюджет і тип оренди одним повідомленням, наприклад: Hamburg, ${roomSpec.label} ${roomsWord(roomSpec.label)}, 950 € Warmmiete.`;
  }

  if (/^(?:warmmiete|kaltmiete|warm|kalt)$/iu.test(String(text || '').trim())) {
    return `Тип оренди розпізнано. Додайте місто, кількість кімнат і бюджет одним повідомленням, наприклад: Hamburg, 3-4 кімнати, 950 € ${/^warm/i.test(String(text || '').trim()) ? 'Warmmiete' : 'Kaltmiete'}.`;
  }

  return null;
}

function housingFollowup(message) {
  const text = String(message?.text || '').trim();
  const previous = String(message?.replyToText || '').trim();
  if (!previous) return null;
  // A typed answer to "Можливо, ви мали на увазі X?" (TG-RUNTIME-074 review):
  // "так" or X itself continues with X and the saved details.
  const suggestion = TOWN_SUGGESTION.exec(previous);
  if (suggestion && (/^(?:так|да|ja|yes|ок|ok|угу|авжеж)[.!]?$/iu.test(text) || foldTown(text) === foldTown(suggestion[1]))) {
    const persons = Number(/^Осіб: (\d{1,2})$/mu.exec(previous)?.[1]) || null;
    const rooms = parseRoomSpec(/^Кімнат: (\d{1,2}(?:-\d{1,2})?)$/mu.exec(previous)?.[1]);
    return withBudgetLine(housingEntryReply({ location:suggestion[1], persons, rooms, jobcenter:/^Умова: житло під Jobcenter\.$/mu.test(previous) }), budgetLineOfPrompt(previous));
  }
  const costFollowup = housingCostFollowup(previous, text);
  if (costFollowup) return costFollowup;

  const jobcenterTopicPrompt = /^Тема: Jobcenter\. Вкажіть місто або район і що саме потрібно:/u.test(previous);
  if (jobcenterTopicPrompt && /wohnung|wohnraum|miete|житл|оренд|квартир|apartment|flat/iu.test(text)) {
    const location = normalizeHousingLocation(extractLocation(text));
    if (!location) return 'Для житла під Jobcenter вкажіть місто або район, наприклад: Lübeck або Trittau.';
    const persons = parseHouseholdSize(text);
    const roomMatch = /(?:^|[\s,])(\d{1,2}(?:\s*[-–—/]\s*\d{1,2})?)\s*(?:кімнат(?:а|и)?|кімн\.?|zimmer|rooms?)(?=$|[^\p{L}])/iu.exec(text);
    const rooms = parseRoomSpec(roomMatch?.[1]);
    return housingEntryReply({ location, persons, rooms, jobcenter: true });
  }

  const genericHousingTopicPrompt = /^Тема: житло\. Вкажіть місто або район(?:\.|, кількість кімнат і що потрібно:)/u.exec(previous);
  if (genericHousingTopicPrompt) {
    const supplied = text.replace(/\s+/g, ' ').trim();
    if (!/^[\p{L}\p{M}.'’ -]{2,80}$/u.test(supplied)) return 'Вкажіть місто або район, наприклад: Hamburg або Trittau.';
    const location = normalizeHousingLocation(supplied);
    const knownRooms = parseRoomSpec(/^Кімнат: (\d{1,2}(?:-\d{1,2})?)$/mu.exec(previous)?.[1]);
    if (previous.includes('\nУмова: житло під Jobcenter.')) {
      const persons = Number(/^Осіб: (\d{1,2})$/mu.exec(previous)?.[1]) || null;
      return housingEntryReply({ location, persons, rooms: knownRooms, jobcenter: true });
    }
    if (knownRooms) return housingRoomsReply(location, knownRooms.label, Number(/^Осіб: (\d{1,2})$/mu.exec(previous)?.[1]) || null);
    return `Тема: житло — ${location}. Локацію вже визначено. Уточніть кількість кімнат і що потрібно: пошук житла, перевірка оренди, Jobcenter-погодження або відповідь орендодавцю.`;
  }

  const standaloneBudgetPrompt = /^Бюджет ([\d.,]+) €(?: (Warmmiete|Kaltmiete))? розпізнано\. Вкажіть місто або район\.$/u.exec(previous);
  if (standaloneBudgetPrompt) {
    const location = normalizeHousingLocation(text);
    if (!/^[\p{L}\p{M}.'’ -]{2,80}$/u.test(location)) return `Для бюджету ${standaloneBudgetPrompt[1]} € вкажіть місто або район, наприклад: Hamburg.`;
    const type = standaloneBudgetPrompt[2] || '';
    return `Бюджет ${standaloneBudgetPrompt[1]} €${type ? ` ${type}` : ''}, місто ${location}. Вкажіть кількість кімнат.`;
  }

  const standaloneLocationPrompt = /^Бюджет ([\d.,]+) €(?: (Warmmiete|Kaltmiete))?, місто ([^.\n]{2,80})\. Вкажіть кількість кімнат\.$/u.exec(previous);
  if (standaloneLocationPrompt) {
    const roomSpec = parseRoomSpec(text);
    if (!roomSpec) return `Для ${standaloneLocationPrompt[3]} вкажіть кількість кімнат числом або діапазоном, наприклад: 3 або 3-4.`;
    const rooms = roomSpec.label;
    if (standaloneLocationPrompt[2]) return `Параметри житла: ${standaloneLocationPrompt[3]}, ${rooms} ${roomsWord(rooms)}, до ${standaloneLocationPrompt[1]} € ${standaloneLocationPrompt[2]}. Оберіть радіус пошуку: 5, 10, 15, 25 або 50 км.`;
    return `Бюджет ${standaloneLocationPrompt[1]} €, місто ${standaloneLocationPrompt[3]}, ${rooms} ${roomsWord(rooms)}. Це Warmmiete чи Kaltmiete? Напишіть один варіант.`;
  }

  const standaloneTypePrompt = /^Бюджет ([\d.,]+) €, місто ([^,\n]{2,80}),\s*(\d{1,2}(?:-\d{1,2})?)\s+кімнат(?:а|и)?\. Це Warmmiete чи Kaltmiete\?/u.exec(previous);
  if (standaloneTypePrompt) {
    const value = text.toLowerCase();
    const type = /warmmiete|^warm$/i.test(value) ? 'Warmmiete' : /kaltmiete|^kalt$/i.test(value) ? 'Kaltmiete' : null;
    if (!type) return `Для бюджету ${standaloneTypePrompt[1]} € вкажіть один варіант: Warmmiete або Kaltmiete.`;
    return `Параметри житла: ${standaloneTypePrompt[2]}, ${standaloneTypePrompt[3]} ${roomsWord(standaloneTypePrompt[3])}, до ${standaloneTypePrompt[1]} € ${type}. Оберіть радіус пошуку: 5, 10, 15, 25 або 50 км.`;
  }

  const locationPrompt = /^Тема: житло — ([^.\n]{1,80})\. Локацію вже визначено\./u.exec(previous);
  if (locationPrompt) {
    if (previous.includes('\nДля нормативів Jobcenter вкажіть кількість осіб (1–20).')) {
      const persons = parseHouseholdSize(text) ?? parseHouseholdSize(`${text} осіб`);
      const rooms = parseRoomSpec(/^Кімнат: (\d{1,2}(?:-\d{1,2})?)$/mu.exec(previous)?.[1]);
      return housingEntryReply({ location: locationPrompt[1], persons, rooms, jobcenter: true });
    }
    const roomSpec = parseRoomSpec(text);
    if (!roomSpec) return `Для житла — ${locationPrompt[1]} вкажіть кількість кімнат числом або діапазоном, наприклад: 3 або 3-4.`;
    const rooms = roomSpec.label;
    return `Житло — ${locationPrompt[1]}, ${rooms} ${roomsWord(rooms)}. Що саме потрібно? Напишіть один варіант: пошук житла, перевірка оренди, Jobcenter-погодження або відповідь орендодавцю.`;
  }

  const actionPrompt = /^Житло — ([^,\n]{1,80}),\s*(\d{1,2}(?:-\d{1,2})?)\s+кімнат(?:а|и)?\./u.exec(previous);
  if (actionPrompt) {
    const location = actionPrompt[1];
    const rooms = actionPrompt[2];
    const value = text.toLowerCase();
    if (/пошук|шука|wohnung|finden/.test(value)) {
      // TG-RUNTIME-075: a budget already given skips the budget question.
      const budget = budgetFromText(text) || budgetOfPrompt(previous);
      if (budget?.type) return `Параметри житла: ${location}, ${rooms} ${roomsWord(rooms)}, до ${formatAmount(budget.amount)} € ${budget.type}. Оберіть радіус пошуку: 5, 10, 15, 25 або 50 км.`;
      if (budget) return `Пошук житла — ${location}, ${rooms} ${roomsWord(rooms)}, бюджет до ${formatAmount(budget.amount)} €. Це Warmmiete чи Kaltmiete? Напишіть один варіант.`;
      return `Пошук житла — ${location}, ${rooms} ${roomsWord(rooms)}. Уточніть максимальний місячний бюджет і, якщо знаєте, чи це Warmmiete або Kaltmiete.`;
    }
    if (JOBCENTER_NAME.test(value) || /погоджен/.test(value)) return `Jobcenter-погодження житла — ${location}, ${rooms} ${roomsWord(rooms)}. Вкажіть Kaltmiete, Betriebskosten без опалення та Heizkosten окремо, якщо вони відомі.`;
    if (/перевір|оренд|miete/.test(value) && !/орендодав/.test(value)) return `Перевірка оренди — ${location}, ${rooms} ${roomsWord(rooms)}. Надішліть основні суми з оголошення: Kaltmiete, Betriebskosten/Nebenkosten і Heizkosten. Не надсилайте повні копії документів.`;
    if (/орендодав|vermieter/.test(value)) return `Відповідь орендодавцю — ${location}, ${rooms} ${roomsWord(rooms)}. Коротко напишіть, на яке повідомлення потрібно відповісти і якою мовою.`;
    if (parseBudget(text)) return `Житло — ${location}, ${rooms} ${roomsWord(rooms)}. Спочатку оберіть дію: пошук житла, перевірка оренди, Jobcenter-погодження або відповідь орендодавцю. Суму уточнимо на наступному кроці.`;
    return `Житло — ${location}, ${rooms} ${roomsWord(rooms)}. Оберіть: пошук житла, перевірка оренди, Jobcenter-погодження або відповідь орендодавцю.`;
  }

  const budgetPrompt = /^Пошук житла — ([^,\n]{1,80}),\s*(\d{1,2}(?:-\d{1,2})?)\s+кімнат(?:а|и)?\. Уточніть максимальний місячний бюджет/u.exec(previous);
  if (budgetPrompt) {
    const location = budgetPrompt[1];
    const rooms = budgetPrompt[2];
    const budget = parseBudget(text);
    if (!budget) return `Пошук житла — ${location}, ${rooms} ${roomsWord(rooms)}. Вкажіть бюджет числом у євро, наприклад: 950 або 1200 € Warmmiete.`;
    const amount = formatAmount(budget.amount);
    if (budget.type) return `Параметри житла: ${location}, ${rooms} ${roomsWord(rooms)}, до ${amount} € ${budget.type}. Оберіть радіус пошуку: 5, 10, 15, 25 або 50 км.`;
    return `Пошук житла — ${location}, ${rooms} ${roomsWord(rooms)}, бюджет до ${amount} €. Це Warmmiete чи Kaltmiete? Напишіть один варіант.`;
  }

  const rentTypePrompt = /^Пошук житла — ([^,\n]{1,80}),\s*(\d{1,2}(?:-\d{1,2})?)\s+кімнат(?:а|и)?, бюджет до ([\d.,]+) €\. Це Warmmiete чи Kaltmiete\?/u.exec(previous);
  if (rentTypePrompt) {
    const value = text.toLowerCase();
    const type = /warmmiete|^warm$/i.test(value) ? 'Warmmiete' : /kaltmiete|^kalt$/i.test(value) ? 'Kaltmiete' : null;
    if (!type) return `Для бюджету ${rentTypePrompt[3]} € вкажіть один варіант: Warmmiete або Kaltmiete.`;
    return `Параметри житла: ${rentTypePrompt[1]}, ${rentTypePrompt[2]} ${roomsWord(rentTypePrompt[2])}, до ${rentTypePrompt[3]} € ${type}. Оберіть радіус пошуку: 5, 10, 15, 25 або 50 км.`;
  }

  const radiusPromptMatch = /^Параметри житла: ([^,\n]{1,80}),\s*(\d{1,2}(?:-\d{1,2})?)\s+кімнат(?:а|и)?, до ([\d.,]+) € (Warmmiete|Kaltmiete)\. Оберіть радіус пошуку:/u.exec(previous);
  if (radiusPromptMatch) {
    const radiusMatch = /^(5|10|15|25|50)\s*(?:км|km)?$/iu.exec(text);
    if (!radiusMatch) return `Для ${radiusPromptMatch[1]} оберіть радіус: 5, 10, 15, 25 або 50 км.`;
    return `Критерії пошуку зібрано: ${radiusPromptMatch[1]}, ${radiusPromptMatch[2]} ${roomsWord(radiusPromptMatch[2])}, до ${radiusPromptMatch[3]} € ${radiusPromptMatch[4]}, радіус ${radiusMatch[1]} км. Наступний крок — перевірка актуальних оголошень за цими параметрами.`;
  }

  return null;
}

function topicReply(text) {
  const raw = String(text || '');
  const value = raw.toLowerCase();
  const location = normalizeHousingLocation(extractLocation(raw));
  if (JOBCENTER_NAME.test(value) || /bürgergeld|buergergeld|bescheid|mitwirkung|kdu/.test(value)) return 'Тема: Jobcenter. Вкажіть місто або район і що саме потрібно: Bürgergeld, Bescheid, Mitwirkung, оренда/житло, строк або підготовка листа. Не надсилайте номер клієнта чи повні копії документів.';
  if (/familienkasse|kindergeld/.test(value)) return 'Тема: Familienkasse / Kindergeld. Вкажіть місто або район і що саме потрібно: заява, статус, лист, запит документів або строк. Не надсилайте повні номери справ чи банківські дані.';
  if (/ausländer|auslaender|aufenthalt|e.?at|fiktions|документ|перебув|посвідк|ausweis/.test(value)) return 'Тема: документи та перебування. Вкажіть місто або район і тип питання: Aufenthalt, eAT, Fiktionsbescheinigung, Ausländerbehörde, запис на Termin або лист від органу.';
  if (/wohnung|wohnraum|miete|житл|оренд|квартир|apartment|flat/.test(value)) {
    if (location) return `Тема: житло — ${location}. Локацію вже визначено. Уточніть кількість кімнат і що потрібно: пошук житла, перевірка оренди, Jobcenter-погодження або відповідь орендодавцю.`;
    return 'Тема: житло. Вкажіть місто або район.';
  }
  if (/arbeit|job|робот|фріланс|freelance/.test(value)) return 'Тема: робота. Вкажіть місто/район або що шукаєте: офлайн-робота, віддалена робота, резюме, вакансії чи підготовка звернення роботодавцю.';
  if (/integrationskurs|sprachkurs|deutsch|курс|німецьк/.test(value)) return 'Тема: інтеграційні та мовні курси. Вкажіть місто або район і що потрібно: пошук курсу, Anmeldung, Einstufungstest, графік, пропуск або лист до Kursträger/BAMF.';
  if (/schule|kita|kindergarten|школ|садок|дитсад/.test(value)) return 'Тема: школа / Kita. Вкажіть місто або район, вік дитини та що потрібно: місце, лист, відвідування, харчування, квиток або інше організаційне питання.';
  if (/transport|hvv|deutsche bahn|\bdb\b|bus|bahn|zug|транспорт|автобус|поїзд/.test(value)) return 'Тема: транспорт. Вкажіть пункт відправлення, пункт призначення, дату й бажаний час. Я зможу підготувати запит для перевірки маршруту та пересадок.';
  return null;
}

export function replyFor(message) {
  const text = message?.text?.trim() || '';
  const cmd = /^\/(start|help|topics|privacy|datenschutz|impressum)(?:@ZaskaletaInfoBot)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase();
  if (cmd) return ({ start: START, help: HELP, topics: TOPICS, privacy: PRIVACY, datenschutz: PRIVACY, impressum: IMPRESSUM })[cmd];
  if (text.startsWith('/')) return 'Невідома команда. Використайте /help.';
  // The landlord's German message would otherwise be read as a new housing request.
  const landlord = landlordReply(message?.replyToText, text);
  if (landlord) return landlord;
  // Groups get no inline keyboard, so no question with buttons there.
  const naturalHousing = naturalHousingEntry(text, !message?.chatType || message.chatType === 'private', Boolean(message?.replyToText));
  // A complete new household request also works when replying to an older prompt.
  if (naturalHousing && JOBCENTER_NAME.test(text) && parseHouseholdSize(text) && extractLocation(text)) return naturalHousing;
  // TG-RUNTIME-070: so does a request that names its own town and its own
  // rooms/budget, or another town than the open dialogue.
  if (startsNewHousingRequest(text, String(message?.replyToText || ''), naturalHousing)) {
    const fresh = naturalHousing || standaloneHousingRecovery(text) || bareTownReply(text, message);
    if (fresh) return fresh;
  }
  const followup = housingFollowup(message);
  if (followup) return housingContext(followup, String(message?.replyToText || ''), text);
  if (naturalHousing) return naturalHousing;
  const recoveredHousing = standaloneHousingRecovery(text);
  if (recoveredHousing) return recoveredHousing;
  const guided = topicFollowup(message);
  if (guided) return guided;
  return topicReply(text) || bareTownReply(text, message) || NOT_READY;
}

function startsNewHousingRequest(text, previous, naturalHousing = null) {
  if (!previous) return false;
  // TG-RUNTIME-078: a town with a typo is a new request too, as a known
  // town is: "Житло в Elmschorn для 2 осіб" (or just "Elmschorn") during the
  // rooms step for Kiel gets the town question, not "кімнати для Kiel".
  if (naturalHousing && TOWN_SUGGESTION.test(naturalHousing)) return true;
  const bare = String(text || '').replace(/\s+/gu, ' ').trim();
  // A bare word only at the rooms step, where a town is a likely answer
  // (review #078: "Heidi" at the budget step is no town).
  if (/кількість кімнат/u.test(previous) && /^[\p{L}\p{M}.'’()\/ -]{2,60}$/u.test(bare) && suggestedTown(bare)) return true;
  return Boolean(parseCompactHousingCriteria(text)) || startsNewHousingDialogue(text, previous);
}

// A message that is only a known town (TG-RUNTIME-070): the topics for that
// town as buttons. Housing is the main use, but after another menu topic the
// town may be meant for it, so the bot does not guess.
function bareTownReply(text, message) {
  // Groups get no inline keyboard (group-beta-runtime.mjs), so no buttons
  // can be promised there.
  if (message?.chatType && message.chatType !== 'private') return null;
  const source = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!/^[\p{L}\p{M}.'’()\/ -]{2,60}$/u.test(source)) return null;
  const town = knownHousingLocation(source);
  // The whole message must be the town ("Kiel", "bad oldesloe", "Любек"), not
  // a sentence that only mentions one.
  const wholeMessage = town && (foldTown(source) === foldTown(town) || foldTown(normalizeHousingLocation(source)) === foldTown(town));
  const topics = name => `📍 ${name} — що потрібно?\nОберіть тему кнопкою нижче або напишіть запитання своїми словами.`;
  if (wholeMessage) return topics(town);
  const spelled = umlautTown(source);
  if (spelled) return topics(spelled);
  return townSuggestionText(source);
}

// TG-RUNTIME-074: a town with a small typo ("Elmschorn") gets a question, never
// a silent correction (review: "Wandsbek" became the village Wasbek with the
// Jobcenter limits of another Kreis, "Kiew" became Kiel). Only one letter off,
// at least 5 letters, Latin script, and the typed name is not known anywhere:
// not a Schleswig-Holstein place, not Hamburg, not a big town elsewhere.
const NOT_SH_TOWNS = new Set(['kiew', 'kiev', 'kyiv', 'koln', 'koeln', 'kassel', 'halle', 'stettin', 'krakow', 'krakau', 'berlin', 'bremen', 'hannover', 'munchen', 'muenchen', 'dresden', 'leipzig', 'essen', 'bonn', 'mainz', 'lwiw', 'lviv', 'odesa', 'odessa', 'charkiw', 'kharkiv', 'dnipro', 'warschau', 'prag', 'wien', 'paris', 'london']);

function oneEditApart(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// "neumuenster", "ECKERNFOERDE": a correct spelling without umlauts.
function umlautSpelling(value) {
  return String(value || '').replace(/ae/gu, 'ä').replace(/oe/gu, 'ö').replace(/ue/gu, 'ü').replace(/Ae|AE/gu, 'Ä').replace(/Oe|OE/gu, 'Ö').replace(/Ue|UE/gu, 'Ü');
}

function umlautTown(typed) {
  const source = String(typed || '').replace(/\s+/gu, ' ').trim();
  if (!/ae|oe|ue/iu.test(source)) return null;
  const spelled = umlautSpelling(source);
  const town = knownHousingLocation(spelled);
  return town && foldTown(town) === foldTown(spelled) ? town : null;
}

function suggestedTown(typed) {
  const source = String(typed || '').replace(/\s+/gu, ' ').trim();
  if (/\p{Script=Cyrillic}/u.test(source) || source.replace(/[^\p{L}]/gu, '').length < 5) return null;
  if (knownHousingLocation(source) || canonicalHamburgPlace(source) || hamburgPlaceRoute(source) || NOT_SH_TOWNS.has(foldTown(source))) return null;
  const town = resolveBarePlaceName(source);
  // Only the 88 towns people search for most (all 63 cities and the curated
  // municipalities): one letter off a small village is usually a word
  // ("Strand" → Strande, "Husten" → Hütten).
  return town && SUGGESTABLE_TOWNS.has(town) && oneEditApart(foldTown(source), foldTown(town)) ? town : null;
}

const SUGGESTABLE_TOWNS = new Set(SH_UKRAINIAN_PLACE_ROWS.map(row => row.canonical));

function townSuggestionText(typed, details = '') {
  const town = suggestedTown(typed);
  if (!town) return null;
  return `❓ Місто «${String(typed).trim()}» не знайдено. Можливо, ви мали на увазі ${town}?\nЯкщо так — оберіть тему для ${town} кнопкою нижче. Якщо ні — напишіть назву міста ще раз.${details ? `\n${details}` : ''}`;
}

const TOWN_SUGGESTION = /^❓ Місто «[^»\n]{1,60}» не знайдено\. Можливо, ви мали на увазі ([^?\n]{2,80})\?\n/u;

const TOWN_TOPICS = /^📍 ([^\n]{2,80}) — що потрібно\?\n/u;

// The housing button continues with what the request already said (review
// #074): persons and rooms skip their steps, the Jobcenter condition goes
// straight to the Jobcenter search; otherwise the rooms step (hkr:x keeps
// "Осіб: N").
function housingButtonFor(town, encoded, text) {
  const persons = Number(/^Осіб: (\d{1,2})$/mu.exec(text)?.[1]) || null;
  const rooms = /^Кімнат: (\d{1,2}(?:-\d{1,2})?)$/mu.exec(text)?.[1] || null;
  const jobcenter = /^Умова: житло під Jobcenter\.$/mu.test(text);
  if (jobcenter && persons && rooms) return { text:`🏛 Житло під Jobcenter — ${town}`, callback_data:`hka:j:${persons}:${rooms}:${encoded}` };
  if (persons && persons <= 6 && rooms) return { text:'🏠 Житло', callback_data:`hkp:${persons}:${rooms}:${encoded}` };
  if (rooms && /^(?:[1-5]|2-3|3-4)$/u.test(rooms)) return { text:'🏠 Житло', callback_data:`hkr:${rooms}:${encoded}` };
  return { text:'🏠 Житло', callback_data:`hkr:x:${encoded}` };
}

function townTopicsMarkup(town, text = '') {
  const encoded = encodeURIComponent(town);
  const kreis = beratungPlace(town)?.kreis;
  const rows = [];
  const housing = housingButtonFor(town, encoded, text);
  if (new TextEncoder().encode(housing.callback_data).byteLength <= 64 && new TextEncoder().encode(encoded).byteLength <= 48) rows.push([housing]);
  rows.push([{ text:'🤝 Консультації', callback_data:/^01\d{3}$/u.test(String(kreis || '')) ? `adv:${kreis}` : 'nav:advice' }]);
  // events-command.mjs accepts 2–40 characters without ':' and knows fewer
  // names than the housing registry (a Kreis is not an events place).
  const eventsTown = eventsPlace(town) && town.length <= 40 && !town.includes(':') && new TextEncoder().encode(`ev:t:${town}`).byteLength <= 64;
  rows.push([{ text:'🎉 Куди піти', callback_data:eventsTown ? `ev:t:${town}` : 'nav:events' }]);
  rows.push([{ text:'🏛 Jobcenter', callback_data:'nav:jobcenter' }]);
  return { inline_keyboard:rows };
}


// A reply to a menu topic prompt, or a message naming both a topic and a
// place, gets concrete next steps instead of the same prompt again.
const TOPIC_PLACE_MISSING = '\n\n⚠️ Місто або громаду не знайдено. Напишіть, наприклад: Kiel, Lübeck або Trittau.';
function topicFollowup(message) {
  const text = String(message?.text || '').trim();
  const previous = String(message?.replyToText || '').trim();
  const promptTopic = topicOfPrompt(previous);
  if (promptTopic) {
    const guided = topicGuidance(promptTopic, text);
    if (guided && !guided.needsPlace) return guided.text;
    return `${previous.replace(/\n\n⚠️ Місто або громаду не знайдено\.[^\n]*$/u, '')}${TOPIC_PLACE_MISSING}`;
  }
  const topic = topicOfText(text);
  // A Jobcenter question (Mitwirkung, Widerspruch, …) is answered even without a town.
  if (!topic || (!placeFromText(text) && !(topic === 'jobcenter' && /bürgergeld|buergergeld|mitwirkung|widerspruch|bescheid/iu.test(text)))) return null;
  const guided = topicGuidance(topic, text);
  return guided && !guided.needsPlace ? guided.text : null;
}

export function replyMarkupFor(text) {
  const townTopics = TOWN_TOPICS.exec(text) || TOWN_SUGGESTION.exec(text);
  if (townTopics) return townTopicsMarkup(townTopics[1], text);
  if (text.includes('\nДля нормативів Jobcenter вкажіть кількість осіб (1–20).')) return { force_reply: true, selective: true, input_field_placeholder: 'Напр.: 3 особи' };
  if (/^(?:Jobcenter-погодження житла|Перевірка оренди) —/u.test(text)) return { force_reply: true, selective: true };
  if (topicOfPrompt(text) || LANDLORD_PROMPT.test(text)) return { force_reply: true, selective: true };
  if (text === START || text === TOPICS) return { keyboard: [[{ text: '🏠 Житло' }, { text: '🏛 Jobcenter' }], [{ text: '💼 Робота' }, { text: '🎓 Курси' }], [{ text: '👨‍👩‍👧 Школа / Kita' }, { text: '🚌 Транспорт' }], [{ text: '📄 Документи' }, { text: '👶 Kindergeld' }]], resize_keyboard: true, one_time_keyboard: true, selective: true, input_field_placeholder: 'Оберіть тему або напишіть запитання' };
  if (/^Тема: житло\. Вкажіть місто або район(?:\.|, кількість кімнат і що потрібно:)/u.test(text)) return { force_reply: true, selective: true, input_field_placeholder: 'Напр.: Kiel, Hamburg або Trittau' };
  const criteria = /^Критерії пошуку зібрано: ([^,\n]{1,80}),\s*(\d{1,2}(?:-\d{1,2})?)\s+кімнат(?:а|и)?, до ([\d.,]+) € (Warmmiete|Kaltmiete)(?:, радіус (5|10|15|25|50) км)?\./u.exec(text);
  if (criteria) {
    const action = housingSearchAction({ location: criteria[1], rooms: criteria[2], amount: Number(criteria[3].replace(',', '.')), type: criteria[4], ...(criteria[5] ? { radiusKm: Number(criteria[5]) } : {}) });
    if (action) return { keyboard: [[{ text: action }]], resize_keyboard: true, one_time_keyboard: true, selective: true, input_field_placeholder: 'Натисніть для актуального пошуку' };
  }
  if (/^Параметри житла: [^,\n]{1,80},\s*\d{1,2}(?:-\d{1,2})?\s+кімнат(?:а|и)?, до [\d.,]+ € (?:Warmmiete|Kaltmiete)\. Оберіть радіус пошуку:/u.test(text)) return { keyboard: [[{ text: '5 км' }, { text: '10 км' }, { text: '15 км' }], [{ text: '25 км' }, { text: '50 км' }]], resize_keyboard: true, one_time_keyboard: true, selective: true, input_field_placeholder: 'Оберіть радіус пошуку' };
  if (/^Тема: житло — [^.\n]{1,80}\. Локацію вже визначено\./u.test(text)) return { force_reply: true, selective: true, input_field_placeholder: 'Напр.: 3 або 3-4' };
  if (/^Житло — [^,\n]{1,80},\s*\d{1,2}(?:-\d{1,2})?\s+кімнат(?:а|и)?\./u.test(text)) return { force_reply: true, selective: true, input_field_placeholder: 'Напр.: пошук житла' };
  if (/^Пошук житла — [^,\n]{1,80},\s*\d{1,2}(?:-\d{1,2})?\s+кімнат(?:а|и)?\. Уточніть/u.test(text)) return { force_reply: true, selective: true, input_field_placeholder: 'Напр.: 950 або 1200 € Warmmiete' };
  if (/^Пошук житла — [^,\n]{1,80},\s*\d{1,2}(?:-\d{1,2})?\s+кімнат(?:а|и)?, бюджет до/u.test(text)) return { force_reply: true, selective: true, input_field_placeholder: 'Warmmiete або Kaltmiete' };
  if (/^Бюджет [\d.,]+ €(?: (?:Warmmiete|Kaltmiete))? розпізнано\. Вкажіть місто/u.test(text)) return { force_reply: true, selective: true, input_field_placeholder: 'Напр.: Hamburg' };
  if (/^Бюджет [\d.,]+ €(?: (?:Warmmiete|Kaltmiete))?, місто [^.\n]{2,80}\. Вкажіть кількість кімнат/u.test(text)) return { force_reply: true, selective: true, input_field_placeholder: 'Напр.: 3 або 3-4' };
  if (/^Бюджет [\d.,]+ €, місто [^,\n]{2,80},\s*\d{1,2}(?:-\d{1,2})?\s+кімнат(?:а|и)?\. Це Warmmiete/u.test(text)) return { force_reply: true, selective: true, input_field_placeholder: 'Warmmiete або Kaltmiete' };
  if (/^\d{1,2}(?:-\d{1,2})? кімнат(?:а|и)? розпізнано\./u.test(text)) return { force_reply: true, selective: true, input_field_placeholder: 'Напр.: Hamburg, 3-4 кімнати, 950 € Warmmiete' };
  if (/^Тип оренди розпізнано\./u.test(text)) return { force_reply: true, selective: true, input_field_placeholder: 'Напр.: Hamburg, 3-4 кімнати, 950 € Warmmiete' };
  return null;
}

const PLAIN_SEARCH_CARDS = 5;

// TG-RUNTIME-069: the search slot taken by a plain search is released when
// the reply ends, whatever happens in between.
export async function sendStatelessPilotReply(message, env = {}, transport = fetch) {
  const held = { slot:null };
  try {
    return await statelessPilotReply(message, env, transport, held);
  } finally {
    await held.slot?.release();
  }
}

async function statelessPilotReply(message, env, transport, held) {
  const allowedConfig = pilotConfig(env);
  if (!statelessDirectReplyEnabled(env) || !isAllowedPilotChat(allowedConfig, message?.chatId)) return { status: 'disabled' };
  // Bind every text/media response and response validation to the requesting chat.
  const config = { ...allowedConfig, chatId: message.chatId };
  const liveCriteria = parseHousingSearchAction(message?.text);
  let text;
  let replyMarkup;
  let media = [];
  let moreNote = null;
  if (liveCriteria) {
    // TG-RUNTIME-067 (full analysis 23.10.2026): this search asked only the
    // paid Kleinanzeigen API, which is off, so every user got "провайдер ще не
    // підключено". It now uses the same multi-source search as the Jobcenter
    // flow (the API is still used when a key is set). Cards show 5 listings.
    // TG-RUNTIME-069: one search at a time per user, at most 20 in 10 min.
    // The slot is held until the reply is sent (sendStatelessPilotReply).
    const slot = held.slot = await acquireSearchSlot(env, Number(message?.chatId), Number(message?.userId));
    const found = slot.allowed ? await searchPrimaryHousing(liveCriteria, klazApiKey(env), transport) : { status:'rate_limited_user', listings:[] };
    const all = Array.isArray(found?.listings) ? found.listings : [];
    const result = { ...found, listings:all.slice(0, PLAIN_SEARCH_CARDS) };
    text = slot.allowed ? formatHousingListings(liveCriteria, result) : searchRateText(slot.reason);
    if (result.status === 'ok' && all.length > PLAIN_SEARCH_CARDS) {
      moreNote = `Ще знайдено: ${all.length - PLAIN_SEARCH_CARDS}. Повний список із перевіркою норми Jobcenter: «🏠 Житло» → місто → «🏛 Житло під Jobcenter».`;
      text = `${text}\n\n${moreNote}`.slice(0, 4096);
    }
    media = result.status === 'ok' && result.listings?.length ? housingListingMedia(result) : [];
    replyMarkup = !slot.allowed
      ? null
      : result.status === 'ok' && result.listings?.length
        ? housingListingsMarkup(result)
        : externalHousingSearchMarkup(liveCriteria);
  } else {
    text = replyFor(message);
    replyMarkup = replyMarkupFor(text);
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) return { status: 'disabled' };
  if (liveCriteria) {
    const mediaController = new AbortController();
    const mediaTimeout = setTimeout(() => mediaController.abort(), 20000);
    try {
      // The summary text is only a fallback when cards go out; the note on
      // further listings then follows the cards.
      return await sendHousingMediaReply({ config, media, text, replyMarkup, transport, signal: mediaController.signal, ...(moreNote && media.length ? { postText:moreNote } : {}) });
    } finally {
      clearTimeout(mediaTimeout);
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    let response;
    let expectAlbum = false;
    if (media.length >= 2) {
      expectAlbum = true;
      response = await transport(`https://api.telegram.org/bot${config.token}/sendMediaGroup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.chatId, media, disable_notification: true }),
        signal: controller.signal
      });
    } else if (media.length === 1) {
      const item = media[0];
      response = await transport(`https://api.telegram.org/bot${config.token}/sendPhoto`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.chatId, photo: item.media, caption: item.caption, parse_mode: item.parse_mode, disable_notification: true, reply_markup: replyMarkup || undefined }),
        signal: controller.signal
      });
    } else {
      const payload = { chat_id: config.chatId, ...telegramTextStyle(text), disable_notification: true, link_preview_options: { is_disabled: true } };
      if (replyMarkup) payload.reply_markup = replyMarkup;
      response = await transport(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    }
    const parsed = await readBoundedJSON(response, 32768);
    if (parsed.error) return { status: 'uncertain' };
    const data = parsed.value;
    if (response.ok && data?.ok === true) {
      if (expectAlbum && Array.isArray(data.result) && data.result.length === media.length && data.result.every(item => Number.isSafeInteger(item?.message_id) && item.message_id > 0 && item?.chat?.id === config.chatId)) return { status: 'sent', messageId: data.result[0].message_id };
      if (!expectAlbum && Number.isSafeInteger(data.result?.message_id) && data.result.message_id > 0 && data.result?.chat?.id === config.chatId) return { status: 'sent', messageId: data.result.message_id };
    }
    if (response.status >= 500 || response.ok) return { status: 'uncertain' };
    return { status: 'rejected' };
  } catch { return { status: 'uncertain' }; }
  finally { clearTimeout(timeout); }
}

export function createOutboxRuntime(ctx, env, outbox, transport = fetch, now = Date.now) {
  let draining = null;
  async function schedule() {
    const timestamp = now();
    const deliveryEnabled = env.TELEGRAM_DELIVERY_ENABLED === 'true' && !!pilotConfig(env);
    const due = deliveryEnabled ? outbox.nextDue(timestamp) : null;
    const current = await ctx.storage.getAlarm();
    const target = planAlarm(timestamp, due, deliveryEnabled, current);
    if (target !== null) await ctx.storage.setAlarm(target);
  }
  async function drain() {
    if (draining) return draining;
    draining = (async () => {
      outbox.reconcile(now());
      if (env.TELEGRAM_DELIVERY_ENABLED === 'true' && pilotConfig(env)) {
        const claim = outbox.claim(now());
        if (claim) {
          let result;
          try { result = await sendPilotMessage(claim, env, transport); }
          catch { result = { status: 'uncertain' }; }
          outbox.complete(claim.id, claim.token, result, now());
        }
      }
      outbox.purge(now());
      await schedule();
    })();
    try { return await draining; } finally { draining = null; }
  }
  async function enqueue(message, reply) {
    const result = outbox.enqueue(message, reply, now());
    await schedule();
    return result;
  }
  return { drain, enqueue, schedule };
}

export class TelegramOutbox {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.outbox = new Outbox(ctx.storage);
    this.runtime = createOutboxRuntime(ctx, env, this.outbox);
    ctx.blockConcurrencyWhile(async () => { this.outbox.init(); });
  }
  async alarm() { await this.runtime.drain(); }
  async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).hostname !== 'outbox.internal') return json({ error: 'Not found' }, 404);
    const config = pilotConfig(this.env);
    if (!config) return json({ error: 'Disabled' }, 503);
    const parsed = await readBoundedJSON(request, 16384);
    if (parsed.error) return json({ error: parsed.error }, parsed.error === 'too_large' ? 413 : 400);
    const p = parsed.value;
    try {
      if (p?.op === 'snapshot') {
        if (this.env.TELEGRAM_DELIVERY_ENABLED !== 'false') return json({ error: 'Disabled' }, 503);
        return json(readQueueSnapshot(this.ctx.storage, config.chatId));
      }
      if (this.env.TELEGRAM_INGRESS_ENABLED !== 'true') return json({ error: 'Disabled' }, 503);
      if (p?.op === 'enqueue') {
        if (p.message?.chatId !== config.chatId) return json({ error: 'Forbidden' }, 403);
        const message = { id: p.message.id, chatId: p.message.chatId, messageId: p.message.messageId };
        const result = await this.runtime.enqueue(message, p.reply);
        if (result.accepted || result.reason === 'duplicate') return json(result);
        return json(result, 429);
      }
      if (p?.op === 'erase' && p.chatId === config.chatId) return json({ erased: this.outbox.eraseChat(p.chatId) });
      return json({ error: 'Bad operation' }, 400);
    } catch { return json({ error: 'Storage unavailable' }, 503); }
  }
}

export async function handle(request, env = {}, now = Date.now(), transport = fetch) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    const body = { ok: true, service: 'zaskaleta-info-telegram', delivery: env.TELEGRAM_DELIVERY_ENABLED === 'true' && !!pilotConfig(env), versionId: env.CF_VERSION_METADATA?.id || null };
    if (url.searchParams.get('probe') === 'release') body.release = 'stormarn-hardening-v2';
    const response = json(body);
    response.headers.set('x-zaskaleta-release', 'stormarn-hardening-v2');
    return response;
  }
  if (url.pathname === AUDIT_PATH) return handleQueueAudit(request, env, now);
  if (url.pathname === STATELESS_PATH) {
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    const config = pilotConfig(env);
    if (!config || env.TELEGRAM_INGRESS_ENABLED !== 'true' || !statelessDirectReplyEnabled(env)) return json({ error: 'Not configured' }, 503);
    if (!equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return json({ error: 'Unauthorized' }, 401);
    const parsed = await readBoundedJSON(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.error === 'too_large' ? 413 : 400);
    const message = normalizePilotUpdate(parsed.value, now);
    if (!message || !isAllowedPilotChat(config, message.chatId)) return json({ ok: true, ignored: true });
    const result = await sendStatelessPilotReply(message, env, transport);
    return json({ ok: true, mode: 'stateless', delivered: result.status === 'sent' });
  }
  if (url.pathname !== '/telegram/webhook' || request.method !== 'POST') return json({ error: 'Not found' }, 404);
  const config = pilotConfig(env);
  if (!config || env.TELEGRAM_INGRESS_ENABLED !== 'true') return json({ error: 'Not configured' }, 503);
  if (!equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return json({ error: 'Unauthorized' }, 401);
  const parsed = await readBoundedJSON(request);
  if (parsed.error) return json({ error: parsed.error }, parsed.error === 'too_large' ? 413 : 400);
  const message = normalizePilotUpdate(parsed.value, now);
  if (!message || message.chatId !== config.chatId) return json({ ok: true, ignored: true });
  if (!env.OUTBOX) return json({ error: 'Storage unavailable' }, 503);
  try {
    const id = env.OUTBOX.idFromName('telegram-pilot-v1');
    const response = await env.OUTBOX.get(id).fetch('https://outbox.internal/enqueue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'enqueue', message: { id: message.id, chatId: message.chatId, messageId: message.messageId }, reply: replyFor(message) }) });
    if (!response.ok) return json({ error: 'Queue unavailable' }, 503);
    const result = await response.json();
    if (result.accepted || result.reason === 'duplicate') return json({ ok: true });
    return json({ error: 'Queue unavailable' }, 503);
  } catch { return json({ error: 'Queue unavailable' }, 503); }
}

export default { fetch(request, env) { return handle(request, env); } };

