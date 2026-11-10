// AI module (TG-RUNTIME-047): the model calls and the fixed texts around
// them. Telegram handling lives in ai-commands.mjs, limits and cache in
// ai-state.mjs.
//
// Provider order: Cloudflare Workers AI first (already the bot's processor,
// no key, the data stays at Cloudflare). External OpenAI-compatible providers
// are an optional text-only fallback: off unless AI_EXTERNAL_ENABLED is
// 'true', one key per provider from a Worker secret, never in code. A 429
// moves on to the next provider; nothing rotates keys or accounts. Photos of
// letters never leave Workers AI.
//
// Model: Mistral Small 3.1 (Apache-2.0, vision). Llama 4 is not used here:
// its licence grants no rights to its multimodal models to individuals or
// companies domiciled in the EU.
export const AI_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
// Inside the 30 s a Worker stays alive after the webhook response, with the
// image download and the Telegram calls.
const AI_TIMEOUT_MS = 15000;
const EXTERNAL_TIMEOUT_MS = 8000;
const MAX_ANSWER_CHARS = 3500;
const MAX_INPUT_CHARS = 4000;
// Output token caps: a short answer stretches the free daily quota; the
// explanation of a letter needs more room.
const ANSWER_TOKENS = 500;
const SCAN_TOKENS = 900;

// The optional fallback (TG-RUNTIME-054): the bot has no budget, so only a
// free provider is used, with one key from a Worker secret.
// - Groq (USA). Free plan; its Data Processing Addendum is part of the Groq
//   Services Agreement and incorporates the EU Standard Contractual Clauses
//   (console.groq.com/docs/legal/customer-data-processing-addendum).
//   Its rate limits apply per organization, so a second key adds nothing.
// Not used: Mistral (no API on its free plan), Gemini (only the paid API may
// serve users in the EEA), GitHub Models (retired on 30.07.2026).
const EXTERNAL_PROVIDERS = Object.freeze([
  Object.freeze({ id:'groq', key:'GROQ_API_KEY', url:'https://api.groq.com/openai/v1/chat/completions', model:'llama-3.1-8b-instant', modelVar:'AI_GROQ_MODEL' })
]);

export const SYSTEM_INSTRUCTION = [
  'Ти — довідковий помічник Telegram-бота «Schleswig-Holstein Помічник» для українців у землі Schleswig-Holstein (Німеччина).',
  'Бот незалежний, не є державним органом і не представляє Jobcenter, Ausländerbehörde чи Familienkasse.',
  'Відповідай українською, сухо, коротко і конкретно, без емоцій і без обіцянок результату. Німецькі терміни, назви установ, законів і документів залишай мовою оригіналу (Jobcenter, Bürgergeld, Bescheid, Kaltmiete тощо).',
  'Ти не надаєш індивідуальної правової допомоги і не оцінюєш конкретну справу: не кажи, чи законний Bescheid, чи треба подавати Widerspruch, чи буде схвалено заяву. Для таких питань направляй на безкоштовні консультації: /beratung (Migrationsberatung für Erwachsene — MBE, Jugendmigrationsdienst — JMD).',
  'Не вигадуй суми, строки, параграфи законів, адреси, телефони чи посилання. Якщо факт не можна підтвердити, пиши: «Не можу це підтвердити».',
  'Ніколи не проси і не повторюй персональні дані: Kundennummer або BG-Nummer, паролі, PIN, номери паспорта чи Aufenthaltstitel, IBAN, дату народження, повні копії документів. Якщо користувач їх надіслав, не відтворюй їх у відповіді.',
  'Кожну суму чи строк, узяті з листа користувача, супроводжуй приміткою «перевірте в оригіналі листа».',
  'Відповідай простим текстом без HTML і Markdown-таблиць, коротко: до 1000 символів, розбір листа — до 1800 символів.'
].join('\n');

const SCAN_INSTRUCTION = [
  'Користувач надіслав офіційний лист (фото або текст): Bescheid, Antrag, Anhörung, Aufforderung чи інший лист від установи.',
  'Зроби так:',
  '1. Від кого лист і що це за документ (одним рядком, назву установи — в оригіналі).',
  '2. Суть простими словами українською (3–5 пунктів).',
  '3. Складні терміни: німецький термін — коротке пояснення українською.',
  '4. Строки (Frist) і дати, до яких щось треба зробити, кожен окремим рядком, з приміткою «перевірте в оригіналі листа». Якщо строку не видно, напиши: «Строк у тексті не знайдено».',
  '5. Які документи або дії вимагаються, якщо це прямо написано в листі.',
  'Не переписуй персональні дані (ім’я, адресу, номери, IBAN, дату народження). Не оцінюй, чи рішення правильне. Якщо текст не читається або це не лист установи, так і скажи.'
].join('\n');

const LETTER_INSTRUCTION = [
  'Du schreibst auf Deutsch eine kurze, höfliche Erstanfrage an einen Vermieter zu der unten beschriebenen Wohnung, im Namen einer wohnungssuchenden Person aus der Ukraine.',
  'Regeln:',
  '- Höchstens 170 Wörter, Anrede „Sehr geehrte Damen und Herren,“, Schluss „Mit freundlichen Grüßen“ und darunter [Vor- und Nachname], [Telefonnummer].',
  '- Steht unten „Personen im Haushalt: N“, nenne diese Zahl; sonst schreibe [Anzahl der Personen]. Weitere persönliche Angaben nur als Platzhalter in eckigen Klammern: [Einzugstermin], [Name], [Telefonnummer]. Erfinde keine Daten.',
  '- Erwähne, dass die Miete über das Jobcenter [Ort/Kreis] übernommen werden soll und das Jobcenter vor Vertragsschluss die Angemessenheit prüft.',
  '- Bitte um ein schriftliches Mietangebot mit Kaltmiete, Betriebskosten, Heizkosten, Kaution und Wohnfläche sowie um einen Besichtigungstermin.',
  '- Behaupte NICHT, dass die Wohnung den Richtwerten des Jobcenters entspricht oder genehmigt ist.',
  '- Nur den Brieftext ausgeben, ohne Betreffzeile-Erklärungen, ohne Kommentare.'
].join('\n');

export const AI_ANSWER_HEADER = '🤖 Відповідь ШІ — довідка, не юридична консультація';
export const AI_ANSWER_FOOTER = 'ℹ️ Складні або особисті питання — безкоштовні консультації: /beratung';
export const SCAN_HEADER = '🔎 Розбір листа (ШІ)';
export const SCAN_FOOTER = [
  '⚠️ Перевірте точні дані в оригіналі вашого листа.',
  'Це не юридична консультація. Щодо Widerspruch, строків і рішень — безкоштовні консультації: /beratung',
  'Фото й текст листа бот не зберігає.'
].join('\n');
export const LETTER_HEADER = '✉️ Лист орендодавцю — чернетка';
export const LETTER_FOOTER = [
  'ℹ️ Заповніть поля в [дужках] і перевірте текст перед надсиланням.',
  'Бот не підтверджує, що квартира відповідає нормам Jobcenter: для перевірки потрібен письмовий Mietangebot.'
].join('\n');

function clip(value, limit) {
  const text = String(value ?? '').replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const end = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return `${(end > limit * 0.6 ? cut.slice(0, end + 1) : cut).trim()} …`;
}

function resultText(result) {
  const value = typeof result === 'string'
    ? result
    : result?.response ?? result?.result?.response ?? result?.choices?.[0]?.message?.content;
  return typeof value === 'string' ? clip(value, MAX_ANSWER_CHARS) : '';
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('AI timeout')), ms); })
  ]);
}

// All model calls of one request share this budget, so the background paths
// still reply inside the 30 s after the webhook response (and a free-text
// answer holds the webhook no longer than this).
const GENERATE_BUDGET_MS = 20000;
const MIN_EXTERNAL_MS = 2500;

async function workersAi(env, messages, timeoutMs = AI_TIMEOUT_MS, maxTokens = ANSWER_TOKENS) {
  if (!env?.AI || typeof env.AI.run !== 'function') return null;
  try {
    const text = resultText(await withTimeout(env.AI.run(AI_MODEL, { messages, max_tokens:maxTokens, temperature:0.2 }), timeoutMs));
    return text || null;
  } catch {
    return null;
  }
}

function externalEnabled(env) {
  return env?.AI_EXTERNAL_ENABLED === 'true';
}

async function externalProvider(provider, env, messages, transport, timeoutMs = EXTERNAL_TIMEOUT_MS, maxTokens = ANSWER_TOKENS) {
  const key = String(env?.[provider.key] || '').trim();
  if (!key || (provider.flag && env?.[provider.flag] !== 'true')) return { status:'skipped' };
  try {
    const response = await transport(provider.url, {
      method:'POST',
      headers:{ authorization:`Bearer ${key}`, 'content-type':'application/json', accept:'application/json' },
      body:JSON.stringify({ model:String(env?.[provider.modelVar] || provider.model), messages, max_tokens:maxTokens, temperature:0.2 }),
      signal:AbortSignal.timeout(timeoutMs)
    });
    if (response.status === 429) return { status:'rate_limited' };
    if (!response.ok) return { status:'failed' };
    const text = resultText(await response.json());
    return text ? { status:'ok', text } : { status:'failed' };
  } catch {
    return { status:'failed' };
  }
}

// Text: Workers AI, then (if enabled) Groq.
// A person's letter (photo or pasted text) never leaves Workers AI.
// `external` is false, or the text sent outside (`externalUser`) that may
// differ from what Workers AI sees.
export async function generate(env, { system, user, imageDataUrl = null, external = true, externalUser = null, maxTokens = ANSWER_TOKENS }, transport = fetch, now = () => Date.now()) {
  const content = imageDataUrl
    ? [{ type:'text', text:user }, { type:'image_url', image_url:{ url:imageDataUrl } }]
    : user;
  const messages = [{ role:'system', content:system }, { role:'user', content }];
  const outside = !imageDataUrl && external && externalEnabled(env);
  const deadline = now() + GENERATE_BUDGET_MS;
  // With a fallback possible, Workers AI leaves room for one external call.
  const primary = await workersAi(env, messages, outside ? GENERATE_BUDGET_MS - EXTERNAL_TIMEOUT_MS - 1000 : AI_TIMEOUT_MS, maxTokens);
  if (primary) return { status:'ok', text:primary, provider:'workers-ai' };
  if (!outside) return { status:'unavailable' };
  const externalMessages = externalUser === null ? messages : [{ role:'system', content:system }, { role:'user', content:externalUser }];
  let rateLimited = false;
  for (const provider of EXTERNAL_PROVIDERS) {
    const remaining = deadline - now() - 1000;
    if (remaining < MIN_EXTERNAL_MS) break;
    const outcome = await externalProvider(provider, env, externalMessages, transport, Math.min(EXTERNAL_TIMEOUT_MS, remaining), maxTokens);
    if (outcome.status === 'ok') return { status:'ok', text:outcome.text, provider:provider.id };
    if (outcome.status === 'rate_limited') rateLimited = true;
  }
  return { status:rateLimited ? 'rate_limited' : 'unavailable' };
}

export function questionInput(text) {
  return clip(text, MAX_INPUT_CHARS);
}

// One screen for "this text may be a person's case": it decides both the
// 24 h cache (ai-commands.mjs) and the external fallback. It catches the
// obvious cases only; a lower-case name or a health detail still passes, so
// users are asked not to write personal data (privacy-policy.mjs).
const LETTER_SHAPE = /(?:sehr\s+geehrte|kundennummer|aktenzeichen|bg-nummer|bedarfsgemeinschaft|steuer-?id|geburtsdatum|iban|mit\s+freundlichen\s+grüßen|bescheid\s+vom)/iu;
const NAME_PART = "\\p{Lu}[\\p{L}\\p{M}'’ʼ-]*";
// Two capitalised words in a row ("Oleh Petrenko", "Petrenko, Oleh",
// "OLEH PETRENKO", "Дар'я Коваль"), or an initial ("О. Петренко").
const NAME_PAIR = new RegExp(`${NAME_PART}[\\s,]+${NAME_PART}`, 'u');
const INITIAL = /(?:^|[\s(])\p{Lu}\.\s*\p{Lu}/u;
// Ukrainian capitalises only names and places inside a sentence. Country
// names that general questions often contain are not a person.
const CYRILLIC_CAPITAL_INSIDE = /[^.!?\n\s]\s+(?=\p{Script=Cyrillic})\p{Lu}/u;
const COMMON_PLACES = /(?:Україн|Німеччин|Європ|Шлезвіг-Гольштейн)\p{L}*/gu;

export function looksPersonal(text) {
  const value = String(text || '');
  return /[\p{Nd}@＠]/u.test(value) || NAME_PAIR.test(value) || INITIAL.test(value) || CYRILLIC_CAPITAL_INSIDE.test(value.replace(COMMON_PLACES, 'місце')) || LETTER_SHAPE.test(value);
}

export function externalSafe(text) {
  const value = String(text || '');
  return value.length <= 300 && !looksPersonal(value);
}

export function answerQuestion(env, question, transport = fetch) {
  return generate(env, { system:SYSTEM_INSTRUCTION, user:questionInput(question), external:externalSafe(question) }, transport);
}

export function scanLetter(env, { text = '', imageDataUrl = null }, transport = fetch) {
  const user = imageDataUrl
    ? `${SCAN_INSTRUCTION}\n\nЛист на фото.`
    : `${SCAN_INSTRUCTION}\n\nТекст листа:\n${questionInput(text)}`;
  return generate(env, { system:SYSTEM_INSTRUCTION, user, imageDataUrl, external:false, maxTokens:SCAN_TOKENS }, transport);
}

// Outside Workers AI a letter is built only from the card's price, place,
// rooms and area lines: an ad title can carry a private landlord's name or
// phone number.
export function listingFacts(listing) {
  return String(listing || '').split('\n')
    .map(line => line.trim())
    .filter(line => /^(?:💶|📍|🛏|📐)/u.test(line))
    // The place line can be a street address: only postcode and town go out.
    .map(line => (line.startsWith('📍') ? `📍 ${line.slice(2).split(',').at(-1).trim()}` : line))
    .map(line => clip(line, 120))
    .join('\n');
}

// The household size the search was made for ("Склад сім'ї: 4" or "Осіб: 4"
// on the card). It stays inside Workers AI, like the rest of the card.
export function householdSize(listing) {
  const persons = Number(/(?:^|\n)\s*(?:Склад сім['’ʼ]ї|Осіб):\s*(\d{1,2})\s*(?:\n|$)/u.exec(String(listing || ''))?.[1]);
  return Number.isSafeInteger(persons) && persons >= 1 && persons <= 20 ? persons : null;
}

export function writeLandlordLetter(env, listing, transport = fetch) {
  const facts = listingFacts(listing);
  const persons = householdSize(listing);
  return generate(env, {
    system:LETTER_INSTRUCTION,
    user:`Angaben aus der Anzeige:\n${clip(listing, 900)}${persons ? `\n\nPersonen im Haushalt: ${persons}` : ''}`,
    external:Boolean(facts),
    externalUser:`Angaben aus der Anzeige:\n${facts}`
  }, transport);
}

// Used when the model is unavailable or the daily limit is reached, so the
// button always gives a usable letter.
export function landlordLetterTemplate(listing) {
  const title = /^(?:🏠\s*)?(?:\d+\/\d+\s*·\s*|\d+\.\s*)?(.+)$/u.exec(String(listing || '').split('\n')[0] || '')?.[1]?.trim();
  return [
    'Sehr geehrte Damen und Herren,',
    '',
    `mit großem Interesse habe ich Ihre Anzeige${title ? ` „${clip(title, 120)}“` : ''} gelesen und möchte mich um die Wohnung bewerben.`,
    `Wir sind ${householdSize(listing) || '[Anzahl der Personen]'} Personen und suchen eine Wohnung ab [Einzugstermin]. Die Miete soll über das Jobcenter [Ort/Kreis] übernommen werden; das Jobcenter prüft vor Vertragsschluss die Angemessenheit.`,
    'Dafür benötige ich bitte ein schriftliches Mietangebot mit Kaltmiete, Betriebskosten, Heizkosten, Kaution und Wohnfläche.',
    'Über einen Besichtigungstermin würde ich mich sehr freuen.',
    '',
    'Mit freundlichen Grüßen',
    '[Vor- und Nachname]',
    '[Telefonnummer]'
  ].join('\n');
}

export function aiAnswerText(answer) {
  return [AI_ANSWER_HEADER, '', clip(answer, MAX_ANSWER_CHARS), '', AI_ANSWER_FOOTER].join('\n');
}

export function scanAnswerText(answer) {
  return [SCAN_HEADER, '', clip(answer, MAX_ANSWER_CHARS), '', SCAN_FOOTER].join('\n');
}

export function letterText(letter, { template = false } = {}) {
  return [
    LETTER_HEADER,
    ...(template ? ['(шаблон: ШІ зараз недоступний або денний ліміт вичерпано)'] : []),
    '',
    clip(letter, MAX_ANSWER_CHARS),
    '',
    LETTER_FOOTER
  ].join('\n');
}

// The listing card the button belongs to, without links and the bot's own
// warning lines. A card holds no personal data.
export function listingFromCard(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^(?:⚠️|Ціна з оголошення|Джерело:|🔗)/u.test(line) && !/https?:\/\//iu.test(line))
    .slice(0, 10)
    .join('\n');
}
