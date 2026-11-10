import assert from 'node:assert/strict';
import { resolveSchleswigHolsteinJobcenterRoute } from '../src/municipality-directory.mjs';
import { jobcenterRuleLocationForMunicipality } from '../src/schleswig-holstein-jobcenter-route.mjs';
import { SH_STATEWIDE_KDU_COVERAGE, resolveJobcenterRule } from '../src/jobcenter-registry-statewide.mjs';

const MODE = String(process.argv[2] || '').trim();
assert.ok(['resolver','jobcenter','kdu','statewide'].includes(MODE), `Unknown audit mode: ${MODE}`);
const FILTER_CODES = new Set(String(process.argv[3] || '').split(',').map(value => value.trim()).filter(Boolean));
const SLICE = String(process.argv[4] || '').trim();
const REMOTE_URL = 'https://raw.githubusercontent.com/robert-koch-institut/rki.emiga.common/3c65e867d64cb504ee9b733fec98cb55efebfc20/rki.emiga.common/input/fsh/CodeSystem/RegionKeys.fsh';
const BLOB_URL = 'https://api.github.com/repos/robert-koch-institut/rki.emiga.common/git/blobs/b8619cde98d02381d4cfff517cc93c5e94c77f64';
const EXPECTED_VERSION = '2026-03-31';
const PENDING = new Set(['Ostholstein','Neumünster']);
const BY_CODE = Object.freeze({'01':'Flensburg','02':'Kiel','03':'Lübeck','04':'Neumünster','51':'Dithmarschen','53':'Herzogtum Lauenburg','54':'Nordfriesland','55':'Ostholstein','56':'Pinneberg','57':'Plön','58':'Rendsburg-Eckernförde','59':'Schleswig-Flensburg','60':'Segeberg','61':'Steinburg','62':'Stormarn'});
const ALL_CODES = new Set(Object.keys(BY_CODE));
for (const code of FILTER_CODES) assert.ok(BY_CODE[code], `Unknown territory code filter: ${code}`);
function key(value){return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/gu,'').replace(/ß/gu,'ss').toLowerCase().replace(/[’ʼ'`´]/gu,'').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/gu,' ').trim();}
function name(value){return String(value||'').replace(/,\s*(?:Stadt|Landeshauptstadt|Hansestadt)\s*$/iu,'').replace(/\s+/gu,' ').trim();}
function ags(ars){return `${ars.slice(0,5)}${ars.slice(-3)}`;}
function transport(row){return async url=>{const target=new URL(String(url));const q=target.searchParams.get('q')||'';const data=key(q)===key(row.canonical)?[{ags:row.ags,ars:row.ars,normalized_display_name:row.canonical}]:[];return new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json'}});};}
function sliceRows(rows){if(!SLICE)return rows;const match=/^(\d+):(\d+)$/u.exec(SLICE);assert.ok(match,`Invalid row slice: ${SLICE}`);const start=Number(match[1]),end=Number(match[2]);assert.ok(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&end>start&&end<=rows.length,`Row slice out of range: ${SLICE}/${rows.length}`);return rows.slice(start,end);}
function validSource(text){return typeof text==='string'&&text.length>100_000&&text.includes('CodeSystem: RegionKeys')&&text.includes(`* ^version = "${EXPECTED_VERSION}"`)&&text.includes('Quelle: Statistisches Bundesamt, Wiesbaden');}
async function fetchText(url,headers){const response=await fetch(url,{headers,signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.text();}
async function loadSource(){
  const errors=[];
  try{const text=await fetchText(REMOTE_URL,{accept:'text/plain','user-agent':'zaskaleta-info-routing-stage/1.1'});if(validSource(text))return{text,source:'raw-pinned'};errors.push(`raw invalid=${text.length}`);}catch(error){errors.push(`raw ${error?.name||'Error'}:${error?.message||String(error)}`);}
  try{
    const payload=JSON.parse(await fetchText(BLOB_URL,{accept:'application/vnd.github+json','user-agent':'zaskaleta-info-routing-stage/1.1','x-github-api-version':'2022-11-28'}));
    const text=payload?.encoding==='base64'&&typeof payload?.content==='string'?Buffer.from(payload.content.replace(/\s+/gu,''),'base64').toString('utf8'):'';
    if(validSource(text))return{text,source:'github-blob-pinned'};
    errors.push(`blob invalid=${text.length}`);
  }catch(error){errors.push(`blob ${error?.name||'Error'}:${error?.message||String(error)}`);}
  throw new Error(`Pinned RegionKeys unavailable: ${errors.join(' | ')}`);
}
const {text,source}=await loadSource();
assert.ok(validSource(text),`RegionKeys payload invalid: ${text.length}`);
assert.equal(/^\* \^version = "([^"]+)"$/mu.exec(text)?.[1],EXPECTED_VERSION,'unexpected RegionKeys version');
const deprecated=new Set([...text.matchAll(/^\* #(01\d{10}) \^property\[\d+\]\.valueCode = #deprecated\s*$/gmu)].map(m=>m[1]));
const allRows=[];
for(const m of text.matchAll(/^\* #(01\d{10}) "([^"]+)"\s*$/gmu)){if(deprecated.has(m[1]))continue;const a=ags(m[1]);const code=a.slice(3,5);const jurisdiction=BY_CODE[code];if(jurisdiction)allRows.push({ars:m[1],ags:a,code,canonical:name(m[2]),jurisdiction});}
assert.equal(deprecated.size,3,`deprecated=${deprecated.size}`);assert.equal(allRows.length,1104,`active=${allRows.length}`);assert.equal(new Set(allRows.map(r=>r.ags)).size,1104,'duplicate AGS');assert.equal(new Set(allRows.map(r=>r.ars)).size,1104,'duplicate ARS');assert.deepEqual([...new Set(allRows.map(r=>r.code))].sort(),[...ALL_CODES].sort(),'territory-code coverage mismatch');
const filteredRows=(FILTER_CODES.size?allRows.filter(r=>FILTER_CODES.has(r.code)):allRows).sort((a,b)=>a.ags.localeCompare(b.ags,'de'));const rows=sliceRows(filteredRows);assert.ok(rows.length>0,'Audit filter selected zero municipalities');
const failures=[];let resolverPass=0,jobcenterPass=0,kduVerifiedPass=0,kduPendingPass=0;
for(const row of rows){
  if(MODE==='resolver'||MODE==='statewide'){
    const route=await resolveSchleswigHolsteinJobcenterRoute(row.canonical,transport(row));
    if(!route||route.jurisdiction!==row.jurisdiction)failures.push({mode:'resolver',ags:row.ags,name:row.canonical,expected:row.jurisdiction,actual:route?.jurisdiction||null,source:route?.source||null});else resolverPass++;
    if(MODE==='resolver')continue;
  }
  const location=jobcenterRuleLocationForMunicipality(row);
  if(!location){failures.push({mode:'jobcenter',ags:row.ags,name:row.canonical,jurisdiction:row.jurisdiction,reason:'no_rule_location'});continue;}
  jobcenterPass++;
  if(MODE==='jobcenter')continue;
  const coverage=SH_STATEWIDE_KDU_COVERAGE[row.jurisdiction];const resolved=resolveJobcenterRule(location,3);
  if(PENDING.has(row.jurisdiction)){
    if(coverage?.numericStatus!=='pending_direct_verification'||resolved?.status==='verified'||resolved?.rule)failures.push({mode:'kdu',ags:row.ags,name:row.canonical,jurisdiction:row.jurisdiction,location,reason:'pending_not_fail_closed'});else kduPendingPass++;
  }else if(coverage?.numericStatus!=='verified'||resolved?.status!=='verified'||resolved?.jurisdiction!==row.jurisdiction||!Number.isFinite(Number(resolved?.rule?.grossColdLimit))||!Number.isFinite(Number(resolved?.rule?.maxAreaSqm)))failures.push({mode:'kdu',ags:row.ags,name:row.canonical,jurisdiction:row.jurisdiction,location,reason:'verified_kdu_failed'});else kduVerifiedPass++;
}
assert.deepEqual(failures,[],`${MODE} failures: ${JSON.stringify(failures.slice(0,30))}`);
console.log(`SH_ROUTING_STAGE_PASS mode=${MODE} rows=${rows.length} source1104=${allRows.length} deprecated=${deprecated.size} territories=${new Set(allRows.map(r=>r.code)).size} resolverPass=${resolverPass} jobcenterPass=${jobcenterPass} kduVerifiedPass=${kduVerifiedPass} kduPendingPass=${kduPendingPass} fail=${failures.length} codes=${[...new Set(rows.map(r=>r.code))].join(',')} slice=${SLICE||'all'} first=${rows[0]?.ags}:${rows[0]?.canonical} last=${rows.at(-1)?.ags}:${rows.at(-1)?.canonical} source=${source}`);
