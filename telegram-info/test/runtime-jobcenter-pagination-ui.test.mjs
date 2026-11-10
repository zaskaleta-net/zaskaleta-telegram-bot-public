import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localSearchSummaryPayload,
  radiusPageContextFromText,
  districtSearchProgressText
} from '../src/runtime-jobcenter.mjs';

test('local Jobcenter search shows an explicit final notice when exactly five listings are all that exist', () => {
  const payload = localSearchSummaryPayload({
    location:'Rendsburg',
    rooms:'3-4',
    persons:3,
    radius:15,
    jurisdiction:'Rendsburg-Eckernförde',
    page:0,
    total:5,
    visible:5
  });
  assert.equal(payload.hasMore, false);
  assert.match(payload.text, /Показано 1–5 із 5/u);
  assert.match(payload.text, /Оголошень більше немає/u);
  assert.equal(payload.reply_markup, undefined);
});

test('local Jobcenter search exposes deterministic next-page control when more than five listings exist', () => {
  const first = localSearchSummaryPayload({
    location:'Rendsburg',
    rooms:'3-4',
    persons:3,
    radius:15,
    jurisdiction:'Rendsburg-Eckernförde',
    page:0,
    total:12,
    visible:5
  });
  assert.equal(first.hasMore, true);
  assert.equal(first.reply_markup.inline_keyboard[0][0].text, '➡️ Наступні оголошення');
  assert.equal(first.reply_markup.inline_keyboard[0][0].callback_data, 'jrp:1');

  const second = localSearchSummaryPayload({
    location:'Rendsburg',
    rooms:'3-4',
    persons:3,
    radius:15,
    jurisdiction:'Rendsburg-Eckernförde',
    page:1,
    total:12,
    visible:5
  });
  assert.match(second.text, /Показано 6–10 із 12/u);
  assert.equal(second.reply_markup.inline_keyboard[0][0].callback_data, 'jrp:2');
});

test('radius pagination reconstructs search context from the controlled summary message', () => {
  const text = [
    '🔎 Автопошук житла під Jobcenter — Rendsburg',
    'Осіб: 3',
    'Кімнати: 3-4',
    'Jobcenter/Kreis: Rendsburg-Eckernförde.',
    '📍 Радіус пошуку: 15 км',
    '✅ Показано 1–5 із 12 знайдених оголошень.'
  ].join('\n');
  assert.deepEqual(radiusPageContextFromText(text, 1), {
    location:'Rendsburg',
    persons:3,
    rooms:'3-4',
    radius:15,
    page:1
  });
});

test('whole-district search gives immediate visible progress feedback', () => {
  assert.equal(
    districtSearchProgressText('Rendsburg-Eckernförde'),
    '🔎 Шукаю оголошення по всьому Jobcenter/Kreis Rendsburg-Eckernförde…'
  );
});
