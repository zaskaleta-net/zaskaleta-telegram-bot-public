import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchLiveHousing,
  formatHousingListings,
  housingListingMedia,
  housingListingsMarkup
} from '../src/housing-provider.mjs';

const KEY = 'klaz_live_' + 'F'.repeat(24);
const criteria = { location:'Itzehoe', rooms:'2-3', roomsMin:2, roomsMax:3, amount:800, type:'Warmmiete', radiusKm:15 };

const wankendorfer = `
<article>
  <h4>Helle Wohnung in attraktiver Lage</h4>
  <div>Stettiner Str. 18, 25524 Itzehoe</div>
  <div>Gesamtmiete</div><div>620,76 €</div>
  <div>Fläche</div><div>56,68 m²</div>
  <div>Zimmer</div><div>2,5</div>
</article>`;

function json(value, status=200) {
  return new Response(JSON.stringify(value), { status, headers:{'content-type':'application/json'} });
}

function html(value, url='') {
  const result = new Response(value, { status:200, headers:{'content-type':'text/html; charset=utf-8'} });
  if (url) Object.defineProperty(result, 'url', { value:url });
  return result;
}

test('zero Kleinanzeigen results fall back only to location-relevant public housing sources', async () => {
  const calls = [];
  const transport = async (url, options={}) => {
    calls.push({url, options});
    if (url.includes('/locations?')) return json({success:true,data:{locations:[{id:'123',name:'Itzehoe'}]}});
    if (url.includes('api.kleinanzeigen-agent.de') && url.includes('/search?')) return json({success:true,data:{ads:[]}});
    if (url === 'https://www.wankendorfer.de/wohnungssuche/') return html(wankendorfer, url);
    throw new Error('unexpected URL ' + url);
  };

  const result = await searchLiveHousing(criteria, KEY, transport, {includePublic:true});
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'public_sources');
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].source, 'Wankendorfer');
  assert.equal(result.listings[0].price, 620.76);
  assert.equal(result.listings[0].priceType, 'Gesamtmiete');
  assert.equal(result.listings[0].publicSource, true);
  assert.equal(calls.length, 6);
  assert.deepEqual(result.publicSources, [{source:'wankendorfer',status:'ok',count:1}, {source:'wobau-ostholstein',status:'unavailable',count:0}, {source:'wodi-dithmarschen',status:'unavailable',count:0}]);

  const text = formatHousingListings(criteria, result);
  assert.match(text, /Kleinanzeigen не дав придатних результатів/);
  assert.match(text, /Wankendorfer/);
  assert.match(text, /620,76 €/);
  assert.match(text, /Gesamtmiete/);

  const media = housingListingMedia(result);
  assert.equal(media.length, 1);
  assert.equal(media[0].type, 'text');
  assert.equal(media[0].media, null);
  assert.match(media[0].caption, /Helle Wohnung in attraktiver Lage/u);
  assert.match(media[0].caption, /wankendorfer\.de\/wohnungssuche/u);
  const markup = housingListingsMarkup(result);
  assert.equal(markup.inline_keyboard[0][0].text, '1. Wankendorfer');
  assert.equal(markup.inline_keyboard[0][0].url, 'https://www.wankendorfer.de/wohnungssuche/');
});

test('existing Kleinanzeigen results short-circuit public-source requests', async () => {
  let publicCalls = 0;
  const transport = async url => {
    if (url.includes('/locations?')) return json({success:true,data:{locations:[{id:'123',name:'Itzehoe'}]}});
    if (url.includes('api.kleinanzeigen-agent.de') && url.includes('/search?')) {
      return json({success:true,data:{ads:[{
        ad_id:'77', title:'Helle 2 Zimmer Wohnung', description:'',
        price:{amount:700,price_type:'FIXED'}, status:'ACTIVE', deleted:false,
        ad_url:'https://www.kleinanzeigen.de/s-anzeige/helle-wohnung/77',
        location:{name:'Itzehoe'}, details:{Zimmer:'2'}
      }]}});
    }
    publicCalls++;
    return html('', url);
  };

  const result = await searchLiveHousing(criteria, KEY, transport, {includePublic:true});
  assert.equal(result.source, 'Kleinanzeigen');
  assert.equal(result.listings.length, 1);
  assert.equal(publicCalls, 0);
});

