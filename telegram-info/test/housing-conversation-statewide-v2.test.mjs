import test from 'node:test';
import assert from 'node:assert/strict';
import { SH_JURISDICTIONS } from '../src/jobcenter-jurisdictions.mjs';
import { SH_UKRAINIAN_PLACE_ROWS } from '../src/schleswig-holstein-place-names.mjs';
import {
  conversationalHouseholdSize,
  conversationalHousingPlace,
  normalizedHousingConversationText,
  normalizeStatewideHousingConversationRequest
} from '../src/housing-conversation-statewide-v2.mjs';

const HOUSING_PROMPT = 'Тема: житло. Вкажіть місто або район.';

function requestFor(text, { previous = HOUSING_PROMPT, type = 'private' } = {}) {
  const chatId = type === 'private' ? 123 : -123;
  const message = {
    message_id:2,
    chat:{ id:chatId, type },
    from:{ id:123, is_bot:false },
    text
  };
  if (previous) {
    message.reply_to_message = {
      message_id:1,
      chat:{ id:chatId, type },
      from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
      text:previous
    };
  }
  return new Request('https://worker.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-test':'housing-conversation' },
    body:JSON.stringify({ update_id:1, message })
  });
}

function municipalityDirectoryTransport() {
  return async url => {
    const parsed = new URL(String(url));
    if (parsed.hostname !== 'www.gemeindeverzeichnis.de') throw new Error(`unexpected host ${parsed.hostname}`);
    const query = parsed.searchParams.get('q');
    const data = query === 'Witzwort'
      ? [{ ags:'01054161', ars:'010545484161', normalized_display_name:'Witzwort', bundesland_slug:'schleswig-holstein' }]
      : [];
    return new Response(JSON.stringify({ data }), {
      status:200,
      headers:{ 'content-type':'application/json' }
    });
  };
}

test('screenshot regression: Любек дві жінки keeps Lübeck separate from household composition', () => {
  assert.equal(conversationalHousingPlace('Любек дві жінки'), 'Lübeck');
  assert.equal(conversationalHouseholdSize('Любек дві жінки'), 2);
  assert.equal(
    normalizedHousingConversationText('Любек дві жінки', { requireHousingContext:true }),
    'Lübeck житло для 2 осіб'
  );
});

test('screenshot regression: Ренсберг для сім\'ї 3 resolves to Rendsburg and three people', () => {
  assert.equal(conversationalHousingPlace("Ренсберг для сім'ї 3"), 'Rendsburg');
  assert.equal(conversationalHouseholdSize("Ренсберг для сім'ї 3"), 3);
  assert.equal(
    normalizedHousingConversationText("Ренсберг для сім'ї 3", { requireHousingContext:true }),
    'Rendsburg житло для 3 осіб'
  );
});

test('phone regression 57280: Бад зегерберг двое дорослих resolves location and household separately', () => {
  assert.equal(conversationalHousingPlace('Бад зегерберг двое дорослих'), 'Bad Segeberg');
  assert.equal(conversationalHouseholdSize('Бад зегерберг двое дорослих'), 2);
  assert.equal(
    normalizedHousingConversationText('Бад зегерберг двое дорослих', { requireHousingContext:true }),
    'Bad Segeberg житло для 2 осіб'
  );
});

test('word household composition sums separate child and adult groups', () => {
  assert.equal(conversationalHouseholdSize('двоє дітей та двоє дорослих'), 4);
  assert.equal(conversationalHouseholdSize('двое детей и двое взрослых'), 4);
});

test('housing location prompt accepts a bare known municipality without swallowing extra words', async () => {
  const request = requestFor('Ренсберг');
  const normalized = await normalizeStatewideHousingConversationRequest(request);
  const payload = await normalized.json();
  assert.equal(payload.message.text, 'Rendsburg житло');
  assert.equal(payload.message.reply_to_message, undefined);
  assert.equal(normalized.headers.get('x-test'), 'housing-conversation');
});

test('phone regression 57280: housing location prompt strips reply metadata and keeps only Bad Segeberg as place', async () => {
  const request = requestFor('Бад зегерберг двое дорослих');
  const normalized = await normalizeStatewideHousingConversationRequest(request);
  const payload = await normalized.json();
  assert.equal(payload.message.text, 'Bad Segeberg житло для 2 осіб');
  assert.equal(payload.message.reply_to_message, undefined);
});

test('housing location prompt can accept place, household and rooms in one reply', async () => {
  const request = requestFor('Любек дві жінки 3 кімнати');
  const normalized = await normalizeStatewideHousingConversationRequest(request);
  const payload = await normalized.json();
  assert.equal(payload.message.text, 'Lübeck житло для 2 осіб 3 кімнати');
  assert.equal(payload.message.reply_to_message, undefined);
});

test('strong standalone place plus household composition recovers housing intent even without reply metadata', async () => {
  const request = requestFor("Ренсберг для сім'ї 3", { previous:null });
  const normalized = await normalizeStatewideHousingConversationRequest(request);
  const payload = await normalized.json();
  assert.equal(payload.message.text, 'Rendsburg житло для 3 осіб');
});

test('explicit housing location step resolves smaller uncurated Schleswig-Holstein Gemeinde through statewide directory', async () => {
  const request = requestFor("Witzwort для сім'ї 4");
  const normalized = await normalizeStatewideHousingConversationRequest(request, municipalityDirectoryTransport());
  const payload = await normalized.json();
  assert.equal(payload.message.text, 'Witzwort житло для 4 осіб');
  assert.equal(payload.message.reply_to_message, undefined);
});

test('a bare place outside housing context is not silently converted into housing', async () => {
  const request = requestFor('Rendsburg', { previous:null });
  const normalized = await normalizeStatewideHousingConversationRequest(request);
  assert.equal(normalized, request);
});

test('administrative Jobcenter wording is never hijacked as generic housing', () => {
  const source = "Rendsburg Bescheid для сім'ї 3";
  assert.equal(normalizedHousingConversationText(source, { requireHousingContext:true }), source);
});

test('statewide conversational recovery works for every curated place and all 15 jurisdictions', () => {
  const jurisdictions = new Set();
  for (const row of SH_UKRAINIAN_PLACE_ROWS) {
    jurisdictions.add(row.jurisdiction);
    const alias = row.aliases?.[0] || row.canonical;
    const normalized = normalizedHousingConversationText(`${alias} для сім'ї 4`, { requireHousingContext:true });
    assert.ok(normalized.startsWith(`${row.canonical} житло для 4 осіб`), `${alias} -> ${normalized}`);
  }
  assert.deepEqual(jurisdictions, new Set(SH_JURISDICTIONS));
});

test('group messages remain untouched', async () => {
  const request = requestFor("Любек дві жінки", { type:'group' });
  const normalized = await normalizeStatewideHousingConversationRequest(request);
  assert.equal(normalized, request);
});
