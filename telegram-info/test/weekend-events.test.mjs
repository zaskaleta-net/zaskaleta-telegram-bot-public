import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isWeekendPostTime, publishWeekendEvents } from '../src/weekend-events.mjs';
import { parseNordtickerEvents, eventsForWeekend, weekendPostText, clearEventsCache } from '../src/events-nordticker.mjs';

const page = name => readFileSync(new URL(`./fixtures/nordticker-${name}-2026-10-17.html`, import.meta.url), 'utf8');
const PAGES = { wochenende:page('wochenende'), 'feste-maerkte':page('feste-maerkte'), 'familie-kinder':page('familie-kinder') };
// Friday 23.10.2026, 16:00 Berlin (CEST until 25.10).
const FRIDAY = Date.UTC(2026, 9, 23, 14, 0, 0);
const GROUP = -1001234567890;
// TG-RUNTIME-115: the weekend post goes to the news channel only.
const CHANNEL = -1004480749326;

test('the post goes out on Friday between 16:00 and 21:00 Berlin only', () => {
  assert.equal(isWeekendPostTime(FRIDAY), true);
  assert.equal(isWeekendPostTime(FRIDAY - 3600000), false, '15:00');
  assert.equal(isWeekendPostTime(FRIDAY + 5 * 3600000), false, '21:00');
  assert.equal(isWeekendPostTime(FRIDAY + 86400000), false, 'Saturday');
});

test('weekend selection: Friday to Sunday, at most seven, spread over categories', () => {
  const all = Object.values(PAGES).flatMap(parseNordtickerEvents);
  const list = eventsForWeekend(all, FRIDAY);
  assert.ok(list.length >= 1 && list.length <= 7);
  assert.ok(list.every(event => event.sortDate >= '2026-10-23' && event.sortDate <= '2026-10-25'));
  assert.ok(list.some(event => event.title === 'Bauen Wohnen Lifestyle Messe'));
  const text = weekendPostText(list, FRIDAY);
  assert.match(text, /^🎉 <b>Куди піти на вихідних у Schleswig-Holstein<\/b> · 23\.10–25\.10/u);
  assert.match(text, /Джерело: nordticker\.de$/u);
});

function outbox(env = {}) {
  const data = new Map();
  return {
    data,
    env:{ TELEGRAM_BOT_TOKEN:`123456789:${'A'.repeat(35)}`, TELEGRAM_WEBHOOK_SECRET:'B'.repeat(40), TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_PILOT_MODE:'public',
      TELEGRAM_ALLOWED_CHAT_IDS:`${GROUP},${CHANNEL}`, TELEGRAM_NEWS_CHAT_IDS:String(CHANNEL), ...env },
    householdContextStorage:{ async get(key) { return structuredClone(data.get(key)); }, async put(key, value) { data.set(key, structuredClone(value)); } }
  };
}

test('publishing: once per chat and Friday, with a link to the bot; nothing outside the window', async () => {
  clearEventsCache();
  const sent = [];
  const transport = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.telegram.org/')) { sent.push(JSON.parse(options.body)); return new Response('{"ok":true,"result":{"message_id":1}}', { status:200 }); }
    const key = Object.keys(PAGES).find(name => target.includes(`/${name}/`));
    return key ? new Response(PAGES[key], { status:200 }) : new Response('no', { status:404 });
  };
  const box = outbox();
  assert.equal((await publishWeekendEvents(box, FRIDAY - 3600000, transport)).status, 'not_now');
  const first = await publishWeekendEvents(box, FRIDAY, transport);
  assert.equal(first.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, CHANNEL);
  assert.equal(sent[0].parse_mode, 'HTML');
  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].url, 'https://t.me/ZaskaletaInfoBot');
  assert.equal((await publishWeekendEvents(box, FRIDAY + 3600000, transport)).status, 'already_sent');
  assert.equal(sent.length, 1);
  assert.equal((await publishWeekendEvents(outbox({ TELEGRAM_DAILY_NEWS_ENABLED:'false' }), FRIDAY, transport)).status, 'not_now');
  clearEventsCache();
});
