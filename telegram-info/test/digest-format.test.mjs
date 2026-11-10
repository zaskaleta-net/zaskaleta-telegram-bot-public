import test from 'node:test';
import assert from 'node:assert/strict';
import { newsCardCaptionV2 } from '../src/news-quality-v2.mjs';
import { regionalCandidates } from '../src/news-v2.mjs';
import { cleanTranslation } from '../src/news-translation.mjs';

const NOW = Date.UTC(2026, 9, 17, 6, 0, 0);

test('a digest card carries a short topic tag, the source name and no raw URL', () => {
  const card = { kind:'regional', titleUk:'Нові правила для орендарів', descriptionUk:'Подробиці.', source:'NDR Schleswig-Holstein', link:'https://www.ndr.de/nachrichten/schleswig-holstein/a-very-long-article-path,artikel123.html' };
  const text = newsCardCaptionV2(card);
  assert.match(text, /^📰 Schleswig-Holstein\n\nНові правила для орендарів/u);
  assert.match(text, /\nДжерело: NDR Schleswig-Holstein$/u);
  assert.doesNotMatch(text, /https?:\/\/|ГОЛОВНЕ В|ВАЖЛИВО ДЛЯ/u);
  assert.match(newsCardCaptionV2({ ...card, kind:'refugee' }), /^🇺🇦 Для українців\n/u);
  assert.match(newsCardCaptionV2({ ...card, eventLike:true }), /^🎉 Дозвілля · Schleswig-Holstein\n/u);
});

test('an NDR weather forecast card is left out; a storm warning stays', () => {
  const item = (title, n) => ({ title, description:'', link:`https://www.ndr.de/${n}.html`, publishedAt:NOW - 3600000 });
  const titles = regionalCandidates([
    item('So wird das Wetter in Schleswig-Holstein', 1),
    item('Wettervorhersage: Regen am Wochenende', 2),
    item('Unwetterwarnung: Sturm an der Küste, Bahnverkehr eingeschränkt', 3)
  ], NOW).map(candidate => candidate.item?.title || candidate.title);
  assert.ok(!titles.some(title => /So wird das Wetter|Wettervorhersage/u.test(String(title))));
  assert.ok(titles.some(title => /Unwetterwarnung/u.test(String(title))));
});

test('the Land keeps its German name in every translation', () => {
  assert.equal(cleanTranslation('Уряд Шлезвіг-Гольштейну та жителі Шлезвіг-Гольштейна.'), 'Уряд Schleswig-Holstein та жителі Schleswig-Holstein.');
});
