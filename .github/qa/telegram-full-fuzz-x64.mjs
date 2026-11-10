import assert from 'node:assert/strict';
import { SH_RUNTIME_MUNICIPALITY_ROWS } from '../../telegram-info/src/sh-municipality-jurisdiction-runtime.mjs';
import {
  matchOfficialSchleswigHolsteinMunicipality,
  resolveSchleswigHolsteinMunicipalityText
} from '../../telegram-info/src/municipality-directory.mjs';
import {
  districtSearchLimitCandidates,
  districtSummaryPayload,
  filterUnseenDistrictListings,
  jobcenterSearchSignature,
  listingStateKey,
  radiusPageContextFromText
} from '../../telegram-info/src/runtime-jobcenter.mjs';

function key(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/ß/gu, 'ss')
    .toLowerCase()
    .replace(/[’ʼ'`´]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

let seed = 0x5a17c0de;
function rand() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
}
function pick(values) {
  return values[Math.floor(rand() * values.length)];
}

assert.equal(SH_RUNTIME_MUNICIPALITY_ROWS.length, 1104, 'statewide runtime index must stay pinned to 1,104 municipalities');

const byName = new Map();
for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
  const k = key(row.canonical);
  const bucket = byName.get(k) || [];
  bucket.push(row);
  byName.set(k, bucket);
}

let uniqueMunicipalities = 0;
let ambiguousMunicipalityNames = 0;
let resolverNetworkCalls = 0;
for (const bucket of byName.values()) {
  const canonical = bucket[0].canonical;
  const local = matchOfficialSchleswigHolsteinMunicipality(canonical);
  if (bucket.length === 1) {
    uniqueMunicipalities += 1;
    assert.ok(local, `local statewide resolver missed ${canonical}`);
    assert.equal(local.canonical, canonical);
    assert.equal(local.jurisdiction, bucket[0].jurisdiction);

    const resolved = await resolveSchleswigHolsteinMunicipalityText(canonical, async () => {
      resolverNetworkCalls += 1;
      return new Response('{}', { status:503, headers:{ 'content-type':'application/json' } });
    });
    assert.ok(resolved, `network-independent resolver missed ${canonical}`);
    assert.equal(resolved.jurisdiction, bucket[0].jurisdiction, canonical);
  } else {
    ambiguousMunicipalityNames += 1;
    assert.equal(local, null, `ambiguous bare municipality must fail closed: ${canonical}`);
  }
}

const allowedJurisdictions = new Set(SH_RUNTIME_MUNICIPALITY_ROWS.map(row => row.jurisdiction));
assert.equal(allowedJurisdictions.size, 15, 'statewide runtime must cover exactly 15 territories');

let mutatedNameChecks = 0;
for (let i = 0; i < 5000; i += 1) {
  const row = pick(SH_RUNTIME_MUNICIPALITY_ROWS);
  const variants = [
    row.canonical,
    `  ${row.canonical}  `,
    row.canonical.replace(/\s+/gu, '   '),
    row.canonical.replace(/-/gu, '–'),
    row.canonical.toLocaleUpperCase('de-DE')
  ];
  const input = pick(variants);
  const route = matchOfficialSchleswigHolsteinMunicipality(input);
  if (route) {
    assert.ok(allowedJurisdictions.has(route.jurisdiction), 'fuzz resolver escaped Schleswig-Holstein');
    const sameNameRows = byName.get(key(row.canonical)) || [];
    if (sameNameRows.length === 1) assert.equal(route.jurisdiction, row.jurisdiction, input);
  }
  mutatedNameChecks += 1;
}

let randomGarbageChecks = 0;
const garbageAlphabet = ['?', '!', '#', '/', ':', 'x', 'ж', '9', ' ', '-', '_', '.'];
for (let i = 0; i < 5000; i += 1) {
  const length = 1 + Math.floor(rand() * 80);
  let input = '';
  for (let j = 0; j < length; j += 1) input += pick(garbageAlphabet);
  const route = matchOfficialSchleswigHolsteinMunicipality(input);
  if (route) assert.ok(allowedJurisdictions.has(route.jurisdiction));
  assert.equal(radiusPageContextFromText(input, Math.floor(rand() * 20)), null);
  randomGarbageChecks += 1;
}

let signatureChecks = 0;
for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
  for (const rooms of ['1', '2', '3', '3-4', '10-12']) {
    const persons = 1 + Math.floor(rand() * 20);
    const signature = jobcenterSearchSignature({
      location:row.canonical,
      persons,
      rooms,
      jurisdiction:row.jurisdiction
    });
    assert.ok(signature, `valid signature rejected: ${row.canonical}`);
    signatureChecks += 1;
  }
}
for (const persons of [0, 21, -1, 1.5, Number.NaN]) {
  assert.equal(jobcenterSearchSignature({ location:'Trittau', persons, rooms:'3', jurisdiction:'Stormarn' }), null);
}

const listings = Array.from({ length:1000 }, (_, i) => ({
  id:`qa-${i}`,
  url:`https://example.invalid/listing/${i}?tracking=1`,
  title:`QA Wohnung ${i}`,
  location:SH_RUNTIME_MUNICIPALITY_ROWS[i % SH_RUNTIME_MUNICIPALITY_ROWS.length].canonical,
  price:400 + (i % 700),
  rooms:1 + (i % 5),
  areaSqm:35 + (i % 90)
}));
const seenKeys = listings.filter((_, i) => i % 3 === 0).map(listingStateKey);
const effectiveSeenKeys = seenKeys.slice(0, 120);
const unseen = filterUnseenDistrictListings(listings, seenKeys);
assert.equal(unseen.length, 1000 - effectiveSeenKeys.length, 'district dedup must honor the bounded 120-key durable state');
const effectiveSeenSet = new Set(effectiveSeenKeys);
for (const item of unseen) assert.equal(effectiveSeenSet.has(listingStateKey(item)), false);

let paginationChecks = 0;
for (let i = 0; i < 3000; i += 1) {
  const visibleCount = Math.floor(rand() * 6);
  const pageStart = Math.floor(rand() * 6) * 5;
  const total = pageStart + visibleCount + Math.floor(rand() * 10);
  const visible = Array.from({ length:visibleCount }, (_, index) => ({
    location:pick(SH_RUNTIME_MUNICIPALITY_ROWS).canonical,
    url:`https://example.invalid/p/${i}/${index}`
  }));
  const hasMore = total > pageStart + visibleCount;
  const payload = districtSummaryPayload({
    jurisdiction:pick([...allowedJurisdictions]),
    listings:visible,
    pageStart,
    total,
    hasMore,
    location:'Trittau',
    persons:4,
    rooms:'3-4'
  });
  assert.ok(typeof payload.text === 'string' && payload.text.length > 0 && payload.text.length <= 4096);
  assert.equal(Boolean(payload.reply_markup), hasMore);
  paginationChecks += 1;
}

let radiusContextChecks = 0;
for (let i = 0; i < 2000; i += 1) {
  const row = pick(SH_RUNTIME_MUNICIPALITY_ROWS);
  const radius = pick([15, 20, 25]);
  const persons = 1 + Math.floor(rand() * 20);
  const rooms = pick(['1', '2', '3', '3-4']);
  const text = [
    `🔎 Автопошук житла під Jobcenter — ${row.canonical}`,
    `Осіб: ${persons}`,
    `Кімнати: ${rooms}`,
    `📍 Радіус пошуку: ${radius} км`
  ].join('\n');
  const page = Math.floor(rand() * 20);
  const parsed = radiusPageContextFromText(text, page);
  assert.ok(parsed);
  assert.equal(parsed.location, row.canonical);
  assert.equal(parsed.persons, persons);
  assert.equal(parsed.rooms, rooms);
  assert.equal(parsed.radius, radius);
  assert.equal(parsed.page, page);
  radiusContextChecks += 1;
}

let districtAnchorChecks = 0;
for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
  const candidates = districtSearchLimitCandidates(row.jurisdiction, row.canonical);
  assert.ok(candidates.length >= 1 && candidates.length <= 5, `unbounded district candidates: ${row.canonical}`);
  assert.equal(candidates[0], row.canonical);
  assert.equal(new Set(candidates).size, candidates.length);
  districtAnchorChecks += 1;
}

console.log('TELEGRAM_FULL_FUZZ_X64_PASS', JSON.stringify({
  officialMunicipalities:SH_RUNTIME_MUNICIPALITY_ROWS.length,
  uniqueMunicipalities,
  ambiguousMunicipalityNames,
  jurisdictions:allowedJurisdictions.size,
  resolverNetworkCalls,
  mutatedNameChecks,
  randomGarbageChecks,
  signatureChecks,
  dedupListings:listings.length,
  paginationChecks,
  radiusContextChecks,
  districtAnchorChecks,
  deterministicSeed:'0x5a17c0de'
}));
