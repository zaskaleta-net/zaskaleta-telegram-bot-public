import {
  STORMARN_KDU_REGISTRY,
  evaluateStormarnHousing,
  stormarnRuleFor
} from './jobcenter-rules.mjs';
import {
  DITHMARSCHEN_KDU_REGISTRY,
  evaluateDithmarschenHousing,
  resolveDithmarschenRule
} from './jobcenter-rules-dithmarschen.mjs';
import {
  SH_REGIONAL_KDU_MODULES,
  SH_REGIONAL_JURISDICTIONS,
  resolveRegionalJobcenterRule
} from './jobcenter-rules-sh-regions.mjs';
import {
  SEGEBERG_KDU_REGISTRY,
  evaluateSegebergHousing,
  resolveSegebergRule
} from './jobcenter-rules-segeberg.mjs';
import {
  jobcenterModuleForJurisdiction,
  normalizeSchleswigHolsteinJurisdiction
} from './jobcenter-jurisdictions.mjs';

const freezeLimits = limits => Object.freeze(
  Object.fromEntries(Object.entries(limits).map(([persons, value]) => [persons, Object.freeze(value)]))
);

const KIEL = Object.freeze({
  id: 'jobcenter-kiel-kdu-2025-01-01', authority: 'Jobcenter Kiel', jurisdiction: 'Kiel',
  validFrom: '2025-01-01', verifiedOn: '2026-09-10',
  costMeasure: 'Bruttokaltmiete (Grundmiete + Betriebskosten, ohne Heizkosten)',
  heatingRule: 'Heizkosten kommen zusätzlich hinzu und werden gesondert geprüft.', areaPolicy:'orientation_only',
  limits: freezeLimits({1:[474.50,50],2:[545.00,60],3:[679.00,75],4:[815.50,90],5:[949.50,105],6:[1040.00,115],7:[1130.50,125]}),
  extraAfter:7, extraCost:90.40, extraArea:10,
  sources:Object.freeze([Object.freeze({type:'official-kdu',url:'https://www.jobcenter-kiel.de/geldleistungen/'})])
});

const FLENSBURG = Object.freeze({
  id:'jobcenter-flensburg-kdu-2025-07-01', authority:'Jobcenter Flensburg', jurisdiction:'Flensburg',
  validFrom:'2025-07-01', verifiedOn:'2026-09-10',
  costMeasure:'Kaltmiete inklusive Betriebskosten (ohne Heizkosten)',
  heatingRule:'Heizkosten werden zusätzlich grundsätzlich in tatsächlicher Höhe berücksichtigt; bei unwirtschaftlichem Verhalten kann eine Begrenzung erfolgen.',
  areaPolicy:'orientation_only', minimumBetriebskostenPerSqm:1.50,
  limits:freezeLimits({1:[486.00,50],2:[540.00,60],3:[661.00,75],4:[772.00,90],5:[929.00,105]}),
  extraAfter:5, extraCost:89.00, extraArea:10,
  sources:Object.freeze([Object.freeze({type:'official-kdu',url:'https://jobcenter-flensburg.de/geld/kosten-der-unterkunft/'})])
});

const LUEBECK = Object.freeze({
  id:'jobcenter-luebeck-kdu-2026-05-01', authority:'Jobcenter Lübeck', jurisdiction:'Lübeck',
  validFrom:'2026-05-01', verifiedOn:'2026-09-10',
  costMeasure:'Bruttokaltmiete (Nettokaltmiete + Betriebskosten, ohne Heizkosten)',
  heatingRule:'Kosten der Heizung werden gesondert geprüft.', areaPolicy:'orientation_only',
  limits:freezeLimits({1:[606.00,50],2:[680.00,60],3:[807.00,75],4:[923.00,85],5:[1071.00,95],6:[1186.00,105]}),
  higherHouseholdPolicy:'individual_review',
  sources:Object.freeze([
    Object.freeze({type:'official-kdu',url:'https://www.jobcenter-luebeck.de/geldleistungen/zuzug_umzug/index.html'}),
    Object.freeze({type:'official-housing-info',url:'https://www.jobcenter-luebeck.de/geldleistungen/wohnen/index.html'})
  ])
});

export const SH_VERIFIED_KDU_MODULES = Object.freeze({
  Stormarn: STORMARN_KDU_REGISTRY,
  Dithmarschen: DITHMARSCHEN_KDU_REGISTRY,
  ...SH_REGIONAL_KDU_MODULES,
  Segeberg: SEGEBERG_KDU_REGISTRY,
  Kiel: KIEL,
  Flensburg: FLENSBURG,
  Lübeck: LUEBECK
});

function money(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) && number >= 0 && number <= 50000 ? Math.round(number * 100) / 100 : null;
}

function flatRule(module, householdSize) {
  const persons=Number(householdSize);
  if (!Number.isSafeInteger(persons) || persons<1 || persons>20) return {status:'unsupported_or_invalid',module,rule:null};
  const direct=module.limits?.[persons];
  if (direct) return {status:'verified',jurisdiction:module.jurisdiction,module,rule:Object.freeze({
    registryId:module.id,jurisdiction:module.jurisdiction,authority:module.authority,householdSize:persons,
    grossColdLimit:direct[0],maxAreaSqm:direct[1],validFrom:module.validFrom,costMeasure:module.costMeasure,
    heatingRule:module.heatingRule,sourceUrl:module.sources[0].url
  })};
  if (module.extraAfter && persons>module.extraAfter) {
    const base=module.limits[module.extraAfter], extra=persons-module.extraAfter;
    return {status:'verified',jurisdiction:module.jurisdiction,module,rule:Object.freeze({
      registryId:module.id,jurisdiction:module.jurisdiction,authority:module.authority,householdSize:persons,
      grossColdLimit:Math.round((base[0]+module.extraCost*extra)*100)/100,maxAreaSqm:base[1]+module.extraArea*extra,
      validFrom:module.validFrom,costMeasure:module.costMeasure,heatingRule:module.heatingRule,sourceUrl:module.sources[0].url
    })};
  }
  return {status:'individual_review',jurisdiction:module.jurisdiction,module,rule:null};
}

function stormarnResolved(location,householdSize) {
  const rule=stormarnRuleFor(location,householdSize);
  if (!rule) return null;
  return {status:'verified',jurisdiction:'Stormarn',module:STORMARN_KDU_REGISTRY,rule:Object.freeze({...rule,jurisdiction:'Stormarn',authority:STORMARN_KDU_REGISTRY.authority})};
}

export function resolveJobcenterRule(location,householdSize) {
  const stormarn=stormarnResolved(location,householdSize);
  if (stormarn) return stormarn;
  const dithmarschen=resolveDithmarschenRule(location,householdSize);
  if (dithmarschen) return dithmarschen;
  const segeberg=resolveSegebergRule(location,householdSize);
  if (segeberg) return segeberg;
  const regional=resolveRegionalJobcenterRule(location,householdSize);
  if (regional) return regional;

  const jurisdiction=normalizeSchleswigHolsteinJurisdiction(location);
  if (!jurisdiction) return {status:'unknown_jurisdiction',jurisdiction:null,module:null,rule:null};
  const module=SH_VERIFIED_KDU_MODULES[jurisdiction];
  if (!module) {
    const metadata = jobcenterModuleForJurisdiction(jurisdiction);
    return { ...metadata, status: metadata.status === 'verified' ? 'not_yet_mapped' : metadata.status, rule:null };
  }
  if (jurisdiction==='Stormarn' || jurisdiction==='Dithmarschen' || jurisdiction==='Segeberg' || SH_REGIONAL_JURISDICTIONS.includes(jurisdiction)) {
    return {status:'not_yet_mapped',jurisdiction,module,rule:null};
  }
  return flatRule(module,householdSize);
}

function evaluateFlat(resolved,input) {
  const {module,rule}=resolved;
  const kaltmiete=money(input.kaltmiete), betriebskosten=money(input.betriebskosten), heizkosten=money(input.heizkosten), area=money(input.areaSqm);
  if (kaltmiete===null || betriebskosten===null || heizkosten===null) return {status:'insufficient_data',module,rule,kaltmiete,betriebskosten,heizkosten,areaSqm:area};
  const grossCold=Math.round((kaltmiete+betriebskosten)*100)/100;
  if (grossCold>rule.grossColdLimit) return {status:'over_limit',module,rule,kaltmiete,betriebskosten,heizkosten,grossCold,areaSqm:area};
  if (module.minimumBetriebskostenPerSqm) {
    if (area===null || area<=0) return {status:'needs_review',reason:'area_required_for_betriebskosten_check',module,rule,kaltmiete,betriebskosten,heizkosten,grossCold,areaSqm:area};
    if (betriebskosten/area<module.minimumBetriebskostenPerSqm) return {status:'needs_review',reason:'betriebskosten_below_published_minimum',module,rule,kaltmiete,betriebskosten,heizkosten,grossCold,areaSqm:area};
  }
  return {status:'within_guideline',module,rule,kaltmiete,betriebskosten,heizkosten,grossCold,areaSqm:area,areaAboveGuideline:area!==null&&Number.isFinite(Number(rule.maxAreaSqm))&&area>rule.maxAreaSqm};
}

export function evaluateJobcenterHousing(input={}) {
  const resolved=resolveJobcenterRule(input.location,Number(input.householdSize));
  if (!resolved || resolved.status!=='verified') return resolved || {status:'unknown_jurisdiction',jurisdiction:null,module:null,rule:null};
  if (resolved.module.id===STORMARN_KDU_REGISTRY.id) return {...evaluateStormarnHousing(input),module:STORMARN_KDU_REGISTRY};
  if (resolved.module.id===DITHMARSCHEN_KDU_REGISTRY.id) return evaluateDithmarschenHousing(input);
  if (resolved.module.id===SEGEBERG_KDU_REGISTRY.id) return evaluateSegebergHousing(input);
  return evaluateFlat(resolved,input);
}

