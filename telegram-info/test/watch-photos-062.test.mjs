import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, USER, json } from './runtime-fixture.mjs';
import { handleHousingWatchStorage, compactListing, watchMessage, HOUSING_WATCH_PATH, HOUSING_WATCH_PREFIX } from '../src/housing-watch.mjs';
import { sendHousingMediaReply, PHOTO_MISSING_NOTE, PHOTO_FAILED_NOTE } from '../src/telegram-media.mjs';
import { publicListingCardText } from '../src/public-housing-cards.mjs';

// TG-RUNTIME-062 (owner, 19.10.2026): a flat that fits the price but has no
// photo is shown with "фото відсутнє"; watch alerts came without photos.

const TRITTAU = { location:'Trittau', persons:4, rooms:'3-4', radius:15 };
const GROUP = 'trittau|4|3-4|15';
const KEY = `${HOUSING_WATCH_PREFIX}${USER}:${USER}`;
const ENV = { TELEGRAM_BOT_TOKEN:`123456789:${'A'.repeat(35)}`, TELEGRAM_WEBHOOK_SECRET:'B'.repeat(40), TELEGRAM_RELEASE_APPROVED:'pilot-v1', TELEGRAM_PILOT_MODE:'allowlist', TELEGRAM_ALLOWED_CHAT_IDS:[USER, ...Array.from({ length:30 }, (_, index) => 900000001 + index)].join(',') };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function memoryStorage(entries = []) {
  const data = new Map(entries);
  return {
    data,
    async get(key) { return structuredClone(data.get(key)); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { return data.delete(key); },
    async list({ prefix = '', limit = Infinity } = {}) { return new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit)); }
  };
}

function deliver(storage, listings, transport) {
  return handleHousingWatchStorage(new Request(`https://outbox.internal${HOUSING_WATCH_PATH}`, { method:'POST', body:JSON.stringify({ now:NOW, op:'deliver', group:GROUP, criteria:TRITTAU, listings }) }), { householdContextStorage:storage, env:ENV }, { transport }).then(response => response.json());
}

const listing = (id, imageUrl = null) => ({ key:`u:https://www.kleinanzeigen.de/s-anzeige/x/${id}`, url:`https://www.kleinanzeigen.de/s-anzeige/x/${id}`, title:`Wohnung ${id}`, price:887, rooms:'3', areaSqm:70, location:'Ahrensburg', imageUrl });
const watch = chat => [`${HOUSING_WATCH_PREFIX}${chat}:${chat}`, { criteria:TRITTAU, baseline:true, seen:[], interval:'m15', createdAt:NOW - 86400000, updatedAt:NOW - 86400000, lastRunAt:0, expiresAt:NOW + 86400000 }];

function recorder({ photoOk = true } = {}) {
  const calls = [];
  const transport = async (url, options = {}) => {
    const value = String(url);
    if (value.startsWith('https://img.')) {
      calls.push({ kind:'download', url:value });
      return photoOk ? new Response(JPEG, { headers:{ 'content-type':'image/jpeg' } }) : new Response('gone', { status:404 });
    }
    const method = value.split('/').at(-1);
    const body = options.body instanceof FormData ? Object.fromEntries(options.body.entries()) : JSON.parse(options.body || '{}');
    calls.push({ kind:'telegram', method, body });
    if (method === 'sendMediaGroup') return json({ ok:true, result:[{ message_id:2, chat:{ id:Number(body.chat_id) } }, { message_id:3, chat:{ id:Number(body.chat_id) } }] });
    return json({ ok:true, result:{ message_id:1, chat:{ id:Number(body.chat_id) } } });
  };
  return { calls, transport };
}

test('#062 the watch keeps the photo address of a listing', () => {
  const kept = compactListing({ url:'https://www.kleinanzeigen.de/s-anzeige/a/1', title:'A', imageUrl:'https://img.kleinanzeigen.de/api/v1/prod-ads/images/1.jpg' });
  assert.equal(kept.imageUrl, 'https://img.kleinanzeigen.de/api/v1/prod-ads/images/1.jpg');
  assert.equal(compactListing({ url:'https://www.kleinanzeigen.de/s-anzeige/a/2', title:'B', imageUrl:'http://x/1.jpg' }).imageUrl, null);
});

test('#062 an alert sends its text, then the photos silently; a listing without a photo says so', async () => {
  const storage = memoryStorage([watch(USER)]);
  const { calls, transport } = recorder();
  const result = await deliver(storage, [listing(1, 'https://img.kleinanzeigen.de/1.jpg'), listing(2, 'https://img.kleinanzeigen.de/2.jpg'), listing(3)], transport);
  assert.equal(result.sent, 1);
  assert.equal(result.albums, 1);
  const telegram = calls.filter(call => call.kind === 'telegram');
  assert.deepEqual(telegram.map(call => call.method), ['sendMessage', 'sendMediaGroup']);
  const text = telegram[0].body.text;
  assert.equal(text.split(PHOTO_MISSING_NOTE).length - 1, 1, 'only listing 3 has no photo');
  assert.match(text, new RegExp(`Wohnung 3</a>\\n[^\\n]+\\n${PHOTO_MISSING_NOTE}`, 'u'));
  const album = JSON.parse(telegram[1].body.media);
  assert.equal(album.length, 2);
  assert.match(album[0].caption, /^<b>1\.<\/b> <a href="https:\/\/www\.kleinanzeigen\.de\/s-anzeige\/x\/1">Wohnung 1<\/a>/u);
  assert.equal(telegram[1].body.disable_notification, 'true');
  assert.ok(storage.data.get(KEY).seen.length >= 3);
});

test('#062 a photo that does not load is named in the text and no album is sent', async () => {
  const storage = memoryStorage([watch(USER)]);
  const { calls, transport } = recorder({ photoOk:false });
  const result = await deliver(storage, [listing(1, 'https://img.kleinanzeigen.de/1.jpg')], transport);
  assert.equal(result.sent, 1);
  assert.equal(result.albums, 0);
  const telegram = calls.filter(call => call.kind === 'telegram');
  assert.deepEqual(telegram.map(call => call.method), ['sendMessage']);
  assert.ok(telegram[0].body.text.includes(PHOTO_FAILED_NOTE));
});

test('#062 one delivery call stays under the Workers Free subrequest limit; the rest waits for the next run', async () => {
  const chats = Array.from({ length:30 }, (_, index) => 900000001 + index);
  const storage = memoryStorage(chats.map(watch));
  const { calls, transport } = recorder();
  const listings = Array.from({ length:5 }, (_, index) => listing(index + 1, `https://img.kleinanzeigen.de/${index + 1}.jpg`));
  const result = await deliver(storage, listings, transport);
  assert.ok(calls.length <= 45, String(calls.length));
  assert.equal(calls.filter(call => call.kind === 'download').length, 5, 'each photo is downloaded once');
  assert.ok(result.sent >= 15 && result.sent < 30, String(result.sent));
  const waiting = chats.filter(chat => storage.data.get(`${HOUSING_WATCH_PREFIX}${chat}:${chat}`).lastRunAt === 0);
  assert.equal(waiting.length, 30 - result.sent, 'not sent = still due');
});

test('#062 search cards: no photo on the site and a photo that failed are both shown with a note', async () => {
  const sent = [];
  const transport = async (url, options = {}) => {
    const value = String(url);
    if (value.startsWith('https://img.')) return new Response('gone', { status:404 });
    sent.push(JSON.parse(options.body));
    return json({ ok:true, result:{ message_id:sent.length, chat:{ id:USER } } });
  };
  const card = (id, media) => ({ type:media ? 'photo' : 'text', media, caption:`<b>${id}. Wohnung</b>\n💶 <b>887,00 €</b> · Ahrensburg\n<a href="https://www.kleinanzeigen.de/s-anzeige/x/${id}">🔗 Відкрити оголошення</a>`, parse_mode:'HTML' });
  const outcome = await sendHousingMediaReply({ config:{ token:'1:x', chatId:USER }, media:[card(1, null), card(2, 'https://img.kleinanzeigen.de/2.jpg')], text:'summary', replyMarkup:null, transport, separateItems:true });
  assert.equal(outcome.status, 'sent');
  assert.equal(sent.length, 2, 'both listings are shown');
  assert.ok(sent[0].text.includes(PHOTO_MISSING_NOTE));
  assert.ok(sent[1].text.includes(PHOTO_FAILED_NOTE));
  assert.ok(publicListingCardText({ location:'Trittau' }, { title:'A', price:887 }).includes(PHOTO_MISSING_NOTE));
  assert.ok(!publicListingCardText({ location:'Trittau' }, { title:'A', price:887, imageUrl:'https://img.kleinanzeigen.de/a.jpg' }).includes(PHOTO_MISSING_NOTE));
});

test('#062 the default message text marks only listings without a photo address', () => {
  const text = watchMessage(TRITTAU, [listing(1, 'https://img.kleinanzeigen.de/1.jpg'), listing(2)]);
  assert.equal(text.split(PHOTO_MISSING_NOTE).length - 1, 1);
});

test('#062 review: a watch photo over 2 MB is not kept; the text names it', async () => {
  const storage = memoryStorage([watch(USER)]);
  const calls = [];
  const transport = async (url, options = {}) => {
    const value = String(url);
    if (value.startsWith('https://img.')) return new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers:{ 'content-type':'image/jpeg' } });
    const body = JSON.parse(options.body || '{}');
    calls.push({ method:value.split('/').at(-1), body });
    return json({ ok:true, result:{ message_id:1, chat:{ id:USER } } });
  };
  const result = await deliver(storage, [listing(1, 'https://img.kleinanzeigen.de/big.jpg')], transport);
  assert.equal(result.albums, 0);
  assert.deepEqual(calls.map(call => call.method), ['sendMessage']);
  assert.ok(calls[0].body.text.includes(PHOTO_FAILED_NOTE));
});
