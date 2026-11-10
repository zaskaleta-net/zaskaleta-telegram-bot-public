import test from 'node:test';
import assert from 'node:assert/strict';
import { sendHousingMediaReply } from '../src/telegram-media.mjs';

const config = { chatId: 321, token: '12345:' + 'A'.repeat(30) };
const media = [
  { media: 'https://img.example.test/a.jpg', caption: '<b>1. A</b>\n<a href="https://www.kleinanzeigen.de/s-anzeige/a/3506905833-203-1">🔗 Відкрити оголошення</a>', parse_mode: 'HTML' },
  { media: 'https://img.example.test/b.jpg', caption: '<b>2. B</b>\n<a href="https://www.kleinanzeigen.de/s-anzeige/b/3506905999-203-1">🔗 Відкрити оголошення</a>', parse_mode: 'HTML' }
];
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const ok = (result, status = 200) => new Response(JSON.stringify({ ok: true, result }), { status, headers: { 'content-type': 'application/json' } });

test('default delivery sends every listing as a separate photo with its own open-link button', async () => {
  const sentBodies = [];
  const transport = async (url, options = {}) => {
    if (url.startsWith('https://img.example.test/')) return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    assert.match(url, /sendPhoto$/);
    sentBodies.push(options.body);
    const markup = JSON.parse(options.body.get('reply_markup'));
    assert.equal(markup.inline_keyboard[0][0].text, '🔗 Відкрити оголошення');
    assert.match(markup.inline_keyboard[0][0].url, /^https:\/\/www\.kleinanzeigen\.de\//);
    return ok({ message_id: 50 + sentBodies.length, chat: { id: 321 } });
  };
  const result = await sendHousingMediaReply({ config, media, text: 'fallback', replyMarkup: null, transport });
  assert.equal(result.status, 'sent');
  assert.equal(result.mediaCount, 2);
  assert.equal(result.separateCards, true);
  assert.equal(sentBodies.length, 2);
  assert.match(sentBodies[0].get('caption'), /Відкрити оголошення/u);
  assert.match(sentBodies[1].get('caption'), /Відкрити оголошення/u);
});

test('legacy album mode is sent once, then buttons are attached by editing markup without resending photos', async () => {
  const telegramMethods = [];
  const transport = async (url, options = {}) => {
    if (url.startsWith('https://img.example.test/')) return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    const method = url.split('/').at(-1); telegramMethods.push(method);
    if (method === 'sendMediaGroup') {
      const album = JSON.parse(options.body.get('media'));
      assert.equal(album.length, 2);
      assert.match(album[0].caption, /^<b>1\. A/);
      assert.match(album[1].caption, /^<b>2\. B/);
      return ok([{ message_id: 10, chat: { id: 321 } }, { message_id: 11, chat: { id: 321 } }]);
    }
    if (method === 'editMessageReplyMarkup') {
      const body = JSON.parse(options.body);
      assert.equal(body.chat_id, 321);
      assert.ok([10, 11].includes(body.message_id));
      assert.match(body.reply_markup.inline_keyboard[0][0].url, /^https:\/\/www\.kleinanzeigen\.de\//);
      assert.match(body.reply_markup.inline_keyboard[1][0].callback_data, /^jc:\d+$/);
      return ok({ message_id: body.message_id, chat: { id: 321 } });
    }
    throw new Error('unexpected transport ' + url);
  };
  const result = await sendHousingMediaReply({ config, media, text: 'fallback', replyMarkup: null, transport, separateItems:false });
  assert.deepEqual(telegramMethods, ['sendMediaGroup', 'editMessageReplyMarkup', 'editMessageReplyMarkup']);
  assert.equal(result.status, 'sent');
  assert.equal(result.mediaCount, 2);
  assert.equal(result.buttonsAttached, 2);
});

test('failed earlier photo is removed and surviving legacy album captions are renumbered from one', async () => {
  const three = [
    { media:'https://img.example.test/fail.jpg', caption:'<b>1. Missing</b>', parse_mode:'HTML' },
    ...media.map((item, i) => ({ ...item, caption:item.caption.replace(`<b>${i+1}.`, `<b>${i+2}.`) }))
  ];
  const transport = async (url, options = {}) => {
    if (url.endsWith('/fail.jpg')) return new Response('blocked', { status: 403 });
    if (url.startsWith('https://img.example.test/')) return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (url.endsWith('/sendMediaGroup')) {
      const album = JSON.parse(options.body.get('media'));
      assert.match(album[0].caption, /^<b>1\. A/);
      assert.match(album[1].caption, /^<b>2\. B/);
      return ok([{ message_id: 20, chat: { id: 321 } }, { message_id: 21, chat: { id: 321 } }]);
    }
    if (url.endsWith('/editMessageReplyMarkup')) {
      const body = JSON.parse(options.body); return ok({ message_id: body.message_id, chat: { id: 321 } });
    }
    throw new Error('unexpected transport ' + url);
  };
  const result = await sendHousingMediaReply({ config, media: three, text:'fallback', replyMarkup:null, transport, separateItems:false });
  assert.equal(result.status, 'sent');
  assert.equal(result.mediaCount, 2);
});

test('all failed image downloads preserve every listing as an individual text card', async () => {
  const sent = [];
  const transport = async (url, options = {}) => {
    if (url.startsWith('https://img.example.test/')) return new Response('blocked', { status: 403 });
    if (url.endsWith('/sendMessage')) {
      const body = JSON.parse(options.body);
      sent.push(body);
      assert.match(body.reply_markup.inline_keyboard[0][0].url, /^https:\/\/www\.kleinanzeigen\.de\//u);
      assert.match(body.reply_markup.inline_keyboard[1][0].callback_data, /^jc:\d+$/u);
      assert.equal(body.parse_mode, undefined);
      return ok({ message_id: 30 + sent.length, chat: { id: 321 } });
    }
    throw new Error('unexpected transport ' + url);
  };
  const result = await sendHousingMediaReply({ config, media, text:'fallback', replyMarkup:null, transport });
  assert.equal(result.status, 'sent');
  assert.equal(result.mediaCount, 2);
  assert.equal(result.separateCards, true);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /^1\. A/mu);
  assert.match(sent[1].text, /^2\. B/mu);
});

test('definite legacy album rejection falls back once; ambiguous failures are never retried as media', async () => {
  let groupCalls = 0, textCalls = 0;
  const transport = async (url, options = {}) => {
    if (url.startsWith('https://img.example.test/')) return new Response(jpeg, { status: 200, headers: { 'content-type':'image/jpeg' } });
    if (url.endsWith('/sendMediaGroup')) { groupCalls++; return new Response(JSON.stringify({ ok:false }), { status:400, headers:{'content-type':'application/json'} }); }
    if (url.endsWith('/sendMessage')) { textCalls++; return ok({ message_id:40, chat:{id:321} }); }
    throw new Error('unexpected transport ' + url);
  };
  const result = await sendHousingMediaReply({ config, media, text:'fallback', replyMarkup:null, transport, separateItems:false });
  assert.equal(result.status, 'sent');
  assert.equal(groupCalls, 1);
  assert.equal(textCalls, 1);
});
