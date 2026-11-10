// Cloudflare Workers Free allows 50 external subrequests per invocation. Once
// they are used up every further fetch fails instantly, including the Telegram
// calls that deliver the answer or the failure notice. Housing providers get a
// bounded share; Telegram calls and card images keep the rest for delivery.
import { safeLogText } from './log-safe.mjs';

export const DEFAULT_PROVIDER_SUBREQUEST_BUDGET = 32;

const BUDGET_ERROR = 'Provider subrequest budget exhausted';
const MAX_PROVIDER_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REUSABLE_BODY_BYTES = 1024 * 1024;

// True only for failures raised before the request left the Worker: the
// platform subrequest cap or this module's own budget. Such a request never
// reached Telegram, so it is safe to retry, unlike a timeout or a lost reply.
export function isSubrequestNotSentError(error) {
  const message = String(error?.message || '');
  return /too many subrequests/iu.test(message) || message === BUDGET_ERROR;
}

export function providerSubrequestBudget(env = {}) {
  const raw = String(env?.TELEGRAM_PROVIDER_SUBREQUEST_BUDGET || '').trim();
  const value = /^[0-9]{1,7}$/u.test(raw) ? Number(raw) : 0;
  return value > 0 ? value : DEFAULT_PROVIDER_SUBREQUEST_BUDGET;
}

function requestUrl(url) {
  return String(url?.url || url || '');
}

function acceptHeader(url, options) {
  const headers = options?.headers ?? url?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get('accept') || '');
  return String(headers.accept || headers.Accept || '');
}

function isDeliveryCall(url, options) {
  if (/^https:\/\/api\.telegram\.org\//u.test(requestUrl(url))) return true;
  return /^\s*image\//iu.test(acceptHeader(url, options));
}

function reusableKey(url, options) {
  const method = String(options?.method || url?.method || 'GET').toUpperCase();
  if (method !== 'GET' || options?.body != null) return '';
  return requestUrl(url);
}

// Reads at most one byte past the provider HTML cap, so an oversized page
// still looks oversized to the provider's own streaming check.
async function boundedBody(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return new ArrayBuffer(0);
  const chunks = [];
  let total = 0;
  while (total <= MAX_PROVIDER_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (total > MAX_PROVIDER_BODY_BYTES) await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

async function bufferedResponse(response) {
  return {
    url:String(response.url || ''),
    status:response.status,
    statusText:response.statusText,
    headers:[...response.headers],
    body:await boundedBody(response)
  };
}

function replayResponse(cached) {
  const response = new Response(cached.body.byteLength ? new Uint8Array(cached.body) : null, {
    status:cached.status,
    statusText:cached.statusText,
    headers:cached.headers
  });
  // Redirect host checks read response.url, which a constructed Response lacks.
  if (cached.url) Object.defineProperty(response, 'url', { value:cached.url });
  return response;
}

export function subrequestBudgetTransport(transport = fetch, env = {}, { budget = providerSubrequestBudget(env) } = {}) {
  let providerCalls = 0;
  let budgetLogged = false;
  let failureLogged = false;
  // Search phases re-request the same provider pages; within one invocation a
  // completed GET is replayed instead of spending another subrequest.
  const pages = new Map();
  const send = async (url, options) => {
    if (!isDeliveryCall(url, options)) {
      if (providerCalls >= budget) {
        if (!budgetLogged) {
          budgetLogged = true;
          console.error('telegram_provider_subrequest_budget_reached', { budget });
        }
        throw new TypeError(BUDGET_ERROR);
      }
      providerCalls += 1;
    }
    try {
      return await transport(url, options);
    } catch (error) {
      if (!failureLogged && error?.name !== 'AbortError') {
        failureLogged = true;
        console.error('telegram_subrequest_failed', {
          name:String(error?.name || 'Error'),
          message:safeLogText(error?.message || 'Subrequest failed')
        });
      }
      throw error;
    }
  };
  return async (url, options) => {
    const key = isDeliveryCall(url, options) ? '' : reusableKey(url, options);
    if (!key) return send(url, options);
    if (!pages.has(key)) {
      const pending = send(url, options).then(bufferedResponse);
      pages.set(key, pending);
      pending.catch(() => pages.delete(key));
    }
    const cached = await pages.get(key);
    // Keep the invocation's memory bounded: oversized pages are not retained.
    if (cached.body.byteLength > MAX_REUSABLE_BODY_BYTES) pages.delete(key);
    return replayResponse(cached);
  };
}
