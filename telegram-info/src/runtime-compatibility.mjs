// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
// Historical helper API only. Do not use in the active dispatcher.
import { mainInlineMenu } from './main-panel.mjs';
import { searchPublicHousingSources } from './housing-public-sources.mjs';
import { formatEuro } from './listing-format.mjs';
import { roomsWord } from './rooms.mjs';
const STATELESS_PATH = '/telegram/stateless';

const TELEGRAM_TIMEOUT_MS = 8000;

const START_OR_MENU_COMMAND = /^(?:\/start(?:@ZaskaletaInfoBot)?|\/(?:menu|panel)(?:@ZaskaletaInfoBot)?|☰\s*Меню)\s*$/iu;

const MAIN_NAV_CALLBACK = /^nav:(?:menu|housing|jobcenter|work|courses|school|transport|documents|kindergeld|news|report)$/u;

const NAVIGATION = Object.freeze({
  housing:'🏠 Житло',
  jobcenter:'🏛 Jobcenter',
  work:'💼 Робота',
  courses:'🎓 Курси',
  school:'👨‍👩‍👧 Школа / Kita',
  transport:'🚌 Транспорт',
  documents:'📄 Документи',
  kindergeld:'👶 Kindergeld',
  news:'🗞 Новини',
  report:'🐞 Повідомити про помилку'
});

const NAVIGATION_TEXTS = new Set(Object.values(NAVIGATION));

const HOUSING_PROVIDER_CREDIT_TEXT = 'У провайдера недостатньо credits для live-пошуку. Поповніть або дочекайтеся доступного безкоштовного ліміту.';

const HOUSING_PROVIDER_FAILURE_PREFIXES = Object.freeze([
  HOUSING_PROVIDER_CREDIT_TEXT,
  'Живий пошук оголошень підготовлено, але провайдер ще не підключено.',
  'Не вдалося однозначно знайти локацію',
  'Провайдер не прийняв API-авторизацію.',
  'Провайдер тимчасово обмежив частоту live-запитів.',
  'Провайдер відхилив параметри пошуку.',
  'Kleinanzeigen тимчасово не відповідає провайдеру.',
  'Сервіс актуальних оголошень тимчасово недоступний.'
]);

const SAFE_PUBLIC_HOUSING_URL = /^https:\/\/(?:www\.)?(?:wankendorfer\.de|wobau-neumuenster\.de|fab\.sh|wbg-kiel-ost\.de|luebecker-bauverein\.de|wobau-oh\.de|wo-di\.de|trave\.de|wogekiel\.de|neueluebecker\.de|adlershorst\.de|big-verwaltung\.de|zbvv\.de|hausundgrund\.de|wg-gesucht\.de|vonovia\.de|tenant\.immomio\.com)\//i;

function isTelegramApiUrl(value) {
  return /^https:\/\/api\.telegram\.org\/bot[^/]+\//u.test(String(value || ''));
}

function isTelegramSendMessageUrl(value) {
  return /^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/u.test(String(value || ''));
}

function providerFailureIndex(text) {
  const source = String(text || '');
  let found = -1;
  for (const prefix of HOUSING_PROVIDER_FAILURE_PREFIXES) {
    const index = source.indexOf(prefix);
    if (index >= 0 && (found < 0 || index < found)) found = index;
  }
  return found;
}

function parseJobcenterSearchCriteria(text) {
  const source = String(text || '');
  const location = /^🔎\s*Автопошук житла під Jobcenter\s*[—–-]\s*([^\n]{2,120})\s*$/mu.exec(source)?.[1]?.trim();
  const roomRaw = /^Кімнати:\s*(\d{1,2}(?:[.,]\d+)?(?:\s*[-–]\s*\d{1,2}(?:[.,]\d+)?)?)\s*$/mu.exec(source)?.[1];
  const amountRaw = /Орієнтир[^\n:]{0,180}:\s*до\s*(\d{2,5}(?:[.,]\d{1,2})?)\s*€\s*Bruttokaltmiete/iu.exec(source)?.[1];
  const radiusRaw = /^Радіус пошуку:\s*(5|10|15|25|50)\s*км\.?\s*$/mu.exec(source)?.[1];
  if (!location || !roomRaw || !amountRaw || !radiusRaw) return null;
  if (!/^[\p{L}\p{M}.'’ -]{2,120}$/u.test(location)) return null;
  const rooms = roomRaw.replace(/\s*[–-]\s*/u, '-').replace(',', '.');
  const amount = Number(amountRaw.replace(',', '.'));
  const radiusKm = Number(radiusRaw);
  if (!/^\d{1,2}(?:\.\d+)?(?:-\d{1,2}(?:\.\d+)?)?$/u.test(rooms) || !Number.isFinite(amount) || amount < 100 || amount > 50000) return null;
  return { location, rooms, amount, type:'Bruttokaltmiete', radiusKm };
}

function shownNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  return number.toLocaleString('de-DE', { maximumFractionDigits:2 });
}

// A euro amount always shows its cents (943,80 €), as on listing cards.
function euro(value) {
  return Number.isFinite(Number(value)) ? formatEuro(value) : shownNumber(value);
}

function publicFallbackText(criteria, result) {
  const listings = Array.isArray(result?.listings) ? result.listings.slice(0, 5) : [];
  if (!listings.length) {
    return [
      '🔎 Автоматичний пошук виконано через доступні відкриті житлові джерела.',
      `За фільтром ${criteria.location}, ${criteria.rooms} ${roomsWord(criteria.rooms)}, до ${euro(criteria.amount)} € зараз не знайдено надійно відфільтрованих пропозицій.`,
      'Кнопки Kleinanzeigen, ImmoScout24 та Immowelt нижче залишаються активними — можна відкрити пошук на порталах одразу.'
    ].join('\n');
  }

  const lines = [
    '🔎 Пошук автоматично продовжено через доступні відкриті житлові джерела.',
    `Знайдено кандидати — ${criteria.location}, ${criteria.rooms} ${roomsWord(criteria.rooms)}, до ${euro(criteria.amount)} €:`
  ];
  listings.forEach((item, index) => {
    const priceType = item?.priceType ? ` · ${String(item.priceType).slice(0, 40)}` : '';
    const area = Number.isFinite(Number(item?.areaSqm)) ? ` · ${shownNumber(item.areaSqm)} м²` : '';
    lines.push(`\n${index + 1}. ${String(item?.title || 'Оголошення').replace(/\s+/g, ' ').trim().slice(0, 140)}\n${euro(item?.price)} €${priceType} · ${String(item?.location || criteria.location).replace(/\s+/g, ' ').trim().slice(0, 100)}${area}\nДжерело: ${String(item?.source || 'відкрите джерело').slice(0, 60)}`);
  });
  lines.push('\nЦе кандидати для перевірки, а не Zusicherung. Перед зверненням перевірте актуальність оголошення та склад орендної плати.');
  return lines.join('\n');
}

function prependPublicListingButtons(markup, result) {
  const existing = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : [];
  const rows = (Array.isArray(result?.listings) ? result.listings : [])
    .slice(0, 5)
    .filter(item => SAFE_PUBLIC_HOUSING_URL.test(String(item?.url || '')))
    .map((item, index) => [{
      text:`${index + 1}. ${String(item?.source || 'Відкрити оголошення').slice(0, 40)}`,
      url:String(item.url)
    }]);
  if (!rows.length) return markup;
  return { ...(markup || {}), inline_keyboard:[...rows, ...existing].slice(0, 16) };
}

async function activatePublicHousingFallback(payload, transport) {
  if (typeof payload?.text !== 'string') return false;
  const failureAt = providerFailureIndex(payload.text);
  if (failureAt < 0) return false;
  const criteria = parseJobcenterSearchCriteria(payload.text);
  if (!criteria) return false;

  let result = { status:'unavailable', listings:[] };
  try {
    result = await searchPublicHousingSources(criteria, transport);
  } catch {}

  const replacement = publicFallbackText(criteria, result);
  payload.text = `${payload.text.slice(0, failureAt)}${replacement}`.slice(0, 4096);
  payload.reply_markup = prependPublicListingButtons(payload.reply_markup, result);
  return true;
}


function isMainReplyKeyboard(rows) {
  const texts = new Set((Array.isArray(rows) ? rows : []).flatMap(row => Array.isArray(row) ? row.map(button => String(button?.text || '')) : []));
  return texts.has('🏠 Житло') && texts.has('🏛 Jobcenter') && texts.has('📄 Документи');
}

function hasInlineMenuButton(rows) {
  return Array.isArray(rows) && rows.some(row => Array.isArray(row) && row.some(button => button?.callback_data === 'nav:menu'));
}

function appendMenuButton(markup) {
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : [];
  if (hasInlineMenuButton(rows)) return markup;
  return { ...markup, inline_keyboard:[...rows, [{ text:'☰ Меню', callback_data:'nav:menu' }]] };
}

export function collapsiblePrivateKeyboardTransport(transport = fetch) {
  return async (url, options = {}) => {
    if (!isTelegramApiUrl(url) || typeof options.body !== 'string') {
      return transport(url, options);
    }

    try {
      const payload = JSON.parse(options.body);
      let changed = await activatePublicHousingFallback(payload, transport);

      if (typeof payload?.text === 'string' && payload.text.includes(HOUSING_PROVIDER_CREDIT_TEXT)) {
        const criteria = parseJobcenterSearchCriteria(payload.text);
        const replacement = criteria
          ? publicFallbackText(criteria, { status:'unavailable', listings:[] })
          : 'Автоматичний пошук оголошень зараз тимчасово недоступний. Скористайтеся кнопками пошуку нижче або спробуйте пізніше.';
        payload.text = payload.text.replace(HOUSING_PROVIDER_CREDIT_TEXT, replacement);
        changed = true;
      }

      const chatId = Number(payload?.chat_id);
      const privateChat = Number.isSafeInteger(chatId) && chatId > 0;
      if (privateChat && isTelegramSendMessageUrl(url)) {
        const markup = payload?.reply_markup;
        if (Array.isArray(markup?.keyboard)) {
          payload.reply_markup = isMainReplyKeyboard(markup.keyboard)
            ? mainInlineMenu()
            : { ...markup, resize_keyboard:true, one_time_keyboard:false, is_persistent:false };
          changed = true;
        } else if (Array.isArray(markup?.inline_keyboard)) {
          payload.reply_markup = appendMenuButton(markup);
          changed = true;
        }
      }

      if (changed) {
        return transport(url, { ...options, body:JSON.stringify(payload) });
      }
    } catch {}

    return transport(url, options);
  };
}
const KEYBOARD_GUARD_MESSAGE_ID = 2147483001;

const TELEGRAM_METHOD_RE = /^https:\/\/api\.telegram\.org\/bot[^/]+\/([A-Za-z]+)$/u;

const MAIN_REPLY_KEYBOARD = Object.freeze([
  Object.freeze([{ text:'🏠 Житло' }, { text:'🏛 Jobcenter' }]),
  Object.freeze([{ text:'💼 Робота' }, { text:'🎓 Курси' }]),
  Object.freeze([{ text:'👨‍👩‍👧 Школа / Kita' }, { text:'🚌 Транспорт' }]),
  Object.freeze([{ text:'📄 Документи' }, { text:'👶 Kindergeld' }]),
  Object.freeze([{ text:'🗞 Новини' }, { text:'🐞 Повідомити про помилку' }])
]);

function telegramOk(result = true) {
  return new Response(JSON.stringify({ ok:true, result }), {
    status:200,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function mainReplyMarkup() {
  return {
    keyboard:MAIN_REPLY_KEYBOARD.map(row => row.map(button => ({ ...button }))),
    resize_keyboard:true,
    one_time_keyboard:false,
    is_persistent:false,
    input_field_placeholder:'Оберіть тему або напишіть запитання'
  };
}

function isMainInlineMenu(markup) {
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : [];
  const callbacks = new Set(rows.flatMap(row => Array.isArray(row) ? row.map(button => String(button?.callback_data || '')) : []));
  return callbacks.has('nav:housing') && callbacks.has('nav:jobcenter') && callbacks.has('nav:documents') && callbacks.has('nav:kindergeld');
}

export function persistentPrivateKeyboardFinalTransport(transport = fetch) {
  return async (url, options = {}) => {
    const method = TELEGRAM_METHOD_RE.exec(String(url || ''))?.[1];
    if (!method || typeof options.body !== 'string') return transport(url, options);

    let payload;
    try { payload = JSON.parse(options.body); } catch { return transport(url, options); }
    const chatId = Number(payload?.chat_id);
    const privateChat = Number.isSafeInteger(chatId) && chatId > 0;
    if (!privateChat) return transport(url, options);

    if (method === 'deleteMessage' && Number(payload?.message_id) === KEYBOARD_GUARD_MESSAGE_ID) {
      return telegramOk(true);
    }

    if (method !== 'sendMessage') return transport(url, options);

    const markup = payload?.reply_markup;
    if (markup?.remove_keyboard === true) {
      return telegramOk({
        message_id:KEYBOARD_GUARD_MESSAGE_ID,
        date:Math.floor(Date.now() / 1000),
        chat:{ id:chatId, type:'private' },
        text:String(payload?.text || '')
      });
    }

    let changed = false;
    if (Array.isArray(markup?.keyboard)) {
      const { selective: _selective, ...rest } = markup;
      payload.reply_markup = {
        ...rest,
        keyboard:markup.keyboard,
        resize_keyboard:true,
        one_time_keyboard:false,
        is_persistent:false
      };
      changed = true;
    } else if (isMainInlineMenu(markup)) {
      // Keep the main navigation inline. Reinstalling a ReplyKeyboardMarkup here
      // makes Telegram persist its input_field_placeholder across later /start
      // interactions, including placeholders left by historical report prompts.
      // Canonicalize the full menu so compatibility callers cannot accidentally
      // retain only a partial subset of the production navigation.
      payload.reply_markup = mainInlineMenu();
      changed = true;
    }

    return changed
      ? transport(url, { ...options, body:JSON.stringify(payload) })
      : transport(url, options);
  };
}
