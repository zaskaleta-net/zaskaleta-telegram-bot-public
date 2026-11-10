import test from 'node:test';
import assert from 'node:assert/strict';
import { archivePilotBugReport, buildPilotReportId } from '../src/bug-report-bridge.mjs';

const config = { token:'123456789:' + 'A'.repeat(35) };
const NOW = Date.parse('2026-09-13T12:00:00Z');

test('bug report id is stable and contains no user identity', () => {
  const update = { update_id:51819911, message:{ message_id:42, from:{ id:908597048 } } };
  assert.equal(buildPilotReportId(update, NOW), 'R-20260913-51819911');
});

test('text-only bug report queues anonymized payload and follows trusted platform redirect', async () => {
  let captured = null;
  const update = {
    update_id:77,
    message:{
      message_id:12,
      chat:{ id:222222222, type:'private' },
      from:{ id:222222222, username:'tester', first_name:'Test' },
      text:'Кнопка не працює'
    }
  };

  const result = await archivePilotBugReport(update, config, NOW, async (url, options = {}) => {
    assert.match(String(url), /tg-bug-7f3c91-ingest$/u);
    assert.equal(options.redirect, 'follow');
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok:true, queued:true, report_id:'R-20260913-77' }), {
      status:200,
      headers:{ 'content-type':'application/json' }
    });
  });

  assert.equal(result.queued, true);
  assert.equal(result.reportId, 'R-20260913-77');
  assert.equal(result.attempts, 1);
  assert.equal(result.status, 200);
  assert.equal(captured.description, 'Кнопка не працює');
  assert.equal(captured.metadata.chat_type, 'private');
  assert.equal(captured.metadata.has_media, false);
  assert.equal('user_id' in captured.metadata, false);
  assert.equal('username' in captured.metadata, false);
  assert.equal(JSON.stringify(captured).includes('222222222'), false);
  assert.equal(JSON.stringify(captured).includes('tester'), false);
});

test('photo bug report archives bounded image and media group without reporter identity', async () => {
  let ingest = null;
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const update = {
    update_id:88,
    message:{
      message_id:15,
      media_group_id:'album-opaque-123',
      chat:{ id:333333333, type:'private' },
      from:{ id:333333333, username:'hidden-person' },
      photo:[{ file_id:'small', file_size:100 }, { file_id:'largest-safe', file_size:1200 }]
    }
  };

  const result = await archivePilotBugReport(update, config, NOW, async (url, options = {}) => {
    const target = String(url);
    if (/\/getFile$/u.test(target)) {
      assert.equal(JSON.parse(options.body).file_id, 'largest-safe');
      return new Response(JSON.stringify({ ok:true, result:{ file_path:'photos/report.jpg' } }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    if (/\/file\/bot/u.test(target)) {
      return new Response(jpeg, { status:200, headers:{ 'content-type':'image/jpeg', 'content-length':String(jpeg.byteLength) } });
    }
    if (/tg-bug-7f3c91-ingest$/u.test(target)) {
      assert.equal(options.redirect, 'follow');
      ingest = JSON.parse(options.body);
      return new Response(JSON.stringify({ ok:true, queued:true, report_id:'R-20260913-88' }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    throw new Error(`unexpected url ${target}`);
  });

  assert.equal(result.queued, true);
  assert.equal(result.mediaArchived, true);
  assert.equal(result.attempts, 1);
  assert.equal(ingest.media_kind, 'photo');
  assert.equal(ingest.media_mime, 'image/jpeg');
  assert.equal(typeof ingest.media_base64, 'string');
  assert.equal(ingest.metadata.has_media, true);
  assert.equal(ingest.metadata.media_group_id, 'album-opaque-123');
  assert.equal(JSON.stringify(ingest).includes('333333333'), false);
  assert.equal(JSON.stringify(ingest).includes('hidden-person'), false);
});

test('transient ingest transport failure is retried once', async () => {
  let calls = 0;
  const update = {
    update_id:99,
    message:{
      message_id:21,
      chat:{ id:444444444, type:'private' },
      from:{ id:444444444 },
      text:'E2E retry probe'
    }
  };

  const result = await archivePilotBugReport(update, config, NOW, async (url, options = {}) => {
    assert.match(String(url), /tg-bug-7f3c91-ingest$/u);
    assert.equal(options.redirect, 'follow');
    calls += 1;
    if (calls === 1) throw new Error('temporary network failure');
    return new Response(JSON.stringify({ ok:true, queued:true, report_id:'R-20260913-99' }), {
      status:200,
      headers:{ 'content-type':'application/json' }
    });
  });

  assert.equal(calls, 2);
  assert.equal(result.queued, true);
  assert.equal(result.reason, 'queued');
  assert.equal(result.attempts, 2);
  assert.equal(result.status, 200);
});
