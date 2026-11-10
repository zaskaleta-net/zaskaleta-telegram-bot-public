// Ukrainian translation of news headlines, teasers and transport notices.
//
// m2m100 alone produced wrong headlines on staging (13.10.2026): it invented
// content ("Bas-Rücktritt …" became "Укрзалізниця …"), prepended page chrome
// ("Наступна стаття…") and glued sentences together. An instruction-tuned
// model translates first; m2m100 is only the fallback. Every result is
// cleaned and checked, and a result that fails the check is not published.

import { translationMemoKey } from './news-translation-memo.mjs';
import { AI_MODEL } from './ai-assistant.mjs';

// Mistral Small 3.1 (Apache-2.0), the AI module's model: the Llama 4 licence
// grants no rights to its multimodal models to EU-domiciled operators
// (TG-RUNTIME-050).
export const LLM_TRANSLATION_MODEL = AI_MODEL;
export const FALLBACK_TRANSLATION_MODEL = '@cf/meta/m2m100-1.2b';

const SYSTEM_PROMPT = [
  'You translate German or English news headlines, teasers and transport notices into Ukrainian.',
  'Output only the Ukrainian translation as one line: no quotes, no labels, no comments.',
  'Keep names, places and numbers exactly. Do not add or drop information.'
].join(' ');

// Page chrome that m2m100 prepends ("Nächster Artikel", "Weiterlesen").
const ARTIFACT_PREFIX_RE = /^(?:наступна\s+стаття|попередня\s+стаття|читайте\s+також|читати\s+далі|next\s+article|previous\s+article)\s*[:.\-–—]?\s*/iu;
// A label the model puts before its answer ("Переклад: …"); only with a
// separator, so a headline that starts with the word keeps it.
const LABEL_PREFIX_RE = /^(?:(?:ось\s+)?переклад(?:\s+українською)?|translation)\s*[:\-–—]\s*/iu;
const ARTIFACT_ANYWHERE_RE = /наступна\s+стаття|попередня\s+стаття|next\s+article/iu;
// The model sometimes answers about the task instead of translating a short name.
const META_REPLY_RE = /для\s+перекладу|надайте\s+текст|немає\s+тексту|я\s+не\s+можу|як\s+мовна\s+модель|to\s+translate|please\s+provide/iu;

function collapse(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function resultText(result) {
  if (typeof result === 'string') return result;
  return String(
    result?.response
      || result?.translated_text
      || result?.translation
      || result?.result?.translated_text
      || result?.result?.response
      || ''
  );
}

export function cleanTranslation(value, max = 1400) {
  // An LLM answer is expected on one line; anything after a line break is commentary.
  const firstLine = String(value || '').split(/\r?\n/u).map(line => line.trim()).find(Boolean) || '';
  let text = collapse(firstLine)
    .replace(/^["'«»„“”]+|["'«»„“”]+$/gu, '');
  let previous;
  do {
    previous = text;
    text = text.replace(ARTIFACT_PREFIX_RE, '').replace(LABEL_PREFIX_RE, '');
  } while (text !== previous);
  // "частину.Ремонтні" -> "частину. Ремонтні"
  text = text.replace(/([.!?…])(?=\p{Lu})/gu, '$1 ');
  // The bot names the Land in German everywhere; a translated
  // "Шлезвіг-Гольштейн(і/у/ом)" would read as a different name.
  text = text.replace(/Шлезвіг[-‑\s]*Гол(?:ь)?штейн\p{L}*/gu, 'Schleswig-Holstein');
  return collapse(text).slice(0, max);
}

function numbers(value) {
  return String(value || '').match(/\d+/gu) || [];
}

export function translationKeepsSource(source, translated) {
  const text = String(translated || '');
  const original = collapse(source);
  if (!text || !/[а-яіїєґ]/iu.test(text)) return false;
  if (text.toLowerCase() === original.toLowerCase()) return false;
  if (ARTIFACT_ANYWHERE_RE.test(text) || META_REPLY_RE.test(text)) return false;
  if (text.length > original.length * 3 + 40) return false;
  // Dates, line numbers and road numbers must survive translation unchanged.
  const translatedNumbers = new Set(numbers(text));
  return numbers(original).every(number => translatedNumbers.has(number));
}

async function runModel(env, model, source, sourceLang) {
  const input = model === LLM_TRANSLATION_MODEL
    ? {
        messages:[
          { role:'system', content:SYSTEM_PROMPT },
          { role:'user', content:`Translate into Ukrainian:\n${source}` }
        ],
        max_tokens:400,
        temperature:0
      }
    : { text:source, source_lang:sourceLang, target_lang:'uk' };
  return resultText(await env.AI.run(model, input));
}

// budget = { count, max }: every model call counts, so a fallback costs one more.
// env.NEWS_TRANSLATION_MEMO (a Map, see news-translation-memo.mjs) answers a
// text translated in an earlier build without a model call or budget.
export async function translateNewsText(env, text, { sourceLang = 'de', max = 1400, budget = null } = {}) {
  const source = collapse(text).slice(0, 1200);
  if (!source || !env?.AI || typeof env.AI.run !== 'function') return null;
  const memo = env.NEWS_TRANSLATION_MEMO instanceof Map ? env.NEWS_TRANSLATION_MEMO : null;
  const memoKey = memo ? await translationMemoKey(sourceLang, source) : null;
  if (memoKey && memo.has(memoKey)) {
    const known = memo.get(memoKey);
    memo.delete(memoKey);
    memo.set(memoKey, known);
    return known.slice(0, max);
  }
  for (const model of [LLM_TRANSLATION_MODEL, FALLBACK_TRANSLATION_MODEL]) {
    if (budget && budget.count >= budget.max) return null;
    if (budget) budget.count += 1;
    try {
      const translated = cleanTranslation(await runModel(env, model, source, sourceLang), max);
      if (translationKeepsSource(source, translated)) {
        if (memoKey) memo.set(memoKey, translated);
        return translated;
      }
    } catch {
      // Quota or model errors: try the fallback model, then give up.
    }
  }
  return null;
}
