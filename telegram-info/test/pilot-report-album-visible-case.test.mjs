import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePilotCommunityUpdate } from '../src/pilot-community.mjs';

const config = {
  chatId:-1001234567890,
  chatIds:[-1001234567890],
  adminUserIds:[111111111],
  token:'123456789:abcdefghijklmnopqrstuvwxyzABCDEFGH_123456',
  secret:'abcdefghijklmnopqrstuvwxyzABCDEFGH_1234567890'
};

const NOW = Date.parse('2026-09-13T19:43:00Z');
const PROMPT = '🐞 Повідомлення про помилку\n\nНадішліть скріншот';
const CASE_ID = 'R-20260913-51820501';

function albumUpdate(updateId, messageId, fileId) {
  return {
    update_id:updateId,
    message:{
      message_id:messageId,
      media_group_id:'opaque-album-case-1',
      chat:{ id:222222222, type:'private' },
      from:{ id:222222222 },
      photo:[{ file_id:fileId, file_size:4 }],
      reply_to_message:{ text:PROMPT }
    }
  };
}

test('one Telegram album produces one visible case id while preserving every photo', async () => {
  const calls = [];
  const ingested = [];
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

  const transport = async (url, options = {}) => {
    const target = String(url);
    let body = null;
    if (typeof options.body === 'string') {
      try { body = JSON.parse(options.body); } catch {}
    }
    calls.push({ target, body });

    if (/\/getFile$/u.test(target)) {
      return new Response(JSON.stringify({ ok:true, result:{ file_path:`photos/${body.file_id}.jpg` } }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    if (/\/file\/bot/u.test(target)) {
      return new Response(jpeg, {
        status:200,
        headers:{ 'content-type':'image/jpeg', 'content-length':String(jpeg.byteLength) }
      });
    }
    if (/tg-bug-7f3c91-ingest$/u.test(target)) {
      ingested.push(body);
      const first = body.report_id === CASE_ID;
      return new Response(JSON.stringify({
        ok:true,
        queued:true,
        report_id:body.report_id,
        case_id:CASE_ID,
        group_first:first
      }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    if (/\/copyMessage$/u.test(target)) {
      return new Response(JSON.stringify({ ok:true, result:{ message_id:900 } }), { status:200 });
    }
    if (/\/sendMessage$/u.test(target)) {
      return new Response(JSON.stringify({ ok:true, result:{ message_id:901, chat:{ id:body.chat_id } } }), { status:200 });
    }
    throw new Error(`unexpected url ${target}`);
  };

  const firstResponse = await handlePilotCommunityUpdate(
    albumUpdate(51820501, 601, 'photo-1'),
    config,
    NOW,
    transport
  );
  const secondResponse = await handlePilotCommunityUpdate(
    albumUpdate(51820502, 602, 'photo-2'),
    config,
    NOW + 1000,
    transport
  );

  const firstBody = await firstResponse.json();
  const secondBody = await secondResponse.json();

  assert.equal(firstBody.reportId, CASE_ID);
  assert.equal(firstBody.rawReportId, CASE_ID);
  assert.equal(firstBody.groupFirst, true);
  assert.equal(secondBody.reportId, CASE_ID);
  assert.equal(secondBody.rawReportId, 'R-20260913-51820502');
  assert.equal(secondBody.groupFirst, false);

  assert.equal(ingested.length, 2);
  assert.equal(ingested[0].metadata.media_group_id, 'opaque-album-case-1');
  assert.equal(ingested[1].metadata.media_group_id, 'opaque-album-case-1');

  const adminMeta = calls.filter(call =>
    /\/sendMessage$/u.test(call.target) &&
    call.body?.chat_id === 111111111 &&
    /^🐞 R-/u.test(String(call.body?.text || ''))
  );
  assert.equal(adminMeta.length, 1);
  assert.match(adminMeta[0].body.text, new RegExp(CASE_ID));
  assert.equal(adminMeta[0].body.text.includes('Telegram ID'), false);

  const adminCopies = calls.filter(call => /\/copyMessage$/u.test(call.target) && call.body?.chat_id === 111111111);
  assert.equal(adminCopies.length, 2);

  const userConfirmations = calls.filter(call =>
    /\/sendMessage$/u.test(call.target) &&
    call.body?.chat_id === 222222222 &&
    /Дякуємо/u.test(String(call.body?.text || ''))
  );
  assert.equal(userConfirmations.length, 1);
  assert.match(userConfirmations[0].body.text, new RegExp(CASE_ID));
});
