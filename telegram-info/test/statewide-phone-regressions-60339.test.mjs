import test from 'node:test';
import assert from 'node:assert/strict';

import {
  prepareJobcenterBackgroundAck,
  deliverListingsThenControls,
  JOBCENTER_BACKGROUND_ACK_HEADER,
  JOBCENTER_BACKGROUND_PROGRESS_HEADER,
  JOBCENTER_BACKGROUND_LOCK_HEADER
} from '../src/runtime-jobcenter.mjs';
import { resolveJobcenterRule, SH_STATEWIDE_KDU_COVERAGE } from '../src/jobcenter-registry-statewide.mjs';
import { SH_RUNTIME_MUNICIPALITY_ROWS } from '../src/sh-municipality-jurisdiction-runtime.mjs';
import { jobcenterRuleLocationForMunicipality } from '../src/schleswig-holstein-jobcenter-route.mjs';

const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const USER = 777777777;

function env() {
  return {
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_ALLOWED_CHAT_IDS:String(USER),
    TELEGRAM_ADMIN_USER_IDS:String(USER),
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_DELIVERY_ENABLED:'true'
  };
}

function callbackRequest(data) {
  return new Request('https://worker.example/telegram/stateless', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-telegram-bot-api-secret-token':SECRET
    },
    body:JSON.stringify({
      update_id:60339001,
      callback_query:{
        id:'60339-callback',
        from:{ id:USER, is_bot:false },
        data,
        message:{
          message_id:100,
          chat:{ id:USER, type:'private' },
          text:'60339 statewide phone regression'
        }
      }
    })
  });
}

test('60339 background ack makes whole-Kreis visibly react before detached execution', async () => {
  const calls = [];
  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    calls.push({ method, body });
    if (method === 'answerCallbackQuery') {
      return new Response(JSON.stringify({ ok:true, result:true }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    if (method === 'sendMessage') {
      return new Response(JSON.stringify({
        ok:true,
        result:{ message_id:60339, chat:{ id:USER } }
      }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    throw new Error('unexpected call: ' + url);
  };

  const ack = await prepareJobcenterBackgroundAck(
    callbackRequest('jcd:3:3-4:Itzehoe'),
    env(),
    transport
  );

  assert.equal(ack.handled,true);
  assert.equal(ack.callbackAnswered,true);
  assert.equal(ack.progressMessageId,60339);
  assert.deepEqual(calls.map(call => call.method), ['answerCallbackQuery','sendMessage']);
  assert.match(calls[1].body.text,/Steinburg/u);
  assert.match(calls[1].body.text,/Шукаю оголошення по всьому/u);
});

test('60339 local search also gets immediate visible progress before detached execution', async () => {
  const calls = [];
  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    calls.push({ method, body });
    if (method === 'answerCallbackQuery') {
      return new Response(JSON.stringify({ ok:true, result:true }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    if (method === 'sendMessage') {
      return new Response(JSON.stringify({
        ok:true,
        result:{ message_id:60340, chat:{ id:USER } }
      }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    throw new Error('unexpected call: ' + url);
  };

  // The local search itself (jcr:) gets the progress line. hka:j only shows the
  // paused guideline, so it must not leave a "Шукаю…" line that is never edited.
  const ack = await prepareJobcenterBackgroundAck(
    callbackRequest('jcr:15:2:2:Friedrichstadt'),
    env(),
    transport
  );

  assert.equal(ack.callbackAnswered,true);
  assert.equal(ack.progressMessageId,60340);
  assert.match(calls[1].body.text,/Friedrichstadt/u);

  calls.length = 0;
  const guideline = await prepareJobcenterBackgroundAck(
    callbackRequest('hka:j:2:2:Friedrichstadt'),
    env(),
    transport
  );
  assert.equal(guideline.callbackAnswered,true);
  assert.equal(guideline.progressMessageId,null);
  assert.deepEqual(calls.map(call => call.method), ['answerCallbackQuery']);
});


test('60339 district lock is acquired before progress and repeated taps do not create another searching line', async () => {
  const storage = new Map();
  const outbox = {
    idFromName(){ return 'telegram-pilot-v1'; },
    get(){ return { async fetch(_url,options={}) {
      const value = JSON.parse(String(options.body || '{}'));
      const key = 'lock:' + value.chatId + ':' + value.userId + ':' + value.signature;
      if (value.op === 'district_acquire') {
        const current = storage.get(key);
        if (current && current.expiresAt > value.now) {
          return new Response(JSON.stringify({
            status:'ok',
            acquired:false,
            duplicate:current.token === value.token,
            expiresAt:current.expiresAt
          }),{status:200,headers:{'content-type':'application/json'}});
        }
        const next = { token:value.token, expiresAt:value.now + 45000 };
        storage.set(key,next);
        return new Response(JSON.stringify({status:'ok',acquired:true,expiresAt:next.expiresAt}),{
          status:200,headers:{'content-type':'application/json'}
        });
      }
      return new Response(JSON.stringify({status:'ok'}),{status:200,headers:{'content-type':'application/json'}});
    } }; }
  };
  const e = { ...env(), OUTBOX:outbox };
  const calls = [];
  const transport = async (url,options={}) => {
    const method = String(url).split('/').at(-1);
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    calls.push({method,body});
    if (method === 'answerCallbackQuery') {
      return new Response(JSON.stringify({ok:true,result:true}),{status:200,headers:{'content-type':'application/json'}});
    }
    if (method === 'sendMessage') {
      return new Response(JSON.stringify({ok:true,result:{message_id:700 + calls.length,chat:{id:USER}}}),{
        status:200,headers:{'content-type':'application/json'}
      });
    }
    throw new Error('unexpected call: ' + url);
  };

  const first = await prepareJobcenterBackgroundAck(callbackRequest('jcd:3:3-4:Itzehoe'),e,transport);
  assert.equal(first.lockAcquired,true);
  assert.equal(first.skipBackground,false);
  assert.ok(first.progressMessageId);

  const second = await prepareJobcenterBackgroundAck(callbackRequest('jcd:3:3-4:Itzehoe'),e,transport);
  assert.equal(second.lockAcquired,false);
  assert.equal(second.skipBackground,true);
  assert.equal(second.duplicateSuppressed,true);

  const progressMessages = calls.filter(call => call.method === 'sendMessage' && /Шукаю оголошення по всьому/u.test(String(call.body?.text || '')));
  assert.equal(progressMessages.length,1);
  assert.equal(calls.some(call => /уже виконується/u.test(String(call.body?.text || ''))),true);
});

test('60339 controls are delivered strictly after listings, never concurrently', async () => {
  const order = [];
  const result = await deliverListingsThenControls(
    async () => {
      order.push('listing-1');
      await Promise.resolve();
      order.push('listing-2');
      return { status:'sent', mediaCount:2 };
    },
    async () => {
      order.push('controls');
      return true;
    }
  );

  assert.deepEqual(order,['listing-1','listing-2','controls']);
  assert.equal(result.listings.mediaCount,2);
  assert.equal(result.controls,true);
});

test('60339 background marker headers are stable internal contracts', () => {
  assert.equal(JOBCENTER_BACKGROUND_ACK_HEADER,'x-zaskaleta-jobcenter-callback-acked');
  assert.equal(JOBCENTER_BACKGROUND_PROGRESS_HEADER,'x-zaskaleta-jobcenter-progress-message-id');
  assert.equal(JOBCENTER_BACKGROUND_LOCK_HEADER,'x-zaskaleta-jobcenter-district-lock-acquired');
});

test('60339 tested cities still resolve statewide without one-off patches', () => {
  const cases = [
    ['Wentorf bei Hamburg',4,'Herzogtum Lauenburg'],
    ['Friedrichstadt',2,'Nordfriesland'],
    ['Itzehoe',3,'Steinburg'],
    ['Plön',2,'Plön'],
    ['Norderstedt',3,'Segeberg'],
    ['Eckernförde',2,'Rendsburg-Eckernförde']
  ];
  for (const [location,persons,jurisdiction] of cases) {
    const resolved = resolveJobcenterRule(location,persons);
    assert.equal(resolved?.status,'verified',location);
    assert.equal(resolved?.jurisdiction,jurisdiction,location);
  }
});


test('60339 all 15 Schleswig-Holstein territories keep a routable municipality and safe KdU status', () => {
  const firstByJurisdiction = new Map();
  for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
    if (!firstByJurisdiction.has(row.jurisdiction)) firstByJurisdiction.set(row.jurisdiction,row.canonical);
  }
  assert.equal(firstByJurisdiction.size,15);
  assert.equal(Object.keys(SH_STATEWIDE_KDU_COVERAGE).length,15);

  for (const [jurisdiction,location] of firstByJurisdiction) {
    const row = SH_RUNTIME_MUNICIPALITY_ROWS.find(entry => entry.jurisdiction === jurisdiction && entry.canonical === location);
    assert.ok(row, location);
    const ruleLocation = jobcenterRuleLocationForMunicipality(row);
    assert.ok(ruleLocation, location);
    const resolved = resolveJobcenterRule(ruleLocation,2);
    assert.equal(resolved?.jurisdiction,jurisdiction,location);
    const coverage = SH_STATEWIDE_KDU_COVERAGE[jurisdiction];
    assert.ok(coverage, jurisdiction);
    if (coverage.numericStatus === 'verified') {
      assert.equal(resolved?.status,'verified',location);
      assert.ok(Number(resolved?.rule?.grossColdLimit) > 0,location);
    } else {
      assert.notEqual(resolved?.status,'verified',location);
      assert.equal(resolved?.rule,null,location);
    }
  }
});

test('60339 Neumünster remains fail-closed until direct numeric verification exists', () => {
  const resolved = resolveJobcenterRule('Neumünster',2);
  assert.notEqual(resolved?.status,'verified');
  assert.equal(resolved?.rule,null);
  assert.ok(resolved?.pending);
});
