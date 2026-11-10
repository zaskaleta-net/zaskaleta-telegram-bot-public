import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const env = {
  CONTROL_AUTH_TOKEN: 'x'.repeat(40),
  TELEGRAM_WORKER_URL: 'https://example.invalid',
};

test('public health is non-sensitive and read-only', async () => {
  const response = await worker.fetch(new Request('https://control.example/health'), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'healthy');
  assert.equal(body.mode, 'read-only');
  assert.equal(JSON.stringify(body).includes(env.CONTROL_AUTH_TOKEN), false);
});

test('MCP rejects missing authorization', async () => {
  const response = await worker.fetch(new Request('https://control.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }), env);
  assert.equal(response.status, 401);
});

test('MCP lists only the two read-only tools', async () => {
  const response = await worker.fetch(new Request('https://control.example/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.CONTROL_AUTH_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  }), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.result.tools.map((tool) => tool.name), [
    'telegram_worker_health',
    'telegram_webhook_status',
  ]);
});

test('unknown routes are 404', async () => {
  const response = await worker.fetch(new Request('https://control.example/nope'), env);
  assert.equal(response.status, 404);
});
