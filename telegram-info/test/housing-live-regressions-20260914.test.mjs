import test from 'node:test';
import assert from 'node:assert/strict';
import { replyFor } from '../src/worker.mjs';
import {
  conversationalHouseholdSize,
  normalizedHousingConversationText,
  normalizeStatewideHousingConversationRequest
} from '../src/housing-conversation-statewide-v2.mjs';
import { shouldClearLegacyReplyKeyboard } from '../src/worker-entry-pilot-v21.mjs';

const HOUSING_PROMPT = 'Тема: житло. Вкажіть місто або район.';

function housingRequest(text) {
  return new Request('https://worker.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      update_id:1,
      message:{
        message_id:2,
        date:1,
        chat:{ id:321, type:'private' },
        from:{ id:321, is_bot:false },
        text,
        reply_to_message:{
          message_id:1,
          chat:{ id:321, type:'private' },
          from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
          text:HOUSING_PROMPT
        }
      }
    })
  });
}

test('live screenshot regression: «ітцего житло для 1» preserves one-person household', async () => {
  assert.equal(conversationalHouseholdSize('ітцего житло для 1'), 1);

  const request = await normalizeStatewideHousingConversationRequest(housingRequest('ітцего житло для 1'));
  const payload = await request.json();
  assert.equal(payload.message.text, 'Itzehoe житло для 1 осіб');
  assert.equal(payload.message.reply_to_message, undefined);

  const first = replyFor({ text:payload.message.text, replyToText:'' });
  assert.match(first, /^Тема: житло — Itzehoe\./u);
  assert.match(first, /^Осіб: 1$/mu);
  assert.match(first, /кількість кімнат/u);

  const second = replyFor({ text:'2', replyToText:first });
  assert.match(second, /^Житло — Itzehoe, 2 кімнати\./u);
  assert.match(second, /^Осіб: 1$/mu);
  assert.doesNotMatch(second, /Вкажіть кількість осіб/u);
});

test('explicit standalone housing shorthand preserves household without reply metadata', () => {
  assert.equal(
    normalizedHousingConversationText('Itzehoe житло для 1'),
    'Itzehoe житло для 1 осіб'
  );
  assert.equal(
    normalizedHousingConversationText('Itzehoe для 1'),
    'Itzehoe для 1'
  );
});

test('bare household shorthand is bounded and does not reinterpret room counts', () => {
  assert.equal(conversationalHouseholdSize('Itzehoe житло для 1'), 1);
  assert.equal(conversationalHouseholdSize('Itzehoe житло для 20'), 20);
  assert.equal(conversationalHouseholdSize('Itzehoe житло для 21'), null);
  assert.equal(conversationalHouseholdSize('Itzehoe житло для 2 кімнати'), null);
  assert.equal(conversationalHouseholdSize('Itzehoe житло для 1 під Jobcenter'), 1);
});

test('legacy keyboard clear is limited to deliberate main-navigation boundaries', () => {
  assert.equal(shouldClearLegacyReplyKeyboard({ message:{ text:'/start' } }), true);
  assert.equal(shouldClearLegacyReplyKeyboard({ message:{ text:'/menu' } }), true);
  assert.equal(shouldClearLegacyReplyKeyboard({ message:{ text:'☰ Меню' } }), true);
  assert.equal(shouldClearLegacyReplyKeyboard({ message:{ text:'🏠 Житло' } }), true);
  assert.equal(shouldClearLegacyReplyKeyboard({ message:{ text:'🏛 Jobcenter' } }), true);
  assert.equal(shouldClearLegacyReplyKeyboard({ callback_query:{ data:'nav:menu' } }), true);
  assert.equal(shouldClearLegacyReplyKeyboard({ callback_query:{ data:'nav:housing' } }), true);

  assert.equal(shouldClearLegacyReplyKeyboard({ message:{ text:'2' } }), false);
  assert.equal(shouldClearLegacyReplyKeyboard({ message:{ text:'3-4' } }), false);
  assert.equal(shouldClearLegacyReplyKeyboard({ callback_query:{ data:'jcr:15:1:2:Itzehoe' } }), false);
  assert.equal(shouldClearLegacyReplyKeyboard({ callback_query:{ data:'hka:j:1:2:Itzehoe' } }), false);
});
