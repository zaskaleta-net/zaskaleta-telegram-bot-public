import test from 'node:test';
import assert from 'node:assert/strict';
import { compactJobcenterStepTwo } from '../src/jobcenter-compact-message.mjs';

const hamburg = [
  '🏛 Jobcenter team.arbeit.hamburg',
  'Оголошення: #3508564619',
  'Локація: 22159 Hamburg Farmsen-Berne',
  'Домогосподарство: 4',
  'Площа оголошення: 40,88 м²',
  'Перевірений орієнтир від 2026-04-28: до 1036,80 € — Bruttokaltmiete inklusive Betriebskosten und Wasserkosten, ohne Heizkosten.',
  '📍 Регіон: Hamburg (Гамбург) — окрема федеральна земля (Freie und Hansestadt Hamburg). Це НЕ Schleswig-Holstein.',
  'Офіційна гамбурзька таблиця Angemessenheitsgrenzen від 28.04.2026 публікує грошові межі Bruttokaltmiete, а не загальну окрему межу площі для звичайного вільного житла.',
  '',
  'Крок 2/2: надішліть три суми, наприклад:',
  'Kaltmiete 700, Betriebskosten 150, Heizkosten 100'
].join('\n');

test('Hamburg Jobcenter verification becomes one compact card with room mismatch', () => {
  const text = compactJobcenterStepTwo(hamburg, {
    status:'mismatch',
    text:'⚠️ За пошуковою рекомендацією для 4 осіб: 3–4 кімнати; в оголошенні 1. Це рекомендація пошуку, не норматив Jobcenter.'
  });
  assert.match(text, /^🔎 Перевірка оголошення/mu);
  assert.match(text, /3–4 кімнати/u);
  assert.match(text, /🏛 Jobcenter team\.arbeit\.hamburg/u);
  assert.match(text, /Hamburg — окрема федеральна земля, НЕ Schleswig-Holstein/u);
  assert.match(text, /👥 4 осіб · 🏠 40,88 м²/u);
  assert.match(text, /💶 Ліміт \(від 2026-04-28\): до 1036,80 € · Bruttokaltmiete/u);
  assert.match(text, /Крок 2\/2:/u);
  assert.doesNotMatch(text, /Офіційна гамбурзька таблиця/u);
  assert.doesNotMatch(text, /Регіон: Hamburg \(Гамбург\)/u);
});

test('non-step-two messages are unchanged', () => {
  const text = '🏛 Перевірка під Jobcenter\nКрок 1/2: вкажіть кількість осіб.';
  assert.equal(compactJobcenterStepTwo(text, null), text);
});
