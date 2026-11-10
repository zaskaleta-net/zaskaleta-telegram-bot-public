import { parseRoomSpec, roomsWord } from './rooms.mjs';
import { normalizeHousingLocation } from './housing-language.mjs';
import { resolveJobcenterRule } from './jobcenter-registry-statewide.mjs';
import { SH_ADMINISTRATIVE_AREAS } from './jobcenter-jurisdictions.mjs';

const FLOW_TTL_MS = 2 * 60 * 60 * 1000;
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const USER_WINDOW_MS = 20 * 1000;
const USER_WINDOW_MAX = 6;
const GROUP_WINDOW_MS = 60 * 1000;
const GROUP_WINDOW_MAX = 40;
const RADII = new Set([5, 10, 15, 25, 50]);
const validChatId = value => Number.isSafeInteger(value) && value !== 0;
const validUserId = value => Number.isSafeInteger(value) && value > 0;
const validUpdateId = value => Number.isSafeInteger(value) && value >= 0;
const validTime = value => Number.isSafeInteger(value) && value >= 0;

function normalizeLocation(value) {
  const supplied = String(value || '').replace(/\s+/g, ' ').trim();
  if (!/^[\p{L}\p{M}.'’ -]{2,80}$/u.test(supplied)) return null;
  return normalizeHousingLocation(supplied);
}

function parseBudget(value) {
  const match = /^(\d{2,5})(?:[.,](\d{1,2}))?\s*(?:€|eur|euro|євро)?(?:\s*(warmmiete|kaltmiete|warm|kalt))?$/iu.exec(String(value || '').trim());
  if (!match) return null;
  const amount = Number(match[1] + (match[2] ? '.' + match[2] : ''));
  if (!Number.isFinite(amount) || amount < 100 || amount > 50000) return null;
  const raw = String(match[3] || '').toLowerCase();
  const type = raw.startsWith('warm') ? 'Warmmiete' : raw.startsWith('kalt') ? 'Kaltmiete' : null;
  return { amount: Math.round(amount * 100) / 100, type };
}

function parseType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'warm' || text === 'warmmiete') return 'Warmmiete';
  if (text === 'kalt' || text === 'kaltmiete') return 'Kaltmiete';
  return null;
}

function parseRadius(value) {
  const match = /^(5|10|15|25|50)\s*(?:км|km)?$/iu.exec(String(value || '').trim());
  const radius = match ? Number(match[1]) : null;
  return RADII.has(radius) ? radius : null;
}

function districtSearchRequested(value) {
  return /^(?:🏘\s*)?(?:по\s+(?:всьому\s+)?району|весь\s+район|район|kreis)$/iu.test(String(value || '').trim());
}

function districtLocationFor(value) {
  const resolved = resolveJobcenterRule(value, 1);
  const jurisdiction = resolved?.jurisdiction;
  if (!jurisdiction || SH_ADMINISTRATIVE_AREAS[jurisdiction]?.type !== 'kreis') return null;
  return `Kreis ${jurisdiction}`;
}

function startsHousing(value) {
  return /^(?:🏠\s*Житло|\/housing(?:@ZaskaletaInfoBot)?|\/wohnung(?:@ZaskaletaInfoBot)?|(?:житло|квартира|wohnung)\s*[:—-])/iu.test(String(value || '').trim());
}

function cleanHousingPrefix(value) {
  return String(value || '').trim().replace(/^(?:житло|квартира|wohnung)\s*[:—-]\s*/iu, '').trim();
}

function safeHousingState(value) {
  if (!value || typeof value !== 'object') return null;
  if (!['city','rooms','budget_choice','budget','type','radius'].includes(value.step)) return null;
  const state = { step: value.step };
  if (typeof value.location === 'string' && value.location.length <= 80) state.location = value.location;
  if (typeof value.rooms === 'string' && /^\d{1,2}(?:-\d{1,2})?$/.test(value.rooms)) state.rooms = value.rooms;
  if (Number.isFinite(value.amount) && value.amount >= 100 && value.amount <= 50000) state.amount = value.amount;
  if (value.type === 'Warmmiete' || value.type === 'Kaltmiete' || value.type === 'Bruttokaltmiete') state.type = value.type;
  if (value.jobcenter === true) state.jobcenter = true;
  if (Number.isSafeInteger(value.persons) && value.persons >= 1 && value.persons <= 20) state.persons = value.persons;
  return state;
}

function safeJobcenterState(value) {
  if (!value || typeof value !== 'object' || !['persons','rent'].includes(value.step)) return null;
  const listingId = String(value.listingId || '');
  const location = String(value.location || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/^\d{6,20}$/.test(listingId) || !location || location.length > 160) return null;
  const state = { step: value.step, listingId, location };
  if (Number.isFinite(value.areaSqm) && value.areaSqm >= 10 && value.areaSqm <= 1000) state.areaSqm = value.areaSqm;
  if (value.step === 'rent') {
    if (!Number.isSafeInteger(value.persons) || value.persons < 1 || value.persons > 20) return null;
    state.persons = value.persons;
  }
  return state;
}

function radiusPrompt(prefix = '') {
  return `${prefix ? `${prefix} ` : ''}Оберіть радіус: 5, 10, 15, 25 або 50 км, або «🏘 По району».`;
}

function formatSearchEuro(value) {
  return Number(value).toFixed(2).replace('.', ',');
}

function budgetChoicePrompt(amount) {
  return [
    'Оберіть бюджет пошуку:',
    `1. 🏛 Використати норматив Jobcenter — до ${formatSearchEuro(amount)} € Bruttokaltmiete`,
    '2. ✍️ Вказати свій бюджет'
  ].join('\n');
}

function useJobcenterBudget(value) {
  return /^(?:1|🏛\s*)?(?:використати\s+)?(?:норм(?:атив|и)?|ліміт|ціна|бюджет)\s*(?:jobcenter|джобцент(?:ер|р))?/iu.test(String(value || '').trim()) || /^1$/u.test(String(value || '').trim());
}

function useCustomBudget(value) {
  return /^(?:2|✍️\s*)?(?:вказати\s+)?(?:свій|власний)\s+бюджет$/iu.test(String(value || '').trim()) || /^2$/u.test(String(value || '').trim());
}

function locationFromJobcenterReply(previous) {
  const topic = /^Тема: житло — ([^.\n]{1,80})\. Локацію вже визначено\./mu.exec(previous)?.[1];
  if (topic) return normalizeLocation(topic);
  const action = /^Житло — ([^,\n]{1,80}),\s*\d{1,2}(?:-\d{1,2})?\s+кімнат(?:а|и)?\./mu.exec(previous)?.[1];
  return action ? normalizeLocation(action) : null;
}

function roomsFromJobcenterReply(previous) {
  const action = /^Житло — [^,\n]{1,80},\s*(\d{1,2}(?:-\d{1,2})?)\s+кімнат(?:а|и)?\./mu.exec(previous)?.[1];
  if (action) return parseRoomSpec(action);
  const context = /^Кімнат:\s*(\d{1,2}(?:-\d{1,2})?)$/mu.exec(previous)?.[1];
  return parseRoomSpec(context);
}

export function jobcenterSearchFromReply(message) {
  const previous = String(message?.replyToText || '').trim();
  if (!previous || !previous.includes('Умова: житло під Jobcenter.')) return null;
  const persons = Number(/^Осіб:\s*(\d{1,2})$/mu.exec(previous)?.[1]);
  if (!Number.isSafeInteger(persons) || persons < 1 || persons > 20) return null;
  const location = locationFromJobcenterReply(previous);
  if (!location) return null;

  const input = String(message?.text || '').trim();
  let rooms = parseRoomSpec(input);
  if (!rooms && /пошук|шука|wohnung|finden/iu.test(input)) rooms = roomsFromJobcenterReply(previous);
  if (!rooms) return null;

  const resolved = resolveJobcenterRule(location, persons);
  if (resolved?.status !== 'verified' || !Number.isFinite(resolved?.rule?.grossColdLimit)) return null;
  const amount = Math.round(resolved.rule.grossColdLimit * 100) / 100;
  const state = {
    step: 'budget_choice',
    location,
    rooms: rooms.label,
    amount,
    type: 'Bruttokaltmiete',
    jobcenter: true,
    persons
  };
  const reply = [
    `Пошук житла — ${location}, ${rooms.label} ${roomsWord(rooms.label)}.`,
    `Осіб: ${persons}`,
    'Умова: житло під Jobcenter.',
    `Перевірений орієнтир Jobcenter: до ${formatSearchEuro(amount)} € Bruttokaltmiete (Kaltmiete + Betriebskosten без опалення).`,
    'Heizkosten перевіряються окремо.',
    '',
    budgetChoicePrompt(amount)
  ].join('\n');
  return { handled: true, state, reply };
}

export function advanceGroupHousingFlow(current, text) {
  const input = String(text || '').trim();
  if (/^\/cancel(?:@ZaskaletaInfoBot)?(?:\s|$)/i.test(input)) return { handled: true, clear: true, reply: 'Поточний пошук житла скасовано.' };

  if (startsHousing(input)) {
    const inline = cleanHousingPrefix(input);
    if (inline && inline !== input && normalizeLocation(inline)) {
      const location = normalizeLocation(inline);
      return { handled: true, state: { step: 'rooms', location }, reply: `Житло — ${location}. Вкажіть кількість кімнат: наприклад 3 або 3-4.` };
    }
    return { handled: true, state: { step: 'city' }, reply: 'Житло. Вкажіть місто або район.' };
  }

  // Commands are routed by the runtime, never consumed as housing values.
  if (/^\//.test(input)) return { handled: false };

  const state = safeHousingState(current);
  if (!state) return { handled: false };

  if (state.step === 'city') {
    const location = normalizeLocation(input);
    if (!location) return { handled: true, state, reply: 'Вкажіть місто або район, наприклад: Trittau, Kiel або Lübeck.' };
    return { handled: true, state: { step: 'rooms', location }, reply: `Житло — ${location}. Вкажіть кількість кімнат: наприклад 3 або 3-4.` };
  }

  if (state.step === 'rooms') {
    const rooms = parseRoomSpec(input);
    if (!rooms) return { handled: true, state, reply: 'Вкажіть кількість кімнат числом або діапазоном, наприклад: 3 або 3-4.' };
    return { handled: true, state: { step: 'budget', location: state.location, rooms: rooms.label }, reply: `Житло — ${state.location}, ${rooms.label} ${roomsWord(rooms.label)}. Вкажіть максимальний місячний бюджет у євро.` };
  }

  if (state.step === 'budget_choice') {
    if (useJobcenterBudget(input)) {
      return {
        handled: true,
        state: { ...state, step: 'radius' },
        reply: [
          `Використовую норматив Jobcenter: до ${formatSearchEuro(state.amount)} € Bruttokaltmiete.`,
          'Heizkosten — окремо.',
          radiusPrompt()
        ].join('\n')
      };
    }
    if (useCustomBudget(input)) {
      return {
        handled: true,
        state: { step: 'budget', location: state.location, rooms: state.rooms, jobcenter: true, persons: state.persons },
        reply: `Вкажіть свій максимальний бюджет у євро. Можна одразу з типом, наприклад: 1100 € Warmmiete або 900 € Kaltmiete.`
      };
    }
    return { handled: true, state, reply: `Оберіть один варіант:\n${budgetChoicePrompt(state.amount)}` };
  }

  if (state.step === 'budget') {
    const budget = parseBudget(input);
    if (!budget) return { handled: true, state, reply: 'Вкажіть бюджет, наприклад: 950 €.' };
    const next = {
      location: state.location,
      rooms: state.rooms,
      amount: budget.amount,
      ...(state.jobcenter ? { jobcenter: true, persons: state.persons } : {})
    };
    if (budget.type) return { handled: true, state: { step: 'radius', ...next, type: budget.type }, reply: radiusPrompt(`Бюджет ${budget.amount} € ${budget.type}.`) };
    return { handled: true, state: { step: 'type', ...next }, reply: `Бюджет ${budget.amount} €. Це Warmmiete чи Kaltmiete?` };
  }

  if (state.step === 'type') {
    const type = parseType(input);
    if (!type) return { handled: true, state, reply: 'Напишіть один варіант: Warmmiete або Kaltmiete.' };
    return {
      handled: true,
      state: {
        step: 'radius',
        location: state.location,
        rooms: state.rooms,
        amount: state.amount,
        type,
        ...(state.jobcenter ? { jobcenter: true, persons: state.persons } : {})
      },
      reply: radiusPrompt(`${type}.`)
    };
  }

  if (districtSearchRequested(input)) {
    const district = districtLocationFor(state.location);
    if (!district) return { handled: true, state, reply: radiusPrompt(`Для ${state.location} окремий Kreis не визначено.`) };
    return {
      handled: true,
      state,
      criteria: {
        location: district,
        rooms: state.rooms,
        amount: state.amount,
        type: state.type,
        radiusKm: 50,
        districtSearch: true,
        originLocation: state.location,
        ...(state.jobcenter ? { jobcenter: true, householdSize: state.persons } : {})
      }
    };
  }

  const radiusKm = parseRadius(input);
  if (!radiusKm) return { handled: true, state, reply: radiusPrompt() };
  return {
    handled: true,
    state,
    criteria: {
      location: state.location,
      rooms: state.rooms,
      amount: state.amount,
      type: state.type,
      radiusKm,
      ...(state.jobcenter ? { jobcenter: true, householdSize: state.persons } : {})
    }
  };
}

export class GroupBetaState {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
  }
  one(query, ...args) { return this.sql.exec(query, ...args).toArray()[0] || null; }
  tx(fn) { return this.storage.transactionSync(fn); }
  init() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_beta_flow (
      chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id,user_id)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_beta_jobcenter (
      chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id,user_id)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_beta_rate (
      scope TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY(scope,bucket)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_beta_seen (
      update_id INTEGER PRIMARY KEY, seen_at INTEGER NOT NULL
    )`);
  }
  increment(scope, bucket) {
    const row = this.one('SELECT count FROM telegram_beta_rate WHERE scope=? AND bucket=?', scope, bucket);
    const next = Number(row?.count || 0) + 1;
    this.sql.exec('INSERT INTO telegram_beta_rate(scope,bucket,count) VALUES(?,?,?) ON CONFLICT(scope,bucket) DO UPDATE SET count=excluded.count', scope, bucket, next);
    return next;
  }
  admit(message, now) {
    if (!validUpdateId(message?.id) || !validChatId(message?.chatId) || !validUserId(message?.userId) || !validTime(now)) throw Error('Invalid beta admission');
    if (this.one('SELECT update_id FROM telegram_beta_seen WHERE update_id=?', message.id)) return { status: 'duplicate' };
    this.sql.exec('INSERT INTO telegram_beta_seen(update_id,seen_at) VALUES(?,?)', message.id, now);
    const userCount = this.increment(`user:${message.chatId}:${message.userId}`, Math.floor(now / USER_WINDOW_MS));
    const groupCount = this.increment(`group:${message.chatId}`, Math.floor(now / GROUP_WINDOW_MS));
    if (userCount > USER_WINDOW_MAX || groupCount > GROUP_WINDOW_MAX) return { status: 'rate_limited' };
    return { status: 'ok' };
  }
  readFlow(chatId, userId, now) {
    const row = this.one('SELECT state_json,updated_at FROM telegram_beta_flow WHERE chat_id=? AND user_id=?', chatId, userId);
    if (!row || row.updated_at < now - FLOW_TTL_MS) return null;
    try { return safeHousingState(JSON.parse(row.state_json)); } catch { return null; }
  }
  writeFlow(chatId, userId, state, now) {
    const safe = safeHousingState(state);
    if (!safe) throw Error('Invalid beta flow state');
    this.sql.exec('INSERT INTO telegram_beta_flow(chat_id,user_id,state_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at', chatId, userId, JSON.stringify(safe), now);
  }
  clearFlow(chatId, userId) {
    this.sql.exec('DELETE FROM telegram_beta_flow WHERE chat_id=? AND user_id=?', chatId, userId);
  }
  readJobcenter(chatId, userId, now = Date.now()) {
    if (!validChatId(chatId) || !validUserId(userId) || !validTime(now)) throw Error('Invalid Jobcenter beta state key');
    const row = this.one('SELECT state_json,updated_at FROM telegram_beta_jobcenter WHERE chat_id=? AND user_id=?', chatId, userId);
    if (!row || row.updated_at < now - FLOW_TTL_MS) return null;
    try { return safeJobcenterState(JSON.parse(row.state_json)); } catch { return null; }
  }
  startJobcenter(message, context, now = Date.now()) {
    if (!context || !validTime(now)) throw Error('Invalid Jobcenter beta start');
    return this.tx(() => {
      const admission = this.admit(message, now);
      if (admission.status !== 'ok') return admission;
      const state = safeJobcenterState({ step:'persons', ...context });
      if (!state) throw Error('Invalid Jobcenter beta context');
      this.clearFlow(message.chatId, message.userId);
      this.sql.exec('INSERT INTO telegram_beta_jobcenter(chat_id,user_id,state_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at', message.chatId, message.userId, JSON.stringify(state), now);
      return { status:'ok', state };
    });
  }
  setJobcenterPersons(chatId, userId, persons, now = Date.now()) {
    if (!validChatId(chatId) || !validUserId(userId) || !Number.isSafeInteger(persons) || persons < 1 || persons > 20 || !validTime(now)) throw Error('Invalid Jobcenter persons');
    return this.tx(() => {
      const current = this.readJobcenter(chatId, userId, now);
      if (!current) return null;
      const state = safeJobcenterState({ ...current, step:'rent', persons });
      this.sql.exec('UPDATE telegram_beta_jobcenter SET state_json=?,updated_at=? WHERE chat_id=? AND user_id=?', JSON.stringify(state), now, chatId, userId);
      return state;
    });
  }
  clearJobcenter(chatId, userId) {
    if (!validChatId(chatId) || !validUserId(userId)) throw Error('Invalid Jobcenter state key');
    this.sql.exec('DELETE FROM telegram_beta_jobcenter WHERE chat_id=? AND user_id=?', chatId, userId);
  }
  process(message, now = Date.now()) {
    if (!validUpdateId(message?.id) || !validChatId(message?.chatId) || !validUserId(message?.userId) || typeof message?.text !== 'string' || message.text.length > 4000 || !validTime(now)) throw Error('Invalid beta group input');
    return this.tx(() => {
      const admission = this.admit(message, now);
      if (admission.status !== 'ok') return admission;
      const current = this.readFlow(message.chatId, message.userId, now);
      const plan = (!current ? jobcenterSearchFromReply(message) : null) || advanceGroupHousingFlow(current, message.text);
      if (plan.handled) {
        if (startsHousing(message.text) || /^\/cancel(?:@ZaskaletaInfoBot)?(?:\s|$)/i.test(message.text)) this.clearJobcenter(message.chatId, message.userId);
        if (plan.clear) this.clearFlow(message.chatId, message.userId);
        else if (plan.state) this.writeFlow(message.chatId, message.userId, plan.state, now);
      }
      return { status: 'ok', ...plan };
    });
  }
  purge(now = Date.now()) {
    if (!validTime(now)) throw Error('Invalid time');
    this.tx(() => {
      this.sql.exec('DELETE FROM telegram_beta_flow WHERE updated_at<?', now - FLOW_TTL_MS);
      this.sql.exec('DELETE FROM telegram_beta_jobcenter WHERE updated_at<?', now - FLOW_TTL_MS);
      this.sql.exec('DELETE FROM telegram_beta_seen WHERE seen_at<?', now - SEEN_TTL_MS);
      this.sql.exec('DELETE FROM telegram_beta_rate WHERE (scope LIKE ? AND bucket<?) OR (scope LIKE ? AND bucket<?)', 'user:%', Math.floor((now - 2 * USER_WINDOW_MS) / USER_WINDOW_MS), 'group:%', Math.floor((now - 2 * GROUP_WINDOW_MS) / GROUP_WINDOW_MS));
    });
  }
}
