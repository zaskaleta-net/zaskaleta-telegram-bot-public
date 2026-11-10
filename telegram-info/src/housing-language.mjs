import { resolveJobcenterRule } from './jobcenter-registry-statewide.mjs';
import { canonicalSchleswigHolsteinPlace } from './schleswig-holstein-place-names.mjs';
import { canonicalHamburgPlace } from './hamburg-place-names.mjs';

const LOCATION_ALIASES = new Map([
  ['гамбург', 'Hamburg'], ['кіль', 'Kiel'], ['киль', 'Kiel'],
  ['любек', 'Lübeck'], ['любеку', 'Lübeck'], ['любеці', 'Lübeck'], ['любеке', 'Lübeck'],
  ['любик', 'Lübeck'], ['любику', 'Lübeck'], ['любике', 'Lübeck'], ['любіку', 'Lübeck'],
  ['lübeck', 'Lübeck'], ['luebeck', 'Lübeck'],
  ['плен', 'Plön'], ['плені', 'Plön'], ['плену', 'Plön'], ['плён', 'Plön'], ['плёне', 'Plön'],
  ['пльон', 'Plön'], ['пльоні', 'Plön'], ['plön', 'Plön'], ['ploen', 'Plön'], ['plon', 'Plön'],
  ['stormarn', 'Stormarn'], ['штормарн', 'Stormarn'], ['штормарні', 'Stormarn'], ['штормарну', 'Stormarn'], ['штормарне', 'Stormarn'],
  ['segeberg', 'Segeberg'], ['зегеберг', 'Segeberg'], ['зегебергу', 'Segeberg'], ['зегеберга', 'Segeberg'], ['зегеберге', 'Segeberg'], ['зегеберзі', 'Segeberg'],
  ['шлезвіг-фленсбург', 'Schleswig-Flensburg'], ['шлезвіг фленсбург', 'Schleswig-Flensburg'],
  ['шлезвиг-фленсбург', 'Schleswig-Flensburg'], ['шлезвиг фленсбург', 'Schleswig-Flensburg'],
  ['trittau', 'Trittau'], ['трітау', 'Trittau'], ['тріттау', 'Trittau'], ['триттау', 'Trittau'],
  ['аренсбург', 'Ahrensburg'], ['аренсбургу', 'Ahrensburg'], ['аренсбурзі', 'Ahrensburg'],
  ['аренсбурге', 'Ahrensburg'], ['аренсбурга', 'Ahrensburg'], ['ahrensburg', 'Ahrensburg'],
  ['rendsburg', 'Rendsburg'], ['рендсбург', 'Rendsburg'], ['ренсберг', 'Rendsburg'], ['ренсбург', 'Rendsburg'],
  ['шверін', 'Schwerin'], ['шверин', 'Schwerin'],
  ['бад олдеслое', 'Bad Oldesloe'], ['бад-олдеслое', 'Bad Oldesloe'],
  ['neumünster', 'Neumünster'], ['neumunster', 'Neumünster'], ['ноймюнстер', 'Neumünster'],
  ['flensburg', 'Flensburg'], ['фленсбург', 'Flensburg']
]);

const DISTRICT_PREFIX = /^(?:kreis|landkreis|район|районі|району|районе)\s+(.+)$/iu;
const DISTRICT_JURISDICTIONS = new Set([
  'Dithmarschen', 'Herzogtum Lauenburg', 'Nordfriesland', 'Ostholstein', 'Pinneberg', 'Plön',
  'Rendsburg-Eckernförde', 'Schleswig-Flensburg', 'Segeberg', 'Steinburg', 'Stormarn'
]);

export function normalizeHousingLocation(value) {
  const supplied = String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!supplied) return null;
  const districtMatch = DISTRICT_PREFIX.exec(supplied);
  if (districtMatch) {
    const body = LOCATION_ALIASES.get(districtMatch[1].toLowerCase()) || districtMatch[1];
    const resolved = resolveJobcenterRule(body, 1);
    if (resolved?.jurisdiction && DISTRICT_JURISDICTIONS.has(resolved.jurisdiction)) return `Kreis ${resolved.jurisdiction}`;
  }
  const canonicalPlace = canonicalSchleswigHolsteinPlace(supplied) || canonicalHamburgPlace(supplied);
  return canonicalPlace || LOCATION_ALIASES.get(supplied.toLowerCase()) || supplied;
}

function statewideKnownLocation(value) {
  const normalized = normalizeHousingLocation(value);
  if (!normalized) return null;
  const registered = canonicalSchleswigHolsteinPlace(normalized);
  if (registered) return registered;
  const resolved = resolveJobcenterRule(normalized, 1);
  return resolved?.jurisdiction ? normalized : null;
}

export function knownHousingLocation(text) {
  const source = String(text || '').normalize('NFC');
  // Resolve complete place phrases before aliases such as Segeberg or Hamburg,
  // which may also occur inside a municipality's full name.
  const exact = canonicalSchleswigHolsteinPlace(source);
  if (exact) return exact;

  // Compact chat input may start with a registered place followed by a family count.
  // Keep this deliberately narrow: only a known place before "family N" is accepted.
  const compactFamily = /^(.+?)\s+(?:сім['’ʼ]?я|семья|familie|family)\s+(?:з\s+)?\d{1,2}(?:\s|$)/iu.exec(source);
  const compactPlace = compactFamily?.[1]
    ?.replace(/[,:;.!?\-–—]+\s*$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const compactResolved = compactPlace ? statewideKnownLocation(compactPlace) : null;
  if (compactResolved) return compactResolved;

  // Users often start with the place name: "Trittau житло ...". Accept that
  // ordering only for a registered place or a location confirmed by the router.
  const leadingMatch = /^([\p{L}\p{M}.'’()/ -]{2,80}?)(?=\s+(?:житл[\p{L}\p{M}]*|квартир[\p{L}\p{M}]*|wohnung|wohnraum)(?=$|[^\p{L}]))/iu.exec(source);
  const leadingCandidate = leadingMatch?.[1]?.replace(/\s+/g, ' ').trim();
  const leadingResolved = leadingCandidate ? statewideKnownLocation(leadingCandidate) : null;
  if (leadingResolved) return leadingResolved;

  // Natural input may contain lower-case, multi-word German or Ukrainian place names.
  // Stop before either a Jobcenter phrase, an explicit household count, or a
  // Ukrainian/German "for a family / for N people" clause.
  const naturalMatch = /(?:^|[\s,])(?:в|у|in)\s+([\p{L}\p{M}.'’()/ -]{2,100}?)(?=\s+(?:(?:під|под|для|für|for|unter|under)\s+(?:job[\s-]*center|джоб[\s-]*[цс][еэ]нт[еэ]?р)|(?:для|für|for)\s+(?:(?:сім['’ʼ]?ї|семьи|familie)\s*(?:з\s*)?)?\d{1,2}\s*(?:осіб|особи|особа|людини|людей|людина|человек(?:а)?|personen)|(?:job[\s-]*center|джоб[\s-]*[цс][еэ]нт[еэ]?р)|\d{1,2}(?:\s*[-–—/]\s*\d{1,2})?\s*(?:кімнат(?:а|и)?|кімн\.?|zimmer|rooms?|осіб|особи|особа|людини|людей|людина|personen))|$|[,.!?])/iu.exec(source);
  const candidate = naturalMatch?.[1]?.replace(/\s+/g, ' ').trim();
  // "in der Nähe" is not the municipality Nahe (TG-RUNTIME-070 review): a
  // German article starts a phrase, not a place name.
  const naturalResolved = candidate && !/^(?:der|die|das|dem|den)\s/iu.test(candidate) ? statewideKnownLocation(candidate) : null;
  if (naturalResolved) return naturalResolved;

  const aliasMatch = /(?:^|[^\p{L}])(hamburg|гамбург|trittau|трітау|тріттау|триттау|ahrensburg|аренсбург(?:у|а|е)?|аренсбурзі|rendsburg|рендсбург|ренсберг|ренсбург|lübeck|luebeck|любек[уе]?|любеці|любик[уе]?|любіку|(?:(?:kreis|landkreis|район|районі|району|районе)\s+)?(?:schleswig[- ]flensburg|шлезв[іи]г[- ]фленсбург)|flensburg|фленсбург|(?:(?:kreis|landkreis|район|районі|району|районе)\s+)?(?:stormarn|штормарн(?:і|у|е)?)|(?:(?:kreis|landkreis|район|районі|району|районе)\s+)?(?:segeberg|зегеберг(?:у|а|е)?|зегеберзі)|(?:(?:kreis|landkreis|район|районі|району|районе)\s+)?(?:plön|ploen|plon|плен[іу]?|плён[е]?|пльон[і]?))(?=$|[^\p{L}])/iu.exec(source);
  if (aliasMatch) return normalizeHousingLocation(aliasMatch[1]);
  return null;
}

const NUMBER_WORDS = new Map([
  [0, 'нуль ноль'],
  [1, 'один одна однієї одного одну одной'],
  [2, 'два дві двох двух двое двоє'],
  [3, 'три трьох трех трое троє'],
  [4, 'чотири чотирьох четыре четырех четверо'],
  [5, "п'ять п'яти пять пяти п'ятеро пятеро"],
  [6, 'шість шести шістьох шесть шестеро'],
  [7, 'сім семи сімох семь семеро'],
  [8, 'вісім восьми вісьмох восемь восьмеро'],
  [9, "дев'ять дев'яти девять девяти дев'ятеро девятеро"],
  [10, 'десять десяти десятеро'],
  [11, 'одинадцять одинадцяти одиннадцать одиннадцати'],
  [12, 'дванадцять дванадцяти двенадцать двенадцати'],
  [13, 'тринадцять тринадцяти тринадцать тринадцати'],
  [14, 'чотирнадцять чотирнадцяти четырнадцать четырнадцати'],
  [15, "п'ятнадцять п'ятнадцяти пятнадцать пятнадцати"],
  [16, 'шістнадцять шістнадцяти шестнадцать шестнадцати'],
  [17, 'сімнадцять сімнадцяти семнадцать семнадцати'],
  [18, 'вісімнадцять вісімнадцяти восемнадцать восемнадцати'],
  [19, "дев'ятнадцять дев'ятнадцяти девятнадцать девятнадцати"],
  [20, 'двадцять двадцяти двадцать двадцати'],
  // Consume larger/compound numbers whole so their final word is not a small household.
  [30, 'тридцять тридцяти тридцать тридцати'],
  [40, 'сорок сорока'], [50, "п'ятдесят п'ятдесяти пятьдесят пятидесяти"],
  [60, 'шістдесят шістдесяти шестьдесят шестидесяти'],
  [70, 'сімдесят сімдесяти семьдесят семидесяти'],
  [80, 'вісімдесят вісімдесяти восемьдесят восьмидесяти'],
  [90, "дев'яносто дев'яноста девяносто девяноста"], [100, 'сто ста']
].flatMap(([value, words]) => words.split(' ').map(word => [word, value])));
const NUMBER = `(?:[0-9]+|${[...NUMBER_WORDS.keys()].join('|')})`;
const GENERIC_PEOPLE_NOUN = '(?:осіб|особи|особа|людини|людей|людина|людину|человек(?:а)?|personen)';
const COMPONENT_PEOPLE_NOUN = '(?:жінка|жінки|жінок|чоловік|чоловіки|чоловіків|дорослий|доросла|дорослі|дорослих|дитина|дитини|дитину|діти|дітей|женщина|женщины|женщин|мужчина|мужчины|мужчин|взрослый|взрослая|взрослые|взрослых|ребенок|ребёнок|ребенка|ребёнка|дети|детей|frau(?:en)?|mann|männer|maenner|erwachsene|kinder|women|men|adults|children)';
const PEOPLE_NOUN = `(?:${GENERIC_PEOPLE_NOUN}|${COMPONENT_PEOPLE_NOUN})`;
const PEOPLE = new RegExp(`(?<![\\p{L}\\p{N}])([-+−–—]?${NUMBER}(?:\\s*(?:[-–—/+.,]|або|чи|или|до)\\s*[-+−]?${NUMBER}|\\s+${NUMBER})*)\\s*(${PEOPLE_NOUN})(?=$|[^\\p{L}])`, 'giu');
const GENERIC_PEOPLE = new RegExp(`^${GENERIC_PEOPLE_NOUN}$`, 'iu');
const FAMILY_DIGITS = /(?:^|[^\p{L}\p{N}])(?:сім['’ʼ]?я|семья|familie|family)\s+(?:з\s+)?([0-9]{1,2})(?=$|[^\p{N}])/iu;

function parsedHouseholdCount(raw) {
  const count = /^[0-9]+$/u.test(raw) ? Number(raw) : NUMBER_WORDS.get(raw);
  return Number.isSafeInteger(count) && count >= 1 && count <= 20 ? count : null;
}

export function parseHouseholdSize(text) {
  const source = String(text || '').normalize('NFC').toLowerCase().replace(/[’ʼ]/gu, "'");
  const family = FAMILY_DIGITS.exec(source);
  if (family) return parsedHouseholdCount(family[1]);

  const matches = [...source.matchAll(PEOPLE)];
  if (!matches.length) return null;

  const parts = matches.map(match => ({ count: parsedHouseholdCount(match[1]), noun: match[2] }));
  if (parts.some(part => !part.count)) return null;

  const generic = parts.filter(part => GENERIC_PEOPLE.test(part.noun));
  const components = parts.filter(part => !GENERIC_PEOPLE.test(part.noun));
  if (generic.length > 1) return null;

  const componentTotal = components.reduce((sum, part) => sum + part.count, 0);
  if (componentTotal > 20) return null;

  if (generic.length === 1) {
    const statedTotal = generic[0].count;
    if (!components.length) return statedTotal;
    return statedTotal === componentTotal ? statedTotal : null;
  }

  return componentTotal >= 1 && componentTotal <= 20 ? componentTotal : null;
}