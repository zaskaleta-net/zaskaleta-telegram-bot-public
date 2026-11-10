import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchCuratedSchleswigHolsteinMunicipality,
  matchOfficialSchleswigHolsteinMunicipality,
  resolveSchleswigHolsteinMunicipalityText
} from '../src/municipality-directory.mjs';
import { normalizeStatewideHousingConversationRequest } from '../src/housing-conversation-statewide-v2.mjs';
import { recordHousingPrompt } from '../src/runtime-housing-state.mjs';
import { districtSearchLimitCandidates } from '../src/runtime-jobcenter.mjs';
import { SH_RUNTIME_MUNICIPALITY_ROWS } from '../src/sh-municipality-jurisdiction-runtime.mjs';

function privateRequest(text, replyText = null) {
  const message = { message_id:2, chat:{ id:123, type:'private' }, from:{ id:123, is_bot:false }, text };
  if (replyText) message.reply_to_message = { message_id:1, chat:{ id:123, type:'private' }, from:{ is_bot:true, username:'ZaskaletaInfoBot' }, text:replyText };
  return new Request('https://worker.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ update_id:1, message })
  });
}

test('60162 Ukrainian Itzehoe spelling resolves to Steinburg', () => {
  const route = matchCuratedSchleswigHolsteinMunicipality('Ітцегое');
  assert.equal(route?.canonical, 'Itzehoe');
  assert.equal(route?.jurisdiction, 'Steinburg');
});

test('60162 Ukrainian Oldenburg-in-Holstein spelling resolves to Ostholstein', () => {
  const route = matchCuratedSchleswigHolsteinMunicipality('Ольденбург-в-Гольштейні');
  assert.equal(route?.canonical, 'Oldenburg in Holstein');
  assert.equal(route?.jurisdiction, 'Ostholstein');
});

test('all-state exact official municipality lookup is local and network-independent', async () => {
  let networkCalls = 0;
  const route = await resolveSchleswigHolsteinMunicipalityText('Witzwort', async () => {
    networkCalls += 1;
    throw new Error('network must not be used');
  });
  assert.equal(route?.canonical, 'Witzwort');
  assert.equal(route?.jurisdiction, 'Nordfriesland');
  assert.equal(route?.source, 'local-statewide-index');
  assert.equal(networkCalls, 0);
});

test('duplicate official names remain fail-closed in statewide local index', () => {
  assert.equal(matchOfficialSchleswigHolsteinMunicipality('Quickborn'), null);
  assert.equal(matchOfficialSchleswigHolsteinMunicipality('Schenefeld'), null);
  assert.equal(matchOfficialSchleswigHolsteinMunicipality('Nortorf'), null);
});

test('exact German municipality works in housing location step without directory network', async () => {
  const normalized = await normalizeStatewideHousingConversationRequest(
    privateRequest('Itzehoe', 'Тема: житло. Вкажіть місто або район.'),
    async () => { throw new Error('network must not be used'); }
  );
  const body = await normalized.json();
  assert.equal(body.message.text, 'Itzehoe житло');
  assert.equal(body.message.reply_to_message, undefined);
});

test('generic parse fallback preserves active housing prompt for corrected retry', async () => {
  let stored = null;
  const env = { OUTBOX:{
    idFromName(){ return 'telegram-pilot-v1'; },
    get(){ return { async fetch(_url, options = {}) {
      const value = JSON.parse(String(options.body || '{}'));
      if (value.op === 'put') stored = { prompt:value.prompt, updatedAt:value.now };
      if (value.op === 'clear') stored = null;
      const response = value.op === 'read' ? { status:'ok', prompt:stored?.prompt || null } : { status:'ok' };
      return new Response(JSON.stringify(response), { status:200, headers:{'content-type':'application/json'} });
    } }; }
  } };
  const prompt = 'Тема: житло. Вкажіть місто або район.';
  assert.equal(await recordHousingPrompt({ chat_id:123, text:prompt }, env, 1000), true);
  assert.equal(stored?.prompt, prompt);
  assert.equal(await recordHousingPrompt({ chat_id:123, text:'Не вдалося однозначно зрозуміти запит.\n\nСпробуйте ще раз.' }, env, 1100), true);
  assert.equal(stored?.prompt, prompt);
});

test('whole-Kreis synchronous limit candidates stay bounded to five statewide', () => {
  const firstByJurisdiction = new Map();
  for (const row of SH_RUNTIME_MUNICIPALITY_ROWS) {
    if (!firstByJurisdiction.has(row.jurisdiction)) firstByJurisdiction.set(row.jurisdiction, row.canonical);
  }
  assert.equal(firstByJurisdiction.size, 15);
  for (const [jurisdiction, origin] of firstByJurisdiction) {
    const candidates = districtSearchLimitCandidates(jurisdiction, origin);
    assert.ok(candidates.length >= 1, `${jurisdiction} must include origin`);
    assert.ok(candidates.length <= 5, `${jurisdiction} must stay CPU-bounded`);
    assert.equal(candidates[0], origin);
  }
});
