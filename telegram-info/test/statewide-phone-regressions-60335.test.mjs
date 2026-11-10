import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isBackgroundJobcenterSearchRequest,
  backgroundJobcenterFailureText
} from '../src/runtime.mjs';
import {
  handleJobcenterSearchStorage,
  localSearchProgressText,
  localSearchUnavailableText,
  districtSearchProgressText
} from '../src/runtime-jobcenter.mjs';
import { resolveJobcenterRule } from '../src/jobcenter-registry-statewide.mjs';

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
      update_id:60335001,
      callback_query:{
        id:'60335-callback',
        from:{ id:USER, is_bot:false },
        data,
        message:{
          message_id:100,
          chat:{ id:USER, type:'private' },
          text:'60335 statewide phone regression'
        }
      }
    })
  });
}

class MemoryStorage {
  constructor(){ this.map=new Map(); }
  async get(key){ return this.map.get(key); }
  async put(key,value){ this.map.set(key,value); }
  async delete(key){ this.map.delete(key); }
}

function storageRequest(body) {
  return new Request('https://outbox.internal/jobcenter-search-state', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body)
  });
}

test('60335 all active Jobcenter housing search callbacks are detached from webhook lifecycle', async () => {
  const callbacks = [
    'hka:j:4:3-4:Wentorf%20bei%20Hamburg',
    'hka:j:2:2:Friedrichstadt',
    'hka:j:3:3-4:Itzehoe',
    'hka:j:2:3:Pl%C3%B6n',
    'hka:j:3:3:Norderstedt',
    'hka:j:2:2:Eckernf%C3%B6rde',
    'jcd:4:3-4:Wentorf%20bei%20Hamburg',
    'jcd:3:3-4:Itzehoe',
    'jcd:3:3:Norderstedt',
    'jcr:25:3:3:Norderstedt',
    'jcp:1:3:3:Norderstedt',
    'jrp:1'
  ];
  for (const data of callbacks) {
    assert.equal(
      await isBackgroundJobcenterSearchRequest(callbackRequest(data), env()),
      true,
      data
    );
  }
  assert.equal(
    await isBackgroundJobcenterSearchRequest(callbackRequest('nav:housing'), env()),
    false
  );
});

test('60335 statewide locations resolve to the intended Jobcenter territory before live search', () => {
  const cases = [
    ['Wentorf bei Hamburg',4,'Herzogtum Lauenburg','verified'],
    ['Friedrichstadt',2,'Nordfriesland','verified'],
    ['Itzehoe',3,'Steinburg','verified'],
    ['Plön',2,'Plön','verified'],
    ['Norderstedt',3,'Segeberg','verified'],
    ['Eckernförde',2,'Rendsburg-Eckernförde','verified'],
    ['Neumünster',2,'Neumünster','not_yet_verified']
  ];
  for (const [location,persons,jurisdiction,status] of cases) {
    const resolved = resolveJobcenterRule(location,persons);
    assert.equal(resolved?.jurisdiction,jurisdiction,location);
    assert.equal(resolved?.status,status,location);
  }
});

test('60335 district in-flight lock is global per private user across search signatures', async () => {
  const storage = new MemoryStorage();
  const outbox = { householdContextStorage:storage };
  const common = { chatId:USER, userId:USER, now:100000 };

  let response = await handleJobcenterSearchStorage(storageRequest({
    ...common,
    op:'district_acquire',
    signature:'herzogtum lauenburg|wentorf bei hamburg|4|3-4',
    token:'wentorf-a'
  }), outbox);
  assert.equal((await response.json()).acquired,true);

  response = await handleJobcenterSearchStorage(storageRequest({
    ...common,
    now:100001,
    op:'district_acquire',
    signature:'herzogtum lauenburg|wentorf bei hamburg|4|3-4',
    token:'wentorf-b'
  }), outbox);
  assert.equal((await response.json()).acquired,false);

  response = await handleJobcenterSearchStorage(storageRequest({
    ...common,
    now:100002,
    op:'district_acquire',
    signature:'steinburg|itzehoe|3|3-4',
    token:'itzehoe-a'
  }), outbox);
  const crossCity = await response.json();
  assert.equal(crossCity.acquired,false);
  assert.equal(crossCity.duplicate,false);
});

test('60335 local and district searches always have visible progress and terminal failure copy', () => {
  assert.match(localSearchProgressText('Eckernförde'), /Eckernförde/u);
  assert.match(localSearchUnavailableText('Friedrichstadt'), /не завершився вчасно/u);
  assert.match(localSearchUnavailableText('Friedrichstadt'), /фінальної відповіді/u);
  assert.match(districtSearchProgressText('Segeberg'), /Segeberg/u);
  assert.match(backgroundJobcenterFailureText(), /технічну помилку/u);
  assert.match(backgroundJobcenterFailureText(), /фінальної відповіді/u);
});

test('60335 Neumünster remains intentionally fail-closed instead of inventing a numeric limit', () => {
  const resolved = resolveJobcenterRule('Neumünster',2);
  assert.notEqual(resolved?.status,'verified');
  assert.equal(resolved?.rule,null);
  assert.ok(resolved?.pending);
  // TG-RUNTIME-073: the call sites add the "no numbers" line; the text says no table is verified.
  assert.match(String(resolved?.pending?.messageUk || ''), /Перевіреної офіційної таблиці з сумами в боті поки немає/u);
});
