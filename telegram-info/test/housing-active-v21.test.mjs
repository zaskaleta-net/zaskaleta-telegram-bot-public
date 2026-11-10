import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBuesumHousingText,
  housingActiveTransport
} from '../src/worker-entry-pilot-v21.mjs';

test('active v21 runtime canonicalizes Büsum aliases in natural housing text', () => {
  const original = "Житло для сім'ї двое дітей та двое дорослих бюзум";
  const normalized = normalizeBuesumHousingText(original);
  assert.match(normalized, /^Büsum житло /u);
  assert.doesNotMatch(normalized, /бюзум/iu);
});

test('active v21 housing transport keeps specialized reply keyboards user-collapsible', async () => {
  let captured = null;
  const transport = async (_url, options = {}) => {
    if (typeof options.body === 'string') captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok:true, result:{ message_id:1 } }), {
      status:200,
      headers:{ 'content-type':'application/json' }
    });
  };
  const wrapped = housingActiveTransport(transport);
  await wrapped('https://api.telegram.org/bot123:ABC/sendMessage', {
    method:'POST',
    body:JSON.stringify({
      chat_id:1,
      text:'Меню',
      reply_markup:{
        keyboard:[[{ text:'🏠 Житло' }]],
        resize_keyboard:true,
        one_time_keyboard:true,
        is_persistent:true
      }
    })
  });
  assert.equal(captured.reply_markup.one_time_keyboard, false);
  assert.equal(captured.reply_markup.is_persistent, false);
});

test('active v21 housing fallback upgrades to direct listing and Ukrainian summary', async () => {
  let telegramPayload = null;
  const transport = async (url, options = {}) => {
    const target = String(url || '');
    // ImmoScout24 is no longer fetched automatically (401 from Cloudflare);
    // the fallback upgrades from the KIP public source instead.
    assert.doesNotMatch(target, /immobilienscout24\.de/iu);
    if (/kip\.net\/schleswig-holstein\/buesum\/mieten\/wohnungen/iu.test(target)) {
      const url = '/schleswig-holstein/buesum/mieten/Wohnung_W1002';
      return new Response(`<div class="list-element"><h3><a href="${url}">3-Zimmer Wohnung in Büsum</a></h3>
        <h4>25761 Büsum</h4><dl><dt>71 m&sup2;</dt><dd>Wohnfläche</dd></dl>
        <dl><dt>3</dt><dd>Anzahl Zimmer</dd></dl><dl><dt>625,00 &#128;</dt><dd>Kaltmiete</dd></dl></div>`, {
        status:200,
        headers:{ 'content-type':'text/html; charset=utf-8' }
      });
    }
    if (/api\.telegram\.org/iu.test(target)) {
      telegramPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({ ok:true, result:{ message_id:1 } }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    return new Response('not found', { status:404 });
  };

  const wrapped = housingActiveTransport(transport);
  await wrapped('https://api.telegram.org/bot123:ABC/sendMessage', {
    method:'POST',
    body:JSON.stringify({
      chat_id:1,
      text:[
        '🔎 Автопошук житла під Jobcenter — Büsum',
        'Кімнати: 3-4',
        'Орієнтир Bruttokaltmiete: до 900 € Bruttokaltmiete',
        'Радіус пошуку: 15 км.',
        '🔎 Автоматичний пошук виконано через доступні відкриті житлові джерела.'
      ].join('\n')
    })
  });

  assert.ok(telegramPayload);
  assert.match(telegramPayload.text, /🔎 Активний пошук оголошень виконано\./u);
  assert.match(telegramPayload.text, /🇺🇦 Коротко:/u);
  assert.match(JSON.stringify(telegramPayload.reply_markup), /kip\.net\/schleswig-holstein\/buesum\/mieten\/Wohnung_W1002/u);
});


test('active v21 fallback renders each public search label only once', async () => {
  let telegramPayload = null;
  const transport = async (url, options = {}) => {
    const target = String(url || '');
    if (/api\.telegram\.org/iu.test(target)) {
      telegramPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({ ok:true, result:{ message_id:1 } }), {
        status:200,
        headers:{ 'content-type':'application/json' }
      });
    }
    return new Response('<html><body><div class="aditem">Keine passenden Treffer</div></body></html>', {
      status:200,
      headers:{ 'content-type':'text/html; charset=utf-8' }
    });
  };

  const wrapped = housingActiveTransport(transport);
  await wrapped('https://api.telegram.org/bot123:ABC/sendMessage', {
    method:'POST',
    body:JSON.stringify({
      chat_id:1,
      text:[
        '🔎 Автопошук житла під Jobcenter — Kiel',
        'Кімнати: 3',
        'Орієнтир Jobcenter Kiel: до 679 € Bruttokaltmiete',
        'Радіус пошуку: 15 км.',
        '🔎 Автоматичний пошук виконано через доступні відкриті житлові джерела.'
      ].join('\n')
    })
  });

  assert.ok(telegramPayload);
  const labels = (telegramPayload.reply_markup?.inline_keyboard || [])
    .flat()
    .map(button => String(button?.text || ''));
  assert.equal(labels.filter(label => label === '↗ Kleinanzeigen · публічний пошук').length, 1);
});
