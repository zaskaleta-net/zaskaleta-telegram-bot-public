import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMaintenanceStorage } from '../src/runtime-maintenance.mjs';
import { fixture, GROUP } from './runtime-fixture.mjs';

const CHAT = -1001;
const MARKER = `maintenance-announcement:v1:${CHAT}`;
const NOW = Date.UTC(2026, 9, 11, 6, 0);

function maintenanceOutbox() {
  const values = new Map();
  return {
    values,
    env:{ TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_BOT_TOKEN:`12345:${'A'.repeat(32)}`, TELEGRAM_WEBHOOK_SECRET:'s'.repeat(32), TELEGRAM_ALLOWED_CHAT_IDS:String(CHAT), TELEGRAM_MAINTENANCE_MODE:'true' },
    householdContextStorage:{ async get(k) { return structuredClone(values.get(k)); }, async put(k, v) { values.set(k, structuredClone(v)); }, async delete(k) { return values.delete(k); } }
  };
}

const announce = (outbox, now) => handleMaintenanceStorage(new Request('https://outbox.internal/maintenance-announcement-v1', { method:'POST', body:JSON.stringify({ now }) }), outbox).then(r => r.json());

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

const telegramOk = () => new Response(JSON.stringify({ ok:true, result:{ message_id:1 } }), { status:200 });

test('TG-RUNTIME-010 an ambiguous announcement send is kept uncertain and never posted twice', async () => {
  for (const ambiguous of [
    async () => { throw new DOMException('aborted', 'AbortError'); },
    async () => new Response('<html>bad gateway</html>', { status:502 }),
    async () => new Response(JSON.stringify({ ok:false, error_code:500 }), { status:500 })
  ]) {
    const outbox = maintenanceOutbox();
    let sends = 0;
    await withFetch(async (...args) => { sends += 1; return ambiguous(...args); }, () => announce(outbox, NOW));
    assert.equal(outbox.values.get(MARKER)?.state, 'uncertain');
    await withFetch(async () => { sends += 1; return telegramOk(); }, () => announce(outbox, NOW + 10 * 60 * 1000));
    assert.equal(sends, 1, 'the announcement is not re-sent after an ambiguous outcome');
  }
});

test('TG-RUNTIME-010 a stale in-flight announcement becomes uncertain instead of being re-sent', async () => {
  const outbox = maintenanceOutbox();
  outbox.values.set(MARKER, { state:'sending', startedAt:NOW - 10 * 60 * 1000 });
  let sends = 0;
  await withFetch(async () => { sends += 1; return telegramOk(); }, () => announce(outbox, NOW));
  assert.equal(sends, 0);
  assert.equal(outbox.values.get(MARKER)?.state, 'uncertain');
});

test('TG-RUNTIME-010 a 429 announcement honours retry_after and a definite 4xx is retried later', async () => {
  const outbox = maintenanceOutbox();
  let sends = 0;
  await withFetch(async () => { sends += 1; return new Response(JSON.stringify({ ok:false, error_code:429, parameters:{ retry_after:120 } }), { status:429 }); }, () => announce(outbox, NOW));
  await withFetch(async () => { sends += 1; return telegramOk(); }, () => announce(outbox, NOW + 30_000));
  assert.equal(sends, 1, 'no resend before retry_after');
  await withFetch(async () => { sends += 1; return telegramOk(); }, () => announce(outbox, NOW + 121_000));
  assert.equal(sends, 2);
  assert.equal(outbox.values.get(MARKER)?.state, 'sent');

  const rejected = maintenanceOutbox();
  await withFetch(async () => new Response(JSON.stringify({ ok:false, error_code:403 }), { status:403 }), () => announce(rejected, NOW));
  assert.equal(rejected.values.has(MARKER), false, 'a definite rejection leaves no marker');
});

test('TG-RUNTIME-010 turning maintenance off clears the announcement marker for the next window', async () => {
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'false' });
  try {
    const key = `maintenance-announcement:v1:${GROUP}`;
    await f.storage.put(key, { state:'sent', sentAt:NOW - 1000 });
    await f.object.fetch(new Request('https://outbox.internal/telegram-update-claim', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ op:'claim', updateId:1 }) }));
    assert.equal(await f.storage.get(key), undefined);
  } finally { f.close(); }
});
