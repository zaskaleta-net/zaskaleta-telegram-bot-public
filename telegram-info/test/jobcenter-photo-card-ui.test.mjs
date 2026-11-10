import test from 'node:test';
import assert from 'node:assert/strict';
import { jobcenterPhotoCards, scopedJobcenterSearchMarkup } from '../src/runtime-housing-search.mjs';

test('Jobcenter result card keeps photo listing link without rejecting on area alone', () => {
  const result = {
    criteria:{ location:'Flensburg', rooms:'3', amount:661, type:'Bruttokaltmiete', radiusKm:15 },
    listings:[{
      title:'Schöne 3-Zimmer-Wohnung',
      price:599,
      location:'24937 Flensburg',
      rooms:'3',
      areaSqm:79.5,
      distanceKm:0.5,
      imageUrl:'https://images.example.test/flat.jpg',
      url:'https://www.kleinanzeigen.de/s-anzeige/schoene-3-zimmer-wohnung/3508980852-203-718'
    }]
  };
  const context = { criteria:result.criteria };
  const cards = jobcenterPhotoCards(result, context, 'Jobcenter Flensburg', 75);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].media, 'https://images.example.test/flat.jpg');
  assert.match(cards[0].caption, /🔗 Відкрити оголошення/u);
  assert.match(cards[0].caption, /3508980852-203-718/u);
  assert.doesNotMatch(cards[0].caption, /понад орієнтир|Потрібна окрема перевірка Jobcenter/u);
  assert.match(cards[0].caption, /площа-орієнтир до 75 м² \(не критерій автоматичного відсіву\)/u);
  assert.match(cards[0].caption, /до 661 € Bruttokaltmiete/u);
  assert.doesNotMatch(cards[0].caption, /Пошук ще у/u);
});

