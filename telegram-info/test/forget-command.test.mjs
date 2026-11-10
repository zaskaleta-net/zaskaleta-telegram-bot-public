import test from 'node:test';
import assert from 'node:assert/strict';
import { forgetCommand, handleForgetUserStorage, forgetKeys, FORGET_DONE_TEXT, FORGET_USER_PATH } from '../src/forget-command.mjs';
import { RETENTION_RULES } from '../src/retention-sweep.mjs';

const SECRET = 's'.repeat(32);
const TOKEN = `12345:${'A'.repeat(32)}`;
const ENV = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_BOT_TOKEN:TOKEN, TELEGRAM_WEBHOOK_SECRET:SECRET, TELEGRAM_INGRESS_ENABLED:'true', TELEGRAM_DELIVERY_ENABLED:'true' };

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async list({ prefix }) { return new Map([...data].filter(([key]) => key.startsWith(prefix))); },
    async delete(keys) { let count = 0; for (const key of [].concat(keys)) if (data.delete(key)) count += 1; return count; }
  };
}

function update(text, { chatId = 777, userId = 777, type = 'private' } = {}) {
  return new Request('https://bot.test/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
    body:JSON.stringify({ update_id:1, message:{ message_id:5, text, chat:{ id:chatId, type }, from:{ id:userId, is_bot:false } } })
  });
}

test('the shared object deletes every per-user key of this user and nothing else', async () => {
  const box = storage({
    'telegram-household-context:v1:777:777': { persons:3, updatedAt:1 },
    'telegram-jobcenter-search-state:v1:777:777': { seen:['a'], updatedAt:1 },
    'telegram-keyboard-reset:v6:777:777': { phase:'complete', updatedAt:1 },
    'housing-cost-active:v14:777': { prompt:'x', updatedAt:1 },
    'telegram-household-context:v1:888:888': { persons:2, updatedAt:1 },
    'telegram-news-publication-cache:v1': { createdAt:1 }
  });
  const response = await handleForgetUserStorage(new Request(`https://outbox.internal${FORGET_USER_PATH}`, { method:'POST', body:JSON.stringify({ chatId:777, userId:777 }) }), { householdContextStorage:box });
  assert.deepEqual(await response.json(), { status:'ok', deleted:4 });
  assert.deepEqual([...box.data.keys()].sort(), ['telegram-household-context:v1:888:888', 'telegram-news-publication-cache:v1']);
});

test('every per-user prefix with a retention rule is covered by /forget', () => {
  const keys = forgetKeys(1, 1);
  for (const rule of RETENTION_RULES.filter(rule => !rule.prefix.startsWith('telegram-update:'))) {
    assert.ok(keys.some(key => key.startsWith(rule.prefix)), rule.prefix);
  }
});

test('the own whole-Kreis object drops queued searches', async () => {
  const box = storage({ 'telegram-jobcenter-district-task:v1:42': { update:{ callback_query:{ from:{ first_name:'Olena' } } } } });
  const response = await handleForgetUserStorage(new Request(`https://outbox.internal${FORGET_USER_PATH}`, { method:'POST', body:JSON.stringify({ chatId:777, userId:777, ownObject:true }) }), { householdContextStorage:box });
  assert.equal((await response.json()).status, 'ok');
  assert.equal(box.data.size, 0);
});

test('/forget in a private chat deletes in both objects and confirms', async () => {
  const calls = [];
  const env = { ...ENV, OUTBOX:{
    idFromName:name => name,
    get:name => ({ async fetch(url, init) { calls.push({ name, body:JSON.parse(init.body) }); return new Response(JSON.stringify({ status:'ok', deleted:1 }), { status:200 }); } })
  } };
  const sent = [];
  const transport = async (url, init) => { sent.push({ url:String(url), body:JSON.parse(init.body) }); return new Response('{"ok":true}'); };
  const response = await forgetCommand(update('/forget'), env, Date.now(), transport);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(call => call.name).sort(), ['jobcenter-district-search:v2:777', 'telegram-pilot-v1']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, 777);
  assert.equal(sent[0].body.text, FORGET_DONE_TEXT);
});

test('/forget is ignored outside a private chat and other text passes through', async () => {
  const env = { ...ENV, OUTBOX:{ idFromName:name => name, get:() => { throw new Error('no storage call expected'); } } };
  const group = await forgetCommand(update('/forget', { chatId:-100, userId:777, type:'supergroup' }), env, Date.now(), async () => { throw new Error('no send'); });
  assert.equal((await group.json()).reason, 'private_chat_required');
  assert.equal(await forgetCommand(update('Kiel'), env, Date.now()), null);
});

test('a failed deletion is reported honestly', async () => {
  const env = { ...ENV, OUTBOX:{ idFromName:name => name, get:() => ({ async fetch() { return new Response('{}', { status:503 }); } }) } };
  const sent = [];
  const response = await forgetCommand(update('/forget'), env, Date.now(), async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('{"ok":true}'); });
  assert.equal(response.status, 503);
  assert.match(sent[0].text, /^⚠️ Не вдалося видалити дані/u);
});
