import { readBoundedJSON } from './pilot-security.mjs';
import { archivePilotBugReport, buildPilotReportId } from './bug-report-bridge.mjs';

const BOT_USERNAME = 'ZaskaletaInfoBot';
const REPORT_PROMPT_PREFIX = '🐞 Повідомлення про помилку';
const REPORT_BUTTON = '🐞 Повідомити про помилку';
const LEGACY_REPORT_REPLY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NEWS_BUTTON = '🗞 Новини';
const NDR_FEED = 'https://www.ndr.de/nachrichten/schleswig-holstein/index~rss2.xml';
const LAND_FEED = 'https://www.schleswig-holstein.de/DE/landesportal/service/RSS/RSS_PI_alle/RSSNewsfeed_PI_alle.xml';
const FEED_TIMEOUT_MS = 6000;
const TELEGRAM_TIMEOUT_MS = 8000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function cleanText(value, max = 500) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function command(text) {
  const match = /^\/([a-z0-9_]+)(?:@ZaskaletaInfoBot)?(?:\s+([^\s]{1,64}))?\s*$/iu.exec(String(text || '').trim());
  return match ? { name:match[1].toLowerCase(), arg:String(match[2] || '').toLowerCase() } : null;
}

function isReportAction(text) {
  const parsed = command(text);
  return parsed?.name === 'report' || String(text || '').trim() === REPORT_BUTTON;
}

async function telegramJSON(config, method, payload, transport = fetch, timeoutMs = TELEGRAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

function reportPrompt() {
  return [
    REPORT_PROMPT_PREFIX,
    '',
    'Надішліть скріншот, фото або короткий опис наступним повідомленням.',
    'Натискати «Відповісти» не потрібно — бот сам прив’яже наступне повідомлення до звіту.',
    'Опис — за бажанням. Якщо розумієте проблему, коротко напишіть, що сталося.',
    'Якщо не впевнені, у чому саме проблема, просто надішліть скріншот — цього достатньо.',
    '',
    'Можна також надіслати лише текст без скріншота.',
    'Не надсилайте паролі, банківські дані, номер клієнта Jobcenter або повні копії документів.'
  ].join('\n');
}

function isReportPromptReply(message) {
  return String(message?.reply_to_message?.text || '').startsWith(REPORT_PROMPT_PREFIX);
}

function staleReportReply(message, now) {
  if (!isReportPromptReply(message)) return false;
  const replyDateSeconds = Number(message?.reply_to_message?.date);
  if (!Number.isFinite(replyDateSeconds) || replyDateSeconds <= 0) return false;
  return now - (replyDateSeconds * 1000) > LEGACY_REPORT_REPLY_MAX_AGE_MS;
}

function isReportReply(message, now) {
  return isReportPromptReply(message) && !staleReportReply(message, now);
}

async function cleanupStaleReportReply(config, message, now, transport) {
  if (message?.chat?.type !== 'private' || !staleReportReply(message, now)) return false;
  const chatId = Number(message?.chat?.id);
  const messageId = Number(message?.reply_to_message?.message_id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0 || !Number.isSafeInteger(messageId) || messageId <= 0) return false;
  const deleted = await telegramJSON(config, 'deleteMessage', {
    chat_id:chatId,
    message_id:messageId
  }, transport);
  return deleted.ok;
}

function hasReportContent(message) {
  return Array.isArray(message?.photo) || !!message?.document || !!cleanText(message?.text || message?.caption, 1000);
}

async function sendReportPrompt(config, chatId, transport) {
  return telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text:reportPrompt(),
    disable_notification:true
  }, transport);
}

async function confirmReport(config, chatId, ok, reportId, transport) {
  const text = ok
    ? `✅ Дякуємо. Звіт ${reportId || ''} прийнято.`.replace(/\s+/gu, ' ').trim()
    : '⚠️ Не вдалося прийняти звіт. Спробуйте ще раз через /report.';
  return telegramJSON(config, 'sendMessage', { chat_id:chatId, text, disable_notification:true }, transport);
}

async function copyReportToAdmin(config, adminId, update, reportId, includeMeta, transport) {
  const message = update?.message;
  if (!message) return false;
  const description = cleanText(message.caption || message.text, 1200) || 'Опис не додано користувачем.';

  let metaOk = true;
  if (includeMeta) {
    const meta = [
      `🐞 ${reportId || 'Звіт без номера'}`,
      `Опис: ${description}`
    ].join('\n');
    const metaSent = await telegramJSON(config, 'sendMessage', {
      chat_id:adminId,
      text:meta,
      disable_notification:false
    }, transport);
    metaOk = metaSent.ok;
  }

  if (Array.isArray(message.photo) || message.document) {
    const copied = await telegramJSON(config, 'copyMessage', {
      chat_id:adminId,
      from_chat_id:message.chat.id,
      message_id:message.message_id
    }, transport);
    return metaOk && copied.ok;
  }
  return metaOk;
}

export async function handlePilotCommunityUpdate(update, config, now = Date.now(), transport = fetch) {
  const message = update?.message;
  if (!message || !config) return null;
  const chatId = Number(message.chat?.id);
  const chatType = message?.chat?.type;
  const parsedCommand = command(message.text);
  const reportAction = isReportAction(message.text);

  await cleanupStaleReportReply(config, message, now, transport);

  if (reportAction && ['group','supergroup'].includes(chatType)) {
    const sent = await telegramJSON(config, 'sendMessage', {
      chat_id:chatId,
      text:'🐞 Помилки та скріншоти надсилайте тільки в особистий чат з ботом.',
      disable_notification:true,
      reply_markup:{ inline_keyboard:[[
        { text:'🐞 Надіслати помилку', url:`https://t.me/${BOT_USERNAME}?start=report` }
      ]] }
    }, transport);
    return json({ ok:true, mode:'pilot-report-handoff', delivered:sent.ok });
  }

  if (chatType === 'private' && (reportAction || (parsedCommand?.name === 'start' && parsedCommand.arg === 'report'))) {
    const sent = await sendReportPrompt(config, chatId, transport);
    return json({ ok:true, mode:'pilot-report-prompt', delivered:sent.ok });
  }

  if (chatType === 'private' && isReportReply(message, now) && hasReportContent(message)) {
    const rawReportId = buildPilotReportId(update, now);
    const archive = await archivePilotBugReport(update, config, now, transport)
      .catch(() => ({ queued:false, reportId:rawReportId, caseId:rawReportId, groupFirst:true, reason:'bridge_error' }));
    const reportId = archive?.caseId || rawReportId;
    const isAlbum = typeof message.media_group_id === 'string' && message.media_group_id.trim().length > 0;
    const includeMeta = !isAlbum || archive?.groupFirst !== false;
    const admins = Array.isArray(config.adminUserIds) ? config.adminUserIds.filter(id => Number.isSafeInteger(id) && id > 0) : [];
    let delivered = false;
    for (const adminId of admins) {
      const ok = await copyReportToAdmin(config, adminId, update, reportId, includeMeta, transport);
      delivered ||= ok;
    }
    const accepted = delivered || archive?.queued === true;
    if (includeMeta) await confirmReport(config, chatId, accepted, reportId, transport);
    return json({
      ok:true,
      mode:'pilot-report-submit',
      delivered,
      queued:archive?.queued === true,
      reportId,
      rawReportId,
      groupFirst:includeMeta
    });
  }

  return null;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/giu, '$1')
    .replace(/&#(\d+);/gu, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/giu, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&apos;/giu, "'")
    .replace(/<[^>]+>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tagValue(block, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'iu').exec(block);
  return match ? decodeXml(match[1]) : '';
}

export function parseRssItems(xml, source, limit = 10) {
  const items = [];
  const blocks = String(xml || '').match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/giu) || [];
  for (const block of blocks) {
    const title = cleanText(tagValue(block, 'title'), 220);
    const link = cleanText(tagValue(block, 'link') || tagValue(block, 'guid'), 1000);
    const pubDateRaw = tagValue(block, 'pubDate') || tagValue(block, 'dc:date') || tagValue(block, 'date');
    const pubDate = Date.parse(pubDateRaw);
    if (!title || !/^https?:\/\//iu.test(link)) continue;
    items.push({ title, link, source, publishedAt:Number.isFinite(pubDate) ? pubDate : null });
    if (items.length >= limit) break;
  }
  return items;
}

async function fetchFeed(url, source, transport = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await transport(url, {
      method:'GET',
      headers:{ accept:'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1' },
      signal:controller.signal
    });
    if (!response?.ok) return [];
    const text = await response.text();
    if (text.length > 1_000_000) return [];
    return parseRssItems(text, source, 12);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function recentFirst(items, now, maxItems) {
  const cutoff = now - 36 * 60 * 60 * 1000;
  const recent = items.filter(item => item.publishedAt === null || item.publishedAt >= cutoff);
  return (recent.length ? recent : items).slice(0, maxItems);
}

function formatDateBerlin(now) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone:'Europe/Berlin',
    day:'2-digit', month:'2-digit', year:'numeric'
  }).format(new Date(now));
}

export function berlinNewsDateKey(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Europe/Berlin', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function shouldPublishDailyNews(now) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone:'Europe/Berlin', hour:'2-digit', hourCycle:'h23'
  }).format(new Date(now)));
  return hour >= 8 && hour <= 10;
}

export async function buildDailyNewsDigest(now = Date.now(), transport = fetch) {
  const [ndr, land] = await Promise.all([
    fetchFeed(NDR_FEED, 'NDR Schleswig-Holstein', transport),
    fetchFeed(LAND_FEED, 'Landesregierung Schleswig-Holstein', transport)
  ]);
  const ndrItems = recentFirst(ndr, now, 4);
  const landItems = recentFirst(land, now, 2);
  if (!ndrItems.length && !landItems.length) return null;

  const lines = [
    `🗞 Новини Schleswig-Holstein — ${formatDateBerlin(now)}`,
    '',
    'Коротка ранкова добірка з офіційних та регіональних джерел.'
  ];
  const addSection = (label, items) => {
    if (!items.length) return;
    lines.push('', label);
    for (const item of items) lines.push(`• ${item.title}\n${item.link}`);
  };
  addSection('📍 NDR Schleswig-Holstein', ndrItems);
  addSection('🏛 Landesregierung Schleswig-Holstein', landItems);
  lines.push('', 'Джерела: NDR.de та Landesportal Schleswig-Holstein.');
  return lines.join('\n').slice(0, 4096);
}

export async function sendNewsDigestToChat(config, chatId, now = Date.now(), transport = fetch) {
  const text = await buildDailyNewsDigest(now, transport);
  if (!text) return { ok:false, reason:'feeds_unavailable' };
  const sent = await telegramJSON(config, 'sendMessage', {
    chat_id:chatId,
    text,
    disable_notification:false,
    link_preview_options:{ is_disabled:true }
  }, transport);
  return { ok:sent.ok, reason:sent.ok ? 'sent' : 'telegram_error' };
}

export async function publishDailyNewsToPilotGroups(config, now = Date.now(), transport = fetch) {
  if (!config || !shouldPublishDailyNews(now)) return { sent:0, skipped:true };
  const groups = Array.isArray(config.chatIds)
    ? [...new Set(config.chatIds.filter(id => Number.isSafeInteger(id) && id < 0))]
    : [];
  if (!groups.length) return { sent:0, skipped:true };
  const text = await buildDailyNewsDigest(now, transport);
  if (!text) return { sent:0, skipped:false, error:'feeds_unavailable' };
  let sent = 0;
  for (const chatId of groups) {
    const result = await telegramJSON(config, 'sendMessage', {
      chat_id:chatId,
      text,
      disable_notification:false,
      link_preview_options:{ is_disabled:true }
    }, transport);
    if (result.ok) sent += 1;
  }
  return { sent, skipped:false };
}

export function isNewsCommand(update) {
  const text = String(update?.message?.text || '').trim();
  const parsed = command(text);
  return parsed?.name === 'news' || text === NEWS_BUTTON;
}
