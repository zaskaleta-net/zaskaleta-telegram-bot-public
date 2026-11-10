import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = process.cwd();
const config = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'));
const compatibilityDate = config.compatibility_date;
assert.match(compatibilityDate, /^\d{4}-\d{2}-\d{2}$/);
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const vars = {
  TELEGRAM_PILOT_MODE: 'allowlist', TELEGRAM_RELEASE_APPROVED: 'pilot-v1',
  TELEGRAM_ALLOWED_CHAT_IDS: '321', TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_INGRESS_ENABLED: 'true',
  TELEGRAM_DELIVERY_ENABLED: 'false', TEST_TRANSPORT_MODE: 'success'
};

async function collectLocalModules(entry) {
  const modules = new Map();
  const visit = async absolutePath => {
    const normalized = resolve(absolutePath);
    if (modules.has(normalized)) return;
    const localPath = relative(root, normalized);
    assert.ok(localPath && !localPath.startsWith('..'), `Module escapes test root: ${localPath}`);
    const contents = await readFile(normalized, 'utf8');
    modules.set(normalized, { type:'ESModule', path:normalized, contents });
    const pattern = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
    for (const match of contents.matchAll(pattern)) {
      const child = resolve(dirname(normalized), match[1]);
      await visit(child);
    }
  };
  await visit(resolve(root, entry));
  return [...modules.values()];
}

const modules = await collectLocalModules('test/local-runtime.fixture.mjs');
assert.ok(modules.length >= 10, 'Local runtime module graph is unexpectedly small');
const update = (id, text = '/start') => ({ update_id: id, message: { message_id: id + 1, date: Math.floor(Date.now() / 1000), chat: { id: 321, type: 'private' }, from: { id: 321, is_bot: false }, text } });
const body = value => JSON.stringify(value);
const directory = await mkdtemp(join(tmpdir(), 'zaskaleta-do-'));
let mf, scenario, checks = 0, unexpectedNetworkCalls = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(() => { checks++; console.log('PASS ' + name); }); }
async function start(name, options = {}) {
  if (mf) await mf.dispose();
  scenario = name;
  mf = create(options);
}
function create(options = {}) {
  const converted = convertV4MiniflareOptions({
    modules, modulesRoot: root,
    compatibilityDate,
    durableObjects: { OUTBOX: { className: 'TelegramOutbox', useSQLite: true } },
    outboundService: async () => {
      unexpectedNetworkCalls++;
      return new Response('External network disabled', { status: 503 });
    },
    bindings: { ...vars, ...options }
  });
  return new Miniflare({ ...converted, resourcePersistencePath: join(directory, scenario) });
}
async function internal(op, data = {}) {
  const ns = await mf.getDurableObjectNamespace('OUTBOX');
  const stub = ns.get(ns.idFromName('telegram-pilot-v1'));
  const res = await stub.fetch('https://test.internal/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body({ op, ...data }) });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}
async function webhook(value, secret = SECRET) {
  return mf.dispatchFetch('https://pilot.test/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: body(value) });
}
async function waitFor(id, state, timeout = 6000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await internal('state', { id });
    if (result.row?.state === state) return result;
    await sleep(50);
  }
  assert.fail(`Timed out waiting for update ${id} to become ${state}`);
}
try {
  await start('disabled', { TELEGRAM_INGRESS_ENABLED: 'false', TELEGRAM_RELEASE_APPROVED: '' });
  await check('disabled configuration rejects incoming messages', async () => {
    assert.equal((await webhook(update(1))).status, 503);
    assert.equal((await mf.dispatchFetch('https://pilot.test/health')).status, 200);
  });

  await start('dedup');
  await check('authenticated webhook and concurrent updates persist one SQLite row', async () => {
    assert.equal((await webhook(update(10), 'wrong')).status, 401);
    const results = await Promise.all(Array.from({ length: 12 }, () => webhook(update(10))));
    assert.ok(results.every(r => r.status === 200));
    assert.equal((await internal('count')).count, 1);
    const stored = await internal('state', { id: 10 });
    assert.equal(stored.row.state, 'queued');
    assert.ok(stored.alarm >= Date.now() + 3_000_000, 'Disabled delivery must schedule maintenance, not an immediate queued deadline');
    assert.equal((await internal('drain')).calls, 0);
  });

  await start('alarm', { TELEGRAM_DELIVERY_ENABLED: 'true' });
  await check('real bounded Durable Object alarm delivers once through synthetic transport', async () => {
    assert.equal((await webhook(update(20))).status, 200);
    const initial = await internal('state', { id: 20 });
    assert.ok(initial.alarm >= Date.now() + 50_000, 'Delivery alarm must not be immediate');
    const result = await waitFor(20, 'sent', 75_000);
    assert.equal(result.calls, 1);
    await internal('drain');
    assert.equal((await internal('state', { id: 20 })).calls, 1);
    assert.equal((await internal('count')).count, 1);
  });

  await start('restart');
  await check('restart preserves a durable claim and prevents ambiguous resend', async () => {
    assert.equal((await webhook(update(30))).status, 200);
    const claim = await internal('claim');
    assert.equal(claim.claim.id, 30);
    await mf.dispose(); mf = create();
    const result = await internal('state', { id: 30 });
    assert.equal(result.row.state, 'uncertain');
    assert.equal((await internal('drain')).calls, 0);
    assert.equal((await internal('count')).count, 1);
  });

  await start('erasure');
  await check('erasure cancels queued content and retains replay tombstone', async () => {
    assert.equal((await webhook(update(40))).status, 200);
    assert.equal((await internal('erase', { chatId: 321 })).erased, true);
    const row = (await internal('state', { id: 40 })).row;
    assert.equal(row.chat_id, 0);
    assert.equal(row.state, 'rejected');
    assert.equal((await webhook(update(40))).status, 200);
    assert.equal((await internal('count')).count, 1);
    assert.equal((await internal('drain')).calls, 0);
  });

  await start('timeout', { TELEGRAM_DELIVERY_ENABLED: 'true', TEST_TRANSPORT_MODE: 'timeout' });
  await check('synthetic network timeout is terminal and never automatically retried', async () => {
    assert.equal((await webhook(update(50))).status, 200);
    await internal('drain');
    const result = await waitFor(50, 'uncertain');
    assert.equal(result.calls, 1);
    await internal('drain');
    assert.equal((await internal('state', { id: 50 })).calls, 1);
  });

  assert.equal(unexpectedNetworkCalls, 0, 'Unexpected external network request');
  console.log(`Local workerd integration: ${checks} checks passed at ${compatibilityDate}; ${modules.length} local modules loaded; zero real Telegram requests.`);
} finally {
  if (mf) await mf.dispose();
  await rm(directory, { recursive: true, force: true });
}
