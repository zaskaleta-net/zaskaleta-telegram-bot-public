import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_LIVE_HOUSING_SOURCES, parsePublicHousingPage } from '../src/housing-public-sources.mjs';

const TRAVE_DETAIL_HTML = `
<main>
  <h1>Gemütliche Wohnung nahe des Wesloer Forst</h1>
  <div>Anzahl Zimmer: 2.2</div>
  <div>Etage: 2</div>
  <div>Wohnfläche: 50,97 m²</div>
  <div>Nettokaltmiete: 308,88 €</div>
  <div>Betriebskostenvorauszahlung: 153,00 €</div>
  <div>Bruttokaltmiete: 461,88 €</div>
  <div>Zusätzlich zu zahlen: Heiz- und Wasserkosten</div>
  <div>Kirschenallee 22</div>
  <div>23566 Lübeck (Marli)</div>
</main>`;

test('TRAVE Lübeck is an approved bounded public-live source', () => {
  const source = PUBLIC_LIVE_HOUSING_SOURCES.find(item => item.id === 'trave-luebeck');
  assert.ok(source);
  assert.equal(source.label, 'TRAVE Lübeck');
  assert.match(source.url, /^https:\/\/www\.trave\.de\//);
  assert.equal(source.priceType, 'Bruttokaltmiete');
});

test('TRAVE parser extracts rooms, area and Bruttokaltmiete conservatively', () => {
  const criteria = { location:'Lübeck', rooms:'2-3', roomsMin:2, roomsMax:3, amount:500, type:'Kaltmiete' };
  const listings = parsePublicHousingPage('trave-luebeck', TRAVE_DETAIL_HTML, criteria);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].source, 'TRAVE Lübeck');
  assert.equal(listings[0].rooms, 2.2);
  assert.equal(listings[0].areaSqm, 50.97);
  assert.equal(listings[0].price, 461.88);
  assert.equal(listings[0].priceType, 'Bruttokaltmiete');
  assert.match(listings[0].location, /23566 Lübeck/);
});

test('TRAVE parser rejects wrong location, room range and budget', () => {
  const base = { location:'Lübeck', rooms:2, amount:500, type:'Kaltmiete' };
  assert.equal(parsePublicHousingPage('trave-luebeck', TRAVE_DETAIL_HTML, { ...base, location:'Kiel' }).length, 0);
  assert.equal(parsePublicHousingPage('trave-luebeck', TRAVE_DETAIL_HTML, { ...base, rooms:4 }).length, 0);
  assert.equal(parsePublicHousingPage('trave-luebeck', TRAVE_DETAIL_HTML, { ...base, amount:400 }).length, 0);
});


test('TRAVE keeps gross-cold price regardless of field order and rejects budgets below it', () => {
  const criteria = {location:'Lübeck', rooms:'2-3', amount:500, type:'Kaltmiete'};
  for (const html of [TRAVE_DETAIL_HTML, TRAVE_DETAIL_HTML.replace('<div>Nettokaltmiete: 308,88 €</div>', '').replace('<div>Bruttokaltmiete: 461,88 €</div>', '<div>Bruttokaltmiete: 461,88 €</div><div>Nettokaltmiete: 308,88 €</div>')]) {
    const [offer] = parsePublicHousingPage('trave-luebeck', html, criteria);
    assert.equal(offer.price, 461.88);
    assert.equal(offer.priceType, 'Bruttokaltmiete');
    assert.equal(parsePublicHousingPage('trave-luebeck', html, {...criteria,amount:400}).length, 0);
  }
  const [netOnly] = parsePublicHousingPage('trave-luebeck', TRAVE_DETAIL_HTML.replace('<div>Bruttokaltmiete: 461,88 €</div>', ''), criteria);
  assert.equal(netOnly.price, 308.88);
  assert.equal(netOnly.priceType, 'Nettokaltmiete');
});
