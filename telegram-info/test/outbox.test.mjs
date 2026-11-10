import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import { Outbox } from '../src/outbox.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const DAY = 86400000;

// A real SQLite database with a small adapter for Cloudflare's synchronous SQL API.
function database(path = ':memory:') {
  const db = new DatabaseSync(path);
  const storage = {
    sql: {
      exec(sql, ...params) {
        if (!params.length && /^(CREATE|PRAGMA)/i.test(sql.trim())) {
          db.exec(sql); return { toArray: () => [] };
        }
        const statement = db.prepare(sql);
        if (/^(SELECT|WITH)/i.test(sql.trim())) {
          const rows = statement.all(...params);
          return { toArray: () => rows };
        }
        statement.run(...params);
        return { toArray: () => [] };
      }
    },
    transactionSync(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  const outbox = new Outbox(storage);
  outbox.init();
  return { db, storage, outbox };
}
const msg = (id, chatId = 321) => ({ id, chatId, messageId: id + 1 });
const raw = (db, id) => db.prepare('SELECT * FROM telegram_outbox WHERE update_id=?').get(id);

test('deduplication is atomic and stores only the outgoing reply', () => {
  const { db, outbox } = database();
  assert.equal(outbox.enqueue(msg(1), 'Тестова відповідь', 1000).accepted, true);
  assert.deepEqual(outbox.enqueue(msg(1, 999), 'Інший текст', 1000), { accepted: false, reason: 'duplicate', state: 'queued' });
  assert.equal(raw(db, 1).reply, 'Тестова відповідь');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_outbox').get().n, 1);
  assert.equal(outbox.limit('in:0'), 1);
  db.close();
});

test('signed Telegram group chat ids are valid queue destinations', () => {
  const { db, outbox } = database();
  const group = -1001234567890;
  assert.equal(outbox.enqueue(msg(1, group), 'Групова відповідь', 1000).accepted, true);
  const claim = outbox.claim(1000);
  assert.equal(claim.chatId, group);
  assert.equal(outbox.complete(1, claim.token, { status:'sent', messageId:50 }, 1100), true);
  assert.equal(outbox.eraseChat(group, 1200), true);
  db.close();
});

test('claims are single-use, throttled and acknowledged only with the right token', () => {
  const { db, outbox } = database();
  outbox.enqueue(msg(1), 'A', 1000);
  outbox.enqueue(msg(2), 'B', 1000);
  const first = outbox.claim(1000);
  assert.equal(first.id, 1);
  assert.equal(outbox.claim(1000), null);
  assert.equal(outbox.complete(1, 'wrong', { status: 'sent', messageId: 50 }, 1100), false);
  assert.equal(outbox.complete(1, first.token, { status: 'sent', messageId: 50 }, 1100), true);
  assert.equal(outbox.get(1).state, 'sent');
  assert.equal(raw(db, 1).reply, null);
  assert.equal(outbox.complete(1, first.token, { status: 'sent', messageId: 51 }, 1200), false);
  assert.equal(outbox.claim(2099), null);
  assert.equal(outbox.claim(2100).id, 2);
  db.close();
});

test('restart and stale claims become uncertain, never queued again', () => {
  const { db, storage, outbox } = database();
  outbox.enqueue(msg(1), 'A', 1000);
  const claim = outbox.claim(1000);
  const restarted = new Outbox(storage);
  restarted.init();
  assert.equal(restarted.get(1).state, 'uncertain');
  assert.equal(raw(db, 1).reply, null);
  assert.equal(restarted.complete(1, claim.token, { status: 'sent', messageId: 77 }, 2000), false);
  assert.equal(restarted.claim(50000), null);
  restarted.enqueue(msg(2), 'B', 1000);
  restarted.claim(50000);
  restarted.reconcile(80000);
  assert.equal(restarted.get(2).state, 'uncertain');
  db.close();
});

test('only confirmed rate limits are retried, with a maximum of three attempts', () => {
  const { db, outbox } = database();
  outbox.enqueue(msg(1), 'A', 1000);
  const a = outbox.claim(1000);
  outbox.complete(1, a.token, { status: 'rate_limited', retryAfter: 2 }, 1000);
  assert.equal(outbox.get(1).state, 'queued');
  assert.equal(outbox.claim(2999), null);
  const b = outbox.claim(3000);
  assert.equal(b.attempts, 2);
  outbox.complete(1, b.token, { status: 'rate_limited', retryAfter: 0 }, 3000);
  const c = outbox.claim(4100);
  assert.equal(c.attempts, 3);
  outbox.complete(1, c.token, { status: 'rate_limited', retryAfter: 1 }, 4100);
  assert.equal(outbox.get(1).state, 'uncertain');
  assert.equal(raw(db, 1).reply, null);
  assert.equal(outbox.claim(100000), null);
  db.close();
});

test('network uncertainty and explicit rejection never produce another send', () => {
  const { db, outbox } = database();
  outbox.enqueue(msg(1), 'A', 1000);
  const a = outbox.claim(1000);
  outbox.complete(1, a.token, { status: 'uncertain' }, 1000);
  assert.equal(outbox.claim(5000), null);
  outbox.enqueue(msg(2), 'B', 5000);
  const b = outbox.claim(5000);
  outbox.complete(2, b.token, { status: 'rejected', errorCode: 403 }, 5000);
  assert.equal(outbox.get(2).state, 'rejected');
  assert.equal(outbox.claim(100000), null);
  db.close();
});

test('queue, incoming and outgoing budgets fail closed', () => {
  const { db, outbox } = database();
  for (let i = 1; i <= 100; i++) assert.equal(outbox.enqueue(msg(i), 'A', 1000).accepted, true);
  assert.equal(outbox.enqueue(msg(101), 'A', 1000).reason, 'queue_full');
  outbox.setLimit('in:0', 200);
  assert.equal(outbox.enqueue(msg(101), 'A', 1000).reason, 'queue_full');
  outbox.setLimit('out:0', 100);
  assert.equal(outbox.claim(1000), null);
  assert.equal(outbox.nextDue(1000), DAY);
  db.close();
});

test('erasure cancels queued replies, removes direct identifiers and keeps replay tombstones', () => {
  const { db, outbox } = database();
  outbox.enqueue(msg(1), 'A', 1000);
  assert.equal(outbox.eraseChat(321, 2000), true);
  assert.equal(outbox.get(1).state, 'rejected');
  assert.equal(raw(db, 1).chat_id, 0);
  assert.equal(raw(db, 1).message_id, 0);
  assert.equal(raw(db, 1).reply, null);
  assert.equal(outbox.claim(5000), null);
  assert.equal(outbox.enqueue(msg(1), 'Again', 5000).reason, 'duplicate');
  outbox.enqueue(msg(2), 'B', 5000);
  const claim = outbox.claim(5000);
  assert.equal(outbox.eraseChat(321, 6000), false);
  outbox.complete(2, claim.token, { status: 'sent', messageId: 10 }, 6000);
  assert.equal(outbox.eraseChat(321, 7000), true);
  db.close();
});

test('old queued messages expire and terminal tombstones are purged after 30 days', () => {
  const { db, outbox } = database();
  outbox.enqueue(msg(1), 'A', 1000);
  outbox.reconcile(DAY + 2000);
  assert.equal(outbox.get(1).state, 'rejected');
  assert.equal(raw(db, 1).reply, null);
  outbox.purge(32 * DAY);
  assert.equal(outbox.get(1), null);
  db.close();
});

test('invalid input and failed storage transactions cannot create partial records', () => {
  const { db, outbox } = database();
  assert.throws(() => outbox.enqueue(msg(1, 0), 'A', 1000));
  assert.throws(() => outbox.enqueue(msg(1), '', 1000));
  assert.throws(() => outbox.enqueue(msg(1), 'x'.repeat(4097), 1000));
  const original = outbox.setLimit.bind(outbox);
  outbox.setLimit = () => { throw Error('storage failure'); };
  assert.throws(() => outbox.enqueue(msg(1), 'A', 1000));
  outbox.setLimit = original;
  assert.equal(outbox.get(1), null);
  assert.equal(outbox.limit('in:0'), 0);
  db.close();
});
