import {
  housingActiveTransport as v21HousingActiveTransport,
  normalizeBuesumHousingText,
  normalizeBuesumRequest,
  parseJobcenterSearchCriteria,
  statewideHousingCopy
} from './housing-active-v21.mjs';
import { parseRoomSpec } from './rooms.mjs';

export { normalizeBuesumHousingText, normalizeBuesumRequest, parseJobcenterSearchCriteria, statewideHousingCopy };

const IMMO_HOSTS = new Set(['immobilienscout24.de', 'www.immobilienscout24.de']);
// ImmoScout search pages can be very large before script/style payloads are removed.
// Read a bounded raw page, compact it, then hand a <= legacy-parser-size response to v21.
const MAX_TARGETED_HTML_BYTES = 16 * 1024 * 1024;
const MAX_COMPACTED_HTML_BYTES = 1900 * 1024;

function roomTargets(criteria) {
  const spec = parseRoomSpec(criteria?.rooms);
  if (!spec || spec.min < 1 || spec.max > 5) return [];
  if (!Number.isInteger(spec.min) || !Number.isInteger(spec.max)) return [];
  if (spec.max - spec.min > 2) return [];
  const values = [];
  for (let room = spec.min; room <= spec.max; room += 1) values.push(room);
  return values;
}

function targetedImmoScoutUrls(rawUrl, criteria) {
  const rooms = roomTargets(criteria);
  if (!rooms.length) return [];
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { return []; }
  if (url.protocol !== 'https:' || !IMMO_HOSTS.has(url.hostname.toLowerCase())) return [];
  if (!/\/wohnung-mieten\/?$/u.test(url.pathname)) return [];
  return rooms.map(room => {
    const target = new URL(url.toString());
    target.pathname = target.pathname.replace(/\/wohnung-mieten\/?$/u, `/${room}-zimmer-wohnung-mieten`);
    return target.toString();
  });
}

async function readBoundedHtml(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength <= MAX_TARGETED_HTML_BYTES ? text : null;
  }
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_TARGETED_HTML_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream:true });
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function compactSearchHtml(source) {
  return String(source || '')
    .replace(/<!--[^]*?-->/gu, ' ')
    .replace(/<script\b[^>]*>[^]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[^]*?<\/style>/giu, ' ')
    .replace(/\s{3,}/gu, ' ');
}

function truncateUtf8(value, maxBytes) {
  const bytes = new TextEncoder().encode(String(value || ''));
  if (bytes.byteLength <= maxBytes) return String(value || '');
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function recognizableTargetedPage(html) {
  const source = String(html || '');
  if (/\/expose\/\d+/u.test(source)) return true;
  const plain = source.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ');
  return /(?:keine\s+(?:passenden?\s+)?(?:Wohnungen|Immobilien|Angebote|Treffer)|(?:0|aktuell\s+0)\s+(?:Miet)?wohnungen)/iu.test(plain);
}

async function compactTargetedHtml(response) {
  if (!response?.ok) return null;
  const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (type && !type.includes('text/html') && !type.includes('application/xhtml+xml')) return null;
  let html;
  try { html = await readBoundedHtml(response); } catch { return null; }
  if (html == null) return null;
  const compacted = compactSearchHtml(html);
  return recognizableTargetedPage(compacted) ? compacted : null;
}

function syntheticHtmlResponse(html, targetUrl) {
  const headers = new Headers();
  headers.set('content-type', 'text/html; charset=utf-8');
  const next = new Response(html, { status:200, headers });
  try { Object.defineProperty(next, 'url', { value:targetUrl }); } catch {}
  return next;
}

function roomScopedTransport(criteria, transport) {
  return async (url, options = {}) => {
    const targets = targetedImmoScoutUrls(url, criteria);
    if (!targets.length) return transport(url, options);

    // Room-range searches share the outer source timeout. Fetch scoped room pages in
    // parallel so a 3–4 request does not consume the whole budget on the first page.
    const attempts = await Promise.all(targets.map(async target => {
      try {
        const response = await transport(target, options);
        const html = await compactTargetedHtml(response);
        return html ? { target, html } : null;
      } catch {
        return null;
      }
    }));
    const readable = attempts.filter(Boolean);

    if (readable.length) {
      const perPageBudget = Math.max(256 * 1024, Math.floor(MAX_COMPACTED_HTML_BYTES / readable.length));
      const combined = readable.map(item => truncateUtf8(item.html, perPageBudget)).join('\n');
      return syntheticHtmlResponse(truncateUtf8(combined, MAX_COMPACTED_HTML_BYTES), readable[0].target);
    }

    // Preserve the previous stable path whenever every room-scoped route is unavailable
    // or returns markup we cannot safely recognize.
    return transport(url, options);
  };
}

export function housingActiveTransport(transport = fetch, options = {}) {
  return async (url, requestOptions = {}) => {
    let criteria = null;
    if (/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/u.test(String(url || '')) && typeof requestOptions.body === 'string') {
      try {
        const payload = JSON.parse(requestOptions.body);
        criteria = parseJobcenterSearchCriteria(payload?.text);
      } catch {}
    }
    const scoped = roomTargets(criteria).length ? roomScopedTransport(criteria, transport) : transport;
    return v21HousingActiveTransport(scoped, options)(url, requestOptions);
  };
}
