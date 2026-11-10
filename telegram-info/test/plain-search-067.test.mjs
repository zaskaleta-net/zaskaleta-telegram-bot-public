import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// TG-RUNTIME-067 (full analysis 23.10.2026): "🔎 Пошук житла" asked only the
// paid Kleinanzeigen API (off), so every user got "провайдер ще не підключено".

const STAGING = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false', KLAZ_API_ENABLED:'false' };

function card(id, { city, plz, km, price }) {
  return `<article class="aditem" data-adid="${id}"><div class="aditem-main">
    <div>${plz} ${city}</div><div>(${km} km)</div>
    <h2><a href="/s-anzeige/3-zimmer-wohnung-${id}/${id}-203-922">3-Zimmer-Wohnung ${id}</a></h2>
    <p>71 m² · 3 Zi.</p><p>${price} €</p></div></article>`;
}

async function plainSearch(pages) {
  const f = await fixture(STAGING);
  const seen = [];
  const transport = async (url, options = {}) => {
    const target = String(url);
    if (!target.startsWith('https://api.telegram.org/')) {
      seen.push(target);
      const html = pages(target);
      if (html) return new Response(html, { headers:{ 'content-type':'text/html; charset=utf-8' } });
    }
    return f.transport(url, options);
  };
  try {
    await handle(f.request('🔎 Trittau · 3-4 · 950 · K · 15km'), f.env, NOW, transport);
    const texts = f.calls.map(call => String(call.body?.text || call.body?.caption || '')).join('\n---\n');
    return { texts, seen };
  } finally { f.close(); }
}

test('#067 the plain search uses the public sources and shows a listing', async () => {
  const { texts, seen } = await plainSearch(url => (url.includes('s-suchanfrage.html')
    ? `<html><body>${card('3497859117', { city:'Ahrensburg', plz:'22926', km:'12,6', price:887 })}</body></html>` : null));
  assert.ok(seen.some(url => url.includes('kleinanzeigen.de')), 'Kleinanzeigen public pages are asked');
  assert.doesNotMatch(texts, /провайдер ще не підключено/u);
  assert.match(texts, /3-Zimmer-Wohnung 3497859117/u);
});

test('#067 with every source down the user gets a clear unavailable or empty text, not the provider notice', async () => {
  const { texts } = await plainSearch(() => null);
  assert.doesNotMatch(texts, /провайдер ще не підключено/u);
  assert.match(texts, /тимчасово недоступний|не знайдено/u);
});

test('#067 more than 5 listings: 5 cards and the rest named, with the Jobcenter path', async () => {
  const cards = Array.from({ length:8 }, (_, index) => card(String(3497859100 + index), { city:'Trittau', plz:'22946', km:'1', price:700 + index }));
  const { texts } = await plainSearch(url => (url.includes('s-suchanfrage.html') ? `<html><body>${cards.join('')}</body></html>` : null));
  assert.match(texts, /Ще знайдено: 3\./u);
  assert.match(texts, /«🏛 Житло під Jobcenter»/u);
});
