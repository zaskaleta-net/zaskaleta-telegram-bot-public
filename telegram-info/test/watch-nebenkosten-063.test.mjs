import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, USER, json } from './runtime-fixture.mjs';
import { handleHousingWatchStorage, compactListing, HOUSING_WATCH_PATH, HOUSING_WATCH_PREFIX } from '../src/housing-watch.mjs';
import { parseKleinanzeigenAdCosts, kleinanzeigenAdId } from '../src/kleinanzeigen-ad-costs.mjs';

// TG-RUNTIME-063 (owner, 19.10.2026): Bad Oldesloe, 820 € Kaltmiete +
// 150 € Nebenkosten = 970 € > 943,80 € (4 persons) was sent as fitting.

const KREIS_TRITTAU = { location:'Trittau', persons:4, rooms:'3-4', radius:'kreis' };
const GROUP = 'trittau|4|3-4|kreis';
const KEY = `${HOUSING_WATCH_PREFIX}${USER}:${USER}`;
const ENV = { TELEGRAM_BOT_TOKEN:`123456789:${'A'.repeat(35)}`, TELEGRAM_WEBHOOK_SECRET:'B'.repeat(40), TELEGRAM_RELEASE_APPROVED:'pilot-v1', TELEGRAM_PILOT_MODE:'allowlist', TELEGRAM_ALLOWED_CHAT_IDS:String(USER) };

const OLDESLOE = { key:'u:oldesloe', url:'https://www.kleinanzeigen.de/s-anzeige/zwei-zimmerwohnung/3500000001-203-1234', title:'Zwei Zimmerwohnung', price:820, rooms:'3', areaSqm:70, location:'23843 Bad Oldesloe', limit:943.8 };
const REINBEK = { key:'u:reinbek', url:'https://www.kleinanzeigen.de/s-anzeige/3-zimmerwohnung-in-reinbek/3500000002-203-1234', title:'3- Zimmerwohnung in Reinbek', price:952, rooms:'3', areaSqm:68, location:'21465 Reinbek', limit:1138.5 };

function adPage(id, attributes) {
  return `<html><script>var x={"adid":"${id}","ad_attributes":"${attributes}"};</script><body>…</body></html>`;
}
const PAGES = {
  3500000001: adPage('3500000001', 'nebenkosten_i:150|qm_d:70.00|heizkosten_i:200|kaution_i:2400|zimmer_d:3.0'),
  3500000002: adPage('3500000002', 'nebenkosten_i:137|heizkosten_i:85|warmmiete_i:1174|zimmer_d:3.0')
};

function memoryStorage(entries = []) {
  const data = new Map(entries);
  return {
    data,
    async get(key) { return structuredClone(data.get(key)); },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { return data.delete(key); },
    async list({ prefix = '', limit = Infinity } = {}) { return new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit)); }
  };
}
const watch = () => [KEY, { criteria:KREIS_TRITTAU, baseline:true, seen:[], interval:'m15', createdAt:NOW - 86400000, updatedAt:NOW - 86400000, lastRunAt:0, expiresAt:NOW + 86400000 }];

function recorder({ pages = PAGES } = {}) {
  const calls = [];
  const transport = async (url, options = {}) => {
    const value = String(url);
    const id = kleinanzeigenAdId(value);
    if (id) {
      calls.push({ kind:'ad', id });
      return pages[id] ? new Response(pages[id], { headers:{ 'content-type':'text/html' } }) : new Response('gone', { status:404 });
    }
    const body = JSON.parse(options.body || '{}');
    calls.push({ kind:'telegram', method:value.split('/').at(-1), body });
    return json({ ok:true, result:{ message_id:1, chat:{ id:USER } } });
  };
  return { calls, transport };
}

function deliver(storage, listings, transport) {
  return handleHousingWatchStorage(new Request(`https://outbox.internal${HOUSING_WATCH_PATH}`, { method:'POST', body:JSON.stringify({ now:NOW, op:'deliver', group:GROUP, criteria:KREIS_TRITTAU, listings }) }), { householdContextStorage:storage, env:ENV }, { transport }).then(response => response.json());
}

test('#063 the ad page gives Nebenkosten; another ad page or no data gives nothing', () => {
  assert.deepEqual(parseKleinanzeigenAdCosts(PAGES[3500000001], '3500000001'), { nebenkosten:150, heizkosten:200, warmmiete:null });
  assert.equal(parseKleinanzeigenAdCosts(PAGES[3500000001], '3500000002'), null);
  assert.equal(parseKleinanzeigenAdCosts('<html>captcha</html>', '3500000001'), null);
  assert.equal(kleinanzeigenAdId(REINBEK.url), '3500000002');
  assert.equal(compactListing(OLDESLOE).limit, 943.8);
});

test('#063 a flat over the limit with its Nebenkosten is not sent; one within it shows the sum', async () => {
  const storage = memoryStorage([watch()]);
  const { calls, transport } = recorder();
  const result = await deliver(storage, [OLDESLOE, REINBEK], transport);
  assert.equal(result.sent, 1);
  assert.equal(result.overLimit, 1);
  const text = calls.find(call => call.method === 'sendMessage').body.text;
  assert.doesNotMatch(text, /Bad Oldesloe/u);
  assert.match(text, /Reinbek/u);
  assert.match(text, /Kaltmiete 952 € \+ Nebenkosten 137 € = 1089 € Bruttokaltmiete \(норма до 1138,50 €\)/u);
  assert.equal(storage.data.get(KEY).seen.length >= 2, true, 'both are remembered');
});

test('#063 when every new listing is over the limit nothing is sent, and they are not checked again', async () => {
  const storage = memoryStorage([watch()]);
  const first = recorder();
  const result = await deliver(storage, [OLDESLOE], first.transport);
  assert.equal(result.sent, 0);
  assert.equal(result.overLimit, 1);
  assert.equal(first.calls.filter(call => call.kind === 'telegram').length, 0);
  const again = recorder();
  await deliver(storage, [OLDESLOE], again.transport);
  assert.equal(again.calls.length, 0, 'seen: no ad page, no message');
});

test('#063 an ad page that cannot be read does not hide the listing; missing Nebenkosten are named', async () => {
  const storage = memoryStorage([watch()]);
  const { calls, transport } = recorder({ pages:{ 3500000002:adPage('3500000002', 'heizkosten_i:85|zimmer_d:3.0') } });
  const result = await deliver(storage, [OLDESLOE, REINBEK], transport);
  assert.equal(result.sent, 1);
  const text = calls.find(call => call.method === 'sendMessage').body.text;
  assert.match(text, /Bad Oldesloe/u, 'page 404: shown unchecked');
  assert.match(text, /Zwei Zimmerwohnung<\/a>\n[^\n]+\nNebenkosten не перевірено/u, 'TG-RUNTIME-064: the unread page is named');
  assert.match(text, /Nebenkosten в оголошенні не вказано/u);
});

test('#063 at most 10 ad pages per delivery call; the rest is shown as not checked', async () => {
  const storage = memoryStorage([watch()]);
  const pages = {};
  const many = Array.from({ length:15 }, (_, index) => {
    const id = String(3600000000 + index);
    pages[id] = adPage(id, 'nebenkosten_i:300|zimmer_d:3.0');
    return { ...OLDESLOE, key:`u:${index}`, url:`https://www.kleinanzeigen.de/s-anzeige/x/${id}-203-1` };
  });
  const { calls, transport } = recorder({ pages });
  const result = await deliver(storage, many, transport);
  assert.equal(calls.filter(call => call.kind === 'ad').length, 10);
  assert.equal(result.overLimit, 10);
  assert.match(calls.find(call => call.method === 'sendMessage').body.text, /Nebenkosten не перевірено/u);
});

test('#063 review: a price that is the Warmmiete is not counted twice; the flat is sent', async () => {
  // Live ad 3543937195 (Schwarzenbek): price 770 €, warmmiete_i:770, NK 155.
  const storage = memoryStorage([watch()]);
  const warm = { ...REINBEK, key:'u:warm', url:'https://www.kleinanzeigen.de/s-anzeige/schwarzenbek/3543937195-203-1', price:770, location:'21493 Schwarzenbek', limit:800 };
  const { calls, transport } = recorder({ pages:{ 3543937195:adPage('3543937195', 'nebenkosten_i:155|zimmer_d:3.0|warmmiete_i:770') } });
  const result = await deliver(storage, [warm], transport);
  assert.equal(result.sent, 1);
  assert.equal(result.overLimit, 0);
  const text = calls.find(call => call.method === 'sendMessage').body.text;
  assert.match(text, /Ціна 770 € — це Warmmiete/u);
  assert.doesNotMatch(text, /Kaltmiete 770/u);
});
