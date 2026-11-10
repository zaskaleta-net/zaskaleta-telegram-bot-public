import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOUSING_SEARCH_SOURCES,
  externalHousingSearchMarkup,
  housingListingMedia,
  housingListingsMarkup
} from '../src/housing-provider.mjs';

const criteria = { location:'Trittau', rooms:'3-4', amount:1200, type:'Warmmiete', radiusKm:25 };

test('housing source catalog includes 24 safe discovery sources', () => {
  assert.equal(HOUSING_SEARCH_SOURCES.length, 24);
  assert.equal(new Set(HOUSING_SEARCH_SOURCES.map(source => source.id)).size, 24);
  assert.equal(HOUSING_SEARCH_SOURCES[0].mode, 'live_api');
  assert.equal(HOUSING_SEARCH_SOURCES.filter(source => source.mode === 'public_live').length, 8);
  for (const source of HOUSING_SEARCH_SOURCES) assert.match(source.url, /^https:\/\//);
});

test('external search fallback exposes every configured source in twelve compact rows', () => {
  const markup = externalHousingSearchMarkup(criteria);
  const buttons = markup.inline_keyboard.flat();
  const labels = buttons.map(button => button.text);
  assert.equal(markup.inline_keyboard.length, 12);
  assert.equal(buttons.length, 24);
  for (const expected of HOUSING_SEARCH_SOURCES.map(source => source.label)) {
    assert.ok(labels.some(label => label.includes(expected)), expected);
  }
});

test('live-result text fallback keeps listing and supplemental source links compact', () => {
  const result = {
    criteria,
    listings:[{ url:'https://www.kleinanzeigen.de/s-anzeige/test/1234567890-203-1' }]
  };
  const markup = housingListingsMarkup(result);
  const labels = markup.inline_keyboard.flat().map(button => button.text);
  assert.ok(labels.some(label => label.includes('Відкрити оголошення')));
  assert.ok(labels.some(label => label.includes('ImmoScout24')));
  assert.ok(labels.some(label => label.includes('Wankendorfer')));
  assert.ok(markup.inline_keyboard.length <= 16);
});

test('media caption adds one complete multi-source link within Telegram limit', () => {
  const result = {
    criteria,
    listings:[{
      id:'1234567890',
      title:'A'.repeat(140),
      price:999,
      location:'Trittau'.repeat(10),
      rooms:'3',
      areaSqm:90,
      distanceKm:1.2,
      createdAt:'2026-09-10T12:00:00Z',
      imageUrl:'https://images.example.test/photo.jpg',
      url:'https://www.kleinanzeigen.de/s-anzeige/test/1234567890-203-1'
    }]
  };
  const [item] = housingListingMedia(result);
  assert.ok(item);
  assert.ok(item.caption.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot);/g, 'X').length <= 1024);
  assert.equal((item.caption.match(/<a /g) || []).length, (item.caption.match(/<\/a>/g) || []).length);
  assert.match(item.caption, /Пошук ще у 23 джерелах/);
});


test('supplemental caption link searches the exact advertised source set', () => {
  const [item] = housingListingMedia({criteria,listings:[{title:'<A & B>',price:700,location:'Trittau',imageUrl:'https://images.example.test/a.jpg',url:'https://www.kleinanzeigen.de/s-anzeige/a/1234567890'}]});
  const links = [...item.caption.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)];
  assert.equal(links.length, 2);
  assert.match(item.caption, /&lt;A &amp; B&gt;/);
  const query = new URL(links[1][1].replace(/&amp;/g, '&')).searchParams.get('q');
  const sites = [...query.matchAll(/site:([^ )]+)/g)].map(match => match[1]);
  assert.equal(sites.length, 23);
  assert.deepEqual(new Set(sites), new Set(HOUSING_SEARCH_SOURCES.slice(1).map(source => new URL(source.url).hostname.replace(/^www\./,''))));
});
