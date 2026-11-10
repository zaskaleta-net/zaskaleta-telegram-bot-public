import test from 'node:test';
import assert from 'node:assert/strict';
import { filterPrimaryListings } from '../src/housing-primary-search.mjs';

// TG-RUNTIME-061: phone check 19.10.2026: "22926 Ahrensburg", 887 €, 12.6 km
// from Trittau, was found by the whole-Kreis search but not by the 15 km
// search. Listings of town-scoped sources carry no measured distance and
// were kept only in the searched town itself.

const listing = (id, location, price = 887) => ({ id, sourceId:'wankendorfer', title:'3-Zimmer-Wohnung', price, rooms:'3', location, url:`https://example.org/${id}` });
const criteria = { location:'Trittau', rooms:'3-4', amount:943.8, type:'Bruttokaltmiete', radiusKm:15 };

test('#061 a town-scoped listing inside the radius is kept by its town coordinates', () => {
  const kept = filterPrimaryListings([
    listing('ahrensburg', '22926 Ahrensburg'),
    listing('reinfeld', '23858 Reinfeld (Holstein)', 750),
    listing('trittau', 'Trittau', 800),
    listing('luebeck', 'Lübeck', 700),
    listing('unknown', 'Irgendwo', 700)
  ], criteria).map(item => item.id).sort();
  assert.deepEqual(kept, ['ahrensburg', 'trittau'], 'Reinfeld (~22 km), Lübeck and an unknown town stay out');
});

test('#061 a measured distance still decides; the price limit still applies', () => {
  assert.deepEqual(filterPrimaryListings([{ ...listing('far', '22926 Ahrensburg'), distanceKm:16 }], criteria), []);
  assert.deepEqual(filterPrimaryListings([listing('dear', '22926 Ahrensburg', 990)], criteria), []);
});
