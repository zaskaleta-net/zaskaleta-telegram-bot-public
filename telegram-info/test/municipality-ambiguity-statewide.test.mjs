import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchCuratedSchleswigHolsteinMunicipality,
  resolveSchleswigHolsteinMunicipalityText
} from '../src/municipality-directory.mjs';

function directory(items) {
  return async url => {
    const target = new URL(String(url));
    assert.equal(target.hostname, 'www.gemeindeverzeichnis.de');
    return new Response(JSON.stringify({ data:items }), { status:200, headers:{'content-type':'application/json'} });
  };
}

test('ambiguous German canonical city names are not silently claimed by curated registry', () => {
  assert.equal(matchCuratedSchleswigHolsteinMunicipality('Quickborn'), null);
  assert.equal(matchCuratedSchleswigHolsteinMunicipality('Schenefeld'), null);
  assert.equal(matchCuratedSchleswigHolsteinMunicipality('Nortorf'), null);
});

test('duplicate exact directory results fail closed instead of choosing a wrong Kreis', async () => {
  const quickborn = await resolveSchleswigHolsteinMunicipalityText('Quickborn', directory([
    { ags:'01051089', ars:'010515163089', normalized_display_name:'Quickborn' },
    { ags:'01056041', ars:'010560041041', normalized_display_name:'Quickborn' }
  ]));
  assert.equal(quickborn, null);

  const schenefeld = await resolveSchleswigHolsteinMunicipalityText('Schenefeld', directory([
    { ags:'01056044', ars:'010560044044', normalized_display_name:'Schenefeld' },
    { ags:'01061097', ars:'010615168097', normalized_display_name:'Schenefeld' }
  ]));
  assert.equal(schenefeld, null);

  const nortorf = await resolveSchleswigHolsteinMunicipalityText('Nortorf', directory([
    { ags:'01058117', ars:'010585864117', normalized_display_name:'Nortorf' },
    { ags:'01061077', ars:'010615179077', normalized_display_name:'Nortorf' }
  ]));
  assert.equal(nortorf, null);
});

test('bare compound municipality is resolved by directory, not hijacked by embedded curated city token', async () => {
  const route = await resolveSchleswigHolsteinMunicipalityText('Ostenfeld (Rendsburg)', directory([
    { ags:'01058122', ars:'010585888122', normalized_display_name:'Ostenfeld (Rendsburg)' }
  ]));
  assert.equal(route?.canonical, 'Ostenfeld (Rendsburg)');
  assert.equal(route?.jurisdiction, 'Rendsburg-Eckernförde');
  assert.equal(route?.source, 'gv-isys-directory');
});

test('bare Sylt municipality is not collapsed to curated Sylt municipality', async () => {
  const route = await resolveSchleswigHolsteinMunicipalityText('Kampen (Sylt)', directory([
    { ags:'01054061', ars:'010545492061', normalized_display_name:'Kampen (Sylt)' }
  ]));
  assert.equal(route?.canonical, 'Kampen (Sylt)');
  assert.equal(route?.jurisdiction, 'Nordfriesland');
  assert.equal(route?.source, 'gv-isys-directory');
});
