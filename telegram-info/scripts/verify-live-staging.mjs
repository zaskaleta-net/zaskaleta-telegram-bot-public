import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export const STAGING_URL = 'https://zaskaleta-info-telegram-staging.zaskaleta86.workers.dev';

const EXPECTED = [
  { name: 'health', path: '/health', method: 'GET', status: 200 },
  { name: 'unknown route', path: '/not-a-route', method: 'GET', status: 404, body: { error: 'Not found' } },
  { name: 'webhook GET', path: '/telegram/stateless', method: 'GET', status: 404, body: { error: 'Not found' } },
  { name: 'protected webhook', path: '/telegram/stateless', method: 'POST', status: 401, body: { error: 'Unauthorized' } }
];

async function readResponse(response) {
  const limit = 4096;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new Error('Response exceeds 4096 bytes');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function verifyLiveStaging(fetchImpl = fetch, base = STAGING_URL) {
  assert.equal(base, STAGING_URL, 'Only the reviewed staging host is allowed');
  const results = [];

  for (const check of EXPECTED) {
    const options = {
      method: check.method,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    };
    if (check.method === 'POST') options.body = '{}';

    let response;
    try {
      response = await fetchImpl(base + check.path, options);
    } catch (error) {
      throw new Error(`${check.name}: request failed (${error?.name || 'Error'})`);
    }

    const type = response.headers.get('content-type') || '';
    let body;
    try {
      const text = await readResponse(response);
      if (!/^application\/json(?:\s*;|\s*$)/i.test(type)) throw new Error('Non-JSON content type');
      body = JSON.parse(text);
    } catch (error) {
      throw new Error(`${check.name}: HTTP ${response.status}, content-type ${type || 'missing'}, ${error.message}. No response body is logged.`);
    }

    assert.equal(response.status, check.status, `${check.name}: unexpected HTTP status`);

    if (check.name === 'health') {
      assert.equal(body.ok, true, 'health: ok must be true');
      assert.equal(body.service, 'zaskaleta-info-telegram', 'health: unexpected service');
      assert.equal(body.delivery, true, 'health: delivery must be enabled');
      assert.match(
        String(body.versionId || ''),
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        'health: valid active version id is required'
      );
    } else {
      assert.deepEqual(body, check.body, `${check.name}: unexpected response`);
    }

    results.push({ name: check.name, status: response.status, contentType: type, passed: true });
  }

  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = await verifyLiveStaging();
    for (const result of results) {
      console.log(`PASS ${result.name}: HTTP ${result.status}, ${result.contentType}`);
    }
    console.log(`PASS: ${results.length} bounded live-staging checks; delivery enabled and unauthenticated webhook remains fail-closed.`);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
