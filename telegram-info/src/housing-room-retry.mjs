// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { readBoundedJSON } from './pilot-security.mjs';
const STATELESS_PATH = '/telegram/stateless';
const ROOM_RETRY = /^Для житла\s*[—–-]\s*([^\n]{1,80}?)\s+вкажіть кількість кімнат(?:\s|$)/iu;
const ROOM_VALUE = /^\s*\d{1,2}(?:\s*[-–—/]\s*\d{1,2})?\s*$/u;

export async function normalizeHousingRoomRetryRequest(request) {
  const url = new URL(request.url);
  if (url.pathname !== STATELESS_PATH || request.method !== 'POST') return request;

  const parsed = await readBoundedJSON(request.clone(), 65536);
  if (parsed.error) return request;

  const update = parsed.value;
  const message = update?.message;
  if (message?.chat?.type !== 'private' || !ROOM_VALUE.test(String(message?.text || ''))) return request;

  const previous = String(message?.reply_to_message?.text || '').trim();
  const match = ROOM_RETRY.exec(previous);
  if (!match) return request;

  const location = String(match[1] || '').replace(/\s+/gu, ' ').trim();
  if (!location) return request;

  const copy = JSON.parse(JSON.stringify(update));
  copy.message.reply_to_message.text = `Тема: житло — ${location}. Локацію вже визначено.\nВкажіть кількість кімнат, наприклад: 3 або 3-4.`;

  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, {
    method:'POST',
    headers,
    body:JSON.stringify(copy)
  });
}
