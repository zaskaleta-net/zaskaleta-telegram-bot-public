// Deterministic next steps for the menu topics that used to repeat their own
// prompt (work, courses, school, transport, documents, Kindergeld, Jobcenter).
// Only official, link-checked sources are named (2026-10-13); nothing here is
// an individual legal assessment.
import { knownHousingLocation } from './housing-language.mjs';
import { resolveJobcenterRule, SH_STATEWIDE_KDU_COVERAGE, SH_VERIFIED_KDU_MODULES } from './jobcenter-registry-statewide.mjs';

const TOPIC_PROMPTS = Object.freeze([
  ['work', /^Тема: робота\./u],
  ['courses', /^Тема: інтеграційні та мовні курси\./u],
  ['school', /^Тема: школа \/ Kita\./u],
  ['transport', /^Тема: транспорт\./u],
  ['documents', /^Тема: документи та перебування\./u],
  ['kindergeld', /^Тема: Familienkasse \/ Kindergeld\./u],
  ['jobcenter', /^Тема: Jobcenter\./u]
]);

const TOPIC_WORDS = Object.freeze([
  ['transport', /(?:транспорт|автобус|поїзд|потяг|електричк|маршрут|fahrplan|\bbus\b|\bbahn\b|\bzug\b|hvv|nah\.?sh)/iu],
  ['kindergeld', /(?:kindergeld|familienkasse|кіндергельд|допомог[аиу] на дитину)/iu],
  ['documents', /(?:ausländer|auslaender|aufenthalt|fiktions|\be-?at\b|reisepass|паспорт|посвідк|перебуван|документ)/iu],
  ['courses', /(?:integrationskurs|sprachkurs|deutschkurs|курс|einstufungstest)/iu],
  ['school', /(?:schule|kita|kindergarten|школ|садок|дитсад)/iu],
  ['work', /(?:робот[аиу]|вакансі|резюме|lebenslauf|bewerbung|arbeit|\bjob\b(?![\s-]*center))/iu]
]);

export const OFFICIAL_LINKS = Object.freeze({
  jobboerse:'https://www.arbeitsagentur.de/jobsuche/',
  anerkennung:'https://www.anerkennung-in-deutschland.de/',
  integrationskurse:'https://bamf-navi.bamf.de/de/Themen/Integrationskurse/',
  migrationsberatung:'https://bamf-navi.bamf.de/de/Themen/Migrationsberatung/',
  kitaportal:'https://www.kitaportal-sh.de/',
  nahsh:'https://www.nah.sh/de/',
  bahn:'https://www.bahn.de/',
  hvv:'https://www.hvv.de/',
  zufish:'https://zufish.schleswig-holstein.de/',
  germany4ukraine:'https://www.germany4ukraine.de/',
  kindergeld:'https://www.arbeitsagentur.de/familie-und-kinder/kindergeld',
  kindergeldAnspruch:'https://www.arbeitsagentur.de/familie-und-kinder/kindergeld-anspruch-hoehe-dauer'
});

export function topicOfPrompt(text) {
  const source = String(text || '').trim();
  return TOPIC_PROMPTS.find(([, pattern]) => pattern.test(source))?.[0] || null;
}

export function topicOfText(text) {
  const source = String(text || '');
  if (/job[\s-]*center|джоб[\s-]*[цс][еэ]нт|bürgergeld|buergergeld|mitwirkung|widerspruch/iu.test(source)) return 'jobcenter';
  return TOPIC_WORDS.find(([, pattern]) => pattern.test(source))?.[0] || null;
}

// Ukrainian place names arrive declined ("у Кілі", "в Любеку").
function nameVariants(word) {
  const value = String(word || '').trim();
  const variants = [value];
  if (/[іиуюї]$/u.test(value)) variants.push(value.slice(0, -1), `${value.slice(0, -1)}ь`, `${value.slice(0, -1)}а`);
  if (/ові$/u.test(value)) variants.push(value.slice(0, -3));
  return variants.filter(item => item.length >= 2);
}

export function placeFromText(text) {
  const source = String(text || '').normalize('NFC');
  const direct = knownHousingLocation(source);
  if (direct) return direct;
  const candidates = [];
  for (const segment of source.split(/[,;:\n]+/u)) {
    const words = segment.trim().split(/\s+/u).filter(Boolean);
    for (let size = Math.min(3, words.length); size >= 1; size -= 1) {
      for (let start = 0; start + size <= words.length; start += 1) {
        const phrase = words.slice(start, start + size).join(' ').replace(/^[«"'(]+|[»"'),.!?]+$/gu, '');
        if (!/^[\p{Lu}]/u.test(phrase)) continue;
        if (size === 1) candidates.push(...nameVariants(phrase));
        else candidates.push(phrase);
      }
    }
  }
  for (const candidate of candidates) {
    const resolved = knownHousingLocation(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function jurisdictionOf(place) {
  if (!place) return null;
  const jurisdiction = resolveJobcenterRule(place, 1)?.jurisdiction || null;
  return jurisdiction && SH_STATEWIDE_KDU_COVERAGE[jurisdiction] ? jurisdiction : null;
}

function jobcenterOf(jurisdiction) {
  if (!jurisdiction) return null;
  const coverage = SH_STATEWIDE_KDU_COVERAGE[jurisdiction];
  const url = SH_VERIFIED_KDU_MODULES[jurisdiction]?.sources?.[0]?.url;
  let site = null;
  try { site = url ? new URL(url).origin + '/' : null; } catch {}
  return { authority:coverage?.authority || `Jobcenter ${jurisdiction}`, site };
}

function placeLine(place, jurisdiction) {
  if (!place) return null;
  return jurisdiction && jurisdiction !== place ? `📍 ${place} (Kreis/місто: ${jurisdiction})` : `📍 ${place}`;
}

function workQuery(text, place) {
  const words = String(text || '')
    .replace(new RegExp(String(place || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu'), ' ')
    .replace(/[^\p{L}\p{N} -]+/gu, ' ')
    .split(/\s+/u)
    .filter(word => /^[A-Za-zÄÖÜäöüß-]{3,}$/u.test(word) && !/^(?:und|oder|in|im|bei|als|job|jobs|arbeit|suche)$/iu.test(word));
  return words.slice(0, 3).join(' ');
}

// Frequent destinations outside Schleswig-Holstein, written in Cyrillic
// (also declined: "до Гамбурга").
const CITY_ALIASES = Object.freeze({
  'гамбург':'Hamburg', 'берлін':'Berlin', 'бремен':'Bremen', 'ганновер':'Hannover',
  'мюнхен':'München', 'франкфурт':'Frankfurt am Main', 'кельн':'Köln', 'шверін':'Schwerin',
  'росток':'Rostock', 'копенгаген':'København'
});
const ROUTE_FROM_TO = /(?:^|\s)(?:з|із|від|von|from)\s+([\p{L}\p{M}.' -]{2,40}?)\s+(?:до|в|у|nach|to)\s+([\p{L}\p{M}.' -]{2,40}?)(?=$|[,.!?]|\s+(?:завтра|сьогодні|о\s|в\s\d|um\s|\d))/iu;
const ROUTE_SEPARATED = /^\s*([\p{L}\p{M}.' ]{2,40}?)\s*(?:→|->|—|–|-|>)\s*([\p{L}\p{M}.' ]{2,40}?)\s*(?=$|[,.!?]|\s+(?:завтра|сьогодні|о\s|в\s\d|um\s|\d))/iu;

function routeOf(text) {
  const source = String(text || '');
  const match = ROUTE_FROM_TO.exec(source) || ROUTE_SEPARATED.exec(source);
  return match ? [match[1], match[2]] : null;
}

function routePlace(raw) {
  const value = String(raw || '').trim();
  const known = placeFromText(value.replace(/^\p{Ll}/u, letter => letter.toUpperCase()));
  if (known) return known;
  const key = value.toLowerCase();
  return CITY_ALIASES[key] || CITY_ALIASES[key.replace(/[ауі]$/u, '')] || value;
}

export function jobboerseSearchUrl(place, query = '') {
  const params = new URLSearchParams({ angebotsart:'1' });
  if (place) params.set('wo', place);
  if (query) params.set('was', query);
  return `https://www.arbeitsagentur.de/jobsuche/suche?${params.toString()}`;
}

function needPlace(topic) {
  const examples = { transport:'з Trittau до Hamburg, завтра 8:00' };
  return {
    text:[
      'Вкажіть, будь ласка, місто або громаду в Schleswig-Holstein.',
      `Наприклад: ${examples[topic] || 'Kiel, Lübeck або Trittau'}.`
    ].join('\n'),
    needsPlace:true
  };
}

const builders = {
  work(text, place, jurisdiction) {
    const jobcenter = jobcenterOf(jurisdiction);
    const query = workQuery(text, place);
    return [
      '💼 Робота',
      placeLine(place, jurisdiction),
      '',
      `1. Вакансії Bundesagentur für Arbeit (Jobbörse)${query ? ` за запитом «${query}»` : ''}:`,
      jobboerseSearchUrl(place, query),
      '2. Якщо отримуєте Bürgergeld, про пошук роботи, курси та Bewerbungskosten домовляйтеся з вашим Jobcenter:',
      jobcenter ? `${jobcenter.authority}${jobcenter.site ? ` — ${jobcenter.site}` : ''}` : 'Jobcenter за місцем проживання.',
      '3. Визнання українського диплома чи професії (Anerkennung):',
      OFFICIAL_LINKS.anerkennung,
      '',
      'Не надсилайте в чат номер клієнта Jobcenter чи копії документів.'
    ];
  },
  courses(_text, place, jurisdiction) {
    return [
      '🎓 Інтеграційні та мовні курси',
      placeLine(place, jurisdiction),
      '',
      '1. Пошук Integrationskurs поруч (BAMF-NAvI, введіть свій поштовий індекс):',
      OFFICIAL_LINKS.integrationskurse,
      '2. Право або обов’язок відвідувати курс (Berechtigung/Verpflichtung) зазвичай оформлює Jobcenter або Ausländerbehörde — візьміть цей документ до Kursträger.',
      '3. Безкоштовна консультація з питань курсу, документів і листів (Migrationsberatung):',
      OFFICIAL_LINKS.migrationsberatung
    ];
  },
  school(text, place, jurisdiction) {
    const kita = /kita|kindergarten|садок|дитсад/iu.test(String(text || ''));
    return [
      kita ? '👶 Kita' : '🎒 Школа / Kita',
      placeLine(place, jurisdiction),
      '',
      '1. Місце в Kita в Schleswig-Holstein шукають і подають заявку через Kita-Portal SH:',
      OFFICIAL_LINKS.kitaportal,
      '2. Для школи зверніться до найближчої школи або до Schulamt вашого Kreis/міста: там підкажуть, яка школа приймає дитину і чи є клас DaZ (Deutsch als Zweitsprache).',
      '3. Допомога з листами від школи чи Kita (Migrationsberatung):',
      OFFICIAL_LINKS.migrationsberatung
    ];
  },
  transport(text, place) {
    const route = routeOf(text);
    const from = route ? routePlace(route[0]) : place;
    const to = route ? routePlace(route[1]) : null;
    const hamburg = /hamburg|гамбург/iu.test(`${from || ''} ${to || ''} ${text || ''}`);
    return [
      '🚌 Транспорт',
      from || to ? `🧭 ${from || '?'} → ${to || '?'}` : null,
      '',
      '1. Розклад автобусів і поїздів у Schleswig-Holstein (NAH.SH, Fahrplanauskunft):',
      OFFICIAL_LINKS.nahsh,
      '2. Поїзди по Німеччині та квитки (Deutsche Bahn):',
      OFFICIAL_LINKS.bahn,
      ...(hamburg ? ['3. Гамбург і околиці (HVV):', OFFICIAL_LINKS.hvv] : []),
      '',
      'Перед поїздкою перевірте зміни в розкладі в день поїздки.'
    ];
  },
  documents(_text, place, jurisdiction) {
    return [
      '📄 Документи та перебування',
      placeLine(place, jurisdiction),
      '',
      '1. Ваша Ausländerbehörde (Zuwanderungsbehörde), адреса, Termin і потрібні документи — Zuständigkeitsfinder Schleswig-Holstein (введіть послугу, наприклад «Aufenthaltserlaubnis», і своє місто):',
      OFFICIAL_LINKS.zufish,
      '2. Офіційна інформація для людей з України (Germany4Ukraine):',
      OFFICIAL_LINKS.germany4ukraine,
      '3. Якщо строк дії документа спливає, звертайтеся до Ausländerbehörde заздалегідь і зберігайте підтвердження подання.',
      '4. Безкоштовна консультація (Migrationsberatung):',
      OFFICIAL_LINKS.migrationsberatung
    ];
  },
  kindergeld(_text, place, jurisdiction) {
    return [
      '👶 Kindergeld / Familienkasse',
      placeLine(place, jurisdiction),
      '',
      '1. Kindergeld, заява онлайн і контакти Familienkasse:',
      OFFICIAL_LINKS.kindergeld,
      '2. Хто має право, розмір і тривалість виплати:',
      OFFICIAL_LINKS.kindergeldAnspruch,
      '3. У листуванні з Familienkasse завжди вказуйте свій Kindergeldnummer (у чат його не надсилайте).'
    ];
  },
  jobcenter(text, place, jurisdiction) {
    const jobcenter = jobcenterOf(jurisdiction);
    const bescheid = /bescheid|рішенн|лист|widerspruch/iu.test(String(text || ''));
    const mitwirkung = /mitwirkung/iu.test(String(text || ''));
    return [
      '🏛 Jobcenter',
      placeLine(place, jurisdiction),
      jobcenter ? `${jobcenter.authority}${jobcenter.site ? `\n${jobcenter.site}` : ''}` : null,
      '',
      ...(mitwirkung ? [
        'Mitwirkungspflichten (обов’язок співпраці з Jobcenter):',
        '• подавати запитані документи до вказаного строку;',
        '• приходити на призначені Termine;',
        '• одразу повідомляти про зміни: дохід, адреса, склад сім’ї, робота.',
        '• Не встигаєте до строку — повідомте Jobcenter письмово заздалегідь і попросіть продовження.',
        ''
      ] : []),
      ...(bescheid ? [
        'Bescheid (рішення Jobcenter):',
        '• Наприкінці Bescheid є Rechtsbehelfsbelehrung — там указано строк і адресу для Widerspruch. Зазвичай це один місяць від отримання.',
        '• Якщо не згодні з рішенням, подайте Widerspruch письмово до закінчення строку і збережіть підтвердження.',
        '• Не розумієте лист — безкоштовна Migrationsberatung допоможе його розібрати:',
        OFFICIAL_LINKS.migrationsberatung
      ] : [
        'Для житла під Jobcenter відкрийте «🏠 Житло» → місто → «🏛 Житло під Jobcenter».',
        'Питання про Bürgergeld, Bescheid або Mitwirkung ставте своєму Jobcenter; допомогу з листами дає Migrationsberatung:',
        OFFICIAL_LINKS.migrationsberatung
      ]),
      '',
      'Не надсилайте в чат номер клієнта (Kundennummer) чи копії документів.'
    ];
  }
};

export function topicGuidance(topic, text) {
  const build = builders[topic];
  if (!build) return null;
  const place = placeFromText(text);
  if (!place && !['transport', 'kindergeld', 'jobcenter'].includes(topic)) return needPlace(topic);
  const jurisdiction = jurisdictionOf(place);
  const lines = build(text, place, jurisdiction).filter(line => line !== null && line !== undefined);
  return { text:lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim(), needsPlace:false, topic, place, jurisdiction };
}
