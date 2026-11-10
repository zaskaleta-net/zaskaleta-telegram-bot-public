const EVENT_NAME_RE = /^[a-z][a-z0-9 _-]{2,80}$/;
const TOKEN_RE = /^[A-Za-z0-9._-]{8,256}$/;
const STATIC_DISTINCT_ID = 'zaskaleta-telegram-worker';
const DEFAULT_TIMEOUT_MS = 1800;

const SAFE_PROPERTY_KEYS = new Set([
  'update_type',
  'feature',
  'outcome',
  'http_status',
  'duration_ms',
  'worker_version',
  'release',
  'source',
]);

function boundedString(value, max = 80) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) return null;
  return /^[A-Za-z0-9 ._:/-]+$/.test(text) ? text : null;
}

function safeInteger(value, min = 0, max = 1_000_000) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

export function posthogTelemetryConfig(env = {}) {
  if (env?.POSTHOG_ENABLED !== 'true') return null;
  const apiKey = String(env?.POSTHOG_PROJECT_TOKEN || '').trim();
  const rawHost = String(env?.POSTHOG_HOST || '').trim();
  if (!TOKEN_RE.test(apiKey) || !rawHost) return null;

  let host;
  try { host = new URL(rawHost); } catch { return null; }
  if (
    host.protocol !== 'https:' ||
    host.username ||
    host.password ||
    host.search ||
    host.hash ||
    (host.pathname !== '/' && host.pathname !== '')
  ) return null;

  return {
    apiKey,
    endpoint:new URL('/i/v0/e/', host).toString(),
  };
}

export function sanitizePosthogProperties(properties = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(properties || {})) {
    if (!SAFE_PROPERTY_KEYS.has(key)) continue;

    if (key === 'http_status') {
      const parsed = safeInteger(value, 100, 599);
      if (parsed !== null) safe[key] = parsed;
      continue;
    }
    if (key === 'duration_ms') {
      const parsed = safeInteger(value, 0, 300_000);
      if (parsed !== null) safe[key] = parsed;
      continue;
    }

    const parsed = boundedString(value, key === 'worker_version' ? 80 : 64);
    if (parsed !== null) safe[key] = parsed;
  }
  return safe;
}

export function classifyTelegramTelemetry(update = {}) {
  if (update?.callback_query) {
    const data = String(update.callback_query.data || '');
    if (/^nav:(menu|housing|jobcenter|work|courses|school|transport|documents|kindergeld|news|events|report)$/u.test(data)) {
      return {
        update_type:'callback',
        feature:data.slice(4),
        source:'inline_navigation',
      };
    }
    if (/^ev:t:/u.test(data)) return { update_type:'callback', feature:'events', source:'inline_action' };
    if (data === 'nav:advice' || /^adv:/u.test(data)) return { update_type:'callback', feature:'advice', source:'inline_action' };
    if (/^(?:hka:|jcr:|jcd:|jcp:|jcn:)/u.test(data)) {
      return {
        update_type:'callback',
        feature:'housing_jobcenter',
        source:'inline_action',
      };
    }
    return {
      update_type:'callback',
      feature:'other',
      source:'inline_action',
    };
  }

  const text = String(update?.message?.text || '').trim();
  if (update?.message) {
    if (/^\/(?:start|menu)(?:@ZaskaletaInfoBot)?(?:\s|$)/iu.test(text)) {
      return { update_type:'message', feature:'menu', source:'command' };
    }
    if (/^(?:\/events(?:@ZaskaletaInfoBot)?|🎉\s*Куди піти)(?:\s+\S[^\n]{0,59})?\s*$/iu.test(text)) {
      return { update_type:'message', feature:'events', source:'command' };
    }
    if (/^(?:\/beratung(?:@ZaskaletaInfoBot)?|🤝\s*Консультації)(?:\s+\S[^\n]{0,59})?\s*$/iu.test(text)) {
      return { update_type:'message', feature:'advice', source:'command' };
    }
    if (/^(?:🏠 Житло|🏛 Jobcenter|💼 Робота|🎓 Курси|👨‍👩‍👧 Школа \/ Kita|🚌 Транспорт|📄 Документи|👶 Kindergeld|🗞 Новини|🐞 Повідомити про помилку)$/u.test(text)) {
      const feature = text.includes('Житло') ? 'housing'
        : text.includes('Jobcenter') ? 'jobcenter'
        : text.includes('Робота') ? 'work'
        : text.includes('Курси') ? 'courses'
        : text.includes('Школа') ? 'school'
        : text.includes('Транспорт') ? 'transport'
        : text.includes('Документи') ? 'documents'
        : text.includes('Kindergeld') ? 'kindergeld'
        : text.includes('Новини') ? 'news'
        : 'report';
      return { update_type:'message', feature, source:'menu_text' };
    }
    return {
      update_type:'message',
      feature:'free_text',
      source:'user_input',
    };
  }

  return {
    update_type:'other',
    feature:'other',
    source:'telegram',
  };
}

export function buildPosthogEvent(env, event, properties = {}) {
  const config = posthogTelemetryConfig(env);
  if (!config || !EVENT_NAME_RE.test(String(event || ''))) return null;

  return {
    endpoint:config.endpoint,
    payload:{
      api_key:config.apiKey,
      event:String(event),
      distinct_id:STATIC_DISTINCT_ID,
      properties:{
        '$process_person_profile':false,
        service:'zaskaleta-telegram',
        ...sanitizePosthogProperties(properties),
      },
    },
  };
}

export async function capturePosthogEvent(env, event, properties = {}, transport = fetch) {
  const built = buildPosthogEvent(env, event, properties);
  if (!built) return { status:'disabled' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await transport(built.endpoint, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(built.payload),
      signal:controller.signal,
    });
    return { status:response.ok ? 'sent' : 'rejected', httpStatus:response.status };
  } catch {
    return { status:'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}
