import test from 'node:test';
import assert from 'node:assert/strict';
import {
  districtSearchUnavailableText,
  localSearchSummaryPayload
} from '../src/runtime-jobcenter.mjs';
import { scopedJobcenterSearchMarkup } from '../src/runtime-housing-search.mjs';

test('district timeout produces a final user-visible response instead of hanging at searching', () => {
  const text = districtSearchUnavailableText('Stormarn');
  assert.match(text, /не завершився вчасно/u);
  assert.match(text, /не буде залишати вас лише з повідомленням «Шукаю…»/u);
});

test('runtime jobcenter text fallback keeps direct listing actions', () => {
  const markup = {
    inline_keyboard:[
      [{ text:'1. Відкрити оголошення', url:'https://www.kleinanzeigen.de/s-anzeige/test/123-203-1' }],
      [{ text:'↗ Kleinanzeigen', url:'https://www.google.com/search?q=test' }]
    ]
  };
  const scoped = scopedJobcenterSearchMarkup(markup, 'Jobcenter Stormarn', { location:'Trittau', rooms:'3-4', amount:943.8 }, { preserveListingRows:true });
  assert.equal(scoped.inline_keyboard.some(row => row.some(button => button.text === '1. Відкрити оголошення')), true);
});

test('local summary can paginate beyond five results after recovery fill', () => {
  const payload = localSearchSummaryPayload({
    location:'Rendsburg', rooms:'3-4', persons:3, radius:15,
    jurisdiction:'Rendsburg-Eckernförde', page:0, total:12, visible:5
  });
  assert.equal(payload.hasMore,true);
  assert.equal(payload.reply_markup.inline_keyboard[0][0].text,'➡️ Наступні оголошення');
});
