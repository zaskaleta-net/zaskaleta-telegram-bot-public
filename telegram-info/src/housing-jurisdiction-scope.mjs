import { SH_RUNTIME_MUNICIPALITY_JURISDICTIONS, SH_RUNTIME_MUNICIPALITY_ROWS } from './sh-municipality-jurisdiction-runtime.mjs';
import {
  SH_JURISDICTIONS,
  administrativeAreaForJurisdiction,
  normalizeSchleswigHolsteinJurisdiction
} from './jobcenter-jurisdictions.mjs';

const JURISDICTIONS = new Set(SH_JURISDICTIONS);
const EXPLICIT_FOREIGN_REGION = /(?:\(\s*(?:mecklenburg(?:-vorpommern)?|niedersachsen|hamburg|bremen)\s*\)|,\s*(?:mecklenburg(?:-vorpommern)?|niedersachsen|hamburg|bremen)\s*$)/iu;
const HAMBURG_LOCALITY = /(?:^|[^\p{L}])(?:hamburg|wandsbek|altona|bergedorf|eimsbüttel|eimsbuettel|harburg|hamburg[-\s]?mitte|hamburg[-\s]?nord)(?=$|[^\p{L}])/iu;

function key(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ß/gu, 'ss')
    .toLowerCase()
    .replace(/\([^)]*\bkm\s*\)\s*$/giu, ' ')
    .replace(/\b\d{5}\b/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const MUNICIPALITY_JURISDICTION = new Map(
  Object.entries(SH_RUNTIME_MUNICIPALITY_JURISDICTIONS)
    .filter(([, jurisdiction]) => JURISDICTIONS.has(jurisdiction))
);

// Portals drop the official qualifier: "Reinfeld (Holstein)" is listed as
// "23858 Reinfeld". Accept the bare name only when every municipality that
// carries it belongs to one jurisdiction and the bare name is not taken.
{
  const bare = new Map();
  for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
    const name = key(String(row?.canonical || '').replace(/\s*\([^)]*\)\s*$/u, ''));
    if (!name) continue;
    if (!bare.has(name)) bare.set(name, new Set());
    bare.get(name).add(row.jurisdiction);
  }
  for (const [name, jurisdictions] of bare) {
    const [only] = jurisdictions;
    if (jurisdictions.size === 1 && JURISDICTIONS.has(only) && !MUNICIPALITY_JURISDICTION.has(name)
        && !SH_RUNTIME_MUNICIPALITY_ROWS.some(row => key(row?.canonical) === name && row.jurisdiction !== only)) {
      MUNICIPALITY_JURISDICTION.set(name, only);
    }
  }
}

const MUNICIPALITY_NAMES = [...MUNICIPALITY_JURISDICTION.entries()]
  .filter(([, jurisdiction]) => jurisdiction)
  .sort((a, b) => b[0].length - a[0].length);

export function jurisdictionForHousingLocation(value) {
  const raw = String(value || '');
  if (EXPLICIT_FOREIGN_REGION.test(raw)) return null;
  const normalized = key(raw);
  if (!normalized) return null;

  // Resolve an exact pinned Schleswig-Holstein municipality before applying
  // foreign-locality guards. This preserves legitimate names such as
  // "Wentorf bei Hamburg" (Herzogtum Lauenburg) while still rejecting
  // unresolved Hamburg localities.
  const direct = MUNICIPALITY_JURISDICTION.get(normalized);
  if (direct) return direct;

  if (HAMBURG_LOCALITY.test(raw)) return null;

  const admin = normalizeSchleswigHolsteinJurisdiction(value);
  if (admin && JURISDICTIONS.has(admin)) return admin;

  const padded = ` ${normalized} `;
  let found = null;
  for (const [name, jurisdiction] of MUNICIPALITY_NAMES) {
    if (!padded.includes(` ${name} `)) continue;
    if (found && found !== jurisdiction) return null;
    found = jurisdiction;
  }
  return found;
}

export function housingListingMatchesJurisdiction(item, jurisdiction, originLocation = '') {
  const target = normalizeSchleswigHolsteinJurisdiction(jurisdiction) || (JURISDICTIONS.has(String(jurisdiction || '')) ? String(jurisdiction) : null);
  if (!target) return false;

  const rawLocation = String(item?.location || '');
  if (EXPLICIT_FOREIGN_REGION.test(rawLocation) || HAMBURG_LOCALITY.test(rawLocation)) return false;

  const resolved = jurisdictionForHousingLocation(rawLocation);
  if (resolved) return resolved === target;

  const area = administrativeAreaForJurisdiction(target);
  if (area?.type !== 'kreisfreie_stadt') return false;

  const locationKey = key(rawLocation);
  const targetKey = key(target);
  if (locationKey && targetKey && (locationKey === targetKey || locationKey.includes(` ${targetKey} `) || locationKey.startsWith(`${targetKey} `) || locationKey.endsWith(` ${targetKey}`))) {
    return true;
  }

  // Kleinanzeigen city-scoped public pages often label neighborhoods
  // (e.g. "24143 Gaarden") without repeating the kreisfreie Stadt name.
  // Trust an unresolved neighborhood only when it came from the verified
  // location-scoped result page itself. Explicit foreign municipalities were
  // already rejected above through their resolved jurisdiction.
  if (
    item?.sourceId === 'kleinanzeigen-public' &&
    jurisdictionForHousingLocation(originLocation) === target &&
    (item?.locationScoped === true || /^\s*\d{5}\s+[^,()]+\s*$/u.test(rawLocation))
  ) {
    return true;
  }

  return false;
}

export function filterHousingListingsToJurisdiction(listings, jurisdiction, originLocation = '') {
  return (Array.isArray(listings) ? listings : [])
    .filter(item => housingListingMatchesJurisdiction(item, jurisdiction, originLocation));
}
