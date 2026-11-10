import test from 'node:test';
import assert from 'node:assert/strict';
import { filterNewsCardsV2 } from '../src/news-quality-v2.mjs';

const now = Date.UTC(2026, 8, 13, 12, 0, 0);

function event(fallbackDate, link) {
  return {
    kind:'event',
    title:'Test event',
    titleUk:'Тестова подія',
    image:'https://example.test/event.jpg',
    link,
    source:'example.test',
    city:'Кіль',
    eventMeta:{ startAt:null, fallbackDate, fallbackTime:'18:00' }
  };
}

test('quality gate rejects an event whose fallback date is already in the past', () => {
  const cards = filterNewsCardsV2([event('10.09.2026', 'https://example.test/past')], now);
  assert.equal(cards.length, 0);
});

test('quality gate keeps a future event when only fallback date is available', () => {
  const cards = filterNewsCardsV2([event('20.09.2026', 'https://example.test/future')], now);
  assert.equal(cards.length, 1);
});

test('quality gate rejects invalid fallback calendar dates', () => {
  const cards = filterNewsCardsV2([event('31.02.2026', 'https://example.test/invalid')], now);
  assert.equal(cards.length, 0);
});
