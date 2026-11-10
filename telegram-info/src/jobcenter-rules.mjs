const OFFICIAL_KDU_SOURCE = 'https://jobcenter-stormarn.de/wp-content/uploads/2024/12/KDU-Uebersicht_pdf_2025.pdf';
const OFFICIAL_MOVE_SOURCE = 'https://jobcenter-stormarn.de/wp-content/uploads/2024/12/Umzugspaket.pdf';
const OFFICIAL_MUNICIPAL_SOURCE = 'https://www.kreis-stormarn.de/kreis/staedte-und-gemeinden/index.html';

const groups = Object.freeze({
  east: Object.freeze({
    id: 'stormarn-east',
    officialScope: 'Glinde, Ammersbek, Oststeinbek, Großhansdorf, Amt Siek',
    limits: Object.freeze({
      1: [618.20, 50], 2: [748.00, 60], 3: [889.90, 75], 4: [1040.60, 90], 5: [1188.00, 105]
    }),
    extra: Object.freeze([141.90, 10])
  }),
  central: Object.freeze({
    id: 'stormarn-central',
    officialScope: 'Bad Oldesloe, Reinfeld (Holstein), Tangstedt; Ämter Bad Oldesloe Land, Bargteheide Land, Nordstormarn, Trittau',
    limits: Object.freeze({
      1: [562.10, 50], 2: [680.90, 60], 3: [810.70, 75], 4: [943.80, 90], 5: [1080.20, 105]
    }),
    extra: Object.freeze([130.90, 10])
  }),
  premium: Object.freeze({
    id: 'stormarn-premium',
    officialScope: 'Ahrensburg, Barsbüttel, Bargteheide, Reinbek',
    limits: Object.freeze({
      1: [676.50, 50], 2: [819.50, 60], 3: [975.50, 75], 4: [1138.50, 90], 5: [1301.30, 105]
    }),
    extra: Object.freeze([163.90, 10])
  })
});

const municipalityGroups = new Map();
function add(group, names) {
  for (const name of names) municipalityGroups.set(normalizeLocation(name), group);
}

add('east', [
  'Glinde', 'Ammersbek', 'Oststeinbek', 'Großhansdorf',
  'Braak', 'Brunsbek', 'Hoisdorf', 'Siek', 'Stapelfeld'
]);
add('central', [
  'Bad Oldesloe', 'Reinfeld', 'Reinfeld (Holstein)', 'Tangstedt',
  'Grabau', 'Lasbek', 'Meddewade', 'Neritz', 'Pölitz', 'Rethwisch', 'Rümpel', 'Steinburg', 'Travenbrück',
  'Bargfeld-Stegen', 'Delingsdorf', 'Elmenhorst', 'Hammoor', 'Jersbek', 'Nienwohld', 'Todendorf', 'Tremsbüttel',
  'Badendorf', 'Barnitz', 'Feldhorst', 'Hamberge', 'Heidekamp', 'Heilshoop', 'Klein Wesenberg', 'Mönkhagen', 'Rehhorst', 'Wesenberg', 'Westerau', 'Zarpen',
  'Grande', 'Grönwohld', 'Großensee', 'Hamfelde', 'Hohenfelde', 'Köthel', 'Lütjensee', 'Rausdorf', 'Trittau', 'Witzhave'
]);
add('premium', ['Ahrensburg', 'Barsbüttel', 'Bargteheide', 'Reinbek']);

export const STORMARN_KDU_REGISTRY = Object.freeze({
  id: 'jobcenter-stormarn-kdu-2025-01-01',
  authority: 'Jobcenter Stormarn',
  district: 'Kreis Stormarn',
  validFrom: '2025-01-01',
  verifiedOn: '2026-09-10',
  costMeasure: 'Kaltmiete + Betriebskosten (ohne Heizkosten)',
  heatingRule: 'Heizkosten werden im Einzelfall geprüft.',
  sources: Object.freeze([
    Object.freeze({ type: 'official-kdu', url: OFFICIAL_KDU_SOURCE }),
    Object.freeze({ type: 'official-move-package', url: OFFICIAL_MOVE_SOURCE }),
    Object.freeze({ type: 'official-municipality-register', url: OFFICIAL_MUNICIPAL_SOURCE })
  ]),
  groups
});

export function normalizeLocation(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/\b\d{5}\b/g, ' ')
    .replace(/[^a-z0-9 -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stormarnGroupForLocation(value) {
  const location = normalizeLocation(value);
  if (!location || /\b(?:kreis|landkreis)\s+(?!stormarn\b)/u.test(location) || location === 'steinburg') return null;
  const names = [...municipalityGroups.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const pattern = new RegExp(`(?:^|\\s|-)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s|-)`);
    if (pattern.test(location)) return groups[municipalityGroups.get(name)];
  }
  return null;
}

export function stormarnRuleFor(value, householdSize) {
  const persons = Number(householdSize);
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20) return null;
  const group = stormarnGroupForLocation(value);
  if (!group) return null;
  const [baseCost, baseArea] = group.limits[Math.min(persons, 5)];
  const extraCount = Math.max(0, persons - 5);
  return Object.freeze({
    registryId: STORMARN_KDU_REGISTRY.id,
    groupId: group.id,
    officialScope: group.officialScope,
    householdSize: persons,
    grossColdLimit: Math.round((baseCost + group.extra[0] * extraCount) * 100) / 100,
    maxAreaSqm: baseArea + group.extra[1] * extraCount,
    validFrom: STORMARN_KDU_REGISTRY.validFrom,
    costMeasure: STORMARN_KDU_REGISTRY.costMeasure,
    heatingRule: STORMARN_KDU_REGISTRY.heatingRule,
    sourceUrl: OFFICIAL_KDU_SOURCE
  });
}

function money(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) && number >= 0 && number <= 50000 ? Math.round(number * 100) / 100 : null;
}

export function evaluateStormarnHousing(input = {}) {
  const rule = stormarnRuleFor(input.location, Number(input.householdSize));
  if (!rule) return { status: 'unsupported_or_invalid', rule: null };
  const kaltmiete = money(input.kaltmiete);
  const betriebskosten = money(input.betriebskosten);
  const heizkosten = money(input.heizkosten);
  if (kaltmiete === null || betriebskosten === null || heizkosten === null) {
    return { status: 'insufficient_data', rule, kaltmiete, betriebskosten, heizkosten };
  }
  const grossCold = Math.round((kaltmiete + betriebskosten) * 100) / 100;
  const area = money(input.areaSqm);
  if (grossCold > rule.grossColdLimit) {
    return { status: 'over_limit', rule, kaltmiete, betriebskosten, heizkosten, grossCold, areaSqm: area };
  }
  return { status: 'within_guideline', rule, kaltmiete, betriebskosten, heizkosten, grossCold, areaSqm: area, areaAboveGuideline: area !== null && area > rule.maxAreaSqm };
}

export function parseRentBreakdown(text) {
  const source = String(text ?? '').trim();
  const pick = labels => {
    const pattern = new RegExp(`(?:${labels})\\s*[:=]?\\s*(\\d{1,5}(?:[.,]\\d{1,2})?)`, 'iu');
    const match = pattern.exec(source);
    return match ? Number(match[1].replace(',', '.')) : null;
  };
  let kaltmiete = pick('kaltmiete|grundmiete|kalt');
  let betriebskosten = pick('betriebskosten|nebenkosten|bk|nk');
  let heizkosten = pick('heizkosten|heizung|hk');
  if ([kaltmiete, betriebskosten, heizkosten].some(value => value === null)) {
    const numbers = [...source.matchAll(/(?:^|\s)(\d{1,5}(?:[.,]\d{1,2})?)(?=\s|€|$)/gu)].map(match => Number(match[1].replace(',', '.')));
    if (numbers.length === 3) [kaltmiete, betriebskosten, heizkosten] = numbers;
  }
  return { kaltmiete, betriebskosten, heizkosten };
}

export function formatEuro(value) {
  const number = Number(value);
  return Number.isInteger(number) ? `${number} €` : `${number.toFixed(2).replace('.', ',')} €`;
}

