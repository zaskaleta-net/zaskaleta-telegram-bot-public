import test from 'node:test';
import assert from 'node:assert/strict';
import { jobcenterAreaWarnings, scopedJobcenterSearchMarkup } from '../src/runtime-housing-search.mjs';

test('Jobcenter search never warns or rejects solely because area exceeds an orientation', () => {
  const text = jobcenterAreaWarnings([
    { title:'within', areaSqm:74.5 },
    { title:'over', areaSqm:79.5 },
    { title:'unknown', areaSqm:null }
  ], 75);

  assert.equal(text, '');
});

test('Jobcenter search does not emit an area warning when all known areas fit', () => {
  assert.equal(jobcenterAreaWarnings([{ areaSqm:60 }, { areaSqm:75 }], 75), '');
});

test('ImmoScout24 and Immowelt buttons use broad location-room queries instead of brittle path and budget queries', () => {
  const input = {
    inline_keyboard:[
      [
        { text:'↗ ImmoScout24', url:'https://www.google.com/search?q=site%3Aimmobilienscout24.de%2FSuche+Flensburg+3+Zimmer+Wohnung+mieten+bis+661+EUR+Bruttokaltmiete' },
        { text:'↗ Immowelt', url:'https://www.google.com/search?q=site%3Aimmowelt.de%2Fsuche+Flensburg+3+Zimmer+Wohnung+mieten+bis+661+EUR+Bruttokaltmiete' }
      ],
      [{ text:'↗ FAB Flensburg', url:'https://www.fab.sh/main/aktuelle-wohnungsangebote/' }]
    ]
  };

  const output = scopedJobcenterSearchMarkup(input, 'Jobcenter Flensburg', {
    location:'Flensburg', rooms:'3', amount:661, type:'Bruttokaltmiete', radiusKm:15
  });
  const buttons = output.inline_keyboard.flat();
  const scout = buttons.find(button => button.text === '↗ ImmoScout24');
  const welt = buttons.find(button => button.text === '↗ Immowelt');

  assert.ok(scout);
  assert.ok(welt);
  const scoutQuery = new URL(scout.url).searchParams.get('q');
  const weltQuery = new URL(welt.url).searchParams.get('q');
  assert.equal(scoutQuery, 'site:immobilienscout24.de Flensburg 3 Zimmer Wohnung mieten');
  assert.equal(weltQuery, 'site:immowelt.de Flensburg 3 Zimmer Wohnung mieten');
  assert.doesNotMatch(scoutQuery, /\/Suche|661|Bruttokaltmiete/u);
  assert.doesNotMatch(weltQuery, /\/suche|661|Bruttokaltmiete/u);
});
