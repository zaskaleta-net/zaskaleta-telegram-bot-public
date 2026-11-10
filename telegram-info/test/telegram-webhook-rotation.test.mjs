// Coordinated rotation executes the actual protected inline script with mocked network only.
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const raw=fs.readFileSync(new URL('../../.github/workflows/telegram-webhook-secret-rotate.yml',import.meta.url),'utf8');
const code=raw.split("node --input-type=module <<'NODE'\n")[1].split('          NODE')[0].split('\n').map(x=>x.slice(10)).join('\n');

const old='ac5e41ae-c9ae-4926-af0f-557b53708b08', fresh='bc5e41ae-c9ae-4926-af0f-557b53708b08', other='cc5e41ae-c9ae-4926-af0f-557b53708b08';
const secrets={CLOUDFLARE_API_TOKEN:'Mock_CF_'.repeat(6),CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),TELEGRAM_BOT_TOKEN:'123456789:'+ 'Mock_TG_'.repeat(5),TELEGRAM_WEBHOOK_SECRET:'Mock_WEBHOOK_'.repeat(4),EXPECTED_ACTIVE_VERSION:old};
const poison=Object.values(secrets).join(' ');
async function run(config={}) {
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

import { readFileSync } from 'node:fs';
const workflow = raw;
const REQUIRED_UPDATES = ['message', 'callback_query', 'chat_join_request'];
const WEBHOOK_URL = 'https://bot.zaskaleta.net/telegram/stateless';

test('TG-RELEASE-118 rotation preserves message, callback_query and chat_join_request', async () => {
  const result = await run();
  assert.equal(result.exit, 0);
  const writes = result.calls.filter(c => c.url.endsWith('/setWebhook'));
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].opt.body), {
    url:WEBHOOK_URL,secret_token:secrets.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates:REQUIRED_UPDATES,max_connections:7,drop_pending_updates:false
  });
  assert.match(result.output,/^TELEGRAM_WEBHOOK_ROTATION_OK /);
});
test('TG-RELEASE-118 rotation rejects any missing required update before mutation and after registration', async () => {
  for (const allowed_updates of [['message','callback_query'],['message','chat_join_request'],['callback_query','chat_join_request']]) {
    const before = await run({info:{allowed_updates}});
    assert.equal(before.exit,1);
    assert.equal(before.put,0);
    assert.equal(before.set,0);
    assert.ok(before.calls.every(c=>c.method==='GET'));
    const after = await run({finalInfo:{allowed_updates}});
    assert.equal(after.exit,1);
    assert.equal(after.set,1);
    assert.doesNotMatch(after.output,/ROTATION_OK/);
    assert.match(after.output,/BOTH_UPDATED_VERIFICATION_PENDING FINAL_VERIFY/);
  }
});
test('TG-RELEASE-118 rotation keeps bounded retries, wrong-secret fail-closed probe and reviewed destination', async () => {
  const retried=await run({tgTimeout:1});
  assert.equal(retried.exit,0);
  assert.equal(retried.set,2);
  for (const write of retried.calls.filter(c=>c.url.endsWith('/setWebhook'))) {
    const body=JSON.parse(write.opt.body);
    assert.deepEqual(body.allowed_updates,REQUIRED_UPDATES);
    assert.equal(body.drop_pending_updates,false);
    assert.equal(body.max_connections,7);
    assert.equal(body.url,WEBHOOK_URL);
  }
  const exhausted=await run({tgTimeout:true});
  assert.equal(exhausted.exit,1);
  assert.equal(exhausted.set,3);
  assert.match(exhausted.output,/CF_SECRET_CONFIRMED_TG_UNRESOLVED/);
  assert.doesNotMatch(exhausted.output,/ROTATION_OK/);
  const open=await run({badInvalid:true});
  assert.equal(open.exit,1);
  assert.equal(open.put,0);
  assert.equal(open.set,0);
  const probe=open.calls.find(c=>c.url===WEBHOOK_URL);
  assert.equal(probe.opt.headers['X-Telegram-Bot-Api-Secret-Token'],'invalid-rotation-probe-secret');
});
test('TG-RELEASE-118 workflow keeps reviewed safeguards and preserves all required subscriptions plus extras', async () => {
  assert.match(workflow,/^ {2}WEBHOOK_URL: https:\/\/bot\.zaskaleta\.net\/telegram\/stateless$/m);
  assert.match(workflow,/^ {2}EXPECTED_TELEGRAM_INFO_TREE: [0-9a-f]{40}$/m);
  assert.match(workflow,/test "\$\(git rev-parse HEAD:telegram-info\)" = "\$EXPECTED_TELEGRAM_INFO_TREE"/);
  assert.match(workflow,/inputs\.approval == 'ROTATE-TELEGRAM-WEBHOOK-SECRET'/);
  assert.match(workflow,/github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow,/^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(workflow,/drop_pending_updates:\s*true/);
  assert.doesNotMatch(workflow,/deleteWebhook/);
  const allowed_updates=[...REQUIRED_UPDATES,'edited_message'];
  const result=await run({info:{allowed_updates}});
  assert.equal(result.exit,0);
  assert.deepEqual(JSON.parse(result.calls.find(c=>c.url.endsWith('/setWebhook')).opt.body).allowed_updates,allowed_updates);
});

// TG-RELEASE-121: the reviewed-tree guard. The exact guard lines of every
// guarded workflow are run in bash with a stub `git`, so the test proves that
// a different telegram-info tree or a non-main ref is rejected and only the
// pinned tree on main is accepted. No network, no Cloudflare, no Telegram.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PIN = /EXPECTED_TELEGRAM_INFO_TREE:\s*([0-9a-f]{40})\b/gu;
const REF_LINE = 'test "${GITHUB_REF}" = "refs/heads/main"';
const TREE_LINE = 'test "$(git rev-parse HEAD:telegram-info)" = "$EXPECTED_TELEGRAM_INFO_TREE"';
// The four guarded workflows (TG-RELEASE-121 amended contract), and how many
// guarded jobs each has.
const PINNED = { 'telegram-staging-deploy.yml':1, 'telegram-webhook-migrate.yml':1, 'telegram-webhook-secret-rotate.yml':2, 'telegram-live-verify.yml':1 };

function guarded(name) {
  const text = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
  const pins = [...text.matchAll(PIN)].map(match => match[1]);
  const guards = text.split('\n').map((line, index, lines) => line.trim() === TREE_LINE ? lines[index - 1].trim() : null).filter(line => line !== null);
  return { pins, guards };
}

function runGuard(expected, actualTree, ref = 'refs/heads/main') {
  const dir = mkdtempSync(join(tmpdir(), 'tree-guard-'));
  try {
    const git = join(dir, 'git');
    writeFileSync(git, `#!/usr/bin/env bash\n[ "$1 $2" = "rev-parse HEAD:telegram-info" ] || exit 64\necho "${actualTree}"\n`);
    chmodSync(git, 0o755);
    const script = `set -euo pipefail\n${REF_LINE}\n${TREE_LINE}\n`;
    return spawnSync('bash', ['-c', script], { env:{ PATH:`${dir}:/usr/bin:/bin`, GITHUB_REF:ref, EXPECTED_TELEGRAM_INFO_TREE:expected } }).status;
  } finally {
    rmSync(dir, { recursive:true, force:true });
  }
}

test('TG-RELEASE-121 every guarded job keeps the main-ref and reviewed-tree checks', () => {
  for (const [name, jobs] of Object.entries(PINNED)) {
    const { pins, guards } = guarded(name);
    assert.equal(guards.length, jobs, `${name}: one tree check per guarded job`);
    assert.ok(guards.every(line => line === REF_LINE), `${name}: the main-ref check directly precedes each tree check`);
    assert.ok(pins.length >= 1, `${name}: a pinned tree`);
  }
});

test('TG-RELEASE-121 all four guarded workflows carry one and the same reviewed tree', () => {
  const pins = new Set(Object.keys(PINNED).flatMap(name => guarded(name).pins));
  assert.equal(pins.size, 1, `one reviewed tree, got ${[...pins].join(', ')}`);
});

test('TG-RELEASE-121 the guard accepts only the pinned tree on main', () => {
  const [pin] = guarded('telegram-staging-deploy.yml').pins;
  const other = pin.replace(/^./u, c => (c === '0' ? '1' : '0'));
  assert.equal(runGuard(pin, pin), 0, 'the pinned tree on main is accepted');
  assert.notEqual(runGuard(pin, other), 0, 'a different tree is rejected');
  assert.notEqual(runGuard(pin, ''), 0, 'an empty tree is rejected');
  assert.notEqual(runGuard('', pin), 0, 'a missing pin is rejected');
  assert.notEqual(runGuard(pin, pin, 'refs/heads/agent/release-agent/x'), 0, 'a non-main ref is rejected');
});


// Security review #121 (F1): ways to defeat a guard that the line check alone
// does not see. Each guard step must stay a plain fail-closed step.
function guardSteps(text) {
  const lines = text.split('\n');
  const steps = [];
  lines.forEach((line, index) => {
    if (line.trim() !== TREE_LINE) return;
    let start = index;
    while (start > 0 && !/^\s*- name:/u.test(lines[start])) start -= 1;
    let end = index + 1;
    while (end < lines.length && !/^\s*- (?:name|uses):/u.test(lines[end]) && !/^\S/u.test(lines[end]) && !/^ {2}\S/u.test(lines[end])) end += 1;
    steps.push(lines.slice(start, end).join('\n'));
  });
  return steps;
}

test('TG-RELEASE-121 guard steps cannot be softened (continue-on-error, set +e, an expression as the pin)', () => {
  for (const name of Object.keys(PINNED)) {
    const text = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
    for (const step of guardSteps(text)) {
      assert.doesNotMatch(step, /continue-on-error/u, `${name}: a guard step never continues on error`);
      assert.doesNotMatch(step, /\bset\s+\+[a-z]*e/u, `${name}: errexit stays on in a guard step`);
      assert.match(step, /set -euo pipefail/u, `${name}: the guard step runs with set -euo pipefail`);
      // Security review #121 round 2: other ways to skip or neutralise a guard step.
      assert.doesNotMatch(step, /^\s*if:/mu, `${name}: a guard step has no step-level if`);
      assert.doesNotMatch(step, /\bset\s+\+o\b/u, `${name}: no set +o in a guard step`);
      assert.doesNotMatch(step, /\btrap\b/u, `${name}: no trap in a guard step`);
      assert.doesNotMatch(step, /(?:^|[\s;&|(])(?:export\s+)?(?:GITHUB_REF|EXPECTED_TELEGRAM_INFO_TREE)=/mu, `${name}: the guard does not reassign its inputs`);
      assert.doesNotMatch(step, /^\s*env:/mu, `${name}: the guard step does not override env`);
    }
    const definitions = text.split('\n').filter(line => /^\s*EXPECTED_TELEGRAM_INFO_TREE\s*:/u.test(line));
    assert.ok(definitions.length >= 1, `${name}: the pin is defined`);
    for (const line of definitions) assert.match(line, /^\s*EXPECTED_TELEGRAM_INFO_TREE:\s*[0-9a-f]{40}\s*$/u, `${name}: the pin is a literal 40-hex tree, never an expression`);
    assert.doesNotMatch(text, /^\s{4}continue-on-error:\s*true/mu, `${name}: no job continues on error`);
    for (const condition of text.split('\n').filter(line => /^\s{4}if:/u.test(line))) {
      assert.match(condition, /github\.ref == 'refs\/heads\/main'/u, `${name}: every job runs on main only`);
    }
  }
});
