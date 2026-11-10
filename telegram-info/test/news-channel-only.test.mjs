import test from 'node:test';
import assert from 'node:assert/strict';
import { publishNews, newsTargets } from '../src/runtime-news.mjs';
import { publishWeekendEvents } from '../src/weekend-events.mjs';
import { pilotConfig } from '../src/pilot-security.mjs';
import { NEWS_CHANNEL_ID, DISCUSSION_GROUP_ID, GROUP_NEWS_POINTER_TEXT, NEWS_CHANNEL_URL } from '../src/channel-membership-gate.mjs';
import { fixture, NOW as FIXTURE_NOW, USER, GROUP } from './runtime-fixture.mjs';
import { handle } from '../src/runtime.mjs';

// TG-RUNTIME-115: every automatic news post goes to the channel only. The
// discussion group never gets a digest, even when an old
// TELEGRAM_NEWS_CHAT_IDS still lists it; "/news" in a group answers with a
// pointer to the channel.

const NOW = Date.UTC(2026, 9, 11, 6, 0); // 08:00 Europe/Berlin
const TOKEN = `12345:${'A'.repeat(32)}`;
const OWNER = 726209831;
// Controller review (P1): any other allowlisted group, not only the discussion group.
const THIRD = -1009999999999;

function newsEnv(newsIds, allowedIds = [OWNER, DISCUSSION_GROUP_ID, NEWS_CHANNEL_ID, THIRD]) {
  return {
    TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1',
    TELEGRAM_BOT_TOKEN:TOKEN, TELEGRAM_WEBHOOK_SECRET:'s'.repeat(32),
    TELEGRAM_INGRESS_ENABLED:'true', TELEGRAM_DELIVERY_ENABLED:'true',
    TELEGRAM_ALLOWED_CHAT_IDS:allowedIds.join(','), TELEGRAM_NEWS_CHAT_IDS:newsIds.join(','),
    AI:{ async run() { return { translated_text:'переклад' }; } }
  };
}

function memoryOutbox(env) {
  const values = new Map();
  const storage = {
    values,
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { return values.delete(key); },
    async list({ prefix = '' } = {}) { return new Map([...values].filter(([key]) => key.startsWith(prefix)).sort()); }
  };
  return { env, householdContextStorage:storage, storage };
}

function newsTransport() {
  const telegram = [];
  const transport = async (url, options = {}) => {
    url = String(url);
    if (url.startsWith('https://api.telegram.org/')) {
      const body = JSON.parse(options.body || '{}');
      telegram.push({ method:url.split('/').at(-1), body });
      return new Response(JSON.stringify({ ok:true, result:{ message_id:telegram.length, chat:{ id:body.chat_id } } }), { status:200 });
    }
    if (url.includes('rss') || url.endsWith('.xml')) {
      const items = Array.from({ length:8 }, (_, i) => `<item><title>Ukraine Flüchtlinge Neuigkeit ${i}</title><link>https://www.ndr.de/a${i}.html</link><description>Ukraine Flüchtlinge Integration</description><pubDate>${new Date(Date.UTC(2026, 9, 10)).toUTCString()}</pubDate></item>`).join('');
      return new Response(`<rss><channel>${items}</channel></rss>`, { status:200 });
    }
    if (url.includes('open-meteo')) return new Response('{}', { status:200, headers:{ 'content-type':'application/json' } });
    return new Response(`<html><head><meta property="og:title" content="Titel"></head></html>`, { status:200 });
  };
  transport.telegram = telegram;
  return transport;
}

const chatsOf = telegram => new Set(telegram.filter(call => /^send/u.test(call.method)).map(call => Number(call.body.chat_id)));

test('#115 newsTargets drops the discussion group even when it is configured', () => {
  const both = newsEnv([NEWS_CHANNEL_ID, DISCUSSION_GROUP_ID]);
  assert.deepEqual(newsTargets(both, pilotConfig(both)), [NEWS_CHANNEL_ID]);
  const groupOnly = newsEnv([DISCUSSION_GROUP_ID]);
  assert.deepEqual(newsTargets(groupOnly, pilotConfig(groupOnly)), []);
  const channel = newsEnv([NEWS_CHANNEL_ID]);
  assert.deepEqual(newsTargets(channel, pilotConfig(channel)), [NEWS_CHANNEL_ID], 'the expected configuration');
  const notAllowed = newsEnv([NEWS_CHANNEL_ID], [OWNER, DISCUSSION_GROUP_ID]);
  assert.deepEqual(newsTargets(notAllowed, pilotConfig(notAllowed)), [], 'a channel outside the allowlist still gets nothing');
});

test('#115 a third allowlisted group never becomes a news target (alongside the channel or alone)', () => {
  const all = newsEnv([NEWS_CHANNEL_ID, DISCUSSION_GROUP_ID, THIRD]);
  assert.deepEqual(newsTargets(all, pilotConfig(all)), [NEWS_CHANNEL_ID]);
  const third = newsEnv([THIRD]);
  assert.deepEqual(newsTargets(third, pilotConfig(third)), []);
  const twoGroups = newsEnv([THIRD, DISCUSSION_GROUP_ID]);
  assert.deepEqual(newsTargets(twoGroups, pilotConfig(twoGroups)), []);
});

test('#115 daily, manual and weekend publishing skip a third allowlisted group', async () => {
  const daily = newsTransport();
  await publishNews(memoryOutbox(newsEnv([THIRD, NEWS_CHANNEL_ID, DISCUSSION_GROUP_ID])), { now:NOW }, daily);
  assert.deepEqual([...chatsOf(daily.telegram)], [NEWS_CHANNEL_ID], 'daily');
  const manual = newsTransport();
  await publishNews(memoryOutbox(newsEnv([THIRD, NEWS_CHANNEL_ID])), { now:NOW, publication:{ type:'digest', idempotencyKey:'digest:third-115' } }, manual);
  assert.deepEqual([...chatsOf(manual.telegram)], [NEWS_CHANNEL_ID], 'manual');
  const alone = newsTransport();
  const result = await publishNews(memoryOutbox(newsEnv([THIRD])), { now:NOW }, alone);
  assert.equal(result.skipped, true, 'the third group alone gets nothing');
  assert.equal(alone.telegram.length, 0);
  const weekend = memoryOutbox(newsEnv([THIRD, NEWS_CHANNEL_ID]));
  await weekend.storage.put(`telegram-weekend-events:v1:${NEWS_CHANNEL_ID}`, '2026-10-16');
  assert.equal((await publishWeekendEvents(weekend, Date.UTC(2026, 9, 16, 15, 0), newsTransport())).status, 'already_sent', 'weekend: the third group is no target');
});

test('#115 the daily (cron) digest reaches the channel and never the group', async () => {
  const outbox = memoryOutbox(newsEnv([DISCUSSION_GROUP_ID, NEWS_CHANNEL_ID]));
  const transport = newsTransport();
  const result = await publishNews(outbox, { now:NOW }, transport);
  assert.equal(result.failed, 0);
  const chats = chatsOf(transport.telegram);
  assert.ok(chats.has(NEWS_CHANNEL_ID), 'the channel got the digest');
  assert.equal(chats.has(DISCUSSION_GROUP_ID), false, 'nothing went to the group');
  assert.equal(await outbox.storage.get(`telegram-daily-news:v2:${DISCUSSION_GROUP_ID}`), undefined);
});

test('#115 a manual digest (admin trigger) reaches the channel and never the group', async () => {
  const outbox = memoryOutbox(newsEnv([NEWS_CHANNEL_ID, DISCUSSION_GROUP_ID]));
  const transport = newsTransport();
  const result = await publishNews(outbox, { now:NOW, publication:{ type:'digest', idempotencyKey:'digest:test-115' } }, transport);
  assert.equal(result.skipped, false);
  const chats = chatsOf(transport.telegram);
  assert.ok(chats.has(NEWS_CHANNEL_ID));
  assert.equal(chats.has(DISCUSSION_GROUP_ID), false);
});

test('#115 with only the group configured nothing is published at all', async () => {
  const outbox = memoryOutbox(newsEnv([DISCUSSION_GROUP_ID]));
  const transport = newsTransport();
  const result = await publishNews(outbox, { now:NOW }, transport);
  assert.equal(result.skipped, true);
  assert.equal(transport.telegram.length, 0);
});

test('#115 the weekend events post follows the same channel-only targets', async () => {
  const outbox = memoryOutbox(newsEnv([DISCUSSION_GROUP_ID, NEWS_CHANNEL_ID]));
  const transport = newsTransport();
  // Friday 17:00 Berlin (the weekend slot); the channel already has today's post.
  const friday = Date.UTC(2026, 9, 16, 15, 0);
  await outbox.storage.put(`telegram-weekend-events:v1:${NEWS_CHANNEL_ID}`, '2026-10-16');
  const result = await publishWeekendEvents(outbox, friday, transport);
  assert.equal(result.status, 'already_sent', 'the group is no target, so nothing is pending');
  assert.equal(chatsOf(transport.telegram).has(DISCUSSION_GROUP_ID), false);
});

test('#115 "/news" in a group gets the channel pointer, not a digest; in private the digest stays', async () => {
  const f = await fixture({ TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' });
  try {
    for (const text of ['/news', '/news@ZaskaletaInfoBot']) {
      const before = f.calls.length;
      const response = await handle(f.request(text, { user:USER, chat:GROUP, type:'supergroup' }), f.env, FIXTURE_NOW, f.transport);
      const body = await response.json();
      const sent = f.calls.slice(before).filter(call => call.method.startsWith('send'));
      assert.equal(body.mode, 'group-news-pointer', text);
      assert.equal(sent.length, 1, `${text}: one pointer, no digest cards`);
      assert.equal(sent[0].body.text, GROUP_NEWS_POINTER_TEXT);
      assert.equal(sent[0].body.reply_markup.inline_keyboard[0][0].url, NEWS_CHANNEL_URL);
    }
    const before = f.calls.length;
    const response = await handle(f.request('/news', { user:USER }), f.env, FIXTURE_NOW, f.transport);
    const body = await response.json();
    assert.notEqual(body.mode, 'group-news-pointer');
    assert.ok(f.calls.slice(before).every(call => Number(call.body?.chat_id || USER) > 0), 'the private /news stays private');
  } finally { f.close(); }
});

test('#115 "/news" in the discussion group under public mode gets exactly the pointer', async () => {
  const f = await fixture({ ...newsEnv([NEWS_CHANNEL_ID]), TELEGRAM_BOT_TOKEN:`123456789:${'A'.repeat(35)}`, TELEGRAM_WEBHOOK_SECRET:'B'.repeat(40), TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_ADMIN_USER_IDS:'' });
  try {
    const before = f.calls.length;
    const response = await handle(f.request('/news', { user:OWNER, chat:DISCUSSION_GROUP_ID, type:'supergroup' }), f.env, FIXTURE_NOW, f.transport);
    assert.equal((await response.json()).mode, 'group-news-pointer');
    const sent = f.calls.slice(before).filter(call => call.method.startsWith('send'));
    assert.equal(sent.length, 1, 'one pointer, no digest');
    assert.equal(sent[0].body.text, GROUP_NEWS_POINTER_TEXT);
    assert.equal(Number(sent[0].body.chat_id), DISCUSSION_GROUP_ID);
  } finally { f.close(); }
});

// Review #115 (F5): the real cron route, through the Durable Object, so the
// legacy unfiltered sender (GroupTelegramOutbox.publishDailyNews) would fail
// here if the TelegramOutbox override were ever removed.
test('#115 the cron route through the Durable Object posts to the channel, never to the group', async () => {
  const transport = newsTransport();
  const original = globalThis.fetch;
  globalThis.fetch = transport;
  const f = await fixture({ ...newsEnv([DISCUSSION_GROUP_ID, NEWS_CHANNEL_ID]), TELEGRAM_BOT_TOKEN:`123456789:${'A'.repeat(35)}`, TELEGRAM_WEBHOOK_SECRET:'B'.repeat(40), TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_DAILY_NEWS_ENABLED:'true' });
  try {
    const response = await f.env.OUTBOX.get().fetch('https://outbox.internal/beta-group', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ op:'daily_news', now:NOW }) });
    assert.ok(response.status < 500, `status ${response.status}`);
    const chats = chatsOf(transport.telegram);
    assert.ok(chats.has(NEWS_CHANNEL_ID), 'the channel got the digest');
    assert.equal(chats.has(DISCUSSION_GROUP_ID), false, 'nothing went to the group');
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
