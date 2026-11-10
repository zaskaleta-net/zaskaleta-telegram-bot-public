import { hamburgPlaceRoute } from './hamburg-place-names.mjs';

const freeze = value => Object.freeze(value);
const BASE_LIMITS = freeze({ 1:574.00, 2:697.80, 3:860.25, 4:1036.80, 5:1480.50, 6:1668.00 });

// Anlage 3 to the Hamburg §22 SGB II Fachanweisung, Stand 22.05.2026.
// In these Stadtteile an exceedance of the normal Bruttokaltmiete threshold by up to 10%
// is treated as angemessen under section 3.4. Keep this separate from the citywide base table.
export const HAMBURG_STADTTEIL_SURCHARGE_10 = freeze(new Set([
  'Allermöhe','Alsterdorf','Altengamme','Barmbek-Nord','Barmbek-Süd','Bergstedt','Blankenese','Duvenstedt','Eilbek','Eimsbüttel','Eppendorf','Francop','Groß Flottbek','HafenCity','Harvestehude','Hoheluft-Ost','Hoheluft-West','Hohenfelde','Iserbrook','Kirchwerder','Langenbek','Lemsahl-Mellingstedt','Lokstedt','Marienthal',
  'Marmstorf','Neuengamme','Neustadt','Niendorf','Nienstedten','Ochsenwerder','Ohlsdorf','Othmarschen','Ottensen','Poppenbüttel','Reitbrook','Rissen','Rönneburg','Rotherbaum','Sasel','Spadenland','Sülldorf','Tatenberg','Uhlenhorst','Volksdorf','Wellingsbüttel','Winterhude','Wohldorf-Ohlstedt'
]));

export const HAMBURG_KDU_REGISTRY = freeze({
  id:'hamburg-kdu-2026-04-28',
  authority:'Jobcenter team.arbeit.hamburg',
  jurisdiction:'Hamburg',
  validFrom:'2026-04-28',
  verifiedOn:'2026-09-11',
  costMeasure:'Bruttokaltmiete inklusive Betriebskosten und Wasserkosten, ohne Heizkosten',
  heatingRule:'Angemessene Heizkosten werden gesondert übernommen und geprüft.',
  areaPolicy:'no_general_area_limit_in_published_bkm_table',
  areaNoteUk:'📍 Регіон: Hamburg (Гамбург) — окрема федеральна земля (Freie und Hansestadt Hamburg). Це НЕ Schleswig-Holstein.\nОфіційна гамбурзька таблиця Angemessenheitsgrenzen від 28.04.2026 публікує грошові межі Bruttokaltmiete, а не загальну окрему межу площі для звичайного вільного житла.',
  limits:BASE_LIMITS,
  extraAfter:6,
  extraCost:208.50,
  cityDistrictSurchargePercent:10,
  sources:freeze([
    freeze({ type:'official-kdu-table', url:'https://dokumente.hamburg.de/resource/blob/46624/dd3a3e0888e4d0eb45e3f23f6f480892/fa-sgbii-22-kdu-14-angemessenheitsgrenzen-infoblatt-data.pdf' }),
    freeze({ type:'official-sgbii-guidance', url:'https://www.hamburg.de/politik-und-verwaltung/behoerden/sozialbehoerde/rechtliche-grundlagen/infoline/fachliche-vorgaben-und-hinweise/sgb-ii-grundsicherung-fuer-arbeitsuchende/fa-sgbii-22-kdu-45744' })
  ])
});

function money(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) && number >= 0 && number <= 50000 ? Math.round(number * 100) / 100 : null;
}

function baseLimit(persons) {
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20) return null;
  if (BASE_LIMITS[persons]) return BASE_LIMITS[persons];
  return Math.round((BASE_LIMITS[6] + (persons - 6) * HAMBURG_KDU_REGISTRY.extraCost) * 100) / 100;
}

export function resolveHamburgRule(location, householdSize) {
  const route = hamburgPlaceRoute(location);
  if (!route) return null;
  const persons = Number(householdSize);
  const base = baseLimit(persons);
  if (base === null) return { status:'unsupported_or_invalid', jurisdiction:'Hamburg', module:HAMBURG_KDU_REGISTRY, rule:null };

  const specificStadtteil = route.canonical !== 'Hamburg' && Boolean(route.borough);
  const surcharge = specificStadtteil && HAMBURG_STADTTEIL_SURCHARGE_10.has(route.canonical) ? 10 : 0;
  const grossColdLimit = Math.round(base * (1 + surcharge / 100) * 100) / 100;
  const zoneLabel = route.canonical === 'Hamburg' ? 'Hamburg' : `${route.canonical}${route.borough ? ` · Bezirk ${route.borough}` : ''}`;
  return {
    status:'verified', jurisdiction:'Hamburg', module:HAMBURG_KDU_REGISTRY,
    rule:freeze({
      registryId:HAMBURG_KDU_REGISTRY.id,
      jurisdiction:'Hamburg', authority:HAMBURG_KDU_REGISTRY.authority,
      householdSize:persons, grossColdLimit, baseGrossColdLimit:base, maxAreaSqm:null,
      validFrom:HAMBURG_KDU_REGISTRY.validFrom, verifiedCurrentOn:HAMBURG_KDU_REGISTRY.verifiedOn,
      costMeasure:HAMBURG_KDU_REGISTRY.costMeasure, heatingRule:HAMBURG_KDU_REGISTRY.heatingRule,
      zoneLabel, borough:route.borough || null, stadtteil:route.borough ? route.canonical : null,
      surchargePercent:surcharge,
      surchargeNoteUk:surcharge ? 'Для цього Stadtteil гамбурзька Fachanweisung дозволяє перевищення базової Angemessenheitsgrenze до 10% як angemessen.' : null,
      sourceUrl:HAMBURG_KDU_REGISTRY.sources[0].url
    })
  };
}

export function evaluateHamburgHousing(input = {}) {
  const resolved = resolveHamburgRule(input.location, Number(input.householdSize));
  if (!resolved || resolved.status !== 'verified') return resolved || { status:'unknown_jurisdiction', jurisdiction:null, module:null, rule:null };
  const kaltmiete = money(input.kaltmiete);
  const betriebskosten = money(input.betriebskosten);
  const heizkosten = money(input.heizkosten);
  const areaSqm = money(input.areaSqm);
  const common = { module:resolved.module, rule:resolved.rule, kaltmiete, betriebskosten, heizkosten, areaSqm };
  if (kaltmiete === null || betriebskosten === null || heizkosten === null) return { status:'insufficient_data', ...common };
  const grossCold = Math.round((kaltmiete + betriebskosten) * 100) / 100;
  if (grossCold > resolved.rule.grossColdLimit) return { status:'over_limit', ...common, grossCold };
  return { status:'within_guideline', ...common, grossCold };
}
