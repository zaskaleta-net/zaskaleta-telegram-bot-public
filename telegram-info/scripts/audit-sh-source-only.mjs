import assert from 'node:assert/strict';

const URL = 'https://raw.githubusercontent.com/robert-koch-institut/rki.emiga.common/3c65e867d64cb504ee9b733fec98cb55efebfc20/rki.emiga.common/input/fsh/CodeSystem/RegionKeys.fsh';
const EXPECTED_VERSION = '2026-03-31';
const CODES = new Set(['01','02','03','04','51','53','54','55','56','57','58','59','60','61','62']);

const response = await fetch(URL, { headers:{ accept:'text/plain', 'user-agent':'zaskaleta-info-statewide-source-audit/1.0' } });
assert.equal(response.ok, true, `RegionKeys fetch failed: HTTP ${response.status}`);
const text = await response.text();
assert.ok(text.length > 100_000, `RegionKeys payload unexpectedly small: ${text.length}`);
assert.equal(/^\* \^version = "([^"]+)"$/mu.exec(text)?.[1], EXPECTED_VERSION);
assert.match(text, /Quelle:\s*Statistisches Bundesamt, Wiesbaden/iu);

const deprecated = new Set([...text.matchAll(/^\* #(01\d{10}) \^property\[\d+\]\.valueCode = #deprecated\s*$/gmu)].map(m => m[1]));
const active = [];
for (const m of text.matchAll(/^\* #(01\d{10}) "([^"]+)"\s*$/gmu)) {
  if (deprecated.has(m[1])) continue;
  const ags = `${m[1].slice(0,5)}${m[1].slice(-3)}`;
  if (!CODES.has(ags.slice(3,5))) continue;
  active.push({ ars:m[1], ags, name:m[2], code:ags.slice(3,5) });
}
assert.equal(deprecated.size, 3, `deprecated=${deprecated.size}`);
assert.equal(active.length, 1104, `active=${active.length}`);
assert.equal(new Set(active.map(x => x.ags)).size, 1104, 'duplicate AGS');
assert.equal(new Set(active.map(x => x.ars)).size, 1104, 'duplicate ARS');
assert.deepEqual([...new Set(active.map(x => x.code))].sort(), [...CODES].sort());
console.log('SH_SOURCE_ONLY_AUDIT_PASS', JSON.stringify({ version:EXPECTED_VERSION, active:active.length, deprecated:deprecated.size, territories:new Set(active.map(x => x.code)).size }));
