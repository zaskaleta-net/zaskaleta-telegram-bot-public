import { GroupTelegramOutbox as BaseGroupTelegramOutbox } from './group-beta-runtime.mjs';
import { pilotConfig, isAllowedPilotChat, readBoundedJSON } from './pilot-security.mjs';
import { normalizeHousingLocation, knownHousingLocation, parseHouseholdSize } from './housing-language.mjs';
import { berlinNewsDateKey, sendNewsDigestToChat, shouldPublishDailyNews } from './pilot-community.mjs';

const INTERNAL_PATH = '/beta-group';
const CALLBACK = /^jc:(\d{6,20}):u(\d{1,20})$/;
const JOBCENTER_NAME = /job[\s-]*center|джоб[\s-]*[цс][еэ]нт[еэ]?р/iu;
const HOUSING = /житл|квартир|wohnung|wohnraum/iu;
const CONTEXT_PREFIX = 'telegram-household-context:v1:';
const DAILY_NEWS_PREFIX = 'telegram-daily-news:v1:';
const CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;
const CONTEXT_GRACE_DELAYS_MS = [0, 120, 300];
const validChatId = value => Number.isSafeInteger(value) && value !== 0;
const validUserId = value => Number.isSafeInteger(value) && value > 0;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const validHouseholdSize = value => Number.isSafeInteger(value) && value >= 1 && value <= 20;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
});

function contextKey(chatId, userId) {
  return `${CONTEXT_PREFIX}${chatId}:${userId}`;
}

function messageText(message) {
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.caption === 'string') return message.caption;
  return '';
}

function householdFromUserMessage(message, expectedUserId) {
  if (!message || message.from?.is_bot === true || message.from?.id !== expectedUserId) return null;
  const persons = parseHouseholdSize(messageText(message));
  return validHouseholdSize(persons) ? persons : null;
}

function householdReplyPrompt(message) {
  const text = messageText(message?.reply_to_message);
  return /Крок\s*1\/2[\s\S]{0,160}кількість\s+осіб/iu.test(text);
}

async function storageCall(env, payload) {
  if (!env?.OUTBOX) return { status:'unavailable' };
  try {
    const id = env.OUTBOX.idFromName('telegram-pilot-v1');
    const response = await env.OUTBOX.get(id).fetch(`https://outbox.internal${INTERNAL_PATH}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(payload)
    });
    if (!response.ok) return { status:'unavailable' };
    const parsed = await readBoundedJSON(response, 16384);
    return parsed.error ? { status:'unavailable' } : parsed.value;
  } catch {
    return { status:'unavailable' };
  }
}

async function storageCallWithRetry(env, payload) {
  let result = { status:'unavailable' };
  for (const delay of [0, 60, 160]) {
    if (delay) await pause(delay);
    result = await storageCall(env, payload);
    if (result.status === 'ok') return result;
    if (result.status === 'forbidden' || result.status === 'bad_operation') break;
  }
  return result;
}

export async function triggerDailyNewsFromScheduler(env = {}, now = Date.now()) {
  if (!validTime(now)) return { status:'bad_operation' };
  return storageCallWithRetry(env, { op:'daily_news', now });
}

export async function rememberNaturalJobcenterContext(update, env = {}, now = Date.now()) {
  const message = update?.message;
  const chat = message?.chat;
  if (!message || !chat || !['group','supergroup'].includes(chat.type) || !validChatId(chat.id) || !validUserId(message.from?.id) || message.from.is_bot === true || !validTime(now)) return false;
  const text = String(message.text || '').trim();
  if (!text || !HOUSING.test(text) || !JOBCENTER_NAME.test(text)) return false;
  const persons = parseHouseholdSize(text);
  const location = normalizeHousingLocation(knownHousingLocation(text));
  if (!validHouseholdSize(persons) || !location) return false;

  // A complete new request is authoritative. It must not be consumed as an answer
  // to an older housing or Jobcenter flow left in the same group/user session.
  const reset = await storageCallWithRetry(env, {
    op:'conversation_reset',
    chatId:chat.id,
    userId:message.from.id,
    now
  });
  if (reset.status !== 'ok') return false;

  const result = await storageCallWithRetry(env, {
    op:'flow_context',
    chatId:chat.id,
    userId:message.from.id,
    state:{ location, jobcenter:true, persons },
    now
  });
  return result.status === 'ok';
}

export function normalizeJobcenterPersonsReply(update) {
  const message = update?.message;
  if (!message || !householdReplyPrompt(message)) return update;
  const direct = Number(String(message.text || '').trim());
  const parsed = Number.isSafeInteger(direct) && direct >= 1 && direct <= 20
    ? direct
    : parseHouseholdSize(message.text);
  if (!validHouseholdSize(parsed)) return update;
  return {
    ...update,
    message:{ ...message, text:String(parsed) }
  };
}

export async function enrichCallbackHouseholdFromActiveFlow(update, env = {}, now = Date.now()) {
  const query = update?.callback_query;
  const caption = String(query?.message?.caption || '');
  if (!query || /(?:^|\n)👥\s*\d{1,2}\s+осіб(?:\s|$)/u.test(caption)) return update;
  const match = CALLBACK.exec(String(query.data || ''));
  if (!match) return update;
  const userId = query?.from?.id;
  const ownerUserId = Number(match[2]);
  if (!validUserId(userId) || !validUserId(ownerUserId) || userId !== ownerUserId) return update;
  const chatId = query?.message?.chat?.id;
  if (!validChatId(chatId) || !validTime(now)) return update;

  // Old listing cards can predate the durable household context. Telegram often
  // still carries the original user request as reply_to_message on that card.
  const repliedPersons = householdFromUserMessage(query.message?.reply_to_message, userId);
  if (validHouseholdSize(repliedPersons)) {
    return {
      ...update,
      callback_query:{
        ...query,
        message:{
          ...query.message,
          caption:`${caption}${caption ? '\n' : ''}👥 ${repliedPersons} осіб`
        }
      }
    };
  }

  const result = await storageCall(env, { op:'flow_read', chatId, userId, now });
  const persons = result?.state?.jobcenter === true ? result.state.persons : null;
  if (!validHouseholdSize(persons)) return update;
  return {
    ...update,
    callback_query:{
      ...query,
      message:{
        ...query.message,
        caption:`${caption}${caption ? '\n' : ''}👥 ${persons} осіб`
      }
    }
  };
}

export class GroupTelegramOutbox extends BaseGroupTelegramOutbox {
  constructor(ctx, env) {
    super(ctx, env);
    this.householdContextStorage = ctx.storage;
  }

  async readHouseholdContext(key, now) {
    for (const delay of CONTEXT_GRACE_DELAYS_MS) {
      if (delay) await pause(delay);
      const stored = await this.householdContextStorage.get(key);
      if (stored && validTime(stored.updatedAt) && stored.updatedAt >= now - CONTEXT_TTL_MS && validHouseholdSize(stored.persons)) return stored;
      if (stored && (!validTime(stored.updatedAt) || stored.updatedAt < now - CONTEXT_TTL_MS || !validHouseholdSize(stored.persons))) {
        await this.householdContextStorage.delete(key);
        return null;
      }
    }
    return null;
  }

  async publishDailyNews(now = Date.now()) {
    if (this.env?.TELEGRAM_INGRESS_ENABLED !== 'true' || !shouldPublishDailyNews(now)) return { sent:0, skipped:true };
    const config = pilotConfig(this.env);
    if (!config) return { sent:0, skipped:true };
    const groups = [...new Set((config.chatIds || []).filter(id => Number.isSafeInteger(id) && id < 0))];
    if (!groups.length) return { sent:0, skipped:true };
    const today = berlinNewsDateKey(now);
    let sent = 0;
    let alreadySent = 0;
    let failed = 0;
    for (const chatId of groups) {
      const markerKey = `${DAILY_NEWS_PREFIX}${chatId}`;
      const lastDate = await this.householdContextStorage.get(markerKey);
      if (lastDate === today) {
        alreadySent += 1;
        continue;
      }
      const result = await sendNewsDigestToChat(config, chatId, now);
      if (result.ok) {
        await this.householdContextStorage.put(markerKey, today);
        sent += 1;
      } else {
        failed += 1;
      }
    }
    return { sent, alreadySent, failed, skipped:false, date:today };
  }

  async alarm() {
    await super.alarm();
    const now = Date.now();
    try {
      const cutoff = now - CONTEXT_TTL_MS;
      const entries = await this.householdContextStorage.list({ prefix:CONTEXT_PREFIX });
      for (const [key, value] of entries) {
        if (!value || !validTime(value.updatedAt) || value.updatedAt < cutoff) await this.householdContextStorage.delete(key);
      }
    } catch {}
    try {
      const result = await this.publishDailyNews(now);
      if (!result.skipped) console.info('TELEGRAM_DAILY_NEWS_ALARM', JSON.stringify(result));
    } catch {
      console.info('TELEGRAM_DAILY_NEWS_ALARM', JSON.stringify({ ok:false, error:'publish_failed' }));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.hostname === 'outbox.internal' && url.pathname === INTERNAL_PATH) {
      const parsed = await readBoundedJSON(request.clone(), 16384);
      const value = parsed.error ? null : parsed.value;
      if (value?.op === 'daily_news') {
        const config = pilotConfig(this.env);
        if (!config) return json({ status:'forbidden' }, 403);
        if (!validTime(value.now)) return json({ status:'bad_operation' }, 400);
        try {
          const result = await this.publishDailyNews(value.now);
          return json({ status:'ok', ...result });
        } catch {
          return json({ status:'unavailable' }, 503);
        }
      }
      if (value?.op === 'flow_read' || value?.op === 'flow_context' || value?.op === 'conversation_reset') {
        const config = pilotConfig(this.env);
        if (!config || !isAllowedPilotChat(config, value.chatId)) return json({ status:'forbidden' }, 403);
        if (!validChatId(value.chatId) || !validUserId(value.userId) || !validTime(value.now)) return json({ status:'bad_operation' }, 400);
        const key = contextKey(value.chatId, value.userId);
        try {
          if (value.op === 'conversation_reset') {
            this.beta.clearFlow(value.chatId, value.userId);
            this.beta.clearJobcenter(value.chatId, value.userId);
            return json({ status:'ok' });
          }
          if (value.op === 'flow_read') {
            const stored = await this.readHouseholdContext(key, value.now);
            if (!stored) return json({ status:'ok', state:null });
            return json({ status:'ok', state:{ jobcenter:true, persons:stored.persons } });
          }
          const persons = value?.state?.persons;
          if (value?.state?.jobcenter !== true || !validHouseholdSize(persons)) return json({ status:'bad_operation' }, 400);
          await this.householdContextStorage.put(key, { persons, updatedAt:value.now });
          return json({ status:'ok' });
        } catch {
          return json({ status:'unavailable' }, 503);
        }
      }
    }
    return super.fetch(request);
  }
}