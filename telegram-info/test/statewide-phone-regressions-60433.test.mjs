import test from 'node:test';
import assert from 'node:assert/strict';

import { handleNavigation } from '../src/runtime-keyboard.mjs';
import {
  isTopLevelNavigationRequest,
  superviseBackgroundJobcenterTask
} from '../src/runtime.mjs';
import {
  JOBCENTER_BACKGROUND_TASK_HEADER,
  JOBCENTER_BACKGROUND_LOCK_HEADER,
  cancelJobcenterBackgroundForNavigation,
  districtSearchCompletedNotice,
  handleJobcenterSearchStorage,
  jobcenterSearchSignature,
  releasePreparedJobcenterBackgroundLock,
  settleWithinAbortable,
  transportWithAbortSignal
} from '../src/runtime-jobcenter.mjs';

const USER = 777777777;
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);

function env(overrides = {}) {
  return {
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_ALLOWED_CHAT_IDS:String(USER),
    TELEGRAM_ADMIN_USER_IDS:String(USER),
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_DELIVERY_ENABLED:'true',
    TELEGRAM_MAINTENANCE_MODE:'false',
    ...overrides
  };
}

function callbackRequest(data = 'nav:housing', updateId = 60433001) {
  return new Request('https://worker.example/telegram/stateless', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-telegram-bot-api-secret-token':SECRET
    },
    body:JSON.stringify({
      update_id:updateId,
      callback_query:{
        id:`q-${updateId}`,
        from:{ id:USER, is_bot:false },
        data,
        message:{
          message_id:91,
          date:1700000000,
          chat:{ id:USER, type:'private' },
          text:'Вітаємо!\nSchleswig-Holstein Помічник 🇺🇦🇩🇪'
        }
      }
    })
  });
}

test('60433 nav:housing stays responsive even when legacy keyboard cleanup never answers', async () => {
  const stateCalls = [];
  const fakeEnv = env({
    OUTBOX:{
      idFromName(){ return 'fixture'; },
      get(){
        return {
          async fetch(url, options = {}) {
            const body = JSON.parse(options.body);
            stateCalls.push({ path:new URL(url).pathname, body });
            if (body.op === 'read') {
              return new Response(JSON.stringify({
                status:'ok',
                phase:'pending',
                messageIds:[101,102],
                updateId:60432999
              }), { status:200, headers:{ 'content-type':'application/json' } });
            }
            if (body.op === 'complete') {
              return new Response(JSON.stringify({ status:'ok', phase:'complete' }), {
                status:200,
                headers:{ 'content-type':'application/json' }
              });
            }
            return new Response(JSON.stringify({ status:'ok' }), {
              status:200,
              headers:{ 'content-type':'application/json' }
            });
          }
        };
      }
    }
  });

  const calls = [];
  const never = new Promise(() => {});
  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : {};
    calls.push({ method, body });
    if (method === 'deleteMessage') return never;
    if (method === 'answerCallbackQuery') {
      return new Response(JSON.stringify({ ok:true, result:true }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    if (method === 'getChatMember') {
      return new Response(JSON.stringify({
        ok:true,
        result:{ status:'member', user:{ id:USER, is_bot:false } }
      }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    return new Response(JSON.stringify({ ok:true, result:true }), {
      status:200,
      headers:{ 'content-type':'application/json' }
    });
  };

  const started = Date.now();
  const routed = await handleNavigation(callbackRequest(), fakeEnv, Date.now(), transport);
  const elapsed = Date.now() - started;

  assert.ok(routed?.request instanceof Request);
  const synthetic = await routed.request.json();
  assert.equal(synthetic.message.text,'🏠 Житло');
  assert.ok(calls.some(call => call.method === 'answerCallbackQuery'));
  assert.ok(calls.some(call => call.method === 'deleteMessage'));
  assert.ok(stateCalls.some(call => call.body.op === 'complete'));
  assert.ok(elapsed < 1200, `navigation callback took too long: ${elapsed}ms`);
});

test('60433 background watchdog turns explicit delivery failure into a visible terminal fallback', async () => {
  const sent = [];
  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    if (method === 'sendMessage') {
      const body = JSON.parse(options.body);
      sent.push(body);
      return new Response(JSON.stringify({
        ok:true,
        result:{ message_id:500, chat:{ id:USER, type:'private' } }
      }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    throw new Error('unexpected transport ' + url);
  };

  const failed = Promise.resolve(new Response(JSON.stringify({
    ok:true,
    mode:'private-jobcenter-district-search',
    delivered:false
  }), { status:200, headers:{ 'content-type':'application/json' } }));

  const response = await superviseBackgroundJobcenterTask(
    failed,
    callbackRequest('jcd:4:3-4:Wentorf%20bei%20Hamburg',60433002),
    env(),
    { transport, timeoutMs:50 }
  );

  assert.equal(response.status,200);
  assert.equal(sent.length,1);
  assert.match(sent[0].text,/не завершився через технічну помилку/u);
  assert.match(sent[0].text,/фінальної відповіді/u);
});

test('60433 background watchdog also covers a task that never settles', async () => {
  const sent = [];
  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    if (method === 'sendMessage') {
      sent.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        ok:true,
        result:{ message_id:501, chat:{ id:USER, type:'private' } }
      }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    throw new Error('unexpected transport ' + url);
  };

  const response = await superviseBackgroundJobcenterTask(
    new Promise(() => {}),
    callbackRequest('jcd:5:4-5:Itzehoe',60433003),
    env(),
    { transport, timeoutMs:5 }
  );

  assert.equal(response.status,504);
  const payload = await response.json();
  assert.equal(payload.mode,'telegram-jobcenter-search-background-timeout');
  assert.equal(sent.length,1);
});

test('60433 whole-Kreis success gets a new visible completion notice before listing cards', () => {
  const text = districtSearchCompletedNotice('Steinburg',3);
  assert.match(text,/Пошук по всьому Jobcenter\/Kreis Steinburg завершено/u);
  assert.match(text,/Знайдено нових оголошень: 3/u);
  assert.match(text,/Результати та керування пошуком надсилаю нижче/u);
});


class MemoryStorage60433 {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key); }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
}

function jobcenterStorageRequest60433(body) {
  return new Request('https://outbox.internal/jobcenter-search-state', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body)
  });
}

function lockedDistrictRequest60433(queryId = 'q-lock-60433') {
  const base = callbackRequest('jcd:4:3-4:Wentorf%20bei%20Hamburg',60433010);
  const headers = new Headers(base.headers);
  headers.set(JOBCENTER_BACKGROUND_LOCK_HEADER,'1');
  return new Request(base.url, {
    method:'POST',
    headers,
    body:JSON.stringify({
      update_id:60433010,
      callback_query:{
        id:queryId,
        from:{ id:USER, is_bot:false },
        data:'jcd:4:3-4:Wentorf%20bei%20Hamburg',
        message:{
          message_id:99,
          date:1700000000,
          chat:{ id:USER, type:'private' },
          text:'60433 district regression'
        }
      }
    })
  });
}

function outboxEnv60433(storage) {
  const outbox = { householdContextStorage:storage };
  return {
    ...env(),
    OUTBOX:{
      idFromName(){ return 'telegram-pilot-v1'; },
      get(){
        return {
          async fetch(url, options = {}) {
            return handleJobcenterSearchStorage(new Request(url, options), outbox);
          }
        };
      }
    }
  };
}

async function acquire60433(storage, token, now = 1000) {
  const signature = jobcenterSearchSignature({
    location:'Wentorf bei Hamburg',
    persons:4,
    rooms:'3-4',
    jurisdiction:'Herzogtum Lauenburg'
  });
  const outbox = { householdContextStorage:storage };
  const response = await handleJobcenterSearchStorage(jobcenterStorageRequest60433({
    op:'district_acquire',
    chatId:USER,
    userId:USER,
    signature,
    token,
    now
  }), outbox);
  return await response.json();
}

test('60433 three sequential district timeouts leave zero orphan network tasks', async () => {
  let active = 0;
  let aborted = 0;

  for (let index = 0; index < 3; index += 1) {
    const result = await settleWithinAbortable(
      signal => {
        active += 1;
        signal.addEventListener('abort', () => {
          active -= 1;
          aborted += 1;
        }, { once:true });
        return new Promise(() => {});
      },
      10,
      () => ({ status:'timeout' })
    );

    assert.equal(result.status,'timeout');
    assert.equal(active,0,`orphan task remained after timeout #${index + 1}`);
  }

  assert.equal(aborted,3);
});

test('60433 parent abort propagates through provider transport', async () => {
  const controller = new AbortController();
  let observedSignal = null;
  let aborted = false;

  const transport = transportWithAbortSignal(
    async (_url, options = {}) => {
      observedSignal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name:'AbortError' }));
        }, { once:true });
      });
    },
    controller.signal
  );

  const pending = transport('https://provider.example/search', {
    method:'GET',
    signal:AbortSignal.timeout(5000)
  }).catch(error => error);

  controller.abort();
  const error = await pending;
  assert.equal(observedSignal?.aborted,true);
  assert.equal(aborted,true);
  assert.equal(error?.name,'AbortError');
});

test('60433 emergency release removes a prepared district lock', async () => {
  const storage = new MemoryStorage60433();
  const fakeEnv = outboxEnv60433(storage);

  const first = await acquire60433(storage,'q-lock-60433',1000);
  assert.equal(first.acquired,true);

  const released = await releasePreparedJobcenterBackgroundLock(
    lockedDistrictRequest60433('q-lock-60433'),
    fakeEnv
  );
  assert.equal(released,true);

  const second = await acquire60433(storage,'q-after-release',1001);
  assert.equal(second.acquired,true);
});

test('60433 watchdog aborts task and releases prepared lock before fallback', async () => {
  const storage = new MemoryStorage60433();
  const fakeEnv = outboxEnv60433(storage);
  const request = lockedDistrictRequest60433('q-watchdog-60433');

  const first = await acquire60433(storage,'q-watchdog-60433',2000);
  assert.equal(first.acquired,true);

  const controller = new AbortController();
  const sent = [];
  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    if (method === 'sendMessage') {
      sent.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        ok:true,
        result:{ message_id:502, chat:{ id:USER, type:'private' } }
      }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    throw new Error('unexpected transport ' + url);
  };

  const response = await superviseBackgroundJobcenterTask(
    new Promise(() => {}),
    request,
    fakeEnv,
    { transport, timeoutMs:10, abortController:controller }
  );

  assert.equal(response.status,504);
  assert.equal(controller.signal.aborted,true);
  assert.equal(sent.length,1);

  const next = await acquire60433(storage,'q-after-watchdog',2001);
  assert.equal(next.acquired,true);
});

test('60433 housing navigation is a hard boundary while district callback is not', async () => {
  const housingMessage = new Request('https://worker.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      update_id:60433020,
      message:{
        message_id:120,
        date:1700000000,
        chat:{ id:USER, type:'private' },
        from:{ id:USER, is_bot:false },
        text:'🏠 Житло'
      }
    })
  });
  assert.equal(await isTopLevelNavigationRequest(housingMessage),true);
  assert.equal(await isTopLevelNavigationRequest(callbackRequest('nav:housing',60433021)),true);
  assert.equal(await isTopLevelNavigationRequest(callbackRequest('jcd:4:3-4:Wentorf%20bei%20Hamburg',60433022)),false);
});


test('60433 district lock is global per private user, not per city signature', async () => {
  const storage = new MemoryStorage60433();
  const outbox = { householdContextStorage:storage };

  let response = await handleJobcenterSearchStorage(jobcenterStorageRequest60433({
    op:'district_acquire',
    chatId:USER,
    userId:USER,
    signature:'herzogtum lauenburg|wentorf bei hamburg|4|3-4',
    token:'district-wentorf',
    now:5000
  }), outbox);
  assert.equal((await response.json()).acquired,true);

  response = await handleJobcenterSearchStorage(jobcenterStorageRequest60433({
    op:'district_acquire',
    chatId:USER,
    userId:USER,
    signature:'steinburg|itzehoe|3|3-4',
    token:'district-itzehoe',
    now:5001
  }), outbox);
  const second = await response.json();
  assert.equal(second.acquired,false);
  assert.equal(second.duplicate,false);
});

test('60433 top-level housing navigation cancels stale district ownership and dedup state', async () => {
  const storage = new MemoryStorage60433();
  const fakeEnv = outboxEnv60433(storage);
  const outbox = { householdContextStorage:storage };

  let response = await handleJobcenterSearchStorage(jobcenterStorageRequest60433({
    op:'district_acquire',
    chatId:USER,
    userId:USER,
    signature:'herzogtum lauenburg|wentorf bei hamburg|4|3-4',
    token:'stale-district',
    now:6000
  }), outbox);
  assert.equal((await response.json()).acquired,true);

  response = await handleJobcenterSearchStorage(jobcenterStorageRequest60433({
    op:'record_seen',
    chatId:USER,
    userId:USER,
    signature:'herzogtum lauenburg|wentorf bei hamburg|4|3-4',
    keys:['u:https://example.invalid/already-shown'],
    reset:true,
    now:6000
  }), outbox);
  assert.equal((await response.json()).status,'ok');

  const nav = new Request('https://worker.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      update_id:60433030,
      message:{
        message_id:130,
        date:1700000000,
        chat:{ id:USER, type:'private' },
        from:{ id:USER, is_bot:false },
        text:'🏠 Житло'
      }
    })
  });
  assert.equal(await cancelJobcenterBackgroundForNavigation(nav,fakeEnv,6001),true);

  response = await handleJobcenterSearchStorage(jobcenterStorageRequest60433({
    op:'district_check',
    chatId:USER,
    userId:USER,
    token:'stale-district',
    now:6002
  }), outbox);
  assert.equal((await response.json()).owned,false);

  response = await handleJobcenterSearchStorage(jobcenterStorageRequest60433({
    op:'district_acquire',
    chatId:USER,
    userId:USER,
    signature:'steinburg|itzehoe|3|3-4',
    token:'fresh-district',
    now:6003
  }), outbox);
  assert.equal((await response.json()).acquired,true);

  response = await handleJobcenterSearchStorage(jobcenterStorageRequest60433({
    op:'district_baseline',
    chatId:USER,
    userId:USER,
    signature:'steinburg|itzehoe|3|3-4',
    initialize:true,
    now:6004
  }), outbox);
  assert.deepEqual((await response.json()).baseline,[]);
});

test('60433 detached Jobcenter task has an explicit state-isolation marker', () => {
  assert.equal(JOBCENTER_BACKGROUND_TASK_HEADER,'x-zaskaleta-jobcenter-background-task');
});
