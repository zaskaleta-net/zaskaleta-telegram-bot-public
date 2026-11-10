import test from 'node:test';
import assert from 'node:assert/strict';
import { matchStatewideHousingPlace } from '../src/housing-statewide-input.mjs';
import {
  normalizedHousingConversationText,
  normalizeStatewideHousingConversationRequest
} from '../src/housing-conversation-statewide-v2.mjs';
import { matchCuratedSchleswigHolsteinMunicipality } from '../src/municipality-directory.mjs';

function privateRequest(text, replyText = null) {
  const message = {
    message_id:2,
    chat:{ id:123, type:'private' },
    from:{ id:123, is_bot:false },
    text
  };
  if (replyText) message.reply_to_message = { message_id:1, chat:{ id:123, type:'private' }, text:replyText };
  return new Request('https://worker.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ update_id:1, message })
  });
}

async function requestText(request) {
  return (await request.json()).message.text;
}

test('video 57232 spelling Вальштет resolves to official Wahlstedt', () => {
  const place = matchStatewideHousingPlace("Вальштет сім'я 3 людини");
  assert.equal(place?.canonical, 'Wahlstedt');
  assert.equal(place?.jurisdiction, 'Segeberg');
  assert.equal(normalizedHousingConversationText("Вальштет сім'я 3 людини"), 'Wahlstedt житло для 3 осіб');
});

test('video 57233 spelling Зульфельд resolves to official Sülfeld without swallowing the full sentence', () => {
  const text = "Зульфельд житло для сім'ї двоє дітей та двоє дорослих";
  const place = matchStatewideHousingPlace(text);
  assert.equal(place?.canonical, 'Sülfeld');
  assert.equal(place?.jurisdiction, 'Segeberg');
  assert.equal(normalizedHousingConversationText(text), 'Sülfeld житло для 4 осіб');
});

test('common Cyrillic Arnis spelling remains canonical and routed to Schleswig-Flensburg', () => {
  const place = matchCuratedSchleswigHolsteinMunicipality('Арнис житло для 3 осіб');
  assert.equal(place?.canonical, 'Arnis');
  assert.equal(place?.jurisdiction, 'Schleswig-Flensburg');
});

test('uncurated official Gemeinde resolves in a natural housing request without Telegram ForceReply context', async () => {
  const transport = async url => {
    const parsed = new URL(String(url));
    assert.equal(parsed.hostname, 'www.gemeindeverzeichnis.de');
    assert.equal(parsed.searchParams.get('bundesland'), '01');
    assert.equal(parsed.searchParams.get('q'), 'Witzwort');
    return new Response(JSON.stringify({ data:[{
      ags:'01054161',
      ars:'010545484161',
      normalized_display_name:'Witzwort',
      bundesland_slug:'schleswig-holstein',
      kreis_slug:'kreis-nordfriesland',
      slug:'witzwort'
    }] }), { status:200, headers:{ 'content-type':'application/json' } });
  };

  const normalized = await normalizeStatewideHousingConversationRequest(
    privateRequest("Witzwort сім'я 3 людини"),
    transport
  );
  assert.equal(await requestText(normalized), 'Witzwort житло для 3 осіб');
});

test('bare official Gemeinde still resolves when the user explicitly replies to the housing location prompt', async () => {
  const transport = async url => {
    const parsed = new URL(String(url));
    assert.equal(parsed.searchParams.get('q'), 'Witzwort');
    return new Response(JSON.stringify({ data:[{
      ags:'01054161',
      normalized_display_name:'Witzwort'
    }] }), { status:200, headers:{ 'content-type':'application/json' } });
  };

  const normalized = await normalizeStatewideHousingConversationRequest(
    privateRequest('Witzwort', 'Тема: житло. Вкажіть місто або район.'),
    transport
  );
  const body = await normalized.json();
  assert.equal(body.message.text, 'Witzwort житло');
  assert.equal(body.message.reply_to_message, undefined);
});
