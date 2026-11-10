// Datenschutzerklärung (privacy policy) of @ZaskaletaInfoBot, served at
// GET /datenschutz in German (binding) and Ukrainian.
//
// Every statement below follows the code as audited on 14.10.2026, and for
// the AI module (TG-RUNTIME-047) on 18.10.2026 (storage keys, retention,
// outbound hosts), and for the external AI fallback (TG-RUNTIME-048) on the
// same day. When the bot starts storing or
// sending something new, this text must change in the same pull request.
//
// The page and the /privacy link stay off while any controller field still
// holds a [placeholder]: an incomplete policy is not published.
export const PRIVACY_POLICY_PATH = '/datenschutz';
// The bot's own address in the zaskaleta.net ecosystem (Cloudflare Custom
// Domain on this Worker since 17.10.2026), which also receives the webhook.
export const PRIVACY_POLICY_URL = 'https://bot.zaskaleta.net/datenschutz';
export const PRIVACY_POLICY_DATE = '23.10.2026';

export const PRIVACY_CONTROLLER = Object.freeze({
  name:'[Vor- und Nachname]',
  address:'[Straße Hausnummer, PLZ Ort]',
  email:'[E-Mail-Adresse]',
  // TG-RUNTIME-066 review: the Impressum needs a second way to reach the
  // operator directly besides e-mail (phone number or the operator's own
  // Telegram username, e.g. "@name"). /report cannot be answered.
  contact:'[Telefon oder Telegram-Benutzername]'
});

// Name, address and e-mail (as for the policy) plus a second direct contact.
export function impressumPublished(controller = PRIVACY_CONTROLLER) {
  const contact = String(controller?.contact || '').trim();
  return privacyPolicyPublished(controller) && contact.length > 0 && !/[[\]]/u.test(contact);
}

export function privacyPolicyPublished(controller = PRIVACY_CONTROLLER) {
  return ['name', 'address', 'email'].every(field => {
    const value = String(controller?.[field] || '').trim();
    return value.length > 0 && !/[[\]]/u.test(value);
  });
}

const DE = Object.freeze([
  ['1. Verantwortlicher', [
    '{name}<br>{address}<br>E-Mail: <a href="mailto:{email}">{email}</a>',
    'Der Telegram-Bot @ZaskaletaInfoBot („Schleswig-Holstein Помічник“) ist ein kostenloser, unabhängiger Informationsdienst für Menschen aus der Ukraine in Schleswig-Holstein. Er ist keine Behörde. Ein Benutzerkonto gibt es nicht.'
  ]],
  ['2. Welche Daten verarbeitet werden', [
    '<b>Telegram-Kennungen.</b> Mit jeder Nachricht übermittelt Telegram Ihre Telegram-ID, die Chat-ID, Nachrichten-IDs sowie – je nach Ihren Telegram-Einstellungen – Vorname, Nachname, Benutzername und Spracheinstellung. Der Bot verwendet die IDs, um zu antworten. Namen speichert er nicht; nur während einer laufenden Wohnungssuche im ganzen Kreis liegt die vollständige Telegram-Nachricht bis zum Abschluss der Suche im Zwischenspeicher. In Gruppen begrüßt der Bot neue Mitglieder mit dem Vornamen, ohne ihn zu speichern.',
    '<b>Nachrichteninhalte.</b> Ihre Nachrichten und Schaltflächen werden verarbeitet, um die Antwort zu erzeugen, und danach nicht gespeichert. Ausnahme: Fehlermeldungen (Abschnitt 4).',
    '<b>Dialog- und Suchstatus</b> (gespeichert mit Telegram-ID und Chat-ID):',
    '<ul><li>die letzte Frage des Bots, damit Ihre Antwort zugeordnet werden kann – 15 Minuten;</li><li>bei der Mietprüfung eingegebene Beträge sowie Wohnart, Ort und Zimmerzahl – 15 Minuten;</li><li>Haushaltsgröße (Anzahl der Personen) – 2 Stunden;</li><li>Suchkriterien einer Wohnungssuche (Ort, Jobcenter-Bereich, Personen, Zimmer) und Kennungen der bereits gezeigten Anzeigen, damit keine Anzeige doppelt erscheint – 1 Stunde;</li><li>die Anzahl Ihrer Anfragen an den KI-Assistenten am jeweiligen Tag (für das Tageslimit) – 2 Tage;</li><li>bei Premium: Ablaufdatum, Betrag und Zahlungskennung von Telegram – bis 30 Tage nach Ablauf.</li></ul>',
    '<b>Technische Einträge.</b> Kennungen eingehender Telegram-Updates zum Schutz vor Doppelverarbeitung – höchstens 1 Stunde. Ein Vermerk, dass Ihre Bot-Tastatur aktualisiert wurde (Telegram-ID, Chat-ID, Nachrichten-IDs, Zeitpunkt) – 180 Tage. Die Zeitpunkte Ihrer letzten Wohnungssuchen (mit Telegram-ID und Chat-ID), damit eine Person nicht viele Suchen gleichzeitig startet und die Immobilienportale überlastet – 10 Minuten. Abgelaufene Einträge werden stündlich gelöscht.',
    '<b>Betriebsprotokolle.</b> Zur Fehlersuche schreibt der Bot technische Statuszeilen in die Protokolle von Cloudflare (Workers Logs), z. B. welche Quellen bei einer Wohnungssuche geantwortet haben und wie viele Anzeigen gefunden wurden, bei einem Fehler auch den gesuchten Ort. Nachrichteninhalte, Namen, Telegram-ID und Chat-ID werden dort nicht eingetragen. Cloudflare löscht diese Protokolle nach 3 Tagen.',
    '<b>Gruppen.</b> Für Gruppen, in denen der Bot arbeitet, werden die Gruppen-ID sowie Vermerke über bereits versandte Nachrichtenübersichten und Wartungshinweise gespeichert.'
  ]],
  ['3. Wohnungssuche und externe Quellen', [
    'Für eine Wohnungssuche ruft der Bot öffentliche Immobilienportale ab (kleinanzeigen.de bzw. die Kleinanzeigen-Agent-API, ohne-makler.net, kip.net, wg-gesucht.de, immobilienscout24.de, vonovia.de, immomio.com, wo-di.de sowie Seiten kommunaler Wohnungsunternehmen und Genossenschaften). Übermittelt werden nur die Suchkriterien – Ort, Umkreis, Zimmerzahl und Preisgrenze –, keine Telegram-ID und kein Name. Die Anfragen kommen von Servern von Cloudflare, nicht von Ihrem Gerät. Fotos der Anzeigen werden von den Portalen geladen und an Telegram weitergegeben.',
    'Einige Schaltflächen öffnen eine Google-Suche nach Wohnungsanzeigen. Erst wenn Sie eine solche Schaltfläche antippen, ruft Ihr Gerät google.com auf; Google erhält dabei die Suchbegriffe (Ort, Zimmerzahl, Preisgrenze, Umkreis, Warm- oder Kaltmiete) und die IP-Adresse Ihres Geräts nach den eigenen Bedingungen von Google. Der Bot selbst übermittelt nichts an Google.',
    'Nachrichten, Wetter, Verkehrsmeldungen und Veranstaltungstipps stammen von öffentlichen Quellen (u. a. NDR, Landesregierung Schleswig-Holstein, NAH.SH, Open-Meteo, nordticker.de). Beratungsstellen stammen aus der BAMF-Datenbank NAvI; übermittelt wird dabei nur der gewählte Kreis. Dabei werden keine personenbezogenen Daten übermittelt. Nachrichtentexte werden mit Cloudflare Workers AI ins Ukrainische übersetzt; Ihre Nachrichten werden dafür nicht verwendet.',
    '<b>KI-Assistent.</b> Wenn Sie eine Frage stellen, die der Bot nicht einem Bereich zuordnen kann, mit /scanner ein Foto oder den Text eines Briefes senden oder unter einer Anzeige „🤖 Написати орендодавцю (ШІ)“ wählen, wird der Text bzw. das Foto mit Cloudflare Workers AI (Modell Mistral Small 3.1) verarbeitet, um die Antwort zu erzeugen. Telegram-ID und Name werden dabei nicht übermittelt. Fotos und Brieftexte werden nicht gespeichert. Antworten auf allgemeine Fragen ohne Ziffern und ohne Namen sowie Vermieter-Briefe zu einer Anzeige werden ohne Zuordnung zu Ihrer Telegram-ID bis zu 24 Stunden zwischengespeichert, damit dieselbe Frage nicht erneut verarbeitet wird. Ist Workers AI nicht erreichbar oder ausgelastet, kann der Text einer kurzen allgemeinen Frage oder – für einen Vermieter-Brief – nur Preis, Ort, Zimmerzahl und Wohnfläche der Anzeige ersatzweise an Groq, Inc. (USA) übermittelt werden. Übermittelt wird der Inhalt der Frage, nicht Ihre Telegram-ID oder Ihr Telegram-Name; bitte schreiben Sie keine personenbezogenen Daten in eine Frage. Fotos und Texte von Briefen (/scanner) sowie längere oder briefähnliche Texte werden nie an Groq übermittelt; Fragen mit Ziffern, E-Mail-Adressen oder erkennbaren Namen werden ebenfalls nicht übermittelt. Die Antworten sind allgemeine Informationen und keine Rechtsberatung. Bitte decken Sie Kundennummer, IBAN und Geburtsdatum vor dem Foto ab.',
    '<b>Wohnungs-Benachrichtigung.</b> Wenn Sie unter einer Wohnungssuche „🔔 Стежити за новими оголошеннями“ wählen, speichert der Bot Ihre Chat-ID, Ort, Personenzahl, Zimmerzahl und Radius (bzw. Suche im ganzen Kreis) dieser Suche sowie Kennungen der Ihnen bereits gezeigten oder gemeldeten Anzeigen. Der Bot wiederholt die Suche in dem von Ihnen gewählten Abstand (alle 15 Minuten bis einmal täglich) bei denselben Wohnungsportalen und sendet Ihnen nur neue Anzeigen; eine KI wird dafür nicht verwendet. Die Daten werden spätestens 30 Tage nach dem letzten Einschalten oder Verlängern gelöscht (zwei Tage vor Ablauf erinnert der Bot einmal daran), sofort mit /watch → „Вимкнути“ oder mit /forget; haben Sie den Bot blockiert, bei der nächsten Benachrichtigung, die Telegram deshalb nicht zustellt.',
    '<b>Premium.</b> Ein optionales Premium mit höherem KI-Tageslimit wird über Telegram Stars bezahlt. Die Zahlung wickelt Telegram ab; der Bot erhält keine Bank- oder Kartendaten, nur die Zahlungsbestätigung mit Betrag und Zahlungskennung.'
  ]],
  ['4. Fehlermeldungen', [
    'Wenn Sie über „🐞 Повідомити про помилку“ eine Meldung senden, werden Ihr Text (bis 1.200 Zeichen) und gegebenenfalls ein Bild an die Administratoren des Bots und die Inhaber der Partnergruppen in Telegram weitergeleitet und zur Bearbeitung bei Supabase Inc. gespeichert. Telegram-ID, Name und Benutzername werden dabei nicht übermittelt. Bitte nennen Sie in einer Meldung keine personenbezogenen Daten. Meldungen werden gelöscht, sobald sie bearbeitet sind, oder früher auf Ihren Antrag.'
  ]],
  ['5. Empfänger und Auftragsverarbeiter', [
    '<b>Telegram</b> – der Messenger, über den Sie den Bot nutzen. Telegram verarbeitet Ihre Daten in eigener Verantwortung: <a href="https://telegram.org/privacy">telegram.org/privacy</a>.',
    '<b>Cloudflare, Inc.</b> (USA) – Betrieb des Bots (Cloudflare Workers, Durable Objects als Speicher, Workers Logs als Betriebsprotokoll, Workers AI für die Übersetzung von Nachrichtentexten und den KI-Assistenten). <a href="https://www.cloudflare.com/privacypolicy/">cloudflare.com/privacypolicy</a>.',
    '<b>Supabase Inc.</b> (USA) – Speicherung von Fehlermeldungen. <a href="https://supabase.com/privacy">supabase.com/privacy</a>.',
    '<b>Groq, Inc.</b> (USA) – nur als Ersatz für Workers AI bei kurzen allgemeinen Fragen und Vermieter-Briefen (Abschnitt 3). <a href="https://groq.com/privacy-policy/">groq.com/privacy-policy</a>.',
    'Eine Übermittlung in die USA ist möglich. Cloudflare, Inc. ist nach dem EU-US Data Privacy Framework zertifiziert; für Supabase und Groq gelten die Standardvertragsklauseln der EU-Kommission aus deren Auftragsverarbeitungsvertrag (Data Processing Addendum). Groq verwendet die Daten laut seinem Auftragsverarbeitungsvertrag nur für die dort beschriebenen Zwecke.'
  ]],
  ['6. Keine Analyse, keine Werbung', [
    'Der Bot setzt keine Analyse- oder Tracking-Dienste ein, zeigt keine Werbung, erstellt keine Profile und trifft keine automatisierten Entscheidungen mit rechtlicher Wirkung. Die technischen Betriebsprotokolle (Abschnitt 2) enthalten keine Nachrichteninhalte, Namen, Telegram-ID oder Chat-ID und werden nach 3 Tagen gelöscht. Zur Überwachung des Betriebs zählt der Bot ohne jeden Personenbezug, wie oft Bereiche genutzt wurden und ob Suchen erfolgreich waren; diese Tageszähler werden nach 8 Tagen gelöscht.'
  ]],
  ['7. Rechtsgrundlagen', [
    'Die Verarbeitung erfolgt, um die von Ihnen angefragte Information bereitzustellen (Art. 6 Abs. 1 lit. b DSGVO), sowie auf Grundlage unseres berechtigten Interesses an einem sicheren, missbrauchsfreien und fehlerfreien Betrieb (Art. 6 Abs. 1 lit. f DSGVO).'
  ]],
  ['8. Ihre Rechte', [
    'Mit dem Befehl /forget im privaten Chat löschen Sie alle beim Bot zu Ihnen gespeicherten Daten sofort selbst, einschließlich eines Premium-Eintrags.',
    'Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch (Art. 15 bis 21 DSGVO). Schreiben Sie dazu an die oben genannte E-Mail-Adresse und nennen Sie Ihre Telegram-ID oder Ihren Benutzernamen, damit wir Ihre Daten finden.',
    'Sie können sich bei einer Datenschutz-Aufsichtsbehörde beschweren (Art. 77 DSGVO), insbesondere in dem Bundesland oder Mitgliedstaat Ihres Aufenthalts. In Schleswig-Holstein ist das das Unabhängige Landeszentrum für Datenschutz Schleswig-Holstein (ULD).',
    'Die Nutzung des Bots ist freiwillig. Senden Sie bitte keine Passwörter, PINs, Bankdaten, Kundennummern oder vollständigen Dokumentenkopien.'
  ]]
]);

const UK = Object.freeze([
  ['1. Відповідальна особа', [
    '{name}<br>{address}<br>E-mail: <a href="mailto:{email}">{email}</a>',
    'Telegram-бот @ZaskaletaInfoBot («Schleswig-Holstein Помічник») — безкоштовний незалежний інформаційний сервіс для людей з України у Schleswig-Holstein. Він не є державним органом. Обліковий запис не потрібен.'
  ]],
  ['2. Які дані обробляються', [
    '<b>Ідентифікатори Telegram.</b> З кожним повідомленням Telegram передає ваш Telegram-ID, ID чату, ID повідомлень і, залежно від ваших налаштувань Telegram, ім’я, прізвище, ім’я користувача та мову. Бот використовує ID, щоб відповісти. Імен він не зберігає; лише під час пошуку житла по всьому району повне повідомлення Telegram тимчасово зберігається до завершення пошуку. У групах бот вітає нових учасників на ім’я, не зберігаючи його.',
    '<b>Зміст повідомлень.</b> Ваші повідомлення й натискання кнопок обробляються, щоб сформувати відповідь, і після цього не зберігаються. Виняток — повідомлення про помилку (розділ 4).',
    '<b>Стан діалогу та пошуку</b> (зберігається разом із Telegram-ID та ID чату):',
    '<ul><li>останнє запитання бота, щоб зрозуміти вашу відповідь, — 15 хвилин;</li><li>суми, введені під час перевірки оренди, а також тип житла, місто й кількість кімнат — 15 хвилин;</li><li>склад сім’ї (кількість осіб) — 2 години;</li><li>критерії пошуку житла (місто, територія Jobcenter, кількість осіб, кімнати) та ідентифікатори вже показаних оголошень, щоб не повторювати їх, — 1 година;</li><li>кількість ваших запитів до ШІ-помічника за день (для денного ліміту) — 2 дні;</li><li>для Premium: дата завершення, сума та ідентифікатор платежу Telegram — до 30 днів після завершення.</li></ul>',
    '<b>Технічні записи.</b> Ідентифікатори вхідних оновлень Telegram для захисту від повторної обробки — не більше 1 години. Позначка, що вашу клавіатуру бота оновлено (Telegram-ID, ID чату, ID повідомлень, час), — 180 днів. Час ваших останніх пошуків житла (разом із Telegram-ID та ID чату), щоб одна людина не запускала багато пошуків одночасно й не перевантажувала портали, — 10 хвилин. Прострочені записи видаляються щогодини.',
    '<b>Журнали роботи.</b> Для пошуку помилок бот записує технічні службові рядки в журнали Cloudflare (Workers Logs), наприклад, які джерела відповіли під час пошуку житла і скільки оголошень знайдено, а у разі помилки — також місто пошуку. Зміст повідомлень, імена, Telegram-ID та ID чату туди не записуються. Cloudflare видаляє ці журнали через 3 дні.',
    '<b>Групи.</b> Для груп, у яких працює бот, зберігаються ID групи та позначки про вже надіслані огляди новин і повідомлення про технічні роботи.'
  ]],
  ['3. Пошук житла та зовнішні джерела', [
    'Для пошуку житла бот звертається до публічних порталів нерухомості (kleinanzeigen.de або Kleinanzeigen-Agent-API, ohne-makler.net, kip.net, wg-gesucht.de, immobilienscout24.de, vonovia.de, immomio.com, wo-di.de та сайти комунальних житлових компаній). Передаються лише критерії пошуку — місто, радіус, кількість кімнат і межа ціни — без Telegram-ID та імені. Запити надходять із серверів Cloudflare, а не з вашого пристрою. Фото оголошень завантажуються з порталів і передаються в Telegram.',
    'Деякі кнопки відкривають пошук оголошень у Google. Лише коли ви натискаєте таку кнопку, ваш пристрій звертається до google.com; Google отримує пошукові слова (місто, кількість кімнат, межу ціни, радіус, Warm- чи Kaltmiete) та IP-адресу вашого пристрою відповідно до власних умов Google. Бот сам нічого не передає Google.',
    'Новини, погода, транспортні повідомлення й афіша заходів беруться з публічних джерел (зокрема NDR, уряд землі Schleswig-Holstein, NAH.SH, Open-Meteo, nordticker.de). Консультаційні пункти беруться з бази BAMF-NAvI; при цьому передається лише обраний район. Персональні дані при цьому не передаються. Тексти новин перекладаються українською за допомогою Cloudflare Workers AI; ваші повідомлення для цього не використовуються.',
    '<b>ШІ-помічник.</b> Якщо ви ставите запитання, яке бот не може віднести до жодного розділу, надсилаєте через /scanner фото чи текст листа або натискаєте під оголошенням «🤖 Написати орендодавцю (ШІ)», текст або фото обробляються Cloudflare Workers AI (модель Mistral Small 3.1), щоб сформувати відповідь. Telegram-ID та ім’я при цьому не передаються. Фото й тексти листів не зберігаються. Відповіді на загальні запитання без цифр та імен і листи орендодавцю за оголошенням тимчасово зберігаються без прив’язки до вашого Telegram-ID до 24 годин, щоб не обробляти те саме запитання повторно. Якщо Workers AI недоступний або перевантажений, текст короткого загального запитання або — для листа орендодавцю — лише ціна, місто, кількість кімнат і площа з оголошення можуть бути передані резервно сервісу Groq, Inc. (США). Передається зміст запитання, а не ваш Telegram-ID чи ім’я в Telegram; будь ласка, не пишіть у запитанні персональних даних. Фото й тексти листів (/scanner), а також довші тексти чи тексти, схожі на лист, ніколи не передаються Groq; запитання з цифрами, e-mail-адресами або розпізнаними іменами також не передаються. Відповіді є загальною інформацією, а не юридичною консультацією. Перед фото прикрийте Kundennummer, IBAN і дату народження.',
    '<b>Сповіщення про житло.</b> Якщо після пошуку житла ви натискаєте «🔔 Стежити за новими оголошеннями», бот зберігає ваш chat-ID, місто, кількість осіб, кількість кімнат і радіус (або пошук по всьому району) цього пошуку, а також ідентифікатори вже показаних або надісланих вам оголошень. Бот повторює пошук з обраною вами періодичністю (від кожних 15 хвилин до раз на день) на тих самих порталах житла і надсилає лише нові оголошення; ШІ для цього не використовується. Дані видаляються не пізніше ніж через 30 днів після останнього ввімкнення або продовження (за два дні до кінця бот один раз нагадує про це), одразу — через /watch → «Вимкнути» або /forget; якщо ви заблокували бота — під час наступного сповіщення, яке Telegram через це не доставить.',
    '<b>Premium.</b> Необов’язковий Premium з більшим денним лімітом ШІ оплачується через Telegram Stars. Оплату проводить Telegram; бот не отримує банківських даних чи даних картки, лише підтвердження оплати із сумою та ідентифікатором платежу.'
  ]],
  ['4. Повідомлення про помилку', [
    'Якщо ви надсилаєте повідомлення через «🐞 Повідомити про помилку», ваш текст (до 1200 символів) і, за наявності, зображення пересилаються адміністраторам бота та власникам партнерських груп у Telegram і зберігаються для опрацювання в Supabase Inc. Telegram-ID, ім’я та ім’я користувача при цьому не передаються. Будь ласка, не вказуйте в повідомленні персональних даних. Повідомлення видаляються після опрацювання або раніше — на ваш запит.'
  ]],
  ['5. Отримувачі та обробники даних', [
    '<b>Telegram</b> — месенджер, через який ви користуєтеся ботом. Telegram обробляє ваші дані на власну відповідальність: <a href="https://telegram.org/privacy">telegram.org/privacy</a>.',
    '<b>Cloudflare, Inc.</b> (США) — робота бота (Cloudflare Workers, Durable Objects як сховище, Workers Logs як журнали роботи, Workers AI для перекладу новин і ШІ-помічника). <a href="https://www.cloudflare.com/privacypolicy/">cloudflare.com/privacypolicy</a>.',
    '<b>Supabase Inc.</b> (США) — зберігання повідомлень про помилки. <a href="https://supabase.com/privacy">supabase.com/privacy</a>.',
    '<b>Groq, Inc.</b> (США) — лише як резерв для Workers AI для коротких загальних запитань і листів орендодавцю (розділ 3). <a href="https://groq.com/privacy-policy/">groq.com/privacy-policy</a>.',
    'Можлива передача даних до США. Cloudflare, Inc. сертифікована за EU-US Data Privacy Framework; для Supabase і Groq діють стандартні договірні умови Європейської комісії з їхніх договорів про обробку даних (Data Processing Addendum). Згідно з договором про обробку даних Groq використовує дані лише для визначених у ньому цілей.'
  ]],
  ['6. Без аналітики та реклами', [
    'Бот не використовує сервісів аналітики чи відстеження, не показує реклами, не створює профілів і не ухвалює автоматизованих рішень із юридичними наслідками. Технічні журнали роботи (розділ 2) не містять змісту повідомлень, імен, Telegram-ID чи ID чату і видаляються через 3 дні. Для контролю роботи бот без жодної прив’язки до осіб рахує, скільки разів використовувалися розділи та чи вдалися пошуки; ці денні лічильники видаляються через 8 днів.'
  ]],
  ['7. Правові підстави', [
    'Обробка здійснюється, щоб надати запитану вами інформацію (ст. 6 ч. 1 п. b DSGVO), а також на підставі нашого законного інтересу до безпечної, захищеної від зловживань і безпомилкової роботи (ст. 6 ч. 1 п. f DSGVO).'
  ]],
  ['8. Ваші права', [
    'Командою /forget у приватному чаті ви самі одразу видаляєте всі дані, які бот зберігає про вас, разом із записом Premium.',
    'Ви маєте право на доступ до даних, виправлення, видалення, обмеження обробки, перенесення даних і заперечення (ст. 15–21 DSGVO). Напишіть на вказану вище e-mail-адресу та зазначте свій Telegram-ID або ім’я користувача, щоб ми могли знайти ваші дані.',
    'Ви можете подати скаргу до органу нагляду за захистом даних (ст. 77 DSGVO), зокрема в землі чи державі вашого проживання. У Schleswig-Holstein це Unabhängiges Landeszentrum für Datenschutz Schleswig-Holstein (ULD).',
    'Користування ботом добровільне. Будь ласка, не надсилайте паролі, PIN-коди, банківські дані, номери клієнта чи повні копії документів.'
  ]]
]);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
}

function section(sections, controller) {
  const fill = text => text.replace(/\{(name|address|email)\}/gu, (_, field) => escapeHtml(controller[field]));
  return sections.map(([title, paragraphs]) => `<h2>${title}</h2>\n${paragraphs.map(text => {
    const filled = fill(text);
    return filled.startsWith('<ul>') ? filled : `<p>${filled}</p>`;
  }).join('\n')}`).join('\n');
}

export function privacyPolicyHtml(controller = PRIVACY_CONTROLLER) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Datenschutzerklärung – @ZaskaletaInfoBot</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#5a5a5a;--line:#ddd;--link:#0b57d0}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--muted:#a8a8a8;--line:#333;--link:#8ab4f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:46rem;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:28px 0 8px}
p,li{margin:0 0 10px}ul{padding-left:1.25rem}a{color:var(--link)}
.meta{color:var(--muted);margin-bottom:16px}nav a{margin-right:16px}
hr{border:0;border-top:1px solid var(--line);margin:40px 0}
</style>
</head>
<body>
<main>
<nav><a href="#de">Deutsch</a><a href="#uk">Українська</a></nav>
<section id="de" lang="de">
<h1>Datenschutzerklärung</h1>
<p class="meta">@ZaskaletaInfoBot · Stand: ${PRIVACY_POLICY_DATE}</p>
${section(DE, controller)}
</section>
<hr>
<section id="uk" lang="uk">
<h1>Політика конфіденційності</h1>
<p class="meta">@ZaskaletaInfoBot · станом на ${PRIVACY_POLICY_DATE} · переклад; юридично чинною є німецька версія</p>
${section(UK, controller)}
</section>
${impressumPublished(controller) ? '<hr>\n<p><a href="/impressum">Impressum</a></p>\n' : ''}</main>
</body>
</html>`;
}

// GET /datenschutz. Returns null for every other request, and while the
// policy is not published, so the normal 404 handling stays unchanged.
export function handlePrivacyPolicyRequest(request, controller = PRIVACY_CONTROLLER) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (url.pathname !== PRIVACY_POLICY_PATH && url.pathname !== `${PRIVACY_POLICY_PATH}/`) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (!privacyPolicyPublished(controller)) return null;
  const body = request.method === 'HEAD' ? null : privacyPolicyHtml(controller);
  return new Response(body, {
    status:200,
    headers:{
      'content-type':'text/html; charset=utf-8',
      'cache-control':'public, max-age=3600',
      'x-content-type-options':'nosniff',
      'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy':'no-referrer'
    }
  });
}

export function privacyCommandText(controller = PRIVACY_CONTROLLER) {
  const rules = 'Не надсилайте паролі, PIN-коди, банківські дані або повні копії документів.\n\nУ групах персональні запити та результати щодо житла або Jobcenter обробляються в приватному чаті.';
  if (!privacyPolicyPublished(controller)) {
    // TG-RUNTIME-066: Telegram's policy does not cover the bot's own
    // processing, so the text no longer points to it.
    return `🔐 Конфіденційність\n\n${rules}\n\nПовна політика конфіденційності (Datenschutzerklärung) та Impressum ще готуються і будуть опубліковані до офіційного запуску.\n\nВидалити всі свої дані в боті одразу: /forget`;
  }
  return [
    '🔐 Конфіденційність',
    '',
    rules,
    '',
    'Коротко: бот не зберігає ваших повідомлень та імен. Стан діалогу й пошуку житла зберігається від 15 хвилин до 2 годин. Аналітики й реклами немає. Пошук житла передає порталам лише місто, кімнати й межу ціни. ШІ-функції працюють на Cloudflare Workers AI; фото й тексти листів не зберігаються.',
    '',
    `Повна політика конфіденційності (Datenschutzerklärung):\n${PRIVACY_POLICY_URL}`,
    '',
    'Видалити всі свої дані в боті одразу: /forget',
    `Запит на доступ до даних: ${controller.email}`
  ].join('\n');
}
