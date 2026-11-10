import test from 'node:test';
import assert from 'node:assert/strict';
import { retryHealthProbe } from '../scripts/cloudflare-health-retry.mjs';

test('health probe retries a transient timeout and succeeds without failing the release', async () => {
  let calls = 0;
  const result = await retryHealthProbe({
    url:'https://example.test/health',
    expectedVersionId:'11111111-1111-1111-1111-111111111111',
    attempts:3,
    delayMs:0,
    sleep:async()=>{},
    requestJson:async()=>{
      calls += 1;
      if (calls === 1) {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      }
      return {
        status:200,
        body:{
          ok:true,
          delivery:true,
          versionId:'11111111-1111-1111-1111-111111111111'
        }
      };
    }
  });

  assert.equal(calls,2);
  assert.equal(result.attempt,2);
  assert.equal(result.lastError,null);
  assert.equal(result.health.status,200);
});

test('health probe waits for the expected version instead of accepting stale health', async () => {
  const seen=[];
  const result = await retryHealthProbe({
    url:'https://example.test/health',
    expectedVersionId:'22222222-2222-2222-2222-222222222222',
    attempts:3,
    delayMs:0,
    sleep:async()=>{},
    requestJson:async()=>{
      const versionId = seen.length === 0
        ? '11111111-1111-1111-1111-111111111111'
        : '22222222-2222-2222-2222-222222222222';
      seen.push(versionId);
      return { status:200, body:{ ok:true, delivery:true, versionId } };
    }
  });

  assert.equal(result.attempt,2);
  assert.equal(result.health.body.versionId,'22222222-2222-2222-2222-222222222222');
});

test('health probe exhausts transient failures without inventing a healthy response', async () => {
  const error = new Error('network unavailable');
  const result = await retryHealthProbe({
    url:'https://example.test/health',
    attempts:2,
    delayMs:0,
    sleep:async()=>{},
    requestJson:async()=>{ throw error; }
  });

  assert.equal(result.health,null);
  assert.equal(result.lastError,error);
  assert.equal(result.attempt,2);
});

test('health probe can wait through a long stale-version propagation window', async () => {
  let calls = 0;
  const expected = '33333333-3333-3333-3333-333333333333';
  const stale = '11111111-1111-1111-1111-111111111111';
  const result = await retryHealthProbe({
    url:'https://example.test/health',
    expectedVersionId:expected,
    attempts:60,
    delayMs:0,
    sleep:async()=>{},
    requestJson:async()=>{
      calls += 1;
      return {
        status:200,
        body:{
          ok:true,
          delivery:true,
          versionId:calls < 60 ? stale : expected
        }
      };
    }
  });

  assert.equal(calls,60);
  assert.equal(result.attempt,60);
  assert.equal(result.health.body.versionId,expected);
  assert.equal(result.lastError,null);
});
