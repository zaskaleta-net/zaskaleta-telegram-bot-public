import { readBoundedJSON } from './pilot-security.mjs';
import { telegramTextStyle } from './telegram-text-style.mjs';

const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const KLEINANZEIGEN_URL = /^https:\/\/(?:www\.)?kleinanzeigen\.de\//i;
// TG-RUNTIME-062: a listing without a photo is still shown, with a note.
export const PHOTO_MISSING_NOTE = '📷 На сайті фото відсутнє.';
export const PHOTO_FAILED_NOTE = '📷 Фото не вдалося завантажити — перегляньте його на сайті.';
const SAFE_LISTING_URL = /^https:\/\/(?:www\.)?(?:kleinanzeigen\.de|immobilienscout24\.de|immowelt\.de|ohne-makler\.net|kip\.net|wankendorfer\.de|wobau-neumuenster\.de|fab\.sh|wbg-kiel-ost\.de|luebecker-bauverein\.de|wobau-oh\.de|wo-di\.de|trave\.de|wogekiel\.de|neueluebecker\.de|adlershorst\.de|big-verwaltung\.de|zbvv\.de|hausundgrund\.de|wg-gesucht\.de|vonovia\.de|tenant\.immomio\.com)\//i;

async function readBoundedPhoto(response, maxBytes = PHOTO_MAX_BYTES) {
  if (!response?.ok) return null;
  const type = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!PHOTO_TYPES.has(type)) return null;
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > maxBytes ? null : { bytes, type };
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, type };
}

async function downloadPhoto(url, transport, signal, maxBytes = PHOTO_MAX_BYTES) {
  try {
    const response = await transport(String(url), {
      method: 'GET',
      headers: {
        accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8,*/*;q=0.1',
        'user-agent': 'ZaskaletaInfoBot/1.0'
      },
      redirect: 'follow',
      signal
    });
    return await readBoundedPhoto(response, maxBytes);
  } catch {
    return null;
  }
}

function telegramMessageOK(data, chatId) {
  return data?.ok === true && Number.isSafeInteger(data.result?.message_id) && data.result.message_id > 0 && data.result?.chat?.id === chatId;
}

function telegramAlbumOK(data, chatId, expected) {
  return data?.ok === true && Array.isArray(data.result) && data.result.length === expected && data.result.every(item => Number.isSafeInteger(item?.message_id) && item.message_id > 0 && item?.chat?.id === chatId);
}

async function parseTelegram(response) {
  const parsed = await readBoundedJSON(response, 32768);
  return parsed.error ? null : parsed.value;
}

function listingUrlFromCaption(caption) {
  const match = /href="(https:\/\/[^"<>]{1,2048})"/i.exec(String(caption || ''));
  const value = match?.[1]?.replace(/&amp;/g, '&') || '';
  return SAFE_LISTING_URL.test(value) ? value : null;
}

function listingIdFromUrl(url) {
  if (!KLEINANZEIGEN_URL.test(String(url || ''))) return null;
  try {
    const path = new URL(url).pathname;
    const match = /(?:^|\/)(\d{6,20})(?:[-/]|$)/.exec(path);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function callbackData(listingId, ownerUserId) {
  if (!listingId) return null;
  return Number.isSafeInteger(ownerUserId) && ownerUserId > 0
    ? `jc:${listingId}:u${ownerUserId}`
    : `jc:${listingId}`;
}

function listingMarkup(item, ownerUserId = null) {
  const url = listingUrlFromCaption(item?.caption);
  const listingId = listingIdFromUrl(url);
  if (!url) return null;
  const rows = [[{ text: '🔗 Відкрити оголошення', url }]];
  const callback = callbackData(listingId, ownerUserId);
  if (callback) rows.push([{ text: '🏛 Перевірити під Jobcenter', callback_data: callback }]);
  return { inline_keyboard: rows };
}

function markupHasUrl(markup, url) {
  const target = String(url || '');
  return !!target && Array.isArray(markup?.inline_keyboard)
    && markup.inline_keyboard.some(row => Array.isArray(row)
      && row.some(button => String(button?.url || '') === target));
}

function mergeInlineMarkups(primary, secondary) {
  const first = Array.isArray(primary?.inline_keyboard) ? primary.inline_keyboard : [];
  const second = Array.isArray(secondary?.inline_keyboard) ? secondary.inline_keyboard : [];
  if (!first.length) return secondary || null;
  if (!second.length) return primary || null;
  const seen = new Set();
  const rows = [];
  for (const row of [...first, ...second]) {
    const clean = (Array.isArray(row) ? row : []).filter(button => {
      const key = String(button?.callback_data || button?.url || button?.text || '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (clean.length) rows.push(clean);
  }
  return { inline_keyboard:rows };
}

// Drops buttons that belong to other cards of the same batch: their listing link
// and their Jobcenter action. Navigation (pagination, external sources) is kept.
function withoutForeignListingButtons(markup, foreignUrls) {
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : null;
  if (!rows || !foreignUrls.size) return markup;
  const foreignIds = [...foreignUrls].map(listingIdFromUrl).filter(Boolean);
  const isForeign = button => {
    if (foreignUrls.has(String(button?.url || ''))) return true;
    const data = String(button?.callback_data || '');
    return foreignIds.some(id => data === `jc:${id}` || data.startsWith(`jc:${id}:`));
  };
  const kept = rows
    .map(row => (Array.isArray(row) ? row : []).filter(button => !isForeign(button)))
    .filter(row => row.length);
  return kept.length ? { ...markup, inline_keyboard: kept } : null;
}

function enhanceListingMarkup(replyMarkup, ownerUserId = null) {
  const rows = Array.isArray(replyMarkup?.inline_keyboard) ? replyMarkup.inline_keyboard : null;
  if (!rows) return replyMarkup;
  const enhanced = rows.map(row => {
    const copy = Array.isArray(row) ? [...row] : [];
    const urlButton = copy.find(button => SAFE_LISTING_URL.test(String(button?.url || '')));
    const listingId = listingIdFromUrl(urlButton?.url);
    const callback = callbackData(listingId, ownerUserId);
    const callbackAlreadyExists = callback && rows.some(existingRow => Array.isArray(existingRow)
      && existingRow.some(button => String(button?.callback_data || '').startsWith(`jc:${listingId}`)));
    if (callback && !callbackAlreadyExists) {
      copy.push({ text: '🏛 Jobcenter', callback_data: callback });
    }
    return copy;
  });
  return { ...replyMarkup, inline_keyboard: enhanced };
}

function renumberCaption(caption, index) {
  const html = String(caption || '').replace(/^<b>\d+\.\s*/u, `<b>${index + 1}. `);
  // Bot API caps visible text after parsing entities; never slice an HTML tag or href.
  const plain = html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot);/g,
    (_match, name) => ({ amp:'&', lt:'<', gt:'>', quot:'"' })[name]);
  if (plain.length <= 1024) return html;
  return Array.from(plain).slice(0, 500).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plainListingCaption(caption) {
  return String(caption || '')
    .replace(/<a\s+href="[^"]+">\s*🔗\s*Відкрити оголошення\s*<\/a>/giu, '')
    .replace(/<a\s+href="[^"]+">([^<]*)<\/a>/giu, '$1')
    .replace(/<\/?b>/giu, '')
    .replace(/<[^>]*>/gu, '')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .trim();
}

function replyParameters(replyToMessageId) {
  return Number.isSafeInteger(replyToMessageId) && replyToMessageId > 0
    ? { message_id: replyToMessageId, allow_sending_without_reply: false }
    : null;
}

async function sendText(config, text, replyMarkup, transport, signal, replyToMessageId = null, ownerUserId = null) {
  const payload = { chat_id: config.chatId, ...telegramTextStyle(text), disable_notification: true, link_preview_options: { is_disabled: true } };
  const reply = replyParameters(replyToMessageId);
  if (reply) payload.reply_parameters = reply;
  const enhancedMarkup = enhanceListingMarkup(replyMarkup, ownerUserId);
  if (enhancedMarkup) payload.reply_markup = enhancedMarkup;
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });
    const data = await parseTelegram(response);
    if (response.ok && telegramMessageOK(data, config.chatId)) return { status: 'sent', messageId: data.result.message_id, mediaFallback: true };
    if (response.status >= 500 || response.status === 429 || response.ok) return { status: 'uncertain' };
    return { status: 'rejected' };
  } catch {
    return { status: 'uncertain' };
  }
}

function filenameFor(index, type) {
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  return `listing-${index + 1}.${ext}`;
}

async function attachAlbumMarkups(config, entries, messages, transport, signal, ownerUserId = null) {
  const tasks = entries.map(async ({ item }, index) => {
    const replyMarkup = listingMarkup(item, ownerUserId);
    const messageId = messages[index]?.message_id;
    if (!replyMarkup || !Number.isSafeInteger(messageId) || messageId <= 0) return false;
    try {
      const response = await transport(`https://api.telegram.org/bot${config.token}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.chatId, message_id: messageId, reply_markup: replyMarkup }),
        signal
      });
      const data = await parseTelegram(response);
      return response.ok && telegramMessageOK(data, config.chatId);
    } catch {
      return false;
    }
  });
  const results = await Promise.all(tasks);
  return results.filter(Boolean).length;
}

async function sendSeparateListingPhotos({ config, prepared, text, replyMarkup, transport, signal, replyToMessageId, ownerUserId, postText = null, postReplyMarkup = null }) {
  let sent = 0;
  let firstMessageId = null;
  let hadUncertain = false;
  const rejected = [];

  const sendTextCard = async (item, index, navigationButtons, note) => {
    const listingButtons = listingMarkup(item, ownerUserId);
    const listingUrl = listingUrlFromCaption(item?.caption);
    // Generic search markup may already contain this listing row. Prefer that
    // enhanced row instead of adding a second "open / Jobcenter" row pair.
    const itemMarkup = markupHasUrl(navigationButtons, listingUrl)
      ? navigationButtons
      : mergeInlineMarkups(listingButtons, navigationButtons);
    return await sendText(
      config,
      [plainListingCaption(item?.caption) || `Оголошення ${index + 1}`, note].filter(Boolean).join('\n\n'),
      itemMarkup,
      transport,
      signal,
      index === 0 ? replyToMessageId : null,
      ownerUserId
    );
  };

  const batchListingUrls = prepared.map(entry => listingUrlFromCaption(entry.item?.caption));

  for (let index = 0; index < prepared.length; index++) {
    const { item, photo } = prepared[index];
    const foreignUrls = new Set(batchListingUrls.filter((url, other) => url && other !== index && url !== batchListingUrls[index]));
    const navigationButtons = index === prepared.length - 1
      ? withoutForeignListingButtons(enhanceListingMarkup(replyMarkup, ownerUserId), foreignUrls)
      : null;

    if (!photo) {
      const fallback = await sendTextCard(item, index, navigationButtons, item?.media ? PHOTO_FAILED_NOTE : PHOTO_MISSING_NOTE);
      if (fallback.status === 'sent') {
        sent++;
        if (firstMessageId === null) firstMessageId = fallback.messageId;
        continue;
      }
      if (fallback.status === 'rejected') {
        rejected.push(index);
        continue;
      }
      hadUncertain = true;
      break;
    }

    const form = new FormData();
    form.append('chat_id', String(config.chatId));
    form.append('photo', new Blob([photo.bytes], { type: photo.type }), filenameFor(index, photo.type));
    form.append('caption', String(item.caption || ''));
    if (item.parse_mode) form.append('parse_mode', String(item.parse_mode));
    form.append('disable_notification', 'true');
    if (index === 0) {
      const reply = replyParameters(replyToMessageId);
      if (reply) form.append('reply_parameters', JSON.stringify(reply));
    }
    const listingButtons = listingMarkup(item, ownerUserId);
    const itemMarkup = mergeInlineMarkups(listingButtons, navigationButtons);
    if (itemMarkup) form.append('reply_markup', JSON.stringify(itemMarkup));

    try {
      const response = await transport(`https://api.telegram.org/bot${config.token}/sendPhoto`, { method: 'POST', body: form, signal });
      const data = await parseTelegram(response);
      if (response.ok && telegramMessageOK(data, config.chatId)) {
        sent++;
        if (firstMessageId === null) firstMessageId = data.result.message_id;
        continue;
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        // A definite photo rejection is safe to replace with a text card because
        // Telegram confirmed that the photo message was not accepted.
        const fallback = await sendTextCard(item, index, navigationButtons, PHOTO_FAILED_NOTE);
        if (fallback.status === 'sent') {
          sent++;
          if (firstMessageId === null) firstMessageId = fallback.messageId;
          continue;
        }
        if (fallback.status === 'rejected') {
          rejected.push(index);
          continue;
        }
      }
      hadUncertain = true;
      break;
    } catch {
      hadUncertain = true;
      break;
    }
  }

  if (sent > 0) {
    const delivery = {
      sent,
      requested:prepared.length,
      partial:hadUncertain || rejected.length > 0 || sent !== prepared.length
    };
    const finalText = typeof postText === 'function' ? postText(delivery) : postText;
    const finalMarkup = typeof postReplyMarkup === 'function' ? postReplyMarkup(delivery) : postReplyMarkup;
    let postTextDelivered = null;
    if (typeof finalText === 'string' && finalText.trim()) {
      const post = await sendText(config, finalText, finalMarkup, transport, signal, null, ownerUserId);
      postTextDelivered = post.status === 'sent';
    }
    const allTextFallback = prepared.length > 0 && prepared.every(entry => !entry.photo);
    return {
      status:'sent',
      messageId:firstMessageId,
      mediaCount:sent,
      separateCards:true,
      requestedCount:prepared.length,
      ...(allTextFallback ? { mediaFallback:true } : {}),
      ...(typeof finalText === 'string' && finalText.trim() ? { postTextDelivered } : {}),
      ...(delivery.partial || postTextDelivered === false ? { partial:true } : {})
    };
  }
  if (hadUncertain) return { status:'uncertain', mediaCount:0, requestedCount:prepared.length, partial:true };
  return sendText(config, text, replyMarkup, transport, signal, replyToMessageId, ownerUserId);
}

export async function sendHousingMediaReply({ config, media, text, replyMarkup, transport = fetch, signal, replyToMessageId = null, ownerUserId = null, separateItems = true, postText = null, postReplyMarkup = null, indexOffset = 0 }) {
  const requested = Array.isArray(media) ? media.slice(0, 5) : [];
  if (!requested.length) return sendText(config, text, replyMarkup, transport, signal, replyToMessageId, ownerUserId);

  const attempted = await Promise.all(requested.map(async item => ({
    item,
    photo:item?.media && /^https:\/\//iu.test(String(item.media))
      ? await downloadPhoto(item.media, transport, signal)
      : null
  })));

  // Later pages continue the numbering (6., 7., …) instead of restarting at 1.
  const firstNumber = Number.isSafeInteger(indexOffset) && indexOffset > 0 ? indexOffset : 0;
  if (separateItems) {
    const prepared = attempted.map((entry, index) => ({
      ...entry,
      item:{ ...entry.item, caption:renumberCaption(entry.item?.caption, firstNumber + index) }
    }));
    return sendSeparateListingPhotos({
      config, prepared, text, replyMarkup, transport, signal, replyToMessageId,
      ownerUserId, postText, postReplyMarkup
    });
  }

  const downloaded = attempted.filter(entry => entry.photo);
  if (!downloaded.length) return sendText(config, text, replyMarkup, transport, signal, replyToMessageId, ownerUserId);
  const prepared = downloaded.map((entry, index) => ({ ...entry, item: { ...entry.item, caption: renumberCaption(entry.item?.caption, firstNumber + index) } }));

  try {
    let response;
    let expectedAlbum = 0;
    const reply = replyParameters(replyToMessageId);
    if (prepared.length === 1) {
      const [{ item, photo }] = prepared;
      const form = new FormData();
      form.append('chat_id', String(config.chatId));
      form.append('photo', new Blob([photo.bytes], { type: photo.type }), filenameFor(0, photo.type));
      form.append('caption', String(item.caption || ''));
      if (item.parse_mode) form.append('parse_mode', String(item.parse_mode));
      form.append('disable_notification', 'true');
      if (reply) form.append('reply_parameters', JSON.stringify(reply));
      const itemMarkup = listingMarkup(item, ownerUserId) || enhanceListingMarkup(replyMarkup, ownerUserId);
      if (itemMarkup) form.append('reply_markup', JSON.stringify(itemMarkup));
      response = await transport(`https://api.telegram.org/bot${config.token}/sendPhoto`, { method: 'POST', body: form, signal });
    } else {
      expectedAlbum = prepared.length;
      const form = new FormData();
      form.append('chat_id', String(config.chatId));
      form.append('disable_notification', 'true');
      if (reply) form.append('reply_parameters', JSON.stringify(reply));
      const album = prepared.map(({ item }, index) => ({
        type: 'photo',
        media: `attach://photo${index}`,
        caption: String(item.caption || ''),
        ...(item.parse_mode ? { parse_mode: item.parse_mode } : {})
      }));
      form.append('media', JSON.stringify(album));
      prepared.forEach(({ photo }, index) => form.append(`photo${index}`, new Blob([photo.bytes], { type: photo.type }), filenameFor(index, photo.type)));
      response = await transport(`https://api.telegram.org/bot${config.token}/sendMediaGroup`, { method: 'POST', body: form, signal });
    }

    const data = await parseTelegram(response);
    if (response.ok) {
      if (expectedAlbum && telegramAlbumOK(data, config.chatId, expectedAlbum)) {
        const buttonsAttached = await attachAlbumMarkups(config, prepared, data.result, transport, signal, ownerUserId);
        return { status: 'sent', messageId: data.result[0].message_id, mediaCount: expectedAlbum, buttonsAttached };
      }
      if (!expectedAlbum && telegramMessageOK(data, config.chatId)) return { status: 'sent', messageId: data.result.message_id, mediaCount: 1 };
      return { status: 'uncertain' };
    }

    // A definite Telegram 4xx rejection (except rate limiting) means the media message was not accepted,
    // so a single text fallback is safe and prevents a silent bot failure.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) return sendText(config, text, replyMarkup, transport, signal, replyToMessageId, ownerUserId);
    return { status: 'uncertain' };
  } catch {
    return { status: 'uncertain' };
  }
}

// TG-RUNTIME-062: the housing watch sends the photos of new listings as one
// album after its text alert. Photos are uploaded, as for search cards.
export async function downloadListingPhoto(url, transport = fetch, signal, maxBytes = PHOTO_MAX_BYTES) {
  return /^https:\/\//iu.test(String(url || '')) ? downloadPhoto(url, transport, signal, Math.min(PHOTO_MAX_BYTES, maxBytes)) : null;
}

export async function sendListingPhotos({ token, chatId, photos, transport = fetch, signal }) {
  const items = (Array.isArray(photos) ? photos : []).filter(entry => entry?.photo?.bytes).slice(0, 10);
  if (!items.length) return { ok:false, status:0 };
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('disable_notification', 'true');
  let method = 'sendPhoto';
  if (items.length === 1) {
    form.append('photo', new Blob([items[0].photo.bytes], { type: items[0].photo.type }), filenameFor(0, items[0].photo.type));
    form.append('caption', String(items[0].caption || '').slice(0, 1024));
    form.append('parse_mode', 'HTML');
  } else {
    method = 'sendMediaGroup';
    form.append('media', JSON.stringify(items.map((entry, index) => ({ type:'photo', media:`attach://photo${index}`, caption:String(entry.caption || '').slice(0, 1024), parse_mode:'HTML' }))));
    items.forEach((entry, index) => form.append(`photo${index}`, new Blob([entry.photo.bytes], { type: entry.photo.type }), filenameFor(index, entry.photo.type)));
  }
  try {
    const response = await transport(`https://api.telegram.org/bot${token}/${method}`, { method:'POST', body:form, signal });
    const data = await parseTelegram(response);
    return { ok:response.ok && data?.ok === true, status:response.status };
  } catch {
    return { ok:false, status:0 };
  }
}
