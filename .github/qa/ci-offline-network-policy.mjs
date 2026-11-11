// Pure destination policy: never initiate a network operation in this module.
const LOOPBACK_NAME = new Set([
  'localhost', 'localhost.', '::1', '[::1]',
  '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1',
]);

export function assertLoopbackHost(host) {
  const normalized = String(host ?? 'localhost').trim().toLowerCase();
  if (LOOPBACK_NAME.has(normalized)) return;
  if (/^127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(normalized) &&
      normalized.split('.').every((part) => Number(part) <= 255)) return;
  throw new Error('CI_NETWORK_EGRESS_DENIED');
}

export function assertOfflineFetchTarget(target) {
  const input = target?.url ?? target;
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error('CI_NETWORK_EGRESS_DENIED');
  }
  if (url.protocol === 'data:') return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('CI_NETWORK_EGRESS_DENIED');
  }
  assertLoopbackHost(url.hostname);
}

export function assertOfflineSocketConnect(args) {
  const first = args[0];
  const options = Array.isArray(first) ? first : args;
  const input = options[0];
  if (typeof input === 'string' && input.startsWith('/')) return; // Unix test socket
  if (input && typeof input === 'object') {
    if (typeof input.path === 'string' && input.path.startsWith('/')) return;
    assertLoopbackHost(input.host ?? input.hostname);
    return;
  }
  if (typeof input === 'number') {
    assertLoopbackHost(typeof options[1] === 'string' ? options[1] : 'localhost');
    return;
  }
  throw new Error('CI_NETWORK_EGRESS_DENIED');
}
