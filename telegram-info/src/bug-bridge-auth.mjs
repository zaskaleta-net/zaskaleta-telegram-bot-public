const encoder = new TextEncoder();
const SIGNATURE_RE = /^v1=([0-9a-f]{64})$/u;
const DEFAULT_MAX_SKEW_SECONDS = 300;

function validSecret(secret) {
  return typeof secret === 'string' && secret.length >= 32 && secret.length <= 256 && /^[A-Za-z0-9_-]+$/u.test(secret);
}

function unixSeconds(now) {
  if (!Number.isFinite(now) || now < 0) return null;
  return Math.floor(now / 1000);
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const max = Math.max(x.length, y.length);
  for (let i = 0; i < max; i += 1) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export async function signBugBridgeBody(secret, body, now = Date.now()) {
  if (!validSecret(secret) || typeof body !== 'string') return null;
  const timestamp = unixSeconds(now);
  if (timestamp === null) return null;
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  return { timestamp:String(timestamp), signature:`v1=${bytesToHex(signature)}` };
}

export async function verifyBugBridgeSignature(secret, body, timestampValue, signatureValue, now = Date.now(), maxSkewSeconds = DEFAULT_MAX_SKEW_SECONDS) {
  if (!validSecret(secret) || typeof body !== 'string' || !/^\d{1,12}$/u.test(String(timestampValue || '')) || !SIGNATURE_RE.test(String(signatureValue || ''))) return false;
  const timestamp = Number(timestampValue);
  const current = unixSeconds(now);
  if (!Number.isSafeInteger(timestamp) || current === null || !Number.isFinite(maxSkewSeconds) || maxSkewSeconds < 0 || Math.abs(current - timestamp) > maxSkewSeconds) return false;
  const signed = await signBugBridgeBody(secret, body, timestamp * 1000);
  return !!signed && constantTimeEqual(signed.signature, String(signatureValue));
}

export function bugBridgeSecretIsValid(secret) {
  return validSecret(secret);
}
