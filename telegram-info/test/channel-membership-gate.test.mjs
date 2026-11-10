import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handle } from '../src/runtime.mjs';
import { handleJoinRequestUpdate, handleJoinCheckCallback, NEWS_CHANNEL_ID, DISCUSSION_GROUP_ID, NOT_SUBSCRIBED_TEXT, UNVERIFIED_JOIN_TEXT, APPROVED_TEXT, JOIN_CHECK_CALLBACK } from '../src/channel-membership-gate.mjs';
import { fixture, NOW, SECRET } from './runtime-fixture.mjs';

// TG-RUNTIME-115: a join request to the discussion group is approved only
// when getChatMember confirms a subscription to the news channel. Anything
// else leaves the request pending; nobody is ever declined, banned or removed.

const CONFIG = { token:`123456789:${'A'.repeat(35)}`, secret:SECRET, chatIds:[], adminUserIds:[] };
const APPLICANT = 5550001;
const FORBIDDEN = /^(?:declineChatJoinRequest|banChatMember|kickChatMember|unbanChatMember|restrictChatMember)$/u;

function joinUpdate({ chatId = DISCUSSION_GROUP_ID, userId = APPLICANT, isBot = false, updateId = 9001 } = {}) {
  return { update_id:updateId, chat_join_request:{ chat:{ id:chatId, type:'supergroup' }, from:{ id:userId, is_bot:isBot, first_name:'Test' }, user_chat_id:userId, date:Math.floor(NOW / 1000) } };
}

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json' } });

// member: the getChatMember answer (object, Response or Error, or a list of
// them for consecutive calls); approveAnswer likewise.
function botApi({ member = { status:'member' }, approveAnswer = { ok:true, result:true } } = {}) {
  const calls = [];
  const next = value => Array.isArray(value) ? (value.length > 1 ? value.shift() : value[0]) : value;
  const answer = value => value instanceof Error ? Promise.reject(value) : value instanceof Response ? value.clone() : reply(value);
  const transport = async (url, options = {}) => {
    const method = String(url).split('/').at(-1);
    const body = JSON.parse(options.body || '{}');
    calls.push({ method, body });
    if (method === 'getChatMember') {
      const current = next(member);
      return answer(current instanceof Error || current instanceof Response ? current : { ok:true, result:{ user:{ id:body.user_id }, ...current } });
    }
    if (method === 'approveChatJoinRequest') return answer(next(approveAnswer));
    return reply({ ok:true, result:{ message_id:1 } });
  };
  transport.calls = calls;
  transport.count = method => calls.filter(call => call.method === method).length;
  return transport;
}

async function outcome(update, api) {
  const response = await handleJoinRequestUpdate(update, CONFIG, api);
  assert.ok(!api.calls.some(call => FORBIDDEN.test(call.method)), 'no decline, ban or removal');
  // Review #115 (F3): never a 503, which would hold the update queue.
  assert.equal(response.status, 200);
  return { status:response.status, body:await response.json() };
}

test('#115 subscribed statuses are approved: creator, administrator, member, restricted with is_member', async () => {
  for (const member of [{ status:'creator' }, { status:'administrator' }, { status:'member' }, { status:'restricted', is_member:true }]) {
    const api = botApi({ member });
    const { status, body } = await outcome(joinUpdate(), api);
    assert.equal(status, 200, member.status);
    assert.equal(body.approved, true, JSON.stringify(member));
    const check = api.calls.find(call => call.method === 'getChatMember');
    assert.deepEqual(check.body, { chat_id:NEWS_CHANNEL_ID, user_id:APPLICANT }, 'checked in the channel, for the applicant');
    assert.deepEqual(api.calls.find(call => call.method === 'approveChatJoinRequest').body, { chat_id:DISCUSSION_GROUP_ID, user_id:APPLICANT });
  }
});

test('#115 not subscribed (left, kicked, restricted without is_member) stays pending with the instruction', async () => {
  for (const member of [{ status:'left' }, { status:'kicked' }, { status:'restricted', is_member:false }, { status:'restricted' }]) {
    const api = botApi({ member });
    const { status, body } = await outcome(joinUpdate(), api);
    assert.equal(status, 200);
    assert.equal(body.approved, false, JSON.stringify(member));
    assert.equal(body.pending, true);
    assert.equal(api.count('approveChatJoinRequest'), 0);
    const message = api.calls.find(call => call.method === 'sendMessage');
    assert.equal(message.body.chat_id, APPLICANT, 'sent through user_chat_id');
    assert.equal(message.body.text, NOT_SUBSCRIBED_TEXT);
    const buttons = message.body.reply_markup.inline_keyboard.flat();
    assert.ok(buttons.some(button => button.url === 'https://t.me/ukrainci_schleswig_holstein'));
    assert.ok(buttons.some(button => button.callback_data === JOIN_CHECK_CALLBACK));
  }
});

test('#115 an unknown status is never approved', async () => {
  const api = botApi({ member:{ status:'something_new' } });
  const { status, body } = await outcome(joinUpdate(), api);
  assert.equal(status, 200);
  assert.equal(body.approved, false);
  assert.equal(api.count('approveChatJoinRequest'), 0);
});

test('#115 API failures never approve; transient ones answer 200 and leave the way in by the button', async () => {
  const transientCases = [
    reply({ ok:false, error_code:429, description:'Too Many Requests: retry after 17', parameters:{ retry_after:17 } }, 429),
    reply({ ok:false, error_code:502, description:'Bad Gateway' }, 502),
    new Error('network down')
  ];
  for (const member of transientCases) {
    const api = botApi({ member });
    const started = Date.now();
    const result = await outcome(joinUpdate(), api);
    assert.ok(Date.now() - started < 1500, 'a long retry_after is not waited for');
    assert.equal(result.body.pending, true);
    assert.equal(api.count('approveChatJoinRequest'), 0);
    const message = api.calls.find(call => call.method === 'sendMessage');
    assert.equal(message.body.text, UNVERIFIED_JOIN_TEXT);
    assert.ok(message.body.reply_markup.inline_keyboard.flat().some(button => button.callback_data === JOIN_CHECK_CALLBACK));
  }
  // The bot is not an admin of the channel / lacks rights: no approval, no message, waits for the admins.
  for (const member of [reply({ ok:false, error_code:400, description:'Bad Request: member list is inaccessible' }, 400), reply({ ok:false, error_code:403, description:'Forbidden: bot is not a member of the channel chat' }, 403)]) {
    const api = botApi({ member });
    const result = await outcome(joinUpdate(), api);
    assert.equal(result.body.pending, true);
    assert.equal(api.count('approveChatJoinRequest'), 0);
    assert.equal(api.count('sendMessage'), 0);
  }
});

test('#115 a short 429 (retry_after up to 2 s) is waited for once, then approved', async () => {
  const api = botApi({ member:[reply({ ok:false, error_code:429, parameters:{ retry_after:1 } }, 429), { status:'member' }] });
  const result = await outcome(joinUpdate(), api);
  assert.equal(result.body.approved, true);
  assert.equal(api.count('getChatMember'), 2);
  assert.equal(api.count('approveChatJoinRequest'), 1);
});

test('#115 approval errors: missing rights stays pending, a handled request is fine, a long 429 stays pending', async () => {
  const noRights = botApi({ approveAnswer:reply({ ok:false, error_code:400, description:'Bad Request: not enough rights to manage chat join requests' }, 400) });
  const a = await outcome(joinUpdate(), noRights);
  assert.equal(a.body.pending, true);
  assert.equal(noRights.count('sendMessage'), 0);
  const handled = botApi({ approveAnswer:reply({ ok:false, error_code:400, description:'Bad Request: HIDE_REQUESTER_MISSING' }, 400) });
  const b = await outcome(joinUpdate(), handled);
  assert.equal(b.body.reason, 'already_handled');
  const limited = botApi({ approveAnswer:reply({ ok:false, error_code:429, parameters:{ retry_after:30 } }, 429) });
  const c = await outcome(joinUpdate(), limited);
  assert.equal(c.body.pending, true);
  assert.equal(limited.count('approveChatJoinRequest'), 1, 'no wait for 30 s');
  assert.equal(limited.calls.find(call => call.method === 'sendMessage').body.text, UNVERIFIED_JOIN_TEXT);
});

test('#115 requests to another chat and from bots are left untouched', async () => {
  for (const update of [joinUpdate({ chatId:-1001234567890 }), joinUpdate({ chatId:NEWS_CHANNEL_ID }), joinUpdate({ isBot:true })]) {
    const api = botApi();
    const { body } = await outcome(update, api);
    assert.equal(body.ignored, true);
    assert.equal(api.calls.length, 0, 'no Telegram call at all');
  }
});

test('#115 "Я підписався — перевірити" approves once subscribed; otherwise explains again', async () => {
  const query = (chatType = 'private', chatId = APPLICANT) => ({ update_id:9100, callback_query:{ id:'q1', data:JOIN_CHECK_CALLBACK, from:{ id:APPLICANT, is_bot:false }, message:{ message_id:3, chat:{ id:chatId, type:chatType } } } });
  const subscribed = botApi();
  await handleJoinCheckCallback(query(), CONFIG, subscribed);
  assert.equal(subscribed.count('answerCallbackQuery'), 1);
  assert.equal(subscribed.count('approveChatJoinRequest'), 1);
  assert.equal(subscribed.calls.find(call => call.method === 'sendMessage').body.text, APPROVED_TEXT);
  const notYet = botApi({ member:{ status:'left' } });
  await handleJoinCheckCallback(query(), CONFIG, notYet);
  assert.equal(notYet.count('approveChatJoinRequest'), 0);
  assert.match(notYet.calls.find(call => call.method === 'sendMessage').body.text, /ще не видно/u);
  const handled = botApi({ approveAnswer:reply({ ok:false, error_code:400, description:'Bad Request: USER_ALREADY_PARTICIPANT' }, 400) });
  await handleJoinCheckCallback(query(), CONFIG, handled);
  assert.match(handled.calls.find(call => call.method === 'sendMessage').body.text, /не знайдено або її вже розглянуто/u);
  const failing = botApi({ member:new Error('down') });
  await handleJoinCheckCallback(query(), CONFIG, failing);
  assert.equal(failing.count('approveChatJoinRequest'), 0);
  assert.match(failing.calls.find(call => call.method === 'sendMessage').body.text, /не вдалося перевірити/u);
  const inGroup = botApi();
  await handleJoinCheckCallback(query('supergroup', DISCUSSION_GROUP_ID), CONFIG, inGroup);
  assert.equal(inGroup.calls.length, 0, 'only in the private chat');
});

test('#115 the webhook routes join requests to the gate, also during maintenance', async () => {
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'true' });
  try {
    const request = new Request('https://fixture.example/telegram/stateless', { method:'POST', headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET }, body:JSON.stringify(joinUpdate({ userId:5550002 })) });
    const response = await handle(request, f.env, NOW, f.transport);
    const body = await response.json();
    assert.equal(body.mode, 'channel-join-gate');
    // The fixture answers getChatMember "left" for anyone but its admin user.
    assert.equal(body.approved, false);
    assert.ok(!f.calls.some(call => call.method === 'approveChatJoinRequest' || FORBIDDEN.test(call.method)));
    const bad = new Request('https://fixture.example/telegram/stateless', { method:'POST', headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':'wrong'.repeat(8) }, body:JSON.stringify(joinUpdate()) });
    assert.equal((await handle(bad, f.env, NOW, f.transport)).status, 401, 'the webhook secret still guards the gate');
  } finally { f.close(); }
});

test('#115 a redelivered join update is processed once (update idempotency)', async () => {
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_DELIVERY_ENABLED:'true' });
  const original = globalThis.fetch;
  const approvals = [];
  globalThis.fetch = async (url, options) => {
    const method = String(url).split('/').at(-1);
    const body = JSON.parse(options?.body || '{}');
    if (method === 'getChatMember') return reply({ ok:true, result:{ status:'member', user:{ id:body.user_id } } });
    if (method === 'approveChatJoinRequest') { approvals.push(body); return reply({ ok:true, result:true }); }
    return f.transport(url, options);
  };
  try {
    const waits = [];
    const ctx = { waitUntil(promise) { waits.push(promise); } };
    const send = () => worker.fetch(new Request('https://fixture.example/telegram/stateless', { method:'POST', headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET }, body:JSON.stringify(joinUpdate({ updateId:424242 })) }), f.env, ctx);
    const first = await (await send()).json();
    await Promise.all(waits);
    const second = await (await send()).json();
    await Promise.all(waits);
    assert.equal(first.approved, true);
    assert.equal(second.duplicate, true);
    assert.equal(approvals.length, 1, 'one approval for one update');
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
