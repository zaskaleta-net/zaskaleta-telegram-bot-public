import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  assertLoopbackHost,
  assertOfflineFetchTarget,
  assertOfflineSocketConnect,
} from './ci-offline-network-policy.mjs';

test('rejects external hostnames and addresses without connecting', () => {
  for (const host of [
    'api.telegram.org', 'api.cloudflare.com', 'example.com', '8.8.8.8',
    '10.0.0.1', '192.168.1.1', '2001:4860:4860::8888',
  ]) {
    assert.throws(() => assertLoopbackHost(host), /CI_NETWORK_EGRESS_DENIED/);
  }
});

test('allows loopback only for local test fixtures', () => {
  for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '::1', '[::1]']) {
    assert.doesNotThrow(() => assertLoopbackHost(host));
  }
});

test('denies actual Telegram and Cloudflare URLs before calling fetch', () => {
  assert.throws(() => assertOfflineFetchTarget('https://api.telegram.org/botREDACTED/setWebhook'),
    /CI_NETWORK_EGRESS_DENIED/);
  assert.throws(() => assertOfflineFetchTarget(new URL('https://api.cloudflare.com/client/v4')),
    /CI_NETWORK_EGRESS_DENIED/);
  assert.doesNotThrow(() => assertOfflineFetchTarget('http://127.0.0.1:9999/test'));
  assert.doesNotThrow(() => assertOfflineFetchTarget('data:text/plain,fixture'));
});

test('denies outbound net and TLS connect argument forms without opening sockets', () => {
  for (const args of [
    [{ host: 'api.telegram.org', port: 443 }],
    [443, 'api.telegram.org'],
    [{ host: '8.8.8.8', port: 53 }],
  ]) {
    assert.throws(() => assertOfflineSocketConnect(args), /CI_NETWORK_EGRESS_DENIED/);
  }
  assert.doesNotThrow(() => assertOfflineSocketConnect([{ host: '127.0.0.1', port: 8080 }]));
  assert.doesNotThrow(() => assertOfflineSocketConnect([8080, 'localhost']));
  assert.doesNotThrow(() => assertOfflineSocketConnect([{ path: '/tmp/test-fixture.sock' }]));
});

test('absolute preload activates in Node child processes with different working directories', () => {
  const qaDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(qaDir, '..', '..');
  const guard = join(qaDir, 'ci-offline-network-guard.mjs');
  const inspect = [
    '-e',
    "process.stdout.write([process.env.CI_OFFLINE_TEST_GUARD, require('node:net').Socket.prototype.connect.name].join(':'))",
  ];
  for (const cwd of [repoRoot, join(repoRoot, 'telegram-info')]) {
    const result = spawnSync(process.execPath, inspect, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: `--import=${guard}` },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'enabled:offlineSocketConnect');
  }
});

test('CI full suite runs only in a read-only, network-none pinned container', () => {
  const qaDir = dirname(fileURLToPath(import.meta.url));
  const workflow = readFileSync(resolve(qaDir, '..', 'workflows', 'standalone-telegram-ci.yml'), 'utf8');
  const suite = workflow.split('      - name: Telegram full suite (OS-isolated; no outbound network)')[1]
    ?.split('      - name: ')[0];
  assert.ok(suite, 'full suite step must be present');
  for (const expected of [
    /node:22\.23\.4-bookworm@sha256:[a-f0-9]{64}/u,
    /docker pull "\$image"/u,
    /docker run --rm --pull=never/u,
    /--network none/u,
    /--cap-drop ALL/u,
    /--security-opt no-new-privileges/u,
    /--read-only/u,
    /--volume "\$\{GITHUB_WORKSPACE\}:\/workspace:ro"/u,
    /--env NODE_OPTIONS=--import=\/workspace\/\.github\/qa\/ci-offline-network-guard\.mjs/u,
    /"\$image" npm test/u,
  ]) {
    assert.match(suite, expected);
  }
  assert.doesNotMatch(suite, /--network (?:host|bridge)|--privileged|docker\.sock/iu);
  assert.doesNotMatch(suite, /^\s*npm test\s*$/mu); // no fallback host command
});
