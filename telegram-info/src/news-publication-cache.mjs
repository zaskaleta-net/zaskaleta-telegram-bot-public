// A news digest takes 25–35 s to build: feeds, article pages, translation and
// weather. Staging 13.10.2026: "/news" answered after 33 s. A built publication
// is kept in the outbox Durable Object and reused on the same Berlin day. The
// hourly cron rebuilds it in the background once it is 40 minutes old, so a
// request finds a digest at most about an hour old and answers at once.
import { readBoundedJSON } from './pilot-security.mjs';
import { berlinNewsDateKey } from './pilot-community.mjs';

export const NEWS_PUBLICATION_CACHE_PATH = '/news-publication-cache';
export const NEWS_PUBLICATION_CACHE_TTL_MS = 75 * 60 * 1000;
export const NEWS_PUBLICATION_REFRESH_AFTER_MS = 40 * 60 * 1000;
// Background rebuilds run 06:00–22:59 Berlin time only.
const REFRESH_FIRST_HOUR = 6;
const REFRESH_LAST_HOUR = 22;
export const NEWS_PUBLICATION_CACHE_KEY = 'telegram-news-publication-cache:v1';
const CACHE_KEY = NEWS_PUBLICATION_CACHE_KEY;
const CALL_TIMEOUT_MS = 1500;
const MAX_BODY_BYTES = 262144;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
});

// A digest without news cards (sources down) is not kept: the next request
// should try the sources again.
function cacheable(publication) {
  return Array.isArray(publication?.items) && publication.items.length > 0
    && Number(publication.cardCount) > 0
    && Number.isFinite(Number(publication.createdAt));
}

export function freshCachedPublication(entry, now = Date.now()) {
  const publication = entry?.publication;
  if (!cacheable(publication)) return null;
  const createdAt = Number(publication.createdAt);
  if (createdAt > now || now - createdAt > NEWS_PUBLICATION_CACHE_TTL_MS) return null;
  // The header and the weather brief carry the date.
  if (berlinNewsDateKey(createdAt) !== berlinNewsDateKey(now)) return null;
  return publication;
}

function berlinHour(now) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Berlin', hour:'2-digit', hourCycle:'h23' }).format(new Date(now)));
}

// True when the background run should build a new digest now.
export async function newsPublicationNeedsRefresh(storage, now = Date.now()) {
  const hour = berlinHour(now);
  if (hour < REFRESH_FIRST_HOUR || hour > REFRESH_LAST_HOUR) return false;
  let entry = null;
  try { entry = await storage?.get?.(CACHE_KEY); } catch {}
  const fresh = freshCachedPublication(entry, now);
  return !fresh || now - Number(fresh.createdAt) >= NEWS_PUBLICATION_REFRESH_AFTER_MS;
}

export async function storeCachedPublication(storage, publication) {
  if (typeof storage?.put !== 'function' || !cacheable(publication)) return false;
  try {
    await storage.put(CACHE_KEY, { publication });
    return true;
  } catch {
    return false;
  }
}

export async function handleNewsPublicationCacheStorage(request, outbox) {
  let url;
  try { url = new URL(request?.url || ''); } catch { return null; }
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== NEWS_PUBLICATION_CACHE_PATH) return null;
  const storage = outbox?.householdContextStorage;
  if (typeof storage?.get !== 'function') return json({ status:'unavailable' }, 503);
  const parsed = await readBoundedJSON(request.clone(), MAX_BODY_BYTES);
  const body = parsed.error ? null : parsed.value;
  if (body?.op === 'get') {
    const publication = freshCachedPublication(await storage.get(CACHE_KEY), Number(body.now));
    return json({ status:'ok', publication });
  }
  if (body?.op === 'put') {
    return json({ status:(await storeCachedPublication(storage, body.publication)) ? 'ok' : 'skipped' });
  }
  return json({ status:'bad_operation' }, 400);
}

async function cacheCall(env, payload) {
  if (!env?.OUTBOX) return null;
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const stub = env.OUTBOX.get(env.OUTBOX.idFromName('telegram-pilot-v1'));
        const response = await stub.fetch(`https://outbox.internal${NEWS_PUBLICATION_CACHE_PATH}`, {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          body:JSON.stringify(payload)
        });
        if (!response.ok) return null;
        const parsed = await readBoundedJSON(response, MAX_BODY_BYTES);
        return parsed.error ? null : parsed.value;
      })(),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), CALL_TIMEOUT_MS); })
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// onMiss runs only when the digest has to be built (e.g. a typing indicator).
export async function cachedNewsPublication(env, now, build, { onMiss = null } = {}) {
  const cached = freshCachedPublication(await cacheCall(env, { op:'get', now }), now);
  if (cached) return { publication:cached, cached:true };
  if (typeof onMiss === 'function') await onMiss();
  const publication = await build();
  await cacheCall(env, { op:'put', publication });
  return { publication, cached:false };
}
