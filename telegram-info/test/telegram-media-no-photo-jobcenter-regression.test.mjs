import test from 'node:test';
import assert from 'node:assert/strict';
import { sendHousingMediaReply } from '../src/telegram-media.mjs';

const config = { chatId:321, token:'12345:' + 'A'.repeat(30) };
const imageUrl = 'https://img.example.test/missing.jpg';
const listingUrl = 'https://www.kleinanzeigen.de/s-anzeige/test/3506905833-203-1';
const media = [{
  media:imageUrl,
  caption:`<b>1. Testwohnung in Trittau</b>\n<a href="${listingUrl}">🔗 Відкрити оголошення</a>`,
  parse_mode:'HTML'
}];

function ok(result) {
  return new Response(JSON.stringify({ ok:true, result }), {
    status:200,
    headers:{ 'content-type':'application/json' }
  });
}

test('TG-SMOKE-001 no-photo card has one listing URL action, one Jobcenter action and no redundant open-link text', async () => {
  let sent = null;
  const transport = async (url, options = {}) => {
    if (url === imageUrl) return new Response('blocked', { status:403 });
    if (url.endsWith('/sendMessage')) {
      sent = JSON.parse(options.body);
      return ok({ message_id:41, chat:{ id:321 } });
    }
    throw new Error(`unexpected transport ${url}`);
  };

  const result = await sendHousingMediaReply({
    config,
    media,
    text:'fallback',
    replyMarkup:null,
    transport,
    separateItems:true
  });

  assert.equal(result.status, 'sent');
  assert.ok(sent);
  assert.ok(sent.reply_markup, `expected no-photo listing markup; payload=${JSON.stringify(sent)}`);
  const buttons = sent.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.filter(button => button.url === listingUrl).length, 1);
  assert.equal(
    buttons.filter(button => String(button.callback_data || '').startsWith('jc:3506905833')).length,
    1,
    'no-photo fallback must not duplicate the Jobcenter action across rows'
  );
  assert.doesNotMatch(
    sent.text,
    /🔗\s*Відкрити оголошення/u,
    'open-listing action belongs in the inline button, not repeated as body text'
  );
});
