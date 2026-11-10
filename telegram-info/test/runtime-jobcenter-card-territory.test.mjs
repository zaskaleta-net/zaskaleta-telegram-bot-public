import test from 'node:test';
import assert from 'node:assert/strict';
import { jobcenterAreaWarnings, jobcenterPhotoCards } from '../src/runtime-housing-search.mjs';

function result(criteria) {
  return {
    criteria,
    listings:[{
      title:'3-Zimmer-Wohnung',
      price:900,
      location:'21465 Reinbek',
      rooms:'3',
      areaSqm:65,
      distanceKm:12.8,
      imageUrl:'https://images.example.test/flat.jpg',
      url:'https://www.kleinanzeigen.de/s-anzeige/3-zimmer-wohnung/3508980852-203-718'
    }]
  };
}

test('active Jobcenter card omits an empty district territory label', () => {
  const criteria = {
    location:'Trittau',
    rooms:'3-4',
    amount:943.8,
    type:'Bruttokaltmiete',
    radiusKm:15
  };
  const cards = jobcenterPhotoCards(
    result(criteria),
    { criteria, location:'Trittau', persons:4, rooms:{ label:'3-4' } },
    'Jobcenter Stormarn',
    90
  );

  assert.equal(cards.length, 1);
  assert.doesNotMatch(cards[0].caption, /Територія Jobcenter\/Kreis:/u);
  assert.doesNotMatch(cards[0].caption, /Територія Jobcenter\/Kreis:\s*\./u);
  assert.match(cards[0].caption, /🏛 Jobcenter Stormarn: до 943,80 € Bruttokaltmiete/u);
});

test('active Jobcenter card keeps a real district territory label', () => {
  const criteria = {
    location:'Trittau',
    rooms:'3-4',
    amount:943.8,
    type:'Bruttokaltmiete',
    radiusKm:50,
    districtJurisdiction:'Stormarn'
  };
  const cards = jobcenterPhotoCards(
    result(criteria),
    { criteria, location:'Trittau', persons:4, rooms:{ label:'3-4' } },
    'Jobcenter Stormarn',
    undefined
  );

  assert.equal(cards.length, 1);
  assert.match(cards[0].caption, /Територія Jobcenter\/Kreis: Stormarn\./u);
  assert.match(cards[0].caption, /пошук обмежено територією Stormarn/u);
});


test('area above guideline remains informational for every Jobcenter area', () => {
  const criteria = {
    location:'Lübeck',
    rooms:'3',
    amount:680,
    type:'Bruttokaltmiete',
    radiusKm:15
  };
  const custom = result(criteria);
  custom.listings[0].areaSqm = 85;
  const cards = jobcenterPhotoCards(
    custom,
    { criteria, location:'Lübeck', persons:2, rooms:{ label:'3' } },
    'Jobcenter Lübeck',
    60
  );

  assert.equal(cards.length, 1);
  assert.match(cards[0].caption, /до 680 € Bruttokaltmiete/u);
  assert.doesNotMatch(cards[0].caption, /понад орієнтир|непридат|відхилен/u);
  assert.equal(jobcenterAreaWarnings(custom.listings, 60), '');
});

test('zero or missing area guideline is never rendered as 0 m²', () => {
  const criteria = {
    location:'Lübeck',
    rooms:'3',
    amount:680,
    type:'Bruttokaltmiete',
    radiusKm:15
  };
  const cards = jobcenterPhotoCards(
    result(criteria),
    { criteria, location:'Lübeck', persons:2, rooms:{ label:'3' } },
    'Jobcenter Lübeck',
    0
  );

  assert.equal(cards.length, 1);
  assert.doesNotMatch(cards[0].caption, /0 м²/u);
  assert.doesNotMatch(cards[0].caption, /понад орієнтир/u);
});


test('local Jobcenter result card carries verified territory for district callback context', () => {
  const criteria = {
    location:'Trittau',
    rooms:'3-4',
    amount:943.8,
    type:'Bruttokaltmiete',
    radiusKm:15
  };
  const cards = jobcenterPhotoCards(
    result(criteria),
    {
      criteria,
      location:'Trittau',
      persons:4,
      rooms:{ label:'3-4' },
      resolved:{ jurisdiction:'Stormarn' }
    },
    'Jobcenter Stormarn',
    90
  );

  assert.equal(cards.length, 1);
  assert.match(cards[0].caption, /Територія Jobcenter\/Kreis: Stormarn\./u);
  assert.doesNotMatch(cards[0].caption, /пошук обмежено територією Stormarn/u);
});
