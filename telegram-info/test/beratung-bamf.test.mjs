import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beratungPlace, beratungEntries, beratungReplyText, beratungKeyboard, fetchBeratung, clearBeratungCache, SH_KREISE, NAVI_PAGE } from '../src/beratung-bamf.mjs';
import { beratungCommand, isBeratungRequestUpdate } from '../src/beratung-command.mjs';
import { fixture } from './runtime-fixture.mjs';

const KIEL = JSON.parse(readFileSync(new URL('./fixtures/bamf-navi-beratung-kiel-2026-10-17.json', import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 9, 17, 9, 0, 0);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json' } });

test('a town or a Kreis name resolves to its Kreis key', () => {
  assert.deepEqual(beratungPlace('Elmshorn'), { kreis:'01056', kreisName:'Pinneberg', town:'Elmshorn' });
  assert.deepEqual(beratungPlace('kiel'), { kreis:'01002', kreisName:'Kiel', town:'Kiel' });
  assert.equal(beratungPlace('Nordfriesland').kreis, '01054');
  assert.equal(beratungPlace('Atlantis'), null);
  assert.equal(SH_KREISE.length, 15);
});

test('BAMF records: office, provider without address, phones; no e-mail is ever shown', () => {
  const entries = beratungEntries(KIEL, '01002');
  assert.equal(entries.length, 14);
  const jmd = entries.find(entry => entry.name === 'JMD Kiel (AWO)');
  assert.equal(jmd.provider, 'AWO Kreisverband Kiel e.V.');
  assert.equal(jmd.url, 'https://www.jugendmigrationsdienste.de/jmd/kielawo');
  const text = beratungReplyText(entries, beratungPlace('Kiel'));
  assert.doesNotMatch(text, /@|mail/iu);
  assert.match(text, /<b>Migrationsberatung für erwachsene Zugewanderte \(MBE\)<\/b> — для дорослих від 27 років/u);
  assert.match(text, /<b>Jugendmigrationsdienst \(JMD\)<\/b> — для молоді 12–27 років/u);
  assert.match(text, /• <a href="https:\/\/www\.jugendmigrationsdienste\.de\/jmd\/kielawo">JMD Kiel \(AWO\)<\/a> \(AWO Kreisverband Kiel e\.V\.\)\n   📍 Preetzer Str\. 35, 24143 Kiel\n   📞 0431 77570-66/u);
  assert.match(text, /📞 0431-77570-57 \/ 0431-77570-22/u);
  assert.match(text, /Джерело: BAMF-NAvI/u);
  assert.ok((text.match(/^• /gmu) || []).length <= 15);
});

test('records of another Kreis or an unknown type are dropped; an empty Kreis says so', () => {
  assert.equal(beratungEntries([{ ...KIEL[0], name:'29_Caritasverband für das Erzbistum Hamburg e.V.' }], '01002')[0].name, 'Caritasverband für das Erzbistum Hamburg e.V.');
  assert.deepEqual(beratungEntries([{ ...KIEL[0], ags:'01056025' }, { ...KIEL[0], typId:99 }], '01002'), []);
  assert.match(beratungReplyText([], beratungPlace('Kiel')), /консультаційних пунктів не знайдено/u);
});

test('the keyboard lists the 15 Kreise until one is chosen', () => {
  const choose = beratungKeyboard().inline_keyboard.flat();
  assert.equal(choose.filter(button => /^adv:01\d{3}$/u.test(button.callback_data || '')).length, 15);
  const chosen = beratungKeyboard(beratungPlace('Kiel')).inline_keyboard.flat();
  assert.ok(!chosen.some(button => /^adv:01/u.test(button.callback_data || '')));
  assert.ok(chosen.some(button => button.callback_data === 'adv:ask'));
  assert.ok(chosen.some(button => button.url === NAVI_PAGE));
  assert.ok(chosen.some(button => button.callback_data === 'nav:advice'));
});

test('BAMF answers are cached per Kreis; an outage is unavailable', async () => {
  clearBeratungCache();
  const urls = [];
  const transport = async url => { urls.push(String(url)); return json(KIEL); };
  assert.equal((await fetchBeratung('01002', transport, NOW)).entries.length, 14);
  assert.equal(urls[0], 'https://bamf-navi.bamf.de/atlas-backend/beratungseinrichtungen?ags=01002');
  assert.equal((await fetchBeratung('01002', transport, NOW + 60000)).cached, true);
  assert.equal(urls.length, 1);
  clearBeratungCache();
  assert.equal((await fetchBeratung('01002', async () => json({}, 503), NOW)).status, 'unavailable');
  clearBeratungCache();
});

test('requests: menu button, Kreis button, /beratung [Ort] — private chats only', () => {
  const message = (text, type = 'private') => ({ message:{ text, chat:{ id:5, type }, from:{ id:5 } } });
  assert.equal(isBeratungRequestUpdate(message('/beratung')), true);
  assert.equal(isBeratungRequestUpdate(message('/beratung Elmshorn')), true);
  assert.equal(isBeratungRequestUpdate(message('🤝 Консультації')), true);
  assert.equal(isBeratungRequestUpdate(message('/beratung', 'supergroup')), false);
  const callback = data => ({ callback_query:{ id:'q', data, message:{ chat:{ id:5, type:'private' } } } });
  assert.equal(isBeratungRequestUpdate(callback('nav:advice')), true);
  assert.equal(isBeratungRequestUpdate(callback('adv:01056')), true);
  assert.equal(isBeratungRequestUpdate(callback('adv:02000')), false);
});

test('through the runtime: menu shows the button, /beratung Kiel lists offices, unknown town asks again', async () => {
  clearBeratungCache();
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1' });
  try {
    const menu = await f.send('/menu');
    assert.ok((menu.last?.reply_markup?.inline_keyboard || []).flat().some(button => button.callback_data === 'nav:advice' && button.text === '🤝 Консультації'));
    const sent = [];
    const transport = async (url, options = {}) => {
      if (String(url).startsWith('https://api.telegram.org/')) { sent.push(JSON.parse(options.body)); return json({ ok:true, result:true }); }
      return json(KIEL);
    };
    await beratungCommand(f.request('/beratung Kiel'), f.env, NOW, transport);
    assert.match(sent.at(-1).text, /Безкоштовні консультації — Kiel/u);
    assert.equal(sent.at(-1).parse_mode, 'HTML');
    await beratungCommand(f.request('', { callback:'nav:advice' }), f.env, NOW, transport);
    assert.match(sent.at(-1).text, /Оберіть свій район/u);
    await beratungCommand(f.request('/beratung Atlantis'), f.env, NOW, transport);
    assert.match(sent.at(-1).text, /^Такого міста чи району в Schleswig-Holstein не знайдено — перевірте назву/u);
    const viaRuntime = await f.send('', { callback:'adv:01002' });
    assert.equal(viaRuntime.body.mode, 'beratung-v1');
  } finally { f.close(); clearBeratungCache(); }
});

test('"🔎 Пошук за містом": the next plain text is read as the town and resolved to its Kreis', async () => {
  const { BERATUNG_TOWN_PROMPT } = await import('../src/beratung-bamf.mjs');
  clearBeratungCache();
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1' });
  try {
    const asked = await f.send('', { callback:'adv:ask' });
    assert.equal(asked.last.text, BERATUNG_TOWN_PROMPT);
    const answer = await f.send('Elmshorn');
    assert.equal(answer.body.mode, 'beratung-v1');
    assert.ok(f.sourceCalls.some(url => url === 'https://bamf-navi.bamf.de/atlas-backend/beratungseinrichtungen?ags=01056'));
  } finally { f.close(); clearBeratungCache(); }
});

test('Hamburg has its own BAMF key; the Länderprogramm label is not tied to one Land', async () => {
  assert.deepEqual(beratungPlace('Гамбург'), { kreis:'02000', kreisName:'Hamburg', town:'Hamburg' });
  const entries = beratungEntries([{ ...KIEL[7], ags:'02000000' }], '02000');
  assert.equal(entries.length, 1);
  assert.match(beratungReplyText(entries, beratungPlace('Hamburg')), /Безкоштовні консультації — Hamburg[\s\S]*Migrationsberatungsstelle in einem Länderprogramm/u);
});
