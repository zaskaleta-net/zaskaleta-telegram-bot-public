import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GroupBetaState } from '../src/group-beta-state.mjs';

const GROUP = -1001234567890;
const NOW = 1700000000000;

function database() {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: {
      exec(sql, ...params) {
        if (!params.length && /^CREATE/i.test(sql.trim())) {
          db.exec(sql);
          return { toArray: () => [] };
        }
        const statement = db.prepare(sql);
        if (/^(SELECT|WITH)/i.test(sql.trim())) return { toArray: () => statement.all(...params) };
        statement.run(...params);
        return { toArray: () => [] };
      }
    },
    transactionSync(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  const state = new GroupBetaState(storage);
  state.init();
  return { db, state };
}

const message = (id, userId, text) => ({ id, chatId:GROUP, userId, messageId:id + 100, text, trigger:'reply' });

test('SQLite keeps simultaneous housing flows isolated by chat and user', () => {
  const { db, state } = database();
  assert.equal(state.process(message(1,701,'житло: Trittau'),NOW).status,'ok');
  assert.equal(state.process(message(2,702,'житло: Kiel'),NOW).status,'ok');
  assert.equal(state.process(message(3,701,'3-4'),NOW+1).status,'ok');
  assert.equal(state.process(message(4,702,'2'),NOW+1).status,'ok');
  assert.equal(state.process(message(5,701,'1200'),NOW+2).status,'ok');
  assert.equal(state.process(message(6,702,'850 Warmmiete'),NOW+2).status,'ok');

  const a=state.readFlow(GROUP,701,NOW+3);
  const b=state.readFlow(GROUP,702,NOW+3);
  assert.deepEqual(a,{step:'type',location:'Trittau',rooms:'3-4',amount:1200});
  assert.deepEqual(b,{step:'radius',location:'Kiel',rooms:'2',amount:850,type:'Warmmiete'});

  const rows=db.prepare('SELECT chat_id,user_id,state_json FROM telegram_beta_flow ORDER BY user_id').all();
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(row=>row.user_id),[701,702]);
  assert.ok(rows.every(row=>row.chat_id===GROUP));
  db.close();
});

test('duplicate Telegram update is rejected before a second state transition', () => {
  const { db, state } = database();
  const first=state.process(message(10,701,'житло: Lübeck'),NOW);
  const duplicate=state.process(message(10,701,'4'),NOW+1);
  assert.equal(first.status,'ok');
  assert.equal(duplicate.status,'duplicate');
  assert.deepEqual(state.readFlow(GROUP,701,NOW+2),{step:'rooms',location:'Lübeck'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_beta_seen').get().n,1);
  db.close();
});

test('per-user flood limit is independent from the group-wide limit', () => {
  const { db, state } = database();
  for(let i=0;i<6;i++) assert.equal(state.process(message(20+i,701,'/help'),NOW+i).status,'ok');
  assert.equal(state.process(message(26,701,'/help'),NOW+6).status,'rate_limited');
  assert.equal(state.process(message(27,702,'/help'),NOW+7).status,'ok');
  db.close();
});

test('group-wide flood limit caps aggregate activity across different users', () => {
  const { db, state } = database();
  for(let i=0;i<40;i++) assert.equal(state.process(message(100+i,1000+i,'/help'),NOW+i).status,'ok');
  assert.equal(state.process(message(140,2000,'/help'),NOW+40).status,'rate_limited');
  db.close();
});

test('Jobcenter state is independently keyed for each group participant', () => {
  const { db, state } = database();
  const a={listingId:'3506905833',location:'22946 Trittau',areaSqm:90};
  const b={listingId:'3506905999',location:'Kiel',areaSqm:70};
  assert.equal(state.startJobcenter(message(201,701,'callback'),a,NOW).status,'ok');
  assert.equal(state.startJobcenter(message(202,702,'callback'),b,NOW+1).status,'ok');

  const aRent=state.setJobcenterPersons(GROUP,701,4,NOW+2);
  assert.equal(aRent.step,'rent');
  assert.equal(aRent.persons,4);
  assert.deepEqual(state.readJobcenter(GROUP,702,NOW+2),{step:'persons',listingId:'3506905999',location:'Kiel',areaSqm:70});

  state.clearJobcenter(GROUP,701);
  assert.equal(state.readJobcenter(GROUP,701,NOW+3),null);
  assert.notEqual(state.readJobcenter(GROUP,702,NOW+3),null);
  db.close();
});
