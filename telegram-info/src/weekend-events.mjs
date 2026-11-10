// Friday "Куди піти на вихідних" post in the news chats: the hourly cron asks
// the shared object; from 16:00 Berlin on Friday the post is sent once per
// chat and week (marker per chat). Nothing is posted when nothing is on.
import { pilotConfig, readBoundedJSON } from './pilot-security.mjs';
import { newsTargets } from './runtime-news.mjs';
import { fetchNordtickerEvents, eventsForWeekend, weekendPostText, berlinDate, BRIEF_PAGES } from './events-nordticker.mjs';

export const WEEKEND_EVENTS_PATH = '/weekend-events';
const MARKER_PREFIX = 'telegram-weekend-events:v1:';
const POST_FROM_HOUR = 16;
const POST_UNTIL_HOUR = 21;
export const BOT_LINK = 'https://t.me/ZaskaletaInfoBot';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

export function isWeekendPostTime(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Berlin', weekday:'short', hour:'2-digit', hourCycle:'h23' })
    .formatToParts(new Date(now)).map(part => [part.type, part.value]));
  const hour = Number(parts.hour);
  return parts.weekday === 'Fri' && hour >= POST_FROM_HOUR && hour < POST_UNTIL_HOUR;
}

export async function publishWeekendEvents(outbox, now, transport = fetch) {
  const env = outbox?.env || {};
  if (env.TELEGRAM_DAILY_NEWS_ENABLED === 'false' || !isWeekendPostTime(now)) return { status:'not_now' };
  const config = pilotConfig(env);
  const chats = newsTargets(env, config);
  const storage = outbox?.householdContextStorage;
  if (!config || !chats.length || !storage) return { status:'skipped' };
  const date = berlinDate(now);
  const pending = [];
  for (const chatId of chats) if ((await storage.get(`${MARKER_PREFIX}${chatId}`)) !== date) pending.push(chatId);
  if (!pending.length) return { status:'already_sent' };

  const result = await fetchNordtickerEvents(transport, now, BRIEF_PAGES);
  const events = result.status === 'ok' ? eventsForWeekend(result.events, now) : [];
  if (!events.length) return { status:result.status === 'ok' ? 'nothing_on' : 'unavailable' };
  const text = weekendPostText(events, now);
  let sent = 0;
  for (const chatId of pending) {
    try {
      const response = await transport(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({
          chat_id:chatId, text, parse_mode:'HTML', disable_notification:true, link_preview_options:{ is_disabled:true },
          reply_markup:{ inline_keyboard:[[{ text:'🎉 Більше заходів у боті', url:BOT_LINK }]] }
        })
      });
      const parsed = await readBoundedJSON(response, 16384);
      if (response.ok && !parsed.error && parsed.value?.ok === true) {
        await storage.put(`${MARKER_PREFIX}${chatId}`, date);
        sent += 1;
      }
    } catch {}
  }
  return { status:sent === pending.length ? 'sent' : 'partial', sent, events:events.length };
}

export async function handleWeekendEventsStorage(request, outbox, transport = fetch) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (request.method !== 'POST' || url.hostname !== 'outbox.internal' || url.pathname !== WEEKEND_EVENTS_PATH) return null;
  const parsed = await readBoundedJSON(request.clone(), 4096);
  const now = Number(parsed.error ? NaN : parsed.value?.now);
  if (!Number.isSafeInteger(now) || now <= 0) return json({ status:'bad_operation' }, 400);
  try { return json(await publishWeekendEvents(outbox, now, transport)); }
  catch { return json({ status:'unavailable' }, 503); }
}
