import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import { AUDIT_PATH, auditHeaders, verifyAudit, readQueueSnapshot, validateQueueSnapshot, handleQueueAudit } from '../src/queue-audit.mjs';
import { handle } from '../src/worker.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const SECRET = 'B'.repeat(40);
const TOKEN = '123456789:' + 'A'.repeat(35);
const NOW = 1700000000000;
const base = 'https://pilot.example';
const env = () => ({ TELEGRAM_RELEASE_APPROVED: 'pilot-v1', TELEGRAM_PILOT_MODE: 'allowlist', TELEGRAM_ALLOWED_CHAT_IDS: '321', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_INGRESS_ENABLED: 'true', TELEGRAM_DELIVERY_ENABLED: 'false' });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const snapshot = { schema: 'queue-audit-v1', asOf: NOW, total: 1, queued: 1, sending: 0, sent: 0, uncertain: 0, rejected: 0, expiredQueued: 0, oldestQueuedAt: NOW, lastRecordedAt: NOW };
const signed = async (secret = SECRET, now = NOW) => new Request(base + AUDIT_PATH, { method: 'POST', headers: await auditHeaders(secret, now) });

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE telegram_outbox (update_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, reply TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL, due_at INTEGER NOT NULL, claimed_at INTEGER, claim_token TEXT, telegram_message_id INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER)`);
  const storage = { sql: { exec(sql, ...params) { return { toArray: () => db.prepare(sql).all(...params) }; } } };
  return { db, storage };
}

test('audit HMAC is scoped to method, path and a short time window', async () => {
  const r = await signed();
  assert.equal(await verifyAudit(r, SECRET, NOW), true);
  assert.equal(await verifyAudit(r, SECRET, NOW + 60001), false);
  assert.equal(await verifyAudit(r, 'C'.repeat(40), NOW), false);
  assert.equal(await verifyAudit(new Request(base + '/other', { method: 'POST', headers: r.headers }), SECRET, NOW), false);
  assert.equal(await verifyAudit(new Request(base + AUDIT_PATH, { method: 'GET', headers: r.headers }), SECRET, NOW), false);
  const bad = new Headers(r.headers); bad.set('x-telegram-audit-signature', '0'.repeat(64));
  assert.equal(await verifyAudit(new Request(base + AUDIT_PATH, { method: 'POST', headers: bad }), SECRET, NOW), false);
  bad.set('x-telegram-audit-time', 'not-a-time');
  assert.equal(await verifyAudit(new Request(base + AUDIT_PATH, { method: 'POST', headers: bad }), SECRET, NOW), false);
  await assert.rejects(auditHeaders('short', NOW), /Invalid audit configuration/);
});

test('SQLite snapshot is aggregate-only and does not mutate records', () => {
  const { db, storage } = database();
  const secretText = 'PRIVATE_REPLY_MUST_NOT_LEAK';
  const insert = db.prepare('INSERT INTO telegram_outbox(update_id,chat_id,message_id,reply,state,attempts,due_at,created_at) VALUES(?,?,?,?,?,0,?,?)');
  insert.run(1,321,2,secretText,'queued',NOW,NOW);
  insert.run(2,321,3,'old','queued',NOW-86400001,NOW-86400001);
  insert.run(3,321,4,null,'sending',NOW,NOW);
  insert.run(4,321,5,null,'sent',NOW,NOW);
  insert.run(5,321,6,null,'uncertain',NOW,NOW);
  insert.run(6,321,7,null,'rejected',NOW,NOW);
  insert.run(7,999,8,'FOREIGN_PRIVATE_TEXT','queued',NOW,NOW);
  const before = db.prepare('SELECT * FROM telegram_outbox ORDER BY update_id').all();
  const result = readQueueSnapshot(storage,321,NOW);
  assert.deepEqual(result,{schema:'queue-audit-v1',asOf:NOW,total:6,queued:2,sending:1,sent:1,uncertain:1,rejected:1,expiredQueued:1,oldestQueuedAt:NOW-86400001,lastRecordedAt:NOW});
  assert.equal(validateQueueSnapshot(result),true);
  assert.deepEqual(db.prepare('SELECT * FROM telegram_outbox ORDER BY update_id').all(),before);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_REPLY_MUST_NOT_LEAK|FOREIGN_PRIVATE_TEXT/);
  assert.deepEqual(Object.keys(result).sort(),['schema','asOf','total','queued','sending','sent','uncertain','rejected','expiredQueued','oldestQueuedAt','lastRecordedAt'].sort());
  db.close();
});

test('empty database, signed group scope, invalid scope and unavailable storage fail safely', () => {
  const { db,storage }=database();
  assert.deepEqual(readQueueSnapshot(storage,321,NOW),{schema:'queue-audit-v1',asOf:NOW,total:0,queued:0,sending:0,sent:0,uncertain:0,rejected:0,expiredQueued:0,oldestQueuedAt:null,lastRecordedAt:null});
  assert.deepEqual(readQueueSnapshot(storage,-1001234567890,NOW),{schema:'queue-audit-v1',asOf:NOW,total:0,queued:0,sending:0,sent:0,uncertain:0,rejected:0,expiredQueued:0,oldestQueuedAt:null,lastRecordedAt:null});
  assert.throws(()=>readQueueSnapshot(storage,0,NOW),/Invalid audit scope/);
  assert.throws(()=>readQueueSnapshot({sql:{exec(){throw Error('unavailable');}}},321,NOW),/unavailable/);
  assert.equal(validateQueueSnapshot({...snapshot,total:2}),false);
  assert.equal(validateQueueSnapshot({...snapshot,queued:-1}),false);
  db.close();
});

test('public audit fails closed and never reaches storage without valid authentication', async () => {
  let calls=0;
  const e={...env(),OUTBOX:{idFromName(){calls++;throw Error('must not access');}}};
  assert.equal((await handle(new Request(base+AUDIT_PATH),e,NOW)).status,404);
  assert.equal((await handle(new Request(base+AUDIT_PATH,{method:'POST'}),e,NOW)).status,401);
  assert.equal((await handle(await signed(),{...e,TELEGRAM_DELIVERY_ENABLED:'true'},NOW)).status,503);
  assert.equal((await handle(await signed(),{...e,TELEGRAM_DELIVERY_ENABLED:undefined},NOW)).status,503);
  assert.equal((await handle(await signed(),{...e,TELEGRAM_RELEASE_APPROVED:''},NOW)).status,503);
  assert.equal((await handle(new Request(base+AUDIT_PATH,{method:'POST',headers:await auditHeaders(SECRET,NOW),body:'{}'}),e,NOW)).status,400);
  assert.equal(calls,0);
});

test('authorized audit accepts zero bytes even when a POST body stream exists', async () => {
  let calls=0;
  const e={...env(),OUTBOX:{idFromName(name){assert.equal(name,'telegram-pilot-v1');return name;},get(){return {fetch:async()=>{calls++;return json(snapshot);}};}}};
  const r=new Request(base+AUDIT_PATH,{method:'POST',headers:await auditHeaders(SECRET,NOW),body:''});
  assert.notEqual(r.body,null);
  const response=await handleQueueAudit(r,e,NOW);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),snapshot);
  assert.equal(calls,1);
});

test('authorized audit reads the fixed singleton and never returns downstream private fields', async () => {
  let calls=0;
  const e={...env(),OUTBOX:{idFromName(name){assert.equal(name,'telegram-pilot-v1');return name;},get(){return {fetch:async(url,options)=>{calls++;assert.equal(url,'https://outbox.internal/audit');assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{op:'snapshot'});return json({...snapshot,reply:'PRIVATE',chatId:321,token:'PRIVATE'});}};}}};
  const r=await handle(await signed(),e,NOW);
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),snapshot);
  assert.equal(calls,1);
  const failed=await handleQueueAudit(await signed(),{...e,OUTBOX:{idFromName(){return 'x';},get(){return {fetch:async()=>json({error:'storage unavailable'},503)};}}},NOW);
  assert.equal(failed.status,503);
  assert.deepEqual(await failed.json(),{error:'Storage unavailable'});
});

test('audit does not accept an arbitrary body or return malformed aggregate responses',async()=>{
  const e={...env(),OUTBOX:{idFromName(){return 'x';},get(){return {fetch:async()=>json({...snapshot,queued:2})};}}};
  assert.equal((await handleQueueAudit(await signed(),e,NOW)).status,503);
  assert.equal((await handleQueueAudit(await signed(),{...e,OUTBOX:undefined},NOW)).status,503);
  assert.equal((await handleQueueAudit(await signed(),{...e,OUTBOX:{idFromName(){return 'x';},get(){return {fetch:async()=>new Response('x'.repeat(5000),{headers:{'content-type':'application/json'}})};}}},NOW)).status,503);
});
