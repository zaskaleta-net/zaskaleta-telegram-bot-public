import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_PROFILE, BRANDED_BOT_COMMANDS, syncBotCommandMetadata, resetBotCommandSyncForTests } from '../src/bot-command-sync.mjs';

const TOKEN = '123456789:' + 'A'.repeat(35);

test('published assistant metadata uses only the Schleswig-Holstein identity', () => {
  assert.deepEqual(BRANDED_BOT_COMMANDS.map(item => item.command), ['start','menu','news','events','beratung','watch','scanner','report','help','topics','premium','privacy','impressum','forget']);
  assert.match(BRANDED_BOT_COMMANDS[0].description, /Schleswig-Holstein Помічник/u);
  assert.match(BRANDED_BOT_COMMANDS.find(item => item.command === 'news').description, /новини Schleswig-Holstein/iu);
  assert.match(BRANDED_BOT_COMMANDS.find(item => item.command === 'report').description, /помилку/iu);
  assert.equal(ASSISTANT_PROFILE.name, 'Schleswig-Holstein Помічник 🇺🇦🇩🇪');
  assert.match(ASSISTANT_PROFILE.description, /Schleswig-Holstein/u);
});

test('metadata sync updates profile, command scopes and persistent menu buttons without exposing the token', async () => {
  resetBotCommandSyncForTests();
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, body:JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok:true, result:true }), { status:200, headers:{'content-type':'application/json'} });
  };
  const chatId = -1001234567890;
  const first = await syncBotCommandMetadata({ token:TOKEN }, transport, chatId);
  assert.equal(first.status, 'synced');
  assert.equal(calls.length, 12);
  const commandCalls = calls.filter(call => /\/setMyCommands$/.test(call.url));
  assert.equal(commandCalls.length, 7);
  for (const call of commandCalls) assert.deepEqual(call.body.commands, BRANDED_BOT_COMMANDS);
  assert.deepEqual(commandCalls.map(call => [call.body.scope?.type || 'default', call.body.language_code || null]), [
    ['default', null], ['all_group_chats', null], ['all_group_chats', 'uk'], ['all_private_chats', null], ['all_private_chats', 'uk'],
    ['chat', null], ['chat', 'uk']
  ]);
  assert.equal(commandCalls[5].body.scope.chat_id, chatId);
  assert.equal(commandCalls[6].body.scope.chat_id, chatId);
  assert.ok(calls.some(call => /\/setMyName$/.test(call.url) && call.body.name === ASSISTANT_PROFILE.name));
  assert.ok(calls.some(call => /\/setMyShortDescription$/.test(call.url) && call.body.short_description === ASSISTANT_PROFILE.shortDescription));
  assert.ok(calls.some(call => /\/setMyDescription$/.test(call.url) && call.body.description === ASSISTANT_PROFILE.description));
  const menuCalls = calls.filter(call => /\/setChatMenuButton$/.test(call.url));
  assert.equal(menuCalls.length, 2);
  assert.deepEqual(menuCalls[0].body, { menu_button:{ type:'commands' } });
  assert.deepEqual(menuCalls[1].body, { chat_id:chatId, menu_button:{ type:'commands' } });

  const second = await syncBotCommandMetadata({ token:TOKEN }, transport, chatId);
  assert.equal(second.status, 'already_synced');
  assert.equal(calls.length, 12);

  const secondChatId = -1009876543210;
  const third = await syncBotCommandMetadata({ token:TOKEN }, transport, secondChatId);
  assert.equal(third.status, 'synced');
  assert.equal(calls.length, 15);
  const thirdCalls = calls.slice(-3);
  assert.deepEqual(thirdCalls.slice(0, 2).map(call => [call.body.scope.type, call.body.scope.chat_id, call.body.language_code || null]), [
    ['chat', secondChatId, null], ['chat', secondChatId, 'uk']
  ]);
  assert.match(thirdCalls[2].url, /\/setChatMenuButton$/);
  assert.deepEqual(thirdCalls[2].body, { chat_id:secondChatId, menu_button:{ type:'commands' } });
});

test('failed metadata sync is non-secret and retryable', async () => {
  resetBotCommandSyncForTests();
  let calls = 0;
  const failed = await syncBotCommandMetadata({ token:TOKEN }, async () => {
    calls++;
    return new Response(JSON.stringify({ ok:false }), { status:500, headers:{'content-type':'application/json'} });
  });
  assert.equal(failed.status, 'unavailable');
  assert.equal(calls, 9);
  assert.doesNotMatch(JSON.stringify(failed), /123456789|AAAA/);
});
