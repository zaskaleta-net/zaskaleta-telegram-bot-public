import test from 'node:test';
import assert from 'node:assert/strict';
import { archivePilotBugReport } from '../src/bug-report-bridge.mjs';
import { verifyBugBridgeSignature } from '../src/bug-bridge-auth.mjs';

const NOW = Date.parse('2026-09-14T12:00:00Z');
const SECRET = 'H'.repeat(48);

test('configured bridge secret replaces legacy marker with HMAC headers', async () => {
  const update = {
    update_id:141,
    message:{
      message_id:22,
      chat:{ id:555555555, type:'private' },
      from:{ id:555555555 },
      text:'HMAC bridge test'
    }
  };
  let captured = null;
  const result = await archivePilotBugReport(
    update,
    { token:'123456789:' + 'A'.repeat(35), bugBridgeHmacSecret:SECRET },
    NOW,
    async (url, options = {}) => {
      assert.match(String(url), /tg-bug-7f3c91-ingest$/u);
      captured = { headers:options.headers, body:options.body };
      return new Response(JSON.stringify({ ok:true, queued:true, report_id:'R-20260914-141' }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
  );

  assert.equal(result.queued, true);
  assert.equal(captured.headers['x-zaskaleta-bridge'], undefined);
  assert.match(captured.headers['x-zaskaleta-timestamp'], /^\d{10}$/u);
  assert.match(captured.headers['x-zaskaleta-signature'], /^v1=[0-9a-f]{64}$/u);
  assert.equal(
    await verifyBugBridgeSignature(
      SECRET,
      captured.body,
      captured.headers['x-zaskaleta-timestamp'],
      captured.headers['x-zaskaleta-signature'],
      NOW
    ),
    true
  );
  assert.equal(captured.body.includes(SECRET), false);
  assert.equal(captured.body.includes('555555555'), false);
});
