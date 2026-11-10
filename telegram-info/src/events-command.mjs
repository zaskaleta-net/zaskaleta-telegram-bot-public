// "🎉 Куди піти": the menu button (nav:events), its text and /events answer in
// a private chat with the upcoming events from nordticker.de.
import { pilotConfig, equalSecret, readBoundedJSON } from './pilot-security.mjs';
import { fetchNordtickerEvents, eventsReplyText, eventsKeyboard, eventsPlace, eventsBarePlace, EVENTS_UNAVAILABLE_TEXT, EVENTS_TOWN_PROMPT, EVENTS_FOLLOWUP_PROMPT } from './events-nordticker.mjs';
import { rememberPrivatePrompt, forgetPrivatePrompt } from './runtime-keyboard.mjs';

const STATELESS_PATH = '/telegram/stateless';
export const EVENTS_BUTTON_TEXT = '🎉 Куди піти';
const EVENTS_TEXT = /^(?:\/events(?:@ZaskaletaInfoBot)?|🎉\s*Куди піти)(?:\s+(\S[^\n]{0,59}))?\s*$/iu;
const TOWN_CALLBACK = /^ev:t:([^:]{2,40})$/u;
const ASK_CALLBACK = 'ev:ask';

// A typed town answering the "🔎 Інше місто" prompt (a real reply or the
// saved prompt context the runtime adds to the next message).
function promptedTown(message) {
  const text = String(message?.text || '').trim();
  if (!text || text.startsWith('/') || text.length > 60) return null;
  const prompt = message?.reply_to_message?.text;
  if (prompt === EVENTS_TOWN_PROMPT) return text;
  // After an events list only a bare town continues the events section.
  return prompt === EVENTS_FOLLOWUP_PROMPT && eventsBarePlace(text) ? text : null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

async function telegram(config, method, payload, transport) {
  try {
    const response = await transport(`https://api.telegram.org/bot${config.token}/${method}`, {
      method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload)
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

export function isEventsRequestUpdate(update) {
  const query = update?.callback_query;
  if (query) return (query.data === 'nav:events' || query.data === ASK_CALLBACK || TOWN_CALLBACK.test(String(query.data || ''))) && query.message?.chat?.type === 'private';
  return update?.message?.chat?.type === 'private' && (EVENTS_TEXT.test(String(update?.message?.text || '').trim()) || Boolean(promptedTown(update?.message)));
}

export async function eventsCommand(request, env, now = Date.now(), transport = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error || !isEventsRequestUpdate(parsed.value)) return null;
  const update = parsed.value;
  const query = update.callback_query;
  const chatId = Number(query ? query.message?.chat?.id : update.message?.chat?.id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0 || (query ? query.from?.is_bot : update.message?.from?.is_bot) === true) return json({ ok:true, ignored:true });
  if (query?.id) await telegram(config, 'answerCallbackQuery', { callback_query_id:query.id }, transport);
  if (query?.data === ASK_CALLBACK) {
    const asked = await telegram(config, 'sendMessage', { chat_id:chatId, text:EVENTS_TOWN_PROMPT }, transport);
    if (asked) await rememberPrivatePrompt(env, chatId, EVENTS_TOWN_PROMPT, now).catch(() => null);
    return json({ ok:true, mode:'events-v1', delivered:asked, source:'ask_town' });
  }
  // A town from a button, "/events Ort" or the prompt; an unknown name gets
  // a short notice above the whole-Land list.
  const askedTown = query ? TOWN_CALLBACK.exec(String(query.data || ''))?.[1] : (promptedTown(update.message) || EVENTS_TEXT.exec(String(update.message?.text || '').trim())?.[1]);
  const near = askedTown ? eventsPlace(askedTown) : null;
  const unknownTown = askedTown && !near ? 'Такого міста в Schleswig-Holstein не знайдено — перевірте назву (можна німецькою, наприклад Trittau). Поки показую заходи по всій землі.\n\n' : '';
  const result = await fetchNordtickerEvents(transport, now);
  const sent = await telegram(config, 'sendMessage', {
    chat_id:chatId,
    text:result.status === 'ok' ? `${unknownTown}${eventsReplyText(result.events, now, near)}` : EVENTS_UNAVAILABLE_TEXT,
    ...(result.status === 'ok' ? { parse_mode:'HTML' } : {}),
    link_preview_options:{ is_disabled:true },
    reply_markup:eventsKeyboard(near)
  }, transport);
  // The next bare town typed after this list asks for events there too.
  await (sent ? rememberPrivatePrompt(env, chatId, EVENTS_FOLLOWUP_PROMPT, now) : forgetPrivatePrompt(env, chatId, now)).catch(() => null);
  return json({ ok:true, mode:'events-v1', delivered:sent, source:result.status });
}
