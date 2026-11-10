import test from 'node:test';
import assert from 'node:assert/strict';
import { searchKleinanzeigenPublicRecovery as expanded } from '../src/housing-kleinanzeigen-public-expanded.mjs';
import { opsReportText, opsSourceKeys } from '../src/ops-metrics.mjs';

// TG-RUNTIME-068 (Workers Logs 20.–23.10.2026): Kleinanzeigen public answered
// 403 on 2530 of 2981 page requests; every run still sent 8 requests, and the
// daily report gave no warning because the source answered 67 of 384 runs.

const criteria = { location:'Trittau', rooms:'3-4', amount:943.8, radiusKm:15, type:'Bruttokaltmiete' };

test('#068 a 403 is a block: no fallback page, no further supplemental batch', async () => {
  const calls = [];
  const result = await expanded(criteria, async url => { calls.push(String(url)); return new Response('Forbidden', { status:403 }); },
    { budgetMs:4500, targetDirectListings:12, maxSupplementalPages:6 });
  assert.equal(result.status, 'blocked');
  assert.ok(result.pages.every(page => page.reason === 'blocked'), JSON.stringify(result.pages));
  // strict page + the first supplemental batch (4), which starts at once; before: 8
  assert.ok(calls.length <= 5, String(calls.length));
});

test('#068 a readable page still works as before', async () => {
  const html = '<html><body><article class="aditem" data-adid="3497859117"><div class="aditem-main"><div>22926 Ahrensburg</div><div>(12,6 km)</div><h2><a href="/s-anzeige/x/3497859117-203-922">3-Zimmer-Wohnung</a></h2><p>71 m² · 3 Zi.</p><p>887 €</p></div></article></body></html>';
  const result = await expanded(criteria, async url => new Response(String(url).includes('s-suchanfrage.html') ? html : '<html></html>', { headers:{ 'content-type':'text/html' } }),
    { budgetMs:4500, targetDirectListings:12, maxSupplementalPages:0 });
  assert.equal(result.status, 'ok');
  assert.equal(result.listings.length, 1);
});

test('#068 a blocked source counts as failed, and a mostly failing source is warned about', () => {
  assert.deepEqual(opsSourceKeys([{ source:'Kleinanzeigen public', status:'blocked', pages:[{ reason:'blocked', httpStatus:403 }] }]), ['src_fail:kleinanzeigen_public']);
  const text = opsReportText({ day:'2026-10-22', counts:{ 'src_ok:kleinanzeigen_public':67, 'src_fail:kleinanzeigen_public':317, 'src_ok:ohne_makler':384 } });
  assert.match(text, /⚠️ Джерело Kleinanzeigen відповідає рідко: 67 з 384 спроб/u);
  assert.doesNotMatch(text, /Ohne-Makler відповідає рідко/u);
  assert.doesNotMatch(opsReportText({ day:'2026-10-22', counts:{ 'src_ok:kleinanzeigen_public':300, 'src_fail:kleinanzeigen_public':20 } }), /відповідає рідко/u);
});
