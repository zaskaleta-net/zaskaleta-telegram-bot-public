import test from 'node:test';
import assert from 'node:assert/strict';
import { searchKleinanzeigenPublicRecovery } from '../src/housing-kleinanzeigen-public-recovery-base.mjs';

function response(html){ return new Response(html,{status:200,headers:{'content-type':'text/html; charset=utf-8'}}); }
function card(){
  return `<article class="aditem" data-adid="777001">
    <a href="/s-anzeige/helle-3-zimmer-wohnung-rendsburg/777001-203-477"><img src="https://img.kleinanzeigen.de/api/v1/prod-ads/images/777001.jpg"></a>
    <div>24768 Rendsburg</div>
    <h2><a href="/s-anzeige/helle-3-zimmer-wohnung-rendsburg/777001-203-477">Helle 3-Zimmer-Wohnung in Rendsburg</a></h2>
    <p>70 m² · 3 Zi.</p><p>570 €</p>
  </article>`;
}

test('strict recognized zero does not suppress fallback Rendsburg catalog recovery', async () => {
  const fetched=[];
  const result=await searchKleinanzeigenPublicRecovery(
    {location:'Rendsburg',rooms:'3',amount:645.75,radiusKm:15},
    async url=>{
      const s=String(url); fetched.push(s);
      if(s.includes('s-suchanfrage.html')) return response('<article class="aditem"><p>recognized but changed markup</p></article>');
      if(s.includes('/s-wohnung-mieten/rendsburg/')) return response(card());
      return response('<html><body>Keine Treffer</body></html>');
    }
  );
  assert.equal(result.status,'ok');
  assert.equal(result.listings.length,1);
  assert.equal(result.listings[0].price,570);
  assert.ok(fetched.some(url=>url.includes('/s-wohnung-mieten/rendsburg/')));
});
