import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTelegramPayload } from '../src/runtime-housing-state.mjs';

const LEGACY = 'Дякуємо за звернення. База перевірених офіційних джерел ще готується. Поки що сервіс не формує автоматичну відповідь, щоб не надати неперевірену інформацію. Напишіть /topics, щоб обрати доступну тему.';

test('v13 replaces misleading generic source fallback with a clear understanding fallback', () => {
  const result = sanitizeTelegramPayload({ chat_id:123, text:LEGACY });
  assert.match(result.text, /Не вдалося однозначно зрозуміти запит/u);
  assert.match(result.text, /\/menu/u);
  assert.doesNotMatch(result.text, /База перевірених офіційних джерел ще готується/u);
});

test('v13 removes Telegram user id from admin report metadata while keeping report id and description', () => {
  const result = sanitizeTelegramPayload({
    chat_id:123,
    text:'🐞 R-20260913-123456789\nКористувач Telegram ID: 123456789\nОпис: Тестовий опис'
  });
  assert.match(result.text, /^🐞 R-20260913-123456789/mu);
  assert.match(result.text, /Опис: Тестовий опис/u);
  assert.doesNotMatch(result.text, /Telegram ID/u);
  assert.doesNotMatch(result.text, /123456789\nОпис/u);
});

test('v13 removes Telegram ID metadata label even when reporter id is unavailable', () => {
  const result = sanitizeTelegramPayload({
    chat_id:123,
    text:'🐞 R-20260913-987654321\nКористувач Telegram ID: невідомо\nОпис: Screenshot без тексту'
  });
  assert.match(result.text, /^🐞 R-20260913-987654321/mu);
  assert.match(result.text, /Опис: Screenshot без тексту/u);
  assert.doesNotMatch(result.text, /Telegram ID/u);
  assert.doesNotMatch(result.text, /невідомо/u);
});

test('v13 leaves unrelated Telegram messages unchanged', () => {
  const payload = { chat_id:123, text:'Звичайне повідомлення' };
  assert.deepEqual(sanitizeTelegramPayload(payload), payload);
});
