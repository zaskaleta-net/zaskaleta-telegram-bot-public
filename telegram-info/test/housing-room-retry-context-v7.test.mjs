import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHousingRoomRetryRequest } from '../src/housing-room-retry.mjs';

function request(update) {
  return new Request('https://worker.test/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(update)
  });
}

test('room retry preserves the already known housing location', async () => {
  const original = request({
    update_id:1,
    message:{
      message_id:12,
      chat:{ id:111, type:'private' },
      from:{ id:111, is_bot:false },
      text:'3',
      reply_to_message:{
        message_id:11,
        text:'Для житла — Любік вкажіть кількість кімнат числом або діапазоном, наприклад: 3 або 3-4.'
      }
    }
  });

  const normalized = await normalizeHousingRoomRetryRequest(original);
  const body = await normalized.json();
  assert.equal(body.message.text, '3');
  assert.match(body.message.reply_to_message.text, /^Тема: житло — Любік\. Локацію вже визначено\./u);
});

test('unrelated replies are not rewritten', async () => {
  const original = request({
    update_id:2,
    message:{
      message_id:13,
      chat:{ id:111, type:'private' },
      from:{ id:111, is_bot:false },
      text:'пошук житла',
      reply_to_message:{ text:'Для житла — Любік вкажіть кількість кімнат числом або діапазоном.' }
    }
  });

  const normalized = await normalizeHousingRoomRetryRequest(original);
  const body = await normalized.json();
  assert.equal(body.message.reply_to_message.text, 'Для житла — Любік вкажіть кількість кімнат числом або діапазоном.');
});
