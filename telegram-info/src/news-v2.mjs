import { readBoundedJSON } from './pilot-security.mjs';
import { translateNewsText } from './news-translation.mjs';

const FEED_TIMEOUT_MS = 6500;
const PAGE_TIMEOUT_MS = 7000;
const TELEGRAM_TIMEOUT_MS = 9000;
const MAX_TRANSLATIONS_PER_RUN = 16;
const REGIONAL_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const REGIONAL_EVENT_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;
const REGIONAL_CARD_LIMIT = 4;
const MAX_PAGE_BYTES = 1_800_000;

const REFUGEE_RSS_SOURCES = [
  {
    name:'NDR Schleswig-Holstein',
    url:'https://www.ndr.de/nachrichten/schleswig-holstein/index~rss2.xml',
    sourceLang:'de'
  },
  {
    name:'Landesportal Schleswig-Holstein',
    url:'https://www.schleswig-holstein.de/DE/landesportal/service/RSS/RSS_PI_alle/RSSNewsfeed_PI_alle.xml',
    sourceLang:'de'
  }
];

const REFUGEE_PAGE_SOURCES = [
  {
    name:'Germany4Ukraine',
    url:'https://www.germany4ukraine.de/DE/aktuelles/seite_node.html',
    sourceLang:'de',
    dedicated:true
  },
  {
    name:'hamburg.de · Ukraine',
    url:'https://www.hamburg.de/politik-und-verwaltung/senat/senatsthemen/ukraine',
    sourceLang:'de',
    dedicated:true
  }
];


const UKRAINE_RE = /(?:ukrain|ukraïn|україн|украин)/iu;
const REFUGEE_RE = /(?:flücht|geflücht|schutzsuch|vertrieben|aufnahme|aufenthalt|temporary protection|schutzstatus|asyl|integration|jobcenter|sozialleistung|unterkunft|wohnen|sprachkurs|schule|kita|familienleistung|kindergeld|gesundheit|registrierung|ausländerbehörde|fiktionsbescheinigung|aufenthaltstitel)/iu;
const EVENT_RE = /(?:konzert|festival|theater|kino|film|museum|ausstellung|markt|fest|show|musik|führung|rundgang|tour|open\s*air|kinder|familie|sport|party|sommer|licht|kunst|lesung|bühne|veranstaltung|workshop|messe|tanz|oper|musical|flohmarkt|stadtfest|straßenfest|strassenfest|kultur)/iu;
// Regional NDR news: practical topics first; crime, court and sport reports
// are not what a newcomer's morning digest is for.
const PRACTICAL_RE = /(?:jobcenter|bürgergeld|miete|wohn|kita|schule|semester|uni\b|verkehr|bahn|bus|zug|streik|sperrung|baustelle|wetter|sturm|unwetter|warnung|katastrophenschutz|gesundheit|krankenhaus|arzt|impf|energie|strom|gas|preis|kosten|gesetz|landtag|landesregierung|wahl|förder|geld|rente|steuer|ukrain|flücht|integration|sprach|arbeit|job|ausbildung|fachkräfte)/iu;
const SKIP_REGIONAL_RE = /(?:mord|tot(?:e|en|er)?\b|leiche|messer|festnahme|festgenommen|polizei sucht|gericht|prozess|angeklagt|verurteilt|unfall|brand|feuer|fußball|handball|thw kiel|holstein kiel|bundesliga|tor\b|spiel\b|sieg|niederlage)/iu;
// The digest opens with its own DWD forecast; an NDR "So wird das Wetter"
// card only repeated it (owner review 17.10.2026).
const WEATHER_FORECAST_RE = /(?:so wird das wetter|\bwetter(?:bericht|vorhersage|aussichten|prognose)\b|\bdas wetter (?:am|im|für|in|zum)\b)/iu;
const REGIONAL_EVENT_RE = /(?:festival|konzert|markt|fest\b|ausstellung|museum|licht|events?\b|veranstaltung|ferien|wochenende|ausflug|tipps?)/iu;
const NAV_RE = /^(?:home|start|mehr|weiter|zurück|zurueck|suche|kontakt|impressum|datenschutz|veranstaltungen|kultur|freizeit|stadtleben|alle|heute|morgen|wochenende|zur übersicht|zur uebersicht)$/iu;

function cleanText(value, max = 800) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&#(\d+);/gu, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/giu, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)));
}

function stripTags(value) {
  return cleanText(
    decodeHtml(
      String(value || '')
        .replace(/<script[\s\S]*?<\/script>/giu, ' ')
        .replace(/<style[\s\S]*?<\/style>/giu, ' ')
        .replace(/<[^>]+>/gu, ' ')
    ),
    1800
  );
}

function absoluteUrl(value, base) {
  try {
    const url = new URL(decodeHtml(value), base);
    if (!['http:','https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function metaValue(html, names) {
  const source = String(html || '');
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'iu'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'iu')
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      if (match?.[1]) return cleanText(decodeHtml(match[1]), 2200);
    }
  }
  return '';
}

function titleValue(html) {
  return metaValue(html, ['og:title','twitter:title'])
    || stripTags(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(String(html || ''))?.[1] || '');
}

function pageDescription(html) {
  return metaValue(html, ['og:description','twitter:description','description']);
}

function pageImage(html, base) {
  const value = metaValue(html, ['og:image:secure_url','og:image','twitter:image','twitter:image:src']);
  return value ? absoluteUrl(value, base) : null;
}

function canonicalLink(html, base) {
  const match = /<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/iu.exec(String(html || ''))
    || /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["'][^>]*>/iu.exec(String(html || ''));
  return match?.[1] ? absoluteUrl(match[1], base) : null;
}

function extractAnchors(html, base, limit = 180) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of String(html || '').matchAll(re)) {
    const href = absoluteUrl(match[1], base);
    const text = stripTags(match[2]).slice(0, 300);
    if (!href || !text || text.length < 5 || NAV_RE.test(text)) continue;
    const key = `${href}|${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ href, text });
    if (out.length >= limit) break;
  }
  return out;
}

function tagValue(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'iu').exec(block);
  return match ? stripTags(match[1]) : '';
}

export function parseRssItems(xml, source, limit = 20) {
  const items = [];
  const blocks = String(xml || '').match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/giu) || [];
  for (const block of blocks) {
    const title = cleanText(tagValue(block, 'title'), 280);
    const link = cleanText(tagValue(block, 'link') || tagValue(block, 'guid'), 1200);
    const description = cleanText(tagValue(block, 'description') || tagValue(block, 'content:encoded'), 1000);
    const pubDateRaw = tagValue(block, 'pubDate') || tagValue(block, 'dc:date') || tagValue(block, 'date');
    const publishedAt = Date.parse(pubDateRaw);
    if (!title || !/^https?:\/\//iu.test(link)) continue;
    items.push({
      title,
      link,
      description,
      source,
      publishedAt:Number.isFinite(publishedAt) ? publishedAt : null
    });
    if (items.length >= limit) break;
  }
  return items;
}

async function fetchText(url, transport = fetch, timeoutMs = PAGE_TIMEOUT_MS, maxBytes = MAX_PAGE_BYTES) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport(url, {
      method:'GET',
      headers:{
        accept:'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.1',
        'user-agent':'Schleswig-Holstein-Pomichnyk/1.0 (+https://t.me/ZaskaletaInfoBot)'
      },
      redirect:'follow',
      signal:controller.signal
    });
    if (!response?.ok) return null;
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    const text = await response.text();
    if (!text || text.length > maxBytes) return null;
    return { text, url:response.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFeed(source, transport = fetch) {
  const page = await fetchText(source.url, transport, FEED_TIMEOUT_MS, 1_000_000);
  return page ? parseRssItems(page.text, source.name, 20) : [];
}

function refugeeRelevant(item) {
  const haystack = `${item?.title || ''} ${item?.description || ''}`;
  return UKRAINE_RE.test(haystack) && REFUGEE_RE.test(haystack);
}


function sourceCandidateScore(candidate, kind) {
  const text = `${candidate.text || ''} ${candidate.title || ''} ${candidate.description || ''}`;
  let score = 0;
  if (kind === 'refugee') {
    if (UKRAINE_RE.test(text)) score += 6;
    if (REFUGEE_RE.test(text)) score += 4;
  } else if (EVENT_RE.test(text)) score += 5;
  if (/2026|2027|september|oktober|november|dezember|januar|februar|märz|april|mai|juni|juli|august/iu.test(text)) score += 1;
  if (/presse|impressum|datenschutz|kontakt|suche/iu.test(candidate.href || '')) score -= 3;
  return score;
}

function asArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function jsonLdObjects(html) {
  const objects = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu;
  for (const match of String(html || '').matchAll(re)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        objects.push(value);
        if (value['@graph']) visit(value['@graph']);
      };
      visit(parsed);
    } catch {}
  }
  return objects;
}

function eventJsonLd(html) {
  return jsonLdObjects(html).find(value => {
    const types = asArray(value?.['@type']).map(type => String(type).toLowerCase());
    return types.includes('event') || types.some(type => type.endsWith('event'));
  }) || null;
}

function articlePublishedAt(html) {
  const value = metaValue(html, ['article:published_time','date','datePublished']);
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const ld = jsonLdObjects(html).find(item => item?.datePublished);
  const ldParsed = Date.parse(ld?.datePublished || '');
  return Number.isFinite(ldParsed) ? ldParsed : null;
}

function addressText(location) {
  const loc = Array.isArray(location) ? location[0] : location;
  if (!loc) return null;
  const name = cleanText(typeof loc === 'string' ? loc : loc.name, 120);
  const address = typeof loc === 'object' ? loc.address : null;
  const parts = [];
  if (name) parts.push(name);
  if (typeof address === 'string') {
    if (cleanText(address, 180)) parts.push(cleanText(address, 180));
  } else if (address && typeof address === 'object') {
    const street = cleanText(address.streetAddress, 120);
    const city = cleanText(address.addressLocality, 100);
    const postal = cleanText(address.postalCode, 20);
    const second = [street, [postal, city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (second) parts.push(second);
  }
  return [...new Set(parts)].join(' · ').slice(0, 220) || null;
}

function eventPrice(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.isAccessibleForFree === true) return 'безкоштовно';
  const offer = asArray(event.offers)[0];
  if (!offer || typeof offer !== 'object') return null;
  const raw = offer.price ?? offer.lowPrice;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(String(raw).replace(',', '.'));
  const currency = cleanText(offer.priceCurrency || 'EUR', 8).toUpperCase();
  if (Number.isFinite(n)) {
    if (n === 0) return 'безкоштовно';
    const formatted = new Intl.NumberFormat('uk-UA', { maximumFractionDigits:2 }).format(n);
    return currency === 'EUR' ? `${formatted} €` : `${formatted} ${currency}`;
  }
  return cleanText(raw, 80);
}

function fallbackEventMeta(text) {
  const source = String(text || '');
  const date = /\b([0-3]?\d[.\/-][01]?\d[.\/-](?:20)?\d{2})\b/u.exec(source)?.[1] || null;
  const time = /\b([0-2]?\d[:.]\d{2})\s*(?:uhr)?\b/iu.exec(source)?.[1]?.replace('.', ':') || null;
  const priceMatch = /\b(?:ab\s*)?(\d{1,4}(?:[,.]\d{1,2})?)\s*(?:€|eur)\b/iu.exec(source);
  return {
    dateText:date,
    timeText:time,
    priceText:priceMatch ? `${priceMatch[1].replace('.', ',')} €` : null
  };
}

function eventMetadata(html, description) {
  const event = eventJsonLd(html);
  const startDate = cleanText(event?.startDate, 80) || null;
  const startAt = startDate ? Date.parse(startDate) : NaN;
  const hasTime = !!startDate && /T\d{2}:\d{2}/u.test(startDate);
  const fallback = fallbackEventMeta(`${description || ''} ${stripTags(html).slice(0, 5000)}`);
  return {
    startAt:Number.isFinite(startAt) ? startAt : null,
    hasTime,
    fallbackDate:fallback.dateText,
    fallbackTime:fallback.timeText,
    place:addressText(event?.location),
    price:eventPrice(event) || fallback.priceText
  };
}

async function enrichCandidate(candidate, sourceName, sourceLang, transport, kind = 'refugee') {
  const page = await fetchText(candidate.link || candidate.href, transport);
  if (!page) return null;
  const link = canonicalLink(page.text, page.url) || page.url;
  const title = cleanText(titleValue(page.text) || candidate.title || candidate.text, 300);
  const description = cleanText(pageDescription(page.text) || candidate.description, 1000);
  const image = pageImage(page.text, page.url);
  if (!title || !image || !link) return null;
  const publishedAt = candidate.publishedAt || articlePublishedAt(page.text);
  const eventMeta = kind === 'event' ? eventMetadata(page.text, description) : null;
  return {
    title,
    description,
    image,
    link,
    source:sourceName,
    sourceLang,
    publishedAt:Number.isFinite(publishedAt) ? publishedAt : null,
    eventMeta
  };
}

async function refugeeCandidates(transport, now, feedSets) {
  const candidates = [];
  REFUGEE_RSS_SOURCES.forEach((source, index) => {
    for (const item of feedSets[index].filter(refugeeRelevant).slice(0, 8)) {
      candidates.push({
        ...item,
        sourceName:source.name,
        sourceLang:source.sourceLang,
        score:sourceCandidateScore(item, 'refugee') + 4
      });
    }
  });

  for (const source of REFUGEE_PAGE_SOURCES) {
    const page = await fetchText(source.url, transport);
    if (!page) continue;
    for (const anchor of extractAnchors(page.text, page.url, 140)) {
      if (anchor.href === page.url) continue;
      const score = sourceCandidateScore(anchor, 'refugee') + (source.dedicated ? 3 : 0);
      if (score < (source.dedicated ? 3 : 7)) continue;
      candidates.push({
        href:anchor.href,
        text:anchor.text,
        sourceName:source.name,
        sourceLang:source.sourceLang,
        score
      });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates.sort((a,b) => (b.score || 0) - (a.score || 0))) {
    const link = candidate.link || candidate.href;
    if (!link || seen.has(link)) continue;
    if (candidate.publishedAt && candidate.publishedAt < now - 14 * 24 * 60 * 60 * 1000) continue;
    seen.add(link);
    unique.push(candidate);
    if (unique.length >= 12) break;
  }
  return unique;
}

export function regionalCandidates(items, now) {
  const seen = new Set();
  const scored = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = `${item?.title || ''} ${item?.description || ''}`;
    if (!item?.link || seen.has(item.link) || SKIP_REGIONAL_RE.test(text) || WEATHER_FORECAST_RE.test(text)) continue;
    const age = Number.isFinite(item.publishedAt) ? now - item.publishedAt : Infinity;
    const eventLike = REGIONAL_EVENT_RE.test(item.title || '');
    if (age < -60 * 60 * 1000 || age > (eventLike ? REGIONAL_EVENT_MAX_AGE_MS : REGIONAL_MAX_AGE_MS)) continue;
    seen.add(item.link);
    let score = 0;
    if (UKRAINE_RE.test(text)) score += 6;
    if (PRACTICAL_RE.test(text)) score += 3;
    if (eventLike) score += 1;
    score += Math.max(0, 2 - age / (12 * 60 * 60 * 1000));
    scored.push({ ...item, eventLike, score });
  }
  return scored.sort((a, b) => b.score - a.score || (b.publishedAt || 0) - (a.publishedAt || 0));
}


function detectedSourceLanguage(text, fallback = 'de') {
  const value = String(text || '');
  if (/\b(?:the|and|with|for|from|festival|concert|family|music)\b/iu.test(value) && !/[äöüß]/iu.test(value)) return 'en';
  return fallback;
}

async function translateToUkrainian(env, text, fallbackLang, budget) {
  const source = cleanText(text, 1200);
  if (!source) return null;
  return translateNewsText(env, source, {
    sourceLang:detectedSourceLanguage(source, fallbackLang),
    max:1400,
    budget
  });
}

async function localizeCard(env, card, kind, city, budget) {
  // Title and teaser are translated together; a card without a title is dropped.
  const [titleUk, descriptionUk] = await Promise.all([
    translateToUkrainian(env, card.title, card.sourceLang || 'de', budget),
    card.description ? translateToUkrainian(env, card.description, card.sourceLang || 'de', budget) : null
  ]);
  if (!titleUk) return null;
  return {
    ...card,
    titleUk,
    descriptionUk,
    kind,
    city:city || null
  };
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

function morningHeader(now) {
  return [
    '🇺🇦 Schleswig-Holstein Помічник',
    `🗞 Головне для українців — ${formatDateBerlin(now)}`,
    '',
    'Важлива інформація для українців у Німеччині + події та дозвілля у Гамбурзі, Любеку та Кілі.'
  ].join('\n');
}

function caption(card) {
  const header = card.kind === 'refugee'
    ? '🇺🇦 Для українців'
    : card.kind === 'regional'
      ? (card.eventLike ? '🎉 Дозвілля · Schleswig-Holstein' : '📰 Schleswig-Holstein')
      : `🎭 Дозвілля · ${cleanText(card.city, 40)}`;

  const lines = [header, '', card.titleUk];

  if (card.kind === 'event') {
    const date = formatEventDate(card.eventMeta);
    const time = formatEventTime(card.eventMeta);
    if (date) lines.push('', `📅 Коли: ${date}${time ? `, ${time}` : ''}`);
    if (card.eventMeta?.place) lines.push(`📍 Де: ${cleanText(card.eventMeta.place, 220)}`);
    if (card.eventMeta?.price) lines.push(`💶 Вартість: ${cleanText(card.eventMeta.price, 80)}`);
  }

  if (card.descriptionUk) lines.push('', cleanText(card.descriptionUk, 360));
  lines.push('', `Джерело: ${card.source}`);
  return lines.join('\n').slice(0, 1024);
}

async function telegramJSON(config, method, payload, transport = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/${method}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(payload),
      signal:controller.signal
    });
    const parsed = await readBoundedJSON(response, 32768);
    return {
      ok:response.ok && !parsed.error && parsed.value?.ok === true,
      data:parsed.error ? null : parsed.value
    };
  } catch {
    return { ok:false, data:null };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendHeader(config, chatId, now, transport) {
  const sent = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text:morningHeader(now),
    disable_notification:false
  }, transport);
  return sent.ok;
}

async function sendCard(config, chatId, card, transport) {
  const sent = await telegramJSON(config, 'sendPhoto', {
    chat_id:chatId,
    photo:card.image,
    caption:caption(card),
    disable_notification:true,
    reply_markup:{
      inline_keyboard:[[
        { text:'🔗 Відкрити джерело', url:card.link }
      ]]
    }
  }, transport);
  return sent.ok;
}

// Each round enriches only as many candidates as cards are still missing and
// translates them in parallel: the instruction model takes 2–4 s per call, so
// translating one card after another doubled the digest time. A candidate whose
// translation fails is replaced from the next round.
async function localizedRounds(candidates, { need, enrich, localize, admit = () => true, accept = () => {} }) {
  const cards = [];
  let index = 0;
  while (cards.length < need && index < candidates.length) {
    const round = [];
    while (cards.length + round.length < need && index < candidates.length) {
      const candidate = candidates[index++];
      if (!admit(candidate, round)) continue;
      const enriched = await enrich(candidate);
      if (enriched && admit(candidate, round, enriched)) round.push({ candidate, enriched });
    }
    const localized = await Promise.all(round.map(({ candidate, enriched }) => localize(enriched, candidate)));
    round.forEach(({ candidate, enriched }, i) => {
      if (!localized[i] || cards.length >= need) return;
      cards.push(localized[i]);
      accept(candidate, enriched);
    });
  }
  return cards;
}

export async function buildNewsCardsV2(env = {}, now = Date.now(), transport = fetch) {
  const budget = { count:0, max:MAX_TRANSLATIONS_PER_RUN };
  const feedSets = await Promise.all(REFUGEE_RSS_SOURCES.map(source => fetchFeed(source, transport)));

  const refugees = await refugeeCandidates(transport, now, feedSets);
  const cards = await localizedRounds(refugees, {
    need:2,
    enrich:candidate => enrichCandidate(candidate, candidate.sourceName, candidate.sourceLang, transport, 'refugee'),
    localize:enriched => localizeCard(env, enriched, 'refugee', null, budget)
  });

  // Headline news of the state (NDR Schleswig-Holstein), translated. The city
  // event calendars render with JavaScript and gave no cards, so events now
  // come from the same feed (festivals, markets, light shows, holiday tips).
  const ndrIndex = REFUGEE_RSS_SOURCES.findIndex(source => source.name === 'NDR Schleswig-Holstein');
  const used = new Set(cards.map(card => card.link));
  let events = 0;
  const regional = await localizedRounds(regionalCandidates(feedSets[ndrIndex] || [], now), {
    need:REGIONAL_CARD_LIMIT,
    enrich:candidate => enrichCandidate(candidate, 'NDR Schleswig-Holstein', 'de', transport, 'regional'),
    localize:(enriched, candidate) => localizeCard(env, enriched, 'regional', null, budget)
      .then(localized => localized && { ...localized, eventLike:candidate.eventLike }),
    // At most one event card; a story is never sent twice.
    admit:(candidate, round, enriched = null) => {
      if (used.has(candidate.link)) return false;
      if (candidate.eventLike && events + round.filter(item => item.candidate.eventLike).length >= 1) return false;
      if (!enriched) return true;
      return !used.has(enriched.link) && !round.some(item => item.enriched.link === enriched.link);
    },
    accept:(candidate, enriched) => {
      used.add(enriched.link);
      if (candidate.eventLike) events += 1;
    }
  });

  return [...cards, ...regional].slice(0, 6);
}

export async function sendNewsDigestToChatV2(config, chatId, env = {}, now = Date.now(), transport = fetch) {
  if (!config || !Number.isSafeInteger(chatId)) {
    return { ok:false, sent:0, reason:'invalid_config' };
  }

  const cards = await buildNewsCardsV2(env, now, transport);
  if (!cards.length) return { ok:false, sent:0, reason:'no_eligible_news' };

  const headerSent = await sendHeader(config, chatId, now, transport);
  let sent = 0;
  for (const card of cards) {
    if (await sendCard(config, chatId, card, transport)) sent += 1;
  }

  return {
    ok:sent > 0,
    sent,
    attempted:cards.length,
    headerSent,
    reason:sent > 0 ? 'sent' : 'telegram_error'
  };
}
