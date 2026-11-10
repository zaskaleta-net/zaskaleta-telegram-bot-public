// Compatibility wrapper around the reviewed housing provider.
// Keep every listing that contributes to the visible count, but never expose an
// unapproved URL as a Telegram link.
export * from './housing-provider-base.mjs';
import { formatEuro, formatArea, formatDistance, priceTypeLabel } from './listing-format.mjs';
import { housingListingMedia as baseHousingListingMedia, listingTitle } from './housing-provider-base.mjs';
// Shown next to the price only when the source names the rent type exactly.
const KNOWN_PRICE_TYPE = /^(?:Warm|Kalt|Nettokalt|Bruttokalt|Gesamt)miete$/u;

const SAFE_URL = /^https:\/\/(?:www\.)?kleinanzeigen\.de\//i;
const SAFE_PUBLIC_URL = /^https:\/\/(?:www\.)?(?:immobilienscout24\.de|immowelt\.de|ohne-makler\.net|kip\.net|wankendorfer\.de|wobau-neumuenster\.de|fab\.sh|wbg-kiel-ost\.de|luebecker-bauverein\.de|wobau-oh\.de|wo-di\.de|trave\.de|wogekiel\.de|neueluebecker\.de|adlershorst\.de|big-verwaltung\.de|zbvv\.de|hausundgrund\.de|wg-gesucht\.de|vonovia\.de|tenant\.immomio\.com)\//i;

function safeHousingUrl(value) {
  const url = String(value || '');
  return SAFE_URL.test(url) || SAFE_PUBLIC_URL.test(url);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fallbackListingCard(item, index) {
  const details = [];
  if (item?.rooms) details.push(`🛏 ${escapeHtml(item.rooms)} кімн.`);
  if (Number.isFinite(item?.areaSqm)) details.push(`📐 ${formatArea(item.areaSqm)} м²`);
  if (Number.isFinite(item?.distanceKm) && !item?.distanceApprox) details.push(`📍 ≈${formatDistance(item.distanceKm)} км`);
  const date = item?.createdAt && /^\d{4}-\d{2}-\d{2}/u.test(item.createdAt)
    ? item.createdAt.slice(0, 10).split('-').reverse().join('.')
    : null;
  if (date) details.push(`📅 ${date}`);
  const caption = [
    `<b>${index + 1}. ${escapeHtml(listingTitle(item))}</b>`,
    `💶 <b>${escapeHtml(formatEuro(item?.price))} €</b>${KNOWN_PRICE_TYPE.test(String(item?.priceType || '')) ? ` ${priceTypeLabel(item.priceType)}` : ''}${Number.isFinite(item?.coldPrice) ? ` (Kaltmiete ${formatEuro(item.coldPrice)} €)` : ''} · ${escapeHtml(String(item?.location || '').slice(0, 100))}`,
    details.join(' · '),
    '🔗 Посилання на джерело недоступне у безпечному форматі.'
  ].filter(Boolean).join('\n');
  const media = item?.imageUrl && /^https:\/\//iu.test(String(item.imageUrl))
    ? String(item.imageUrl)
    : null;
  return { type:media ? 'photo' : 'text', media, caption, parse_mode:'HTML' };
}

export function housingListingMedia(result) {
  const listings = Array.isArray(result?.listings) ? result.listings.slice(0, 5) : [];
  const cards = [];
  let supplementalPending = Boolean(result?.criteria);

  for (let index = 0; index < listings.length; index += 1) {
    const item = listings[index];
    if (safeHousingUrl(item?.url)) {
      const prepared = baseHousingListingMedia({
        ...(result || {}),
        listings:[item],
        criteria:supplementalPending ? result.criteria : null
      })[0];
      if (prepared) {
        cards.push({
          ...prepared,
          caption:String(prepared.caption || '').replace(/^<b>1\. /u, `<b>${index + 1}. `)
        });
        if (supplementalPending) supplementalPending = false;
        continue;
      }
    }
    cards.push(fallbackListingCard(item, index));
  }

  return cards;
}
