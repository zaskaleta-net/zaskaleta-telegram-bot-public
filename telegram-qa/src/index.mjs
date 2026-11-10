const DEFAULT_TARGET='https://zaskaleta-info-telegram-staging.zaskaleta86.workers.dev';
const HEADERS={'cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer'};
const j=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{...HEADERS,'content-type':'application/json; charset=utf-8'}});
const h=(body)=>new Response(body,{headers:{...HEADERS,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"}});

async function probe(base,spec,env){
  const started=Date.now();
  try{
    const init={method:spec.method,headers:{accept:'application/json','content-type':'application/json'},body:spec.method==='POST'?'{}':undefined,redirect:'manual',signal:AbortSignal.timeout(10000)};
    const target=new Request(base+spec.path,init);
    const r=env?.STAGING?.fetch ? await env.STAGING.fetch(target) : await fetch(target);
    const type=r.headers.get('content-type')||'';
    const text=await r.text();
    if(!type.toLowerCase().startsWith('application/json')) throw new Error('non-json response');
    if(text.length>4096) throw new Error('response too large');
    const body=JSON.parse(text); const errors=[];
    if(r.status!==spec.status) errors.push(`HTTP ${r.status}, expected ${spec.status}`);
    if(spec.path==='/health' && spec.method==='GET' && spec.status===200){
      if(body?.ok!==true) errors.push('health.ok');
      if(body?.service!=='zaskaleta-info-telegram') errors.push('service');
      if(body?.delivery!==true) errors.push('delivery');
      if(!/^[0-9a-f-]{36}$/i.test(String(body?.versionId||''))) errors.push('versionId');
    } else if(JSON.stringify(body)!==JSON.stringify(spec.body)) errors.push('body');
    return {name:spec.name,passed:errors.length===0,status:r.status,latencyMs:Date.now()-started,errors};
  }catch(e){return {name:spec.name,passed:false,status:null,latencyMs:Date.now()-started,errors:[String(e?.message||e)]};}
}

async function core(base,env){
  const specs=[
    {name:'health',path:'/health',method:'GET',status:200},
    {name:'unknown route',path:'/not-a-route',method:'GET',status:404,body:{error:'Not found'}},
    {name:'webhook GET',path:'/telegram/stateless',method:'GET',status:404,body:{error:'Not found'}},
    {name:'protected webhook',path:'/telegram/stateless',method:'POST',status:401,body:{error:'Unauthorized'}}
  ];
  const results=[]; for(const s of specs) results.push(await probe(base,s,env));
  return {ok:results.every(x=>x.passed),suite:'staging-contract',target:base,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,results,at:new Date().toISOString()};
}

// The public 10x/20x stress button is gone (17.10.2026): anyone who knew the
// address could make the bot answer 20 requests per click. Stress runs, when
// needed, are done from a session, not from a public page.

const page=`<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZASKALETA Telegram QA</title><style>body{margin:0;background:#0a0d12;color:#eef2f7;font-family:system-ui;padding:24px}.w{max-width:900px;margin:auto}.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.c,pre{background:#111720;border:1px solid #273140;border-radius:14px;padding:16px}.v{font-size:24px;font-weight:800}.ok{color:#6ee7a8}.bad{color:#ff7f88}button{padding:12px 15px;border:0;border-radius:11px;font-weight:800;margin:8px 8px 8px 0}pre{white-space:pre-wrap;min-height:170px}</style></head><body><main class="w"><h1>ZASKALETA · TELEGRAM QA</h1><p>Cloudflare black-box контроль Telegram staging. Production не змінюється.</p><div class="g"><div class="c"><small>ENV</small><div class="v">STAGING</div></div><div class="c"><small>CORE</small><div id="core" class="v">NOT RUN</div></div><div class="c"><small>RUNTIME</small><div class="v">CLOUDFLARE</div></div></div><p><button onclick="go('/api/run','core')">RUN CORE QA</button></p><pre id="out">Готово до тесту.</pre><script>async function go(u,id){let e=document.getElementById(id),o=document.getElementById('out');e.textContent='RUNNING';try{let r=await fetch(u,{cache:'no-store'}),x=await r.json();e.textContent=x.ok?'PASS':'FAIL';e.className='v '+(x.ok?'ok':'bad');o.textContent=JSON.stringify(x,null,2)}catch(x){e.textContent='ERROR';e.className='v bad';o.textContent=String(x)}}</script></main></body></html>`;

export default {async fetch(request,env){
  const u=new URL(request.url), base=String(env.STAGING_URL||DEFAULT_TARGET).replace(/\/$/,'');
  if(request.method!=='GET') return j({error:'Method not allowed'},405);
  if(u.pathname==='/health') return j({ok:true,service:'zaskaleta-telegram-qa',runtime:'cloudflare',transport:env?.STAGING?.fetch?'service-binding':'public-fetch',target:base});
  if(u.pathname==='/api/run') return j(await core(base,env));
  if(u.pathname==='/') return h(page);
  return j({error:'Not found'},404);
}};
