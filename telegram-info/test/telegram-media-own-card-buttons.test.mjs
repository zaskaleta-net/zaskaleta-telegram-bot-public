import test from 'node:test';
import assert from 'node:assert/strict';
import { sendHousingMediaReply } from '../src/telegram-media.mjs';

const config = { chatId:321, token:'12345:' + 'A'.repeat(30) };
const jpeg = new Uint8Array([0xff,0xd8,0xff,0xd9]);
const urlA = 'https://www.kleinanzeigen.de/s-anzeige/a/3506905833-203-1';
const urlB = 'https://www.kleinanzeigen.de/s-anzeige/b/3506905999-203-1';
const media = [
  { media:'https://img.example.test/a.jpg', caption:`<b>1. A</b>\n<a href="${urlA}">🔗 Відкрити оголошення</a>`, parse_mode:'HTML' },
  { media:'https://img.example.test/b.jpg', caption:`<b>2. B</b>\n<a href="${urlB}">🔗 Відкрити оголошення</a>`, parse_mode:'HTML' }
];
// Shape produced by housingListingsMarkup + paginationMarkup: one row per page listing,
// then non-listing navigation that must stay on the last card.
const replyMarkup = { inline_keyboard:[
  [{ text:'1. Відкрити оголошення', url:urlA }],
  [{ text:'2. Відкрити оголошення', url:urlB }],
  [{ text:'Immowelt', url:'https://www.google.com/search?q=site%3Aimmowelt.de' }],
  [{ text:'➡️ Ще оголошення', callback_data:'page:d:5:u702' }]
] };

const ok = result => new Response(JSON.stringify({ ok:true, result }), { status:200, headers:{ 'content-type':'application/json' } });

function cardButtons(cards, index) {
  return cards[index].inline_keyboard.flat();
}

function assertOnlyOwnListing(buttons, ownUrl, ownId, foreignUrl, foreignId) {
  assert.equal(buttons.filter(button => button.url === ownUrl).length, 1, 'own listing link must appear exactly once');
  assert.equal(buttons.filter(button => button.url === foreignUrl).length, 0, 'a card must not link to another listing');
  assert.equal(buttons.filter(button => String(button.callback_data || '').startsWith(`jc:${ownId}`)).length, 1);
  assert.equal(buttons.filter(button => String(button.callback_data || '').startsWith(`jc:${foreignId}`)).length, 0,
    'a card must not carry the Jobcenter action of another listing');
}

for (const photos of [true, false]) {
  test(`TG-MEDIA-001 ${photos ? 'photo' : 'no-photo'} cards keep only their own listing actions and the last card keeps navigation`, async () => {
    const cards = [];
    const transport = async (url, options = {}) => {
      if (url.startsWith('https://img.example.test/')) {
        return photos ? new Response(jpeg, { status:200, headers:{ 'content-type':'image/jpeg' } }) : new Response('blocked', { status:403 });
      }
      const markup = url.endsWith('/sendPhoto')
        ? JSON.parse(options.body.get('reply_markup'))
        : JSON.parse(options.body).reply_markup;
      cards.push(markup);
      return ok({ message_id:100 + cards.length, chat:{ id:321 } });
    };

    const result = await sendHousingMediaReply({ config, media, text:'fallback', replyMarkup, transport, ownerUserId:702, separateItems:true });

    assert.equal(result.status, 'sent');
    assert.equal(result.mediaCount, 2);
    assert.equal(cards.length, 2);
    assertOnlyOwnListing(cardButtons(cards, 0), urlA, '3506905833', urlB, '3506905999');
    assertOnlyOwnListing(cardButtons(cards, 1), urlB, '3506905999', urlA, '3506905833');

    const last = cardButtons(cards, 1);
    assert.ok(last.some(button => button.text === 'Immowelt'), 'external source navigation stays on the last card');
    assert.ok(last.some(button => button.callback_data === 'page:d:5:u702'), 'pagination stays on the last card');
    const first = cardButtons(cards, 0);
    assert.ok(!first.some(button => button.callback_data === 'page:d:5:u702'), 'navigation is emitted once, on the last card');
  });
}
