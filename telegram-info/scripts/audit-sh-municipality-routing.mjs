import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { resolveSchleswigHolsteinJobcenterRoute } from '../src/municipality-directory.mjs';
import { jobcenterRuleLocationForMunicipality } from '../src/schleswig-holstein-jobcenter-route.mjs';
import { SH_STATEWIDE_KDU_COVERAGE, resolveJobcenterRule } from '../src/jobcenter-registry-statewide.mjs';

// Official municipality list: Destatis Gemeindeverzeichnis (GV-ISys), extract
// for the 1st quarter. The RKI RegionKeys mirror used before (pinned commit
// on raw.githubusercontent.com) returned 404 on 17.10.2026; it was itself
// derived from this Destatis data. The file names its Gebietsstand, which is
// asserted, so a newer edition fails loudly instead of shifting the baseline.
const GV_URL = 'https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/Gemeindeverzeichnis/Administrativ/Archiv/GVAuszugQ/AuszugGV1QAktuell.xlsx?__blob=publicationFile';
const EXPECTED_GEBIETSSTAND = 'Gebietsstand am 31.03.2026 (1. Quartal)';
const EXPECTED_ACTIVE_MUNICIPALITIES = 1104;
const PENDING_NUMERIC = new Set(['Neumünster']);

const JURISDICTION_BY_AGS = Object.freeze({
  '01':'Flensburg', '02':'Kiel', '03':'Lübeck', '04':'Neumünster',
  '51':'Dithmarschen', '53':'Herzogtum Lauenburg', '54':'Nordfriesland',
  '55':'Ostholstein', '56':'Pinneberg', '57':'Plön', '58':'Rendsburg-Eckernförde',
  '59':'Schleswig-Flensburg', '60':'Segeberg', '61':'Steinburg', '62':'Stormarn'
});

function placeKey(value) {
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

function cleanCanonical(value) {
  return String(value || '')
    .replace(/,\s*(?:Stadt|Landeshauptstadt|Hansestadt)\s*$/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function agsFromArs(ars) {
  const value = String(ars || '');
  return value.length === 12 ? `${value.slice(0, 5)}${value.slice(-3)}` : '';
}

// Minimal .xlsx reading: the zip central directory, then sharedStrings and
// the data sheet. No dependency for one audit script.
function unzipEntries(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'Gemeindeverzeichnis is not a zip file');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'Broken zip central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    entries.set(name, () => (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const xmlText = value => String(value || '').replace(/<[^>]+>/gu, '').replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'");

function sheetRows(entries) {
  const strings = [...entries.get('xl/sharedStrings.xml')().matchAll(/<si>([\s\S]*?)<\/si>/gu)].map(match => xmlText(match[1]));
  const sheetName = [...entries.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
    .find(name => /Satzart/u.test(entries.get(name)().slice(0, 200000).replace(/<c r="[A-Z]+\d+" [^>]*t="s"[^>]*><v>(\d+)<\/v><\/c>/gu, (_, i) => strings[Number(i)])));
  assert.ok(sheetName, 'Gemeindeverzeichnis data sheet not found');
  return [...entries.get(sheetName)().matchAll(/<row [^>]*>([\s\S]*?)<\/row>/gu)].map(row => {
    const cells = {};
    for (const cell of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const raw = /<v>([\s\S]*?)<\/v>/u.exec(cell[3] || '')?.[1] ?? xmlText(/<is>([\s\S]*?)<\/is>/u.exec(cell[3] || '')?.[1] || '');
      cells[cell[1]] = /t="s"/u.test(cell[2]) && raw !== '' ? strings[Number(raw)] : xmlText(raw);
    }
    return cells;
  });
}

// Satzart 60 = Gemeinde; columns C–G are the ARS parts Land/RB/Kreis/VB/Gem.
function parseGemeindeverzeichnis(buffer) {
  const rows = sheetRows(unzipEntries(buffer));
  const stand = rows.slice(0, 12).flatMap(row => Object.values(row)).find(value => /^Gebietsstand am /u.test(value)) || '';
  assert.equal(stand, EXPECTED_GEBIETSSTAND, `Unexpected Gemeindeverzeichnis edition: ${stand}`);
  const municipalities = [];
  for (const row of rows) {
    if (row.A !== '60' || row.C !== '01') continue;
    const ars = `${row.C}${row.D}${row.E}${row.F}${row.G}`;
    assert.match(ars, /^01\d{10}$/u, `Malformed ARS for ${row.H}`);
    const ags = agsFromArs(ars);
    const jurisdiction = JURISDICTION_BY_AGS[ags.slice(3, 5)] || null;
    if (jurisdiction) municipalities.push(Object.freeze({ ars, ags, canonical:cleanCanonical(row.H), jurisdiction }));
  }
  return { rows:municipalities, stand };
}

function resolvedRuleSignature(resolved) {
  return {
    status:resolved?.status || null,
    jurisdiction:resolved?.jurisdiction || null,
    registryId:resolved?.rule?.registryId || resolved?.module?.id || null,
    zone:resolved?.rule?.zone || resolved?.rule?.groupId || resolved?.zone || null,
    grossColdLimit:resolved?.rule?.grossColdLimit ?? null,
    maxAreaSqm:resolved?.rule?.maxAreaSqm ?? null
  };
}

function semanticallySameRuleLocation(activeLocation, directLocation) {
  const active = resolveJobcenterRule(activeLocation, 3);
  const direct = resolveJobcenterRule(directLocation, 3);
  return {
    same:JSON.stringify(resolvedRuleSignature(active)) === JSON.stringify(resolvedRuleSignature(direct)),
    active:resolvedRuleSignature(active),
    direct:resolvedRuleSignature(direct)
  };
}

function directoryTransport(row) {
  return async url => {
    const target = new URL(String(url));
    assert.equal(target.origin + target.pathname, 'https://www.gemeindeverzeichnis.de/api/gemeinden');
    assert.equal(target.searchParams.get('bundesland'), '01');
    const query = target.searchParams.get('q') || '';
    const matches = placeKey(query) === placeKey(row.canonical)
      ? [{ ags:row.ags, ars:row.ars, normalized_display_name:row.canonical, bundesland_slug:'schleswig-holstein', slug:placeKey(row.canonical).replace(/\s+/gu, '-') }]
      : [];
    return new Response(JSON.stringify({ data:matches }), { status:200, headers:{ 'content-type':'application/json' } });
  };
}

const response = await fetch(GV_URL, { headers:{ accept:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'user-agent':'zaskaleta-info-statewide-routing-audit/1.0' } });
assert.equal(response.ok, true, `Gemeindeverzeichnis fetch failed: HTTP ${response.status}`);
const buffer = Buffer.from(await response.arrayBuffer());
assert.ok(buffer.length > 500_000, `Gemeindeverzeichnis payload unexpectedly small: ${buffer.length}`);

const { rows } = parseGemeindeverzeichnis(buffer);
assert.equal(rows.length, EXPECTED_ACTIVE_MUNICIPALITIES, `Expected ${EXPECTED_ACTIVE_MUNICIPALITIES} active municipalities, got ${rows.length}`);
assert.equal(new Set(rows.map(row => row.ags)).size, rows.length, 'Duplicate AGS in active municipality set');
assert.equal(new Set(rows.map(row => row.ars)).size, rows.length, 'Duplicate ARS in active municipality set');
assert.equal(Object.keys(SH_STATEWIDE_KDU_COVERAGE).length, 15, 'KdU registry must cover all 15 territories');
assert.deepEqual([...new Set(rows.map(row => row.jurisdiction))].sort(), Object.values(JURISDICTION_BY_AGS).sort(), 'Not all 15 territories are covered');

const territoryCounts = Object.fromEntries(Object.values(JURISDICTION_BY_AGS).map(name => [name, 0]));
const failures = [];
let runtimeResolved = 0;
let jobcenterRouted = 0;
let verifiedNumericRules = 0;
let pendingFailClosed = 0;
let canonicalRouted = 0;
let canonicalAmbiguous = 0;

for (const row of rows) {
  territoryCounts[row.jurisdiction] += 1;
  const activeRoute = await resolveSchleswigHolsteinJobcenterRoute(row.canonical, directoryTransport(row));
  if (!activeRoute || activeRoute.jurisdiction !== row.jurisdiction) {
    failures.push({ stage:'active_runtime_resolver', ags:row.ags, municipality:row.canonical, expected:row.jurisdiction, actual:activeRoute?.jurisdiction || null, source:activeRoute?.source || null });
    continue;
  }
  runtimeResolved += 1;

  const directRuleLocation = jobcenterRuleLocationForMunicipality({
    canonical:row.canonical,
    jurisdiction:row.jurisdiction,
    ags:row.ags,
    ars:row.ars
  });
  const ruleLocation = activeRoute.ruleLocation || directRuleLocation;
  if (!ruleLocation) {
    failures.push({ stage:'jobcenter_route_missing', ags:row.ags, municipality:row.canonical, jurisdiction:row.jurisdiction, active:activeRoute.ruleLocation || null, direct:directRuleLocation || null });
    continue;
  }
  if (directRuleLocation && activeRoute.ruleLocation && activeRoute.ruleLocation !== directRuleLocation) {
    const semantic = semanticallySameRuleLocation(activeRoute.ruleLocation, directRuleLocation);
    if (!semantic.same) {
      failures.push({
        stage:'jobcenter_route_semantic_mismatch',
        ags:row.ags,
        municipality:row.canonical,
        jurisdiction:row.jurisdiction,
        active:activeRoute.ruleLocation,
        direct:directRuleLocation,
        activeResolved:semantic.active,
        directResolved:semantic.direct
      });
      continue;
    }
  }
  jobcenterRouted += 1;

  const coverage = SH_STATEWIDE_KDU_COVERAGE[row.jurisdiction];
  if (!coverage) {
    failures.push({ stage:'kdu_coverage', ags:row.ags, municipality:row.canonical, jurisdiction:row.jurisdiction, reason:'missing_coverage' });
    continue;
  }
  const jobcenter = resolveJobcenterRule(ruleLocation, 3);

  // The bot stores and later re-resolves the bare canonical municipality name, so
  // that path must reach the same rule (or ask for the Kreis when the name exists
  // in more than one Kreis) - never another Kreis, Hamburg or unknown_jurisdiction.
  const canonicalResolved = resolveJobcenterRule(activeRoute.canonical, 3);
  if (canonicalResolved?.status === 'ambiguous_municipality') {
    if (canonicalResolved.rule || !canonicalResolved.candidates?.includes(row.jurisdiction)) {
      failures.push({ stage:'canonical_name_ambiguity', ags:row.ags, municipality:row.canonical, jurisdiction:row.jurisdiction, candidates:canonicalResolved.candidates || null });
      continue;
    }
    canonicalAmbiguous += 1;
  } else if (JSON.stringify(resolvedRuleSignature(canonicalResolved)) !== JSON.stringify(resolvedRuleSignature(jobcenter))) {
    failures.push({ stage:'canonical_name_route_mismatch', ags:row.ags, municipality:row.canonical, jurisdiction:row.jurisdiction, ruleLocation, canonical:resolvedRuleSignature(canonicalResolved), route:resolvedRuleSignature(jobcenter) });
    continue;
  } else {
    canonicalRouted += 1;
  }
  if (PENDING_NUMERIC.has(row.jurisdiction)) {
    if (coverage.numericStatus !== 'pending_direct_verification' || jobcenter?.status === 'verified' || jobcenter?.rule) {
      failures.push({ stage:'kdu_fail_closed', ags:row.ags, municipality:row.canonical, jurisdiction:row.jurisdiction, numericStatus:coverage.numericStatus, resolvedStatus:jobcenter?.status || null, exposedRule:!!jobcenter?.rule });
      continue;
    }
    pendingFailClosed += 1;
    continue;
  }
  if (coverage.numericStatus !== 'verified' || !jobcenter || jobcenter.status !== 'verified') {
    failures.push({ stage:'kdu_verified_status', ags:row.ags, municipality:row.canonical, jurisdiction:row.jurisdiction, numericStatus:coverage.numericStatus, resolvedStatus:jobcenter?.status || null, ruleLocation });
    continue;
  }
  if (jobcenter.jurisdiction !== row.jurisdiction) {
    failures.push({ stage:'kdu_wrong_jurisdiction', ags:row.ags, municipality:row.canonical, expected:row.jurisdiction, actual:jobcenter.jurisdiction, ruleLocation });
    continue;
  }
  if (!Number.isFinite(Number(jobcenter.rule?.grossColdLimit)) || !Number.isFinite(Number(jobcenter.rule?.maxAreaSqm))) {
    failures.push({ stage:'kdu_missing_numeric_limit', ags:row.ags, municipality:row.canonical, jurisdiction:row.jurisdiction, ruleLocation });
    continue;
  }
  verifiedNumericRules += 1;
}

assert.deepEqual(failures, [], `Statewide routing/KdU failures: ${JSON.stringify(failures.slice(0, 20))}`);
assert.equal(runtimeResolved, EXPECTED_ACTIVE_MUNICIPALITIES, 'Every municipality must resolve through the active runtime path');
assert.equal(jobcenterRouted, EXPECTED_ACTIVE_MUNICIPALITIES, 'Every municipality must have a Jobcenter rule location');
assert.equal(canonicalRouted + canonicalAmbiguous, EXPECTED_ACTIVE_MUNICIPALITIES, 'Every canonical municipality name must reach its own rule or an explicit Kreis clarification');
assert.equal(verifiedNumericRules + pendingFailClosed, EXPECTED_ACTIVE_MUNICIPALITIES, 'Every municipality must end in verified numeric KdU or explicit fail-closed pending status');

console.log('SH_MUNICIPALITY_ROUTING_AUDIT_PASS', JSON.stringify({
  source:'Destatis Gemeindeverzeichnis (GV-ISys)', version:EXPECTED_GEBIETSSTAND,
  activeMunicipalities:rows.length, territories:Object.keys(territoryCounts).length,
  runtimeResolved, jobcenterRouted, canonicalRouted, canonicalAmbiguous, verifiedNumericRules, pendingFailClosed, territoryCounts
}));
