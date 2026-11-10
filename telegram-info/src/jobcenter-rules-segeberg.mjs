const freeze = value => Object.freeze(value);
const freezeLimits = limits => Object.freeze(Object.fromEntries(
  Object.entries(limits).map(([persons, pair]) => [persons, Object.freeze(pair)])
));

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9 -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SPECIAL = freeze({
  norderstedt: freeze({ label:'Mietstufe 6 – Stadt Norderstedt', limits:[697.62,846.78,1008.26,1176.34,1344.42], extraCost:169.18 }),
  'henstedt-ulzburg': freeze({ label:'Mietstufe 5 – Gemeinde Henstedt-Ulzburg', limits:[639.32,775.28,922.46,1078.44,1231.12], extraCost:147.18 }),
  kaltenkirchen: freeze({ label:'Mietstufe 4 – Stadt Kaltenkirchen', limits:[583.22,708.18,843.26,981.64,1123.32], extraCost:136.18 }),
  'bad-segeberg': freeze({ label:'Mietstufe 4 – Stadt Bad Segeberg', limits:[583.22,708.18,843.26,981.64,1123.32], extraCost:136.18 }),
  'bad-bramstedt': freeze({ label:'Mietstufe 3 – Stadt Bad Bramstedt', limits:[522.72,633.38,755.26,880.44,1005.62], extraCost:121.80 }),
  remaining: freeze({ label:'Mietstufe 2 – übrige Gemeinden im Kreis Segeberg', limits:[469.92,569.58,678.26,792.44,903.32], extraCost:108.79 })
});

const REMAINING_MUNICIPALITIES = Object.freeze([
  'Wahlstedt','Ellerau',
  'Armstedt','Bimöhlen','Borstel','Föhrden-Barl','Fuhlendorf','Großenaspe','Hagen','Hardebek','Hasenkrug','Heidmoor','Hitzhusen','Mönkloh','Weddelbrook','Wiemersdorf',
  'Bornhöved','Damsdorf','Gönnebek','Schmalensee','Stocksee','Tarbek','Tensfeld','Trappenkamp',
  'Itzstedt','Kayhude','Nahe','Oering','Seth','Sülfeld',
  'Alveslohe','Hartenholm','Hasenmoor','Lentföhrden','Nützen','Schmalfeld',
  'Hüttblek','Kattendorf','Kisdorf','Oersdorf','Sievershütten','Struvenhütten','Stuvenborn','Wakendorf II','Winsen',
  'Bark','Bebensee','Fredesdorf','Groß Niendorf','Högersdorf','Kükels','Leezen','Mözen','Neversdorf','Schwissel','Todesfelde','Wittenborn',
  'Boostedt','Daldorf','Groß Kummerfeld','Heidmühlen','Latendorf','Rickling',
  'Bahrenhof','Blunk','Bühnsdorf','Dreggers','Fahrenkrug','Geschendorf','Glasau','Groß Rönnau','Klein Gladebrügge','Klein Rönnau','Krems II','Negernbötel','Nehms','Neuengörs','Pronstorf','Rohlstorf','Schackendorf','Schieren','Seedorf','Stipsdorf','Strukdorf','Travenhorst','Traventhal','Wakendorf I','Weede','Wensin','Westerrade'
]);

const AMBIGUOUS_BARE = new Set([
  'borstel','hagen','winsen','bark','seedorf','stocksee','weede','nahe'
]);

const municipalityIndex = new Map(REMAINING_MUNICIPALITIES.map(name => [normalize(name), name]));

export const SEGEBERG_KDU_REGISTRY = freeze({
  id: 'jobcenter-segeberg-kdu-current-2025-table',
  authority: 'Jobcenter Kreis Segeberg',
  jurisdiction: 'Segeberg',
  validFrom: null,
  validityLabel: 'aktuelle veröffentlichte Tabelle 2025',
  verifiedCurrentOn: '2026-09-10',
  costMeasure: 'Brutto-Kaltmiete (Kaltmiete inklusive Nebenkosten, ohne Heizung)',
  heatingRule: 'Heizkosten werden zusätzlich übernommen, soweit sie angemessen sind.',
  areaPolicy:'orientation_only',
  maxAreas: freeze([50,60,75,85,95]),
  extraArea: 10,
  municipalityCount: 95,
  sources: freeze([
    freeze({ type:'official-current-kdu-page', url:'https://www.jobcenter-kreis-segeberg.de/geldleistungen/kosten-der-unterkunft.html' }),
    freeze({ type:'official-live-linked-table', url:'https://www.jobcenter-kreis-segeberg.de/fileadmin/media/pdf/250115_Hinweise_Anmietung_Wohnung_2025.pdf' }),
    freeze({ type:'official-municipality-register', url:'https://www.segeberg.de/index.php?FID=3466.14987.1&ModID=7&object=tx%7C3466.14987.1' })
  ]),
  zones: SPECIAL
});

function exactOrEmbedded(location, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[ -])${escaped}(?:$|[ -])`, 'u').test(location);
}

export function resolveSegebergMunicipality(value) {
  const location = normalize(value);
  if (!location) return null;
  const explicitKreis = /(?:^|[ -])(?:kreis[ -]+)?segeberg(?:$|[ -])/.test(location);

  const special = [
    ['norderstedt','Norderstedt','norderstedt'],
    ['henstedt-ulzburg','Henstedt-Ulzburg','henstedt-ulzburg'],
    ['henstedt ulzburg','Henstedt-Ulzburg','henstedt-ulzburg'],
    ['kaltenkirchen','Kaltenkirchen','kaltenkirchen'],
    ['bad segeberg','Bad Segeberg','bad-segeberg'],
    ['bad bramstedt','Bad Bramstedt','bad-bramstedt']
  ];
  for (const [alias, municipality, zone] of special) {
    if (exactOrEmbedded(location, alias)) return { status:'resolved', jurisdiction:'Segeberg', municipality, zone };
  }

  const entries = [...municipalityIndex.entries()].sort((a,b) => b[0].length - a[0].length);
  for (const [key, municipality] of entries) {
    if (!exactOrEmbedded(location, key)) continue;
    if (AMBIGUOUS_BARE.has(key) && !explicitKreis) {
      return { status:'ambiguous_municipality', jurisdiction:'Segeberg', municipality, zone:null };
    }
    return { status:'resolved', jurisdiction:'Segeberg', municipality, zone:'remaining' };
  }

  if (location === 'segeberg' || location === 'kreis segeberg') {
    return { status:'not_yet_mapped', jurisdiction:'Segeberg', municipality:null, zone:null };
  }
  return null;
}

export function resolveSegebergRule(value, householdSize) {
  const persons = Number(householdSize);
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20) return null;
  const resolved = resolveSegebergMunicipality(value);
  if (!resolved) return null;
  if (resolved.status !== 'resolved') return { ...resolved, module:SEGEBERG_KDU_REGISTRY, rule:null };

  const zone = SPECIAL[resolved.zone];
  const baseIndex = Math.min(persons, 5) - 1;
  const extra = Math.max(0, persons - 5);
  const grossColdLimit = Math.round((zone.limits[baseIndex] + zone.extraCost * extra) * 100) / 100;
  const maxAreaSqm = SEGEBERG_KDU_REGISTRY.maxAreas[baseIndex] + SEGEBERG_KDU_REGISTRY.extraArea * extra;

  return {
    status:'verified',
    jurisdiction:'Segeberg',
    module:SEGEBERG_KDU_REGISTRY,
    rule:freeze({
      registryId:SEGEBERG_KDU_REGISTRY.id,
      jurisdiction:'Segeberg',
      authority:SEGEBERG_KDU_REGISTRY.authority,
      municipality:resolved.municipality,
      zone:resolved.zone,
      zoneLabel:zone.label,
      householdSize:persons,
      grossColdLimit,
      maxAreaSqm,
      validFrom:null,
      validityLabel:SEGEBERG_KDU_REGISTRY.validityLabel,
      verifiedCurrentOn:SEGEBERG_KDU_REGISTRY.verifiedCurrentOn,
      costMeasure:SEGEBERG_KDU_REGISTRY.costMeasure,
      heatingRule:SEGEBERG_KDU_REGISTRY.heatingRule,
      sourceUrl:SEGEBERG_KDU_REGISTRY.sources[1].url
    })
  };
}

function money(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) && number >= 0 && number <= 50000 ? Math.round(number * 100) / 100 : null;
}

export function evaluateSegebergHousing(input = {}) {
  const resolved = resolveSegebergRule(input.location, Number(input.householdSize));
  if (!resolved || resolved.status !== 'verified') return resolved || { status:'not_yet_mapped', jurisdiction:'Segeberg', module:SEGEBERG_KDU_REGISTRY, rule:null };
  const kaltmiete = money(input.kaltmiete);
  const betriebskosten = money(input.betriebskosten);
  const heizkosten = money(input.heizkosten);
  const areaSqm = money(input.areaSqm);
  const common = { module:resolved.module, rule:resolved.rule, kaltmiete, betriebskosten, heizkosten, areaSqm };
  if (kaltmiete === null || betriebskosten === null || heizkosten === null) return { status:'insufficient_data', ...common };
  const grossCold = Math.round((kaltmiete + betriebskosten) * 100) / 100;
  if (grossCold > resolved.rule.grossColdLimit) return { status:'over_limit', ...common, grossCold };
  return { status:'within_guideline', ...common, grossCold, areaAboveGuideline:areaSqm !== null && areaSqm > resolved.rule.maxAreaSqm };
}
