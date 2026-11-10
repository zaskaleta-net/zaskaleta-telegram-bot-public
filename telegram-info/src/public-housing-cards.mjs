import { listingTitle } from './housing-provider-base.mjs';
import { sendHousingMediaReply, PHOTO_MISSING_NOTE } from './telegram-media.mjs';
import { formatEuro } from './listing-format.mjs';

const SAFE_DIRECT_HOUSING_URL = /^(?:https:\/\/(?:www\.)?kleinanzeigen\.de\/s-anzeige\/|https:\/\/(?:www\.)?immobilienscout24\.de\/expose\/\d+|https:\/\/(?:www\.)?kip\.net\/schleswig-holstein\/[^?#]+\/mieten\/Wohnung_[^?#]+|https:\/\/(?:www\.)?wo-di\.de\/wohnen\/immobilienansicht\/objekt\/ansicht\/[^?#]+)/iu;
const SAFE_IMAGE_URL = /^https:\/\//i;
const TELEGRAM_SEND_MESSAGE = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/sendMessage$/u;

function shownNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  return number.toLocaleString('de-DE', { maximumFractionDigits:2 });
}

// A euro amount always shows its cents (943,80 €), as on listing cards.
function euro(value) {
  return Number.isFinite(Number(value)) ? formatEuro(value) : shownNumber(value);
}

function clean(value, limit) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeListingUrl(item) {
  const value = String(item?.url || '');
  return SAFE_DIRECT_HOUSING_URL.test(value) ? value : null;
}

function cardLines(criteria, item, index, total) {
  const title = clean(item?.title || 'Оголошення', 140);
  const price = Number(item?.price);
  const priceType = clean(item?.priceType, 40);
  const location = clean(item?.location || criteria?.location || '', 100);
  const rooms = clean(item?.rooms, 24);
  const area = Number(item?.areaSqm);
  const source = clean(item?.source || 'відкрите джерело', 60);
  const lines = [
    `🏠 ${index + 1}/${total} · ${title}`,
    Number.isFinite(price) ? `💶 ${euro(price)} €${priceType ? ` · ${priceType}` : ''}` : null,
    location ? `📍 ${location}` : null,
    rooms ? `🛏 ${rooms} кімн.` : null,
    Number.isFinite(area) ? `📐 ${shownNumber(area)} м²` : null,
    `Джерело: ${source}`,
    SAFE_IMAGE_URL.test(String(item?.imageUrl || '')) ? null : PHOTO_MISSING_NOTE,
    '',
    '⚠️ Це кандидат для перевірки, не Zusicherung.',
    'Ціна з оголошення не підтверджує відповідність Bruttokaltmiete; Nebenkosten потрібно перевіряти окремо.'
  ];
  return lines.filter(value => value !== null).join('\n');
}

export function publicListingCardText(criteria, item, index = 0, total = 1) {
  return cardLines(criteria, item, index, total).slice(0, 4096);
}

export function publicListingCardMarkup(item) {
  const url = safeListingUrl(item);
  if (!url) return null;
  return { inline_keyboard:[[{ text:'🔗 Відкрити оголошення', url }]] };
}

export function publicListingCardMedia(criteria, item, index = 0, total = 1) {
  const url = safeListingUrl(item);
  const imageUrl = String(item?.imageUrl || '');
  if (!url || !SAFE_IMAGE_URL.test(imageUrl)) return [];
  const title = escapeHtml(listingTitle(item, 120) || 'Оголошення');
  const price = Number(item?.price);
  const priceType = escapeHtml(clean(item?.priceType, 32));
  const location = escapeHtml(clean(item?.location || criteria?.location || '', 80));
  const rooms = escapeHtml(clean(item?.rooms, 20));
  const area = Number(item?.areaSqm);
  const source = escapeHtml(clean(item?.source || 'відкрите джерело', 48));
  const caption = [
    `<b>${index + 1}/${total}. ${title}</b>`,
    Number.isFinite(price) ? `💶 ${escapeHtml(euro(price))} €${priceType ? ` · ${priceType}` : ''}` : null,
    location ? `📍 ${location}` : null,
    rooms ? `🛏 ${rooms} кімн.` : null,
    Number.isFinite(area) ? `📐 ${escapeHtml(shownNumber(area))} м²` : null,
    `Джерело: ${source}`,
    `🔗 <a href="${escapeHtml(url)}">Відкрити оголошення</a>`,
    '',
    '⚠️ Кандидат для перевірки, не Zusicherung.',
    'Ціна з оголошення ≠ підтверджена Bruttokaltmiete; Nebenkosten перевіряйте окремо.'
  ].filter(value => value !== null).join('\n');
  return [{ type:'photo', media:imageUrl, caption, parse_mode:'HTML' }];
}

function telegramContext(url, payload) {
  const token = TELEGRAM_SEND_MESSAGE.exec(String(url || ''))?.[1] || '';
  const chatId = Number(payload?.chat_id);
  if (!token || !Number.isSafeInteger(chatId) || chatId === 0) return null;
  const replyToMessageId = Number(payload?.reply_parameters?.message_id);
  return {
    token,
    chatId,
    replyToMessageId:Number.isSafeInteger(replyToMessageId) && replyToMessageId > 0 ? replyToMessageId : null,
    ownerUserId:chatId > 0 ? chatId : null
  };
}

function syntheticTelegramSuccess(chatId, messageId) {
  return new Response(JSON.stringify({ ok:true, result:{ message_id:messageId, chat:{ id:chatId } } }), {
    status:200,
    headers:{ 'content-type':'application/json' }
  });
}

function uncertainTelegramResponse() {
  return new Response(JSON.stringify({ ok:false, description:'housing card delivery uncertain' }), {
    status:502,
    headers:{ 'content-type':'application/json' }
  });
}

export async function sendPublicHousingCards({ url, payload, criteria, result, transport = fetch, signal }) {
  const context = telegramContext(url, payload);
  const listings = (Array.isArray(result?.listings) ? result.listings : [])
    .filter(item => safeListingUrl(item))
    .slice(0, 5);
  if (!context || !listings.length) return null;

  let firstMessageId = null;
  let sent = 0;
  for (let index = 0; index < listings.length; index++) {
    const item = listings[index];
    const outcome = await sendHousingMediaReply({
      config:{ token:context.token, chatId:context.chatId },
      media:publicListingCardMedia(criteria, item, index, listings.length),
      text:publicListingCardText(criteria, item, index, listings.length),
      replyMarkup:publicListingCardMarkup(item),
      transport,
      signal,
      replyToMessageId:index === 0 ? context.replyToMessageId : null,
      ownerUserId:context.ownerUserId,
      separateItems:true
    });

    if (outcome?.status === 'sent') {
      sent += 1;
      if (firstMessageId === null) firstMessageId = outcome.messageId;
      continue;
    }
    if (outcome?.status === 'uncertain') return uncertainTelegramResponse();
    if (sent > 0) break;
    return null;
  }

  return sent > 0 && Number.isSafeInteger(firstMessageId)
    ? syntheticTelegramSuccess(context.chatId, firstMessageId)
    : null;
}
