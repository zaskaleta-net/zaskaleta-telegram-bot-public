// "🤝 Консультації": free counselling for immigrants in the user's Kreis from
// the official BAMF-NAvI database (Bundesamt für Migration und Flüchtlinge).
// Verified 17.10.2026: the NAvI web app reads
// /atlas-backend/beratungseinrichtungen?ags=<Kreis key> as JSON; type names
// are those of the NAvI filter. Personal e-mail addresses of counsellors are
// not shown; the office, address, phone and the provider's own page are.
import { placeAgs } from './housing-company-sources.mjs';
import { resolvePlaceName, resolveBarePlaceName, isHamburg } from './place-search.mjs';

const ENDPOINT = 'https://bamf-navi.bamf.de/atlas-backend/beratungseinrichtungen';
export const NAVI_PAGE = 'https://bamf-navi.bamf.de/de/Themen/Beratungsstellen/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BODY_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 6000;
const CACHE_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 15;
const cache = new Map();
export function clearBeratungCache() { cache.clear(); }

// The 15 Kreise and kreisfreie Städte of Schleswig-Holstein by key.
export const SH_KREISE = Object.freeze([
  ['01001', 'Flensburg'], ['01002', 'Kiel'], ['01003', 'Lübeck'], ['01004', 'Neumünster'],
  ['01051', 'Dithmarschen'], ['01053', 'Herzogtum Lauenburg'], ['01054', 'Nordfriesland'], ['01055', 'Ostholstein'],
  ['01056', 'Pinneberg'], ['01057', 'Plön'], ['01058', 'Rendsburg-Eckernförde'], ['01059', 'Schleswig-Flensburg'],
  ['01060', 'Segeberg'], ['01061', 'Steinburg'], ['01062', 'Stormarn']
]);
const KREIS_NAME = new Map(SH_KREISE);

// NAvI type ids, in the order shown; the Ukrainian line says who it is for.
export const BERATUNG_TYPES = Object.freeze([
  { id:1, name:'Migrationsberatung für erwachsene Zugewanderte (MBE)', uk:'для дорослих від 27 років' },
  { id:2, name:'Jugendmigrationsdienst (JMD)', uk:'для молоді 12–27 років' },
  { id:3, name:'Migrationsberatungsstelle in einem Länderprogramm', uk:'консультації за програмою землі' },
  { id:10, name:'Asylverfahrensberatung (AVB)', uk:'щодо процедури надання притулку' },
  { id:11, name:'Asylverfahrensberatung mit besonderer Rechtsberatung (bRB)', uk:'щодо притулку, з юридичною консультацією' }
]);

export function escapeHtml(value) {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

const clean = (value, max = 120) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);

// A town (any SH municipality) or a Kreis name -> { kreis, kreisName, town }.
// Saved after a counselling list (TG-RUNTIME-046): the next message that is
// only a town or Kreis name asks for counselling there too.
export const BERATUNG_FOLLOWUP_PROMPT = '🤝 Консультації: наступна назва міста — консультації поруч.';

// The same place as beratungPlace, but only for a message that is just the name.
export function beratungBarePlace(name) {
  const text = clean(name, 60);
  const bare = isHamburg(text)
    || SH_KREISE.some(([, kreis]) => kreis.toLocaleLowerCase('de-DE') === text.toLocaleLowerCase('de-DE'))
    || Boolean(resolveBarePlaceName(text));
  return bare ? beratungPlace(text) : null;
}

export function beratungPlace(name) {
  const text = clean(name, 60);
  // Hamburg has its own BAMF entries (key 02000).
  if (isHamburg(text)) return { kreis:'02000', kreisName:'Hamburg', town:'Hamburg' };
  const byKreis = SH_KREISE.find(([, kreis]) => kreis.toLocaleLowerCase('de-DE') === text.toLocaleLowerCase('de-DE'));
  const town = resolvePlaceName(text);
  if (byKreis) return { kreis:byKreis[0], kreisName:byKreis[1], town };
  const ags = town ? placeAgs(town) : null;
  if (!ags || !KREIS_NAME.has(ags.slice(0, 5))) return null;
  return { kreis:ags.slice(0, 5), kreisName:KREIS_NAME.get(ags.slice(0, 5)), town };
}

function safeUrl(value) {
  const text = clean(value, 300);
  if (!text) return null;
  const url = /^https?:\/\//iu.test(text) ? text : `https://${text}`;
  try {
    const parsed = new URL(url);
    return /^https?:$/u.test(parsed.protocol) && /\./u.test(parsed.hostname) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function beratungEntries(data, kreis) {
  return (Array.isArray(data) ? data : []).map(item => {
    const type = BERATUNG_TYPES.find(entry => entry.id === Number(item?.typId));
    if (!type || !String(item?.ags || '').startsWith(kreis)) return null;
    const phone = String(item?.telefon || '').split(/\r?\n/u).map(part => clean(part, 30)).filter(part => /\d{4,}/u.test(part.replace(/\D/gu, ''))).slice(0, 2);
    return {
      id:clean(item?.id, 20),
      typeId:type.id,
      // Some names carry an internal number prefix ("29_Caritasverband …").
      name:clean(String(item?.name || '').replace(/^\d{1,3}_/u, ''), 110),
      // Some providers carry their address after a comma; it is shown below.
      provider:clean(String(item?.traeger || '').split(/,\s*(?=[^,]*\d)/u)[0], 110),
      street:clean(item?.strasseHsNr, 80),
      postcode:/^\d{5}$/u.test(String(item?.plz || '')) ? String(item.plz) : '',
      town:clean(item?.ort, 50),
      phone,
      url:safeUrl(item?.url)
    };
  }).filter(entry => entry && entry.name);
}

export async function fetchBeratung(kreis, transport = fetch, now = Date.now()) {
  const cached = cache.get(kreis);
  if (cached && now - cached.at < CACHE_MS) return { status:'ok', entries:cached.entries, cached:true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await transport(`${ENDPOINT}?ags=${encodeURIComponent(kreis)}`, { method:'GET', headers:{ 'user-agent':USER_AGENT, accept:'application/json' }, signal:controller.signal });
    if (!response?.ok) return { status:'unavailable', entries:[] };
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) return { status:'unavailable', entries:[] };
    const entries = beratungEntries(JSON.parse(text), kreis);
    cache.set(kreis, { at:now, entries });
    return { status:'ok', entries };
  } catch {
    return { status:'unavailable', entries:[] };
  } finally {
    clearTimeout(timer);
  }
}

// Grouped by type; with a town, the offices in that town come first.
export function beratungReplyText(entries, place) {
  const header = `🤝 <b>Безкоштовні консультації — ${escapeHtml(place.kreisName)}</b>`;
  if (!entries.length) {
    return [header, '', 'У базі BAMF для цього району консультаційних пунктів не знайдено. Перевірте сусідній район або офіційний пошук (кнопка нижче).'].join('\n');
  }
  const townKey = String(place.town || '').toLocaleLowerCase('de-DE');
  const ordered = [...entries].sort((a, b) => Number(!a.town.toLocaleLowerCase('de-DE').startsWith(townKey || '\u0000')) - Number(!b.town.toLocaleLowerCase('de-DE').startsWith(townKey || '\u0000')));
  const lines = [header, 'Для українців і всіх іммігрантів: документи, Jobcenter, житло, мова, робота. Консультації безкоштовні.'];
  let shown = 0;
  for (const type of BERATUNG_TYPES) {
    const group = ordered.filter(entry => entry.typeId === type.id).slice(0, MAX_ENTRIES - shown);
    if (!group.length) continue;
    lines.push('', `<b>${escapeHtml(type.name)}</b> — ${type.uk}`);
    for (const entry of group) {
      const title = entry.url ? `<a href="${escapeHtml(entry.url)}">${escapeHtml(entry.name)}</a>` : escapeHtml(entry.name);
      const provider = entry.provider && !entry.name.includes(entry.provider) && !entry.provider.includes(entry.name) ? ` (${escapeHtml(entry.provider)})` : '';
      lines.push(`• ${title}${provider}`);
      const address = [entry.street, [entry.postcode, entry.town].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      if (address) lines.push(`   📍 ${escapeHtml(address)}`);
      if (entry.phone.length) lines.push(`   📞 ${escapeHtml(entry.phone.join(' / '))}`);
    }
    shown += group.length;
    if (shown >= MAX_ENTRIES) break;
  }
  if (entries.length > shown) lines.push('', `Ще ${entries.length - shown} — в офіційному пошуку (кнопка нижче).`);
  lines.push('', 'Перед візитом зателефонуйте: години прийому й запис уточнюйте в самій установі.', 'Джерело: BAMF-NAvI (Bundesamt für Migration und Flüchtlinge).');
  return lines.join('\n');
}

export function beratungKeyboard(place = null) {
  const kreise = SH_KREISE.filter(([kreis]) => kreis !== place?.kreis).map(([kreis, name]) => ({ text:name, callback_data:`adv:${kreis}` }));
  const rows = [];
  for (let index = 0; index < kreise.length; index += 3) rows.push(kreise.slice(index, index + 3));
  return { inline_keyboard:[
    ...(place ? [] : rows),
    [{ text:'🔎 Пошук за містом', callback_data:'adv:ask' }],
    [{ text:'🔗 Офіційний пошук BAMF', url:NAVI_PAGE }],
    ...(place ? [[{ text:'🗺 Інший район', callback_data:'nav:advice' }]] : []),
    [{ text:'☰ Меню', callback_data:'nav:menu' }]
  ] };
}

export const BERATUNG_CHOOSE_TEXT = [
  '🤝 <b>Безкоштовні консультації для іммігрантів</b>',
  '',
  'Офіційні консультаційні пункти з бази BAMF: Migrationsberatung (MBE), Jugendmigrationsdienst (JMD) та інші. Там допомагають із документами, листами від Jobcenter чи Ausländerbehörde, житлом, мовними курсами й роботою.',
  '',
  'Оберіть свій район нижче або напишіть: /beratung Назва міста (наприклад, /beratung Elmshorn).'
].join('\n');

// Sent after "🔎 Пошук за містом"; the next text message is read as the town.
export const BERATUNG_TOWN_PROMPT = '🔎 Напишіть назву свого міста чи громади в Schleswig-Holstein — покажу консультації у вашому районі.';

export const BERATUNG_UNAVAILABLE_TEXT = '🤝 Консультації\n\nБаза BAMF зараз недоступна. Спробуйте трохи пізніше або скористайтеся офіційним пошуком (кнопка нижче).';
