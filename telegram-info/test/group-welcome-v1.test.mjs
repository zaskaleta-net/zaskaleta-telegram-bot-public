import test from 'node:test';
import assert from 'node:assert/strict';
import { humanNewMembers, buildWelcomeText, handleGroupWelcomeRequest, normalizeWelcomeDeepLinkRequest } from '../src/group-welcome-v1.mjs';

const GROUP = -1001234567890;
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'abcdefghijklmnopqrstuvwxyzABCDEFGH_1234567890';

function env() {
  return {
    TELEGRAM_INGRESS_ENABLED:'true',
    TELEGRAM_PILOT_MODE:'allowlist',
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',
    TELEGRAM_ALLOWED_CHAT_IDS:String(GROUP),
    TELEGRAM_ADMIN_USER_IDS:'',
    TELEGRAM_BOT_TOKEN:TOKEN,
    TELEGRAM_WEBHOOK_SECRET:SECRET
  };
}

function webhook(update) {
  return new Request('https://worker.test/telegram/stateless', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-telegram-bot-api-secret-token':SECRET
    },
    body:JSON.stringify(update)
  });
}

test('humanNewMembers excludes bots and keeps people', () => {
  const update = {
    message:{
      new_chat_members:[
        { id:1, first_name:'Олена', is_bot:false },
        { id:2, first_name:'Service bot', username:'OtherBot', is_bot:true },
        { id:3, first_name:'Сергій', is_bot:false }
      ]
    }
  };
  assert.deepEqual(humanNewMembers(update).map(item => item.id), [1, 3]);
});

test('welcome text is concise and uses first name only', () => {
  const update = {
    message:{
      chat:{ title:'Українці Schleswig-Holstein' },
      new_chat_members:[
        { id:1, first_name:'Олена', last_name:'Тестова', is_bot:false },
        { id:2, first_name:'Іван', last_name:'Приклад', is_bot:false }
      ]
    }
  };
  const text = buildWelcomeText(update);
  assert.match(text, /Олена та Іван/u);
  assert.doesNotMatch(text, /Тестова|Приклад/u);
  assert.match(text, /закріплене повідомлення/u);
  assert.match(text, /BETA-режим/u);
  assert.ok(text.length < 500);
});

test('allowed pilot group sends one welcome with assistant and help buttons', async () => {
  const calls = [];
  const update = {
    update_id:700,
    message:{
      message_id:55,
      chat:{ id:GROUP, type:'supergroup', title:'Українці Schleswig-Holstein' },
      from:{ id:999, is_bot:false },
      new_chat_members:[
        { id:111, first_name:'Олена', is_bot:false },
        { id:222, first_name:'Іван', is_bot:false },
        { id:333, first_name:'Bot', is_bot:true }
      ]
    }
  };

  const response = await handleGroupWelcomeRequest(webhook(update), env(), async (url, options = {}) => {
    const body = JSON.parse(options.body);
    calls.push({ url:String(url), body });
    return new Response(JSON.stringify({ ok:true, result:{ message_id:901, chat:{ id:GROUP } } }), {
      status:200,
      headers:{ 'content-type':'application/json' }
    });
  });

  assert.ok(response);
  const result = await response.json();
  assert.equal(result.mode, 'group-welcome');
  assert.equal(result.delivered, true);
  assert.equal(result.memberCount, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendMessage$/u);
  assert.equal(calls[0].body.chat_id, GROUP);
  assert.match(calls[0].body.text, /Олена та Іван/u);
  assert.equal(calls[0].body.disable_notification, true);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].text, '🤖 Відкрити помічник');
  assert.match(calls[0].body.reply_markup.inline_keyboard[0][0].url, /start=welcome$/u);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[1][0].text, '📌 Як користуватися');
  assert.match(calls[0].body.reply_markup.inline_keyboard[1][0].url, /start=help$/u);
});

test('bot-only joins are ignored without Telegram delivery', async () => {
  let calls = 0;
  const response = await handleGroupWelcomeRequest(webhook({
    update_id:701,
    message:{
      message_id:56,
      chat:{ id:GROUP, type:'supergroup', title:'Pilot' },
      from:{ id:999, is_bot:false },
      new_chat_members:[{ id:333, first_name:'Bot', is_bot:true }]
    }
  }), env(), async () => {
    calls += 1;
    throw new Error('must not send');
  });
  assert.equal(calls, 0);
  assert.equal((await response.json()).reason, 'no_human_members');
});

test('welcome deep links open the intended private screen', async () => {
  const helpRequest = webhook({
    update_id:702,
    message:{ message_id:57, chat:{ id:111, type:'private' }, from:{ id:111 }, text:'/start help' }
  });
  const normalizedHelp = await normalizeWelcomeDeepLinkRequest(helpRequest);
  assert.equal((await normalizedHelp.json()).message.text, '/help');

  const startRequest = webhook({
    update_id:703,
    message:{ message_id:58, chat:{ id:111, type:'private' }, from:{ id:111 }, text:'/start welcome' }
  });
  const normalizedStart = await normalizeWelcomeDeepLinkRequest(startRequest);
  assert.equal((await normalizedStart.json()).message.text, '/start');
});
