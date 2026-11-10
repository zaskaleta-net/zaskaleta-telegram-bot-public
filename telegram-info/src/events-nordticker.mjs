// "🎉 Куди піти": upcoming festivals, markets, family and evening events in
// Schleswig-Holstein from nordticker.de, verified 17.10.2026 with plain GET.
// The event pages are server-rendered; every card carries its data as
// attributes (data-event-title, -location "Venue, Town", -start-date,
// -start-time, -end-date, -url), so no description text has to be parsed.
// Three pages per refresh, cached for an hour per Worker instance.

import { placeCoordinates, distanceKm } from './housing-company-sources.mjs';
import { resolvePlaceName, resolveBarePlaceName, isHamburg, HAMBURG } from './place-search.mjs';

const BASE = 'https://nordticker.de/events';
// The digest and the weekend post read these three pages.
export const BRIEF_PAGES = Object.freeze([
  `${BASE}/wochenende/`,
  `${BASE}/rubrik/feste-maerkte/`,
  `${BASE}/rubrik/familie-kinder/`
]);
// The menu answer adds music, culture and theatre (verified 17.10.2026: about
// 20 events each, also outside the big cities), so a near list is not empty.
export const NORDTICKER_PAGES = Object.freeze([
  ...BRIEF_PAGES,
  `${BASE}/rubrik/musik-buehne/`,
  `${BASE}/rubrik/kunst-kultur-wissen/`,
  `${BASE}/rubrik/show-comedy-theater/`
]);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_HTML_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 6000;
const CACHE_MS = 60 * 60 * 1000;
// Per page, so the digest's three pages and the menu's six share fetches.
const pageCache = new Map();
export function clearEventsCache() { pageCache.clear(); }

const CATEGORIES = Object.freeze({
  'feste-maerkte':'🎪 Свята й ярмарки',
  'familie-kinder':'👨‍👩‍👧 Для дітей і сімей',
  'musik-buehne':'🎵 Музика',
  'show-comedy-theater':'🎭 Театр і шоу',
  'party-nachtleben':'🪩 Вечірки',
  'kunst-kultur-wissen':'🖼 Культура'
});
const WEEKDAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

function decode(value) {
  return String(value ?? '')
    .replace(/&#0?38;|&amp;/gu, '&').replace(/&quot;/gu, '"').replace(/&#0?39;|&#8217;/gu, '’').replace(/&#8211;/gu, '–').replace(/&nbsp;/gu, ' ')
    .replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function parseNordtickerEvents(html) {
  const events = [];
  for (const match of String(html || '').matchAll(/<div class="nordticker-event-card nordticker-event-card--([\w-]+)"([^>]*)>/gu)) {
    const attributes = Object.fromEntries([...match[2].matchAll(/data-event-([\w-]+)="([^"]*)"/gu)].map(item => [item[1], decode(item[2])]));
    const url = attributes.url || '';
    if (!attributes.id || !attributes.title || !DATE_RE.test(attributes['start-date'] || '') || !/^https:\/\/nordticker\.de\/events\//u.test(url)) continue;
    const parts = String(attributes.location || '').split(',').map(part => part.trim()).filter(Boolean);
    const endDate = DATE_RE.test(attributes['end-date'] || '') ? attributes['end-date'] : attributes['start-date'];
    events.push({
      id:attributes.id,
      title:attributes.title.slice(0, 120),
      category:match[1],
      venue:parts.length > 1 ? parts.slice(0, -1).join(', ').slice(0, 80) : '',
      town:(parts.at(-1) || '').slice(0, 60),
      startDate:attributes['start-date'],
      startTime:/^\d{2}:\d{2}$/u.test(attributes['start-time'] || '') ? attributes['start-time'] : '',
      endDate:endDate < attributes['start-date'] ? attributes['start-date'] : endDate,
      url
    });
  }
  return events;
}

export function berlinDate(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Berlin', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(now));
}

function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// Events that still run today or start within the window, soonest first,
// one entry per event id.
export function upcomingEvents(events, now, days = 14) {
  const today = berlinDate(now);
  const last = addDays(today, days);
  // nordticker lists some events twice under two ids ("Pump up the Mic",
  // owner video 17.10.2026): one entry per title, date, time and venue.
  const seen = new Set();
  const key = event => [event.title.toLocaleLowerCase('de-DE'), event.startDate, event.startTime, event.town, event.venue].join('|');
  return (Array.isArray(events) ? events : [])
    .filter(event => event.endDate >= today && event.startDate <= last)
    .filter(event => !seen.has(event.id) && !seen.has(key(event)) && seen.add(event.id) && seen.add(key(event)))
    .map(event => ({ ...event, sortDate:event.startDate < today ? today : event.startDate }))
    .sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.startTime.localeCompare(b.startTime) || a.title.localeCompare(b.title, 'de'));
}

function shortDate(date, now) {
  const today = berlinDate(now);
  if (date === today) return 'Сьогодні';
  if (date === addDays(today, 1)) return 'Завтра';
  const value = new Date(`${date}T12:00:00Z`);
  return `${WEEKDAYS[value.getUTCDay()]} ${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

// Fairs and markets run every day of their range. A theatre or concert
// "range" is a season with single dates, so it shows the next date only.
export function eventWhen(event, now) {
  const today = berlinDate(now);
  const time = event.startTime ? `, ${event.startTime}` : '';
  if (event.endDate > event.startDate && event.category === 'feste-maerkte') {
    return event.startDate <= today ? `до ${shortDate(event.endDate, now)}` : `${shortDate(event.startDate, now)} – ${shortDate(event.endDate, now)}`;
  }
  if (event.endDate > event.startDate) {
    const until = `${event.endDate.slice(8, 10)}.${event.endDate.slice(5, 7)}`;
    // Which of the season's dates is next is only on the event page.
    return event.startDate < today ? `до ${until} (дати — на сторінці заходу)` : `${shortDate(event.startDate, now)}${time} (інші дати до ${until})`;
  }
  return `${shortDate(event.startDate, now)}${time}`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

// Plain text for the digest; with html the title links to the event page
// (Telegram parse_mode HTML), so no raw URL is printed.
// A short Ukrainian hint from known words in the title, never a machine
// translation: titles are mostly proper names, and the model translated them
// word by word or transliterated them (owner video 17.10.2026). No known
// word, no hint. The first matching rule wins.
const TYPE_HINTS = Object.freeze([
  [/weihnachtsmarkt|weihnachtsdorf|adventsmarkt|winterzauber/iu, 'різдвяний ярмарок'],
  [/weihnacht|advent/iu, 'різдвяний захід'],
  [/flohmarkt|trödel|second[- ]hand|kleider(?:markt|tausch)|mädelsflohmarkt/iu, 'блошиний ринок'],
  [/hochzeitsmesse|hochzeitsfestival/iu, 'весільна виставка'],
  [/messe/iu, 'виставка-ярмарок'],
  [/halloween|grusel/iu, 'Хелловін'],
  [/musical/iu, 'мюзикл'],
  [/oper\b|opernhaus/iu, 'опера'],
  [/konzert|tour\b|live\b|\bband\b|orchester|chor\b|punk|rock\b|metal\b|jazz|blues/iu, 'концерт'],
  [/comedy|kabarett|satire|joking/iu, 'комедійне шоу'],
  [/poetry ?slam|regio slam|\bslam\b/iu, 'поетичний слем'],
  [/lesung|literatur/iu, 'літературні читання'],
  [/ausstellung|vernissage|museum/iu, 'виставка'],
  [/führung|rundgang|stadttour/iu, 'екскурсія'],
  [/theater|schauspiel|bühne/iu, 'вистава'],
  [/tanznachmittag|tanzabend|\btanz\b|ball\b/iu, 'танці'],
  [/party|clubnacht|\bdisco\b/iu, 'вечірка'],
  [/festival|stadtfest|straßenfest|hafenfest/iu, 'фестиваль'],
  [/markt\b|märkte/iu, 'ярмарок'],
  [/kinder|familie|mitmach/iu, 'для дітей']
]);

export function eventTypeHint(event) {
  // The venue counts too: a title at the "Opernhaus" is an opera.
  const text = `${event?.title || ''} ${/opernhaus/iu.test(String(event?.venue || '')) ? 'oper' : ''}`;
  for (const [pattern, hint] of TYPE_HINTS) if (pattern.test(text)) return hint;
  return null;
}

function eventLine(event, now, html = false) {
  const distance = Number.isFinite(event.distanceKm) && event.distanceKm >= 1 ? ` (≈${Math.round(event.distanceKm)} км)` : '';
  const where = [event.town, event.venue].filter(Boolean).join(' · ') + distance;
  const hint = eventTypeHint(event);
  const title = html ? `<a href="${escapeHtml(event.url)}">${escapeHtml(event.title)}</a>${hint ? ` — ${hint}` : ''}` : `${event.title}${hint ? ` — ${hint}` : ''}`;
  const place = html ? escapeHtml(where) : where;
  return `• ${eventWhen(event, now)} — ${title}${where ? `\n   📍 ${place}` : ''}`;
}

async function fetchPage(url, transport) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await transport(url, { method:'GET', headers:{ 'user-agent':USER_AGENT, accept:'text/html', 'accept-language':'de-DE' }, signal:controller.signal });
    if (!response?.ok) return null;
    const text = await response.text();
    return text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNordtickerEvents(transport = fetch, now = Date.now(), pages = NORDTICKER_PAGES) {
  let fetched = 0;
  const results = await Promise.all(pages.map(async url => {
    const cached = pageCache.get(url);
    if (cached && now - cached.at < CACHE_MS) return cached.events;
    fetched += 1;
    const html = await fetchPage(url, transport);
    if (typeof html !== 'string') return null;
    const events = parseNordtickerEvents(html);
    // Only an answered page is cached; a failed one is retried next time.
    pageCache.set(url, { at:now, events });
    return events;
  }));
  const answered = results.filter(Array.isArray);
  if (!answered.length) return { status:'unavailable', events:[] };
  return { status:'ok', events:answered.flat(), ...(fetched === 0 ? { cached:true } : {}) };
}

// Sent after "🔎 Інше місто"; the next text message is read as the town.
export const EVENTS_TOWN_PROMPT = '🔎 Напишіть назву міста чи громади в Schleswig-Holstein — покажу заходи поруч (до 30 км).';

const UNAVAILABLE_TEXT = '🎉 Куди піти\n\nКалендар заходів зараз недоступний. Спробуйте трохи пізніше.';

export const NEAR_RADIUS_KM = 30;
// Towns offered as buttons under the list; any other Schleswig-Holstein
// municipality works as "/events <Ort>".
export const EVENT_TOWNS = Object.freeze(['Kiel', 'Lübeck', 'Flensburg', 'Neumünster', 'Norderstedt', 'Elmshorn', 'Itzehoe', 'Heide']);

// Saved after an events list (TG-RUNTIME-046, phone smoke 17.10.2026): the next
// message that is only a town name asks for events there too, instead of
// falling back into an older housing context. Not a "🔎 Напишіть назву"
// question, so a quoted reply still wins over it.
export const EVENTS_FOLLOWUP_PROMPT = '🎉 Куди піти: наступна назва міста — заходи поруч.';

// The same place as eventsPlace, but only for a message that is just the name.
export function eventsBarePlace(name) {
  if (isHamburg(name)) return eventsPlace(name);
  return resolveBarePlaceName(name) ? eventsPlace(name) : null;
}

// A typed or pressed town: its official name and coordinates, or null.
export function eventsPlace(name) {
  // Events in Schleswig-Holstein within reach of Hamburg (Norderstedt, Pinneberg, …).
  if (isHamburg(name)) return { town:HAMBURG.town, point:HAMBURG.point, radiusKm:NEAR_RADIUS_KM, outsideSh:true };
  const town = resolvePlaceName(name);
  const point = town ? placeCoordinates(town) : null;
  return town && point ? { town, point, radiusKm:NEAR_RADIUS_KM } : null;
}

// Events within the radius of the place, each with its distance; an event
// whose town has no known coordinates is left out of a near list.
export function eventsNear(events, near) {
  if (!near?.point) return Array.isArray(events) ? events : [];
  return (Array.isArray(events) ? events : []).map(event => {
    const distance = distanceKm(near.point, placeCoordinates(event.town));
    return distance === null ? null : { ...event, distanceKm:distance };
  }).filter(event => event && event.distanceKm <= near.radiusKm);
}

// The entries the menu answer shows: grouped by category, at most three per
// category and eight in all (a longer list took several screens, owner video
// 17.10.2026), within the next two weeks; with a place, only those within
// its radius. `total` is the number of events the list was taken from.
export const REPLY_MAX = 8;
const REPLY_PER_CATEGORY = 3;
export function eventsForReply(events, now, near = null) {
  const list = upcomingEvents(eventsNear(events, near), now, 14);
  const groups = [];
  let count = 0;
  for (const [key, label] of Object.entries(CATEGORIES)) {
    const group = list.filter(event => event.category === key).slice(0, Math.min(REPLY_PER_CATEGORY, REPLY_MAX - count));
    if (!group.length) continue;
    groups.push({ label, events:group });
    count += group.length;
  }
  groups.total = list.length;
  return groups;
}

// Full answer for the menu button and /events (parse_mode HTML).
export function eventsReplyText(events, now, near = null) {
  const groups = eventsForReply(events, now, near);
  if (!groups.length) {
    return near
      ? `🎉 Куди піти поруч із ${escapeHtml(near.town)}\n\nУ радіусі ${near.radiusKm} км за найближчі 14 днів у перевіреному календарі заходів не знайдено.${near.outsideSh ? ' Бот показує заходи лише в Schleswig-Holstein; афішу самого Hamburg він не веде.' : ''} Перегляньте заходи по всій землі (кнопка нижче).`
      : '🎉 Куди піти\n\nНа найближчі два тижні в перевіреному календарі заходів не знайдено.';
  }
  const lines = near
    ? [`🎉 <b>Куди піти поруч із ${escapeHtml(near.town)}</b>`, `Заходи в радіусі ${near.radiusKm} км на найближчі 14 днів. Натисніть назву, щоб відкрити сторінку заходу.`, ...(near.outsideSh ? ['Бот показує заходи лише в Schleswig-Holstein; афішу самого Hamburg він не веде.'] : [])]
    : ['🎉 <b>Куди піти в Schleswig-Holstein</b>', 'Заходи на найближчі 14 днів. Натисніть назву, щоб відкрити сторінку заходу.'];
  for (const group of groups) {
    lines.push('', `<b>${group.label}</b>`);
    for (const event of group.events) lines.push(eventLine(event, now, true));
  }
  const shown = groups.reduce((sum, group) => sum + group.events.length, 0);
  if (groups.total > shown) lines.push('', `Ще ${groups.total - shown} — на nordticker.de (кнопка нижче).`);
  lines.push('', 'Назви — мовою організатора. Час і квитки перевіряйте на сторінці заходу.', near ? 'Інше місто — кнопка «🔎 Інше місто» нижче.' : 'Поруч із вашим містом — кнопки нижче або «🔎 Інше місто».', 'Джерело: nordticker.de');
  return lines.join('\n');
}

// The digest's entries: today and the next three days, at most four. A long
// run that began earlier (a theatre season) would repeat every morning; only
// a festival or market that is on right now stays in. The entries are spread
// over categories, festivals and families first, one per venue.
export function eventsForBrief(events, now) {
  const today = berlinDate(now);
  return spreadEvents(upcomingEvents(events, now, 3).filter(event => event.startDate >= today || event.category === 'feste-maerkte'), 4);
}

// Up to max entries spread over categories (festivals and families first),
// one per venue, then in date order.
function spreadEvents(due, max) {
  const order = ['feste-maerkte', 'familie-kinder', 'musik-buehne', 'show-comedy-theater', 'kunst-kultur-wissen', 'party-nachtleben'];
  const queues = order.map(key => due.filter(event => event.category === key));
  const list = [];
  while (list.length < max && queues.some(queue => queue.length)) {
    for (const queue of queues) {
      if (!queue.length || list.length >= max) continue;
      const event = queue.shift();
      // One entry per venue: three parties in one club are one tip.
      if (!list.some(item => item.town === event.town && item.venue === event.venue)) list.push(event);
    }
  }
  return list.sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.startTime.localeCompare(b.startTime));
}

// Friday to Sunday of the current week (the post goes out on Friday).
export function eventsForWeekend(events, now, max = 7) {
  const today = berlinDate(now);
  const sunday = addDays(today, 2);
  return spreadEvents(upcomingEvents(events, now, 2).filter(event => event.sortDate <= sunday && (event.startDate >= today || event.category === 'feste-maerkte')), max);
}

export function weekendPostText(events, now) {
  const today = berlinDate(now);
  const range = `${today.slice(8, 10)}.${today.slice(5, 7)}–${addDays(today, 2).slice(8, 10)}.${addDays(today, 2).slice(5, 7)}`;
  return [
    `🎉 <b>Куди піти на вихідних у Schleswig-Holstein</b> · ${range}`,
    '',
    ...events.map(event => eventLine(event, now, true)),
    '',
    'Назви — мовою організатора. Час і квитки — на сторінці заходу.',
    'Заходи поруч із вашим містом — у боті: «🎉 Куди піти».',
    'Джерело: nordticker.de'
  ].join('\n');
}

// Short block for the morning digest. Empty when nothing is due (the block
// is then left out, never replaced by a "nothing found" line).
export function eventsBriefLines(events, now) {
  const list = eventsForBrief(events, now);
  if (!list.length) return [];
  return ['🎉 КУДИ ПІТИ НАЙБЛИЖЧИМИ ДНЯМИ', ...list.map(event => eventLine(event, now, false)), 'Джерело: nordticker.de. Більше — у боті: «🎉 Куди піти».'];
}

export function eventsKeyboard(near = null) {
  const towns = EVENT_TOWNS.filter(town => town !== near?.town).map(town => ({ text:`📍 ${town}`, callback_data:`ev:t:${town}` }));
  const rows = [];
  for (let index = 0; index < towns.length; index += 4) rows.push(towns.slice(index, index + 4));
  return { inline_keyboard:[
    ...(near ? [[{ text:'🗺 Уся земля', callback_data:'nav:events' }]] : []),
    ...rows,
    [{ text:'🔎 Інше місто', callback_data:'ev:ask' }],
    [{ text:'🔗 Усі заходи на nordticker.de', url:`${BASE}/` }],
    [{ text:'☰ Меню', callback_data:'nav:menu' }]
  ] };
}

export { UNAVAILABLE_TEXT as EVENTS_UNAVAILABLE_TEXT };
