// TG-RUNTIME-066: /privacy, /datenschutz and /impressum in a private chat, and
// the Impressum page GET /impressum. They are answered before the maintenance
// gate, as /forget is, so legal information and deletion never depend on the
// bot's operating state.
import { pilotConfig, equalSecret, readBoundedJSON } from './pilot-security.mjs';
import { PRIVACY_CONTROLLER, impressumPublished, privacyCommandText } from './privacy-policy.mjs';

export { impressumPublished };

const STATELESS_PATH = '/telegram/stateless';
export const IMPRESSUM_PATH = '/impressum';
export const IMPRESSUM_URL = 'https://bot.zaskaleta.net/impressum';
const COMMAND = /^\/(privacy|datenschutz|impressum)(?:@ZaskaletaInfoBot)?\s*$/iu;

function escapeHtml(value) {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

export function impressumCommandText(controller = PRIVACY_CONTROLLER) {
  if (!impressumPublished(controller)) {
    return '🏛 Impressum (вихідні дані)\n\nImpressum ще готується і буде опублікований до офіційного запуску.\n\nКонфіденційність: /privacy';
  }
  return [
    '🏛 Impressum (вихідні дані)',
    '',
    controller.name,
    controller.address,
    `E-Mail: ${controller.email}`,
    controller.contact,
    '',
    'Сервіс не є державним органом.',
    '',
    `Повний Impressum: ${IMPRESSUM_URL}`,
    'Конфіденційність: /privacy'
  ].join('\n');
}

export function impressumHtml(controller = PRIVACY_CONTROLLER) {
  const name = escapeHtml(controller.name);
  const address = escapeHtml(controller.address);
  const email = escapeHtml(controller.email);
  const contact = escapeHtml(controller.contact);
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Impressum – @ZaskaletaInfoBot</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#5a5a5a;--link:#0b57d0}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--muted:#a8a8a8;--link:#8ab4f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:46rem;margin:0 auto;padding:24px 16px 48px}
a{color:var(--link)}.meta{color:var(--muted)}
</style>
</head>
<body>
<main>
<h1>Impressum</h1>
<p class="meta">Telegram-Bot @ZaskaletaInfoBot („Schleswig-Holstein Помічник“)</p>
<h2>Angaben zum Anbieter</h2>
<p>${name}<br>${address}</p>
<h2>Kontakt</h2>
<p>E-Mail: <a href="mailto:${email}">${email}</a><br>${contact}</p>
<h2>Verantwortlich für den Inhalt</h2>
<p>${name}<br>${address}</p>
<h2>Hinweis</h2>
<p>Der Bot ist ein unabhängiger Informationsdienst und keine Behörde. Seine Auskünfte sind keine Rechtsberatung und ersetzen keine Entscheidung des Jobcenters oder einer anderen Stelle.</p>
<p><a href="/datenschutz">Datenschutzerklärung</a></p>
</main>
</body>
</html>`;
}

// GET /impressum. null for every other request and while the controller still
// holds placeholders, so the normal 404 handling stays unchanged.
export function handleImpressumRequest(request, controller = PRIVACY_CONTROLLER) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (url.pathname !== IMPRESSUM_PATH && url.pathname !== `${IMPRESSUM_PATH}/`) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (!impressumPublished(controller)) return null;
  return new Response(request.method === 'HEAD' ? null : impressumHtml(controller), {
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

export async function legalCommand(request, env, now, transport = fetch, controller = PRIVACY_CONTROLLER) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST' || env?.TELEGRAM_INGRESS_ENABLED !== 'true') return null;
  const config = pilotConfig(env);
  if (!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.secret)) return null;
  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return null;
  const message = parsed.value?.message;
  const command = COMMAND.exec(String(message?.text || '').trim())?.[1]?.toLowerCase();
  if (!command) return null;
  const chatId = Number(message?.chat?.id);
  // Groups keep the existing handling (worker.mjs).
  if (message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId) || chatId <= 0 || message?.from?.is_bot === true) return null;
  const text = command === 'impressum' ? impressumCommandText(controller) : privacyCommandText(controller);
  try {
    await transport(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ chat_id:chatId, text, link_preview_options:{ is_disabled:true } })
    });
  } catch {}
  return json({ ok:true, mode:`legal-${command}` });
}
