export const BOT_DISPLAY_NAME = 'Schleswig-Holstein Помічник 🇺🇦🇩🇪';

// Keep text byte-for-byte intact: replies use its plain text as dialogue context.
// JavaScript indices, like Telegram MessageEntity offsets, count UTF-16 units.
export function telegramTextStyle(text) {
  const entities = [];
  const addBold = (offset, length) => {
    if (length <= 0 || entities.length >= 60 || entities.some(e => offset < e.offset + e.length && e.offset < offset + length)) return;
    entities.push({ type: 'bold', offset, length });
  };
  const firstLine = text.split('\n', 1)[0];
  const heading = firstLine.split(/(?<=[.!?])\s/u, 1)[0];
  if (heading.length <= 140) addBold(0, heading.trimEnd().length);
  const brand = text.indexOf(BOT_DISPLAY_NAME);
  if (brand >= 0) addBold(brand, BOT_DISPLAY_NAME.length);
  for (const match of text.matchAll(/^(?:З чого почнемо\?|Команди:|Теми:|Зібрано:|Осіб:|Сума без призначення:|Ще потрібні:|Локація:|Площа(?:-орієнтир)?:|Оренда без опалення:|Кімнати для пошуку:|Опалення \(Heizkosten\):|Дані чинні з:|Орієнтири [^\n]+|Оголошення:|Джерело:|Крок [12]\/2:)/gmu)) {
    addBold(match.index, match[0].length);
  }
  for (const match of text.matchAll(/\b(?:Kaltmiete|Betriebskosten|Heizkosten|Warmmiete)\b/gu)) addBold(match.index, match[0].length);
  for (const match of text.matchAll(/\d+(?:[ .\u00a0\u202f]\d{3})*(?:[.,]\d{1,2})?[ \u00a0\u202f]*€/gu)) addBold(match.index, match[0].length);
  entities.sort((a, b) => a.offset - b.offset);
  return entities.length ? { text, entities } : { text };
}
