import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeatherBriefV2, extractNahTransportItemsV2, buildMorningBriefV2 } from '../src/morning-brief-v2.mjs';
import { sendSafeNewsDigestToChatV2, NEWS_BUILD_NOTICE } from '../src/news-quality-v2.mjs';

const NOW = Date.UTC(2026, 8, 14, 8, 0, 0);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers:{ 'content-type':'application/json' } });
}

function weatherPayload() {
  return [
    { daily:{ weather_code:[61], temperature_2m_max:[18.2], temperature_2m_min:[9.1], precipitation_probability_max:[70], wind_gusts_10m_max:[42] } },
    { daily:{ weather_code:[3], temperature_2m_max:[17.4], temperature_2m_min:[10.3], precipitation_probability_max:[35], wind_gusts_10m_max:[37] } },
    { daily:{ weather_code:[61], temperature_2m_max:[18.8], temperature_2m_min:[10.2], precipitation_probability_max:[60], wind_gusts_10m_max:[39] } },
    { daily:{ weather_code:[2], temperature_2m_max:[16.6], temperature_2m_min:[8.4], precipitation_probability_max:[20], wind_gusts_10m_max:[45] } }
  ];
}

const nahHtml = `
  <section>
    <p>14.09.2026</p>
    <a href="/de/verkehrsmeldungen/bauarbeiten-kiel/">Bauarbeiten im Bahnverkehr zwischen Kiel und Neumünster</a>
    <p>01.09.2026</p>
    <a href="/de/verkehrsmeldungen/alte-stoerung/">Störung im Zugverkehr aus der Vorwoche</a>
  </section>`;

test('weather brief summarizes representative Schleswig-Holstein points', async () => {
  const transport = async url => {
    assert.match(String(url), /api\.open-meteo\.com\/v1\/dwd-icon/u);
    return json(weatherPayload());
  };
  const result = await buildWeatherBriefV2(transport);
  assert.equal(result.min, 8);
  assert.equal(result.max, 19);
  assert.equal(result.maxRain, 70);
  assert.equal(result.maxGust, 45);
  assert.match(result.text, /дощі/u);
  assert.match(result.detail, /Trittau 9…18°/u);
  assert.match(result.detail, /Kiel 10…17°/u);
});

test('NAH.SH parser keeps fresh transport notice and ignores stale one', () => {
  const items = extractNahTransportItemsV2(nahHtml, 'https://www.nah.sh/', NOW);
  assert.equal(items.length, 1);
  assert.match(items[0].title, /Bauarbeiten/u);
  assert.match(items[0].link, /^https:\/\/www\.nah\.sh\//u);
});

test('morning brief contains weather transport and today sections with Ukrainian transport localization', async () => {
  const env = {
    AI:{
      async run() {
        return { translated_text:'Будівельні роботи на залізниці між Кілем і Ноймюнстером' };
      }
    }
  };
  const transport = async url => {
    const target = String(url);
    if (target.includes('api.open-meteo.com')) return json(weatherPayload());
    if (target === 'https://www.nah.sh/') return new Response(nahHtml, { status:200, headers:{ 'content-type':'text/html' } });
    throw new Error(`unexpected ${target}`);
  };
  const text = await buildMorningBriefV2(env, NOW, transport);
  assert.match(text, /🌤 ПОГОДА SCHLESWIG-HOLSTEIN/u);
  assert.match(text, /🚆 ВАЖЛИВІ ТРАНСПОРТНІ ЗМІНИ/u);
  assert.match(text, /📅 ЩО ВАЖЛИВО СЬОГОДНІ/u);
  assert.match(text, /Будівельні роботи/u);
  assert.match(text, /DWD ICON/u);
  assert.match(text, /NAH\.SH/u);
  // The notice link is a button on the message, not a raw URL in the text.
  assert.doesNotMatch(text, /https?:\/\//u);
});

test('morning enrichment returns null when both auxiliary sources are unavailable', async () => {
  const transport = async () => new Response('unavailable', { status:503 });
  const result = await buildMorningBriefV2({}, NOW, transport);
  assert.equal(result, null);
});

test('quality digest sends header plus morning brief even when no news cards survive', async () => {
  const telegramPayloads = [];
  const notices = [];
  const transport = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/deleteMessage')) {
      notices.push(['deleted', JSON.parse(options.body).message_id]);
      return json({ ok:true, result:true });
    }
    if (target.endsWith('/sendMessage') && JSON.parse(options.body).text === NEWS_BUILD_NOTICE) {
      notices.push(['sent', 900]);
      return json({ ok:true, result:{ message_id:900, chat:{ id:JSON.parse(options.body).chat_id } } });
    }
    if (target.includes('api.telegram.org')) {
      telegramPayloads.push(JSON.parse(options.body));
      return json({ ok:true, result:{ message_id:100 + telegramPayloads.length, chat:{ id:-100 } } });
    }
    if (target.includes('api.open-meteo.com')) return json(weatherPayload());
    if (target === 'https://www.nah.sh/') return new Response('<p>14.09.2026</p><div>Keine aktuellen Meldungen</div>', { status:200, headers:{ 'content-type':'text/html' } });
    return new Response('unavailable', { status:503 });
  };

  const result = await sendSafeNewsDigestToChatV2(
    { token:'test', chatIds:[-100] },
    -100,
    {},
    NOW,
    transport
  );

  assert.deepEqual(notices, [['sent', 900], ['deleted', 900]], 'a notice is shown while the digest is built, then removed');
  assert.equal(result.ok, true);
  assert.equal(result.sent, 2);
  assert.equal(result.cardSent, 0);
  assert.equal(result.morningSent, true);
  assert.equal(result.reason, 'brief_only');
  assert.equal(telegramPayloads.length, 2);
  assert.match(telegramPayloads[0].text, /Ранковий огляд/u);
  assert.match(telegramPayloads[1].text, /🌤 ПОГОДА SCHLESWIG-HOLSTEIN/u);
  // No fresh NAH.SH notice: the transport block is left out, not filled
  // with a "nothing found" line, and no fixed reminder is added.
  assert.doesNotMatch(telegramPayloads[1].text, /ТРАНСПОРТНІ ЗМІНИ|свіжих загальних попереджень|Termin у Jobcenter/u);
  assert.match(telegramPayloads[1].text, /📅 ЩО ВАЖЛИВО СЬОГОДНІ\n• ☔ Висока ймовірність опадів/u);
});

test('a digest with a fresh NAH.SH notice carries a NAH.SH button on the morning message', async () => {
  const { buildSafeNewsPublicationV2 } = await import('../src/news-quality-v2.mjs');
  const transport = async url => {
    const target = String(url);
    if (target.includes('api.open-meteo.com')) return json(weatherPayload());
    if (target === 'https://www.nah.sh/') return new Response(nahHtml, { status:200, headers:{ 'content-type':'text/html' } });
    return new Response('unavailable', { status:503 });
  };
  const publication = await buildSafeNewsPublicationV2({ AI:{ async run() { return { translated_text:'Будівельні роботи між Кілем і Ноймюнстером' }; } } }, NOW, transport);
  const morning = publication.items.find(item => item.key === 'morning');
  assert.match(morning.payload.text, /🚆 ВАЖЛИВІ ТРАНСПОРТНІ ЗМІНИ/u);
  assert.deepEqual(morning.payload.reply_markup.inline_keyboard, [[{ text:'🚆 NAH.SH — зміни в русі', url:'https://www.nah.sh/' }]]);
});
