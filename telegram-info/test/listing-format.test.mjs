import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEuro, formatArea, formatDistance, priceTypeLabel } from '../src/listing-format.mjs';
import { housingListingMedia } from '../src/housing-provider.mjs';

test('listing numbers use a decimal comma, no thousands dot and no trailing ",0"', () => {
  assert.equal(formatEuro(471.98), '471,98');
  assert.equal(formatEuro(401.9), '401,90');
  assert.equal(formatEuro(430), '430');
  assert.equal(formatEuro(1029), '1029');
  assert.equal(formatArea(54.01), '54,01');
  assert.equal(formatArea(48.5), '48,5');
  assert.equal(formatArea(50), '50');
  assert.equal(formatDistance(1.04), '1');
  assert.equal(formatDistance(7.14), '7,1');
  assert.equal(formatDistance(12.6), '13');
});

test('a Kaltmiete is shown as the rent before Nebenkosten', () => {
  assert.equal(priceTypeLabel('Kaltmiete'), 'Kaltmiete + Nebenkosten');
  assert.equal(priceTypeLabel('Nettokaltmiete'), 'Nettokaltmiete + Nebenkosten');
  assert.equal(priceTypeLabel('Warmmiete'), 'Warmmiete');
  assert.equal(priceTypeLabel('Gesamtmiete'), 'Gesamtmiete');
});

test('a Vonovia card reads "471,98 € Kaltmiete + Nebenkosten · 54,01 м² · ≈1 км"', () => {
  const [card] = housingListingMedia({ listings:[{
    title:'Modernisierte 2 Zimmer Wohnung', price:471.98, priceType:'Kaltmiete', rooms:'2', areaSqm:54.01, distanceKm:1.04,
    location:'Sandkrug 12, 24143 Kiel (Gaarden-Ost)', source:'Vonovia', sourceId:'vonovia',
    url:'https://www.vonovia.de/zuhause-finden/immobilien/modernisierte-2-zimmer-wohnung-81-0852000001'
  }] });
  assert.match(card.caption, /💶 <b>471,98 €<\/b> Kaltmiete \+ Nebenkosten · Sandkrug 12/u);
  assert.match(card.caption, /📐 54,01 м² · 📍 ≈1 км/u);
  assert.doesNotMatch(card.caption, /\d\.\d/u);
});

test('a card with both rents shows the Warmmiete and the Kaltmiete next to it', () => {
  const [card] = housingListingMedia({ listings:[{
    title:'2-Zimmer Wohnung', price:797.5, priceType:'Warmmiete', coldPrice:500, rooms:'2', areaSqm:48, location:'24159 Kiel', source:'BIG-Verwaltung', sourceId:'big-verwaltung',
    url:'https://big-verwaltung.de/immobilien/wohnung-x/'
  }] });
  assert.match(card.caption, /💶 <b>797,50 €<\/b> Warmmiete \(Kaltmiete 500 €\) · 24159 Kiel/u);
});
