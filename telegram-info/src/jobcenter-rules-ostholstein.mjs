const freeze = value => Object.freeze(value);

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ß/gu, 'ss')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function containsName(location, name) {
  const key = normalize(name);
  if (!key) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^| )${escaped}(?:$| )`, 'u').test(location);
}

const ZONES = freeze({
  eutin: freeze({
    label:'Vergleichsraum Eutin',
    municipalities:freeze([
      freeze({ canonical:'Eutin', aliases:freeze(['Eutin']) }),
      freeze({ canonical:'Malente', aliases:freeze(['Malente']) }),
      freeze({ canonical:'Bosau', aliases:freeze(['Bosau']) }),
      freeze({ canonical:'Süsel', aliases:freeze(['Süsel','Suesel']) })
    ]),
    limits:freeze([[461.50,50],[555.00,60],[679.50,75],[829.80,90],[963.90,105]]),
    extraCost:91.80
  }),
  badSchwartau: freeze({
    label:'Vergleichsraum Bad Schwartau',
    municipalities:freeze([
      freeze({ canonical:'Bad Schwartau', aliases:freeze(['Bad Schwartau']) }),
      freeze({ canonical:'Stockelsdorf', aliases:freeze(['Stockelsdorf']) }),
      freeze({ canonical:'Ratekau', aliases:freeze(['Ratekau']) }),
      freeze({ canonical:'Scharbeutz', aliases:freeze(['Scharbeutz']) }),
      freeze({ canonical:'Timmendorfer Strand', aliases:freeze(['Timmendorfer Strand']) }),
      freeze({ canonical:'Ahrensbök', aliases:freeze(['Ahrensbök','Ahrensboek']) })
    ]),
    limits:freeze([[525.00,50],[637.20,60],[803.25,75],[989.10,90],[1187.55,105]]),
    extraCost:113.10
  }),
  neustadt: freeze({
    label:'Vergleichsraum Neustadt',
    municipalities:freeze([
      freeze({ canonical:'Neustadt in Holstein', aliases:freeze(['Neustadt in Holstein','Neustadt i.H.','Neustadt i H']) }),
      freeze({ canonical:'Dahme', aliases:freeze(['Dahme']) }),
      freeze({ canonical:'Grömitz', aliases:freeze(['Grömitz','Groemitz']) }),
      freeze({ canonical:'Kellenhusen (Ostsee)', aliases:freeze(['Kellenhusen','Kellenhusen Ostsee']) }),
      freeze({ canonical:'Altenkrempe', aliases:freeze(['Altenkrempe']) }),
      freeze({ canonical:'Kasseedorf', aliases:freeze(['Kasseedorf']) }),
      freeze({ canonical:'Schashagen', aliases:freeze(['Schashagen']) }),
      freeze({ canonical:'Schönwalde am Bungsberg', aliases:freeze(['Schönwalde am Bungsberg','Schoenwalde am Bungsberg','Schönwalde a. B.','Schoenwalde a B']) }),
      freeze({ canonical:'Sierksdorf', aliases:freeze(['Sierksdorf']) })
    ]),
    limits:freeze([[448.50,50],[608.40,60],[729.00,75],[913.50,90],[1086.75,105]]),
    extraCost:103.50
  }),
  oldenburg: freeze({
    label:'Vergleichsraum Oldenburg',
    municipalities:freeze([
      freeze({ canonical:'Oldenburg in Holstein', aliases:freeze(['Oldenburg in Holstein','Oldenburg i.H.','Oldenburg i H']) }),
      freeze({ canonical:'Fehmarn', aliases:freeze(['Fehmarn']) }),
      freeze({ canonical:'Heiligenhafen', aliases:freeze(['Heiligenhafen']) }),
      freeze({ canonical:'Grube', aliases:freeze(['Grube']) }),
      freeze({ canonical:'Göhl', aliases:freeze(['Göhl','Goehl']) }),
      freeze({ canonical:'Gremersdorf', aliases:freeze(['Gremersdorf']) }),
      freeze({ canonical:'Großenbrode', aliases:freeze(['Großenbrode','Grossenbrode']) }),
      freeze({ canonical:'Heringsdorf', aliases:freeze(['Heringsdorf']) }),
      freeze({ canonical:'Neukirchen', aliases:freeze(['Neukirchen']) }),
      freeze({ canonical:'Wangels', aliases:freeze(['Wangels']) }),
      freeze({ canonical:'Beschendorf', aliases:freeze(['Beschendorf']) }),
      freeze({ canonical:'Damlos', aliases:freeze(['Damlos']) }),
      freeze({ canonical:'Harmsdorf', aliases:freeze(['Harmsdorf']) }),
      freeze({ canonical:'Kabelhorst', aliases:freeze(['Kabelhorst']) }),
      freeze({ canonical:'Lensahn', aliases:freeze(['Lensahn']) }),
      freeze({ canonical:'Manhagen', aliases:freeze(['Manhagen']) }),
      freeze({ canonical:'Riepsdorf', aliases:freeze(['Riepsdorf']) })
    ]),
    limits:freeze([[507.00,50],[595.80,60],[681.75,75],[836.10,90],[1082.55,105]]),
    extraCost:103.10
  })
});

export const OSTHOLSTEIN_KDU_REGISTRY = freeze({
  id:'jobcenter-ostholstein-kdu-2025-05-01',
  authority:'Jobcenter Ostholstein / Kreis Ostholstein',
  jurisdiction:'Ostholstein',
  validFrom:'2025-05-01',
  verifiedCurrentOn:'2026-10-12',
  costMeasure:'Bruttokaltmiete (Kaltmiete + kalte Betriebskosten, ohne Heizkosten)',
  heatingRule:'Heizkosten werden zusätzlich berücksichtigt und separat auf Angemessenheit geprüft.',
  areaPolicy:'orientation_only',
  municipalityCount:36,
  extraAfter:5,
  extraArea:10,
  zones:ZONES,
  sources:freeze([
    // The Jobcenter page still links this table as current on 2026-10-12:
    // "Übersicht über die Mietobergrenzen ab Mai 2025" (PDF of 06.05.2025).
    freeze({
      type:'official-kdu-table',
      url:'https://www.jobcenter-ostholstein.de/output/download.php?fid=3375.213.1.PDF'
    }),
    freeze({
      type:'official-kdu-page',
      url:'https://www.jobcenter-ostholstein.de/Arbeitnehmer/Grundsicherung/'
    }),
    freeze({
      type:'official-kdu-merkblatt',
      url:'https://www.kreis-oh.de/PDF/Kosten_der_Unterkunft_Umzug_Merkblatt_.PDF?Ext=PDF&ObjID=565&ObjLa=1&ObjSvrID=2454&WTR=1'
    }),
    freeze({
      type:'official-kdu-concept',
      url:'https://www.kreis-oh.de/PDF/Konzept_zur_Ermittlung_der_angemessenen_Bedarfe_f%C3%BCr_Unterkunft.PDF?Ext=PDF&ObjID=566&ObjLa=1&ObjSvrID=2454&WTR=1'
    }),
    freeze({
      type:'official-municipality-register',
      url:'https://www.kreis-oh.de/PDF/%C3%9Cbersicht_%C3%BCber_die_Kommunen_in_Ostholstein.PDF?Ext=PDF&ObjID=3701&ObjLa=1&ObjSvrID=2454&WTR=1'
    })
  ])
});

export function resolveOstholsteinZone(value) {
  const location = normalize(value);
  if (!location) return null;
  if (location === 'ostholstein' || location === 'kreis ostholstein') {
    return { status:'not_yet_mapped', jurisdiction:'Ostholstein', municipality:null, zone:null };
  }
  for (const [zoneId, zone] of Object.entries(ZONES)) {
    for (const municipality of zone.municipalities) {
      if (municipality.aliases.some(alias => containsName(location, alias))) {
        return { status:'resolved', jurisdiction:'Ostholstein', municipality:municipality.canonical, zone:zoneId };
      }
    }
  }
  return null;
}

export function resolveOstholsteinRule(location, householdSize) {
  const persons = Number(householdSize);
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20) {
    return { status:'unsupported_or_invalid', jurisdiction:'Ostholstein', module:OSTHOLSTEIN_KDU_REGISTRY, rule:null };
  }
  const resolved = resolveOstholsteinZone(location);
  if (!resolved) return null;
  if (resolved.status !== 'resolved') return { ...resolved, module:OSTHOLSTEIN_KDU_REGISTRY, rule:null };
  const zone = ZONES[resolved.zone];
  const base = zone.limits[Math.min(persons,5)-1];
  const extraCount = Math.max(0, persons-5);
  return {
    status:'verified',
    jurisdiction:'Ostholstein',
    module:OSTHOLSTEIN_KDU_REGISTRY,
    rule:freeze({
      registryId:OSTHOLSTEIN_KDU_REGISTRY.id,
      jurisdiction:'Ostholstein',
      authority:OSTHOLSTEIN_KDU_REGISTRY.authority,
      municipality:resolved.municipality,
      zone:resolved.zone,
      zoneLabel:zone.label,
      householdSize:persons,
      grossColdLimit:Math.round((base[0] + zone.extraCost*extraCount)*100)/100,
      maxAreaSqm:base[1] + OSTHOLSTEIN_KDU_REGISTRY.extraArea*extraCount,
      validFrom:OSTHOLSTEIN_KDU_REGISTRY.validFrom,
      verifiedCurrentOn:OSTHOLSTEIN_KDU_REGISTRY.verifiedCurrentOn,
      costMeasure:OSTHOLSTEIN_KDU_REGISTRY.costMeasure,
      heatingRule:OSTHOLSTEIN_KDU_REGISTRY.heatingRule,
      sourceUrl:OSTHOLSTEIN_KDU_REGISTRY.sources[0].url
    })
  };
}

function money(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) && number >= 0 && number <= 50000 ? Math.round(number*100)/100 : null;
}

export function evaluateOstholsteinHousing(input={}) {
  const resolved = resolveOstholsteinRule(input.location, Number(input.householdSize));
  if (!resolved || resolved.status !== 'verified') {
    return resolved || { status:'not_yet_mapped', jurisdiction:'Ostholstein', module:OSTHOLSTEIN_KDU_REGISTRY, rule:null };
  }
  const kaltmiete=money(input.kaltmiete);
  const betriebskosten=money(input.betriebskosten);
  const heizkosten=money(input.heizkosten);
  const areaSqm=money(input.areaSqm);
  const common={module:resolved.module,rule:resolved.rule,kaltmiete,betriebskosten,heizkosten,areaSqm};
  if (kaltmiete===null || betriebskosten===null || heizkosten===null) return {status:'insufficient_data',...common};
  const grossCold=Math.round((kaltmiete+betriebskosten)*100)/100;
  if (grossCold>resolved.rule.grossColdLimit) return {status:'over_limit',...common,grossCold};
  return {status:'within_guideline',...common,grossCold,areaAboveGuideline:areaSqm!==null&&areaSqm>resolved.rule.maxAreaSqm};
}
