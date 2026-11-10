import { searchExpandedHousing } from '../src/housing-expanded-v22.mjs';
import { SH_JURISDICTIONS } from '../src/jobcenter-jurisdictions.mjs';
import { SH_RUNTIME_MUNICIPALITY_ROWS } from '../src/sh-municipality-jurisdiction-runtime.mjs';

const TIMEOUT_MS=30000;
const sampleFor=j=>SH_RUNTIME_MUNICIPALITY_ROWS.find(r=>r.jurisdiction===j)?.canonical||null;
const amount=50000;
let failures=0;
console.log('LIVE HOUSING SOURCE AUDIT — no Telegram delivery, no secrets');
for(const jurisdiction of SH_JURISDICTIONS){
  const location=sampleFor(jurisdiction);
  if(!location){console.error('FAIL',jurisdiction,'no municipality sample');failures++;continue;}
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  const transport=(url,init={})=>fetch(url,{...init,signal:controller.signal});
  try{
    const result=await searchExpandedHousing({
      location,rooms:'1-10',amount,type:'Bruttokaltmiete',
      districtJurisdiction:jurisdiction,jobcenterJurisdiction:jurisdiction
    },transport);
    const sources=(result?.sources||[]).map(s=>`${s.source}:${s.status}`).join(', ');
    const count=Array.isArray(result?.listings)?result.listings.length:0;
    console.log(`[${jurisdiction}] ${location} => status=${result?.status||'unknown'} listings=${count} sources=[${sources}]`);
    if(!['ok','partial'].includes(result?.status)||!(result?.sources||[]).some(s=>s.status==='ok'||s.status==='partial')) {
      failures++;
      for (const source of result?.sources || []) {
        if (source.status === 'ok' || source.status === 'partial' || source.status === 'not_relevant') continue;
        console.error(`[${jurisdiction}] ${source.source} diagnostics=${JSON.stringify(source.pages || [])}`);
      }
    }
  }catch(error){
    failures++;
    console.error(`[${jurisdiction}] ERROR`,error instanceof Error?error.message:String(error));
  }finally{clearTimeout(timer);}
}
if(failures){
  console.error(`LIVE HOUSING SOURCE AUDIT FAIL: ${failures} territory/source checks require attention`);
  process.exitCode=1;
}else{
  console.log('LIVE HOUSING SOURCE AUDIT PASS: all 15 territories reached at least one readable public housing source');
}
