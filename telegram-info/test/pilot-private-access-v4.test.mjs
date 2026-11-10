import test from 'node:test';
import assert from 'node:assert/strict';
import { privatePilotAccessAllowed } from '../src/runtime-access.mjs';

const config = {
  chatId:-1001234567890,
  chatIds:[-1001234567890, 111111111],
  adminUserIds:[111111111],
  token:'123456789:abcdefghijklmnopqrstuvwxyzABCDEFGH_123456',
  secret:'abcdefghijklmnopqrstuvwxyzABCDEFGH_1234567890'
};

function privateUpdate(userId) {
  return {
    update_id:1,
    message:{
      message_id:10,
      date:1,
      chat:{ id:userId, type:'private' },
      from:{ id:userId, is_bot:false },
      text:'/start'
    }
  };
}

test('explicit positive allowlist user is admitted without membership lookup', async () => {
  let calls = 0;
  const allowed = await privatePilotAccessAllowed(privateUpdate(111111111), config, async () => {
    calls += 1;
    throw new Error('membership lookup must not run');
  });
  assert.equal(allowed, true);
  assert.equal(calls, 0);
});

test('public mode admits any private user without group membership lookup', async () => {
  const publicConfig = { ...config, mode:'public', chatId:null, chatIds:[] };
  let calls = 0;
  const allowed = await privatePilotAccessAllowed(privateUpdate(222222222), publicConfig, async () => {
    calls += 1;
    throw new Error('membership lookup must not run in public private mode');
  });
  assert.equal(allowed, true);
  assert.equal(calls, 0);
});

test('registered pilot admin is admitted even when not a positive chat allowlist entry', async () => {
  const adminOnly = { ...config, chatIds:[-1001234567890], adminUserIds:[777777777] };
  let calls = 0;
  const allowed = await privatePilotAccessAllowed(privateUpdate(777777777), adminOnly, async () => {
    calls += 1;
    throw new Error('membership lookup must not run for pilot admin');
  });
  assert.equal(allowed, true);
  assert.equal(calls, 0);
});

test('member of allowlisted pilot group is admitted', async () => {
  const allowed = await privatePilotAccessAllowed(privateUpdate(222222222), config, async (url, options) => {
    assert.match(String(url), /getChatMember$/u);
    assert.deepEqual(JSON.parse(options.body), { chat_id:-1001234567890, user_id:222222222 });
    return new Response(JSON.stringify({ ok:true, result:{ status:'member' } }), {
      status:200,
      headers:{ 'content-type':'application/json' }
    });
  });
  assert.equal(allowed, true);
});

test('restricted current member of allowlisted group is admitted', async () => {
  const allowed = await privatePilotAccessAllowed(privateUpdate(333333333), config, async () =>
    new Response(JSON.stringify({ ok:true, result:{ status:'restricted', is_member:true } }), { status:200 })
  );
  assert.equal(allowed, true);
});

test('non-member is denied', async () => {
  const allowed = await privatePilotAccessAllowed(privateUpdate(444444444), config, async () =>
    new Response(JSON.stringify({ ok:true, result:{ status:'left' } }), { status:200 })
  );
  assert.equal(allowed, false);
});

test('membership lookup failure fails closed', async () => {
  const allowed = await privatePilotAccessAllowed(privateUpdate(555555555), config, async () =>
    new Response(JSON.stringify({ ok:false, error_code:400 }), { status:400 })
  );
  assert.equal(allowed, false);
});

test('group update is not subjected to private membership gate', async () => {
  const update = {
    update_id:2,
    message:{
      message_id:11,
      date:1,
      chat:{ id:-1001234567890, type:'supergroup' },
      from:{ id:666666666, is_bot:false },
      text:'/menu'
    }
  };
  const allowed = await privatePilotAccessAllowed(update, config, async () => {
    throw new Error('membership lookup must not run for group update');
  });
  assert.equal(allowed, true);
});
