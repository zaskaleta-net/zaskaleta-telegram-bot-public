// Preload in test runners only. Fail closed on real external fetch/TCP/TLS.
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import {
  assertOfflineFetchTarget,
  assertOfflineSocketConnect,
} from './ci-offline-network-policy.mjs';

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function offlineSocketConnect(...args) {
  assertOfflineSocketConnect(args);
  return Reflect.apply(originalSocketConnect, this, args);
};

const originalTlsConnect = tls.connect;
tls.connect = function offlineTlsConnect(...args) {
  assertOfflineSocketConnect(args);
  return Reflect.apply(originalTlsConnect, this, args);
};

syncBuiltinESMExports();

if (typeof globalThis.fetch !== 'function') {
  throw new Error('CI_NETWORK_GUARD_UNAVAILABLE');
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function offlineFetch(...args) {
  assertOfflineFetchTarget(args[0]);
  return Reflect.apply(originalFetch, this, args);
};

process.env.CI_OFFLINE_TEST_GUARD = 'enabled';
