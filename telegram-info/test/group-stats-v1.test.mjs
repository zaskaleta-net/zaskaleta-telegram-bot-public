import test from 'node:test';
import assert from 'node:assert/strict';
import { handleGroupStatsRequest } from '../src/group-stats-v1.mjs';

const token = '123456789:' + 'a'.repeat(40);
const secret = 's'.repeat(40);
const groupId = -1001234567890;
const adminId = 111111111;

function env(extra = {}) {
  return {
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_ALLOWED_CHAT_IDS:`${groupId},${adminId}`,
    TELEGRAM_ADMIN_USER_IDS:String(adminId),
    TELEGRAM_BOT_TOKEN:token,
    TELEGRAM_WEBHOOK_SECRET:secret,
    ...extra
  };
}

function request(update) {
  return new Request('https://example.test/telegram/stateless', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-telegram-bot-api-secret-token':secret
    },
    body:JSON.stringify(update)
  });
}

function telegramResponse(result, ok = true) {
  return new Response(JSON.stringify({ ok, result }), {
    status:ok ? 200 : 400,
    headers:{ 'content-type':'application/json' }
  });
}

test('group admin /stats returns live Telegram member count', async () => {
  const calls = [];
  const transport = async (url, options) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === 'getChatAdministrators') {
      return telegramResponse([{ status:'administrator', user:{ id:adminId, is_bot:false } }]);
    }
    if (method === 'getChatMemberCount') return telegramResponse(7);
    if (method === 'sendMessage') return telegramResponse({ message_id:22, chat:{ id:groupId } });
    throw new Error(`unexpected ${method}`);
  };

  const response = await handleGroupStatsRequest(request({
    update_id:1,
    message:{
      message_id:10,
      date:1,
      chat:{ id:groupId, type:'supergroup' },
      from:{ id:adminId, is_bot:false },
      text:'/stats'
    }
  }), env(), transport);

  assert.ok(response);
  const data = await response.json();
  assert.deepEqual(data, { ok:true, mode:'group-stats-live', delivered:true, count:7 });
  assert.deepEqual(calls.map(call => call.method), ['getChatAdministrators','getChatMemberCount','sendMessage']);
  assert.match(calls[2].body.text, /Учасників зараз: 7/u);
  assert.match(calls[2].body.text, /Telegram API · live/u);
});

test('non-admin group user cannot run /stats', async () => {
  let countCalls = 0;
  const transport = async (url) => {
    const method = url.split('/').at(-1);
    if (method === 'getChatAdministrators') {
      return telegramResponse([{ status:'creator', user:{ id:adminId, is_bot:false } }]);
    }
    if (method === 'getChatMemberCount') countCalls += 1;
    throw new Error(`unexpected ${method}`);
  };

  const response = await handleGroupStatsRequest(request({
    update_id:2,
    message:{
      message_id:11,
      date:1,
      chat:{ id:groupId, type:'group' },
      from:{ id:222222222, is_bot:false },
      text:'/stats'
    }
  }), env(), transport);

  const data = await response.json();
  assert.equal(data.reason, 'admin_required');
  assert.equal(countCalls, 0);
});

test('configured admin can request the single pilot group count in private chat', async () => {
  const calls = [];
  const transport = async (url, options) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === 'getChatMemberCount') return telegramResponse(9);
    if (method === 'sendMessage') return telegramResponse({ message_id:23, chat:{ id:adminId } });
    throw new Error(`unexpected ${method}`);
  };

  const response = await handleGroupStatsRequest(request({
    update_id:3,
    message:{
      message_id:12,
      date:1,
      chat:{ id:adminId, type:'private' },
      from:{ id:adminId, is_bot:false },
      text:'/stats@ZaskaletaInfoBot'
    }
  }), env(), transport);

  const data = await response.json();
  assert.equal(data.count, 9);
  assert.equal(calls[0].method, 'getChatMemberCount');
  assert.equal(calls[0].body.chat_id, groupId);
  assert.equal(calls[1].body.chat_id, adminId);
});

test('Telegram count failure is reported without inventing a number', async () => {
  const sent = [];
  const transport = async (url, options) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(options.body);
    if (method === 'getChatAdministrators') {
      return telegramResponse([{ status:'creator', user:{ id:adminId, is_bot:false } }]);
    }
    if (method === 'getChatMemberCount') {
      return new Response(JSON.stringify({ ok:false, error_code:400 }), { status:400, headers:{ 'content-type':'application/json' } });
    }
    if (method === 'sendMessage') {
      sent.push(body.text);
      return telegramResponse({ message_id:24, chat:{ id:groupId } });
    }
    throw new Error(`unexpected ${method}`);
  };

  const response = await handleGroupStatsRequest(request({
    update_id:4,
    message:{
      message_id:13,
      date:1,
      chat:{ id:groupId, type:'supergroup' },
      from:{ id:adminId, is_bot:false },
      text:'/stats'
    }
  }), env(), transport);

  const data = await response.json();
  assert.equal(data.reason, 'telegram_count_failed');
  assert.equal('count' in data, false);
  assert.match(sent[0], /Не вдалося отримати live-кількість/u);
});
