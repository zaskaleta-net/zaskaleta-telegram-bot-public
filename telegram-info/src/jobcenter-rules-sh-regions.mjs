const freeze = value => Object.freeze(value);
const freezeLimits = values => freeze(values.map(value => value == null ? null : freeze(value)));
function normalize(value){return String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/ß/g,'ss').toLowerCase().replace(/\b\d{5}\b/g,' ').replace(/[-–—]+/g,' ').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();}
function hasAlias(location,alias){const key=normalize(alias);if(!key)return false;const escaped=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return new RegExp(`(?:^| )${escaped}(?:$| )`,'u').test(location);}
function moduleDef({id,authority,jurisdiction,validFrom,sources,zones}){return freeze({id,authority,jurisdiction,validFrom,verifiedOn:'2026-09-10',costMeasure:'Bruttokaltmiete (Nettokaltmiete/Kaltmiete + kalte Betriebskosten, ohne Heizkosten)',heatingRule:'Heizkosten werden separat auf Angemessenheit geprüft.',areaPolicy:'orientation_only',sources:freeze(sources.map(source=>freeze(source))),zones:freeze(zones.map(zone=>freeze({...zone,aliases:freeze(zone.aliases),limits:freezeLimits(zone.limits)})))});}
const HERZOGTUM_LAUENBURG=moduleDef({id:'jobcenter-herzogtum-lauenburg-kdu-2025-03-01',authority:'Jobcenter Herzogtum Lauenburg',jurisdiction:'Herzogtum Lauenburg',validFrom:'2025-03-01',sources:[{type:'official-kdu',url:'https://www.jobcenter-herzogtum-lauenburg.de/media/48/download/%C3%9Cbersicht%20Mietobergrenzen.pdf?v=1'}],zones:[
{id:'vr1',label:'Vergleichsraum 1',aliases:['berkenthin','breitenfelde','lauenburgische seen','sandesneben'],limits:[[464.50,50],[572.40,60],[685.50,75],[784.80,90],[880.95,105]],extraBaseCost:860.20,extraCost:103.40,extraAfter:5,extraArea:10},
{id:'vr2',label:'Ratzeburg',aliases:['ratzeburg'],limits:[[501.60,50],[606.10,60],[722.70,75],[842.60,90],[962.50,105]],extraBaseCost:962.50,extraCost:116.60,extraAfter:5,extraArea:10},
{id:'vr3',label:'Mölln',aliases:['molln'],limits:[[501.60,50],[606.10,60],[722.70,75],[842.60,90],[962.50,105]],extraBaseCost:962.50,extraCost:116.60,extraAfter:5,extraArea:10},
{id:'vr4',label:'Schwarzenbek-Land / Büchen',aliases:['schwarzenbek land','buchen'],limits:[[470.50,50],[550.20,60],[693.00,75],[838.80,90],[924.00,105]],extraBaseCost:860.20,extraCost:103.40,extraAfter:5,extraArea:10},
{id:'vr5',label:'Schwarzenbek',aliases:['schwarzenbek'],limits:[[562.10,50],[680.90,60],[810.70,75],[943.80,90],[1099.35,105]],extraBaseCost:1080.20,extraCost:130.90,extraAfter:5,extraArea:10},
{id:'vr6-hohe-elbgeest',label:'Amt Hohe Elbgeest',aliases:['amt hohe elbgeest','hohe elbgeest'],limits:[[484,50],[620.40,60],[787.50,75],[954,90],[1113,105]],extraBaseCost:860.20,extraCost:103.40,extraAfter:5,extraArea:10},
{id:'vr6-wentorf',label:'Gemeinde Wentorf',aliases:['wentorf bei hamburg','gemeinde wentorf','wentorf'],limits:[[676.50,50],[819.50,60],[975.70,75],[1138.50,90],[1301.30,105]],extraBaseCost:1301.30,extraCost:163.90,extraAfter:5,extraArea:10},
{id:'vr7',label:'Geesthacht',aliases:['geesthacht'],limits:[[618.20,50],[748,60],[889.90,75],[1040.60,90],[1188,105]],extraBaseCost:1188,extraCost:141.90,extraAfter:5,extraArea:10},
{id:'vr8-lauenburg',label:'Stadt Lauenburg',aliases:['stadt lauenburg','lauenburg elbe','lauenburg'],limits:[[562.10,50],[680.90,60],[810.70,75],[943.80,90],[1080.20,105]],extraBaseCost:1080.20,extraCost:130.90,extraAfter:5,extraArea:10},
{id:'vr8-lutau',label:'Amt Lütau',aliases:['amt lutau','lutau'],limits:[[450.50,50],[542.30,60],[672,75],[760.50,90],[860.20,105]],extraBaseCost:860.20,extraCost:103.40,extraAfter:5,extraArea:10}]});
const NORDFRIESLAND=moduleDef({id:'jobcenter-nordfriesland-kdu-2026-01-01',authority:'Kreis Nordfriesland Fachdienst Jobcenter',jurisdiction:'Nordfriesland',validFrom:'2026-01-01',sources:[{type:'official-kdu',url:'https://jobcenter.nordfriesland.de/loadDocument.phtml?Ext=PDF&FID=3773.125.1'},{type:'official-kdu-page',url:'https://jobcenter.nordfriesland.de/Leistungen/Kosten-der-Unterkunft-/'}],zones:[
{id:'nord',label:'Mietpreisregion Nord',aliases:['amt sudtondern','sudtondern','amt mittleres nordfriesland','mittleres nordfriesland'],limits:[[495,50],[584,60],[742,75],[860,90],[999,105],[1078,115],null,null],individualReviewFrom:7},
{id:'sud',label:'Mietpreisregion Süd',aliases:['husum','tonning','reussenkoge','amt eiderstedt','eiderstedt','amt nordsee treene','nordsee treene','amt pellworm','pellworm','amt viol','viol'],limits:[[515,50],[614,60],[768,75],[921,90],[1099,105],[1193,115],[1237,125],[1356,135]],extraBaseCost:1356,extraCost:105,extraAfter:8,extraArea:10},
{id:'sylt',label:'Mietpreisregion Sylt',aliases:['sylt'],limits:[[618,50],[748,60],[890,75],[1041,90],[1188,105],[1330,115],[1472,125],[1614,135]],extraBaseCost:1614,extraCost:142,extraAfter:8,extraArea:10},
{id:'fohr-amrum',label:'Mietpreisregion Amrum und Föhr',aliases:['amrum','fohr','fohr amrum'],limits:[[618,50],[748,60],[890,75],[1041,90],[1188,105],[1330,115],[1472,125],[1614,135]],extraBaseCost:1614,extraCost:142,extraAfter:8,extraArea:10}]});
const PLOEN=moduleDef({id:'jobcenter-ploen-kdu-2026-01-01',authority:'Jobcenter Kreis Plön',jurisdiction:'Plön',validFrom:'2026-01-01',sources:[{type:'official-kdu',url:'https://www.jobcenter-kreis-ploen.de/pdf/2026-01-mog-jc-kreis-ploen.pdf'}],zones:[
{id:'nord',label:'Vergleichsraum I – Nord',aliases:['amt schrevenborn','schrevenborn','amt probstei','probstei','amt preetz land','preetz land'],limits:[[530,50],[650,60],[830,75],[990,90],[1140,105]],individualReviewFrom:6},
{id:'west',label:'Vergleichsraum II – West',aliases:['stadt preetz','preetz','stadt schwentinental','schwentinental'],limits:[[520,50],[620,60],[800,75],[890,90],[1070,105]],individualReviewFrom:6},
{id:'ost',label:'Vergleichsraum III – Ost',aliases:['amt grosser ploner see','grosser ploner see','amt bokhorst wankendorf','bokhorst wankendorf','amt lutjenburg','lutjenburg','ascheberg holstein','gemeinde ascheberg','amt selent schlesen','selent schlesen','bosdorf','stadt plon','plon'],limits:[[480,50],[570,60],[680,75],[800,90],[940,105]],individualReviewFrom:6}]});
const STEINBURG=moduleDef({id:'jobcenter-steinburg-kdu-2025-07-01',authority:'Jobcenter Steinburg',jurisdiction:'Steinburg',validFrom:'2025-07-01',sources:[{type:'official-kdu',url:'https://jobcenter-steinburg.de/navigation/mietobergrenze/'}],zones:[
{id:'itzehoe',label:'Stadt Itzehoe',aliases:['stadt itzehoe','itzehoe'],limits:[[501.60,50],[606.10,60],[722.70,75],[842.60,90],[962.50,105]],extraBaseCost:962.50,extraCost:116.60,extraAfter:5,extraArea:10},
{id:'rest',label:'Übriger veröffentlichter Bereich',aliases:['stadt gluckstadt','gluckstadt','amt breitenburg','breitenburg','amt itzehoe land','itzehoe land','amt horst herzhorn','horst herzhorn','amt kellinghusen','kellinghusen','amt krempermarsch','krempermarsch','amt wilstermarsch','wilstermarsch','stadt wilster','wilster'],limits:[[448.80,50],[542.30,60],[645.70,75],[754.60,90],[860.20,105]],extraBaseCost:860.20,extraCost:103.40,extraAfter:5,extraArea:10},
{id:'rest-schenefeld',label:'Amt Schenefeld',aliases:['amt schenefeld','schenefeld steinburg'],limits:[[448.80,50],[542.30,60],[645.70,75],[754.60,90],[860.20,105]],extraBaseCost:860.20,extraCost:103.40,extraAfter:5,extraArea:10}]});
const RENDSBURG_ECKERNFOERDE=moduleDef({id:'jobcenter-rendsburg-eckernfoerde-kdu-2026-07-01',authority:'Jobcenter Kreis Rendsburg-Eckernförde',jurisdiction:'Rendsburg-Eckernförde',validFrom:'2026-07-01',sources:[{type:'official-kdu',url:'https://www.kreis-rendsburg-eckernfoerde.de/fileadmin/download/Familie_und_Soziales/Lebensunterhaltsleistungen/Richtwerte_Brutto-Kaltmiete_ab_01072026.pdf'},{type:'official-zone-map',url:'https://www.kreis-rendsburg-eckernfoerde.de/fileadmin/download/Familie_und_Soziales/Lebensunterhaltsleistungen/Vergleichsraeume_und_Kommunen_Kreis_Rendsburg_Stand_02062026.pdf'}],zones:[
{id:'vr1',label:'Vergleichsraum I – Rendsburg und Umland',aliases:['stadt budelsdorf','budelsdorf','stadt rendsburg','rendsburg','amt eiderkanal','eiderkanal','amt fockbek','fockbek','amt hohner harde','hohner harde','amt jevenstedt','jevenstedt'],limits:[[468.50,50],[531.60,60],[645.75,75],[784.80,90],[961.80,105]],extraBaseCost:961.80,extraCost:91.60,extraAfter:5,extraArea:10},
{id:'vr2',label:'Vergleichsraum II – Umland Kiel',aliases:['amt achterwehr','achterwehr','amt danischenhagen','danischenhagen','amt danischer wohld','danischer wohld','amt eidertal','eidertal','gemeinde altenholz','altenholz','gemeinde kronshagen','kronshagen'],limits:[[502.50,50],[589.80,60],[766.50,75],[949.50,90],[1176,105]],extraBaseCost:1176,extraCost:112,extraAfter:5,extraArea:10},
{id:'vr3',label:'Vergleichsraum III – Eckernförde und Umland',aliases:['stadt eckernforde','eckernforde','amt huttener berge','huttener berge','amt schlei ostsee','schlei ostsee'],limits:[[480.50,50],[603,60],[726.75,75],[908.10,90],[1098.30,105]],extraBaseCost:1098.30,extraCost:104.60,extraAfter:5,extraArea:10},
{id:'vr4',label:'Vergleichsraum IV – Umland Neumünster',aliases:['amt bordesholm','bordesholm','amt mittelholstein','mittelholstein','amt nortorfer land','nortorfer land','stadt nortorf','nortorf','gemeinde wasbek','wasbek'],limits:[[476,50],[531,60],[660.75,75],[796.50,90],[1015.35,105]],extraBaseCost:1015.35,extraCost:96.70,extraAfter:5,extraArea:10}]});
export const SH_REGIONAL_KDU_MODULES=freeze({'Herzogtum Lauenburg':HERZOGTUM_LAUENBURG,'Nordfriesland':NORDFRIESLAND,'Plön':PLOEN,'Rendsburg-Eckernförde':RENDSBURG_ECKERNFOERDE,'Steinburg':STEINBURG});
export const SH_REGIONAL_JURISDICTIONS=freeze(Object.keys(SH_REGIONAL_KDU_MODULES));
const AMBIGUOUS=freeze({'Herzogtum Lauenburg':new Set(['herzogtum lauenburg','kreis herzogtum lauenburg']),'Nordfriesland':new Set(['nordfriesland','kreis nordfriesland']),'Plön':new Set(['kreis plon']),'Rendsburg-Eckernförde':new Set(['rendsburg eckernforde','kreis rendsburg eckernforde']),'Steinburg':new Set(['steinburg','kreis steinburg','schenefeld'])});
function buildRule(module,zone,persons){if(zone.individualReviewFrom&&persons>=zone.individualReviewFrom)return{status:'individual_review',jurisdiction:module.jurisdiction,module,rule:null,zone:zone.id};const direct=zone.limits[persons-1];if(direct)return{status:'verified',jurisdiction:module.jurisdiction,module,rule:freeze({registryId:module.id,jurisdiction:module.jurisdiction,authority:module.authority,zone:zone.id,zoneLabel:zone.label,householdSize:persons,grossColdLimit:direct[0],maxAreaSqm:direct[1],validFrom:module.validFrom,costMeasure:module.costMeasure,heatingRule:module.heatingRule,sourceUrl:module.sources[0].url})};if(zone.extraAfter&&persons>zone.extraAfter&&zone.extraCost!=null&&zone.extraBaseCost!=null){const extra=persons-zone.extraAfter;return{status:'verified',jurisdiction:module.jurisdiction,module,rule:freeze({registryId:module.id,jurisdiction:module.jurisdiction,authority:module.authority,zone:zone.id,zoneLabel:zone.label,householdSize:persons,grossColdLimit:Math.round((zone.extraBaseCost+zone.extraCost*extra)*100)/100,maxAreaSqm:zone.limits[zone.extraAfter-1][1]+(zone.extraArea||10)*extra,validFrom:module.validFrom,costMeasure:module.costMeasure,heatingRule:module.heatingRule,sourceUrl:module.sources[0].url})};}return{status:'individual_review',jurisdiction:module.jurisdiction,module,rule:null,zone:zone.id};}
function bestZone(module,location){let best=null,bestLength=0;for(const zone of module.zones){for(const alias of zone.aliases){const length=normalize(alias).length;if(length>bestLength&&hasAlias(location,alias)){best=zone;bestLength=length;}}}return best;}
function explicitRegionalKreisScope(location){
  for(const jurisdiction of SH_REGIONAL_JURISDICTIONS){
    const suffix=`kreis ${normalize(jurisdiction)}`;
    if(location===suffix)return{jurisdiction,scope:''};
    const marker=` ${suffix}`;
    if(location.endsWith(marker))return{jurisdiction,scope:location.slice(0,-marker.length).trim()};
  }
  return null;
}
export function resolveRegionalJobcenterRule(value,householdSize){
  const persons=Number(householdSize);
  if(!Number.isSafeInteger(persons)||persons<1||persons>20)return null;
  const location=normalize(value);
  if(!location)return null;
  if(location==='schenefeld')return{status:'ambiguous_location',jurisdiction:null,module:null,rule:null};

  const explicit=explicitRegionalKreisScope(location);
  if(explicit){
    const module=SH_REGIONAL_KDU_MODULES[explicit.jurisdiction];
    if(!explicit.scope)return{status:'not_yet_mapped',jurisdiction:explicit.jurisdiction,module,rule:null};
    const zone=bestZone(module,explicit.scope);
    if(zone)return buildRule(module,zone,persons);
    return{status:'not_yet_mapped',jurisdiction:explicit.jurisdiction,module,rule:null};
  }

  for(const[jurisdiction,module]of Object.entries(SH_REGIONAL_KDU_MODULES)){
    if(AMBIGUOUS[jurisdiction]?.has(location))return{status:'not_yet_mapped',jurisdiction,module,rule:null};
    const zone=bestZone(module,location);
    if(zone)return buildRule(module,zone,persons);
  }
  return null;
}
