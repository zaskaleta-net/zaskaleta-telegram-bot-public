const freeze = value => Object.freeze(value);

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

function includesName(location, name) {
  const key = normalize(name);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[ -])${escaped}(?:$|[ -])`, 'u').test(location);
}

const MUNICIPALITIES_STUFE_4 = freeze([
  'Barmstedt','Elmshorn','Uetersen','Bönningstedt','Hasloh','Helgoland',
  'Klein Nordende','Klein Offenseth-Sparrieshoop','Kölln-Reisiek','Raa-Besenbek','Seester','Seestermühe','Seeth-Ekholt',
  'Appen','Groß Nordende','Haselau','Haseldorf','Heidgraben','Hetlingen','Heist','Holm','Moorrege','Neuendeich',
  'Bokel','Brande-Hörnerkirchen','Osterhorn','Westerhorn',
  'Borstel-Hohenraden','Ellerbek','Kummerfeld','Prisdorf','Tangstedt',
  'Bevern','Bilsen','Bokholt-Hanredder','Bullenkuhlen','Ellerhoop','Groß Offenseth-Aspern','Heede','Hemdingen','Langeln','Lutzhorn'
]);

const AMT_ALIASES_STUFE_4 = freeze([
  'Amt Elmshorn-Land','Amt Geest und Marsch Südholstein','Amt Hörnerkirchen','Amt Pinnau','Amt Rantzau'
]);

const EXCEPTION_ZONES = freeze([
  freeze({ id:'stufe7', label:'Mietstufe 7', municipalities:freeze(['Schenefeld']), postcodes:freeze(['22869']) }),
  freeze({ id:'stufe6', label:'Mietstufe 6', municipalities:freeze(['Halstenbek','Wedel','Rellingen']), postcodes:freeze(['25469','22880','25462']) }),
  freeze({ id:'stufe5', label:'Mietstufe 5', municipalities:freeze(['Quickborn','Pinneberg','Tornesch']), postcodes:freeze(['25451','25421','25436']) })
]);

const AMBIGUOUS_BARE_NAMES = new Set([
  'quickborn','schenefeld','tangstedt','bokel','holm','heede'
]);

const ZONES = freeze({
  stufe4: freeze({
    label:'Mietstufe 4',
    limits:freeze([[583.22,50],[708.18,60],[843.26,75],[981.64,90],[1123.32,105]]),
    extraCost:136.18
  }),
  stufe5: freeze({
    label:'Mietstufe 5',
    limits:freeze([[639.32,50],[775.28,60],[922.46,75],[1078.44,90],[1231.12,105]]),
    extraCost:147.18
  }),
  stufe6: freeze({
    label:'Mietstufe 6',
    limits:freeze([[697.62,50],[846.78,60],[1008.26,75],[1176.34,90],[1344.42,105]]),
    extraCost:169.18
  }),
  stufe7: freeze({
    label:'Mietstufe 7',
    limits:freeze([[765.82,50],[929.28,60],[1105.06,75],[1290.74,90],[1475.32,105]]),
    extraCost:184.58
  })
});

export const PINNEBERG_KDU_REGISTRY = freeze({
  id:'jobcenter-pinneberg-kdu-2025-table',
  authority:'Jobcenter Kreis Pinneberg',
  jurisdiction:'Pinneberg',
  validFrom:null,
  validityLabel:'ab 2025 gemäß offizieller Kreistabelle',
  verifiedCurrentOn:'2026-09-10',
  costMeasure:'Richtwert für Unterkunftskosten nach SGB II/SGB XII; Heizkosten zusätzlich',
  heatingRule:'Angemessene Heizkosten kommen zusätzlich hinzu und werden separat geprüft.',
  areaPolicy:'orientation_only',
  municipalityCount:49,
  zones:ZONES,
  sources:freeze([
    freeze({type:'official-kdu',url:'https://www.kreis-pinneberg.de/pinneberg_media/Dokumente/Fachdienst+35/35-2/Richtwerte+Unterkunftskosten+(KdU).pdf'}),
    freeze({type:'official-kdu-page',url:'https://www.kreis-pinneberg.de/Verwaltung/Fachbereich%2BFamilie_%2BTeilhabe%2Bund%2BSoziales/Fachdienst%2BSoziales/Team%2BSoziale%2BSicherung.html'}),
    freeze({type:'official-municipality-register',url:'https://www.kreis-pinneberg.de/Kreis%2BPinneberg/St%C3%A4dte_%2B%C3%84mter%2Bund%2BGemeinden.html'})
  ])
});

function countyContext(location) {
  return /(?:^|[ -])kreis[ -]+pinneberg(?:$|[ -])/.test(location) || /(?:^|[ -])pinneberg[ -]+kreis(?:$|[ -])/.test(location);
}

function postcodeContext(raw, postcodes) {
  return postcodes.some(code => new RegExp(`(?:^|\\D)${code}(?:\\D|$)`).test(raw));
}

export function resolvePinnebergZone(value) {
  const raw = String(value ?? '').toLowerCase();
  const location = normalize(value);
  if (!location) return null;
  const explicitCounty = countyContext(location);
  if (location === 'kreis pinneberg' || location === 'pinneberg kreis') {
    return { status:'not_yet_mapped', jurisdiction:'Pinneberg', municipality:null, zone:null };
  }
  // Statewide routing appends "Kreis Pinneberg" to the municipality name. That
  // county suffix must not match the Mietstufe-5 town "Pinneberg" itself.
  const scope = location.replace(/(?:^|[ -])kreis[ -]+pinneberg$/u, '').trim() || location;

  for (const zone of EXCEPTION_ZONES) {
    for (const municipality of zone.municipalities) {
      if (!includesName(scope, municipality)) continue;
      const key = normalize(municipality);
      if (AMBIGUOUS_BARE_NAMES.has(key) && !explicitCounty && !postcodeContext(raw, zone.postcodes)) {
        return { status:'ambiguous_municipality', jurisdiction:'Pinneberg', municipality, zone:null };
      }
      return { status:'resolved', jurisdiction:'Pinneberg', municipality, zone:zone.id };
    }
  }

  for (const municipality of MUNICIPALITIES_STUFE_4) {
    if (!includesName(scope, municipality)) continue;
    const key = normalize(municipality);
    if (AMBIGUOUS_BARE_NAMES.has(key) && !explicitCounty) {
      return { status:'ambiguous_municipality', jurisdiction:'Pinneberg', municipality, zone:null };
    }
    return { status:'resolved', jurisdiction:'Pinneberg', municipality, zone:'stufe4' };
  }

  for (const amt of AMT_ALIASES_STUFE_4) {
    if (includesName(scope, amt)) return { status:'resolved', jurisdiction:'Pinneberg', municipality:amt, zone:'stufe4' };
  }

  if (explicitCounty) return { status:'not_yet_mapped', jurisdiction:'Pinneberg', municipality:null, zone:null };
  return null;
}

export function resolvePinnebergRule(location, householdSize) {
  const persons = Number(householdSize);
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20) {
    return { status:'unsupported_or_invalid', jurisdiction:'Pinneberg', module:PINNEBERG_KDU_REGISTRY, rule:null };
  }
  const resolved = resolvePinnebergZone(location);
  if (!resolved) return null;
  if (resolved.status !== 'resolved') return { ...resolved, module:PINNEBERG_KDU_REGISTRY, rule:null };
  const zone = ZONES[resolved.zone];
  const base = zone.limits[Math.min(persons,5)-1];
  const extraCount = Math.max(0, persons-5);
  return {
    status:'verified', jurisdiction:'Pinneberg', module:PINNEBERG_KDU_REGISTRY,
    rule:freeze({
      registryId:PINNEBERG_KDU_REGISTRY.id,
      jurisdiction:'Pinneberg', authority:PINNEBERG_KDU_REGISTRY.authority,
      municipality:resolved.municipality, zone:resolved.zone, zoneLabel:zone.label,
      householdSize:persons,
      grossColdLimit:Math.round((base[0] + zone.extraCost*extraCount)*100)/100,
      maxAreaSqm:base[1] + 10*extraCount,
      validFrom:null,
      validityLabel:PINNEBERG_KDU_REGISTRY.validityLabel,
      verifiedCurrentOn:PINNEBERG_KDU_REGISTRY.verifiedCurrentOn,
      costMeasure:PINNEBERG_KDU_REGISTRY.costMeasure,
      heatingRule:PINNEBERG_KDU_REGISTRY.heatingRule,
      sourceUrl:PINNEBERG_KDU_REGISTRY.sources[0].url
    })
  };
}

function money(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) && number >= 0 && number <= 50000 ? Math.round(number*100)/100 : null;
}

export function evaluatePinnebergHousing(input={}) {
  const resolved = resolvePinnebergRule(input.location, Number(input.householdSize));
  if (!resolved || resolved.status !== 'verified') return resolved || { status:'not_yet_mapped', jurisdiction:'Pinneberg', module:PINNEBERG_KDU_REGISTRY, rule:null };
  const kaltmiete=money(input.kaltmiete), betriebskosten=money(input.betriebskosten), heizkosten=money(input.heizkosten), areaSqm=money(input.areaSqm);
  const common={module:resolved.module,rule:resolved.rule,kaltmiete,betriebskosten,heizkosten,areaSqm};
  if (kaltmiete===null || betriebskosten===null || heizkosten===null) return {status:'insufficient_data',...common};
  const grossCold=Math.round((kaltmiete+betriebskosten)*100)/100;
  if (grossCold>resolved.rule.grossColdLimit) return {status:'over_limit',...common,grossCold};
  return {status:'within_guideline',...common,grossCold,areaAboveGuideline:areaSqm!==null&&areaSqm>resolved.rule.maxAreaSqm};
}
