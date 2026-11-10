import { fetchNordtickerEvents, eventsBriefLines, BRIEF_PAGES } from './events-nordticker.mjs';
import { readBoundedJSON } from './pilot-security.mjs';
import { translateNewsText } from './news-translation.mjs';

const WEATHER_TIMEOUT_MS = 6000;
const TRANSPORT_TIMEOUT_MS = 6000;
export const NAH_SH_HOME = 'https://www.nah.sh/';
export const TRANSPORT_SECTION = '🚆 ВАЖЛИВІ ТРАНСПОРТНІ ЗМІНИ';
const MAX_TRANSPORT_AGE_MS = 8 * 24 * 60 * 60 * 1000;

const WEATHER_POINTS = Object.freeze([
  { name:'Trittau', lat:53.6164, lon:10.4027 },
  { name:'Kiel', lat:54.3233, lon:10.1228 },
  { name:'Lübeck', lat:53.8655, lon:10.6866 },
  { name:'Flensburg', lat:54.7937, lon:9.4469 }
]);

const TRANSPORT_RE = /(?:streik|warnstreik|störung|ausfall|ausfälle|ersatzverkehr|bauarbeiten|sperrung|fahrplanänder|beeinträchtig|verkehrsmeld|zugverkehr|busverkehr|bahnverkehr)/iu;

function cleanText(value, max = 800) {
  return String(value || '')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

function weatherUrl() {
  const params = new URLSearchParams({
    latitude:WEATHER_POINTS.map(point => point.lat).join(','),
    longitude:WEATHER_POINTS.map(point => point.lon).join(','),
    daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_gusts_10m_max',
    timezone:'Europe/Berlin',
    forecast_days:'1'
  });
  return `https://api.open-meteo.com/v1/dwd-icon?${params.toString()}`;
}

async function fetchJSON(url, transport, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport(url, {
      method:'GET',
      headers:{ accept:'application/json', 'user-agent':'Schleswig-Holstein-Pomichnyk/2.0 (+https://t.me/ZaskaletaInfoBot)' },
      redirect:'follow',
      signal:controller.signal
    });
    if (!response?.ok) return null;
    const parsed = await readBoundedJSON(response, 131072);
    return parsed.error ? null : parsed.value;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, transport, timeoutMs, maxBytes = 900000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport(url, {
      method:'GET',
      headers:{ accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'user-agent':'Schleswig-Holstein-Pomichnyk/2.0 (+https://t.me/ZaskaletaInfoBot)' },
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

function weatherCodeLabel(code) {
  if (typeof code !== 'number' || !Number.isFinite(code)) return 'стан погоди не визначено';
  const value = Number(code);
  if ([95,96,99].includes(value)) return 'грози';
  if ([71,73,75,77,85,86].includes(value)) return 'сніг або мокрий сніг';
  if ([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(value)) return 'дощі';
  if ([45,48].includes(value)) return 'туман';
  if ([2,3].includes(value)) return 'мінлива або значна хмарність';
  if ([0,1].includes(value)) return 'переважно сухо';
  return 'змінна погода';
}

function pointForecast(point, item) {
  const daily = item?.daily || {};
  const reading = value => typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  const tMin = reading(daily.temperature_2m_min?.[0]);
  const tMax = reading(daily.temperature_2m_max?.[0]);
  if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) return null;
  if (tMin > tMax) return null;
  const rain = reading(daily.precipitation_probability_max?.[0]);
  const gust = reading(daily.wind_gusts_10m_max?.[0]);
  const code = reading(daily.weather_code?.[0]);
  return {
    name:point.name,
    tMin:Math.round(tMin),
    tMax:Math.round(tMax),
    rain:Number.isFinite(rain) ? Math.max(0, Math.min(100, Math.round(rain))) : null,
    gust:Number.isFinite(gust) ? Math.max(0, Math.round(gust)) : null,
    code:Number.isFinite(code) ? code : null
  };
}

export async function buildWeatherBriefV2(transport = fetch) {
  const raw = await fetchJSON(weatherUrl(), transport, WEATHER_TIMEOUT_MS);
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const forecasts = WEATHER_POINTS.map((point, index) => pointForecast(point, rows[index])).filter(Boolean);
  if (!forecasts.length) return null;

  const min = Math.min(...forecasts.map(item => item.tMin));
  const max = Math.max(...forecasts.map(item => item.tMax));
  const maximumReading = key => {
    const values = forecasts.map(item => item[key]).filter(value => value !== null);
    return values.length ? Math.max(...values) : null;
  };
  const maxRain = maximumReading('rain');
  const maxGust = maximumReading('gust');
  const complete = forecasts.length === WEATHER_POINTS.length && forecasts.every(item => item.rain !== null && item.gust !== null && item.code !== null);
  const priority = code => [95,96,99].includes(code) ? 5 : [71,73,75,77,85,86].includes(code) ? 4 : [51,53,55,56,57,61,63,65,66,67,80,81,82].includes(code) ? 3 : [45,48].includes(code) ? 2 : [2,3].includes(code) ? 1 : 0;
  const dominant = forecasts.filter(item => item.code !== null).sort((a,b) => priority(b.code) - priority(a.code))[0];
  const detail = forecasts.map(item => `${item.name} ${item.tMin}…${item.tMax}°`).join(' · ');
  const summary = [`по землі ${min}…${max} °C`, weatherCodeLabel(dominant?.code)];
  if (maxRain >= 20) summary.push(`опади до ${maxRain}%`);
  if (maxGust >= 35) summary.push(`пориви до ${maxGust} км/год`);
  return { forecasts, min, max, maxRain, maxGust, complete, text:`${summary.join('; ')}.`, detail };
}

function absoluteUrl(value, base) {
  try {
    const url = new URL(String(value || ''), base);
    if (!['http:','https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function parseGermanDate(value) {
  const match = /\b([0-3]?\d)\.([01]?\d)\.(20\d{2})\b/u.exec(String(value || ''));
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day, 12, 0, 0);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? timestamp : null;
}

function nearestGermanDate(source, anchorStart, anchorLength) {
  const start = Math.max(0, anchorStart - 350);
  const end = Math.min(source.length, anchorStart + anchorLength + 250);
  const window = source.slice(start, end);
  const dateRe = /\b[0-3]?\d\.[01]?\d\.20\d{2}\b/gu;
  const anchorEnd = anchorStart + anchorLength;
  let preceding = null;
  let following = null;
  for (const match of window.matchAll(dateRe)) {
    const timestamp = parseGermanDate(match[0]);
    if (!Number.isFinite(timestamp)) continue;
    const absolute = start + match.index;
    if (absolute <= anchorStart) {
      const distance = anchorStart - absolute;
      if (!preceding || distance < preceding.distance) preceding = { timestamp, distance };
      continue;
    }
    const distance = Math.max(0, absolute - anchorEnd);
    if (!following || distance < following.distance) following = { timestamp, distance };
  }
  return preceding?.timestamp ?? following?.timestamp ?? null;
}

export function extractNahTransportItemsV2(html, base, now) {
  const source = String(html || '');
  const candidates = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of source.matchAll(anchorRe)) {
    const link = absoluteUrl(match[1], base);
    const title = cleanText(match[2], 280);
    if (!link || !title || title.length < 12) continue;
    let hostname;
    try { hostname = new URL(link).hostname.replace(/^www\./u, ''); } catch { continue; }
    if (hostname !== 'nah.sh' || !TRANSPORT_RE.test(title)) continue;
    const publishedAt = nearestGermanDate(source, match.index, match[0].length);
    if (!Number.isFinite(publishedAt)) continue;
    if (publishedAt < now - MAX_TRANSPORT_AGE_MS || publishedAt > now + 24 * 60 * 60 * 1000) continue;
    candidates.push({ title, link, publishedAt });
  }
  const seen = new Set();
  return candidates.sort((a,b) => b.publishedAt - a.publishedAt).filter(item => {
    if (seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  }).slice(0, 2);
}

async function translateToUkrainian(env, text) {
  if (!text) return null;
  return translateNewsText(env, cleanText(text, 500), { sourceLang:'de', max:500 });
}

export async function buildTransportBriefV2(env = {}, now = Date.now(), transport = fetch) {
  const page = await fetchText(NAH_SH_HOME, transport, TRANSPORT_TIMEOUT_MS);
  if (!page) return { checked:false, items:[] };
  const items = extractNahTransportItemsV2(page.text, page.url, now);
  const localized = [];
  for (const item of items) localized.push({ ...item, titleUk:await translateToUkrainian(env, item.title) || item.title });
  return { checked:true, items:localized };
}

// Only advice that follows from today's data. No fixed reminders: the same
// "check your Termin" line every morning reads as filler (owner review
// 17.10.2026). Returns [] on an ordinary day, and the section is left out.
function todayAdvice(weather) {
  const bullets = [];
  if (weather?.maxGust >= 55) bullets.push('⚠️ Сильні пориви вітру: закладіть запас часу та будьте обережні на відкритих ділянках.');
  if (weather?.maxRain >= 65) bullets.push('☔ Висока ймовірність опадів: візьміть парасолю або дощовик.');
  if (weather && !weather.complete) bullets.push('🌤 Погодні дані неповні — перевірте місцевий прогноз перед виходом.');
  return bullets;
}

// Weather is always shown; transport, advice and events only when there is
// something to say. A "nothing found" block is not news.
export async function buildMorningBriefV2(env = {}, now = Date.now(), transport = fetch) {
  let weather = null;
  let transportInfo = { checked:false, items:[] };
  let events = [];
  try {
    const [weatherResult, transportResult, eventsResult] = await Promise.all([
      buildWeatherBriefV2(transport),
      buildTransportBriefV2(env, now, transport),
      fetchNordtickerEvents(transport, now, BRIEF_PAGES).catch(() => ({ events:[] }))
    ]);
    weather = weatherResult;
    transportInfo = transportResult;
    events = eventsResult?.events || [];
  } catch {
    // Morning brief is fail-soft: the daily digest must still be publishable.
  }

  // Preserve the existing one-message fallback if both auxiliary sources are down.
  // This keeps weather/transport enrichment additive rather than making the core digest depend on them.
  if (!weather && !transportInfo?.checked) return null;

  const lines = ['🌤 ПОГОДА SCHLESWIG-HOLSTEIN'];
  if (weather) {
    lines.push(weather.text, weather.detail, 'Джерело: DWD ICON (через Open-Meteo).');
  } else {
    lines.push('Автоматичний прогноз тимчасово недоступний. Перевірте погоду перед виходом.');
  }

  if (transportInfo?.items?.length) {
    lines.push('', TRANSPORT_SECTION);
    // No raw URL in the text: the message carries a "🚆 NAH.SH" button.
    for (const item of transportInfo.items) lines.push(`• ${item.titleUk}`);
    lines.push('Перед виїздом перевірте свій маршрут. Джерело: NAH.SH (кнопка нижче).');
  }

  const advice = todayAdvice(weather);
  if (advice.length) {
    lines.push('', '📅 ЩО ВАЖЛИВО СЬОГОДНІ');
    for (const bullet of advice) lines.push(`• ${bullet}`);
  }

  const eventLines = eventsBriefLines(events, now);
  if (eventLines.length) lines.push('', ...eventLines);
  return lines.join('\n').slice(0, 4096);
}
