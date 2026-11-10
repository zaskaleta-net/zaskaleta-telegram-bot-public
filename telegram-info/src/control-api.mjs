const CONTROL_HEALTH_PATH = '/control/health';
const CONTROL_HEADER = 'x-telegram-control-key';

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders
    }
  });
}

function equalControlSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }

  if (left.length === 0 || left.length !== right.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return difference === 0;
}

function isEnabled(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function isConfigured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function handleControlRequest(request, env = {}) {
  const url = new URL(request.url);

  if (url.pathname !== CONTROL_HEALTH_PATH) {
    return null;
  }

  if (request.method !== 'GET') {
    return json(
      {
        ok: false,
        error: 'Method Not Allowed'
      },
      405,
      {
        allow: 'GET'
      }
    );
  }

  const expectedSecret = env.TELEGRAM_CONTROL_KEY;

  if (!isConfigured(expectedSecret)) {
    return json(
      {
        ok: false,
        error: 'Control API unavailable'
      },
      503
    );
  }

  const suppliedSecret = request.headers.get(CONTROL_HEADER);

  if (!equalControlSecret(suppliedSecret, expectedSecret)) {
    return json(
      {
        ok: false,
        error: 'Unauthorized'
      },
      401
    );
  }

  return json({
    ok: true,
    service: 'zaskaleta-info-telegram-staging',
    status: 'healthy',
    environment: 'staging',
    maintenanceEnabled: isEnabled(env.TELEGRAM_MAINTENANCE_MODE),
    ingressEnabled: isEnabled(env.TELEGRAM_INGRESS_ENABLED),
    deliveryEnabled: isEnabled(env.TELEGRAM_DELIVERY_ENABLED),
    pilotMode: isConfigured(env.TELEGRAM_PILOT_MODE)
      ? env.TELEGRAM_PILOT_MODE
      : null,
    releaseApproved: isConfigured(env.TELEGRAM_RELEASE_APPROVED),
    telegramBotTokenConfigured: isConfigured(env.TELEGRAM_BOT_TOKEN),
    telegramWebhookSecretConfigured: isConfigured(
      env.TELEGRAM_WEBHOOK_SECRET
    ),
    timestamp: new Date().toISOString()
  });
}
