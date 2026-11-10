import { readBoundedJSON } from './pilot-security.mjs';
import { SH_UKRAINIAN_PLACE_ROWS } from './schleswig-holstein-place-names.mjs';
import { SH_MUNICIPALITY_ALIAS_OVERRIDES } from './schleswig-holstein-municipality-alias-overrides.mjs';

const STATELESS_PATH = '/telegram/stateless';
const HOUSING_INTENT = /(?:житл|жиль|квартир|wohnung|wohnraum|miete|оренд|apartment|flat)/iu;

function clean(value, max = 1200) {
  return String(value || '').normalize('NFC').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function aliasPattern(value) {
  const source = clean(value, 120);
  if (!source) return null;
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegex(source)})(?=$|[^\\p{L}\\p{N}])`, 'iu');
}

const PLACE_ALIASES = Object.freeze(
  [...SH_UKRAINIAN_PLACE_ROWS, ...SH_MUNICIPALITY_ALIAS_OVERRIDES]
    .flatMap(row => [row.canonical, ...(row.aliases || [])].map(alias => ({
      canonical:row.canonical,
      jurisdiction:row.jurisdiction,
      alias:clean(alias, 120),
      pattern:aliasPattern(alias)
    })))
    .filter(item => item.alias && item.pattern)
    .sort((a, b) => b.alias.length - a.alias.length)
);

export function matchStatewideHousingPlace(text) {
  const source = clean(text);
  if (!source) return null;
  for (const item of PLACE_ALIASES) {
    const match = item.pattern.exec(source);
    if (!match) continue;
    return Object.freeze({
      canonical:item.canonical,
      jurisdiction:item.jurisdiction,
      alias:item.alias,
      matchText:match[2]
    });
  }
  return null;
}

export function normalizeStatewideHousingText(value) {
  const source = clean(value);
  if (!source || !HOUSING_INTENT.test(source)) return source;
  const place = matchStatewideHousingPlace(source);
  if (!place) return source;

  const canonicalStart = new RegExp(`^${escapeRegex(place.canonical)}(?:\\s|$)`, 'iu');
  if (canonicalStart.test(source) && /(?:^|\s)житл/iu.test(source)) return source;

  const matchedPattern = aliasPattern(place.matchText);
  const stripped = matchedPattern
    ? source.replace(matchedPattern, (all, prefix) => prefix || ' ').replace(/\s+/gu, ' ').trim()
    : source;
  const withoutLeadingHousing = stripped.replace(/^(?:житл[аоу]?|жиль[еёя]|wohnung|wohnraum|квартир[аиу]?|miete|оренд[аиу]?)\s*/iu, '').trim();
  return `${place.canonical} житло ${withoutLeadingHousing}`.replace(/\s+/gu, ' ').trim();
}

export async function normalizeStatewideHousingRequest(request) {
  let url;
  try { url = new URL(request.url); } catch { return request; }
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST') return request;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return request;
  const update = parsed.value;
  const message = update?.message;
  if (message?.chat?.type !== 'private' || typeof message?.text !== 'string') return request;

  const normalized = normalizeStatewideHousingText(message.text);
  if (!normalized || normalized === message.text) return request;

  const copy = JSON.parse(JSON.stringify(update));
  copy.message.text = normalized;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method:'POST', headers, body:JSON.stringify(copy) });
}
