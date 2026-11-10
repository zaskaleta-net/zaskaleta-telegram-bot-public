import { readBoundedJSON } from './pilot-security.mjs';
import { buildNewsCardsV2 } from './news-v2.mjs';
import { buildMorningBriefV2, NAH_SH_HOME, TRANSPORT_SECTION } from './morning-brief-v2.mjs';
import { isSubrequestNotSentError } from './subrequest-budget.mjs';
import { cachedNewsPublication } from './news-publication-cache.mjs';

const TELEGRAM_TIMEOUT_MS = 9000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REFUGEE_AGE_MS = 14 * DAY_MS;
const MAX_EVENT_PAST_GRACE_MS = 6 * 60 * 60 * 1000;

const TRUSTED_NEWS_SOURCES = new Set([
  'NDR Schleswig-Holstein',
  'Landesportal Schleswig-Holstein'
]);

const PROMO_RE = /(?:\bapp\b|appstore|play\s*store|playstore|download|herunterladen|newsletter|online[-\s]*services?|werbung|shop|abo\b|abonnieren)/iu;
const STATIC_GUIDE_RE = /(?:\/online-services\/|\/germany4ukraine-app\/|\/unterkunft-fuer-ukrainer\/|\/seite_node\.html(?:[?#]|$))/iu;
const NEWS_SIGNAL_RE = /(?:\bneu(?:e|en|er|es)?\b|aktuell|aktualisiert|änderung|ändert|geändert|beschlossen|entscheidung|entscheidet|verlängert|verlängerung|frist|startet|endet|tritt\s+.*kraft|reform|warnung|meldung|pressemitteilung|update|erhöht|gesenkt|ab\s+\d{1,2}[.\/-]\d{1,2}|ab\s+(?:januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember))/iu;

function cleanText(value, max = 800) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function freshEnough(publishedAt, now) {
  return Number.isFinite(publishedAt)
    && publishedAt >= now - MAX_REFUGEE_AGE_MS
    && publishedAt <= now + DAY_MS;
}

function refugeeCardAllowed(card, now) {
  const text = `${card?.title || ''} ${card?.description || ''} ${card?.titleUk || ''} ${card?.descriptionUk || ''}`;
  const link = String(card?.link || '');
  if (!link || !card?.image) return false;
  if (PROMO_RE.test(`${text} ${link}`) || STATIC_GUIDE_RE.test(link)) return false;

  if (TRUSTED_NEWS_SOURCES.has(card?.source)) return freshEnough(card.publishedAt, now);

  return freshEnough(card?.publishedAt, now) && NEWS_SIGNAL_RE.test(text);
}

function fallbackEventDate(value, now) {
  const match = /^([0-3]?\d)[.\/-]([01]?\d)[.\/-]((?:20)?\d{2})$/u.exec(String(value || '').trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  if (!Number.isSafeInteger(day) || !Number.isSafeInteger(month) || !Number.isSafeInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const timestamp = Date.UTC(year, month - 1, day, 23, 59, 59);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return timestamp >= now - MAX_EVENT_PAST_GRACE_MS ? timestamp : null;
}

const MAX_REGIONAL_AGE_MS = 36 * 60 * 60 * 1000;
const MAX_REGIONAL_EVENT_AGE_MS = 10 * DAY_MS;

// NDR Schleswig-Holstein headlines: fresh, with a photo, from the NDR host.
function regionalCardAllowed(card, now) {
  if (!card?.image || card?.source !== 'NDR Schleswig-Holstein') return false;
  let host = '';
  try { host = new URL(String(card.link || '')).hostname; } catch { return false; }
  if (host !== 'www.ndr.de' && host !== 'ndr.de') return false;
  if (PROMO_RE.test(`${card.title || ''} ${card.link}`)) return false;
  const age = now - Number(card.publishedAt);
  return Number.isFinite(age) && age >= -DAY_MS && age <= (card.eventLike ? MAX_REGIONAL_EVENT_AGE_MS : MAX_REGIONAL_AGE_MS);
}

function eventCardAllowed(card, now) {
  if (!card?.link || !card?.image) return false;
  const startAt = card?.eventMeta?.startAt;
  if (Number.isFinite(startAt)) return startAt >= now - MAX_EVENT_PAST_GRACE_MS;
  const fallbackDate = String(card?.eventMeta?.fallbackDate || '').trim();
  if (!fallbackDate) return false;
  return fallbackEventDate(fallbackDate, now) !== null;
}

export function filterNewsCardsV2(cards, now = Date.now()) {
  const result = [];
  const seen = new Set();
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || !card.link || seen.has(card.link)) continue;
    if (card.kind === 'refugee' && !refugeeCardAllowed(card, now)) continue;
    if (card.kind === 'event' && !eventCardAllowed(card, now)) continue;
    if (card.kind === 'regional' && !regionalCardAllowed(card, now)) continue;
    if (!['refugee', 'event', 'regional'].includes(card.kind)) continue;
    seen.add(card.link);
    result.push(card);
  }
  return result.slice(0, 6);
}

function formatDateBerlin(now) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone:'Europe/Berlin',
    day:'2-digit',
    month:'2-digit',
    year:'numeric'
  }).format(new Date(now));
}

function formatEventDate(meta) {
  if (!meta) return null;
  if (Number.isFinite(meta.startAt)) {
    return new Intl.DateTimeFormat('uk-UA', {
      timeZone:'Europe/Berlin',
      weekday:'short',
      day:'2-digit',
      month:'2-digit',
      year:'numeric'
    }).format(new Date(meta.startAt));
  }
  return meta.fallbackDate || null;
}

function formatEventTime(meta) {
  if (!meta) return null;
  if (Number.isFinite(meta.startAt) && meta.hasTime) {
    return new Intl.DateTimeFormat('uk-UA', {
      timeZone:'Europe/Berlin',
      hour:'2-digit',
      minute:'2-digit'
    }).format(new Date(meta.startAt));
  }
  return meta.fallbackTime || null;
}

function header(now, hasCards) {
  const lines = [
    '🇺🇦 Schleswig-Holstein Помічник 🇺🇦🇩🇪',
    `🗞 Ранковий огляд — ${formatDateBerlin(now)}`,
    ''
  ];
  if (hasCards) {
    lines.push('Нижче — актуальні матеріали, які пройшли перевірку джерела та свіжості.');
  } else {
    lines.push(
      'На цей ранок нових матеріалів, які пройшли перевірку актуальності та якості, не знайдено.',
      'Старі, рекламні або неперевірені матеріали не підставляються замість новин.',
      'Автоматична перевірка буде виконана знову за розкладом.'
    );
  }
  return lines.join('\n');
}

// One digest header names the date; a card carries only a short topic tag,
// not the same all-caps heading again (owner review 17.10.2026).
function topicTag(card) {
  if (card.kind === 'refugee') return '🇺🇦 Для українців';
  if (card.kind === 'regional') return card.eventLike ? '🎉 Дозвілля · Schleswig-Holstein' : '📰 Schleswig-Holstein';
  return `🎭 Дозвілля · ${cleanText(card.city, 40)}`;
}

function caption(card) {
  const lines = [
    topicTag(card),
    '',
    cleanText(card.titleUk, 300)
  ];

  if (card.kind === 'event') {
    const date = formatEventDate(card.eventMeta);
    const time = formatEventTime(card.eventMeta);
    if (date) lines.push('', `📅 Коли: ${date}${time ? `, ${time}` : ''}`);
    if (card.eventMeta?.place) lines.push(`📍 Де: ${cleanText(card.eventMeta.place, 220)}`);
    if (card.eventMeta?.price) lines.push(`💶 Вартість: ${cleanText(card.eventMeta.price, 80)}`);
  }

  if (card.descriptionUk) lines.push('', cleanText(card.descriptionUk, 360));
  lines.push('', `Джерело: ${cleanText(card.source, 120)}`);
  return lines.join('\n').slice(0, 1024);
}

export { caption as newsCardCaptionV2 };

// Each component has a stable key within the persisted publication. A successful
// header never substitutes for a failed card. Unknown outcomes are not retried.
export async function buildSafeNewsPublicationV2(env = {}, now = Date.now(), transport = fetch) {
  // The morning brief (weather, NAH.SH) needs two requests and goes first:
  // run in parallel, the card fetches used up the budget and the group digest
  // said "weather temporarily unavailable" (14.10.2026, 08:01).
  const morningBrief = await buildMorningBriefV2(env, now, transport).catch(() => null);
  const rawCards = await buildNewsCardsV2(env, now, transport);
  const cards = filterNewsCardsV2(rawCards, now);
  const items = [{ key:'header', kind:'header', method:'sendMessage', payload:{ text:header(now, cards.length > 0), disable_notification:false } }];
  if (morningBrief) {
    const transportButton = morningBrief.includes(TRANSPORT_SECTION) ? { reply_markup:{ inline_keyboard:[[{ text:'🚆 NAH.SH — зміни в русі', url:NAH_SH_HOME }]] } } : {};
    items.push({ key:'morning', kind:'morning', method:'sendMessage', payload:{ text:morningBrief, disable_notification:true, link_preview_options:{ is_disabled:true }, ...transportButton } });
  }
  cards.forEach((card, index) => items.push({ key:`card:${index}`, kind:'card', method:'sendPhoto', payload:{ photo:card.image, caption:caption(card), disable_notification:true, reply_markup:{ inline_keyboard:[[{ text:'🔗 Відкрити джерело', url:card.link }]] } } }));
  return { createdAt:now, items, cardCount:cards.length, rejected:rawCards.length-cards.length };
}

async function sendPublicationItem(config, chatId, item, transport) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/${item.method}`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ ...item.payload, chat_id:chatId }), signal:controller.signal
    });
    const parsed = await readBoundedJSON(response, 32768);
    if (!parsed.error && response.ok && parsed.value?.ok === true) {
      const messageId = Number(parsed.value.result?.message_id);
      return { state:'sent', ...(Number.isSafeInteger(messageId) && messageId>0 ? {messageId} : {}) };
    }
    if (!parsed.error && parsed.value?.ok === false) {
      return { state:response.status === 429 || response.status >= 500 ? 'retryable' : 'rejected' };
    }
    return { state:'uncertain' };
  } catch (error) {
    // Refused by the platform before any byte left the Worker: safe to retry.
    if (isSubrequestNotSentError(error)) return { state:'retryable', notSent:true };
    return { state:'uncertain' };
  } finally { clearTimeout(timeout); }
}

export async function deliverSafeNewsPublicationV2(config, chatId, publication, transport = fetch, { states = {}, checkpoint = async () => {} } = {}) {
  if (!config || !Number.isSafeInteger(chatId) || !Array.isArray(publication?.items)) return { ok:false, complete:false, sent:0, reason:'invalid_config' };
  let sent=0, alreadySent=0, subrequestLimit=false;
  for (const item of publication.items) {
    const state=states[item.key]?.state;
    if (state==='sent') { alreadySent+=1; continue; }
    if (state==='sending') {
      states[item.key]={state:'uncertain'};
      await checkpoint(states);
    }
    if (['sending','uncertain','rejected'].includes(state)) {
      if(item.kind==='header') break;
      continue;
    }
    states[item.key]={state:'sending'};
    await checkpoint(states); // Persist intent before the first network byte.
    const outcome=await sendPublicationItem(config,chatId,item,transport);
    const {notSent, ...stored}=outcome;
    states[item.key]=stored;
    await checkpoint(states);
    if (states[item.key].state==='sent') sent+=1;
    else if(notSent) { subrequestLimit=true; break; } // Every further send would be refused too.
    else if(item.kind==='header') break;
  }
  const delivered = item => states[item.key]?.state==='sent';
  const complete=publication.items.every(delivered);
  const cardSent=publication.items.filter(item=>item.kind==='card' && delivered(item)).length;
  const headerSent=states.header?.state==='sent';
  const morningSent=states.morning?.state==='sent';
  const uncertain=Object.values(states).filter(item=>['sending','uncertain'].includes(item.state)).length;
  return {ok:complete,complete,sent,alreadySent,subrequestLimit,cardSent,morningSent,headerSent,uncertain,attempted:publication.cardCount,rejected:publication.rejected,
    reason:!complete ? (uncertain ? 'delivery_uncertain' : 'partial_delivery') : cardSent>0 ? 'sent' : 'brief_only'};
}

export const NEWS_BUILD_NOTICE='🗞 Готую свіжий огляд новин — це займе до 30 секунд…';

async function telegramCall(config, method, payload, transport) {
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/${method}`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify(payload), signal:AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
    });
    const parsed = await readBoundedJSON(response, 32768);
    return parsed.error ? null : parsed.value;
  } catch {
    return null;
  }
}

export async function sendSafeNewsDigestToChatV2(config, chatId, env = {}, now = Date.now(), transport = fetch) {
  if (!config || !Number.isSafeInteger(chatId)) return { ok:false, complete:false, sent:0, reason:'invalid_config' };
  // A cached digest answers at once. Building one takes 25–35 s; a "typing"
  // indicator lasts only 5 s, so the chat gets a visible notice meanwhile,
  // removed once the digest is delivered.
  let noticeId = null;
  const { publication } = await cachedNewsPublication(env, now, () => buildSafeNewsPublicationV2(env,now,transport), {
    onMiss:async () => {
      const sent = await telegramCall(config, 'sendMessage', { chat_id:chatId, text:NEWS_BUILD_NOTICE, disable_notification:true }, transport);
      const id = Number(sent?.result?.message_id);
      noticeId = Number.isSafeInteger(id) && id > 0 ? id : null;
    }
  });
  const result = await deliverSafeNewsPublicationV2(config,chatId,publication,transport);
  if (noticeId) await telegramCall(config, 'deleteMessage', { chat_id:chatId, message_id:noticeId }, transport);
  return result;
}
