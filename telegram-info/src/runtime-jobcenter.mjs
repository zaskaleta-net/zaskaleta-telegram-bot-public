// Compatibility wrapper around the consolidated Jobcenter runtime.
// The 45s district TTL is an anti-duplicate acquisition lease, not the lifetime
// of the durable task that already owns that token.
// Base invariants remain active through the delegated implementation:
// JOBCENTER_SEARCH_STATE_PATH = '/jobcenter-search-state'
// filterUnseenDistrictListings(rawListings, districtBaseline)
// districtNoNewMessage(districtJurisdiction
export * from './runtime-jobcenter-base.mjs';
import { handleJobcenterSearchStorage as baseHandleJobcenterSearchStorage } from './runtime-jobcenter-base.mjs';

const JOBCENTER_SEARCH_STATE_PATH = '/jobcenter-search-state';
const JOBCENTER_DISTRICT_INFLIGHT_PREFIX = 'telegram-jobcenter-district-inflight:v1:';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

function validPrivateIdentity(chatId, userId) {
  return Number.isSafeInteger(chatId) && chatId > 0
    && Number.isSafeInteger(userId) && userId > 0
    && chatId === userId;
}

export async function handleJobcenterSearchStorage(request, outbox) {
  let url = null;
  try { url = new URL(request?.url || ''); } catch {}
  if (request?.method !== 'POST' || url?.pathname !== JOBCENTER_SEARCH_STATE_PATH) {
    return baseHandleJobcenterSearchStorage(request, outbox);
  }

  let value = null;
  try { value = await request.clone().json(); } catch {}
  if (value?.op !== 'district_check') {
    return baseHandleJobcenterSearchStorage(request, outbox);
  }

  // Let the reviewed base handler perform all request and identity validation.
  const baseResponse = await baseHandleJobcenterSearchStorage(request.clone(), outbox);
  if (!baseResponse?.ok) return baseResponse;
  let baseBody = null;
  try { baseBody = await baseResponse.clone().json(); } catch {}
  if (baseBody?.status !== 'ok') return baseResponse;

  const chatId = Number(value?.chatId);
  const userId = Number(value?.userId);
  const token = typeof value?.token === 'string' ? value.token.slice(0, 256) : '';
  if (!validPrivateIdentity(chatId, userId) || !token || !outbox?.householdContextStorage) {
    return baseResponse;
  }

  try {
    const current = await outbox.householdContextStorage.get(
      `${JOBCENTER_DISTRICT_INFLIGHT_PREFIX}${chatId}:${userId}`
    );
    if (!current || current.token !== token) return baseResponse;
    return json({
      status:'ok',
      owned:true,
      expiresAt:Number.isSafeInteger(current.expiresAt) ? current.expiresAt : null
    });
  } catch {
    return baseResponse;
  }
}
