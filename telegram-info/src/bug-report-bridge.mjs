import { signBugBridgeBody } from './bug-bridge-auth.mjs';

const BUG_INGEST_URL = 'https://rrewwgvmwannnekbqkvw.supabase.co/functions/v1/tg-bug-7f3c91-ingest';
const BOT_USERNAME = 'ZaskaletaInfoBot';
const REPORT_ID_RE = /^R-\d{8}-\d{1,20}$/u;
const MAX_RAW_MEDIA_BYTES = 1_500_000;
const TELEGRAM_TIMEOUT_MS = 8000;
const BRIDGE_TIMEOUT_MS = 8000;
const BRIDGE_ATTEMPTS = 2;

function cleanText(value, max = 1200) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function buildPilotReportId(update, now = Date.now()) {
  const raw = positiveInteger(update?.update_id) || positiveInteger(update?.message?.message_id);
  if (!raw || !Number.isFinite(now) || now < 0) return null;
  const date = new Date(now).toISOString().slice(0, 10).replaceAll('-', '');
  return `R-${date}-${raw}`;
}

function selectTelegramMedia(message) {
  if (Array.isArray(message?.photo) && message.photo.length) {
    const candidates = message.photo
      .filter(item => typeof item?.file_id === 'string' && item.file_id.length > 0)
      .filter(item => !Number.isFinite(Number(item.file_size)) || Number(item.file_size) <= MAX_RAW_MEDIA_BYTES)
      .sort((a, b) => (Number(a.file_size) || 0) - (Number(b.file_size) || 0));
    const chosen = candidates.at(-1);
    if (chosen) return { fileId:chosen.file_id, mediaKind:'photo', mediaMime:'image/jpeg' };
  }

  const document = message?.document;
  const mime = String(document?.mime_type || '').toLowerCase();
  if (
    typeof document?.file_id === 'string' && document.file_id.length > 0 &&
    ['image/jpeg','image/png','image/webp'].includes(mime) &&
    (!Number.isFinite(Number(document.file_size)) || Number(document.file_size) <= MAX_RAW_MEDIA_BYTES)
  ) {
    return { fileId:document.file_id, mediaKind:'image_document', mediaMime:mime };
  }
  return null;
}

async function fetchWithTimeout(transport, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await transport(url, { ...options, signal:controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readSmallJson(response, maxBytes = 32768) {
  try {
    const declared = Number(response?.headers?.get?.('content-length') || '0');
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    const text = await response.text();
    if (text.length > maxBytes) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function archiveTelegramMedia(config, media, transport) {
  if (!media || !config?.token) return null;
  try {
    const fileResponse = await fetchWithTimeout(
      transport,
      `https://api.telegram.org/bot${config.token}/getFile`,
      {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ file_id:media.fileId })
      },
      TELEGRAM_TIMEOUT_MS
    );
    const fileData = await readSmallJson(fileResponse);
    const filePath = typeof fileData?.result?.file_path === 'string' ? fileData.result.file_path : '';
    if (!fileResponse?.ok || fileData?.ok !== true || !filePath || filePath.includes('..') || filePath.startsWith('/')) return null;

    const mediaResponse = await fetchWithTimeout(
      transport,
      `https://api.telegram.org/file/bot${config.token}/${filePath}`,
      { method:'GET' },
      TELEGRAM_TIMEOUT_MS
    );
    if (!mediaResponse?.ok) return null;
    const declared = Number(mediaResponse.headers?.get?.('content-length') || '0');
    if (Number.isFinite(declared) && declared > MAX_RAW_MEDIA_BYTES) return null;
    const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
    if (!bytes.length || bytes.byteLength > MAX_RAW_MEDIA_BYTES) return null;

    return {
      media_kind:media.mediaKind,
      media_mime:media.mediaMime,
      media_base64:bytesToBase64(bytes)
    };
  } catch {
    return null;
  }
}

async function ingestReport(payload, reportId, config, now, transport) {
  try {
    const body = JSON.stringify(payload);
    const headers = { 'content-type':'application/json' };
    if (config?.bugBridgeHmacSecret) {
      const signed = await signBugBridgeBody(config.bugBridgeHmacSecret, body, now);
      if (!signed) return { queued:false, reason:'ingest_unavailable', status:null, caseId:reportId, groupFirst:true };
      headers['x-zaskaleta-timestamp'] = signed.timestamp;
      headers['x-zaskaleta-signature'] = signed.signature;
    } else {
      headers['x-zaskaleta-bridge'] = 'telegram-bug-v1';
    }

    const response = await fetchWithTimeout(
      transport,
      BUG_INGEST_URL,
      {
        method:'POST',
        headers,
        body,
        redirect:'follow'
      },
      BRIDGE_TIMEOUT_MS
    );
    const data = await readSmallJson(response);
    const queued = response?.ok === true && data?.ok === true && data?.queued === true && data?.report_id === reportId;
    const candidateCaseId = typeof data?.case_id === 'string' ? data.case_id : '';
    return {
      queued,
      reason:queued ? 'queued' : 'ingest_rejected',
      status:Number.isInteger(response?.status) ? response.status : null,
      caseId:queued && REPORT_ID_RE.test(candidateCaseId) ? candidateCaseId : reportId,
      groupFirst:queued && typeof data?.group_first === 'boolean' ? data.group_first : true
    };
  } catch {
    return { queued:false, reason:'ingest_unavailable', status:null, caseId:reportId, groupFirst:true };
  }
}

export async function archivePilotBugReport(update, config, now = Date.now(), transport = fetch) {
  const message = update?.message;
  const reportId = buildPilotReportId(update, now);
  if (!message || message.chat?.type !== 'private' || !reportId) {
    return { queued:false, reportId, caseId:reportId, groupFirst:true, mediaArchived:false, reason:'invalid_report', attempts:0, status:null };
  }

  const description = cleanText(message.caption || message.text, 1200) || null;
  const media = selectTelegramMedia(message);
  const archivedMedia = media ? await archiveTelegramMedia(config, media, transport) : null;
  const mediaGroupId = typeof message.media_group_id === 'string'
    ? cleanText(message.media_group_id, 100) || null
    : null;

  const payload = {
    report_id:reportId,
    description,
    ...(archivedMedia || {}),
    metadata:{
      bot:BOT_USERNAME,
      chat_type:'private',
      has_media:!!media,
      message_id:positiveInteger(message.message_id),
      update_id:positiveInteger(update?.update_id),
      ...(mediaGroupId ? { media_group_id:mediaGroupId } : {})
    }
  };

  let result = { queued:false, reason:'ingest_unavailable', status:null, caseId:reportId, groupFirst:true };
  let attempts = 0;
  for (let attempt = 1; attempt <= BRIDGE_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    result = await ingestReport(payload, reportId, config, now, transport);
    if (result.queued || result.reason !== 'ingest_unavailable') break;
  }

  return {
    queued:result.queued,
    reportId,
    caseId:result.caseId,
    groupFirst:result.groupFirst,
    mediaArchived:!!archivedMedia,
    reason:result.reason,
    attempts,
    status:result.status
  };
}
