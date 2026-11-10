import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  filterHousingListingsToJurisdiction,
  jurisdictionForHousingLocation
} from '../src/housing-jurisdiction-scope.mjs';

test('initial Trittau recovery must reject Bälau and unknown Kreis before merging candidates', () => {
  const recovered = [
    { id:'ahrensburg', location:'22926 Ahrensburg', distanceKm:12.7 },
    { id:'baelau', location:'23881 Bälau', distanceKm:14.0 },
    { id:'reinbek', location:'21465 Reinbek', distanceKm:14.7 },
    { id:'unknown', location:'23881 Unbekannter Ort', distanceKm:13.5 }
  ];

  assert.equal(jurisdictionForHousingLocation('22926 Ahrensburg'), 'Stormarn');
  assert.equal(jurisdictionForHousingLocation('23881 Bälau'), 'Herzogtum Lauenburg');
  assert.equal(jurisdictionForHousingLocation('21465 Reinbek'), 'Stormarn');
  assert.equal(jurisdictionForHousingLocation('23881 Unbekannter Ort'), null);

  assert.deepEqual(
    filterHousingListingsToJurisdiction(recovered, 'Stormarn', 'Trittau').map(item => item.id),
    ['ahrensburg','reinbek']
  );

  // The radius search now runs the primary multi-source search; its merged
  // public candidates are fail-closed to the Jobcenter/Kreis before delivery.
  const source = readFileSync(new URL('../src/housing-primary-search.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export function filterPrimaryListings');
  const end = source.indexOf('export function mergePrimaryListings', start);
  assert.ok(start >= 0 && end > start, 'primary listing filter implementation must be present');
  assert.match(
    source.slice(start, end),
    /filterHousingListingsToJurisdiction\(kept,\s*jurisdiction,\s*criteria\?\.location\)/u,
    'public candidates must be fail-closed to the initial Jobcenter/Kreis before merge'
  );
});
