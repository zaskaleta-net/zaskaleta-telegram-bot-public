import test from 'node:test';
import assert from 'node:assert/strict';
import { publishNews } from '../src/runtime-news.mjs';
import { NEWS_CHANNEL_ID } from '../src/channel-membership-gate.mjs';

// Workers Free: 50 external subrequests per invocation, cron invocations too.
const LIMIT = 50;
const NOW = Date.UTC(2026, 9, 11, 6, 0); // 08:00 Europe/Berlin
const DATE = '2026-10-11';
const TOKEN = `12345:${'A'.repeat(32)}`;
// TG-RUNTIME-115: news go to the channel only.
const CHANNEL = NEWS_CHANNEL_ID;

function newsEnv(chatIds, ai) {
  return {
    TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1',
    TELEGRAM_BOT_TOKEN:TOKEN, TELEGRAM_WEBHOOK_SECRET:'s'.repeat(32),
    TELEGRAM_INGRESS_ENABLED:'true', TELEGRAM_DELIVERY_ENABLED:'true',
    TELEGRAM_ALLOWED_CHAT_IDS:chatIds.join(','), TELEGRAM_NEWS_CHAT_IDS:chatIds.join(','),
    AI:ai
  };
}

const AI_DOWN = { async run() { throw new Error('4006: daily free allocation exceeded'); } };
const AI_OK = { async run() { return { translated_text:'переклад' }; } };

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

// Feeds and pages yield plenty of candidates, so an unbounded build keeps fetching.
function cappedTransport({ telegramError = null } = {}) {
  let calls = 0;
  const telegram = [];
  const sources = [];
  const transport = async (url, options = {}) => {
    calls += 1;
    if (calls > LIMIT) throw new Error('Too many subrequests.');
    url = String(url);
    if (url.startsWith('https://api.telegram.org/')) {
      if (telegramError) throw telegramError;
      const body = JSON.parse(options.body);
      telegram.push(body);
      return new Response(JSON.stringify({ ok:true, result:{ message_id:calls, chat:{ id:body.chat_id } } }), { status:200 });
    }
    sources.push(url);
    if (url.includes('rss') || url.endsWith('.xml')) {
      const items = Array.from({ length:10 }, (_, i) => `<item><title>Ukraine Flüchtlinge Neuigkeit ${i}</title><link>https://www.ndr.de/a${i}.html</link><description>Ukraine Flüchtlinge Integration</description><pubDate>${new Date(Date.UTC(2026, 9, 10)).toUTCString()}</pubDate></item>`).join('');
      return new Response(`<rss><channel>${items}</channel></rss>`, { status:200 });
    }
    if (/veranstaltung|kalender|ukraine$|seite_node/.test(url)) {
      const host = new URL(url).origin;
      const anchors = Array.from({ length:20 }, (_, i) => `<a href="${host}/item-${i}">Ukraine Flüchtlinge Konzert Festival ${i} Oktober 2026</a>`).join('');
      return new Response(`<html>${anchors}</html>`, { status:200 });
    }
    if (url.includes('open-meteo')) return new Response('{}', { status:200, headers:{ 'content-type':'application/json' } });
    return new Response(`<html><head><meta property="og:title" content="Titel"><meta property="og:image" content="${new URL(url).origin}/img.jpg"></head></html>`, { status:200 });
  };
  transport.stats = () => ({ calls, telegram, sources });
  return transport;
}

const headersTo = (telegram, chatId) => telegram.filter(body => body.chat_id === chatId && /Ранковий огляд/u.test(String(body.text || '')));

test('TG-RUNTIME-010 daily news with Workers AI unavailable stays within 50 subrequests and delivers', async () => {
  const outbox = memoryOutbox(newsEnv([CHANNEL], AI_DOWN));
  const transport = cappedTransport();
  const result = await publishNews(outbox, { now:NOW }, transport);
  const { calls, telegram } = transport.stats();
  assert.ok(calls <= LIMIT, `used ${calls} subrequests`);
  assert.equal(result.failed, 0);
  assert.equal(result.uncertain, 0);
  assert.equal(headersTo(telegram, CHANNEL).length, 1);
  assert.equal(await outbox.storage.get(`telegram-daily-news:v2:${CHANNEL}`), DATE);
});

// TG-RUNTIME-115: with the channel and two groups configured, only the
// channel is a target; the groups get nothing (they used to get the digest).
test('TG-RUNTIME-010 the channel among configured groups gets the one publication within budget; the groups get nothing', async () => {
  const groups = [-1002, -1003];
  const outbox = memoryOutbox(newsEnv([CHANNEL, ...groups], AI_OK));
  const transport = cappedTransport();
  const result = await publishNews(outbox, { now:NOW }, transport);
  const { calls, telegram, sources } = transport.stats();
  assert.ok(calls <= LIMIT, `used ${calls} subrequests`);
  assert.equal(result.failed, 0);
  assert.equal(result.uncertain, 0);
  assert.equal(headersTo(telegram, CHANNEL).length, 1, 'the channel got the header');
  for (const chatId of groups) assert.equal(telegram.filter(body => body.chat_id === chatId).length, 0, `group ${chatId} got nothing`);
  assert.equal(new Set(sources).size, sources.length, 'each source page is fetched at most once per run');
});

test('TG-RUNTIME-010 a send rejected before reaching Telegram is retryable, not uncertain', async () => {
  const outbox = memoryOutbox(newsEnv([CHANNEL], AI_OK));
  const blocked = cappedTransport({ telegramError:new Error('Too many subrequests.') });
  const first = await publishNews(outbox, { now:NOW }, blocked);
  assert.equal(first.failed, 1);
  assert.equal(first.uncertain, 0);
  const record = await outbox.storage.get(`telegram-news-publication:v1:${CHANNEL}:daily:${DATE}`);
  assert.equal(record.states.header.state, 'retryable');

  const later = cappedTransport();
  const second = await publishNews(outbox, { now:NOW + 60 * 60 * 1000 }, later);
  assert.equal(second.failed, 0);
  assert.equal(headersTo(later.stats().telegram, CHANNEL).length, 1, 'the next cron delivers the morning review');
  assert.equal(await outbox.storage.get(`telegram-daily-news:v2:${CHANNEL}`), DATE);
});

test('TG-RUNTIME-010 past-day daily publication records are removed', async () => {
  const outbox = memoryOutbox(newsEnv([CHANNEL], AI_OK));
  const stale = `telegram-news-publication:v1:${CHANNEL}:daily:2026-10-01`;
  const manual = `telegram-news-publication:v1:${CHANNEL}:manual:digest:1`;
  await outbox.storage.put(stale, { publication:{ items:[] }, states:{ header:{ state:'uncertain' } } });
  await outbox.storage.put(manual, { publication:{ items:[] }, states:{} });
  await publishNews(outbox, { now:NOW }, cappedTransport());
  assert.equal(await outbox.storage.get(stale), undefined);
  assert.ok(await outbox.storage.get(manual), 'manual publication records are untouched');
});
