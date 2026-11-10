import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEWS_PUBLICATION_CACHE_TTL_MS,
  cachedNewsPublication,
  freshCachedPublication,
  handleNewsPublicationCacheStorage,
  storeCachedPublication
} from '../src/news-publication-cache.mjs';

const NOW = Date.UTC(2026, 9, 13, 17, 16); // 19:16 Europe/Berlin

function publication(createdAt = NOW, cardCount = 4) {
  return {
    createdAt,
    cardCount,
    rejected:0,
    items:[{ key:'header', kind:'header', method:'sendMessage', payload:{ text:'Ранковий огляд — 13.10.2026' } }]
  };
}

function outboxEnv() {
  const values = new Map();
  const outbox = {
    householdContextStorage:{
      async get(key) { return structuredClone(values.get(key)); },
      async put(key, value) { values.set(key, structuredClone(value)); }
    }
  };
  const env = {
    OUTBOX:{
      idFromName:name => name,
      get:() => ({ fetch:(url, init) => handleNewsPublicationCacheStorage(new Request(url, init), outbox) })
    }
  };
  return { env, outbox, values };
}

// Staging 13.10.2026: "/news" answered after 33 s because every request built
// the digest from the sources again.
test('a second news request within 45 minutes reuses the built digest', async () => {
  const { env } = outboxEnv();
  let builds = 0;
  let typing = 0;
  const build = async () => { builds += 1; return publication(NOW); };
  const onMiss = async () => { typing += 1; };

  const first = await cachedNewsPublication(env, NOW, build, { onMiss });
  const second = await cachedNewsPublication(env, NOW + 10 * 60 * 1000, build, { onMiss });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.deepEqual(second.publication, first.publication);
  assert.equal(builds, 1);
  assert.equal(typing, 1, 'typing is shown only while a digest is built');
});

test('the cached digest expires after 45 minutes and on the next Berlin day', () => {
  const entry = { publication:publication(NOW) };
  assert.ok(freshCachedPublication(entry, NOW + NEWS_PUBLICATION_CACHE_TTL_MS));
  assert.equal(freshCachedPublication(entry, NOW + NEWS_PUBLICATION_CACHE_TTL_MS + 1), null);
  const lateEvening = Date.UTC(2026, 9, 13, 21, 50); // 23:50 Berlin
  const afterMidnight = Date.UTC(2026, 9, 13, 22, 10); // 00:10 Berlin, next day
  assert.equal(freshCachedPublication({ publication:publication(lateEvening) }, afterMidnight), null);
  assert.equal(freshCachedPublication({ publication:publication(NOW + 1000) }, NOW), null, 'no digest from the future');
});

test('a digest without news cards is not cached, so the next request tries the sources again', async () => {
  const { env, values } = outboxEnv();
  let builds = 0;
  const build = async () => { builds += 1; return publication(NOW, 0); };
  await cachedNewsPublication(env, NOW, build);
  await cachedNewsPublication(env, NOW + 60 * 1000, build);
  assert.equal(builds, 2);
  assert.equal(values.size, 0);
});

test('without the outbox binding the digest is built every time', async () => {
  let builds = 0;
  const build = async () => { builds += 1; return publication(NOW); };
  await cachedNewsPublication({}, NOW, build);
  await cachedNewsPublication({}, NOW, build);
  assert.equal(builds, 2);
});

test('the daily run stores its digest for later "/news" requests', async () => {
  const { env, outbox } = outboxEnv();
  assert.equal(await storeCachedPublication(outbox.householdContextStorage, publication(NOW)), true);
  let builds = 0;
  const result = await cachedNewsPublication(env, NOW + 5 * 60 * 1000, async () => { builds += 1; return publication(); });
  assert.equal(result.cached, true);
  assert.equal(builds, 0);
});

test('the cache endpoint answers only internal POST requests with a known operation', async () => {
  const { outbox } = outboxEnv();
  assert.equal(await handleNewsPublicationCacheStorage(new Request('https://outbox.internal/other', { method:'POST', body:'{}' }), outbox), null);
  assert.equal(await handleNewsPublicationCacheStorage(new Request('https://example.com/news-publication-cache', { method:'POST', body:'{}' }), outbox), null);
  const bad = await handleNewsPublicationCacheStorage(new Request('https://outbox.internal/news-publication-cache', { method:'POST', body:'{"op":"drop"}' }), outbox);
  assert.equal(bad.status, 400);
});

// The hourly cron keeps the digest warm, so "/news" does not wait for a build.
test('the background run rebuilds a missing or 40-minute-old digest during the day only', async () => {
  const { newsPublicationNeedsRefresh } = await import('../src/news-publication-cache.mjs');
  const { outbox } = outboxEnv();
  const storage = outbox.householdContextStorage;
  assert.equal(await newsPublicationNeedsRefresh(storage, NOW), true, 'nothing cached yet');
  await storeCachedPublication(storage, publication(NOW));
  assert.equal(await newsPublicationNeedsRefresh(storage, NOW + 30 * 60 * 1000), false);
  assert.equal(await newsPublicationNeedsRefresh(storage, NOW + 40 * 60 * 1000), true);
  const night = Date.UTC(2026, 9, 14, 2, 0); // 04:00 Berlin
  assert.equal(await newsPublicationNeedsRefresh(storage, night), false, 'no rebuilds at night');
});

test('the refresh endpoint builds and stores a digest with cards, and skips a fresh one', async () => {
  const { refreshNewsPublicationCache } = await import('../src/runtime-news.mjs');
  const { outbox, values } = outboxEnv();
  outbox.env = {
    TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1',
    TELEGRAM_BOT_TOKEN:`12345:${'A'.repeat(32)}`, TELEGRAM_WEBHOOK_SECRET:'s'.repeat(32),
    TELEGRAM_INGRESS_ENABLED:'true', TELEGRAM_DELIVERY_ENABLED:'true',
    AI:{ async run(_model, input) { return { response:`Новина: ${input.messages?.at(-1)?.content.split('\n').at(-1) ?? input.text}` }; } }
  };
  const fresh = new Date(NOW - 2 * 60 * 60 * 1000).toUTCString();
  let sources = 0;
  const transport = async url => {
    const value = String(url);
    if (value.startsWith('https://api.telegram.org/')) throw new Error('a background build sends nothing to Telegram');
    sources += 1;
    if (value.includes('index~rss2.xml')) {
      return new Response(`<rss><channel><item><title>Katastrophenschutz in SH: Das sollten Haushalte wissen</title><link>https://www.ndr.de/nachrichten/schleswig-holstein/katastrophenschutz.html</link><description>Vorrat</description><pubDate>${fresh}</pubDate></item></channel></rss>`, { status:200 });
    }
    if (value.startsWith('https://www.ndr.de/')) {
      return new Response('<html><head><meta property="og:title" content="Katastrophenschutz in SH"><meta property="og:description" content="Vorrat und Warnung"><meta property="og:image" content="https://img.example.test/k.jpg"></head></html>', { status:200 });
    }
    return new Response('unavailable', { status:503 });
  };

  const first = await refreshNewsPublicationCache(outbox, NOW, transport);
  assert.equal(first.status, 'refreshed', JSON.stringify(first));
  assert.ok(first.cards >= 1);
  // The digest and the translation memo (TG-RUNTIME-023) are stored.
  assert.deepEqual([...values.keys()].sort(), ['telegram-news-publication-cache:v1', 'telegram-news-translation-memo:v1']);
  assert.ok(values.get('telegram-news-translation-memo:v1').entries.length >= 1);

  const used = sources;
  const second = await refreshNewsPublicationCache(outbox, NOW + 10 * 60 * 1000, transport);
  assert.equal(second.status, 'fresh');
  assert.equal(sources, used, 'a fresh digest is not rebuilt');
});
