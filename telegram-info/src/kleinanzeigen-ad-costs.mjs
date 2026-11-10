// TG-RUNTIME-063: the running costs of one Kleinanzeigen flat ad. Result
// pages show only the rent (Kaltmiete); the ad page carries Nebenkosten,
// Heizkosten and Warmmiete in its tracking data:
//   "ad_attributes":"…|nebenkosten_i:150|heizkosten_i:200|warmmiete_i:1170|…"
import { formatEuro } from './listing-format.mjs';

const AD_URL = /^https:\/\/(?:www\.)?kleinanzeigen\.de\/s-anzeige\/[^?#]*\/(\d{6,12})-203-\d+(?:[?#].*)?$/u;
const HOST_RE = /^(?:www\.)?kleinanzeigen\.de$/iu;
const MAX_BYTES = 2 * 1024 * 1024;
const HEADERS = Object.freeze({
  accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'accept-language':'de-DE,de;q=0.9',
  'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
});

export function kleinanzeigenAdId(url) {
  return AD_URL.exec(String(url || ''))?.[1] || null;
}

function euros(attributes, name) {
  const match = new RegExp(`(?:^|\\|)${name}_i:(\\d{1,5})(?:\\||$)`, 'u').exec(attributes);
  return match ? Number(match[1]) : null;
}

// null when the page is not this ad's page (another ad, a challenge, no data).
export function parseKleinanzeigenAdCosts(html, adId) {
  const source = String(html || '');
  if (!adId || !source.includes(`"adid":"${adId}"`)) return null;
  const attributes = /"ad_attributes":"([^"]{0,4000})"/u.exec(source)?.[1];
  if (attributes == null) return null;
  return {
    nebenkosten:euros(attributes, 'nebenkosten'),
    heizkosten:euros(attributes, 'heizkosten'),
    warmmiete:euros(attributes, 'warmmiete')
  };
}

async function readText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return text.length > MAX_BYTES ? null : text;
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream:true });
    }
  } catch {
    return null;
  }
  return text + decoder.decode();
}

export async function fetchKleinanzeigenAdCosts(url, transport = fetch, signal) {
  const adId = kleinanzeigenAdId(url);
  if (!adId) return null;
  try {
    const response = await transport(String(url), { method:'GET', headers:HEADERS, redirect:'follow', signal });
    if (!response?.ok) return null;
    if (response.url) {
      const final = new URL(response.url);
      if (final.protocol !== 'https:' || !HOST_RE.test(final.hostname)) return null;
    }
    return parseKleinanzeigenAdCosts(await readText(response), adId);
  } catch {
    return null;
  }
}

// --- Bruttokaltmiete check (watch alerts and search cards) --------------------
// item: a listing with price, limit (the Jobcenter limit it was checked
// against) and costs (the result above, or { unchecked:true }).

// Many landlords enter the Warmmiete as the price (live: 770 € with
// warmmiete_i:770, Kaltmiete 615 + NK 155). Then the Nebenkosten are already
// in the price, and the Bruttokaltmiete is not above it.
function warmPrice(item) {
  const warm = item?.costs?.warmmiete;
  return Number.isFinite(warm) && Number(item?.price) >= warm;
}

function limitNote(item) {
  return Number.isFinite(item?.limit) ? ` (норма до ${formatEuro(item.limit)} €)` : '';
}

// The ad page was read, the price is the Kaltmiete, and Kaltmiete +
// Nebenkosten is over the limit.
export function adCostsOverLimit(item) {
  const nk = item?.costs?.nebenkosten;
  return Number.isFinite(nk) && !warmPrice(item) && Number.isFinite(Number(item?.price)) && Number.isFinite(item?.limit) && Number(item.price) + nk > item.limit;
}

export function adCostsLine(item) {
  const costs = item?.costs;
  if (!costs) return null;
  if (costs.unchecked) return 'Nebenkosten не перевірено — дивіться в оголошенні.';
  if (warmPrice(item)) return `Ціна ${formatEuro(item.price)} € — це Warmmiete (Nebenkosten і Heizkosten уже враховано); Bruttokaltmiete не вища за неї${limitNote(item)}.`;
  if (!Number.isFinite(costs.nebenkosten)) return 'Nebenkosten в оголошенні не вказано — уточніть в орендодавця.';
  const sum = `Kaltmiete ${formatEuro(item.price)} € + Nebenkosten ${formatEuro(costs.nebenkosten)} € = ${formatEuro(Number(item.price) + costs.nebenkosten)} € Bruttokaltmiete`;
  return adCostsOverLimit(item)
    ? `⛔ ${sum} — вище норми ${formatEuro(item.limit)} € для вашої сім'ї.`
    : `${sum}${limitNote(item)}`;
}

export const AD_COSTS_MAX_MS = 3000;
const AD_COSTS_MIN_MS = 500;

// Review finding (#064): the radius search runs under a 22 s watchdog
// (12 s search + 8 s cards). The ad pages only use time left inside the
// search's own 12 s, so the whole search never takes longer than before.
export function adCostsTimeLeft(searchStarted, searchWindowMs, now = Date.now()) {
  return Math.max(0, Math.min(AD_COSTS_MAX_MS, searchStarted + searchWindowMs - now));
}

// Search cards: the ad pages of the Kleinanzeigen listings on one page, at
// once. A page that cannot be read in time (or a used-up provider budget)
// gives { unchecked:true }, never an error; with too little time left no
// page is requested.
export async function withKleinanzeigenAdCosts(listings, transport = fetch, { timeoutMs = AD_COSTS_MAX_MS } = {}) {
  const items = Array.isArray(listings) ? listings : [];
  const checkable = item => kleinanzeigenAdId(item?.url) && Number.isFinite(item?.limit);
  if (timeoutMs < AD_COSTS_MIN_MS) return items.map(item => (checkable(item) ? { ...item, costs:{ unchecked:true } } : item));
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    return await Promise.all(items.map(async item => {
      if (!checkable(item)) return item;
      const costs = await Promise.race([fetchKleinanzeigenAdCosts(item.url, transport, AbortSignal.timeout(timeoutMs)), deadline]);
      return { ...item, costs:costs || { unchecked:true } };
    }));
  } finally {
    clearTimeout(timer);
  }
}
