// TG-RUNTIME-082: one main menu keyboard for /start, /menu, /panel and
// ☰ Меню; /menu and /panel send it with PANEL_TEXT.
// The two most used topics take a whole row (big buttons on a phone); the
// callback data stays nav:* so every existing handler keeps working.

export const PANEL_TEXT = [
  '☰ Панель помічника',
  '',
  'Натисніть тему або просто напишіть запитання.',
  'Наприклад: «Kiel 2 кімнати до 900 € warm».'
].join('\n');

export const PANEL_COMMAND = /^\/(?:menu|panel)(?:@ZaskaletaInfoBot)?\s*$/iu;

const nav = (key, text) => ({ text, callback_data:`nav:${key}` });

export function mainInlineMenu() {
  return { inline_keyboard:[
    [nav('housing', '🏠 Житло — пошук і перевірка оренди')],
    [nav('jobcenter', '🏛 Jobcenter — ліміти на житло')],
    [nav('documents', '📄 Документи'), nav('kindergeld', '👶 Kindergeld')],
    [nav('work', '💼 Робота'), nav('courses', '🎓 Курси')],
    [nav('school', '👨‍👩‍👧 Школа / Kita'), nav('transport', '🚌 Транспорт')],
    [nav('news', '🗞 Новини'), nav('events', '🎉 Куди піти')],
    [nav('advice', '🤝 Консультації'), nav('report', '🐞 Помилка')]
  ] };
}
