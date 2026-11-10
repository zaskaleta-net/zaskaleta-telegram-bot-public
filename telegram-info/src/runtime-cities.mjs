// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { readBoundedJSON } from './pilot-security.mjs';
import { knownHousingLocation, parseHouseholdSize } from './housing-language.mjs';
import { parseRoomSpec, roomsWord } from './rooms.mjs';
import { normalizeMunicipalityRequest } from './municipality-directory.mjs';
import { normalizeStatewideHousingConversationRequest } from './housing-conversation-statewide-v2.mjs';
import { normalizeStatewideHousingRequest, normalizeStatewideHousingText } from './housing-statewide-input.mjs';
import { normalizeBuesumRequest, normalizeBuesumHousingText } from './housing-active-v21.mjs';
export { normalizeBuesumHousingText, normalizeStatewideHousingText };
const aliases = (() => {
const STATELESS_PATH = '/telegram/stateless';

const GUIDED_HOUSING_PROMPT = /^Тема: житло\s*[—–-]\s*([^\n]{2,100}?)\.\s*Локацію вже визначено\./iu;

const HOUSING_TOPIC_PROMPT = /^Тема: житло(?:\.|\s*[—–-])/iu;

function aliasKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[’ʼ'`´]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const BAD_OLDESLOE_KEYS = new Set([
  'бад ольдесло',
  'бад олдесло',
  'бад ольдеслое',
  'бад олдеслое',
  'bad oldesloe'
]);

function canonicalHousingAlias(value) {
  const clean = String(value || '').replace(/\s+/gu, ' ').trim();
  return BAD_OLDESLOE_KEYS.has(aliasKey(clean)) ? 'Bad Oldesloe' : null;
}

function canonicalizeGuidedHousingPrompt(value) {
  const text = String(value || '');
  const match = GUIDED_HOUSING_PROMPT.exec(text);
  if (!match) return text;
  const canonical = canonicalHousingAlias(match[1]);
  if (!canonical) return text;
  return text.replace(GUIDED_HOUSING_PROMPT, full => full.replace(match[1], canonical));
}

async function normalizeHousingAliasRequest(request) {
  try {
    const url = new URL(request.url);
    if (url.pathname !== STATELESS_PATH || request.method !== 'POST') return request;
    const parsed = await readBoundedJSON(request.clone(), 65536);
    if (parsed.error) return request;
    const update = parsed.value;
    const message = update?.message;
    const chatId = Number(message?.chat?.id);
    const userId = Number(message?.from?.id);
    if (message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || chatId !== userId || message?.from?.is_bot === true) return request;

    const previous = String(message?.reply_to_message?.text || '');
    const canonicalDirect = HOUSING_TOPIC_PROMPT.test(previous) ? canonicalHousingAlias(message?.text) : null;
    const canonicalPrevious = canonicalizeGuidedHousingPrompt(previous);
    if (!canonicalDirect && canonicalPrevious === previous) return request;

    const copy = JSON.parse(JSON.stringify(update));
    if (canonicalDirect) copy.message.text = canonicalDirect;
    if (canonicalPrevious !== previous && copy.message.reply_to_message) {
      copy.message.reply_to_message.text = canonicalPrevious;
    }
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    return new Request(request.url, { method:'POST', headers, body:JSON.stringify(copy) });
  } catch {
    return request;
  }
}
return { canonicalHousingAlias, canonicalizeGuidedHousingPrompt, normalizeHousingAliasRequest };
})();
const combined = (() => {
const JOBCENTER_TOPIC_PREFIX = 'Тема: Jobcenter.';
const HOUSING_INTENT = /(?:житл|квартир|wohnung|wohnraum|оренд|miete|apartment|flat)/iu;
const NON_HOUSING_JOBCENTER = /(?:bürgergeld|buergergeld|bescheid|mitwirkung|widerspruch|kindergeld|familienkasse|frist|строк|підготовк[аи]\s+листа|лист(?:а|ом|у)?|brief)/iu;

function explicitRoomSpec(text) {
  const match = /(?:^|[\s,])(\d{1,2}(?:\s*[-–—/]\s*\d{1,2})?)\s*(?:кімнат(?:а|и)?|кімн\.?|zimmer|rooms?)(?=$|[^\p{L}])/iu.exec(String(text || ''));
  return parseRoomSpec(match?.[1]);
}

function normalizeCombinedJobcenterHousingUpdate(update) {
  const message = update?.message;
  const text = String(message?.text || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const previous = String(message?.reply_to_message?.text || '');
  const chatId = Number(message?.chat?.id);

  if (message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0) return update;
  if (!previous.startsWith(JOBCENTER_TOPIC_PREFIX) || !text || !HOUSING_INTENT.test(text) || NON_HOUSING_JOBCENTER.test(text)) return update;

  const location = knownHousingLocation(text);
  const persons = parseHouseholdSize(text);
  const rooms = explicitRoomSpec(text);
  if (!location || !Number.isSafeInteger(persons) || persons < 1 || persons > 20 || !rooms) return update;

  const copy = JSON.parse(JSON.stringify(update));
  copy.message.text = `${location} житло для ${persons} осіб під Jobcenter ${rooms.label} ${roomsWord(rooms.label)}`;
  delete copy.message.reply_to_message;
  return copy;
}

async function normalizeRequest(request) {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/stateless' || request.method !== 'POST') return request;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return request;
  const normalized = normalizeCombinedJobcenterHousingUpdate(parsed.value);
  if (normalized === parsed.value) return request;

  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, {
    method:'POST',
    headers,
    body:JSON.stringify(normalized)
  });
}
return { normalizeRequest };
})();

export const canonicalizeGuidedHousingPrompt = aliases.canonicalizeGuidedHousingPrompt;
export async function normalizeCities(request, transport = fetch) {
  const conversation = await normalizeStatewideHousingConversationRequest(request, transport);
  const statewide = await normalizeStatewideHousingRequest(conversation);
  const buesum = await normalizeBuesumRequest(statewide);
  return aliases.normalizeHousingAliasRequest(buesum);
}
export async function normalizeJobcenterCityInput(request, transport = fetch) {
  return combined.normalizeRequest(await normalizeMunicipalityRequest(request, transport));
}
