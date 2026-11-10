// Translations of news texts are kept between digest builds. The hourly
// background refresh (TG-RUNTIME-023) rebuilds the digest up to 17 times a
// day, mostly from the same headlines; without a memo every build paid the
// Workers AI model again (up to 16 calls). Only new texts are translated now.
const MEMO_KEY = 'telegram-news-translation-memo:v1';
// Durable Object values are limited to 128 KiB; the oldest entries go first.
const MAX_MEMO_BYTES = 100000;

export async function translationMemoKey(sourceLang, source) {
  const bytes = new TextEncoder().encode(`${sourceLang}\n${source}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function loadTranslationMemo(storage) {
  const memo = new Map();
  try {
    const stored = await storage?.get?.(MEMO_KEY);
    for (const entry of Array.isArray(stored?.entries) ? stored.entries : []) {
      if (Array.isArray(entry) && /^[0-9a-f]{64}$/u.test(String(entry[0])) && typeof entry[1] === 'string' && entry[1]) memo.set(entry[0], entry[1]);
    }
  } catch {}
  return memo;
}

// Map order is use order (a hit is moved to the end), so the newest entries
// are kept when the memo is trimmed.
export function trimmedMemoEntries(memo, maxBytes = MAX_MEMO_BYTES) {
  const kept = [];
  let bytes = 0;
  for (const entry of [...memo.entries()].reverse()) {
    const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    kept.push(entry);
  }
  return kept.reverse();
}

export async function saveTranslationMemo(storage, memo) {
  if (typeof storage?.put !== 'function' || !(memo instanceof Map)) return false;
  try {
    await storage.put(MEMO_KEY, { entries:trimmedMemoEntries(memo) });
    return true;
  } catch {
    return false;
  }
}

// Runs build(env) with a memo the translator reads and fills, then stores it.
export async function withTranslationMemo(storage, env, build) {
  const memo = await loadTranslationMemo(storage);
  try {
    return await build({ ...env, NEWS_TRANSLATION_MEMO:memo });
  } finally {
    await saveTranslationMemo(storage, memo);
  }
}
