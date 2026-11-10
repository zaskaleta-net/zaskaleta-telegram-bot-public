// "🤝 Консультації": the menu button (nav:advice), a Kreis button (adv:<key>)
// and "/beratung [Ort]" in a private chat.
import { pilotConfig, equalSecret, readBoundedJSON } from './pilot-security.mjs';
import { beratungPlace, beratungBarePlace, fetchBeratung, beratungReplyText, beratungKeyboard, BERATUNG_CHOOSE_TEXT, BERATUNG_UNAVAILABLE_TEXT, BERATUNG_TOWN_PROMPT, BERATUNG_FOLLOWUP_PROMPT, SH_KREISE } from './beratung-bamf.mjs';
import { rememberPrivatePrompt, forgetPrivatePrompt } from './runtime-keyboard.mjs';

const STATELESS_PATH = '/telegram/stateless';
export const BERATUNG_BUTTON_TEXT = '🤝 Консультації';
const BERATUNG_TEXT = /^(?:\/beratung(?:@ZaskaletaInfoBot)?|🤝\s*Консультації)(?:\s+(\S[^\n]{0,59}))?\s*$/iu;
const KREIS_CALLBACK = /^adv:(01\d{3})$/u;
const ASK_CALLBACK = 'adv:ask';

function promptedTown(message) {
  const text = String(message?.text || '').trim();
  if (!text || text.startsWith('/') || text.length > 60) return null;
  const prompt = message?.reply_to_message?.text;
  if (prompt === BERATUNG_TOWN_PROMPT) return text;
  // After a counselling list only a bare town or Kreis name continues it.
  return prompt === BERATUNG_FOLLOWUP_PROMPT && beratungBarePlace(text) ? text : null;
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

export function isBeratungRequestUpdate(update) {
  const query = update?.callback_query;
  if (query) return (query.data === 'nav:advice' || query.data === ASK_CALLBACK || KREIS_CALLBACK.test(String(query.data || ''))) && query.message?.chat?.type === 'private';
  return update?.message?.chat?.type === 'private' && (BERATUNG_TEXT.test(String(update?.message?.text || '').trim()) || Boolean(promptedTown(update?.message)));
}

export async function beratungCommand(request, env, now = Date.now(), transport = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error || !isBeratungRequestUpdate(parsed.value)) return null;
  const update = parsed.value;
  const query = update.callback_query;
  const chatId = Number(query ? query.message?.chat?.id : update.message?.chat?.id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0 || (query ? query.from?.is_bot : update.message?.from?.is_bot) === true) return json({ ok:true, ignored:true });
  if (query?.id) await telegram(config, 'answerCallbackQuery', { callback_query_id:query.id }, transport);
  if (query?.data === ASK_CALLBACK) {
    const asked = await telegram(config, 'sendMessage', { chat_id:chatId, text:BERATUNG_TOWN_PROMPT }, transport);
    if (asked) await rememberPrivatePrompt(env, chatId, BERATUNG_TOWN_PROMPT, now).catch(() => null);
    return json({ ok:true, mode:'beratung-v1', delivered:asked, source:'ask_town' });
  }
  const kreisKey = query ? KREIS_CALLBACK.exec(String(query.data || ''))?.[1] : null;
  const asked = query ? null : (promptedTown(update.message) || BERATUNG_TEXT.exec(String(update.message?.text || '').trim())?.[1]);
  const kreis = kreisKey ? SH_KREISE.find(([key]) => key === kreisKey) : null;
  const place = kreis ? { kreis:kreis[0], kreisName:kreis[1], town:null } : (asked ? beratungPlace(asked) : null);

  let text;
  let markup;
  let source = 'choose';
  if (!place) {
    text = `${asked ? 'Такого міста чи району в Schleswig-Holstein не знайдено — перевірте назву (можна німецькою, наприклад Trittau).\n\n' : ''}${BERATUNG_CHOOSE_TEXT}`;
    markup = beratungKeyboard();
  } else {
    const result = await fetchBeratung(place.kreis, transport, now);
    source = result.status;
    text = result.status === 'ok' ? beratungReplyText(result.entries, place) : BERATUNG_UNAVAILABLE_TEXT;
    markup = beratungKeyboard(place);
  }
  const sent = await telegram(config, 'sendMessage', {
    chat_id:chatId,
    text,
    ...(source === 'unavailable' ? {} : { parse_mode:'HTML' }),
    link_preview_options:{ is_disabled:true },
    reply_markup:markup
  }, transport);
  // The next bare town typed after this answer asks for counselling there too.
  await (sent ? rememberPrivatePrompt(env, chatId, BERATUNG_FOLLOWUP_PROMPT, now) : forgetPrivatePrompt(env, chatId, now)).catch(() => null);
  return json({ ok:true, mode:'beratung-v1', delivered:sent, source });
}
