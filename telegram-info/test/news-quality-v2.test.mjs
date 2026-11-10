import test from 'node:test';
import assert from 'node:assert/strict';
import { filterNewsCardsV2 } from '../src/news-quality-v2.mjs';

const NOW = Date.UTC(2026, 8, 13, 11, 20, 0);
const recent = NOW - 2 * 24 * 60 * 60 * 1000;

function refugee(overrides = {}) {
  return {
    kind:'refugee',
    title:'Neue Regeln für ukrainische Geflüchtete',
    description:'Die Regelung wurde aktualisiert.',
    titleUk:'Нові правила для українців',
    descriptionUk:'Правила оновлено.',
    image:'https://img.example.test/news.jpg',
    link:'https://www.ndr.de/nachrichten/schleswig-holstein/news.html',
    source:'NDR Schleswig-Holstein',
    publishedAt:recent,
    ...overrides
  };
}

test('quality gate blocks promotional app and evergreen Germany4Ukraine pages', () => {
  const cards = [
    refugee({
      title:'Germany4Ukraine auch als App',
      description:'Jetzt im iOS AppStore und Android PlayStore herunterladen.',
      link:'https://www.germany4ukraine.de/DE/online-services/germany4ukraine-app/seite_node.html',
      source:'Germany4Ukraine',
      publishedAt:null
    }),
    refugee({
      title:'Unterkunft für Ukrainerinnen und Ukrainer',
      description:'Allgemeine Informationen zu Unterkünften.',
      link:'https://www.germany4ukraine.de/DE/unterkunft-fuer-ukrainer/seite_node.html',
      source:'Germany4Ukraine',
      publishedAt:null
    })
  ];
  assert.deepEqual(filterNewsCardsV2(cards, NOW), []);
});

test('quality gate keeps recent trusted news and rejects stale news', () => {
  const current = refugee();
  const stale = refugee({
    link:'https://www.ndr.de/nachrichten/schleswig-holstein/old.html',
    publishedAt:NOW - 30 * 24 * 60 * 60 * 1000
  });
  assert.deepEqual(filterNewsCardsV2([current, stale], NOW), [current]);
});

test('official non-feed refugee pages require both freshness and a real news signal', () => {
  const change = refugee({
    title:'Neue Regelung für ukrainische Geflüchtete ab 1. Oktober',
    description:'Die Regelung wurde geändert.',
    link:'https://www.germany4ukraine.de/DE/aktuelles/neue-regelung.html',
    source:'Germany4Ukraine',
    publishedAt:recent
  });
  const generic = refugee({
    title:'Informationen zum Wohnen für Ukrainer',
    description:'Hier finden Sie allgemeine Informationen.',
    link:'https://www.germany4ukraine.de/DE/wohnen/info.html',
    source:'Germany4Ukraine',
    publishedAt:recent
  });
  assert.deepEqual(filterNewsCardsV2([change, generic], NOW), [change]);
});

test('event cards are not affected by refugee-news promotion filter', () => {
  const event = {
    kind:'event',
    city:'Гамбург',
    titleUk:'Фестиваль у Гамбурзі',
    image:'https://img.example.test/event.jpg',
    link:'https://www.hamburg.de/kultur/veranstaltungen/festival',
    source:'hamburg.de',
    eventMeta:{ startAt:NOW + 2 * 24 * 60 * 60 * 1000 }
  };
  assert.deepEqual(filterNewsCardsV2([event], NOW), [event]);
});

test('regional NDR cards must be fresh, illustrated and from ndr.de', () => {
  const now = Date.UTC(2026, 9, 13, 7, 0, 0);
  const base = { kind:'regional', source:'NDR Schleswig-Holstein', image:'https://img.test/a.jpg', title:'Katastrophenschutz', titleUk:'Цивільний захист', publishedAt:now - 3 * 3600 * 1000 };
  const kept = filterNewsCardsV2([
    { ...base, link:'https://www.ndr.de/nachrichten/schleswig-holstein/a.html' },
    { ...base, link:'https://example.com/a.html' },
    { ...base, link:'https://www.ndr.de/nachrichten/schleswig-holstein/b.html', publishedAt:now - 3 * 86400 * 1000 },
    { ...base, link:'https://www.ndr.de/nachrichten/schleswig-holstein/c.html', publishedAt:now - 3 * 86400 * 1000, eventLike:true },
    { ...base, link:'https://www.ndr.de/nachrichten/schleswig-holstein/d.html', image:null }
  ], now).map(card => card.link.split('/').at(-1));
  assert.deepEqual(kept, ['a.html', 'c.html']);
});
