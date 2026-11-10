import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityGateHousingListings } from '../src/housing-active-v21.mjs';

const criteria = { location:'Bad Segeberg', rooms:'3', amount:843.26, radiusKm:15, type:'Bruttokaltmiete' };

test('3-room search rejects a listing whose title explicitly says 2.5 Zimmer even when structured rooms were misparsed as 3', () => {
  const result = qualityGateHousingListings(criteria, {
    status:'partial',
    listings:[{
      id:'bad-segeberg-25',
      title:'2,5-Zimmer Wohnung in Bad Segeberg',
      rooms:3,
      price:760,
      location:'23795 Bad Segeberg',
      url:'https://www.kip.net/schleswig-holstein/bad-segeberg/mieten/Wohnung_bad-segeberg-25'
    }]
  });
  assert.equal(result.listings.length, 0);
});

test('3-room search keeps a listing whose structured and title room count both say 3', () => {
  const result = qualityGateHousingListings(criteria, {
    status:'partial',
    listings:[{
      id:'bad-segeberg-3',
      title:'3-Zimmer Wohnung in Bad Segeberg',
      rooms:3,
      price:760,
      location:'23795 Bad Segeberg',
      url:'https://www.kip.net/schleswig-holstein/bad-segeberg/mieten/Wohnung_bad-segeberg-3'
    }]
  });
  assert.equal(result.listings.length, 1);
});

test('3-4 room search still rejects an explicit 2.5-Zimmer title', () => {
  const result = qualityGateHousingListings({ ...criteria, rooms:'3-4', amount:981.64 }, {
    status:'partial',
    listings:[{
      id:'bad-segeberg-range-25',
      title:'2.5-Zimmer-Wohnung in Bad Segeberg',
      rooms:3,
      price:760,
      location:'23795 Bad Segeberg',
      url:'https://www.kip.net/schleswig-holstein/bad-segeberg/mieten/Wohnung_bad-segeberg-range-25'
    }]
  });
  assert.equal(result.listings.length, 0);
});
