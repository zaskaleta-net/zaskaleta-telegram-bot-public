import { pilotConfig } from './pilot-security.mjs';
import {
  JOBCENTER_BACKGROUND_TASK_HEADER,
  JOBCENTER_BACKGROUND_ACK_HEADER,
  JOBCENTER_BACKGROUND_PROGRESS_HEADER,
  JOBCENTER_BACKGROUND_LOCK_HEADER
} from './runtime-jobcenter.mjs';

const TASK_PREFIX = 'telegram-jobcenter-district-task:v1:';
const WORKER_MARKER_KEY = 'telegram-jobcenter-district-worker:v1';
const STATELESS_URL = 'https://worker.internal/telegram/stateless';
const MAX_BODY_BYTES = 65536;

function validUpdateId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function taskKey(updateId) {
  return `${TASK_PREFIX}${String(updateId).padStart(20, '0')}`;
}

function copiedHeader(request, name) {
  const value = String(request?.headers?.get(name) || '').trim();
  return value ? value.slice(0, 128) : '';
}

async function requestJSON(request) {
  const declared = Number(request?.headers?.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  try {
    const text = await request.clone().text();
    if (!text || new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return null;
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function storageFor(outbox) {
  const storage = outbox?.ctx?.storage;
  if (!storage || typeof storage.put !== 'function' || typeof storage.list !== 'function' || typeof storage.setAlarm !== 'function') return null;
  return storage;
}

function serializedTask(update, request, now) {
  return {
    update,
    createdAt: Number(now),
    callbackAcked: copiedHeader(request, JOBCENTER_BACKGROUND_ACK_HEADER) === '1',
    progressMessageId: copiedHeader(request, JOBCENTER_BACKGROUND_PROGRESS_HEADER),
    lockAcquired: copiedHeader(request, JOBCENTER_BACKGROUND_LOCK_HEADER) === '1'
  };
}

function taskHeaders(task, secret) {
  const headers = new Headers({
    'content-type':'application/json',
    'x-telegram-bot-api-secret-token':secret,
    [JOBCENTER_BACKGROUND_TASK_HEADER]:'1'
  });
  if (task?.callbackAcked === true) headers.set(JOBCENTER_BACKGROUND_ACK_HEADER, '1');
  if (/^[1-9][0-9]{0,19}$/u.test(String(task?.progressMessageId || ''))) {
    headers.set(JOBCENTER_BACKGROUND_PROGRESS_HEADER, String(task.progressMessageId));
  }
  if (task?.lockAcquired === true) headers.set(JOBCENTER_BACKGROUND_LOCK_HEADER, '1');
  return headers;
}

async function queuedEntries(storage) {
  const entries = await storage.list({ prefix:TASK_PREFIX });
  return [...entries.entries()].sort(([left], [right]) => left.localeCompare(right));
}

async function scheduleSoon(storage, now = Date.now()) {
  const target = Math.max(0, Number(now) || Date.now()) + 1;
  await storage.setAlarm(target);
  return target;
}

export async function queueDurableJobcenterBackgroundTask(request, outbox, { now = Date.now() } = {}) {
  const storage = storageFor(outbox);
  if (!storage) return { queued:false, reason:'storage_unavailable' };
  if (request?.headers?.get(JOBCENTER_BACKGROUND_TASK_HEADER) !== '1') return { queued:false, reason:'unprepared_task' };

  const update = await requestJSON(request);
  if (!validUpdateId(update?.update_id)) return { queued:false, reason:'invalid_update' };

  const key = taskKey(update.update_id);
  await storage.put(WORKER_MARKER_KEY, { active:true, updatedAt:Number(now) || Date.now() });
  await storage.put(key, serializedTask(update, request, now));
  const alarmAt = await scheduleSoon(storage, now);
  return { queued:true, key, alarmAt };
}

export async function isDurableJobcenterWorker(outbox) {
  const storage = storageFor(outbox);
  if (!storage) return false;
  if (typeof storage.get === 'function') {
    try {
      const marker = await storage.get(WORKER_MARKER_KEY);
      if (marker?.active === true) return true;
    } catch {}
  }
  try {
    const markers = await storage.list({ prefix:WORKER_MARKER_KEY });
    return markers.has(WORKER_MARKER_KEY);
  } catch {
    return false;
  }
}

export async function runQueuedDurableJobcenterBackgroundTask(outbox, { runTask, onReplay = null, now = Date.now() } = {}) {
  const storage = storageFor(outbox);
  if (!storage) return { handled:false, completed:false, reason:'storage_unavailable' };
  if (typeof runTask !== 'function') throw new TypeError('runTask must be a function');

  const entries = await queuedEntries(storage);
  if (!entries.length) return { handled:false, completed:false, reason:'empty' };

  const [key, task] = entries[0];
  const config = pilotConfig(outbox?.env || {});
  if (!config?.secret) throw new Error('Telegram runtime secret is unavailable');
  if (!validUpdateId(task?.update?.update_id)) {
    await storage.delete(key);
    if ((await queuedEntries(storage)).length) await scheduleSoon(storage, now);
    return { handled:true, completed:false, discarded:true, reason:'invalid_task' };
  }

  const taskRequest = new Request(STATELESS_URL, {
    method:'POST',
    headers:taskHeaders(task, config.secret),
    body:JSON.stringify(task.update)
  });

  // Alarms are at-least-once: a task that already started may have delivered
  // cards before the object was interrupted. Never re-run it; let the caller
  // send the bounded failure notice and release the search lock instead.
  if (Number.isFinite(task?.startedAt)) {
    const response = typeof onReplay === 'function' ? await onReplay(taskRequest) : null;
    await storage.delete(key);
    if ((await queuedEntries(storage)).length) await scheduleSoon(storage, now);
    return { handled:true, completed:false, replayed:true, response };
  }
  await storage.put(key, { ...task, startedAt:Number(now) || Date.now() });

  const response = await runTask(taskRequest);
  await storage.delete(key);
  if ((await queuedEntries(storage)).length) await scheduleSoon(storage, now);
  return { handled:true, completed:true, response };
}

export const durableJobcenterTaskStorage = Object.freeze({
  taskPrefix:TASK_PREFIX,
  workerMarkerKey:WORKER_MARKER_KEY
});
