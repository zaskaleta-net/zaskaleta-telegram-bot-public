import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 10000);
const QA_KEY = String(process.env.QA_KEY || '');
const MAX_LOG = 220_000;

let state = {
  status: 'idle',
  runId: null,
  startedAt: null,
  finishedAt: null,
  passed: null,
  failedStep: null,
  log: '',
};

const steps = [
  ['syntax', 'npm', ['run', 'check'], 'telegram-info'],
  ['statewide-fuzz', 'node', ['.github/qa/telegram-full-fuzz-x64.mjs'], '.'],
  ['full-suite', 'node', ['--test', '--test-concurrency=8', 'test/*.test.mjs'], 'telegram-info', true],
  ['baseline', 'npm', ['run', 'verify:baseline'], 'telegram-info'],
  ['statewide-runtime', 'node', ['.github/qa/telegram-statewide-runtime-audit-x64.mjs'], '.'],
  ['statewide-crosscheck', 'node', ['scripts/audit-sh-municipality-routing.mjs'], 'telegram-info'],
  ['forensic-p0', 'node', ['scripts/telegram-forensic-audit.mjs'], 'telegram-info'],
  ['staging-contract', 'npm', ['run', 'verify:staging'], 'telegram-info'],
  ['control-validate', 'npm', ['run', 'validate'], 'telegram-control'],
];

function json(res, status, body) {
  res.writeHead(status, {
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
  });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  if (!QA_KEY) return false;
  const got = String(req.headers['x-qa-key'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(QA_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function append(text) {
  state.log += text;
  if (state.log.length > MAX_LOG) state.log = state.log.slice(-MAX_LOG);
}

function runStep(name, cmd, args, cwd, shell = false) {
  return new Promise((resolve, reject) => {
    append(`\n=== ${name} ===\n`);
    const child = spawn(cmd, args, {
      cwd,
      shell,
      env:{...process.env, CI:'true'},
      stdio:['ignore','pipe','pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${name}: timeout`));
    }, 12 * 60 * 1000);
    child.stdout.on('data', d => append(d.toString()));
    child.stderr.on('data', d => append(d.toString()));
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${name}: exit ${code}`));
    });
  });
}

async function execute() {
  state = {
    status:'running',
    runId:randomUUID(),
    startedAt:new Date().toISOString(),
    finishedAt:null,
    passed:null,
    failedStep:null,
    log:'',
  };
  try {
    for (const [name,cmd,args,cwd,shell] of steps) {
      await runStep(name,cmd,args,cwd,shell);
    }
    state.status='completed';
    state.passed=true;
  } catch (error) {
    state.status='completed';
    state.passed=false;
    state.failedStep=String(error?.message || error);
    append(`\nFAIL ${state.failedStep}\n`);
  } finally {
    state.finishedAt=new Date().toISOString();
  }
}

const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET' && url.pathname==='/health'){
    return json(res,200,{ok:true,service:'zaskaleta-telegram-qa-render',runtime:'render',status:state.status});
  }
  if(req.method==='GET' && url.pathname==='/status'){
    if(!authorized(req)) return json(res,401,{error:'Unauthorized'});
    return json(res,200,state);
  }
  if(req.method==='POST' && url.pathname==='/run'){
    if(!authorized(req)) return json(res,401,{error:'Unauthorized'});
    if(state.status==='running') return json(res,409,{error:'QA already running',runId:state.runId});
    void execute();
    return json(res,202,{ok:true,status:'started'});
  }
  return json(res,404,{error:'Not found'});
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log(`QA_RENDER_READY port=${PORT}`);
});
