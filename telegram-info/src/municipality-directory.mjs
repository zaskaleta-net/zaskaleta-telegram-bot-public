// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { SH_UKRAINIAN_PLACE_ROWS } from './schleswig-holstein-place-names.mjs';
import { SH_MUNICIPALITY_ALIAS_OVERRIDES } from './schleswig-holstein-municipality-alias-overrides.mjs';
import { SH_RUNTIME_MUNICIPALITY_ROWS } from './sh-municipality-jurisdiction-runtime.mjs';
import { jobcenterRuleLocationForMunicipality } from './schleswig-holstein-jobcenter-route.mjs';
import { parseHouseholdSize } from './housing-language.mjs';
import { parseRoomSpec, roomsWord } from './rooms.mjs';
import { readBoundedJSON } from './pilot-security.mjs';
const JOBCENTER_TOPIC_PROMPT = 'Тема: Jobcenter. Вкажіть місто або район і що саме потрібно: Bürgergeld, Bescheid, Mitwirkung, оренда/житло, строк або підготовка листа. Не надсилайте номер клієнта чи повні копії документів.';
const JOBCENTER_TOPIC_PREFIX = 'Тема: Jobcenter.';
const JOBCENTER_RETRY_PREFIX = '🏛 Jobcenter: не вдалося однозначно визначити місто або громаду.';
const HOUSING_INTENT = /(?:житл|квартир|wohnung|wohnraum|оренд|miete|apartment|flat)/iu;
const NON_HOUSING_JOBCENTER = /(?:bürgergeld|buergergeld|bescheid|mitwirkung|widerspruch|kindergeld|familienkasse|frist|строк|підготовк[аи]\s+листа|лист(?:а|ом|у)?|brief)/iu;
const CURATED_SUBSTRING_CONTEXT = /(?:jobcenter|джобцентр|джобцентер|житл|жиль|квартир|wohnung|wohnraum|miete|оренд|familie|family|сім|семь|осіб|особи|personen|people|доросл|взросл|kinder|children|діт|дет)/iu;
const EXTERNAL_DIRECTORY = 'https://www.gemeindeverzeichnis.de/api/gemeinden';

const JURISDICTION_BY_AGS = Object.freeze({
  '01':'Flensburg', '02':'Kiel', '03':'Lübeck', '04':'Neumünster',
  '51':'Dithmarschen', '53':'Herzogtum Lauenburg', '54':'Nordfriesland',
  '55':'Ostholstein', '56':'Pinneberg', '57':'Plön', '58':'Rendsburg-Eckernförde',
  '59':'Schleswig-Flensburg', '60':'Segeberg', '61':'Steinburg', '62':'Stormarn'
});

function placeKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ß/gu, 'ss')
    .toLowerCase()
    .replace(/[’ʼ'`´]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const OFFICIAL_RUNTIME_BY_KEY = (() => {
  const index = new Map();
  for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
    const key = placeKey(row?.canonical);
    if (!key) continue;
    const bucket = index.get(key) || [];
    bucket.push(row);
    index.set(key, bucket);
  }
  return index;
})();

export function matchOfficialSchleswigHolsteinMunicipality(text) {
  const inputKey = placeKey(text);
  if (!inputKey) return null;
  const matches = OFFICIAL_RUNTIME_BY_KEY.get(inputKey) || [];
  if (matches.length !== 1) return null;
  const row = matches[0];
  const route = {
    canonical:String(row.canonical || '').trim(),
    jurisdiction:String(row.jurisdiction || '').trim(),
    ags:String(row.ags || '').trim(),
    ars:String(row.ars || '').trim()
  };
  if (!route.canonical || !route.jurisdiction) return null;
  return Object.freeze({
    ...route,
    ruleLocation:jobcenterRuleLocationForMunicipality(route),
    source:'local-statewide-index'
  });
}

// These German canonical municipality names exist in more than one SH jurisdiction.
// Never pick the curated city for a bare canonical input; the directory must either
// disambiguate with context or fail safely rather than route to the wrong Jobcenter.
const AMBIGUOUS_CURATED_CANONICAL_KEYS = new Set(['quickborn','schenefeld','nortorf']);

const CURATED_ALIASES = Object.freeze(
  [...SH_UKRAINIAN_PLACE_ROWS, ...SH_MUNICIPALITY_ALIAS_OVERRIDES]
    .flatMap(row => {
      const canonicalKey = placeKey(row.canonical);
      return [row.canonical, ...(row.aliases || [])].map(alias => ({
        key:placeKey(alias),
        canonicalKey,
        isCanonical:placeKey(alias) === canonicalKey,
        canonical:row.canonical,
        jurisdiction:row.jurisdiction,
        ruleLocation:row.ruleLocation || null
      }));
    })
    .filter(item => item.key)
    .sort((a, b) => b.key.length - a.key.length)
);

function curatedResult(item) {
  const route = { canonical:item.canonical, jurisdiction:item.jurisdiction, ruleLocation:item.ruleLocation };
  return Object.freeze({
    canonical:item.canonical,
    jurisdiction:item.jurisdiction,
    ruleLocation:jobcenterRuleLocationForMunicipality(route),
    source:'local-registry'
  });
}

export function matchCuratedSchleswigHolsteinMunicipality(text) {
  const inputKey = placeKey(text);
  if (!inputKey) return null;

  // Exact aliases are safe, except ambiguous German canonical names. Ukrainian/Russian
  // aliases remain useful local shortcuts for the intended curated municipality.
  for (const item of CURATED_ALIASES) {
    if (item.key !== inputKey) continue;
    if (item.isCanonical && AMBIGUOUS_CURATED_CANONICAL_KEYS.has(item.canonicalKey)) return null;
    return curatedResult(item);
  }

  // A bare municipality-like value must not be hijacked by a shorter curated token
  // (e.g. "Ostenfeld (Rendsburg)" -> Rendsburg or "Kampen (Sylt)" -> Sylt).
  if (!CURATED_SUBSTRING_CONTEXT.test(String(text || ''))) return null;

  const haystack = ` ${inputKey} `;
  for (const item of CURATED_ALIASES) {
    if (item.isCanonical && AMBIGUOUS_CURATED_CANONICAL_KEYS.has(item.canonicalKey)) continue;
    if (haystack.includes(` ${item.key} `)) return curatedResult(item);
  }
  return null;
}

function explicitRoomSpec(text) {
  const match = /(?:^|[\s,])(\d{1,2}(?:\s*[-–—/]\s*\d{1,2}(?:[.,]\d+)?)?)\s*(?:кімнат(?:а|и)?|кімн\.?|zimmer|rooms?)(?=$|[^\p{L}])/iu.exec(String(text || ''));
  return parseRoomSpec(match?.[1]);
}

function plausibleQuery(value) {
  const source = String(value || '').replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!source || source.length < 2 || source.length > 100) return null;
  if (/\d/u.test(source)) return null;
  return source;
}

const PRIVATE_CONTEXT_WORDS = new Set([
  'сімя','сімї','семья','семьи','familie','family','діти','дітей','дитина','дети','детей','ребенок','ребёнок','kinder','children',
  'дорослі','дорослих','дорослий','взрослые','взрослых','erwachsene','adults','люди','людей','людина','осіб','особи','personen','people',
  'один','одна','два','дві','двоє','три','чотири','пять','пятьох','пятьеро','пять','шість','сім','вісім','девять','десять',
  'житло','жилье','wohnung','wohnraum','квартира','квартиру','квартири','miete','оренда','оренду','jobcenter','джобцентр','джобцентер',
  'для','під','под','für','for','mit','und','та','і','и'
]);

function safeLocationToken(token) {
  const key = placeKey(token);
  return !!key && !PRIVATE_CONTEXT_WORDS.has(key) && !/^\d+$/u.test(key);
}

function externalQueryCandidates(text) {
  const source = String(text || '').normalize('NFC').replace(/[.,;:!?()[\]{}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!source) return [];
  const words = source.split(' ').filter(Boolean);
  const candidates = [];
  const push = value => {
    const candidate = plausibleQuery(value);
    if (!candidate) return;
    const tokens = candidate.split(/\s+/u).filter(Boolean);
    if (!tokens.length || tokens.some(token => !safeLocationToken(token))) return;
    const key = placeKey(candidate);
    if (!key || candidates.some(item => placeKey(item) === key)) return;
    candidates.push(candidate);
  };

  if (words.length <= 4 && words.every(safeLocationToken)) push(source);

  const suffix = [];
  for (let i = words.length - 1; i >= 0 && suffix.length < 4; i -= 1) {
    if (!safeLocationToken(words[i])) break;
    suffix.unshift(words[i]);
  }
  for (let size = suffix.length; size >= 1; size -= 1) push(suffix.slice(-size).join(' '));

  const prefix = [];
  for (let i = 0; i < words.length && prefix.length < 4; i += 1) {
    if (!safeLocationToken(words[i])) break;
    prefix.push(words[i]);
  }
  for (let size = prefix.length; size >= 1; size -= 1) push(prefix.slice(0, size).join(' '));

  return candidates.slice(0, 6);
}

function itemsFromDirectoryPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.gemeinden)) return payload.gemeinden;
  return [];
}

function municipalityFromDirectoryItem(item, query) {
  const ags = String(item?.ags || '').replace(/\D/gu, '');
  if (!/^010\d{5}$/u.test(ags)) return null;
  const canonical = String(item?.normalized_display_name || item?.display_name || item?.name || '').replace(/\s+/gu, ' ').trim();
  if (!canonical || placeKey(canonical) !== placeKey(query)) return null;
  const jurisdiction = JURISDICTION_BY_AGS[ags.slice(3, 5)] || null;
  if (!jurisdiction) return null;
  const ars = String(item?.ars || '').replace(/\D/gu, '');
  const route = { canonical, jurisdiction, ags, ars };
  return Object.freeze({
    canonical,
    jurisdiction,
    ags,
    ars,
    ruleLocation:jobcenterRuleLocationForMunicipality(route),
    source:'gv-isys-directory'
  });
}

async function directoryLookup(query, transport = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const url = `${EXTERNAL_DIRECTORY}?q=${encodeURIComponent(query)}&bundesland=01&limit=20`;
    const response = await transport(url, { method:'GET', headers:{ accept:'application/json' }, signal:controller.signal });
    if (!response?.ok) return null;
    const payload = await response.json().catch(() => null);
    const matches = itemsFromDirectoryPayload(payload)
      .map(item => municipalityFromDirectoryItem(item, query))
      .filter(Boolean);
    const unique = [...new Map(matches.map(match => [match.ags, match])).values()];
    return unique.length === 1 ? unique[0] : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveSchleswigHolsteinMunicipalityText(text, transport = fetch) {
  const local = matchCuratedSchleswigHolsteinMunicipality(text);
  if (local) return local;

  const source = String(text || '').trim();
  const compoundDisambiguator = /[()]/u.test(source);
  const officialExact = matchOfficialSchleswigHolsteinMunicipality(source);

  // Plain exact municipality names are resolved entirely from the pinned statewide
  // index. Parenthetical official names keep the directory as the preferred
  // disambiguation authority so embedded city tokens can never hijack them.
  if (officialExact && !compoundDisambiguator) return officialExact;

  for (const candidate of externalQueryCandidates(source)) {
    const officialCandidate = matchOfficialSchleswigHolsteinMunicipality(candidate);
    if (officialCandidate && !compoundDisambiguator && !/[()]/u.test(candidate)) return officialCandidate;

    const resolved = await directoryLookup(candidate, transport);
    if (resolved) return resolved;

    // Network-independent fail-safe: an exact unique official name may still use
    // the pinned statewide index when the directory is unavailable.
    if (officialCandidate) return officialCandidate;
  }

  return officialExact;
}

export async function resolveSchleswigHolsteinJobcenterRoute(text, transport = fetch) {
  const municipality = await resolveSchleswigHolsteinMunicipalityText(text, transport);
  if (!municipality) return null;
  return Object.freeze({
    ...municipality,
    ruleLocation:municipality.ruleLocation || jobcenterRuleLocationForMunicipality(municipality)
  });
}

async function normalizePrivateJobcenterUpdate(update, transport = fetch) {
  const message = update?.message;
  const chatId = Number(message?.chat?.id);
  const text = String(message?.text || '').normalize('NFC').replace(/\s+/gu, ' ').trim();
  const previous = String(message?.reply_to_message?.text || '');
  if (message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || !text) return update;

  if (previous.startsWith(JOBCENTER_TOPIC_PREFIX)) {
    const municipality = await resolveSchleswigHolsteinMunicipalityText(text, transport);
    const persons = parseHouseholdSize(text);
    const housing = HOUSING_INTENT.test(text) && !NON_HOUSING_JOBCENTER.test(text);
    if (municipality && persons && housing) {
      const rooms = explicitRoomSpec(text);
      const copy = JSON.parse(JSON.stringify(update));
      copy.message.text = `${municipality.canonical} житло для ${persons} осіб під Jobcenter${rooms ? ` ${rooms.label} ${roomsWord(rooms.label)}` : ''}`;
      delete copy.message.reply_to_message;
      return copy;
    }
  }

  if (previous.startsWith(JOBCENTER_RETRY_PREFIX)) {
    const municipality = await resolveSchleswigHolsteinMunicipalityText(text, transport);
    if (municipality) {
      const copy = JSON.parse(JSON.stringify(update));
      copy.message.text = municipality.canonical;
      copy.message.reply_to_message.text = JOBCENTER_TOPIC_PROMPT;
      return copy;
    }
  }

  return update;
}

export async function normalizeMunicipalityRequest(request, transport) {
  const url = new URL(request.url);
  if (url.pathname !== '/telegram/stateless' || request.method !== 'POST') return request;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return request;
  const normalized = await normalizePrivateJobcenterUpdate(parsed.value, transport);
  if (normalized === parsed.value) return request;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method:'POST', headers, body:JSON.stringify(normalized) });
}
