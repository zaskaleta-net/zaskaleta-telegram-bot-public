import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedJobcenterSearchMarkup } from '../src/runtime-housing-search.mjs';

function labels(markup) {
  return markup.inline_keyboard.flat().map(button => button.text);
}

test('fallback without actual listings keeps only useful generic and correct local sources', () => {
  const input = { inline_keyboard:[
    [{ text:'↗ ImmoScout24', url:'https://example.test/immoscout' }, { text:'↗ Immowelt', url:'https://example.test/immowelt' }],
    [{ text:'↗ Wohnungsunternehmen Dithmarschen', url:'https://www.wo-di.de/wohnen.html' }, { text:'↗ FAB Flensburg', url:'https://www.fab.sh/' }],
    [{ text:'↗ Immomio', url:'https://www.immomio.com/' }, { text:'↗ Ohne-Makler', url:'https://www.ohne-makler.net/' }]
  ] };
  const shown = labels(scopedJobcenterSearchMarkup(input, 'Jobcenter Dithmarschen', { location:'Heide', rooms:'3' }));
  assert.ok(shown.includes('↗ ImmoScout24'));
  assert.ok(shown.includes('↗ Immowelt'));
  assert.ok(shown.includes('↗ Wohnungsunternehmen Dithmarschen'));
  assert.ok(!shown.includes('↗ FAB Flensburg'));
  assert.ok(!shown.includes('↗ Immomio'));
  assert.ok(!shown.includes('↗ Ohne-Makler'));
});

test('Schleswig-Flensburg does not accidentally inherit Flensburg-city provider buttons', () => {
  const input = { inline_keyboard:[
    [{ text:'↗ ImmoScout24', url:'https://example.test/immoscout' }],
    [{ text:'↗ FAB Flensburg', url:'https://www.fab.sh/' }, { text:'↗ SBV Flensburg', url:'https://www.sbv-flensburg.de/' }]
  ] };
  const shown = labels(scopedJobcenterSearchMarkup(input, 'Jobcenter Schleswig-Flensburg'));
  assert.deepEqual(shown, ['↗ ImmoScout24']);
});
