import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_LIVE_HOUSING_SOURCES,
  parsePublicHousingPage,
  searchPublicHousingSources
} from '../src/housing-public-sources.mjs';

const warm = { location:'Itzehoe', rooms:'2-3', roomsMin:2, roomsMax:3, amount:800, type:'Warmmiete' };

const WANKENDORFER_HTML = `
<article>
  <h4>Helle Wohnung in attraktiver Lage</h4>
  <div>Stettiner Str. 18, 25524 Itzehoe</div>
  <div>Gesamtmiete</div><div>620,76 €</div>
  <div>Fläche</div><div>56,68 m²</div>
  <div>Zimmer</div><div>2,5</div>
</article>
<article>
  <h4>Zu teuer</h4>
  <div>Steinbrückstr. 10, 25524 Itzehoe</div>
  <div>Gesamtmiete</div><div>1.204,60 €</div>
  <div>Fläche</div><div>70,63 m²</div>
  <div>Zimmer</div><div>3</div>
</article>`;

const WOBAU_HTML = `
<div>Wohnung</div>
<h3>Preiswerte 4-Zimmer-Wohnung</h3>
<div>Weberstr. 35, 24537 Neumünster</div>
<div>65,06 m²</div>
<div>4 Zimmer</div>
<div>637,00 € Warmmiete</div>
<div>Mehr dazu</div>`;

const FAB_HTML = `
<div>Modernisierte Wohnung</div>
<div>Flensburg,</div>
<div>Michelsenstr. 9</div>
<div>3,0 Zimmer, 59 m²</div>
<div>753,00 €</div>
<div>Eigentumsangebot</div>
<div>Flensburg,</div>
<div>Ballastkai 6</div>
<div>2,0 Zimmer, 112 m²</div>
<div>849.000,00 €</div>`;

const WBG_HTML = `
<article>
<h3>*** Sehr schöne 3-Zimmer Wohnung mit Balkon*** WbS erforderlich***</h3>
<div>Poppenrade 25, 24148 Kiel-Ellerbek</div>
<div>Details</div>
<div>Wohnfläche:</div><div>71,55 m²</div>
<div>Zimmer:</div><div>3</div>
<div>Gesamtmiete:</div><div>710,08 €</div>
</article>
<article>
<h3>+++ANFRAGESTOPP+++ Tolle 2-Zimmer Wohnung</h3>
<div>Langer Rehm 53, 24149 Kiel</div>
<div>Wohnfläche:</div><div>61,00 m²</div>
<div>Zimmer:</div><div>2</div>
<div>Gesamtmiete:</div><div>735,00 €</div>
</article>`;

const LBV_HTML = `
<article>
<div>Wohnung</div>
<h5>23564 Lübeck</h5>
<div>Straße:</div><div>Ratzeburger Allee 10</div>
<div>Zimmer:</div><div>3</div>
<div>Fläche:</div><div>72,50 m²</div>
<div>Gesamtmiete:</div><div>890,00 €</div>
</article>`;

const WOBAU_OH_HTML = `
<div>575,00 € Kaltmiete per Monat</div>
<div>3 Zimmer, 81,75 m² Platanenhof 1</div>
<div>23758 Oldenburg Details ansehen</div>`;

const WODI_HTML = `
<h2>Hemmingstedt: 2-Zimmer-Wohnung</h2>
<div>Zimmer: 2</div><div>Wohnfläche: 44 m²</div><div>Kaltmiete: 290.00 EUR</div>
<h2>Brunsbüttel: Sonnige 3-Zimmer-Wohnung mit Balkon</h2>
<div>Zimmer: 3</div><div>Wohnfläche: 65 m²</div><div>Kaltmiete: 371.07 EUR</div>`;

test('public live source catalog is bounded and contains only approved pages', () => {
  assert.equal(PUBLIC_LIVE_HOUSING_SOURCES.length, 8);
  assert.deepEqual(PUBLIC_LIVE_HOUSING_SOURCES.map(x => x.id), [
    'wankendorfer','wobau-neumuenster','fab','wbg-kiel-ost','luebecker-bauverein','wobau-ostholstein','wodi-dithmarschen','trave-luebeck'
  ]);
  for (const source of PUBLIC_LIVE_HOUSING_SOURCES) assert.match(source.url, /^https:\/\//);
});

test('Wankendorfer parser extracts matching public rental offers conservatively', () => {
  const listings = parsePublicHousingPage('wankendorfer', WANKENDORFER_HTML, warm);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].source, 'Wankendorfer');
  assert.equal(listings[0].price, 620.76);
  assert.equal(listings[0].rooms, 2.5);
  assert.equal(listings[0].areaSqm, 56.68);
  assert.match(listings[0].location, /25524 Itzehoe/);
});

test('WOBAU parser respects exact location, room and price filters', () => {
  const criteria = { location:'Neumünster', rooms:4, amount:700, type:'Warmmiete' };
  const listings = parsePublicHousingPage('wobau-neumuenster', WOBAU_HTML, criteria);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 637);
  assert.equal(listings[0].rooms, 4);
  assert.equal(listings[0].priceType, 'Warmmiete');
  assert.equal(parsePublicHousingPage('wobau-neumuenster', WOBAU_HTML, { ...criteria, location:'Kiel' }).length, 0);
});

test('FAB parser excludes obvious purchase prices and keeps rental-scale offers', () => {
  const criteria = { location:'Flensburg', rooms:'2-3', roomsMin:2, roomsMax:3, amount:900, type:'Warmmiete' };
  const listings = parsePublicHousingPage('fab', FAB_HTML, criteria);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 753);
  assert.equal(listings[0].rooms, 3);
  assert.equal(listings[0].areaSqm, 59);
});

test('WBG Kiel-Ost parser excludes ANFRAGESTOPP listings', () => {
  const criteria = { location:'Kiel', rooms:'2-3', roomsMin:2, roomsMax:3, amount:900, type:'Warmmiete' };
  const listings = parsePublicHousingPage('wbg-kiel-ost', WBG_HTML, criteria);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 710.08);
  assert.equal(listings[0].rooms, 3);
  assert.equal(listings[0].areaSqm, 71.55);
  assert.doesNotMatch(listings[0].title, /ANFRAGESTOPP/i);
});

test('Lübecker Bauverein parser extracts address and Gesamtmiete', () => {
  const criteria = { location:'Lübeck', rooms:3, amount:1000, type:'Warmmiete' };
  const listings = parsePublicHousingPage('luebecker-bauverein', LBV_HTML, criteria);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 890);
  assert.equal(listings[0].rooms, 3);
  assert.equal(listings[0].areaSqm, 72.5);
  assert.match(listings[0].location, /Ratzeburger Allee 10/);
  assert.match(listings[0].location, /23564 Lübeck/);
});

test('WOBAU Ostholstein parser extracts Kaltmiete, rooms and area', () => {
  const criteria = { location:'Oldenburg', rooms:3, amount:700, type:'Kaltmiete' };
  const listings = parsePublicHousingPage('wobau-ostholstein', WOBAU_OH_HTML, criteria);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 575);
  assert.equal(listings[0].rooms, 3);
  assert.equal(listings[0].areaSqm, 81.75);
  assert.equal(listings[0].priceType, 'Kaltmiete');
  assert.match(listings[0].location, /23758 Oldenburg/);
});

test('Wohnungsunternehmen Dithmarschen parser supports EUR and excludes nonmatching towns', () => {
  const criteria = { location:'Brunsbüttel', rooms:3, amount:500, type:'Kaltmiete' };
  const listings = parsePublicHousingPage('wodi-dithmarschen', WODI_HTML, criteria);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 371.07);
  assert.equal(listings[0].rooms, 3);
  assert.equal(listings[0].areaSqm, 65);
  assert.equal(listings[0].priceType, 'Kaltmiete');
  assert.match(listings[0].title, /Brunsbüttel/);
});

test('public source network keeps independent providers isolated', async () => {
  const calls = [];
  const response = (html, url) => {
    const result = new Response(html, { status:200, headers:{'content-type':'text/html; charset=utf-8'} });
    Object.defineProperty(result, 'url', { value:url });
    return result;
  };
  const transport = async (url, options={}) => {
    calls.push({url, options});
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'follow');
    if (url.includes('wbg-kiel-ost')) return response(WBG_HTML, url);
    if (url.includes('wankendorfer') || url.includes('wobau-oh') || url.includes('wo-di')) return response('<html>no matching offers</html>', url);
    throw new Error('unexpected provider: ' + url);
  };
  const result = await searchPublicHousingSources({ location:'Kiel', rooms:3, amount:900, type:'Warmmiete' }, transport);
  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 4);
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].sourceId, 'wbg-kiel-ost');
});

test('global public sources stay available when no location-specific source applies', async () => {
  const calls = [];
  const response = (html, url) => {
    const result = new Response(html, { status:200, headers:{'content-type':'text/html'} });
    Object.defineProperty(result, 'url', { value:url });
    return result;
  };
  const result = await searchPublicHousingSources(warm, async (url, options={}) => {
    calls.push(url);
    assert.equal(options.method, 'GET');
    if (url.includes('wankendorfer')) return response(WANKENDORFER_HTML, url);
    return response('<html>no matching offers</html>', url);
  });
  assert.equal(calls.length, 3);
  assert.equal(result.listings.length, 1);
});

