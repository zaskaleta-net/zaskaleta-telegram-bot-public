import { budgetFromText, budgetOfPrompt, budgetPhrase } from './housing-budget-line.mjs';
import { readBoundedJSON } from './pilot-security.mjs';
import { knownHousingLocation, parseHouseholdSize } from './housing-language.mjs';
import { matchStatewideHousingPlace } from './housing-statewide-input.mjs';
import { resolveSchleswigHolsteinMunicipalityText } from './municipality-directory.mjs';
import { parseRoomSpec, roomsWord } from './rooms.mjs';

const STATELESS_PATH = '/telegram/stateless';
const HOUSING_LOCATION_PROMPT = /^(?:Тема:\s*житло\.\s*Вкажіть місто або район|Вкажіть місто або район,\s*наприклад:)/iu;
const HOUSING_CUE = /(?:житл|квартир|оренд|wohnung|miet|housing|rent)/iu;
const FAMILY_CUE = /(?:сім['’ʼ]?я|сім['’ʼ]?ї|семь(?:я|и)|familie|family|домогосподарств|household)/iu;
const PEOPLE_CUE = /(?:осіб|особи|особа|людей|людина|жінк|женщ|чоловік|чоловіки|муж|доросл|взросл|дитин|діти|дет|frau|frauen|mann|männer|maenner|erwachsene|kinder|people|women|men|adults|children)/iu;
const JOBCENTER_CUE = /(?:job[\s-]*center|джоб[\s-]*[цс][еэ]нт[еэ]?р)/iu;
const NON_HOUSING_ADMIN = /(?:bürgergeld|buergergeld|bescheid|mitwirkung|widerspruch|kindergeld|familienkasse|frist|строк|brief|лист)/iu;
const DIRECT_FOR_HOUSEHOLD = /(?:^|[^\p{L}\p{N}])(?:для|für|for)\s*(\d{1,2})(?=\s*(?:$|[,.!?;:]|(?:під|под|under|unter)\s+(?:job[\s-]*center|джоб[\s-]*[цс][еэ]нт[еэ]?р)))/iu;
const WORD_PERSON_GROUP = /(?:^|[^\p{L}\p{N}])(один|одна|одне|одно|одну|двоє|двое|два|дві|две|троє|трое|три|четверо|чотири|четыре|п['’ʼ]?ятеро|п['’ʼ]?ять|пятеро|пять|шестеро|шість|шесть|one|two|three|four|five|six|eins?|zwei|drei|vier|f(?:ü|u)nf|sechs)\s+(доросл[\p{L}]*|взросл[\p{L}]*|люд[\p{L}]*|особ[\p{L}]*|осіб|дит[\p{L}]*|діт[\p{L}]*|дет[\p{L}]*|жін[\p{L}]*|женщ[\p{L}]*|чолов[\p{L}]*|муж[\p{L}]*|personen?|erwachsene|kinder|frauen|männer|maenner|people|adults|children|women|men)(?=$|[^\p{L}\p{N}])/giu;

const WORD_PERSON_COUNTS = Object.freeze(new Map([
  ['один',1], ['одна',1], ['одне',1], ['одно',1], ['одну',1], ['one',1], ['ein',1], ['eins',1],
  ['двоє',2], ['двое',2], ['два',2], ['дві',2], ['две',2], ['two',2], ['zwei',2],
  ['троє',3], ['трое',3], ['три',3], ['three',3], ['drei',3],
  ['четверо',4], ['чотири',4], ['четыре',4], ['four',4], ['vier',4],
  ["п'ятеро",5], ['п’ятеро',5], ['пʼятеро',5], ["п'ять",5], ['п’ять',5], ['пʼять',5], ['пятеро',5], ['пять',5], ['five',5], ['fünf',5], ['funf',5],
  ['шестеро',6], ['шість',6], ['шесть',6], ['six',6], ['sechs',6]
]));

function clean(value, max = 1200) {
  return String(value || '').normalize('NFC').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function validPeople(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= 20 ? number : null;
}

function wordPeopleCount(source) {
  let total = 0;
  let groups = 0;
  for (const match of String(source || '').toLowerCase().matchAll(WORD_PERSON_GROUP)) {
    const count = WORD_PERSON_COUNTS.get(match[1]);
    if (!count) continue;
    total += count;
    groups += 1;
  }
  return groups ? validPeople(total) : null;
}

export function conversationalHouseholdSize(text) {
  const parsed = parseHouseholdSize(text);
  if (parsed) return parsed;

  const source = clean(text, 500).toLowerCase();
  const afterFamily = /(?:сім['’ʼ]?я|сім['’ʼ]?ї|семь(?:я|и)|familie|family|домогосподарство|household)\s*(?:з|із|из|of|von)?\s*(\d{1,2})(?=$|[^\d])/iu.exec(source)?.[1];
  const beforeFamily = /(?:^|[^\d])(\d{1,2})\s*(?:-?особ(?:и|а)?\s+)?(?:сім['’ʼ]?я|семья|familie|family|household)(?=$|[^\p{L}])/iu.exec(source)?.[1];
  const directForHousehold = DIRECT_FOR_HOUSEHOLD.exec(source)?.[1];
  return validPeople(afterFamily || beforeFamily || directForHousehold) || wordPeopleCount(source);
}

export function conversationalHousingPlace(text) {
  const source = clean(text, 500);
  if (!source) return null;
  return matchStatewideHousingPlace(source)?.canonical || knownHousingLocation(source) || null;
}

export function conversationalRoomSpec(text) {
  const source = clean(text, 500);
  const match = /(?:^|[^\p{N}])(\d{1,2}(?:\s*[-–—/]\s*\d{1,2})?)\s*(?:кімнат(?:а|и)?|кімн\.?|zimmer|rooms?)(?=$|[^\p{L}])/iu.exec(source);
  return parseRoomSpec(match?.[1]) || null;
}

function housingText(location, source) {
  const persons = conversationalHouseholdSize(source);
  const rooms = conversationalRoomSpec(source);
  const jobcenter = JOBCENTER_CUE.test(String(source || ''));
  return [
    `${location} житло`,
    persons ? `для ${persons} осіб` : null,
    rooms ? `${rooms.label} ${roomsWord(rooms.label)}` : null,
    jobcenter ? 'під Jobcenter' : null,
    // TG-RUNTIME-075: the budget of the sentence stays in the rewrite.
    budgetPhrase(budgetFromText(source))
  ].filter(Boolean).join(' ');
}

function strongHousingComposition(text) {
  const source = clean(text, 500);
  const persons = conversationalHouseholdSize(source);
  const directHousehold = DIRECT_FOR_HOUSEHOLD.test(source);
  return !!persons && (
    FAMILY_CUE.test(source) ||
    PEOPLE_CUE.test(source) ||
    (HOUSING_CUE.test(source) && directHousehold)
  );
}

export function normalizedHousingConversationText(text, { requireHousingContext = false } = {}) {
  const source = clean(text);
  if (!source || NON_HOUSING_ADMIN.test(source)) return source;

  const location = conversationalHousingPlace(source);
  if (!location) return source;
  if (!requireHousingContext && !strongHousingComposition(source)) return source;

  return housingText(location, source);
}

export async function normalizeStatewideHousingConversationRequest(request, transport = fetch) {
  let url;
  try { url = new URL(request.url); } catch { return request; }
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST') return request;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return request;
  const update = parsed.value;
  const message = update?.message;
  if (message?.chat?.type !== 'private' || typeof message?.text !== 'string' || message?.from?.is_bot === true) return request;

  const source = clean(message.text);
  const previous = String(message?.reply_to_message?.text || '').trim();
  const inHousingLocationStep = HOUSING_LOCATION_PROMPT.test(previous);
  let normalized = normalizedHousingConversationText(source, { requireHousingContext:inHousingLocationStep });

  // The exact German names of all official Schleswig-Holstein Gemeinden can be
  // resolved through the statewide directory. Restrict free-form lookups to an
  // explicit housing step or a strong household composition so unrelated private
  // messages are never sent to the directory.
  const canUseStatewideDirectory = inHousingLocationStep || strongHousingComposition(source);
  if (canUseStatewideDirectory && normalized === source && !NON_HOUSING_ADMIN.test(source)) {
    const resolved = await resolveSchleswigHolsteinMunicipalityText(source, transport);
    if (resolved?.canonical) normalized = housingText(resolved.canonical, source);
  }

  if (!normalized || normalized === message.text) return request;

  const copy = JSON.parse(JSON.stringify(update));
  // TG-RUNTIME-075: the budget of the quoted step survives the rewrite.
  const carried = inHousingLocationStep && !budgetFromText(normalized) ? budgetPhrase(budgetOfPrompt(message?.reply_to_message?.text)) : null;
  copy.message.text = carried ? `${normalized} ${carried}` : normalized;
  if (inHousingLocationStep) delete copy.message.reply_to_message;

  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method:'POST', headers, body:JSON.stringify(copy) });
}
