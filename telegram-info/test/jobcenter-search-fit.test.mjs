import test from 'node:test';
import assert from 'node:assert/strict';
import { jobcenterSearchCostFit, jobcenterSearchRoomFit } from '../src/jobcenter-search-fit.mjs';

test('flags one-room listing against four-person search recommendation', () => {
  const result = jobcenterSearchRoomFit({ listingRooms:'1', persons:4 });
  assert.equal(result.status, 'mismatch');
  assert.match(result.text, /3–4 кімнати/u);
  assert.match(result.text, /в оголошенні 1/u);
  assert.match(result.text, /не норматив Jobcenter/u);
});

test('explicit search range takes precedence over generic recommendation', () => {
  const result = jobcenterSearchRoomFit({ listingRooms:'2', targetRooms:'3-4', persons:4 });
  assert.equal(result.status, 'mismatch');
  assert.match(result.text, /параметрам поточного пошуку/u);
  assert.match(result.text, /3-4|3–4/u);
});

test('matching room count stays silent', () => {
  const result = jobcenterSearchRoomFit({ listingRooms:'3', targetRooms:'3-4', persons:4 });
  assert.deepEqual(result, { status:'match', text:null });
});

test('Kaltmiete below BKM limit stays visible but requires Betriebskosten verification', () => {
  const result = jobcenterSearchCostFit({ price:480, priceType:'Kaltmiete', bruttokaltLimit:495 });
  assert.equal(result.status, 'verify');
  assert.equal(result.badge, '⚠️');
  assert.match(result.text, /Betriebskosten/u);
});

test('Kaltmiete above BKM limit is clearly over the search orientation', () => {
  const result = jobcenterSearchCostFit({ price:520, priceType:'Kaltmiete', bruttokaltLimit:495 });
  assert.equal(result.status, 'over');
  assert.equal(result.badge, '❌');
});

test('Warmmiete above BKM limit is not rejected because heating may explain the difference', () => {
  const result = jobcenterSearchCostFit({ price:520, priceType:'Warmmiete', bruttokaltLimit:495 });
  assert.equal(result.status, 'verify');
  assert.match(result.text, /Heizkosten/u);
});

test('explicit Bruttokaltmiete within the limit is a likely fit, not a Zusicherung', () => {
  const result = jobcenterSearchCostFit({ price:490, priceType:'Bruttokaltmiete', bruttokaltLimit:495 });
  assert.equal(result.status, 'likely');
  assert.equal(result.badge, '✅');
  assert.match(result.text, /Zusicherung/u);
});

test('unknown price type remains a verification candidate instead of being discarded', () => {
  const result = jobcenterSearchCostFit({ price:650, priceType:'Preis im Inserat', bruttokaltLimit:495 });
  assert.equal(result.status, 'verify');
  assert.equal(result.badge, '⚠️');
});
