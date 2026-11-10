import test from 'node:test';
import assert from 'node:assert/strict';
import { MANUAL_BUCKET_MS, normalizeManualPublishRequest, manualPublishMarkerKey } from '../src/admin-publish-v1.mjs';
import { handle } from '../src/worker-entry-pilot-v21.mjs';

const TOKEN = `123456:${'A'.repeat(36)}`;
const SECRET = 's'.repeat(40);
const GROUP_ID = -1001234567890;
const ADMIN_ID = 123456789;
const NOW = Date.UTC(2026, 8, 14, 11, 30, 0);

function env(overrides = {}) {
  let calls = 0;
  const outbox = {
    idFromName() { return 'pilot'; },
    get() {
      return {
        async fetch(_url, options) {
          calls += 1;
          const body = JSON.parse(options.body);
          assert.equal(body.publication.type, 'digest');
          assert.equal(body.publication.idempotencyKey, `digest:${Math.floor(NOW / MANUAL_BUCKET_MS)}`);
          return new Response(JSON.stringify({ status:'ok', sent:1, alreadySent:0, inFlight:0, failed:0 }), { status:200, headers:{ 'content-type':'application/json' } });
        }
      };
    }
  };
  return {
    value:{
      TELEGRAM_INGRESS_ENABLED:'true',
      TELEGRAM_PILOT_MODE:'allowlist',
      TELEGRAM_RELEASE_APPROVED:'pilot-v1',
      TELEGRAM_BOT_TOKEN:TOKEN,
      TELEGRAM_WEBHOOK_SECRET:SECRET,
      TELEGRAM_ALLOWED_CHAT_IDS:String(GROUP_ID),
      TELEGRAM_ADMIN_USER_IDS:String(ADMIN_ID),
      OUTBOX:outbox,
      ...overrides
    },
    calls:() => calls
  };
}

function request(userId = ADMIN_ID, secret = SECRET) {
  return new Request('https://worker.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':secret },
    body:JSON.stringify({
      update_id:1,
      message:{
        message_id:10,
        date:Math.floor(NOW / 1000),
        chat:{ id:userId, type:'private' },
        from:{ id:userId, is_bot:false },
        text:'/publishnow'
      }
    })
  });
}

test('manual publish helper creates a stable 15-minute digest idempotency key', () => {
  const first = normalizeManualPublishRequest({ type:'digest' }, NOW);
  const second = normalizeManualPublishRequest({ type:'digest' }, NOW + 1000);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(manualPublishMarkerKey(GROUP_ID, first.idempotencyKey), `telegram-manual-publish:v1:${GROUP_ID}:${first.idempotencyKey}`);
});

test('manual publish rejects malformed requests and invalid group ids', () => {
  assert.equal(normalizeManualPublishRequest({ type:'text' }, NOW), null);
  assert.equal(normalizeManualPublishRequest({ type:'digest', idempotency_key:'bad key' }, NOW), null);
  assert.equal(manualPublishMarkerKey(123, 'digest:12345678'), null);
});

test('admin /publishnow routes through the durable outbox without GitHub Actions', async () => {
  const e = env();
  const response = await handle(request(), e.value, NOW, async () => { throw new Error('network not expected'); });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'admin-publish-now-v1');
  assert.equal(body.sent, 1);
  assert.equal(e.calls(), 1);
});

test('non-admin /publishnow is ignored before durable publication', async () => {
  const e = env({ TELEGRAM_ADMIN_USER_IDS:String(ADMIN_ID) });
  const stranger = ADMIN_ID + 1;
  const transport = async url => {
    if (String(url).includes('/getChatAdministrators')) {
      return new Response(JSON.stringify({ ok:true, result:[] }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    throw new Error(`unexpected network ${url}`);
  };
  const response = await handle(request(stranger), e.value, NOW, transport);
  const body = await response.json();
  assert.equal(body.ignored, true);
  assert.equal(body.reason, 'admin_required');
  assert.equal(e.calls(), 0);
});
