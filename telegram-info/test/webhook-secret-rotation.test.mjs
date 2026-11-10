import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const raw=fs.readFileSync(new URL('../../.github/workflows/telegram-webhook-secret-rotate.yml',import.meta.url),'utf8');
const code=raw.split("node --input-type=module <<'NODE'\n")[1].split('          NODE')[0].split('\n').map(x=>x.slice(10)).join('\n');

const old='ac5e41ae-c9ae-4926-af0f-557b53708b08', fresh='bc5e41ae-c9ae-4926-af0f-557b53708b08', other='cc5e41ae-c9ae-4926-af0f-557b53708b08';
const secrets={CLOUDFLARE_API_TOKEN:'Mock_CF_'.repeat(6),CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),TELEGRAM_BOT_TOKEN:'123456789:'+ 'Mock_TG_'.repeat(5),TELEGRAM_WEBHOOK_SECRET:'Mock_WEBHOOK_'.repeat(4),EXPECTED_ACTIVE_VERSION:old};
const poison=Object.values(secrets).join(' ');
export async function run(config={}) {
 const env={...secrets,...config.env}; const calls=[],logs=[],timeouts=[]; let active=config.recovery?fresh:old, installed=!!config.recovery, put=0, set=0, deploymentCalls=0, validProbes=0, clock=0;
 const proc={env,exitCode:0};
 const info={url:'https://bot.zaskaleta.net/telegram/stateless',has_custom_certificate:false,pending_update_count:8,max_connections:7,allowed_updates:['message','callback_query','chat_join_request'],...config.info};
 const FakeDate=class extends Date {static now(){return clock;}};
 const context=vm.createContext({Date:FakeDate,process:proc,console:{log:x=>logs.push(x),error:x=>logs.push(x)},setTimeout:(fn,delay)=>{clock+=delay;fn();},AbortSignal:{timeout:ms=>{timeouts.push(ms);return 'mock-signal';}},fetch:async(url,opt)=>{
  clock+=config.requestTime||0;
  assert.equal(opt.redirect,'error');assert.equal(opt.signal,'mock-signal');
  const u=new URL(url);assert.ok(['api.cloudflare.com','api.telegram.org','bot.zaskaleta.net'].includes(u.hostname));
  const method=opt.method||'GET';calls.push({url,method,opt});
  if(u.hostname==='api.cloudflare.com') assert.equal(opt.headers.Authorization,'Bearer '+secrets.CLOUDFLARE_API_TOKEN);
  else assert.equal(opt.headers?.Authorization,undefined);
  let body,status=200;
  if(u.pathname.endsWith('/getMe')) body={ok:true,result:{username:config.wrongBot?'OtherBot':'ZaskaletaInfoBot',is_bot:true}};
  else if(u.pathname.endsWith('/getWebhookInfo')) body={ok:true,result:{...info,...(set&&config.finalInfo?config.finalInfo:{})}};
  else if(u.pathname.endsWith('/deployments')) {
   deploymentCalls++;if(config.drift&&deploymentCalls===2)active=other;
   body={success:true,result:{deployments:[{id:'11111111-1111-1111-1111-111111111111',strategy:'percentage',created_on:'2026-11-10T12:00:00Z',versions:[{version_id:active,percentage:100}]}]}};
   if(config.badDeployment)body.result.deployments[0].versions.push({version_id:other,percentage:0});
   if(config.badDate)body.result.deployments[0].created_on='bad';
  } else if(u.pathname.endsWith('/versions')) {assert.equal(u.search,'?page=1&per_page=1');body={success:true,result:{items:[{id:config.newerUpload?other:active,number:3}]}};}
  else if(u.pathname.endsWith('/health')) body={ok:true,delivery:!config.disabled,versionId:config.badHealth?other:active};
  else if(u.pathname.endsWith('/secrets')) {
   assert.equal(method,'PUT');assert.deepEqual(JSON.parse(opt.body),{name:'TELEGRAM_WEBHOOK_SECRET',text:secrets.TELEGRAM_WEBHOOK_SECRET,type:'secret_text'});put++;
   if(!config.cfRejected){active=fresh;installed=true;}
   if(config.cfTimeout)throw new Error(poison);
   body=config.cfRejected?{success:false,errors:[{message:poison}]}:{success:true,result:{name:'TELEGRAM_WEBHOOK_SECRET',type:'secret_text'}};
  } else if(u.pathname.endsWith('/setWebhook')) {
   set++;assert.equal(method,'POST');const payload=JSON.parse(opt.body);assert.deepEqual(payload,{url:info.url,secret_token:secrets.TELEGRAM_WEBHOOK_SECRET,max_connections:info.max_connections,...(info.allowed_updates===undefined?{}:{allowed_updates:info.allowed_updates}),drop_pending_updates:false});
   assert.equal(installed,true);
   if(config.tgTimeout===true || (config.tgTimeout===1&&set===1))throw new Error(poison);
   body={ok:true,result:!config.tgFalse};
  } else if(u.pathname==='/telegram/stateless') {
   assert.equal(method,'POST');assert.equal(opt.body,'{}');
   const valid=opt.headers['X-Telegram-Bot-Api-Secret-Token']===secrets.TELEGRAM_WEBHOOK_SECRET;
   if(valid&&put)validProbes++;
   status=valid&&installed&&validProbes>(config.propagationFailures||0)?200:401;
   if(valid&&installed&&!put)status=200;body={ok:status===200};
   if(config.badInvalid&&!valid)status=200;
   if(config.probeError&&valid){status=500;body={error:poison};}
  } else assert.fail('Unexpected route '+u.pathname);
  if(config.failRoute&&u.pathname.endsWith(config.failRoute)){status=403;body={error:poison};}
  if(config.throwRoute&&u.pathname.endsWith(config.throwRoute))throw new Error(poison);
  return {status,json:async()=>{if(config.badJson&&u.pathname.endsWith(config.badJson))throw new Error(poison);return body;}};
 }});
 await vm.runInContext('(async()=>{'+code+'})()',context);
 const output=logs.join('\n'); for(const value of Object.values(secrets))assert.ok(!output.includes(value),'redacted '+value.slice(0,5));
 assert.ok(timeouts.every(x=>x>0&&x<=15000));
 return {exit:proc.exitCode,output,calls,put,set,installed};
}
async function check(label,config,expected){await test('webhook rotation: '+label,async()=>{const r=await run(config);expected(r);});}
await check('initial success',{},r=>{assert.equal(r.exit,0);assert.equal(r.put,1);assert.equal(r.set,1);assert.match(r.output,/ROTATION_OK/);});
await check('already installed skip CF', {recovery:true},r=>{assert.equal(r.exit,0);assert.equal(r.put,0);assert.equal(r.set,1);});
await check('CF ambiguous success reconcile',{cfTimeout:true},r=>{assert.equal(r.exit,0);assert.equal(r.put,1);assert.equal(r.set,1);});
await check('TG ambiguous first retry',{tgTimeout:1},r=>{assert.equal(r.exit,0);assert.equal(r.set,2);assert.equal(r.put,1);});
await check('TG always ambiguous forward only',{tgTimeout:true},r=>{assert.equal(r.exit,1);assert.equal(r.set,3);assert.equal(r.put,1);assert.equal(r.installed,true);assert.match(r.output,/CF_SECRET_CONFIRMED_TG_UNRESOLVED/);});
await check('CF propagation retries',{propagationFailures:10},r=>{assert.equal(r.exit,0);assert.equal(r.put,1);assert.equal(r.set,1);});
await check('CF propagation budget exhausted',{propagationFailures:999},r=>{assert.equal(r.exit,1);assert.equal(r.put,1);assert.equal(r.set,0);assert.ok(r.calls.length<400);});
await check('Global budget fail closed',{requestTime:100000},r=>{assert.equal(r.exit,1);assert.equal(r.put,0);assert.equal(r.set,0);});
await check('TG false result',{tgFalse:true},r=>{assert.equal(r.exit,1);assert.equal(r.set,3);});
await check('CF rejected no TG',{cfRejected:true},r=>{assert.equal(r.exit,1);assert.equal(r.put,1);assert.equal(r.set,0);assert.match(r.output,/CF_UPDATE_UNKNOWN_TG_UNCHANGED CF_RECONCILE/);});
await check('CF timeout unchanged no TG',{cfRejected:true,cfTimeout:true},r=>{assert.equal(r.exit,1);assert.equal(r.set,0);});
await check('omitted required updates fail closed',{info:{allowed_updates:undefined}},r=>{assert.equal(r.exit,1);assert.equal(r.put,0);assert.equal(r.set,0);});
await check('extra updates preserved',{info:{allowed_updates:['message','callback_query','chat_join_request','edited_message']}},r=>assert.equal(r.exit,0));
for(const [label,config] of Object.entries({wrongBot:{wrongBot:true},wrongUrl:{info:{url:'https://attacker.invalid'}},customCert:{info:{has_custom_certificate:true}},missingCert:{info:{has_custom_certificate:undefined}},badMax:{info:{max_connections:0}},badAllowed:{info:{allowed_updates:['bad/value']}},badPending:{info:{pending_update_count:-1}},multiVersion:{badDeployment:true},badDate:{badDate:true},badHealth:{badHealth:true},disabled:{disabled:true},invalidAccepted:{badInvalid:true},probe500:{probeError:true},latestDrift:{newerUpload:true},activeDrift:{drift:true},expectedDrift:{env:{EXPECTED_ACTIVE_VERSION:other}}}))await check(label,config,r=>{assert.equal(r.exit,1);assert.equal(r.put,0);assert.equal(r.set,0);});
for(const field of Object.keys(secrets))await check('malformed '+field,{env:{[field]:field==='CLOUDFLARE_API_TOKEN'?'invalid token':'invalid'}},r=>{assert.equal(r.exit,1);assert.equal(r.calls.length,0);});
for(const route of ['/getMe','/getWebhookInfo','/deployments','/versions','/health'])for(const mode of ['failRoute','throwRoute','badJson'])await check(mode+' '+route,{[mode]:route},r=>{assert.equal(r.exit,1);assert.equal(r.put,0);assert.equal(r.set,0);});
await check('final metadata failure preserves state',{finalInfo:{url:'https://attacker.invalid'}},r=>{assert.equal(r.exit,1);assert.equal(r.put,1);assert.equal(r.set,1);assert.match(r.output,/BOTH_UPDATED_VERIFICATION_PENDING FINAL_VERIFY/);});
test('webhook rotation serializes staging without cancellation and preserves both environment gates',()=>{
 const staging=fs.readFileSync(new URL('../../.github/workflows/telegram-staging-deploy.yml',import.meta.url),'utf8');
 for(const text of [raw,staging]) {
  assert.match(text,/group: telegram-webhook-secret-rotation/);
  assert.match(text,/cancel-in-progress: false/);
  assert.doesNotMatch(text,/cancel-in-progress: true/);
 }
 assert.match(raw,/environment: telegram-staging/);
 assert.match(raw,/environment: telegram-registration/);
 assert.match(raw,/needs: approve-staging/);
 assert.doesNotMatch(raw,/wrangler|GITHUB_OUTPUT|secret_fingerprint/);
});
