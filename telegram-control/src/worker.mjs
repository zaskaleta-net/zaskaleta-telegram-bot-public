const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function authorized(request, env) {
  const expected = String(env.CONTROL_AUTH_TOKEN || '');
  const supplied = request.headers.get('authorization') || '';
  return expected.length >= 32 && supplied === `Bearer ${expected}`;
}

async function telegramWebhookStatus(env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '');
  if (!token) return { configured: false };
  const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    return { configured: true, ok: false, httpStatus: response.status };
  }
  const r = payload.result || {};
  return {
    configured: true,
    ok: true,
    url: r.url || '',
    hasCustomCertificate: Boolean(r.has_custom_certificate),
    pendingUpdateCount: Number(r.pending_update_count || 0),
    lastErrorDate: Number(r.last_error_date || 0) || null,
    lastErrorMessage: r.last_error_message || null,
    maxConnections: Number(r.max_connections || 0) || null,
    allowedUpdates: Array.isArray(r.allowed_updates) ? r.allowed_updates : null,
  };
}

async function workerHealth(env) {
  const target = String(env.TELEGRAM_WORKER_URL || '').replace(/\/$/, '');
  if (!target.startsWith('https://')) return { configured: false };
  const response = await fetch(`${target}/health`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
  return { configured: true, status: response.status, ok: response.ok, body };
}

const TOOLS = [
  {
    name: 'telegram_worker_health',
    description: 'Read the public health endpoint of the configured Telegram Worker.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'telegram_webhook_status',
    description: 'Read Telegram getWebhookInfo without exposing the bot token.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function callTool(name, env) {
  if (name === 'telegram_worker_health') return workerHealth(env);
  if (name === 'telegram_webhook_status') return telegramWebhookStatus(env);
  throw new Error('Unknown tool');
}

async function mcp(request, env) {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  let message;
  try { message = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const id = message?.id ?? null;
  if (message?.method === 'initialize') {
    return json({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'zaskaleta-cloudflare-control', version: '0.1.0' } } });
  }
  if (message?.method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (message?.method === 'tools/call') {
    try {
      const result = await callTool(message?.params?.name, env);
      return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    } catch (error) {
      return json({ jsonrpc: '2.0', id, error: { code: -32000, message: String(error?.message || 'tool_failed') } });
    }
  }
  if (message?.method === 'notifications/initialized') return new Response(null, { status: 202 });
  return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'healthy', service: 'zaskaleta-cloudflare-control', mode: 'read-only' });
    }
    if (request.method === 'POST' && url.pathname === '/mcp') return mcp(request, env);
    return json({ error: 'not_found' }, 404);
  },
};
