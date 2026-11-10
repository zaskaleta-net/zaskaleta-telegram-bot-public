import { readBoundedJSON } from './pilot-security.mjs';

const API_ROOT = 'https://api.kleinanzeigen-agent.de/api/v2/kleinanzeigen';
const KEY = /^klaz_live_[A-Za-z0-9_-]{8,256}$/;
const AD_ID = /^\d{6,20}$/;
const MAX_BYTES = 524288;

function firstNumber(value, min, max) {
  const match = String(value ?? '').replace(',', '.').match(/\d{1,4}(?:\.\d{1,2})?/u);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function areaSqm(ad) {
  if (ad?.details && typeof ad.details === 'object' && !Array.isArray(ad.details)) {
    for (const [name, value] of Object.entries(ad.details)) {
      if (/wohnfl[aä]che|wohnflaeche|fl[aä]che/iu.test(String(name))) {
        const found = firstNumber(value, 10, 1000);
        if (found !== null) return found;
      }
    }
  }
  for (const attribute of Array.isArray(ad?.attributes) ? ad.attributes : []) {
    const name = `${attribute?.name || ''} ${attribute?.label || ''}`;
    if (!/wohnfl[aä]che|wohnflaeche/iu.test(name)) continue;
    for (const value of Array.isArray(attribute?.values) ? attribute.values : []) {
      const found = firstNumber(value?.value ?? value?.label, 10, 1000);
      if (found !== null) return found;
    }
  }
  const text = `${ad?.title || ''} ${ad?.description || ''}`;
  const match = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:m²|qm|m2)/iu.exec(text);
  return match ? firstNumber(match[1], 10, 1000) : null;
}

function rooms(ad) {
  if (ad?.details && typeof ad.details === 'object' && !Array.isArray(ad.details)) {
    for (const [name, value] of Object.entries(ad.details)) {
      if (String(name).toLocaleLowerCase('de-DE') === 'zimmer') {
        const found = firstNumber(value, 0.5, 30);
        if (found !== null) return found;
      }
    }
  }
  for (const attribute of Array.isArray(ad?.attributes) ? ad.attributes : []) {
    const name = `${attribute?.name || ''} ${attribute?.label || ''}`.toLocaleLowerCase('de-DE');
    if (!name.includes('zimmer')) continue;
    for (const value of Array.isArray(attribute?.values) ? attribute.values : []) {
      const found = firstNumber(value?.value ?? value?.label, 0.5, 30);
      if (found !== null) return found;
    }
  }
  return null;
}

function location(ad) {
  return String(ad?.location?.name || ad?.location?.city || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
}

function failureStatus(status, code) {
  if (status === 401 || status === 403 || /API_KEY|AUTH/iu.test(String(code || ''))) return 'auth_error';
  if (status === 402 || /CREDIT/iu.test(String(code || ''))) return 'insufficient_credits';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_unavailable';
  return 'unavailable';
}

export async function getLiveHousingAdDetail(adId, key, transport = fetch) {
  const id = String(adId || '');
  if (!AD_ID.test(id) || !KEY.test(String(key || ''))) return { status:'not_configured' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await transport(`${API_ROOT}/ads/${id}`, {
      method:'GET',
      headers:{ accept:'application/json', authorization:`Bearer ${key}`, klaz_key:key },
      redirect:'manual',
      signal:controller.signal
    });
    if (response.status >= 300 && response.status < 400) return { status:'unavailable' };
    const parsed = await readBoundedJSON(response, MAX_BYTES);
    if (parsed.error) return { status:'unavailable' };
    if (!response.ok || parsed.value?.success !== true) {
      return { status:failureStatus(response.status, parsed.value?.error_code) };
    }
    const ad = parsed.value?.data?.ad;
    if (!ad || String(ad.ad_id || id) !== id) return { status:'unavailable' };
    return {
      status:'ok',
      id,
      location:location(ad),
      areaSqm:areaSqm(ad),
      rooms:rooms(ad),
      price:Number.isFinite(Number(ad?.price?.amount)) ? Number(ad.price.amount) : null,
      url:typeof ad?.ad_url === 'string' && /^https:\/\/(?:www\.)?kleinanzeigen\.de\//iu.test(ad.ad_url) ? ad.ad_url : null
    };
  } catch {
    return { status:'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}
