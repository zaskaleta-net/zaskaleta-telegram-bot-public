import { roomSpecFromCriteria, roomValueInSpec } from './rooms.mjs';

const MAX_HTML_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 5000;

export const PUBLIC_LIVE_HOUSING_SOURCES = Object.freeze([
  Object.freeze({ id:'wankendorfer', label:'Wankendorfer', url:'https://www.wankendorfer.de/wohnungssuche/', host:/^(?:www\.)?wankendorfer\.de$/i, priceType:'Gesamtmiete', locations:null }),
  Object.freeze({ id:'wobau-neumuenster', label:'WOBAU Neumünster', url:'https://www.wobau-neumuenster.de/mieten/mietangebote', host:/^(?:www\.)?wobau-neumuenster\.de$/i, priceType:'Warmmiete', locations:['neumünster','neumuenster'] }),
  Object.freeze({ id:'fab', label:'FAB Flensburg', url:'https://www.fab.sh/main/aktuelle-wohnungsangebote/', host:/^(?:www\.)?fab\.sh$/i, priceType:'Gesamtmiete/Angebotspreis', locations:['flensburg','harrislee'] }),
  Object.freeze({ id:'wbg-kiel-ost', label:'WBG Kiel-Ost', url:'https://www.wbg-kiel-ost.de/mieten/objekte/mietwohnungen.html', host:/^(?:www\.)?wbg-kiel-ost\.de$/i, priceType:'Gesamtmiete', locations:['kiel'] }),
  Object.freeze({ id:'luebecker-bauverein', label:'Lübecker Bauverein', url:'https://www.luebecker-bauverein.de/angebotsfinder.html', host:/^(?:www\.)?luebecker-bauverein\.de$/i, priceType:'Gesamtmiete', locations:['lübeck','lubeck','bad schwartau','stockelsdorf','selmsdorf','schönberg','schoenberg','rehna','dassow'] }),
  Object.freeze({ id:'wobau-ostholstein', label:'WOBAU Ostholstein', url:'https://www.wobau-oh.de/wohnung-mieten-ostholstein.php', host:/^(?:www\.)?wobau-oh\.de$/i, priceType:'Kaltmiete', locations:null }),
  Object.freeze({ id:'wodi-dithmarschen', label:'Wohnungsunternehmen Dithmarschen', url:'https://www.wo-di.de/wohnen.html', host:/^(?:www\.)?wo-di\.de$/i, priceType:'Kaltmiete', locations:null }),
  Object.freeze({ id:'trave-luebeck', label:'TRAVE Lübeck', url:'https://www.trave.de/interessenten/wohnung-mieten', host:/^(?:www\.)?trave\.de$/i, priceType:'Bruttokaltmiete', locations:['lübeck','lubeck'] })
]);

function decodeHtml(value) {
  const named=new Map([['amp','&'],['quot','"'],['apos',"'"],['lt','<'],['gt','>'],['nbsp',' '],['auml','ä'],['Auml','Ä'],['ouml','ö'],['Ouml','Ö'],['uuml','ü'],['Uuml','Ü'],['szlig','ß']]);
  return String(value||'')
    .replace(/&([a-zA-Z]+);/g,(all,name)=>named.has(name)?named.get(name):all)
    .replace(/&#(\d+);/g,(all,number)=>{const code=Number(number);return Number.isInteger(code)&&code>=0&&code<=0x10ffff?String.fromCodePoint(code):all;})
    .replace(/&#x([0-9a-f]+);/gi,(all,number)=>{const code=Number.parseInt(number,16);return Number.isInteger(code)&&code>=0&&code<=0x10ffff?String.fromCodePoint(code):all;});
}

function htmlLines(html) {
  const cleaned=String(html||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<(?:br|\/p|\/div|\/li|\/article|\/section|\/h[1-6]|\/tr|\/td|\/dt|\/dd)\b[^>]*>/gi,'\n').replace(/<[^>]+>/g,' ');
  return decodeHtml(cleaned).split(/\n+/).map(line=>line.replace(/\s+/g,' ').trim()).filter(Boolean);
}

function deNumber(value) { let text=String(value??'').replace(/\s/g,'').replace(/€/g,''); if(!text)return null; if(text.includes(','))text=text.replace(/\./g,'').replace(',','.'); const number=Number(text); return Number.isFinite(number)?number:null; }
function euroFromLine(line) { const match=String(line||'').match(/(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:€|EUR)/iu); return match?deNumber(match[1]):null; }
function decimalFromLine(line) { const match=String(line||'').match(/\d{1,4}(?:[.,]\d{1,2})?/u); return match?deNumber(match[0]):null; }
function normalize(value) { return String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/ß/g,'ss').toLowerCase().replace(/\b\d{5}\b/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim(); }
function locationMatches(requested,location) { const wanted=normalize(requested),actual=normalize(location); return !!wanted&&!!actual&&(actual.includes(wanted)||wanted.includes(actual)); }
function sourceRelevant(source,location) { if(!Array.isArray(source?.locations)||!source.locations.length)return true; const wanted=normalize(location); return source.locations.some(item=>{const candidate=normalize(item);return candidate&&(wanted.includes(candidate)||candidate.includes(wanted));}); }

function titleBefore(lines,addressIndex,fallback) {
  for(let i=addressIndex-1;i>=Math.max(0,addressIndex-5);i--){const line=lines[i];if(!line||/^wohnung$/i.test(line)||/^mehr\s+dazu$/i.test(line)||/^details$/i.test(line))continue;if(/\b\d{5}\b/.test(line))continue;if(/^(?:gesamtmiete|warmmiete|fläche|flaeche|wohnfläche|wohnflaeche|zimmer)$/i.test(line))continue;return line.slice(0,140);} return fallback;
}

function listing(source,data){return Object.freeze({id:`${source.id}:${data.location}:${data.rooms}:${data.price}`.slice(0,220),source:source.label,sourceId:source.id,title:String(data.title||`${source.label} Wohnungsangebot`).slice(0,140),price:data.price,priceType:data.priceType||source.priceType,location:String(data.location||'').slice(0,140),rooms:data.rooms,areaSqm:data.areaSqm,url:source.url,imageUrl:null,distanceKm:null,publicSource:true});}

function parseWankendorfer(lines,source){
  const out=[];
  for(let i=0;i<lines.length;i++){
    if(normalize(lines[i])!=='gesamtmiete')continue;
    const priceIndex=lines.slice(i+1,i+5).findIndex(line=>euroFromLine(line)!==null); if(priceIndex<0)continue;
    const price=euroFromLine(lines[i+1+priceIndex]); let area=null,rooms=null;
    for(let j=i+1;j<Math.min(lines.length,i+12);j++){
      if(j>i+1&&(/\b\d{5}\b/.test(lines[j])||normalize(lines[j])==='gesamtmiete'))break;
      if(normalize(lines[j])==='flache'&&j+1<lines.length)area=decimalFromLine(lines[j+1]);
      if(normalize(lines[j])==='zimmer'&&j+1<lines.length)rooms=decimalFromLine(lines[j+1]);
    }
    let addressIndex=-1; for(let j=i-1;j>=Math.max(0,i-8);j--){if(/\b\d{5}\b/.test(lines[j])){addressIndex=j;break;}}
    if(addressIndex<0||!Number.isFinite(price)||!Number.isFinite(rooms))continue;
    out.push(listing(source,{title:titleBefore(lines,addressIndex,'Wankendorfer Wohnungsangebot'),location:lines[addressIndex],price,priceType:'Gesamtmiete',rooms,areaSqm:area}));
  }
  return out;
}

function parseWobau(lines,source){
  const out=[];
  for(let i=0;i<lines.length;i++){
    if(!/m²/u.test(lines[i])&&!/m2/i.test(lines[i]))continue;
    const area=decimalFromLine(lines[i]); let rooms=null,price=null;
    for(let j=i+1;j<Math.min(lines.length,i+7);j++){if(rooms===null&&/zimmer/i.test(lines[j]))rooms=decimalFromLine(lines[j]);if(price===null&&/(?:warmmiete|€)/i.test(lines[j]))price=euroFromLine(lines[j]);}
    let addressIndex=-1; for(let j=i-1;j>=Math.max(0,i-6);j--){if(/\b\d{5}\b/.test(lines[j])){addressIndex=j;break;}}
    if(addressIndex<0||!Number.isFinite(area)||!Number.isFinite(rooms)||!Number.isFinite(price))continue;
    out.push(listing(source,{title:titleBefore(lines,addressIndex,'WOBAU Wohnungsangebot'),location:lines[addressIndex],price,priceType:'Warmmiete',rooms,areaSqm:area}));
  }
  return out;
}

function parseFab(lines,source){
  const out=[];
  for(let i=0;i<lines.length;i++){
    const match=lines[i].match(/(\d{1,2}(?:[.,]\d+)?)\s*Zimmer\s*,\s*(\d{1,4}(?:[.,]\d+)?)\s*m(?:²|2)/iu); if(!match)continue;
    const rooms=deNumber(match[1]),area=deNumber(match[2]); let price=null;
    for(let j=i+1;j<Math.min(lines.length,i+6);j++){const value=euroFromLine(lines[j]);if(value!==null){price=value;break;}}
    if(!Number.isFinite(price)||price>=10000)continue;
    const previous=lines.slice(Math.max(0,i-5),i),addressParts=previous.filter(line=>/flensburg|harrislee|\b\d{5}\b/i.test(line));
    const location=addressParts.length?addressParts.slice(-2).join(' ').replace(/\s+/g,' ').trim():'Flensburg';
    const title=[...previous].reverse().find(line=>!/flensburg|harrislee|\b\d{5}\b/i.test(line)&&line.length>=4)||'FAB Wohnungsangebot';
    out.push(listing(source,{title,location,price,rooms,areaSqm:area}));
  }
  return out;
}

function labeledMetricBefore(lines,labelIndex,names,maxBack=12){for(let j=labelIndex-1;j>=Math.max(0,labelIndex-maxBack);j--){if(!names.includes(normalize(lines[j])))continue;for(let k=j+1;k<Math.min(labelIndex,j+4);k++){const number=decimalFromLine(lines[k]);if(Number.isFinite(number))return number;}}return null;}
function priceAfterLabel(lines,index){for(let j=index+1;j<Math.min(lines.length,index+4);j++){const price=euroFromLine(lines[j]);if(Number.isFinite(price))return price;}return euroFromLine(lines[index]);}

function parseWbgKiel(lines,source){
  const out=[];
  for(let i=0;i<lines.length;i++){
    if(normalize(lines[i])!=='gesamtmiete')continue;
    const price=priceAfterLabel(lines,i),rooms=labeledMetricBefore(lines,i,['zimmer']),area=labeledMetricBefore(lines,i,['wohnflache','flache']);
    let addressIndex=-1; for(let j=i-1;j>=Math.max(0,i-14);j--){if(/\b\d{5}\b/.test(lines[j])){addressIndex=j;break;}}
    if(addressIndex<0||!Number.isFinite(price)||!Number.isFinite(rooms))continue;
    const title=titleBefore(lines,addressIndex,'WBG Kiel-Ost Wohnungsangebot'); if(/anfragestopp/i.test(title))continue;
    out.push(listing(source,{title,location:lines[addressIndex],price,priceType:'Gesamtmiete',rooms,areaSqm:area}));
  }
  return out;
}

function parseLuebeckerBauverein(lines,source){
  const out=[];
  for(let i=0;i<lines.length;i++){
    if(normalize(lines[i])!=='gesamtmiete')continue;
    const price=priceAfterLabel(lines,i),rooms=labeledMetricBefore(lines,i,['zimmer']),area=labeledMetricBefore(lines,i,['flache','wohnflache']);
    let cityIndex=-1; for(let j=i-1;j>=Math.max(0,i-14);j--){if(/\b\d{5}\b/.test(lines[j])){cityIndex=j;break;}}
    if(cityIndex<0||!Number.isFinite(price)||!Number.isFinite(rooms))continue;
    let street=''; for(let j=cityIndex+1;j<Math.min(i,cityIndex+6);j++){if(['strasse','str'].includes(normalize(lines[j]))&&j+1<i){street=lines[j+1];break;}}
    const location=[street,lines[cityIndex]].filter(Boolean).join(', ');
    out.push(listing(source,{title:titleBefore(lines,cityIndex,'Lübecker Bauverein Wohnungsangebot'),location,price,priceType:'Gesamtmiete',rooms,areaSqm:area}));
  }
  return out;
}

function parseWobauOstholstein(lines,source){
  const out=[];
  for(let i=0;i<lines.length;i++){
    if(!/kaltmiete/i.test(lines[i]))continue;
    const price=euroFromLine(lines[i]); if(!Number.isFinite(price))continue;
    let rooms=null,area=null,location='';
    for(let j=i+1;j<Math.min(lines.length,i+7);j++){
      const metric=lines[j].match(/(\d{1,2}(?:[.,]\d+)?)\s*Zimmer\s*,?\s*(\d{1,4}(?:[.,]\d+)?)\s*m(?:²|2)/iu);
      if(metric){rooms=deNumber(metric[1]);area=deNumber(metric[2]);}
      if(/\b\d{5}\b/.test(lines[j])) { location=lines[j].replace(/\bDetails\s+ansehen\b.*$/iu,'').trim(); break; }
    }
    if(!Number.isFinite(rooms)||!location)continue;
    out.push(listing(source,{title:`${rooms} Zimmer – ${location.replace(/^\d{5}\s+/,'')}`,location,price,priceType:'Kaltmiete',rooms,areaSqm:area}));
  }
  return out;
}

function parseWodiDithmarschen(lines,source){
  const out=[];
  for(let i=0;i<lines.length;i++){
    const title=lines[i];
    const titleMatch=title.match(/^([^:]{2,80}):\s+.*wohnung/iu); if(!titleMatch)continue;
    let rooms=null,area=null,price=null;
    for(let j=i+1;j<Math.min(lines.length,i+8);j++){
      if(j>i+1&&/^[^:]{2,80}:\s+.*wohnung/iu.test(lines[j]))break;
      if(/^zimmer\s*:/iu.test(lines[j]))rooms=decimalFromLine(lines[j]);
      if(/^wohnfl[aä]che\s*:/iu.test(lines[j]))area=decimalFromLine(lines[j]);
      if(/^kaltmiete\s*:/iu.test(lines[j]))price=euroFromLine(lines[j]);
    }
    if(!Number.isFinite(rooms)||!Number.isFinite(price))continue;
    out.push(listing(source,{title,location:titleMatch[1].trim(),price,priceType:'Kaltmiete',rooms,areaSqm:area}));
  }
  return out;
}

function parseTrave(lines,source){
  const out=[];
  for(let i=0;i<lines.length;i++){
    if(!/^anzahl\s+zimmer\b/i.test(normalize(lines[i])))continue;
    let rooms=decimalFromLine(lines[i]);
    if(!Number.isFinite(rooms)){
      for(let j=i+1;j<Math.min(lines.length,i+3);j++){rooms=decimalFromLine(lines[j]);if(Number.isFinite(rooms))break;}
    }
    let area=null,price=null,priceType='Bruttokaltmiete',location='',title='TRAVE Wohnungsangebot';
    for(let j=Math.max(0,i-12);j<Math.min(lines.length,i+32);j++){
      const key=normalize(lines[j]);
      if(area===null&&/^wohnflache\b/.test(key))area=decimalFromLine(lines[j])??decimalFromLine(lines[j+1]);
      if(/^bruttokaltmiete\b/.test(key)){price=euroFromLine(lines[j])??euroFromLine(lines[j+1]);priceType='Bruttokaltmiete';}
      if(price===null&&/^nettokaltmiete\b/.test(key)){price=euroFromLine(lines[j])??euroFromLine(lines[j+1]);priceType='Nettokaltmiete';}
      if(!location&&/\b\d{5}\b/.test(lines[j])&&/l[uü]beck/i.test(lines[j]))location=lines[j];
    }
    for(let j=i-1;j>=Math.max(0,i-10);j--){
      const candidate=lines[j];
      if(!candidate||/^(?:zur übersicht|freie mietwohnungen der trave|die trave)$/i.test(candidate))continue;
      if(/(?:anzahl\s+zimmer|etage|wohnfl[aä]che|miete|kosten|kaution)/i.test(candidate))continue;
      if(candidate.length>=6&&candidate.length<=140){title=candidate;break;}
    }
    if(!Number.isFinite(rooms)||!Number.isFinite(price)||!location)continue;
    out.push(listing(source,{title,location,price,priceType,rooms,areaSqm:area}));
  }
  return out;
}

const PARSERS=Object.freeze({wankendorfer:parseWankendorfer,'wobau-neumuenster':parseWobau,fab:parseFab,'wbg-kiel-ost':parseWbgKiel,'luebecker-bauverein':parseLuebeckerBauverein,'wobau-ostholstein':parseWobauOstholstein,'wodi-dithmarschen':parseWodiDithmarschen,'trave-luebeck':parseTrave});

export function parsePublicHousingPage(sourceId,html,criteria={}){
  const source=PUBLIC_LIVE_HOUSING_SOURCES.find(item=>item.id===sourceId),parser=source&&PARSERS[source.id]; if(!source||!parser)return [];
  const roomSpec=roomSpecFromCriteria(criteria),maxPrice=Number(criteria?.amount); if(!roomSpec||!Number.isFinite(maxPrice)||maxPrice<100||!sourceRelevant(source,criteria.location))return [];
  const listings=parser(htmlLines(html),source).filter(item=>locationMatches(criteria.location,item.location)).filter(item=>roomValueInSpec(item.rooms,roomSpec)).filter(item=>Number.isFinite(item.price)&&item.price>0&&item.price<=maxPrice);
  const seen=new Set(); return listings.filter(item=>{const key=`${item.sourceId}|${normalize(item.location)}|${item.rooms}|${item.price}|${Math.round(item.areaSqm||0)}`;if(seen.has(key))return false;seen.add(key);return true;});
}

async function readBoundedText(response){
  if(!response?.ok)return null; const type=String(response.headers?.get?.('content-type')||'').toLowerCase(); if(type&&!type.includes('text/html')&&!type.includes('text/plain'))return null;
  const declared=Number(response.headers?.get?.('content-length')); if(Number.isFinite(declared)&&declared>MAX_HTML_BYTES)return null;
  const reader=response.body?.getReader?.(); if(!reader){const text=await response.text();return new TextEncoder().encode(text).byteLength<=MAX_HTML_BYTES?text:null;}
  const decoder=new TextDecoder(); let total=0,text='';
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_HTML_BYTES){await reader.cancel().catch(()=>{});return null;}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return text;}catch{return null;}
}

async function fetchSource(source,criteria,transport){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);
  try{
    const response=await transport(source.url,{method:'GET',headers:{accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1','user-agent':'ZaskaletaInfoBot/1.0'},redirect:'follow',signal:controller.signal});
    if(response?.url){try{const finalUrl=new URL(response.url);if(!source.host.test(finalUrl.hostname))return {source:source.id,status:'rejected_redirect',listings:[]};}catch{return {source:source.id,status:'invalid_response_url',listings:[]};}}
    const html=await readBoundedText(response); if(html===null)return {source:source.id,status:'unavailable',listings:[]};
    return {source:source.id,status:'ok',listings:parsePublicHousingPage(source.id,html,criteria)};
  }catch{return {source:source.id,status:'unavailable',listings:[]};}finally{clearTimeout(timeout);}
}

export async function searchPublicHousingSources(criteria,transport=fetch){
  const roomSpec=roomSpecFromCriteria(criteria),amount=Number(criteria?.amount); if(!criteria?.location||!roomSpec||!Number.isFinite(amount)||amount<100)return {status:'invalid_criteria',listings:[],sources:[]};
  const selectedSources=PUBLIC_LIVE_HOUSING_SOURCES.filter(source=>sourceRelevant(source,criteria.location));
  const sources=await Promise.all(selectedSources.map(source=>fetchSource(source,criteria,transport)));
  const unique=mergePublicHousingListings(sources.flatMap(result=>result.listings),criteria).slice(0,10);
  return {status:sources.some(result=>result.status==='ok')?'ok':'unavailable',listings:unique,sources:sources.map(({source,status,listings:found})=>({source,status,count:found.length}))};
}



// Conservative cross-source dedup: city + rounded price/area alone is not an identity.
export function mergePublicHousingListings(listings, criteria = {}) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const roomSpec = roomSpecFromCriteria(criteria);
  const relevance = item => {
    const rooms = Number(item.rooms);
    return roomSpec && Number.isFinite(rooms) ? Math.abs(rooms - (roomSpec.min + roomSpec.max) / 2) : Infinity;
  };
  const freshness = item => {
    const time = Date.parse(item.createdAt || '');
    return Number.isFinite(time) ? time : -Infinity;
  };
  const sorted = [...listings].sort((a,b) => {
    const da = finite(a.distanceKm) && a.distanceKm >= 0 ? a.distanceKm : Infinity;
    const db = finite(b.distanceKm) && b.distanceKm >= 0 ? b.distanceKm : Infinity;
    return (da - db || relevance(a) - relevance(b) || freshness(b) - freshness(a) || 0);
  });
  const seen = new Set();
  return sorted.filter(item => {
    const location = String(item.location || '');
    // Only explicit postal code + street/house number permits cross-source matching.
    const hasAddress = /\b\d{5}\b/.test(location) && /[a-zäöüß][a-zäöüß. -]*\s+\d{1,4}[a-z]?(?:\b|[,])/i.test(location);
    const exact = item.id && item.sourceId ? `id:${item.sourceId}:${item.id}` : null;
    const address = hasAddress && finite(item.price) && item.priceType && finite(item.areaSqm)
      ? `address:${normalize(location)}:${item.rooms}:${item.price}:${item.priceType}:${item.areaSqm}` : null;
    const keys = [exact, address].filter(Boolean);
    if (keys.some(key => seen.has(key))) return false;
    keys.forEach(key => seen.add(key));
    return true;
  });
}
