import test from 'node:test';
import assert from 'node:assert/strict';
import { pilotConfig, isAllowedPilotChat, isPilotAdmin, isAdminCommand, equalSecret, normalizePilotUpdate, readBoundedJSON, sendPilotMessage } from '../src/pilot-security.mjs';

const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const env = { TELEGRAM_RELEASE_APPROVED: 'pilot-v1', TELEGRAM_PILOT_MODE: 'allowlist', TELEGRAM_ALLOWED_CHAT_IDS: '321', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_DELIVERY_ENABLED: 'true' };
const claim = { chatId: 321, text: 'Тестова відповідь' };
const result = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('configuration fails closed, accepts signed group ids and parses a bounded allowlist', () => {
  assert.equal(pilotConfig({}), null);
  assert.equal(pilotConfig({ ...env, TELEGRAM_ALLOWED_CHAT_IDS: '0' }), null);
  assert.equal(pilotConfig({ ...env, TELEGRAM_ALLOWED_CHAT_IDS: '321,nope' }), null);
  assert.equal(pilotConfig({ ...env, TELEGRAM_RELEASE_APPROVED: undefined }), null);
  assert.equal(pilotConfig(env).chatId, 321);

  const group = pilotConfig({ ...env, TELEGRAM_ALLOWED_CHAT_IDS: '-1001234567890,321', TELEGRAM_ADMIN_USER_IDS: '777,888' });
  assert.deepEqual(group.chatIds, [-1001234567890, 321]);
  assert.equal(group.chatId, -1001234567890);
  assert.equal(isAllowedPilotChat(group, -1001234567890), true);
  assert.equal(isAllowedPilotChat(group, -1009), false);
  assert.equal(isPilotAdmin(group, 777), true);
  assert.equal(isPilotAdmin(group, 999), false);
  assert.equal(isAdminCommand('/status@ZaskaletaInfoBot'), true);
  assert.equal(isAdminCommand('/start'), false);
  assert.equal(equalSecret(SECRET, SECRET), true);
  assert.equal(equalSecret(SECRET + 'x', SECRET), false);
});

test('public mode admits private chats, rejects groups, and requires the public release marker', () => {
  const publicEnv = {
    ...env,
    TELEGRAM_PILOT_MODE: 'public',
    TELEGRAM_RELEASE_APPROVED: 'public-v1',
    TELEGRAM_ALLOWED_CHAT_IDS: ''
  };
  const config = pilotConfig(publicEnv);
  assert.equal(config.mode, 'public');
  assert.equal(config.chatId, null);
  assert.deepEqual(config.chatIds, []);
  assert.equal(isAllowedPilotChat(config, 321), true);
  assert.equal(isAllowedPilotChat(config, 987654321), true);
  assert.equal(isAllowedPilotChat(config, -1001234567890), false);
  assert.equal(pilotConfig({ ...publicEnv, TELEGRAM_RELEASE_APPROVED: 'pilot-v1' }), null);
  assert.equal(pilotConfig({ ...publicEnv, TELEGRAM_ALLOWED_CHAT_IDS: 'bad' }), null);
});

test('public mode transport sends to private chats and refuses groups', async () => {
  const publicEnv = {
    ...env,
    TELEGRAM_PILOT_MODE: 'public',
    TELEGRAM_RELEASE_APPROVED: 'public-v1',
    TELEGRAM_ALLOWED_CHAT_IDS: ''
  };
  const privateClaim = { chatId: 987654321, text: 'Public private reply' };
  const sent = await sendPilotMessage(privateClaim, publicEnv, async (_url, options) => {
    assert.equal(JSON.parse(options.body).chat_id, 987654321);
    return result(200, { ok:true, result:{ message_id:42, chat:{ id:987654321 } } });
  });
  assert.deepEqual(sent, { status:'sent', messageId:42 });

  let calls = 0;
  const group = await sendPilotMessage({ chatId:-1001234567890, text:'No public groups' }, publicEnv, async () => {
    calls += 1;
    throw new Error('public mode must not send to groups');
  });
  assert.equal(group.status, 'disabled');
  assert.equal(calls, 0);
});

test('normalization accepts fresh private messages and preserves trusted bot reply context', () => {
  const now = 1700000000000;
  const p = { update_id: 1, message: { message_id: 2, date: 1700000000, chat: { id: 321, type: 'private' }, from: { id: 321, is_bot: false }, text: '/start' } };
  const normalized = normalizePilotUpdate(p, now);
  assert.equal(normalized.chatId, 321);
  assert.equal(normalized.userId, 321);
  assert.equal(normalized.chatType, 'private');
  assert.equal(normalized.trigger, 'private');
  assert.equal(normalizePilotUpdate({ ...p, message: { ...p.message, date: 1699999000 } }, now), null);
  assert.equal(normalizePilotUpdate({ ...p, message: { ...p.message, from: { id: 322 } } }, now), null);
  assert.equal(normalizePilotUpdate({ ...p, message: { ...p.message, from: { id: 321, is_bot: true } } }, now), null);
  assert.equal(normalizePilotUpdate({ ...p, update_id: -1 }, now), null);

  const trusted = { ...p, message: { ...p.message, text: '3', reply_to_message: { message_id: 1, chat: { id: 321, type: 'private' }, from: { id: 999, is_bot: true, username: 'ZaskaletaInfoBot' }, text: 'Бюджет 1000 €, місто Trittau. Вкажіть кількість кімнат.' } } };
  assert.equal(normalizePilotUpdate(trusted, now).replyToText, 'Бюджет 1000 €, місто Trittau. Вкажіть кількість кімнат.');

  const omittedUsername = { ...trusted, message: { ...trusted.message, reply_to_message: { ...trusted.message.reply_to_message, from: { id: 999, is_bot: true } } } };
  assert.equal(normalizePilotUpdate(omittedUsername, now).replyToText, 'Бюджет 1000 €, місто Trittau. Вкажіть кількість кімнат.');

  const foreignBot = { ...trusted, message: { ...trusted.message, reply_to_message: { ...trusted.message.reply_to_message, from: { id: 999, is_bot: true, username: 'OtherBot' } } } };
  assert.equal(normalizePilotUpdate(foreignBot, now).replyToText, '');
});

test('group normalization reacts only to deliberate triggers and keeps user identity separate from chat identity', () => {
  const now = 1700000000000;
  const base = {
    update_id: 10,
    message: { message_id: 20, date: 1700000000, chat: { id: -1001234567890, type: 'supergroup' }, from: { id: 777, is_bot: false }, text: '/start@ZaskaletaInfoBot' }
  };
  const command = normalizePilotUpdate(base, now);
  assert.equal(command.chatId, -1001234567890);
  assert.equal(command.userId, 777);
  assert.equal(command.chatType, 'supergroup');
  assert.equal(command.trigger, 'command');

  const ordinary = { ...base, update_id: 11, message: { ...base.message, message_id: 21, text: 'Привіт усім, як справи?' } };
  assert.equal(normalizePilotUpdate(ordinary, now), null);

  const mention = { ...base, update_id: 12, message: { ...base.message, message_id: 22, text: '@ZaskaletaInfoBot житло: Trittau' } };
  const mentioned = normalizePilotUpdate(mention, now);
  assert.equal(mentioned.trigger, 'mention');
  assert.equal(mentioned.text, 'житло: Trittau');

  const foreignCommand = { ...base, update_id: 13, message: { ...base.message, message_id: 23, text: '/start@OtherBot' } };
  assert.equal(normalizePilotUpdate(foreignCommand, now), null);

  const reply = { ...base, update_id: 14, message: { ...base.message, message_id: 24, text: '3', reply_to_message: { message_id: 19, chat: base.message.chat, from: { id: 999, is_bot: true, username: 'ZaskaletaInfoBot' }, text: 'Вкажіть кількість кімнат' } } };
  const replied = normalizePilotUpdate(reply, now);
  assert.equal(replied.trigger, 'reply');
  assert.equal(replied.replyToMessageId, 19);
  assert.equal(replied.replyToText, 'Вкажіть кількість кімнат');

  const invalidPositiveGroup = { ...base, update_id: 15, message: { ...base.message, message_id: 25, chat: { id: 123, type: 'group' } } };
  assert.equal(normalizePilotUpdate(invalidPositiveGroup, now), null);
});

test('streaming reader rejects actual oversize, false lengths and malformed UTF-8', async () => {
  assert.deepEqual(await readBoundedJSON(new Request('https://test', { method: 'POST', body: 'x'.repeat(100) }), 20), { error: 'too_large' });
  assert.deepEqual(await readBoundedJSON(new Request('https://test', { method: 'POST', headers: { 'content-length': '1' }, body: 'x'.repeat(100) }), 20), { error: 'too_large' });
  assert.deepEqual(await readBoundedJSON(new Request('https://test', { method: 'POST', body: new Uint8Array([0xff]) })), { error: 'invalid' });
  assert.deepEqual(await readBoundedJSON(new Request('https://test', { method: 'POST', body: '{"ok":true}' })), { value: { ok: true } });
});

test('transport never sends when disabled or addressed to another chat', async () => {
  let calls = 0;
  const transport = async () => { calls++; throw Error('should not call'); };
  assert.equal((await sendPilotMessage(claim, { ...env, TELEGRAM_DELIVERY_ENABLED: 'false' }, transport)).status, 'disabled');
  assert.equal((await sendPilotMessage({ ...claim, chatId: 322 }, env, transport)).status, 'disabled');
  assert.equal(calls, 0);
});

test('valid private and signed-group responses are acknowledged', async () => {
  const ok = await sendPilotMessage(claim, env, async (url, options) => {
    assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    assert.equal(JSON.parse(options.body).chat_id, 321);
    return result(200, { ok: true, result: { message_id: 10, chat: { id: 321 } } });
  });
  assert.deepEqual(ok, { status: 'sent', messageId: 10 });

  const groupEnv = { ...env, TELEGRAM_ALLOWED_CHAT_IDS: '-1001234567890' };
  const groupClaim = { chatId: -1001234567890, text:'Групова відповідь' };
  const group = await sendPilotMessage(groupClaim, groupEnv, async (_url, options) => {
    assert.equal(JSON.parse(options.body).chat_id, -1001234567890);
    return result(200, { ok:true, result:{ message_id:11, chat:{ id:-1001234567890 } } });
  });
  assert.deepEqual(group, { status:'sent', messageId:11 });
  assert.equal((await sendPilotMessage(claim, env, async () => result(200, { ok: true, result: { message_id: 10, chat: { id: 322 } } }))).status, 'uncertain');
  assert.equal((await sendPilotMessage(claim, env, async () => { throw Error('timeout'); })).status, 'uncertain');
});

test('only confirmed 429 is rate limited; 5xx and oversized responses are uncertain', async () => {
  const rate = await sendPilotMessage(claim, env, async () => result(429, { ok: false, error_code: 429, parameters: { retry_after: 99999 } }));
  assert.deepEqual(rate, { status: 'rate_limited', retryAfter: 3600 });
  assert.equal((await sendPilotMessage(claim, env, async () => result(429, { ok: false, error_code: 400 }))).status, 'rejected');
  assert.equal((await sendPilotMessage(claim, env, async () => result(503, { ok: false }))).status, 'uncertain');
  assert.equal((await sendPilotMessage(claim, env, async () => new Response('x'.repeat(20000), { status: 200 }))).status, 'uncertain');
});
