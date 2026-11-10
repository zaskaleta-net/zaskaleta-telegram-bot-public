import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LLM_TRANSLATION_MODEL,
  FALLBACK_TRANSLATION_MODEL,
  cleanTranslation,
  translationKeepsSource,
  translateNewsText
} from '../src/news-translation.mjs';

function aiEnv(answers) {
  const calls = [];
  return {
    calls,
    AI:{
      async run(model, input) {
        calls.push({ model, input });
        const answer = answers[model];
        if (answer instanceof Error) throw answer;
        return model === LLM_TRANSLATION_MODEL ? { response:answer } : { translated_text:answer };
      }
    }
  };
}

// Staging, 13.10.2026: m2m100 output for two NDR headlines.
test('page chrome prepended by m2m100 is removed and glued sentences are split', () => {
  assert.equal(
    cleanTranslation('Наступна статтяНедоступна запасна частина: Missunde III продовжує випадати'),
    'Недоступна запасна частина: Missunde III продовжує випадати'
  );
  assert.equal(
    cleanTranslation('Неможливо доставити запасну частину.Ремонтні роботи повинні бути продовжені після отримання.'),
    'Неможливо доставити запасну частину. Ремонтні роботи повинні бути продовжені після отримання.'
  );
  assert.equal(cleanTranslation('«Відставка Баса спровокувала дебати»\nПримітка: переклад'), 'Відставка Баса спровокувала дебати');
});

test('a translation that drops a number, is not Ukrainian or keeps page chrome is rejected', () => {
  assert.ok(translationKeepsSource('Neuer Fahrplan ab 13. Dezember 2027', 'Новий розклад з 13 грудня 2027'));
  assert.ok(!translationKeepsSource('Neuer Fahrplan ab 13. Dezember 2027', 'Новий розклад з грудня'));
  assert.ok(!translationKeepsSource('B76 zwischen Plön und Eutin gesperrt', 'Дорога між Плен і Ойтін закрита'));
  assert.ok(!translationKeepsSource('Missunde III fällt aus', 'Missunde III fällt aus'));
  assert.ok(!translationKeepsSource('Missunde III fällt aus', 'Наступна стаття про Missunde III'));
  // Staging probe, 13.10.2026: the model answered about the task for a short app name.
  assert.ok(!translationKeepsSource('Germany4Ukraine-App', 'Наразі немає тексту для перекладу. Будь ласка, надайте текст.'));
});

test('the instruction model translates first; m2m100 is not called when it succeeds', async () => {
  const env = aiEnv({
    [LLM_TRANSLATION_MODEL]:'Відставка Баса спровокувала дебати щодо тону спілкування в коаліції',
    [FALLBACK_TRANSLATION_MODEL]:'Наступна статтяУкрзалізниця: у коаліції по-різному'
  });
  const translated = await translateNewsText(env, 'Bas-Rücktritt löst Debatte über Umgangston in Koalition aus');
  assert.equal(translated, 'Відставка Баса спровокувала дебати щодо тону спілкування в коаліції');
  assert.deepEqual(env.calls.map(call => call.model), [LLM_TRANSLATION_MODEL]);
  assert.match(env.calls[0].input.messages.at(-1).content, /\nBas-Rücktritt löst Debatte über Umgangston in Koalition aus$/u);
});

test('m2m100 is the fallback when the instruction model fails or loses a number', async () => {
  const failing = aiEnv({
    [LLM_TRANSLATION_MODEL]:new Error('4006: daily free allocation exceeded'),
    [FALLBACK_TRANSLATION_MODEL]:'Наступна статтяНедоступна запасна частина: Missunde III продовжує випадати'
  });
  assert.equal(
    await translateNewsText(failing, 'Fehlendes Ersatzteil nicht geliefert: Missunde III fällt weiter aus'),
    'Недоступна запасна частина: Missunde III продовжує випадати'
  );

  const lossy = aiEnv({
    [LLM_TRANSLATION_MODEL]:'Новий розклад руху поїздів',
    [FALLBACK_TRANSLATION_MODEL]:'Новий розклад руху з 13 грудня'
  });
  assert.equal(await translateNewsText(lossy, 'Neuer Fahrplan ab 13. Dezember'), 'Новий розклад руху з 13 грудня');
  assert.deepEqual(lossy.calls.map(call => call.model), [LLM_TRANSLATION_MODEL, FALLBACK_TRANSLATION_MODEL]);
});

test('no translation is published when both models fail, and every call counts against the budget', async () => {
  const env = aiEnv({
    [LLM_TRANSLATION_MODEL]:'Новий розклад руху поїздів',
    [FALLBACK_TRANSLATION_MODEL]:'Neuer Fahrplan ab 13. Dezember'
  });
  const budget = { count:0, max:3 };
  assert.equal(await translateNewsText(env, 'Neuer Fahrplan ab 13. Dezember', { budget }), null);
  assert.equal(budget.count, 2);
  assert.equal(await translateNewsText(env, 'Neuer Fahrplan ab 13. Dezember', { budget }), null);
  assert.equal(budget.count, 3, 'the budget stops the second fallback call');
  assert.equal(env.calls.length, 3);
});
