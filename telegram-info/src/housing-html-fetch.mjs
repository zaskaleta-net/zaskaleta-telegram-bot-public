// Shared bounded HTML fetch for public housing portals: short timeout, a hard
// byte cap while streaming, and an HTTPS + host check on the final URL. It
// never throws; failures come back as a fixed reason for the source log.
export const PUBLIC_HTML_MAX_BYTES = 2 * 1024 * 1024;

const HEADERS = Object.freeze({
  accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
  'accept-language':'de-DE,de;q=0.9,en;q=0.5',
  'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
});

export function hostAllowed(hostname, allowedHost) {
  const actual = String(hostname || '').toLowerCase();
  const allowed = String(allowedHost || '').toLowerCase();
  return !!allowed && (actual === allowed || actual === `www.${allowed}`);
}

async function cancelBody(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

async function readBoundedText(response, maxBytes, progress) {
  const type = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (type && !type.includes('text/html') && !type.includes('application/xhtml+xml') && !type.includes('text/plain')) {
    await cancelBody(response);
    return { html:null, reason:'unsupported_content_type' };
  }
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelBody(response);
    return { html:null, reason:'response_too_large' };
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    progress.bytesReceived = new TextEncoder().encode(text).byteLength;
    return progress.bytesReceived <= maxBytes ? { html:text, reason:'read' } : { html:null, reason:'response_too_large' };
  }
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { html:text + decoder.decode(), reason:'read' };
      progress.bytesReceived += value.byteLength;
      if (progress.bytesReceived > maxBytes) {
        await reader.cancel().catch(() => {});
        return { html:null, reason:'response_too_large' };
      }
      text += decoder.decode(value, { stream:true });
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export async function fetchPublicHtml(url, { allowedHost, transport = fetch, timeoutMs = 6000, maxBytes = PUBLIC_HTML_MAX_BYTES, redirect = 'follow' } = {}) {
  const started = Date.now();
  const progress = { httpStatus:0, bytesReceived:0 };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let result;
  try {
    response = await transport(url, { method:'GET', headers:HEADERS, redirect, signal:controller.signal });
    progress.httpStatus = Number(response?.status) || 0;
    if (response?.url) {
      let finalUrl = null;
      try { finalUrl = new URL(response.url); } catch {}
      if (!finalUrl || finalUrl.protocol !== 'https:' || !hostAllowed(finalUrl.hostname, allowedHost)) {
        await cancelBody(response);
        result = { html:null, reason:'rejected_redirect' };
      }
    }
    if (!result && redirect === 'manual' && progress.httpStatus >= 300 && progress.httpStatus < 400) {
      const location = String(response.headers?.get?.('location') || '');
      await cancelBody(response);
      result = { html:null, reason:'redirect', location };
    }
    if (!result && !response?.ok) {
      await cancelBody(response);
      result = { html:null, reason:'http_error' };
    }
    result ||= await readBoundedText(response, maxBytes, progress);
  } catch {
    await cancelBody(response);
    result = { html:null, reason:controller.signal.aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timeout);
  }
  return { ...result, ...progress, durationMs:Date.now() - started };
}

export function pageDiagnostic(page, parsed = null) {
  return {
    reason:page.html == null ? page.reason : parsed?.recognized ? 'parsed' : 'unrecognized_html',
    httpStatus:page.httpStatus,
    bytesReceived:page.bytesReceived,
    durationMs:page.durationMs,
    parsedCount:parsed ? parsed.parsedCount ?? 0 : 0,
    matchedCount:parsed?.listings?.length || 0
  };
}

export function decodeHtmlEntities(value) {
  const named = new Map([
    ['amp','&'],['quot','"'],['apos',"'"],['lt','<'],['gt','>'],['nbsp',' '],['euro','€'],['sup2','²'],
    ['auml','ä'],['Auml','Ä'],['ouml','ö'],['Ouml','Ö'],['uuml','ü'],['Uuml','Ü'],['szlig','ß']
  ]);
  return String(value || '')
    .replace(/&([a-zA-Z0-9]+);/gu, (all, name) => named.has(name) ? named.get(name) : all)
    .replace(/&#(\d+);/gu, (all, number) => {
      const code = Number(number);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    })
    .replace(/&#x([0-9a-f]+);/giu, (all, number) => {
      const code = Number.parseInt(number, 16);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    });
}

export function htmlText(value, max = 4000) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/giu, ' ')
    .replace(/<[^>]+>/gu, ' '))
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

export function numberDe(value) {
  let text = String(value ?? '').replace(/\s/gu, '').replace(/€/gu, '');
  if (!text) return null;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/u.test(text)) text = text.replace(/\./gu, '').replace(',', '.');
  else if (text.includes(',')) text = text.replace(/\./gu, '').replace(',', '.');
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

// Diacritics folded the way both portals build their URL slugs (ü -> u).
export function portalSlug(value) {
  return String(value || '')
    .replace(/ß/gu, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}
