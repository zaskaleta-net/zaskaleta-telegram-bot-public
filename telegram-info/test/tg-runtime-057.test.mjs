import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, USER, NOW } from './runtime-fixture.mjs';
import { HOUSING_WATCH_PREFIX, HOUSING_WATCH_RUN_PATH, handleHousingWatchRun, watchMessage } from '../src/housing-watch.mjs';
import { BRANDED_BOT_COMMANDS, botCommandsFor, syncBotCommandMetadata, resetBotCommandSyncForTests } from '../src/bot-command-sync.mjs';
import { householdSize, landlordLetterTemplate, writeLandlordLetter } from '../src/ai-assistant.mjs';

// TG-RUNTIME-057, from the owner's phone recording of 18.10.2026: the watch
// for a whole-Kreis search, the household size in the landlord letter, and
// no menu command for a feature that is switched off.

const KEY = `${HOUSING_WATCH_PREFIX}${USER}:${USER}`;
const KREIS = { location:'Trittau', persons:4, rooms:'3-4', radius:'kreis', jurisdiction:'Stormarn' };
const CARD = ['4. 3 Zimmer Wohnung Bargteheide', '💶 1092 € · 22941 Bargteheide', '🛏 3 кімн. · 📐 84 м²', '', 'Стартова точка: Trittau', 'Склад сім’ї: 4', 'Кімнати: 3-4'].join('\n');

test('#057 the watch of a whole-Kreis search is saved with its Jobcenter territory', async () => {
  const f = await fixture({ HOUSING_WATCH_ENABLED:'true' });
  try {
    const on = await f.send('', { callback:'jcw:d:4:3-4:Trittau' });
    assert.match(on.last.text, /^🔔 Моніторинг увімкнено\./u);
    assert.match(on.last.text, /Trittau, весь район \(Stormarn\)/u);
    assert.deepEqual(f.data.get(KEY).criteria, KREIS);
    assert.match((await f.send('/watch')).last.text, /весь район \(Stormarn\)/u);
  } finally { f.close(); }
});

test('#057 the whole-Kreis watch search keeps to the provider budget', async () => {
  const f = await fixture({ HOUSING_WATCH_ENABLED:'true', TELEGRAM_PROVIDER_SUBREQUEST_BUDGET:'5' });
  try {
    let calls = 0;
    const transport = async () => { calls += 1; return new Response('<html></html>', { status:200, headers:{ 'content-type':'text/html' } }); };
    const run = await handleHousingWatchRun(new Request(`https://outbox.internal${HOUSING_WATCH_RUN_PATH}`, { method:'POST', body:JSON.stringify({ criteria:KREIS }) }), f.object, { transport });
    assert.equal(run.status, 200);
    assert.ok(calls > 0 && calls <= 5, String(calls));
  } finally { f.close(); }
  assert.match(watchMessage(KREIS, []), /Trittau, весь район \(Stormarn\)/u);
});

test('#057 the command menu leaves out /scanner, /premium and /watch while their feature is off', async () => {
  const names = env => botCommandsFor(env).map(item => item.command);
  assert.deepEqual(names({}).filter(name => ['scanner', 'premium', 'watch'].includes(name)), []);
  assert.deepEqual(names({ AI_ASSISTANT_ENABLED:'true', HOUSING_WATCH_ENABLED:'true', AI_PREMIUM_ENABLED:'false' }).filter(name => ['scanner', 'premium', 'watch'].includes(name)), ['watch', 'scanner']);
  assert.equal(botCommandsFor({ AI_ASSISTANT_ENABLED:'true', HOUSING_WATCH_ENABLED:'true', AI_PREMIUM_ENABLED:'true' }).length, BRANDED_BOT_COMMANDS.length);
  assert.equal(names({ AI_PREMIUM_ENABLED:'true' }).includes('premium'), false, 'Premium needs the AI module too');
  resetBotCommandSyncForTests();
  const sent = [];
  const transport = async (url, options) => { if (String(url).endsWith('/setMyCommands')) sent.push(JSON.parse(options.body).commands); return new Response(JSON.stringify({ ok:true, result:true }), { status:200 }); };
  await syncBotCommandMetadata({ token:`123456789:${'A'.repeat(35)}` }, transport, null, { commands:botCommandsFor({ AI_ASSISTANT_ENABLED:'true' }) });
  assert.ok(sent.length > 0);
  assert.ok(sent.every(commands => !commands.some(item => item.command === 'premium')));
  resetBotCommandSyncForTests();
});

test('#057 the landlord letter names the household size from the card; it stays inside Workers AI', async () => {
  assert.equal(householdSize(CARD), 4);
  assert.equal(householdSize("Склад сім'ї: 3"), 3, 'the ASCII apostrophe of the real card producer');
  assert.equal(householdSize('Осіб: 2'), 2);
  assert.equal(householdSize('Склад сім’ї: 99'), null);
  assert.match(landlordLetterTemplate(CARD), /Wir sind 4 Personen/u);
  assert.match(landlordLetterTemplate('🏠 Wohnung'), /\[Anzahl der Personen\] Personen/u);
  const prompts = [];
  await writeLandlordLetter({ AI:{ async run(model, input) { prompts.push(input.messages.at(-1).content); return { response:'Sehr geehrte Damen und Herren' }; } } }, CARD);
  assert.match(prompts[0], /Personen im Haushalt: 4/u);
  const bodies = [];
  await writeLandlordLetter({ AI:{ async run() { throw new Error('down'); } }, AI_EXTERNAL_ENABLED:'true', GROQ_API_KEY:'g' }, CARD, async (url, options) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify({ choices:[{ message:{ content:'x' } }] }), { status:200 }); });
  assert.doesNotMatch(bodies[0].messages.at(-1).content, /Personen im Haushalt|Склад/u, 'the external fallback gets only price, place, rooms and area');
});
