import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseWankendorfer, parseTrave, parseWobauNeumuenster, searchHousingCompanies, companySourcesFor,
  placeCoordinates, distanceKm, germanNumber, addressParts, clearHousingCompanyCache,
  parseFab, parseWbgKielOst, parseLuebeckerBauverein, parseNeueLuebecker, parseWogeKiel, parseAdlershorst,
  parseBigVerwaltung, parseWodiDithmarschen, parseZbvv, parseHausUndGrundKiel, HOUSING_COMPANY_SOURCES, MAX_COMPANY_PAGES
} from '../src/housing-company-sources.mjs';
import { filterPrimaryListings } from '../src/housing-primary-search.mjs';
import { SH_PLACE_COORDINATES_META } from '../src/sh-place-coordinates.mjs';

// Real list pages, 14.10.2026, trimmed to a few cards.
const fixture = name => readFileSync(new URL(`./fixtures/${name}-list-2026-10-14.html`, import.meta.url), 'utf8');
const html = body => new Response(body, { status:200, headers:{ 'content-type':'text/html; charset=utf-8' } });

test('Wankendorfer cards: Gesamtmiete, town, area, photo; parking spaces are skipped', () => {
  const items = parseWankendorfer(fixture('wankendorfer'));
  assert.equal(items.length, 3, 'three flats, the parking space is not a flat');
  assert.deepEqual(
    { price:items[0].price, priceType:items[0].priceType, rooms:items[0].rooms, areaSqm:items[0].areaSqm, location:items[0].location },
    { price:772.71, priceType:'Gesamtmiete', rooms:'2', areaSqm:54.78, location:'23795 Bad Segeberg' }
  );
  assert.match(items[0].url, /^https:\/\/www\.wankendorfer\.de\/wohnungssuche\/wohnungsangebot-detail\//u);
  assert.match(items[0].imageUrl, /^https:\/\/www\.wankendorfer\.de\/fileadmin\//u);
});

test('TRAVE cards: Nettokaltmiete and district in the location', () => {
  const items = parseTrave(fixture('trave'));
  assert.equal(items.length, 2);
  assert.equal(items[0].price, 956.1);
  assert.equal(items[0].priceType, 'Nettokaltmiete');
  assert.equal(items[0].rooms, '2.5');
  assert.equal(items[0].location, '23556 Lübeck (St. Lorenz Nord)');
  assert.match(items[0].url, /^https:\/\/www\.trave\.de\/interessenten\/wohnung-mieten\?.*record%5D=636/u);
  assert.doesNotMatch(items[0].url, /&amp;/u);
});

test('WOBAU Neumünster cards: Warmmiete', () => {
  const items = parseWobauNeumuenster(fixture('wobau-neumuenster'));
  assert.equal(items.length, 3);
  assert.deepEqual([items[0].price, items[0].priceType, items[0].areaSqm, items[0].location], [839, 'Warmmiete', 73.36, '24534 Neumünster']);
});

test('number and address helpers', () => {
  assert.equal(germanNumber('1.650,00 €'), 1650);
  assert.equal(germanNumber('772.71'), 772.71);
  assert.equal(germanNumber('66,86 m²'), 66.86);
  assert.equal(germanNumber('1.029 €'), 1029, 'a dot before three digits is a thousands separator');
  assert.equal(germanNumber('1.442.760'), 1442760);
  assert.equal(germanNumber('262.29 EUR'), 262.29);
  assert.deepEqual(addressParts('Rumpelstilzchenweg 11, 23560 Lübeck (Moisling)'), { postcode:'23560', town:'Lübeck', location:'23560 Lübeck (Moisling)' });
});

test('pinned coordinates give plausible distances', () => {
  assert.ok(SH_PLACE_COORDINATES_META.resolved > 1000);
  const kiel = placeCoordinates('Kiel');
  assert.ok(Math.abs(distanceKm(kiel, placeCoordinates('Rendsburg')) - 30) < 5);
  assert.ok(Math.abs(distanceKm(placeCoordinates('Trittau'), placeCoordinates('Ahrensburg')) - 13) < 4);
  assert.equal(placeCoordinates('Atlantis'), null);
});

test('a company that lets in one town is asked only when that town can be in the result', () => {
  assert.deepEqual(companySourcesFor({ location:'Kiel', radiusKm:15 }).map(source => source.id), ['wankendorfer', 'wbg-kiel-ost', 'woge-kiel', 'big-verwaltung', 'zbvv', 'hug-kiel']);
  assert.deepEqual(companySourcesFor({ location:'Bad Schwartau', radiusKm:15 }).map(source => source.id), ['wankendorfer', 'trave', 'luebecker-bauverein', 'neue-luebecker']);
  assert.deepEqual(companySourcesFor({ location:'Neumünster', districtJurisdiction:'Neumünster' }).map(source => source.id), ['wankendorfer', 'wobau-neumuenster', 'wbg-kiel-ost', 'woge-kiel', 'big-verwaltung', 'zbvv']);
  assert.deepEqual(companySourcesFor({ location:'Heide', radiusKm:15, districtJurisdiction:'Dithmarschen' }).map(source => source.id), ['wankendorfer', 'wodi-dithmarschen']);
  assert.deepEqual(companySourcesFor({ location:'Norderstedt', radiusKm:15 }).map(source => source.id), ['wankendorfer', 'neue-luebecker', 'adlershorst']);
  // Where none of the regional companies lets, only the statewide list is asked.
  assert.deepEqual(companySourcesFor({ location:'Husum', radiusKm:15 }).map(source => source.id), ['wankendorfer']);
});

test('company listings get a measured distance and the radius applies to them', async () => {
  const transport = async url => html(String(url).includes('wankendorfer') ? fixture('wankendorfer') : '<html></html>');
  const found = await searchHousingCompanies({ location:'Bad Segeberg', radiusKm:10, rooms:'1-3' }, transport);
  assert.equal(found.status, 'ok');
  const segeberg = found.listings.find(item => item.town === 'Bad Segeberg');
  const trappenkamp = found.listings.find(item => item.town === 'Trappenkamp');
  assert.ok(segeberg.distanceKm < 3);
  assert.ok(trappenkamp.distanceKm > 10, `Trappenkamp is ${trappenkamp.distanceKm} km from Bad Segeberg`);
  const kept = filterPrimaryListings(found.listings, { location:'Bad Segeberg', rooms:'1-3', roomsMin:1, roomsMax:3, amount:800, radiusKm:10 });
  assert.deepEqual(kept.map(item => item.town), ['Bad Segeberg']);
});

const sourceOf = id => HOUSING_COMPANY_SOURCES.find(source => source.id === id);
const summary = item => ({ price:item.price, priceType:item.priceType, rooms:item.rooms, areaSqm:item.areaSqm, location:item.location });
const assertOpenable = (items, host) => {
  for (const item of items) {
    assert.ok(item.url.startsWith(`https://${host}/`), item.url);
    assert.doesNotMatch(item.url, /&amp;|\s/u);
  }
};

test('FAB Flensburg cards: Gesamtmiete, the town stands in for the missing postcode', () => {
  const items = parseFab(fixture('fab'));
  assert.equal(items.length, 3);
  assert.deepEqual(summary(items[0]), { price:792, priceType:'Gesamtmiete', rooms:'2', areaSqm:56, location:'Flensburg' });
  assert.equal(items[0].town, 'Flensburg');
  assert.equal(items[0].postcode, null);
  assert.equal(items[1].price, 1660);
  assert.equal(items[0].url, 'https://www.fab.sh/main/aktuelle-wohnungsangebote/objekt/seniorenwohnung-mit-wbs-667');
  assert.match(items[0].imageUrl, /^https:\/\/www\.fab\.sh\/fileadmin\//u);
  assertOpenable(items, 'www.fab.sh');
});

test('WBG Kiel-Ost cards: links resolve against the page base', () => {
  const items = parseWbgKielOst(fixture('wbg-kiel-ost'));
  assert.equal(items.length, 1);
  assert.deepEqual(summary(items[0]), { price:616.2, priceType:'Gesamtmiete', rooms:'2', areaSqm:56.15, location:'24148 Kiel' });
  assert.match(items[0].url, /^https:\/\/www\.wbg-kiel-ost\.de\/mieten\/objekte\/expose\/.+\.html$/u);
  assertOpenable(items, 'www.wbg-kiel-ost.de');
});

test('Lübecker Bauverein cards: flats only, parking spaces and Mecklenburg are skipped', () => {
  const items = parseLuebeckerBauverein(fixture('luebecker-bauverein'));
  assert.equal(items.length, 2, 'two parking spaces and the Rehna (19217) flat are not returned');
  assert.deepEqual(summary(items[0]), { price:1747.43, priceType:'Gesamtmiete', rooms:'4', areaSqm:91.97, location:'23611 Bad Schwartau' });
  assert.equal(items[0].title, '4 Zimmer-Wohnung im Dachgeschoss');
  assert.equal(items[1].location, '23569 Lübeck');
  assert.ok(items.every(item => !/Rehna|Stellplatz/u.test(`${item.location} ${item.title}`)));
  assert.equal(items[0].url, 'https://www.luebecker-bauverein.de/angebotsfinder/objekt/4-zimmer-wohnung-im-dachgeschoss.html');
  assertOpenable(items, 'www.luebecker-bauverein.de');
});

test('Neue Lübecker cards: Wohnen and Mit WBS kept, parking, commercial and Mecklenburg skipped', () => {
  const items = parseNeueLuebecker(fixture('neue-luebecker'));
  assert.equal(items.length, 4);
  assert.deepEqual(summary(items[0]), { price:1000, priceType:'Kaltmiete', rooms:'2', areaSqm:68, location:'22846 Norderstedt' });
  assert.deepEqual(items.map(item => item.town), ['Norderstedt', 'Lübeck', 'Büchen', 'Bad Oldesloe']);
  assert.ok(items.every(item => /^2\d{4}$/u.test(item.postcode)), 'no Crivitz (19089)');
  assert.ok(items.every(item => !/Stellplatz|Gewerbe|Büro/u.test(item.title)));
  assert.equal(items[0].url, 'https://www.neueluebecker.de/mieten/immobilienangebote/objektdetails/helle-2-zimmer-wohnung-mit-dachterrasse-1177889/');
  assertOpenable(items, 'www.neueluebecker.de');
});

test('WOGE Kiel cards: town from the region line, parking space skipped', () => {
  const items = parseWogeKiel(fixture('woge-kiel'));
  assert.equal(items.length, 4, 'the Bordesholm parking space has 0 rooms');
  assert.deepEqual(summary(items[0]), { price:1372, priceType:'Gesamtmiete', rooms:'2', areaSqm:73.31, location:'Kiel' });
  assert.deepEqual(items.map(item => item.town), ['Kiel', 'Kiel', 'Flensburg', 'Preetz']);
  assert.equal(items[0].url, 'https://www.wogekiel.de/mietangebote?&id=3865');
  assert.equal(items[0].imageUrl, 'https://www.wogekiel.de/system/modules/immotool/assets/3865Thumb.jpg');
  assertOpenable(items, 'www.wogekiel.de');
});

test('Adlershorst cards: Kaltmiete, the parking space is skipped', () => {
  const items = parseAdlershorst(fixture('adlershorst'));
  assert.equal(items.length, 2);
  assert.deepEqual(summary(items[0]), { price:782.14, priceType:'Kaltmiete', rooms:'3', areaSqm:68.13, location:'25436 Tornesch' });
  assert.equal(items[1].location, '22844 Norderstedt');
  assert.equal(items[0].url, 'https://www.adlershorst.de/mietobjekt/184.007/');
  assertOpenable(items, 'www.adlershorst.de');
});

test('BIG-Verwaltung cards: the listed Warmmiete is the price, Kaltmiete kept; practices are skipped', () => {
  const items = parseBigVerwaltung(fixture('big-verwaltung'));
  assert.equal(items.length, 3, 'two Praxis offers are not flats');
  assert.deepEqual(summary(items[0]), { price:1075, priceType:'Warmmiete', rooms:'2', areaSqm:60.42, location:'24159 Kiel' });
  assert.equal(items[0].coldPrice, 800);
  assert.deepEqual(items.map(item => [item.price, item.coldPrice]), [[1075, 800], [1130, 900], [797.5, 500]]);
  assert.deepEqual(items.map(item => item.town), ['Kiel', 'Bordesholm', 'Itzehoe']);
  assert.equal(items[0].url, 'https://big-verwaltung.de/immobilien/wohnung-apartment-in-kiel-mieten-44e238/');
  assertOpenable(items, 'big-verwaltung.de');
});

test('Wohnungsunternehmen Dithmarschen cards: dot decimals, commercial offers skipped', () => {
  const items = parseWodiDithmarschen(fixture('wodi-dithmarschen'));
  assert.equal(items.length, 2, 'office and commercial space are not returned');
  assert.deepEqual(summary(items[0]), { price:262.29, priceType:'Kaltmiete', rooms:'2', areaSqm:37, location:'Brunsbüttel' });
  assert.equal(items[0].title, '2-Zimmerwohnung für Preisbewusste');
  assert.equal(items[1].price, 371.07);
  assert.match(items[0].url, /^https:\/\/www\.wo-di\.de\/wohnen\/immobilienansicht\/objekt\/ansicht\/brunsbuettel-.+-171732559\.html$/u);
  assertOpenable(items, 'www.wo-di.de');
});

test('ZBVV cards: only the searched town, garages and other cities skipped', () => {
  const items = parseZbvv(fixture('zbvv'), sourceOf('zbvv'), { town:'Kiel' });
  assert.equal(items.length, 2, 'a garage, a parking space and a Dortmund flat are not returned');
  assert.deepEqual(summary(items[0]), { price:439, priceType:'Kaltmiete', rooms:'1.5', areaSqm:40, location:'Kiel-Wellingdorf' });
  assert.equal(items[0].town, 'Kiel');
  assert.equal(items[0].url, 'https://www.zbvv.de/immobilien/15-zimmer-wohnung-einfach-einziehen/');
  assertOpenable(items, 'www.zbvv.de');
  assert.equal(parseZbvv(fixture('zbvv'), sourceOf('zbvv'), {}).length, 0, 'without a town nothing is trusted');
});

test('Haus und Grund Kiel cards: Warmmiete where listed, else Kaltmiete; carports and flats outside SH skipped', () => {
  const items = parseHausUndGrundKiel(fixture('hug-kiel'));
  assert.equal(items.length, 3, 'the carport and the Obertshausen flat are not returned');
  assert.deepEqual(summary(items[0]), { price:1400, priceType:'Kaltmiete', rooms:'6', areaSqm:140.98, location:'24143 Kiel' });
  assert.equal(items[0].coldPrice, undefined, 'no Warmmiete listed: the Kaltmiete stays the price');
  assert.deepEqual([items[1].price, items[1].priceType, items[1].coldPrice], [825, 'Warmmiete', 550], 'the listed Warmmiete is the full cost');
  assert.equal(items[0].url, 'https://www.hausundgrund.de/verein/kiel/immobilien-angebot/3242/6161452');
  assert.match(items[0].imageUrl, /^https:\/\/images\.propstack\.de\//u);
  assertOpenable(items, 'www.hausundgrund.de');
});

test('ZBVV is asked for the searched town only, and cached per town', async () => {
  assert.ok(!companySourcesFor({ location:'Husum', radiusKm:50 }).some(source => source.id === 'zbvv'));
  assert.ok(companySourcesFor({ location:'Bad Bramstedt', radiusKm:15 }).some(source => source.id === 'zbvv'));
  assert.ok(companySourcesFor({ location:'Felde', radiusKm:15, districtJurisdiction:'Kiel' }).some(source => source.id === 'zbvv'));
  clearHousingCompanyCache();
  const asked = [];
  const transport = async url => {
    asked.push(String(url));
    return html(String(url).includes('zbvv.de') ? fixture('zbvv') : '<html></html>');
  };
  const found = await searchHousingCompanies({ location:'Kiel', radiusKm:15 }, transport);
  assert.ok(asked.includes('https://www.zbvv.de/vermietungsangebote/?inx-search-marketing-type=zu-vermieten&inx-search-locality=Kiel'));
  const zbvv = found.listings.filter(item => item.sourceId === 'zbvv');
  assert.equal(zbvv.length, 2);
  assert.ok(zbvv.every(item => item.distanceKm < 1));
  asked.length = 0;
  await searchHousingCompanies({ location:'Kiel', radiusKm:15 }, transport);
  assert.ok(!asked.some(url => url.includes('zbvv.de')), 'a second Kiel search reuses the page');
  await searchHousingCompanies({ location:'Lübeck', radiusKm:15 }, transport);
  assert.ok(asked.includes('https://www.zbvv.de/vermietungsangebote/?inx-search-marketing-type=zu-vermieten&inx-search-locality=L%C3%BCbeck'));
  clearHousingCompanyCache();
});

test('company pages per search stay within the cap, the statewide list first', () => {
  for (const location of ['Kiel', 'Bad Bramstedt', 'Neumünster', 'Lübeck', 'Bordesholm']) {
    const sources = companySourcesFor({ location, radiusKm:50 });
    assert.ok(sources.length <= MAX_COMPANY_PAGES, location);
    assert.equal(sources[0].id, 'wankendorfer');
  }
});
