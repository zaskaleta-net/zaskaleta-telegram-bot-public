import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseNordtickerEvents, upcomingEvents, eventWhen, eventsReplyText, eventsBriefLines,
  fetchNordtickerEvents, clearEventsCache, NORDTICKER_PAGES, BRIEF_PAGES,
  eventTypeHint, eventsForReply, eventsForBrief, EVENTS_TOWN_PROMPT,
  eventsPlace, eventsNear, eventsKeyboard, EVENT_TOWNS
} from '../src/events-nordticker.mjs';
import { eventsCommand, isEventsRequestUpdate } from '../src/events-command.mjs';
import { fixture } from './runtime-fixture.mjs';

const page = name => readFileSync(new URL(`./fixtures/nordticker-${name}-2026-10-17.html`, import.meta.url), 'utf8');
const PAGES = { wochenende:page('wochenende'), 'feste-maerkte':page('feste-maerkte'), 'familie-kinder':page('familie-kinder'), 'musik-buehne':page('musik-buehne') };
// Saturday 17.10.2026, 09:00 Berlin.
const NOW = Date.UTC(2026, 9, 17, 7, 0, 0);
const html = body => new Response(body, { status:200, headers:{ 'content-type':'text/html' } });

function sourceTransport(calls = []) {
  return async url => {
    calls.push(String(url));
    const key = Object.keys(PAGES).find(name => String(url).includes(`/${name}/`));
    return key ? html(PAGES[key]) : new Response('no', { status:404 });
  };
}

const ALL = () => Object.values(PAGES).flatMap(parseNordtickerEvents);

test('nordticker cards are read from their data attributes', () => {
  const events = parseNordtickerEvents(PAGES['feste-maerkte']);
  assert.equal(events.length, 8);
  const messe = events.find(event => event.title === 'Bauen Wohnen Lifestyle Messe');
  assert.deepEqual(
    { town:messe.town, venue:messe.venue, startDate:messe.startDate, endDate:messe.endDate, startTime:messe.startTime, category:messe.category },
    { town:'Kiel', venue:'Merkur Ostseehalle', startDate:'2026-10-23', endDate:'2026-10-25', startTime:'12:00', category:'feste-maerkte' }
  );
  assert.match(messe.url, /^https:\/\/nordticker\.de\/events\//u);
  // HTML entities in titles are decoded.
  assert.ok(ALL().some(event => event.title === 'POP & TRASH'));
});

test('a card without a nordticker event link or a date is dropped', () => {
  const bad = '<div class="nordticker-event-card nordticker-event-card--feste-maerkte" data-event-id="1" data-event-title="X" data-event-start-date="2026-10-20" data-event-url="https://evil.example/">'
    + '<div class="nordticker-event-card nordticker-event-card--feste-maerkte" data-event-id="2" data-event-title="Y" data-event-start-date="soon" data-event-url="https://nordticker.de/events/y/">';
  assert.deepEqual(parseNordtickerEvents(bad), []);
});

test('upcoming events: still running or starting within the window, once each, soonest first', () => {
  const list = upcomingEvents([...ALL(), ...ALL()], NOW, 14);
  assert.equal(new Set(list.map(event => event.id)).size, list.length);
  assert.ok(list.every(event => event.endDate >= '2026-10-17' && event.startDate <= '2026-10-31'));
  assert.ok(!list.some(event => event.title === 'Tarzan: Das Musical'), 'December is outside two weeks');
  assert.deepEqual(list.map(event => event.sortDate), [...list.map(event => event.sortDate)].sort());
});

test('dates: today and tomorrow by name, fairs as a range, a theatre season as next date plus run', () => {
  const byTitle = title => ALL().find(event => event.title === title);
  assert.equal(eventWhen(byTitle('Starbugs Comedy: Jump Reloaded'), NOW), 'Завтра, 19:00');
  assert.equal(eventWhen(byTitle('Bauen Wohnen Lifestyle Messe'), NOW), 'Пт 23.10 – Нд 25.10');
  assert.equal(eventWhen(byTitle('Idomeneo, Re di Creta'), NOW), 'Сьогодні, 19:00 (інші дати до 27.02)');
  assert.equal(eventWhen(byTitle('Idomeneo, Re di Creta'), NOW + 3 * 86400000), 'до 27.02 (дати — на сторінці заходу)');
});

test('menu answer: at most eight, three per category, a Ukrainian hint, no raw URL, the rest counted', () => {
  const text = eventsReplyText(ALL(), NOW);
  assert.match(text, /^🎉 <b>Куди піти в Schleswig-Holstein<\/b>/u);
  assert.match(text, /<b>🎪 Свята й ярмарки<\/b>\n• Пт 23\.10 – Нд 25\.10 — <a href="https:\/\/nordticker\.de\/events\/[^"]+">Bauen Wohnen Lifestyle Messe<\/a> — виставка-ярмарок\n   📍 Kiel · Merkur Ostseehalle/u);
  assert.equal(text.replace(/<a href="[^"]+">/gu, '').match(/https?:\/\//gu), null);
  const entries = (text.match(/^• /gmu) || []).length;
  assert.ok(entries <= 8);
  const groups = eventsForReply(ALL(), NOW);
  assert.ok(groups.every(group => group.events.length <= 3));
  assert.match(text, new RegExp(`Ще ${groups.total - entries} — на nordticker\\.de`, 'u'));
  assert.doesNotMatch(text, /переклад/u);
  assert.match(text, /Джерело: nordticker\.de$/u);
});

test('Ukrainian hints come only from known words; proper names get none', () => {
  const hint = title => eventTypeHint({ title });
  assert.equal(hint('Bauen Wohnen Lifestyle Messe'), 'виставка-ярмарок');
  assert.equal(hint('Gestüts Weihnacht'), 'різдвяний захід');
  assert.equal(hint('Förde Fräulein: Nachtflohmarkt Kiel 2026'), 'блошиний ринок');
  assert.equal(hint('Tarzan: Das Musical'), 'мюзикл');
  assert.equal(hint('Pump up the Mic: Regio Slam Kiel'), 'поетичний слем');
  assert.equal(hint('Boostedt: Grimms Albtraum im vb30 Halloween-Haus'), 'Хелловін');
  assert.equal(hint('Rob Moir'), null);
  assert.equal(hint('POP & TRASH'), null);
});

test('an event listed twice under two ids is shown once', () => {
  const [first] = parseNordtickerEvents(PAGES.wochenende);
  const twin = { ...first, id:`${first.id}0`, url:`${first.url}twin/` };
  assert.equal(upcomingEvents([first, twin], NOW, 14).length, 1);
});

test('digest block: at most four, one per venue, a past-started season left out; empty when nothing is due', () => {
  const lines = eventsBriefLines(ALL(), NOW);
  assert.equal(lines[0], '🎉 КУДИ ПІТИ НАЙБЛИЖЧИМИ ДНЯМИ');
  const entries = lines.filter(line => line.startsWith('• '));
  assert.ok(entries.length >= 2 && entries.length <= 4);
  assert.equal(lines.filter(line => /Die Pumpe/u.test(line)).length, 1);
  assert.doesNotMatch(eventsBriefLines(ALL(), NOW + 86400000).join('\n'), /Idomeneo/u);
  assert.deepEqual(eventsBriefLines(ALL(), Date.UTC(2028, 5, 1)), []);
});

test('pages are fetched once and cached per page; a failed page is retried, a full outage is unavailable', async () => {
  clearEventsCache();
  const calls = [];
  const first = await fetchNordtickerEvents(sourceTransport(calls), NOW);
  assert.equal(first.status, 'ok');
  assert.equal(calls.length, NORDTICKER_PAGES.length);
  // Two of the six pages have no fixture (404): only they are asked again.
  await fetchNordtickerEvents(sourceTransport(calls), NOW + 60000);
  assert.equal(calls.length, NORDTICKER_PAGES.length + 2);
  // The digest's three pages are all cached already.
  const brief = await fetchNordtickerEvents(sourceTransport(calls), NOW + 120000, BRIEF_PAGES);
  assert.equal(brief.cached, true);
  assert.equal(calls.length, NORDTICKER_PAGES.length + 2);
  clearEventsCache();
  assert.deepEqual(await fetchNordtickerEvents(async () => new Response('down', { status:503 }), NOW), { status:'unavailable', events:[] });
  clearEventsCache();
});

test('events requests: the menu button, its text and /events in a private chat only', () => {
  const message = (text, type = 'private') => ({ message:{ text, chat:{ id:5, type }, from:{ id:5 } } });
  assert.equal(isEventsRequestUpdate(message('/events')), true);
  assert.equal(isEventsRequestUpdate(message('🎉 Куди піти')), true);
  assert.equal(isEventsRequestUpdate(message('/events', 'supergroup')), false);
  assert.equal(isEventsRequestUpdate({ callback_query:{ id:'q', data:'nav:events', message:{ chat:{ id:5, type:'private' } } } }), true);
  assert.equal(isEventsRequestUpdate({ callback_query:{ id:'q', data:'nav:news', message:{ chat:{ id:5, type:'private' } } } }), false);
});

test('the menu button answers the callback and sends the HTML list', async () => {
  clearEventsCache();
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1' });
  try {
    const sent = [];
    const transport = async (url, options = {}) => {
      if (String(url).startsWith('https://api.telegram.org/')) { sent.push({ method:String(url).split('/').at(-1), body:JSON.parse(options.body) }); return new Response('{"ok":true,"result":true}', { status:200 }); }
      return sourceTransport()(url);
    };
    const response = await eventsCommand(f.request('', { callback:'nav:events' }), f.env, NOW, transport);
    assert.equal((await response.json()).delivered, true);
    assert.deepEqual(sent.map(call => call.method), ['answerCallbackQuery', 'sendMessage']);
    assert.equal(sent[1].body.parse_mode, 'HTML');
    assert.match(sent[1].body.text, /Куди піти в Schleswig-Holstein/u);
    assert.equal(sent[1].body.reply_markup.inline_keyboard.at(-1)[0].callback_data, 'nav:menu');
  } finally { f.close(); clearEventsCache(); }
});

test('/events through the full runtime: an unavailable calendar gets a plain notice', async () => {
  clearEventsCache();
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1' });
  try {
    const result = await f.send('/events');
    assert.equal(result.body.mode, 'events-v1');
    assert.match(result.last.text, /Календар заходів зараз недоступний/u);
    assert.equal(result.last.parse_mode, undefined);
    assert.ok(f.sourceCalls.some(url => url.startsWith('https://nordticker.de/events/')));
    const menu = await f.send('/menu');
    const buttons = (menu.last?.reply_markup?.inline_keyboard || []).flat();
    assert.ok(buttons.some(button => button.callback_data === 'nav:events' && button.text === '🎉 Куди піти'));
    const viaButton = await f.send('', { callback:'nav:events' });
    assert.equal(viaButton.body.mode, 'events-v1');
  } finally { f.close(); clearEventsCache(); }
});

test('near a town: only events within 30 km, with the official town name and a distance', () => {
  const kiel = eventsPlace('kiel');
  assert.equal(kiel.town, 'Kiel');
  assert.equal(eventsPlace('Atlantis'), null);
  const near = eventsNear(ALL(), kiel);
  assert.ok(near.length > 0 && near.every(event => event.distanceKm <= 30));
  assert.ok(!near.some(event => event.town === 'Lübeck' || event.town === 'Boostedt'));
  const text = eventsReplyText(ALL(), NOW, kiel);
  assert.match(text, /^🎉 <b>Куди піти поруч із Kiel<\/b>\nЗаходи в радіусі 30 км/u);
  assert.doesNotMatch(text, /Lübeck|Eckernförde/u);
  const lubeck = eventsReplyText(ALL(), NOW, eventsPlace('Lübeck'));
  assert.match(lubeck, /Lübeck · Kolosseum zu Lübeck/u);
  const far = eventsReplyText(ALL(), NOW, eventsPlace('Husum'));
  assert.match(far, /У радіусі 30 км за найближчі 14 днів/u);
});

test('the keyboard offers the towns, and "Уся земля" once a town is chosen', () => {
  const all = eventsKeyboard().inline_keyboard.flat();
  assert.deepEqual(all.filter(button => /^ev:t:/u.test(button.callback_data || '')).map(button => button.callback_data.slice(5)), [...EVENT_TOWNS]);
  assert.ok(all.every(button => !button.callback_data || Buffer.byteLength(button.callback_data) <= 64));
  const kiel = eventsKeyboard(eventsPlace('Kiel')).inline_keyboard;
  assert.equal(kiel[0][0].callback_data, 'nav:events');
  assert.ok(!kiel.flat().some(button => button.callback_data === 'ev:t:Kiel'));
});

test('/events <town> and a town button answer with the near list; an unknown town gets a notice', async () => {
  clearEventsCache();
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1' });
  try {
    const sent = [];
    const transport = async (url, options = {}) => {
      if (String(url).startsWith('https://api.telegram.org/')) { sent.push(JSON.parse(options.body)); return new Response('{"ok":true,"result":true}', { status:200 }); }
      return sourceTransport()(url);
    };
    await eventsCommand(f.request('/events lübeck'), f.env, NOW, transport);
    assert.match(sent.at(-1).text, /Куди піти поруч із Lübeck/u);
    await eventsCommand(f.request('', { callback:'ev:t:Kiel' }), f.env, NOW, transport);
    assert.match(sent.at(-1).text, /Куди піти поруч із Kiel/u);
    await eventsCommand(f.request('/events Atlantis'), f.env, NOW, transport);
    assert.match(sent.at(-1).text, /^Такого міста в Schleswig-Holstein не знайдено — перевірте назву \(можна німецькою, наприклад Trittau\)\. Поки показую заходи по всій землі\.\n\n🎉 <b>Куди піти в Schleswig-Holstein/u);
    assert.equal(await eventsCommand(f.request('', { callback:'ev:x:Kiel' }), f.env, NOW, transport), null);
  } finally { f.close(); clearEventsCache(); }
});

test('"🔎 Інше місто": the prompt is sent and saved; the next plain text is read as the town', async () => {
  clearEventsCache();
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1' });
  try {
    const asked = await f.send('', { callback:'ev:ask' });
    assert.equal(asked.body.source, 'ask_town');
    assert.equal(asked.last.text, EVENTS_TOWN_PROMPT);
    assert.ok(!(asked.last.reply_markup?.force_reply), 'no ForceReply; the prompt is saved server-side');
    const answer = await f.send('Lübeck');
    assert.equal(answer.body.mode, 'events-v1');
    assert.match(answer.last.text, /Куди піти|Календар заходів зараз недоступний/u);
    assert.ok(f.sourceCalls.some(url => url.startsWith('https://nordticker.de/events/')));
    // The town question is used once. After the list (TG-RUNTIME-046, phone
    // smoke 17.10.2026) only a bare town name continues the events section;
    // a sentence is an ordinary message again.
    const later = await f.send('Lübeck');
    assert.equal(later.body.mode, 'events-v1');
    const sentence = await f.send('Ich suche eine Wohnung in Lübeck');
    assert.notEqual(sentence.body.mode, 'events-v1');
  } finally { f.close(); clearEventsCache(); }
});

test('the keyboard offers "🔎 Інше місто"', () => {
  assert.ok(eventsKeyboard().inline_keyboard.flat().some(button => button.callback_data === 'ev:ask'));
  assert.ok(eventsKeyboard(eventsPlace('Kiel')).inline_keyboard.flat().some(button => button.callback_data === 'ev:ask'));
});

test('a town typed in Ukrainian after "🔎 Інше місто" gives the near list (owner video: "Тріттау")', async () => {
  clearEventsCache();
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1' });
  try {
    const sent = [];
    const transport = async (url, options = {}) => {
      if (String(url).startsWith('https://api.telegram.org/')) { sent.push(JSON.parse(options.body)); return new Response('{"ok":true,"result":true}', { status:200 }); }
      return sourceTransport()(url);
    };
    await eventsCommand(f.request('Тріттау', { previous:{ message_id:3, text:EVENTS_TOWN_PROMPT } }), f.env, NOW, transport);
    assert.match(sent.at(-1).text, /^🎉 (?:<b>)?Куди піти поруч із Trittau/u);
    assert.doesNotMatch(sent.at(-1).text, /не знайдено — перевірте/u);
  } finally { f.close(); clearEventsCache(); }
});

test('screenshot 17.10.2026: "Гамбург" quoting the old bug-report prompt still answers "🔎 Інше місто"', async () => {
  clearEventsCache();
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1' });
  try {
    await f.send('', { callback:'ev:ask' });
    const oldPrompt = { message_id:2, text:'🐞 Повідомлення про помилку\nНадішліть скріншот або опишіть проблему.', from:{ id:999999999, is_bot:true } };
    const answer = await f.send('Гамбург', { previous:oldPrompt });
    assert.equal(answer.body.mode, 'events-v1');
    assert.doesNotMatch(String(answer.last?.text || ''), /Не вдалося однозначно зрозуміти/u);
  } finally { f.close(); clearEventsCache(); }
});

test('a reply to an older bot message without a saved town question keeps its old meaning', async () => {
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1' });
  try {
    const answer = await f.send('Kiel', { previous:{ message_id:2, text:'Тема: житло. Вкажіть місто або район.', from:{ id:999999999, is_bot:true } } });
    assert.notEqual(answer.body.mode, 'events-v1');
  } finally { f.close(); }
});

test('Hamburg: events in Schleswig-Holstein within 30 km, with a note', () => {
  const near = eventsPlace('Гамбург');
  assert.equal(near.town, 'Hamburg');
  const text = eventsReplyText(ALL(), NOW, near);
  assert.match(text, /^🎉 (?:<b>)?Куди піти поруч із Hamburg/u);
  assert.match(text, /лише в Schleswig-Holstein; афішу самого Hamburg він не веде/u);
});
