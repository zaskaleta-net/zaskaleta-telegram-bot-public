import test from 'node:test';
import assert from 'node:assert/strict';
import { withKleinanzeigenAdCosts, adCostsLine, adCostsOverLimit, kleinanzeigenAdId } from '../src/kleinanzeigen-ad-costs.mjs';
import { jobcenterPhotoCards } from '../src/runtime-housing-search.mjs';

// TG-RUNTIME-064 (owner, 19.10.2026: "щоб людям було зручно"): the normal
// housing search shows Kaltmiete + Nebenkosten on Kleinanzeigen cards too.

const ad = (id, attributes) => `<html><script>{"adid":"${id}","ad_attributes":"${attributes}"}</script></html>`;
const OLDESLOE = { url:'https://www.kleinanzeigen.de/s-anzeige/zwei-zimmerwohnung/3500000001-203-1234', title:'Zwei Zimmerwohnung', price:820, rooms:'3', areaSqm:70, location:'23843 Bad Oldesloe', source:'Kleinanzeigen', imageUrl:'https://img.kleinanzeigen.de/a.jpg' };
const OTHER = { url:'https://www.immobilienscout24.de/expose/123456', title:'Wohnung', price:700, rooms:'3', location:'Trittau', source:'ImmoScout24' };

function transportFor(pages, calls = []) {
  return async url => {
    const id = kleinanzeigenAdId(String(url));
    calls.push(String(url));
    return pages[id] ? new Response(pages[id], { headers:{ 'content-type':'text/html' } }) : new Response('gone', { status:404 });
  };
}

test('#064 search page: Kleinanzeigen cards get their costs, others are left as they are', async () => {
  const calls = [];
  const [oldesloe, other] = await withKleinanzeigenAdCosts([{ ...OLDESLOE, limit:943.8 }, { ...OTHER, limit:943.8 }], transportFor({ 3500000001:ad('3500000001', 'nebenkosten_i:150|heizkosten_i:200') }, calls));
  assert.deepEqual(oldesloe.costs, { nebenkosten:150, heizkosten:200, warmmiete:null });
  assert.equal(other.costs, undefined);
  assert.equal(calls.length, 1, 'only the Kleinanzeigen ad page');
  assert.equal(adCostsOverLimit(oldesloe), true);
  assert.equal(adCostsLine(oldesloe), "⛔ Kaltmiete 820 € + Nebenkosten 150 € = 970 € Bruttokaltmiete — вище норми 943,80 € для вашої сім'ї.");
});

test('#064 a page that cannot be read (or a used-up provider budget) is marked as not checked, never an error', async () => {
  const [item] = await withKleinanzeigenAdCosts([{ ...OLDESLOE, limit:943.8 }], async () => { throw new Error('Provider subrequest budget exhausted'); });
  assert.deepEqual(item.costs, { unchecked:true });
  assert.match(adCostsLine(item), /не перевірено/u);
});

test('#064 review follow-up: the Warmmiete line names the limit', () => {
  const line = adCostsLine({ price:770, limit:800, costs:{ nebenkosten:155, heizkosten:null, warmmiete:770 } });
  assert.match(line, /Ціна 770 € — це Warmmiete/u);
  assert.match(line, /норма до 800 €/u);
});

test('#064 the search card carries the line and stays within the Telegram caption limit', async () => {
  const listing = { ...OLDESLOE, title:'X'.repeat(300), location:'23843 Bad Oldesloe '.repeat(4), limit:943.8, costs:{ nebenkosten:150, heizkosten:200, warmmiete:null } };
  const criteria = { location:'Trittau', amount:943.8, rooms:'3-4', radiusKm:15, type:'Bruttokaltmiete' };
  const [card] = jobcenterPhotoCards({ status:'ok', listings:[listing], criteria }, { location:'Trittau', persons:4, rooms:{ label:'3-4' }, criteria }, 'Jobcenter Stormarn', 80);
  assert.match(card.caption, /⛔ Kaltmiete 820 € \+ Nebenkosten 150 € = 970 € Bruttokaltmiete — вище норми 943,80 €/u);
  const visible = card.caption.replace(/<[^>]+>/gu, '').replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"');
  assert.ok(visible.length <= 1024, String(visible.length));
});

test('#064 end to end: the Trittau 15 km search card shows the Ahrensburg Nebenkosten and the limit breach', async () => {
  const { handle } = await import('../src/runtime.mjs');
  const { fixture, NOW } = await import('./runtime-fixture.mjs');
  const f = await fixture();
  const card = `<article class="aditem" data-adid="3497859117"><div class="aditem-main">
    <div>22926 Ahrensburg</div><div>(12,6 km)</div>
    <h2><a href="/s-anzeige/sanierte-3-zimmerwohnung/3497859117-203-922">Sanierte 3-Zimmerwohnung</a></h2>
    <p>71 m² · 3 Zi.</p><p>887 €</p></div></article>`;
  const adPages = [];
  const transport = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('s-suchanfrage.html')) return new Response(`<html><body>${card}</body></html>`, { headers:{ 'content-type':'text/html; charset=utf-8' } });
    if (kleinanzeigenAdId(target) === '3497859117') {
      adPages.push(target);
      return new Response(ad('3497859117', 'nebenkosten_i:173|heizkosten_i:72|warmmiete_i:1132'), { headers:{ 'content-type':'text/html' } });
    }
    return f.transport(url, options);
  };
  try {
    await handle(f.request('', { callback:'jcr:15:4:3-4:Trittau' }), f.env, NOW, transport);
    const texts = f.calls.map(call => String(call.body?.text || call.body?.caption || '')).join('\n');
    assert.equal(adPages.length, 1, 'the ad page is read once');
    assert.match(texts, /Sanierte 3-Zimmerwohnung/u);
    assert.match(texts, /⛔ Kaltmiete 887 € \+ Nebenkosten 173 € = 1060 € Bruttokaltmiete — вище норми 943,80 €/u);
  } finally {
    f.close();
  }
});

test('#064 review: ad pages only use the time left in the search window; too little time → no request', async () => {
  const { adCostsTimeLeft } = await import('../src/kleinanzeigen-ad-costs.mjs');
  assert.equal(adCostsTimeLeft(1000, 12000, 1000 + 2000), 3000, 'fast search: the full 3 s');
  assert.equal(adCostsTimeLeft(1000, 12000, 1000 + 11000), 1000, 'slow search: only what is left');
  assert.equal(adCostsTimeLeft(1000, 12000, 1000 + 12500), 0);
  const calls = [];
  const [item] = await withKleinanzeigenAdCosts([{ ...OLDESLOE, limit:943.8 }], transportFor({}, calls), { timeoutMs:200 });
  assert.equal(calls.length, 0);
  assert.deepEqual(item.costs, { unchecked:true });
  const started = Date.now();
  const [slow] = await withKleinanzeigenAdCosts([{ ...OLDESLOE, limit:943.8 }], () => new Promise(() => {}), { timeoutMs:600 });
  assert.ok(Date.now() - started < 1500, 'a page that never answers does not hold the search');
  assert.deepEqual(slow.costs, { unchecked:true });
});
