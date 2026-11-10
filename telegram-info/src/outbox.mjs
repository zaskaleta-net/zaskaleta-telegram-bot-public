// Telegram-only SQLite-backed Durable Object outbox.
// A delivery is claimed durably BEFORE any network call. Ambiguous sends are never retried.
const validId = n => Number.isSafeInteger(n) && n > 0;
const validChatId = n => Number.isSafeInteger(n) && n !== 0;
const validTime = n => Number.isSafeInteger(n) && n >= 0;
const MAX_ATTEMPTS = 3;
const DAY = 86400000;

export class Outbox {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
  }
  one(query, ...args) { return this.sql.exec(query, ...args).toArray()[0] || null; }
  tx(fn) { return this.storage.transactionSync(fn); }
  init() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS telegram_outbox (
      update_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
      reply TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL, claimed_at INTEGER, claim_token TEXT,
      telegram_message_id INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER,
      CHECK (state IN ('queued','sending','sent','uncertain','rejected'))
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS telegram_outbox_due ON telegram_outbox(state,due_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS telegram_limits (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    // Call once on a new object instance, never on every request.
    // A previous in-flight HTTP request may have succeeded before a restart.
    this.sql.exec("UPDATE telegram_outbox SET state='uncertain', reply=NULL, claim_token=NULL, finished_at=claimed_at WHERE state='sending'");
  }
  get(id) {
    return this.one('SELECT update_id,chat_id,state,attempts,due_at,telegram_message_id FROM telegram_outbox WHERE update_id=?', id);
  }
  limit(key) { return this.one('SELECT value FROM telegram_limits WHERE key=?', key)?.value || 0; }
  setLimit(key, value) {
    this.sql.exec('INSERT INTO telegram_limits(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
  }
  enqueue(message, reply, now = Date.now()) {
    if (!validTime(message?.id) || !validChatId(message?.chatId) || !validId(message?.messageId) ||
        typeof reply !== 'string' || !reply.trim() || reply.length > 4096 || !validTime(now)) throw Error('Invalid outbox input');
    return this.tx(() => {
      const existing = this.get(message.id);
      if (existing) return { accepted: false, reason: 'duplicate', state: existing.state };
      const count = this.one("SELECT COUNT(*) AS n FROM telegram_outbox WHERE state IN ('queued','sending')").n;
      if (count >= 100) return { accepted: false, reason: 'queue_full' };
      const key = `in:${Math.floor(now / DAY)}`;
      if (this.limit(key) >= 200) return { accepted: false, reason: 'daily_limit' };
      this.sql.exec("INSERT INTO telegram_outbox(update_id,chat_id,message_id,reply,state,due_at,created_at) VALUES(?,?,?,?,'queued',?,?)", message.id, message.chatId, message.messageId, reply, now, now);
      this.setLimit(key, this.limit(key) + 1);
      return { accepted: true, state: 'queued' };
    });
  }
  claim(now = Date.now()) {
    if (!validTime(now)) throw Error('Invalid time');
    return this.tx(() => {
      const key = `out:${Math.floor(now / DAY)}`;
      if (this.limit(key) >= 100 || now < this.limit('next_send_at')) return null;
      const row = this.one("SELECT * FROM telegram_outbox WHERE state='queued' AND reply IS NOT NULL AND due_at<=? AND created_at>=? AND attempts<? ORDER BY due_at,update_id LIMIT 1", now, now - DAY, MAX_ATTEMPTS);
      if (!row) return null;
      const token = crypto.randomUUID();
      this.sql.exec("UPDATE telegram_outbox SET state='sending',attempts=attempts+1,claimed_at=?,claim_token=? WHERE update_id=? AND state='queued'", now, token, row.update_id);
      this.setLimit(key, this.limit(key) + 1);
      this.setLimit('next_send_at', now + 1100);
      return { id: row.update_id, chatId: row.chat_id, text: row.reply, token, attempts: row.attempts + 1 };
    });
  }
  complete(id, token, result, now = Date.now()) {
    if (!validTime(id) || typeof token !== 'string' || !token || !validTime(now)) throw Error('Invalid completion');
    return this.tx(() => {
      const row = this.one("SELECT * FROM telegram_outbox WHERE update_id=? AND state='sending' AND claim_token=?", id, token);
      if (!row) return false;
      let state = 'uncertain', due = row.due_at, reply = null, remoteId = null;
      if (result?.status === 'sent' && validId(result.messageId)) {
        state = 'sent'; remoteId = result.messageId;
      } else if (result?.status === 'rejected') {
        state = 'rejected';
      } else if (result?.status === 'rate_limited' && row.attempts < MAX_ATTEMPTS) {
        // Only a confirmed Telegram 429 rejection is safe to retry.
        state = 'queued'; reply = row.reply;
        const delay = Number.isFinite(result.retryAfter) ? Math.max(1, Math.min(3600, Math.ceil(result.retryAfter))) : 60;
        due = now + delay * 1000;
      }
      this.sql.exec('UPDATE telegram_outbox SET state=?,reply=?,due_at=?,claim_token=NULL,telegram_message_id=?,finished_at=? WHERE update_id=?', state, reply, due, remoteId, state === 'queued' ? null : now, id);
      return true;
    });
  }
  reconcile(now = Date.now()) {
    if (!validTime(now)) throw Error('Invalid time');
    return this.tx(() => {
      this.sql.exec("UPDATE telegram_outbox SET state='uncertain',reply=NULL,claim_token=NULL,finished_at=? WHERE state='sending' AND claimed_at<=?", now, now - 30000);
      this.sql.exec("UPDATE telegram_outbox SET state='rejected',reply=NULL,finished_at=? WHERE state='queued' AND created_at<?", now, now - DAY);
    });
  }
  nextDue(now = Date.now()) {
    const row = this.one("SELECT MIN(due_at) AS due FROM telegram_outbox WHERE state='queued' AND reply IS NOT NULL AND attempts<?", MAX_ATTEMPTS);
    if (row?.due == null) return null;
    let due = Math.max(row.due, this.limit('next_send_at'), now);
    const day = Math.floor(due / DAY);
    if (this.limit(`out:${day}`) >= 100) due = (day + 1) * DAY;
    return due;
  }
  eraseChat(chatId, now = Date.now()) {
    if (!validChatId(chatId) || !validTime(now)) throw Error('Invalid chat');
    // An in-flight request may already be accepted by Telegram: do not falsely promise cancellation.
    return this.tx(() => {
      const sending = this.one("SELECT COUNT(*) AS n FROM telegram_outbox WHERE chat_id=? AND state='sending'", chatId).n;
      if (sending) return false;
      // Keep only an unlinked update-id tombstone for replay suppression; cancel queued replies.
      this.sql.exec("UPDATE telegram_outbox SET chat_id=0,message_id=0,reply=NULL,telegram_message_id=NULL,state=CASE WHEN state='queued' THEN 'rejected' ELSE state END,finished_at=COALESCE(finished_at,?) WHERE chat_id=?", now, chatId);
      return true;
    });
  }
  purge(now = Date.now()) {
    if (!validTime(now)) throw Error('Invalid time');
    return this.tx(() => {
      // Keep minimal metadata tombstones for 30 days; no raw incoming text is ever stored.
      this.sql.exec("DELETE FROM telegram_outbox WHERE state IN ('sent','uncertain','rejected') AND finished_at<?", now - 30 * DAY);
      this.sql.exec("DELETE FROM telegram_limits WHERE key LIKE 'in:%' AND CAST(SUBSTR(key,4) AS INTEGER)<?", Math.floor(now / DAY) - 2);
      this.sql.exec("DELETE FROM telegram_limits WHERE key LIKE 'out:%' AND CAST(SUBSTR(key,5) AS INTEGER)<?", Math.floor(now / DAY) - 2);
    });
  }
}
