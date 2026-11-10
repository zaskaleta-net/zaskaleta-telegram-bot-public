import {
  SH_VERIFIED_KDU_MODULES as BASE_MODULES,
  evaluateJobcenterHousing as evaluateBase,
  resolveJobcenterRule as resolveBase
} from './jobcenter-registry.mjs';
import { SH_ADMINISTRATIVE_AREAS } from './jobcenter-jurisdictions.mjs';
import { SCHLESWIG_FLENSBURG_KDU_REGISTRY as SLFL } from './jobcenter-rules-schleswig-flensburg.mjs';
import {
  PINNEBERG_KDU_REGISTRY as PINNEBERG,
  evaluatePinnebergHousing,
  resolvePinnebergRule
} from './jobcenter-rules-pinneberg.mjs';
import { resolveOstholsteinRule, evaluateOstholsteinHousing, OSTHOLSTEIN_KDU_REGISTRY } from './jobcenter-rules-ostholstein.mjs';
import { placeRouteForJobcenter } from './schleswig-holstein-place-names.mjs';
import { hamburgPlaceRoute } from './hamburg-place-names.mjs';
import { HAMBURG_KDU_REGISTRY, evaluateHamburgHousing, resolveHamburgRule } from './jobcenter-rules-hamburg.mjs';
import { SH_RUNTIME_MUNICIPALITY_ROWS } from './sh-municipality-jurisdiction-runtime.mjs';
import { jobcenterRuleLocationForMunicipality } from './schleswig-holstein-jobcenter-route.mjs';

export const SH_VERIFIED_KDU_MODULES = Object.freeze({ ...BASE_MODULES, Pinneberg:PINNEBERG, 'Schleswig-Flensburg':SLFL, Ostholstein:OSTHOLSTEIN_KDU_REGISTRY });
export const SH_PENDING_KDU_TERRITORIES = Object.freeze({
  Neumünster:Object.freeze({authority:'Jobcenter Neumünster',status:'current-and-future-thresholds-need-direct-official-verification',futureChangeFrom:'2026-10-01',verifiedCurrentOn:'2026-09-11',sourceUrl:'https://session.neumuenster.de/bi/si0057.asp?__ksinr=8640',sourceLabel:'Порядок денний Ausschuss für Soziales und Gesundheit Stadt Neumünster від 09.09.2026',messageUk:'Stadt Neumünster оголосила нові межі витрат на житло (Neuregelung der Mietobergrenzen) з 01.10.2026 — так зазначено в порядку денному Ausschuss für Soziales und Gesundheit від 09.09.2026. Перевіреної офіційної таблиці з сумами в боті поки немає. Перед підписанням договору оренди уточніть межу для вашого домогосподарства в Jobcenter Neumünster.',note:'Official 09.09.2026 committee agenda announces new Mietobergrenzen from 01.10.2026 but does not publish the numerical table in the agenda item. Historic values are not used. TG-RUNTIME-073: the change is only announced (agenda Mitteilung, no table, no decision); the text no longer speaks of 01.10.2026 as the future and does not claim the limits are in force; the table is still not verified (owner check 24.10.2026: jobcenter-neumuenster.de unreachable from the build environment).'})
});
export const SH_KDU_CAVEATS = Object.freeze({ Kiel:Object.freeze({type:'court-interim-one-person-household',householdSize:1,publishedGrossColdLimit:474.50,interimCourtAmount:502.50,decisionDate:'2026-05-11',caseReference:'L 6 AS 175/25 B ER',sourceUrl:'https://www.schleswig-holstein.de/DE/justiz/gerichte-und-justizbehoerden/LSG/Presse/PI/2026/Mehr_Geld_fuer_Wohnung',noteUk:'Для 1-особового домогосподарства офіційна таблиця Jobcenter Kiel і далі публікує 474,50 € Bruttokaltmiete. 11.05.2026 Schleswig-Holsteinisches Landessozialgericht у конкретній справі в порядку einstweiliger Rechtsschutz вказав, що ця межа, ймовірно, занизька, та тимчасово зобов’язав врахувати 502,50 €. Це не автоматична загальна заміна нормативу для всіх заявників.'}) });
export const SH_STATEWIDE_KDU_COVERAGE = Object.freeze(Object.fromEntries(Object.entries(SH_ADMINISTRATIVE_AREAS).map(([jurisdiction,administrative])=>{const module=SH_VERIFIED_KDU_MODULES[jurisdiction]||null,pending=SH_PENDING_KDU_TERRITORIES[jurisdiction]||null;return[jurisdiction,Object.freeze({jurisdiction,...administrative,numericStatus:module?'verified':pending?'pending_direct_verification':'missing',authority:module?.authority||pending?.authority||null,validFrom:module?.validFrom??pending?.validFrom??null,futureChangeFrom:pending?.futureChangeFrom??null,sourceUrl:module?.sources?.[0]?.url||pending?.sourceUrl||null,caveat:SH_KDU_CAVEATS[jurisdiction]||null})]})));
export const EXTENDED_KDU_COVERAGE=Object.freeze({...SH_STATEWIDE_KDU_COVERAGE,Hamburg:Object.freeze({jurisdiction:'Hamburg',type:'city-state',state:'Hamburg',administrativeCenter:'Hamburg',numericStatus:'verified',authority:HAMBURG_KDU_REGISTRY.authority,validFrom:HAMBURG_KDU_REGISTRY.validFrom,sourceUrl:HAMBURG_KDU_REGISTRY.sources[0].url})});

function normalize(value){return String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/ß/g,'ss').toLowerCase().replace(/\s+/g,' ').trim();}
function isSchleswigFlensburg(value){const text=normalize(value);if(/schleswig[ -]flensburg/u.test(text))return true;if(/\bschleswig-holstein\b/u.test(text))return false;return/(?:^|\D)24837\s+schleswig(?:\D|$)/u.test(text)||/^schleswig(?:,|$)/u.test(text);}
function explicitKreisJurisdiction(value){const text=normalize(value);for(const jurisdiction of Object.keys(SH_STATEWIDE_KDU_COVERAGE)){const j=normalize(jurisdiction).replace(/-/g,'[ -]');if(new RegExp(`(?:^|[ -])kreis[ -]+${j}(?:$|[ -])`,'u').test(text))return jurisdiction;}return null;}
function routedLocation(value){const route=placeRouteForJobcenter(value);if(route?.ruleLocation)return route.ruleLocation.replace(/[-–—]+/g,' ');const hamburg=hamburgPlaceRoute(value);if(hamburg?.ruleLocation)return hamburg.ruleLocation;return value;}
function money(value){if(value===null||value===undefined||value==='')return null;const number=Number(String(value).replace(',','.'));return Number.isFinite(number)&&number>=0&&number<=50000?Math.round(number*100)/100:null;}
function slflRuleFor(persons){if(!Number.isSafeInteger(persons)||persons<1||persons>20)return null;const direct=SLFL.limits[persons],base=direct||SLFL.limits[SLFL.extraAfter],extra=direct?0:persons-SLFL.extraAfter;return Object.freeze({registryId:SLFL.id,jurisdiction:SLFL.jurisdiction,authority:SLFL.authority,householdSize:persons,grossColdLimit:Math.round((base[0]+SLFL.extraCost*extra)*100)/100,maxAreaSqm:base[1]+SLFL.extraArea*extra,validFrom:SLFL.validFrom,costMeasure:SLFL.costMeasure,heatingRule:SLFL.heatingRule,sourceUrl:SLFL.sources[0].url});}
function resolveSchleswigFlensburg(location,householdSize){if(!isSchleswigFlensburg(location))return null;const persons=Number(householdSize),rule=slflRuleFor(persons);return rule?{status:'verified',jurisdiction:SLFL.jurisdiction,module:SLFL,rule}:{status:'unsupported_or_invalid',jurisdiction:SLFL.jurisdiction,module:SLFL,rule:null};}
function enrichPending(resolved){const pending=resolved?.jurisdiction?SH_PENDING_KDU_TERRITORIES[resolved.jurisdiction]:null;return pending?{...resolved,pending}:resolved;}


// Exact lookup of a canonical municipality name in the pinned 1104-row statewide
// index. Runs before curated aliases, Hamburg Stadtteile and substring matching so a
// bare name can never be claimed by another Kreis or by Hamburg. A name that exists
// in several Kreise (or equals the name of a different Kreis) is never guessed.
function placeKey(value){return String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/gu,'').replace(/ß/gu,'ss').toLowerCase().replace(/[’ʼ'`´]/gu,'').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/gu,' ').trim();}
const SH_MUNICIPALITY_INDEX=(()=>{const index=new Map();for(const row of SH_RUNTIME_MUNICIPALITY_ROWS){const key=placeKey(row?.canonical);if(!key||!row.jurisdiction)continue;const bucket=index.get(key)||[];bucket.push(row);index.set(key,bucket);}return index;})();
const KREIS_NAME_KEYS=new Map(Object.keys(SH_STATEWIDE_KDU_COVERAGE).map(jurisdiction=>[placeKey(jurisdiction),jurisdiction]));
export function canonicalMunicipalityRoute(location){
  const key=placeKey(location);
  const rows=key?SH_MUNICIPALITY_INDEX.get(key):null;
  if(!rows?.length)return null;
  const routes=[...new Map(rows.map(row=>{const ruleLocation=jobcenterRuleLocationForMunicipality(row);return[`${row.jurisdiction}|${ruleLocation}`,{canonical:row.canonical,jurisdiction:row.jurisdiction,ruleLocation}];})).values()];
  const candidates=[...new Set(routes.map(route=>route.jurisdiction))];
  const kreis=KREIS_NAME_KEYS.get(key);
  if(kreis&&!candidates.includes(kreis))candidates.push(kreis);
  if(routes.length===1&&candidates.length===1)return Object.freeze({status:'routed',...routes[0]});
  return Object.freeze({status:'ambiguous',canonical:rows[0].canonical,candidates:Object.freeze(candidates.sort((a,b)=>a.localeCompare(b,'de')))});
}
function ambiguousMunicipality(route){return{status:'ambiguous_municipality',jurisdiction:null,module:null,rule:null,municipality:route.canonical,candidates:route.candidates};}

function resolveRoutedTarget(location,householdSize){
  const shRoute=placeRouteForJobcenter(location);
  const target=shRoute?.ruleLocation?shRoute.ruleLocation.replace(/[-–—]+/g,' '):routedLocation(location);
  const explicit=explicitKreisJurisdiction(target);
  if(explicit){
    if(explicit==='Ostholstein')return resolveOstholsteinRule(target,householdSize)||{status:'not_yet_mapped',jurisdiction:'Ostholstein',module:OSTHOLSTEIN_KDU_REGISTRY,rule:null};
    if(explicit==='Schleswig-Flensburg')return resolveSchleswigFlensburg(target,householdSize);
    if(explicit!=='Pinneberg')return enrichPending(resolveBase(target,householdSize));
  }
  if(!shRoute){const hamburg=resolveHamburgRule(location,householdSize);if(hamburg)return hamburg;}
  const ostholstein=resolveOstholsteinRule(target,householdSize);if(ostholstein)return ostholstein;
  const pinneberg=resolvePinnebergRule(target,householdSize);if(pinneberg)return pinneberg;
  const slfl=resolveSchleswigFlensburg(target,householdSize);if(slfl)return slfl;
  return enrichPending(resolveBase(target,householdSize));
}

export function resolveJobcenterRule(location,householdSize){
  const canonical=canonicalMunicipalityRoute(location);
  if(canonical?.status==='ambiguous')return ambiguousMunicipality(canonical);
  return resolveRoutedTarget(canonical?.ruleLocation||location,householdSize);
}

function evaluateSchleswigFlensburg(input={}){const resolved=resolveSchleswigFlensburg(input.location,Number(input.householdSize));if(!resolved||resolved.status!=='verified')return resolved;const kaltmiete=money(input.kaltmiete),betriebskosten=money(input.betriebskosten),heizkosten=money(input.heizkosten),areaSqm=money(input.areaSqm),common={module:resolved.module,rule:resolved.rule,kaltmiete,betriebskosten,heizkosten,areaSqm};if(kaltmiete===null||betriebskosten===null||heizkosten===null)return{status:'insufficient_data',...common};const grossCold=Math.round((kaltmiete+betriebskosten)*100)/100;if(grossCold>resolved.rule.grossColdLimit)return{status:'over_limit',...common,grossCold};return{status:'within_guideline',...common,grossCold,areaAboveGuideline:areaSqm!==null&&areaSqm>resolved.rule.maxAreaSqm};}
export function evaluateJobcenterHousing(input={}){
  const canonical=canonicalMunicipalityRoute(input.location);
  if(canonical?.status==='ambiguous')return ambiguousMunicipality(canonical);
  const location=canonical?.ruleLocation||input.location;
  const shRoute=placeRouteForJobcenter(location),target=shRoute?.ruleLocation?shRoute.ruleLocation.replace(/[-–—]+/g,' '):routedLocation(location),routedInput=target===input.location?input:{...input,location:target};
  const explicit=explicitKreisJurisdiction(target);
  if(explicit){const resolved=resolveRoutedTarget(target,Number(input.householdSize));if(!resolved||resolved.status!=='verified')return resolved;if(explicit==='Schleswig-Flensburg')return evaluateSchleswigFlensburg(routedInput);if(explicit==='Pinneberg')return evaluatePinnebergHousing(routedInput);if(explicit==='Ostholstein')return evaluateOstholsteinHousing(routedInput);return evaluateBase(routedInput);}
  if(!shRoute){const hamburg=resolveHamburgRule(location,Number(input.householdSize));if(hamburg)return hamburg.status==='verified'?evaluateHamburgHousing({...input,location}):hamburg;}
  const ostholstein=resolveOstholsteinRule(target,Number(input.householdSize));if(ostholstein)return ostholstein.status==='verified'?evaluateOstholsteinHousing(routedInput):ostholstein;
  const pinneberg=resolvePinnebergRule(target,Number(input.householdSize));if(pinneberg)return pinneberg.status==='verified'?evaluatePinnebergHousing(routedInput):pinneberg;
  if(isSchleswigFlensburg(target))return evaluateSchleswigFlensburg(routedInput);
  return enrichPending(evaluateBase(routedInput));
}
