// Town search for the menu sections (events, counselling): a name typed in
// Ukrainian ("Тріттау", "Ельмсхорн") or with a small typo ("Elmhorn") finds
// its Schleswig-Holstein municipality. Owner video 17.10.2026: "Тріттау" got
// "Такого міста … не знайдено". Order: exact name, the housing dictionary,
// Ukrainian-to-German transliteration, then the closest official name.
import { SH_RUNTIME_MUNICIPALITY_ROWS } from './sh-municipality-jurisdiction-runtime.mjs';
import { placeName } from './housing-company-sources.mjs';
import { knownHousingLocation } from './housing-language.mjs';

function nameKey(value) {
  return String(value || '').toLocaleLowerCase('de-DE')
    .replace(/ä/gu, 'ae').replace(/ö/gu, 'oe').replace(/ü/gu, 'ue').replace(/ß/gu, 'ss')
    .normalize('NFKD').replace(/[^a-z0-9]/gu, '');
}

let names = null;
function municipalityNames() {
  if (!names) {
    names = new Map();
    for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
      const name = String(row.canonical).replace(/\s*\(.*?\)\s*/gu, ' ').split(',')[0].trim();
      const key = nameKey(name);
      if (key && !names.has(key)) names.set(key, name);
    }
  }
  return names;
}

// Ukrainian letters with the German spellings they usually stand for; a
// letter with two readings (г = g/h, х = ch/h, и = i/y, ж = sch/s) gives
// several candidates.
const CYRILLIC = Object.freeze({
  а:['a'], б:['b'], в:['w', 'v'], г:['h', 'g'], ґ:['g'], д:['d'], е:['e'], є:['je', 'e'], ж:['sch', 's'], з:['s', 'z'],
  и:['i', 'y'], і:['i'], ї:['ji', 'i'], й:['i', 'j', ''], к:['k', 'ck'], л:['l'], м:['m'], н:['n'], о:['o'], п:['p'], р:['r'],
  с:['s', 'ss'], т:['t'], у:['u', 'ue'], ф:['f'], х:['ch', 'h'], ц:['z', 'tz'], ч:['tsch'], ш:['sch'], щ:['schtsch'],
  ь:[''], ю:['ju', 'ue'], я:['ja', 'a'], "'":[''], '’':[''], ы:['y'], э:['e'], ё:['jo'], ъ:['']
});
const MAX_VARIANTS = 64;

export function transliterations(text) {
  let variants = [''];
  for (const char of String(text || '').toLocaleLowerCase('uk-UA')) {
    const options = CYRILLIC[char] || [char];
    const next = [];
    for (const variant of variants) for (const option of options) if (next.length < MAX_VARIANTS) next.push(variant + option);
    variants = next;
  }
  return [...new Set(variants)];
}

function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length:b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

// The closest official name within a small distance; a tie between two
// different towns is no answer (better "not found" than the wrong town).
function closestName(keys) {
  let best = null;
  let bestDistance = Infinity;
  let tie = false;
  for (const key of keys) {
    if (key.length < 3) continue;
    const limit = key.length <= 5 ? 1 : 2;
    for (const [candidate, name] of municipalityNames()) {
      if (candidate[0] !== key[0]) continue;
      const distance = editDistance(key, candidate, limit);
      if (distance > limit) continue;
      if (distance < bestDistance) { best = name; bestDistance = distance; tie = false; }
      else if (distance === bestDistance && name !== best) tie = true;
    }
  }
  return best && !tie ? best : null;
}

export function resolvePlaceName(text) {
  const input = String(text || '').replace(/\s+/gu, ' ').trim().slice(0, 60);
  if (!input) return null;
  const direct = placeName(input);
  if (direct) return direct;
  const known = knownHousingLocation(input);
  const fromDictionary = known ? placeName(known) : null;
  if (fromDictionary) return fromDictionary;
  const keys = /\p{Script=Cyrillic}/u.test(input) ? transliterations(input).map(nameKey) : [nameKey(input)];
  for (const key of keys) {
    const name = municipalityNames().get(key);
    if (name) return name;
  }
  return closestName(keys);
}

// A message that is only a place name (an official name, a Cyrillic spelling
// or a small typo), not a sentence that mentions one: "Шукаю житло в Kiel"
// is no bare place even though resolvePlaceName finds Kiel in it.
export function resolveBarePlaceName(text) {
  const input = String(text || '').replace(/\s+/gu, ' ').trim().slice(0, 60);
  if (!input || /\d/u.test(input)) return null;
  const bare = input.replace(/\s*\(.*?\)\s*/gu, ' ').trim();
  const keys = /\p{Script=Cyrillic}/u.test(bare) ? transliterations(bare).map(nameKey) : [nameKey(bare)];
  // The whole message must be the name, up to the same small typo allowance.
  const whole = name => {
    const target = nameKey(name);
    return keys.some(key => editDistance(key, target, key.length <= 5 ? 1 : 2) <= (key.length <= 5 ? 1 : 2));
  };
  const direct = placeName(input);
  if (direct && whole(direct)) return direct;
  for (const key of keys) {
    const name = municipalityNames().get(key);
    if (name) return name;
  }
  // One Cyrillic word the housing dictionary knows («Хайде», «Ойтін»).
  if (/\p{Script=Cyrillic}/u.test(bare) && !/\s/u.test(bare)) {
    const known = knownHousingLocation(bare);
    const name = known ? placeName(known) || known : null;
    if (name) return name;
  }
  return closestName(keys);
}

// Hamburg is not a Schleswig-Holstein municipality, but many users live next
// to it and type it (owner screenshot 17.10.2026: "Гамбург"). The sections
// that can serve it (events near it, BAMF counselling) ask for it here.
export const HAMBURG = Object.freeze({ town:'Hamburg', ags:'02000000', point:Object.freeze([53.5511, 9.9937]) });

export function isHamburg(text) {
  const key = nameKey(String(text || '').replace(/^(?:freie und )?hansestadt\s+/iu, ''));
  if (key === 'hamburg' || key === 'hh') return true;
  return /\p{Script=Cyrillic}/u.test(String(text || '')) && transliterations(String(text).trim()).map(nameKey).includes('hamburg');
}
