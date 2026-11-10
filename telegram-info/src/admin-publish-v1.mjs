export const MANUAL_BUCKET_MS = 15 * 60 * 1000;
export const INTERNAL_PUBLISH_PATH = '/admin-publish-v1';

const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,96}$/u;

export function normalizeManualPublishRequest(value, now = Date.now()) {
  if (!value || value.type !== 'digest' || !Number.isFinite(now) || now < 0) return null;
  const idempotencyKey = String(value.idempotency_key || value.idempotencyKey || `digest:${Math.floor(now / MANUAL_BUCKET_MS)}`).trim();
  if (!IDEMPOTENCY_RE.test(idempotencyKey)) return null;
  return { type:'digest', idempotencyKey };
}

export function manualPublishMarkerKey(chatId, idempotencyKey) {
  if (!Number.isSafeInteger(chatId) || chatId >= 0 || !IDEMPOTENCY_RE.test(String(idempotencyKey || ''))) return null;
  return `telegram-manual-publish:v1:${chatId}:${idempotencyKey}`;
}
