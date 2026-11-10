import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOBCENTER_BACKGROUND_TASK_PATH,
  handleDurableJobcenterBackgroundTask,
  shouldDelegateWholeKreisBackground
} from '../src/runtime.mjs';
import { JOBCENTER_BACKGROUND_TASK_HEADER } from '../src/runtime-jobcenter.mjs';

test('60161 only whole-Kreis callbacks are delegated to Durable Object execution', () => {
  const env = { OUTBOX:{} };
  assert.equal(shouldDelegateWholeKreisBackground({ district:true }, env), true);
  assert.equal(shouldDelegateWholeKreisBackground({ district:false }, env), false);
  assert.equal(shouldDelegateWholeKreisBackground({ district:true }, {}), false);
});

test('60161 Durable Object endpoint owns the long task after returning accepted', async () => {
  let releaseTask;
  const longTask = new Promise(resolve => { releaseTask = resolve; });
  const waits = [];
  const calls = [];
  const outbox = {
    env:{},
    ctx:{ waitUntil(promise){ waits.push(promise); } }
  };
  const request = new Request(`https://outbox.internal${JOBCENTER_BACKGROUND_TASK_PATH}`, {
    method:'POST',
    headers:{
      'content-type':'application/json',
      [JOBCENTER_BACKGROUND_TASK_HEADER]:'1'
    },
    body:JSON.stringify({ update_id:60161, callback_query:{ id:'district-callback' } })
  });

  const response = await handleDurableJobcenterBackgroundTask(request, outbox, {
    runTask(taskRequest, fallbackRequest) {
      calls.push({
        url:taskRequest.url,
        taskHeader:taskRequest.headers.get(JOBCENTER_BACKGROUND_TASK_HEADER),
        fallbackUrl:fallbackRequest.url
      });
      return longTask;
    }
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, 'telegram-jobcenter-search-durable-accepted');
  assert.equal(waits.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/telegram/stateless');
  assert.equal(calls[0].taskHeader, '1');
  assert.equal(new URL(calls[0].fallbackUrl).pathname, '/telegram/stateless');

  releaseTask(new Response(JSON.stringify({ ok:true, delivered:true }), {
    status:200,
    headers:{ 'content-type':'application/json' }
  }));
  await waits[0];
});

test('60161 Durable Object endpoint rejects an unprepared internal task', async () => {
  const waits = [];
  const outbox = {
    env:{},
    ctx:{ waitUntil(promise){ waits.push(promise); } }
  };
  const request = new Request(`https://outbox.internal${JOBCENTER_BACKGROUND_TASK_PATH}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:'{}'
  });

  const response = await handleDurableJobcenterBackgroundTask(request, outbox, {
    runTask(){ throw new Error('must not run'); }
  });

  assert.equal(response.status, 400);
  assert.equal(waits.length, 0);
});
