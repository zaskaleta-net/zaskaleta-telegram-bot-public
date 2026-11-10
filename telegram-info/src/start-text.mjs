// The /start greeting. Both /start paths (the fast private start in
// runtime-keyboard.mjs and the legacy command reply in worker.mjs) send this
// text: on a phone the legacy path answered with the old wording while the
// tests covered only the new one (owner video 17.10.2026).
export const START_TEXT = [
  'Вітаємо!',
  'Schleswig-Holstein Помічник 🇺🇦🇩🇪',
  '',
  'Незалежний інформаційний сервіс для українців у Schleswig-Holstein.',
  '',
  'Що вміє бот — коротко:',
  '1️⃣ 🏠 Житло — шукає квартири на понад 20 сайтах, зокрема під ліміт Jobcenter для вашого складу сім’ї.',
  '2️⃣ 🏛 Jobcenter, документи, Kindergeld — пояснює кроки й дає офіційні посилання.',
  '3️⃣ 🤝 Консультації — безкоштовні пункти допомоги (MBE, JMD) у вашому районі.',
  '4️⃣ 🎉 Куди піти — свята, ярмарки й заходи для сімей поруч із вашим містом.',
  '',
  'Оберіть тему нижче або напишіть запитання.',
  '',
  'Не надсилайте паролі, банківські дані чи повні копії документів.'
].join('\n');
