// TG-RUNTIME-065: Workers Logs are kept by Cloudflare for 3 days, so log
// lines carry no secrets and no Telegram identifiers. Error messages can echo
// a request URL or a provider reply; this keeps their meaning and drops the
// rest: bot tokens, API keys, URL query strings and long numbers (chat and
// user IDs, phone numbers).
// No word boundary in front: Telegram URLs read "bot<id>:<secret>".
const BOT_TOKEN = /(?<!\d)\d{5,20}:[A-Za-z0-9_-]{20,}/gu;
const API_KEYS = /\b(?:klaz_live_|gsk_|sk-|phc_)[A-Za-z0-9_-]{8,}\b/gu;
const QUERY = /(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gu;
// Review (#065): also after "_" (user_123…) and before a full stop.
const LONG_NUMBER = /(?<![\d.])-?\d{7,}(?!\d|\.\d)/gu;

export function safeLogText(value, limit = 240) {
  return String(value ?? '')
    .replace(BOT_TOKEN, '<token>')
    .replace(API_KEYS, '<key>')
    .replace(QUERY, '$1?<query>')
    .replace(LONG_NUMBER, '<id>')
    .slice(0, limit);
}

// Source diagnostics for "housing_search_sources": an allowlist of fields, so
// a field added to a provider's page record later is never logged unchecked.
export function pageLog(pages) {
  return (Array.isArray(pages) ? pages : []).slice(0, 24).map(page => ({
    reason:String(page?.reason || 'unknown').slice(0, 40),
    httpStatus:Number(page?.httpStatus) || 0,
    bytes:Number(page?.bytesReceived ?? page?.bytes) || 0,
    durationMs:Number(page?.durationMs) || 0,
    ...(Number.isFinite(page?.matchedCount) ? { matched:page.matchedCount } : {}),
    ...(page?.supplemental ? { supplemental:true } : {}),
    ...(page?.step ? { step:String(page.step).slice(0, 20) } : {})
  }));
}

export function sourcesLog(sources) {
  return (Array.isArray(sources) ? sources : []).slice(0, 24).map(source => ({
    source:String(source?.source || 'unknown').slice(0, 40),
    status:String(source?.status || 'unknown').slice(0, 30),
    count:Number(source?.count) || 0,
    pages:pageLog(source?.pages)
  }));
}
