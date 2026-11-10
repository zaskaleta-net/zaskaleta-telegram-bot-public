import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichCallbackHouseholdFromActiveFlow, normalizeJobcenterPersonsReply, rememberNaturalJobcenterContext } from '../src/active-household-context.mjs';

const GROUP = -1001234567890;
const USER = 702;

function env(handler) {
  return {
    OUTBOX:{
      idFromName(name){ assert.equal(name, 'telegram-pilot-v1'); return name; },
      get(){ return { fetch:handler }; }
    }
  };
}

function response(value) {
  return new Response(JSON.stringify(value), { status:200, headers:{ 'content-type':'application/json' } });
}

test('natural Jobcenter housing request resets stale conversation before storing household context', async () => {
  const payloads = [];
  const environment = env(async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    return response({ status:'ok' });
  });
  const update = {
    message:{
      chat:{ id:GROUP, type:'supergroup' },
      from:{ id:USER, is_bot:false },
      text:"Тріттау житло для сім'ї 4 людини Для Джобцентер"
    }
  };
  assert.equal(await rememberNaturalJobcenterContext(update, environment, 1700000000000), true);
  assert.deepEqual(payloads.map(item => item.op), ['conversation_reset','flow_context']);
  assert.equal(payloads[0].chatId, GROUP);
  assert.equal(payloads[0].userId, USER);
  assert.equal(payloads[1].state.jobcenter, true);
  assert.equal(payloads[1].state.persons, 4);
  assert.equal(payloads[1].state.location, 'Trittau');
});

test('old listing callback recovers household directly from the original replied user request', async () => {
  let called = false;
  const environment = env(async () => { called = true; return response({ status:'ok', state:null }); });
  const update = {
    callback_query:{
      from:{ id:USER, is_bot:false },
      data:`jc:3508825573:u${USER}`,
      message:{
        chat:{ id:GROUP, type:'supergroup' },
        caption:'3. Wohnung in Hamburg Rahlstedt\n💶 855 € · 22147 Hamburg Rahlstedt\n🛏 3 кімн. · 📐 98 м²',
        reply_to_message:{
          from:{ id:USER, is_bot:false },
          text:"Тріттау житло для сім'ї 4 людини Для Джобцентер"
        }
      }
    }
  };
  const enriched = await enrichCallbackHouseholdFromActiveFlow(update, environment, 1700000000000);
  assert.match(enriched.callback_query.message.caption, /👥 4 осіб/u);
  assert.equal(called, false);
});

test('old listing callback receives household from active Jobcenter flow when reply context is unavailable', async () => {
  const environment = env(async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.op, 'flow_read');
    return response({ status:'ok', state:{ jobcenter:true, persons:4 } });
  });
  const update = {
    callback_query:{
      from:{ id:USER, is_bot:false },
      data:`jc:3508825573:u${USER}`,
      message:{
        chat:{ id:GROUP, type:'supergroup' },
        caption:'3. Wohnung in Hamburg Rahlstedt\n💶 855 € · 22147 Hamburg Rahlstedt\n🛏 3 кімн. · 📐 98 м²'
      }
    }
  };
  const enriched = await enrichCallbackHouseholdFromActiveFlow(update, environment, 1700000000000);
  assert.match(enriched.callback_query.message.caption, /👥 4 осіб/u);
});

test('worded household reply to Step 1 is normalized to the numeric value expected by the Jobcenter flow', () => {
  const update = {
    message:{
      from:{ id:USER, is_bot:false },
      text:'чотири людини',
      reply_to_message:{
        from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
        text:'🏛 Перевірка під Jobcenter\n\nКрок 1/2: вкажіть кількість осіб у домогосподарстві (1–20).'
      }
    }
  };
  const normalized = normalizeJobcenterPersonsReply(update);
  assert.equal(normalized.message.text, '4');
});

test('callback with its own household marker does not query active flow', async () => {
  let called = false;
  const environment = env(async () => { called = true; return response({ status:'ok' }); });
  const update = {
    callback_query:{
      from:{ id:USER, is_bot:false },
      data:`jc:3508825573:u${USER}`,
      message:{ chat:{ id:GROUP, type:'supergroup' }, caption:'Wohnung\n👥 4 осіб' }
    }
  };
  const enriched = await enrichCallbackHouseholdFromActiveFlow(update, environment, 1700000000000);
  assert.equal(enriched, update);
  assert.equal(called, false);
});

test('foreign callback owner mismatch never reads reply context or active flow', async () => {
  let called = false;
  const environment = env(async () => { called = true; return response({ status:'ok' }); });
  const update = {
    callback_query:{
      from:{ id:USER + 1, is_bot:false },
      data:`jc:3508825573:u${USER}`,
      message:{
        chat:{ id:GROUP, type:'supergroup' },
        caption:'Wohnung in Hamburg Rahlstedt',
        reply_to_message:{ from:{ id:USER + 1, is_bot:false }, text:'4 людини' }
      }
    }
  };
  const enriched = await enrichCallbackHouseholdFromActiveFlow(update, environment, 1700000000000);
  assert.equal(enriched, update);
  assert.equal(called, false);
});
