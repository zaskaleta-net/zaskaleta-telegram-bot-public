const freezeLimits = limits => Object.freeze(
  Object.fromEntries(Object.entries(limits).map(([persons, value]) => [persons, Object.freeze(value)]))
);

const NORTH_MUNICIPALITIES = Object.freeze([
  'Heide',
  'Barkenholm', 'Bergewöhrden', 'Delve', 'Fedderingen', 'Glüsing', 'Groven', 'Hemme', 'Hennstedt', 'Hollingstedt',
  'Karolinenkoog', 'Kleve', 'Krempel', 'Lehe', 'Linden', 'Lunden', 'Norderheistedt', 'Rehm-Flehde-Bargen', 'Schlichting',
  'Sankt Annen', 'Süderheistedt', 'Wiemerstedt', 'Dellstedt', 'Dörpling', 'Gaushorn', 'Hövede', 'Pahlen', 'Süderdorf',
  'Schalkholz', 'Tellingstedt', 'Tielenhemme', 'Wallen', 'Welmbüttel', 'Westerborstel', 'Wrohm',
  'Büsum', 'Büsumer Deichhausen', 'Friedrichsgabekoog', 'Hedwigenkoog', 'Hellschen-Heringsand-Unterschaar', 'Hillgroven',
  'Norddeich', 'Oesterdeichstrich', 'Oesterwurth', 'Reinsbüttel', 'Schülp', 'Strübbel', 'Süderdeich', 'Warwerort',
  'Wesselburen', 'Wesselburener Deichhausen', 'Wesselburenerkoog', 'Westerdeichstrich',
  'Hemmingstedt', 'Lieth', 'Lohe-Rickelshof', 'Neuenkirchen', 'Norderwöhrden', 'Nordhastedt', 'Ostrohe',
  'Stelle-Wittenwurth', 'Weddingstedt', 'Wesseln', 'Wöhrden'
]);

const SOUTH_MUNICIPALITIES = Object.freeze([
  'Brunsbüttel',
  'Bargenstedt', 'Barlt', 'Busenwurth', 'Elpersbüttel', 'Epenwöhrden', 'Gudendorf', 'Krumstedt', 'Meldorf', 'Nindorf',
  'Nordermeldorf', 'Odderade', 'Sarzbüttel', 'Windbergen', 'Wolmersdorf', 'Albersdorf', 'Arkebek', 'Bunsoh', 'Immenstedt',
  'Offenbüttel', 'Osterrade', 'Schafstedt', 'Schrum', 'Tensbüttel-Röst', 'Wennbüttel',
  'Averlak', 'Brickeln', 'Buchholz', 'Burg', 'Dingen', 'Eddelak', 'Eggstedt', 'Frestedt', 'Großenrade', 'Hochdonn',
  'Kuden', 'Quickborn', 'Sankt Michaelisdonn', 'Süderhastedt',
  'Diekhusen-Fahrstedt', 'Friedrichskoog', 'Helse', 'Kaiser-Wilhelm-Koog', 'Kronprinzenkoog', 'Marne', 'Marnerdeich',
  'Neufelderkoog', 'Neufeld', 'Ramhusen', 'Schmedeswurth', 'Trennewurth', 'Volsemenhusen'
]);

// These bare municipality names also occur, or can easily be confused with places, outside Dithmarschen.
// They are only auto-routed when the location itself explicitly contains “Dithmarschen”.
const AMBIGUOUS_BARE_NAMES = new Set([
  'burg', 'buchholz', 'quickborn', 'neuenkirchen', 'hennstedt', 'hollingstedt', 'kleve', 'linden',
  'nindorf', 'schulp', 'immenstedt', 'neufeld', 'norddeich', 'lehe'
]);

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/st\.?\s+michaelisdonn/g, 'sankt michaelisdonn')
    .replace(/st\.?\s+annen/g, 'sankt annen')
    .replace(/[^a-z0-9 -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MUNICIPALITIES = Object.freeze([
  ...NORTH_MUNICIPALITIES.map(name => Object.freeze({ key: normalize(name), name, zone: 'north' })),
  ...SOUTH_MUNICIPALITIES.map(name => Object.freeze({ key: normalize(name), name, zone: 'south' }))
].sort((a, b) => b.key.length - a.key.length));

export const DITHMARSCHEN_KDU_REGISTRY = Object.freeze({
  id: 'jobcenter-dithmarschen-kdu-2025-01-01',
  authority: 'Jobcenter Dithmarschen',
  jurisdiction: 'Dithmarschen',
  validFrom: '2025-01-01',
  verifiedOn: '2026-09-10',
  costMeasure: 'Bruttokaltmiete (Kaltmiete + kalte Betriebskosten, ohne Heizkosten)',
  heatingRule: 'Heizkosten werden separat geprüft. Eine größere Wohnfläche allein macht die Unterkunft nach der veröffentlichten Produkttheorie nicht unangemessen; bei größeren Wohnungen sind die Heizkosten besonders zu prüfen.',
  areaPolicy: 'orientation_only',
  individualReviewFrom: 5,
  municipalityCount: NORTH_MUNICIPALITIES.length + SOUTH_MUNICIPALITIES.length,
  zones: Object.freeze({
    north: Object.freeze({
      label: 'Nord',
      limits: freezeLimits({
        1: [497.50, 50], 2: [514.80, 60], 3: [627.00, 75], 4: [751.50, 90], 5: [866.25, 105]
      }),
      extraCost: 123.75,
      extraArea: 10
    }),
    south: Object.freeze({
      label: 'Süd',
      limits: freezeLimits({
        1: [435.50, 50], 2: [491.40, 60], 3: [606.75, 75], 4: [699.30, 90], 5: [856.80, 105]
      }),
      extraCost: 122.40,
      extraArea: 10
    })
  }),
  sources: Object.freeze([
    Object.freeze({
      type: 'official-kdu',
      url: 'https://www.jobcenter-dithmarschen.de/fileadmin/user_upload/Richtlinie_Kosten_der_Unterkunft.pdf'
    }),
    Object.freeze({
      type: 'official-municipality-office-mapping',
      url: 'https://www.dithmarschen.de/fileadmin/download/themen/voruebergehendezuordnung.pdf'
    }),
    Object.freeze({
      type: 'official-state-municipality-register',
      url: 'https://www.statistik-nord.de/fileadmin/Dokumente/A_I_2_vj_26-1_Zensus22_SH.pdf'
    })
  ])
});

export function resolveDithmarschenZone(value) {
  const location = normalize(value);
  if (!location) return null;
  const explicitlyDithmarschen = /(?:^|[ -])dithmarschen(?:$|[ -])/.test(location);

  for (const item of MUNICIPALITIES) {
    const escaped = item.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(?:^|[ -])${escaped}(?:$|[ -])`, 'u').test(location)) continue;
    if (AMBIGUOUS_BARE_NAMES.has(item.key) && !explicitlyDithmarschen) {
      return {
        status: 'ambiguous_municipality',
        jurisdiction: 'Dithmarschen',
        municipality: item.name,
        zone: null
      };
    }
    return {
      status: 'resolved',
      jurisdiction: 'Dithmarschen',
      municipality: item.name,
      zone: item.zone
    };
  }
  return null;
}

export function resolveDithmarschenRule(location, householdSize) {
  const persons = Number(householdSize);
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20) {
    return { status: 'unsupported_or_invalid', jurisdiction: 'Dithmarschen', module: DITHMARSCHEN_KDU_REGISTRY, rule: null };
  }

  const resolved = resolveDithmarschenZone(location);
  if (!resolved) return null;
  if (resolved.status !== 'resolved') {
    return { ...resolved, module: DITHMARSCHEN_KDU_REGISTRY, rule: null };
  }

  const zone = DITHMARSCHEN_KDU_REGISTRY.zones[resolved.zone];
  const base = zone.limits[Math.min(persons, 5)];
  const extraCount = Math.max(0, persons - 5);
  return {
    status: 'verified',
    jurisdiction: 'Dithmarschen',
    module: DITHMARSCHEN_KDU_REGISTRY,
    rule: Object.freeze({
      registryId: DITHMARSCHEN_KDU_REGISTRY.id,
      jurisdiction: 'Dithmarschen',
      authority: DITHMARSCHEN_KDU_REGISTRY.authority,
      zone: resolved.zone,
      zoneLabel: zone.label,
      municipality: resolved.municipality,
      householdSize: persons,
      grossColdLimit: Math.round((base[0] + zone.extraCost * extraCount) * 100) / 100,
      maxAreaSqm: base[1] + zone.extraArea * extraCount,
      validFrom: DITHMARSCHEN_KDU_REGISTRY.validFrom,
      costMeasure: DITHMARSCHEN_KDU_REGISTRY.costMeasure,
      heatingRule: DITHMARSCHEN_KDU_REGISTRY.heatingRule,
      sourceUrl: DITHMARSCHEN_KDU_REGISTRY.sources[0].url
    })
  };
}

function money(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) && number >= 0 && number <= 50000 ? Math.round(number * 100) / 100 : null;
}

export function evaluateDithmarschenHousing(input = {}) {
  const resolved = resolveDithmarschenRule(input.location, Number(input.householdSize));
  if (!resolved || resolved.status !== 'verified') return resolved || { status: 'not_yet_mapped', jurisdiction: 'Dithmarschen', module: DITHMARSCHEN_KDU_REGISTRY, rule: null };

  const kaltmiete = money(input.kaltmiete);
  const betriebskosten = money(input.betriebskosten);
  const heizkosten = money(input.heizkosten);
  const area = money(input.areaSqm);
  const common = { module: resolved.module, rule: resolved.rule, kaltmiete, betriebskosten, heizkosten, areaSqm: area };

  if (kaltmiete === null || betriebskosten === null || heizkosten === null) {
    return { status: 'insufficient_data', ...common };
  }

  const grossCold = Math.round((kaltmiete + betriebskosten) * 100) / 100;
  if (grossCold > resolved.rule.grossColdLimit) {
    return { status: 'over_limit', ...common, grossCold };
  }

  if (resolved.rule.householdSize >= DITHMARSCHEN_KDU_REGISTRY.individualReviewFrom) {
    return { status: 'needs_review', reason: 'large_household_individual_review', ...common, grossCold };
  }

  return {
    status: 'within_guideline',
    ...common,
    grossCold,
    heatingAreaCaution: area !== null && area > resolved.rule.maxAreaSqm
  };
}
