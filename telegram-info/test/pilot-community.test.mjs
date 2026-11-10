import test from 'node:test';
import assert from 'node:assert/strict';
import { berlinNewsDateKey, buildDailyNewsDigest, handlePilotCommunityUpdate, isNewsCommand, parseRssItems, shouldPublishDailyNews } from '../src/pilot-community.mjs';

const config = {
  chatId:-1001234567890,
  chatIds:[-1001234567890],
  adminUserIds:[111111111],
  token:'123456789:abcdefghijklmnopqrstuvwxyzABCDEFGH_123456',
  secret:'abcdefghijklmnopqrstuvwxyzABCDEFGH_1234567890'
};

const rss = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Test &amp; News]]></title><link>https://example.test/a</link><pubDate>Sat, 12 Sep 2026 06:00:00 GMT</pubDate></item>
<item><title>Second</title><link>https://example.test/b</link></item>
</channel></rss>`;

test('RSS parser keeps headline, link and source without HTML', () => {
  const items = parseRssItems(rss, 'Example');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Test & News');
  assert.equal(items[0].link, 'https://example.test/a');
  assert.equal(items[0].source, 'Example');
  assert.equal(Number.isFinite(items[0].publishedAt), true);
});

test('daily news gate provides a bounded 08:00-10:59 Europe/Berlin retry window', () => {
  assert.equal(shouldPublishDailyNews(Date.parse('2026-09-12T06:00:00Z')), true);
  assert.equal(shouldPublishDailyNews(Date.parse('2026-09-12T07:00:00Z')), true);
  assert.equal(shouldPublishDailyNews(Date.parse('2026-09-12T09:00:00Z')), false);
  assert.equal(shouldPublishDailyNews(Date.parse('2026-12-12T07:00:00Z')), true);
  assert.equal(shouldPublishDailyNews(Date.parse('2026-12-12T09:00:00Z')), true);
  assert.equal(shouldPublishDailyNews(Date.parse('2026-12-12T10:00:00Z')), false);
});

test('Berlin date key follows local calendar date', () => {
  assert.equal(berlinNewsDateKey(Date.parse('2026-09-12T22:30:00Z')), '2026-09-13');
  assert.equal(berlinNewsDateKey(Date.parse('2026-12-12T23:30:00Z')), '2026-12-13');
});

test('news command and private menu button are recognized', () => {
  assert.equal(isNewsCommand({ message:{ text:'/news' } }), true);
  assert.equal(isNewsCommand({ message:{ text:'/news@ZaskaletaInfoBot' } }), true);
  assert.equal(isNewsCommand({ message:{ text:'🗞 Новини' } }), true);
  assert.equal(isNewsCommand({ message:{ text:'/start' } }), false);
});

test('daily digest combines regional and official feeds', async () => {
  const digest = await buildDailyNewsDigest(Date.parse('2026-09-12T06:00:00Z'), async url => {
    assert.match(String(url), /ndr\.de|schleswig-holstein\.de/u);
    return new Response(rss, { status:200, headers:{ 'content-type':'application/rss+xml' } });
  });
  assert.match(digest, /Новини Schleswig-Holstein/u);
  assert.match(digest, /NDR Schleswig-Holstein/u);
  assert.match(digest, /Landesregierung Schleswig-Holstein/u);
  assert.match(digest, /https:\/\/example\.test\/a/u);
});

test('private /report prompts for a screenshot', async () => {
  const calls = [];
  const response = await handlePilotCommunityUpdate({
    update_id:1,
    message:{ message_id:10, chat:{ id:222222222, type:'private' }, from:{ id:222222222 }, text:'/report' }
  }, config, Date.parse('2026-09-12T06:00:00Z'), async (url, options) => {
    calls.push({ url:String(url), body:JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok:true, result:{ message_id:99, chat:{ id:222222222 } } }), { status:200 });
  });
  const body = await response.json();
  assert.equal(body.mode, 'pilot-report-prompt');
  assert.equal(body.delivered, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Надішліть скріншот/u);
  assert.equal(calls[0].body.reply_markup, undefined);
  assert.match(calls[0].body.text, /Відповісти.*не потрібно/u);
});

test('private report menu button prompts for a screenshot', async () => {
  const response = await handlePilotCommunityUpdate({
    update_id:2,
    message:{ message_id:11, chat:{ id:222222222, type:'private' }, from:{ id:222222222 }, text:'🐞 Повідомити про помилку' }
  }, config, Date.parse('2026-09-12T06:00:00Z'), async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.text, /Надішліть скріншот/u);
    return new Response(JSON.stringify({ ok:true, result:{ message_id:100, chat:{ id:222222222 } } }), { status:200 });
  });
  assert.equal((await response.json()).mode, 'pilot-report-prompt');
});


test('stale legacy report reply is retired instead of hijacking a new private request', async () => {
  const calls = [];
  const now = Date.parse('2026-09-28T17:00:00Z');
  const response = await handlePilotCommunityUpdate({
    update_id:88,
    message:{
      message_id:44,
      date:Math.floor(now / 1000),
      chat:{ id:222222222, type:'private' },
      from:{ id:222222222 },
      text:'Ренсберг сім’я 3 людини',
      reply_to_message:{
        message_id:33,
        date:Math.floor((now - 2 * 24 * 60 * 60 * 1000) / 1000),
        chat:{ id:222222222, type:'private' },
        from:{ id:999999999, is_bot:true, username:'ZaskaletaInfoBot' },
        text:'🐞 Повідомлення про помилку\n\nНадішліть скріншот'
      }
    }
  }, config, now, async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url:String(url), body });
    return new Response(JSON.stringify({ ok:true, result:true }), { status:200 });
  });

  assert.equal(response, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /deleteMessage$/u);
  assert.deepEqual(calls[0].body, { chat_id:222222222, message_id:33 });
});

test('report reply is copied to pilot admin and acknowledged', async () => {
  const calls = [];
  const response = await handlePilotCommunityUpdate({
    update_id:77,
    message:{
      message_id:12,
      chat:{ id:222222222, type:'private' },
      from:{ id:222222222 },
      caption:'Після натискання кнопки нічого не сталося',
      photo:[{ file_id:'x' }],
      reply_to_message:{ text:'🐞 Повідомлення про помилку\n\nНадішліть скріншот' }
    }
  }, config, Date.parse('2026-09-12T06:00:00Z'), async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url:String(url), body });
    if (/copyMessage$/u.test(String(url))) {
      return new Response(JSON.stringify({ ok:true, result:{ message_id:101 } }), { status:200 });
    }
    return new Response(JSON.stringify({ ok:true, result:{ message_id:100, chat:{ id:body.chat_id } } }), { status:200 });
  });
  const body = await response.json();
  assert.equal(body.mode, 'pilot-report-submit');
  assert.equal(body.delivered, true);
  assert.equal(calls.some(call => /copyMessage$/u.test(call.url) && call.body.chat_id === 111111111), true);
  assert.equal(calls.some(call => /sendMessage$/u.test(call.url) && call.body.chat_id === 222222222 && /Дякуємо/u.test(call.body.text)), true);
});
