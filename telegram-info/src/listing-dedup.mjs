// One flat is often advertised on several portals (Kleinanzeigen, Ohne-Makler,
// KIP, a housing company's own site). Every source gives it a different URL
// and title, so URL and title checks miss it and the user saw it twice.
//
// Cross-portal identity: postcode + rent + living area (+ rooms). Two
// listings with the same identity on DIFFERENT portals are the same flat.
// On the SAME portal they are kept apart: a landlord often offers several
// identical units (staging 13.10.2026, Rendsburg: two ohne-makler ads, both
// 509 €, 52.51 m², 3 rooms, different flats).

function normalizedUrl(value) {
  const url = String(value || '').trim().toLowerCase().replace(/[?#].*$/u, '').replace(/\/+$/u, '');
  return /^https:\/\//u.test(url) ? url : null;
}

export function listingPortal(item) {
  try {
    return new URL(String(item?.url || '')).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return String(item?.sourceId || item?.source || '').toLowerCase() || null;
  }
}

function postcodeOf(item) {
  // Schleswig-Holstein and Hamburg-border postcodes start with 2.
  return /\b(2\d{4})\b/u.exec(`${item?.postcode || ''} ${item?.location || ''}`)?.[1] || null;
}

export function crossPortalFingerprint(item) {
  const postcode = postcodeOf(item);
  const price = Number(item?.price);
  const area = Number(String(item?.areaSqm ?? '').replace(',', '.'));
  if (!postcode || !Number.isFinite(price) || price <= 0 || !Number.isFinite(area) || area <= 0) return null;
  const rooms = Number(String(item?.rooms ?? '').replace(',', '.'));
  return [postcode, Math.round(price), Math.round(area), Number.isFinite(rooms) && rooms > 0 ? Math.round(rooms * 2) / 2 : ''].join('|');
}

// A better-described copy replaces a poorer one (photo, distance, area, rooms).
function quality(item) {
  return (item?.imageUrl ? 4 : 0) + (Number.isFinite(item?.distanceKm) ? 2 : 0) + (item?.areaSqm ? 1 : 0) + (item?.rooms ? 1 : 0);
}

export function dedupeListings(items) {
  const out = [];
  const byUrl = new Map();
  const byFingerprint = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const url = normalizedUrl(item.url);
    if (url && byUrl.has(url)) {
      const index = byUrl.get(url);
      if (quality(item) > quality(out[index])) out[index] = item;
      continue;
    }
    const fingerprint = crossPortalFingerprint(item);
    const portal = listingPortal(item);
    const known = fingerprint ? byFingerprint.get(fingerprint) : null;
    if (known && portal && !known.portals.has(portal)) {
      if (quality(item) > quality(out[known.index])) out[known.index] = item;
      known.portals.add(portal);
      if (url) byUrl.set(url, known.index);
      continue;
    }
    out.push(item);
    const index = out.length - 1;
    if (url) byUrl.set(url, index);
    if (fingerprint && !known) byFingerprint.set(fingerprint, { index, portals:new Set(portal ? [portal] : []) });
    else if (known && portal) known.portals.add(portal);
  }
  return out;
}

// Keys remembered for listings already shown: the URL, and the cross-portal
// identity tagged with its portal, so the same flat from another portal is
// recognised later (radius search first, whole-Kreis search afterwards).
export function crossPortalSeenKey(item) {
  const fingerprint = crossPortalFingerprint(item);
  const portal = listingPortal(item);
  return fingerprint && portal ? `x:${fingerprint}@${portal}` : null;
}

export function seenOnOtherPortal(item, seenKeys) {
  const fingerprint = crossPortalFingerprint(item);
  if (!fingerprint) return false;
  const portal = listingPortal(item);
  const prefix = `x:${fingerprint}@`;
  for (const key of seenKeys) {
    if (typeof key === 'string' && key.startsWith(prefix) && key.slice(prefix.length) !== portal) return true;
  }
  return false;
}
