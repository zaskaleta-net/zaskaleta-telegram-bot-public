// Maps a Schleswig-Holstein municipality name to its pinned Kleinanzeigen
// location id. Names shared by several municipalities are never guessed.
import { SH_RUNTIME_MUNICIPALITY_ROWS } from './sh-municipality-jurisdiction-runtime.mjs';
import { KLEINANZEIGEN_LOCATION_IDS } from './kleinanzeigen-location-ids.mjs';

function placeKey(value) {
  return String(value ?? '').normalize('NFKD').replace(/[̀-ͯ]/gu, '').replace(/ß/gu, 'ss')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

const AGS_BY_NAME = (() => {
  const index = new Map();
  for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
    const key = placeKey(row?.canonical);
    if (key) index.set(key, index.has(key) ? null : row.ags);
  }
  return index;
})();

export function kleinanzeigenLocationId(location) {
  const name = String(location || '').replace(/^\s*\d{5}\s+/u, '');
  const ags = AGS_BY_NAME.get(placeKey(name));
  const id = ags ? KLEINANZEIGEN_LOCATION_IDS[ags] : null;
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}
