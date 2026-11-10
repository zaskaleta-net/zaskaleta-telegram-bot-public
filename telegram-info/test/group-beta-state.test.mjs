import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceGroupHousingFlow } from '../src/group-beta-state.mjs';

function step(state, text) {
  const result = advanceGroupHousingFlow(state, text);
  return { result, state: result.clear ? null : result.state ?? state };
}

test('group housing uses canonical Lübeck for inline and prompted city aliases', () => {
  const inline = step(null, 'житло: Любику').state;
  const prompted = step(step(null, '/housing').state, 'любику').state;
  for (const state of [inline, prompted]) {
    assert.equal(state.location, 'Lübeck');
    assert.equal(state.step, 'rooms');
    assert.equal(step(state, '3').state.rooms, '3');
  }
});

test('two users can run independent housing flows in the same group and refine radius after search', () => {
  let a = null;
  let b = null;

  ({ state:a } = step(a, 'житло: Trittau'));
  ({ state:b } = step(b, 'житло: Kiel'));
  assert.equal(a.location, 'Trittau');
  assert.equal(b.location, 'Kiel');

  ({ state:a } = step(a, '3-4'));
  ({ state:b } = step(b, '2'));
  assert.equal(a.rooms, '3-4');
  assert.equal(b.rooms, '2');

  ({ state:a } = step(a, '1200'));
  ({ state:b } = step(b, '850 Warmmiete'));
  assert.equal(a.amount, 1200);
  assert.equal(a.step, 'type');
  assert.equal(b.amount, 850);
  assert.equal(b.type, 'Warmmiete');
  assert.equal(b.step, 'radius');

  ({ state:a } = step(a, 'Kaltmiete'));
  assert.equal(a.type, 'Kaltmiete');

  const aDone = step(a, '25 км');
  const bDone = step(b, '10 km');
  assert.deepEqual(aDone.result.criteria, { location:'Trittau', rooms:'3-4', amount:1200, type:'Kaltmiete', radiusKm:25 });
  assert.deepEqual(bDone.result.criteria, { location:'Kiel', rooms:'2', amount:850, type:'Warmmiete', radiusKm:10 });
  assert.equal(aDone.state.step, 'radius');
  assert.equal(bDone.state.step, 'radius');

  const aExpanded = step(aDone.state, '50 км');
  assert.deepEqual(aExpanded.result.criteria, { location:'Trittau', rooms:'3-4', amount:1200, type:'Kaltmiete', radiusKm:50 });
  assert.equal(aExpanded.state.location, 'Trittau');
});

test('city search can switch to the whole Kreis while kreisfreie city stays radius-only', () => {
  let state = step(null, 'житло: Trittau').state;
  state = step(state, '3').state;
  state = step(state, '1000 Warmmiete').state;
  const district = step(state, '🏘 По району');
  assert.deepEqual(district.result.criteria, {
    location:'Kreis Stormarn', rooms:'3', amount:1000, type:'Warmmiete', radiusKm:50,
    districtSearch:true, originLocation:'Trittau'
  });
  assert.equal(district.state.location, 'Trittau');
  assert.equal(district.state.step, 'radius');

  let kiel = step(null, 'житло: Kiel').state;
  kiel = step(kiel, '2').state;
  kiel = step(kiel, '900 Kaltmiete').state;
  const noDistrict = step(kiel, 'по району').result;
  assert.equal(noDistrict.criteria, undefined);
  assert.match(noDistrict.reply, /окремий Kreis не визначено/u);
  assert.match(noDistrict.reply, /Оберіть радіус:/u);
});

test('housing flow rejects invalid values without corrupting accumulated criteria', () => {
  let state = step(null, '🏠 Житло').state;
  assert.equal(state.step, 'city');

  let next = step(state, '123').result;
  assert.equal(next.state.step, 'city');
  assert.match(next.reply, /місто або район/);

  state = step(state, 'Lübeck').state;
  next = step(state, '0').result;
  assert.equal(next.state.location, 'Lübeck');
  assert.equal(next.state.step, 'rooms');

  state = step(state, '4').state;
  next = step(state, '50').result;
  assert.equal(next.state.rooms, '4');
  assert.equal(next.state.step, 'budget');

  state = step(state, '950').state;
  next = step(state, 'щось інше').result;
  assert.equal(next.state.amount, 950);
  assert.equal(next.state.step, 'type');
});

test('cancel clears only the active caller flow and final criteria require an approved radius', () => {
  let state = step(null, 'wohnung: Neumünster').state;
  state = step(state, '3').state;
  state = step(state, '900 Warmmiete').state;
  const invalidRadius = step(state, '100 км').result;
  assert.equal(invalidRadius.state.step, 'radius');
  assert.equal(invalidRadius.criteria, undefined);

  const cancelled = step(state, '/cancel@ZaskaletaInfoBot').result;
  assert.equal(cancelled.clear, true);
  assert.match(cancelled.reply, /скасовано/);
});
