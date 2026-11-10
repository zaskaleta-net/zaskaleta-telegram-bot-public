import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKleinanzeigenPublicPage, searchKleinanzeigenPublicRecovery } from '../src/housing-kleinanzeigen-public-recovery.mjs';

function card(id, { city='Rendsburg', plz='24768', title='Helle 3-Zimmer-Wohnung', price=579, rooms=3, area=68.01, metricText=null, adType='', imageUrl=null } = {}) {
  return `<article class="aditem" data-adid="${id}">
    <div class="aditem-image"><a href="/s-anzeige/${title.toLowerCase().replace(/[^a-z0-9]+/g,'-')}/${id}-203-477"><img src="${imageUrl || `https://img.kleinanzeigen.de/api/v1/prod-ads/images/${id}.jpg`}"></a></div>
    <div class="aditem-main">
      <div>${plz} ${city}</div>
      <h2><a href="/s-anzeige/${title.toLowerCase().replace(/[^a-z0-9]+/g,'-')}/${id}-203-477">${title}</a></h2>
      <p>Objektbeschreibung für die angebotene Mietwohnung.</p>
      ${adType ? `<p>${adType}</p>` : ''}
      <p>${metricText ?? `${area} m² · ${rooms} Zi.`}</p>
      <p>${price} €</p>
    </div>
  </article>`;
}

function htmlResponse(html) {
  return new Response(html, { headers:{ 'content-type':'text/html; charset=utf-8' } });
}

test('Rendsburg direct public recovery keeps exact 3-room candidate under the 2-person ceiling and rejects 2.5 rooms', () => {
  const criteria = { location:'Rendsburg', rooms:'3', amount:531.60, radiusKm:15 };
  const html = card('300000001', { price:519, rooms:3, area:49.43, title:'Gemütliche 3-Zimmer-Wohnung in Altstadtnähe' })
    + card('300000002', { price:489, rooms:2.5, area:58.8, title:'Toll geschnittene 2,5-Zimmer-Wohnung' });
  const listings = parseKleinanzeigenPublicPage(html, criteria);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 519);
  assert.equal(listings[0].rooms, 3);
  assert.match(listings[0].url, /kleinanzeigen\.de\/s-anzeige\//u);
});

test('metric parser accepts German decimal comma with area before rooms', () => {
  const criteria = { location:'Kiel', rooms:'3', amount:900, radiusKm:15 };
  const html = card('300000006', {
    city:'Kiel', plz:'24103', title:'Zentrale 3-Zimmer-Wohnung', price:850, metricText:'68,5 m² · 3 Zi.'
  });
  const listings = parseKleinanzeigenPublicPage(html, criteria);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].rooms, 3);
  assert.equal(listings[0].areaSqm, 68.5);
});

test('metric parser accepts rooms before German decimal-comma area without swapping values', () => {
  const criteria = { location:'Flensburg', rooms:'3', amount:900, radiusKm:15 };
  const html = card('300000007', {
    city:'Flensburg', plz:'24937', title:'Schöne 3-Zimmer-Wohnung', price:820, metricText:'3 Zi. · 68,5 m²'
  });
  const listings = parseKleinanzeigenPublicPage(html, criteria);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].rooms, 3);
  assert.equal(listings[0].areaSqm, 68.5);
});

test('Lübeck public parser keeps exact-city 3-room candidates and rejects Tauschwohnung', () => {
  const criteria = { location:'Lübeck', rooms:'3', amount:680, radiusKm:15 };
  const html = card('300000003', { city:'Lübeck', plz:'23554', title:'3-Zimmer-Wohnung zum 01.11.2026', price:600, rooms:3, area:66 })
    + card('300000004', { city:'Lübeck', plz:'23554', title:'TAUSCHWOHNUNG Gemütliche 3-Zimmer-Flat', price:635, rooms:3, area:75 })
    + card('300000005', { city:'Bad Schwartau', plz:'23611', title:'3-Zimmer-Wohnung außerhalb Lübeck', price:590, rooms:3, area:65 });
  const listings = parseKleinanzeigenPublicPage(html, criteria);
  assert.deepEqual(listings.map(item => item.id), ['300000003-203-477']);
});

test('recovery expands beyond primary pages when fewer than five direct candidates are available', async () => {
  const criteria = { location:'Rendsburg', rooms:'3', amount:700, radiusKm:15 };
  const fetched = [];
  const primary = card('310000001', { price:619, rooms:3, title:'Primäre 3-Zimmer-Wohnung' });
  const supplemental = card('310000002', { price:629, rooms:3, title:'Zusätzliche 3-Zimmer-Wohnung' });
  const result = await searchKleinanzeigenPublicRecovery(criteria, async (url, options) => {
    fetched.push({ url:String(url), options });
    if (/seite%3A2/u.test(String(url))) return htmlResponse(supplemental);
    if (/s-wohnung-mieten\/rendsburg/u.test(String(url))) return htmlResponse(primary);
    return htmlResponse('<html><body>Keine Treffer</body></html>');
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.expanded, true);
  assert.deepEqual(result.listings.map(item => item.id).sort(), ['310000001-203-477','310000002-203-477']);
  assert.ok(fetched.some(item => /seite%3A2\/3-zimmer-wohnung-mieten/u.test(item.url)));
  assert.ok(result.pages.some(page => page.supplemental === true));
});

test('five primary direct candidates still expand toward the statewide twelve-candidate target', async () => {
  const criteria = { location:'Kiel', rooms:'3', amount:1000, radiusKm:15 };
  const primary = Array.from({ length:5 }, (_, index) => card(String(320000001 + index), {
    city:'Kiel', plz:'24103', price:800 + index * 10, rooms:3, title:`Angebot ${index + 1} · 3-Zimmer-Wohnung`
  })).join('');
  const fetched = [];
  const result = await searchKleinanzeigenPublicRecovery(criteria, async url => {
    fetched.push(String(url));
    return htmlResponse(primary);
  });
  assert.equal(result.listings.length, 5);
  assert.equal(result.expanded, true);
  assert.ok(fetched.length > 2);
  assert.ok(fetched.some(url => /seite%3A2/u.test(url) || /seite:2/u.test(url)));
});

test('expanded recovery rejects Gesuch/Suche titles but preserves legitimate Nachmieter offer', async () => {
  const criteria = { location:'Lübeck', rooms:'3', amount:1000, radiusKm:15 };
  const html = card('330000001', { city:'Lübeck', plz:'23554', title:'Suche 3-Zimmer-Wohnung in Lübeck', price:850, rooms:3, area:70 })
    + card('330000002', { city:'Lübeck', plz:'23554', title:'3-Zimmer-Wohnung gesucht', price:850, rooms:3, area:70 })
    + card('330000003', { city:'Lübeck', plz:'23554', title:'Nachmieter gesucht für helle 3-Zimmer-Wohnung', price:850, rooms:3, area:70 });
  const result = await searchKleinanzeigenPublicRecovery(criteria, async () => htmlResponse(html));
  assert.deepEqual(result.listings.map(item => item.id), ['330000003-203-477']);
});

test('challenge pages remain unavailable even after supplemental recovery attempts', async () => {
  const criteria = { location:'Rendsburg', rooms:'3', amount:531.60, radiusKm:15 };
  const fetched = [];
  const result = await searchKleinanzeigenPublicRecovery(criteria, async (url, options) => {
    fetched.push({ url:String(url), options });
    return htmlResponse('<html><body><h1>Verify you are human</h1><p>CAPTCHA</p></body></html>');
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.listings.length, 0);
  assert.ok(fetched.length > 2);
  assert.ok(fetched.some(item => /s-wohnung-mieten\/rendsburg\/k0c203$/u.test(item.url)));
  assert.ok(fetched.some(item => /s-wohnung-mieten\/rendsburg\/3--zimmer-wohnung-mieten\/k0c203$/u.test(item.url)));
  assert.ok(fetched.some(item => /seite%3A2\/3-zimmer-wohnung-mieten/u.test(item.url)));
  assert.ok(result.pages.every(page => page.reason === 'challenge'));
  assert.match(String(fetched[0].options?.headers?.['user-agent'] || ''), /Chrome\//u);
});

test('3-4 room criteria adds separate 3 and 4 room supplemental page-two searches', async () => {
  const criteria = { location:'Bad Segeberg', rooms:'3-4', amount:981.64, radiusKm:15 };
  const fetched = [];
  await searchKleinanzeigenPublicRecovery(criteria, async url => {
    fetched.push(String(url));
    return htmlResponse('<html><body>Keine Treffer</body></html>');
  });
  assert.ok(fetched.some(url => /s-wohnung-mieten\/bad-segeberg\/k0c203$/u.test(url)));
  assert.ok(fetched.some(url => /s-wohnung-mieten\/bad-segeberg\/3--zimmer-wohnung-mieten\/k0c203$/u.test(url)));
  assert.ok(fetched.some(url => /s-wohnung-mieten\/bad-segeberg\/4--zimmer-wohnung-mieten\/k0c203$/u.test(url)));
  assert.ok(fetched.some(url => /(?:seite%3A2|seite:2)\/3-zimmer-wohnung-mieten/u.test(url)));
  assert.ok(fetched.some(url => /(?:seite%3A2|seite:2)\/4-zimmer-wohnung-mieten/u.test(url)));
});


test('Kiel recovery uses direct Schleswig-Holstein scope and keeps district-labelled 3-room offers with photos', async () => {
  const criteria = { location:'Kiel', rooms:'3', amount:679, radiusKm:15 };
  const fetched = [];
  const strict = card('340000001', {
    city:'Gaarden(1 km)', plz:'24143', title:'Kaiserstraße: 3 Zimmerwohnung, Einbauküche zu vermieten!', price:600, rooms:3, area:53
  }) + card('340000002', {
    city:'Elmschenhagen-Kroog(2 km)', plz:'24146', title:'2,5 Zimmer Wohnung Kiel', price:540, rooms:2.5, area:65
  }) + card('340000003', {
    city:'Büdelsdorf(29 km)', plz:'24782', title:'Sehr gepflegte 3-Zimmer-Wohnung zu vermieten', price:670, rooms:3, area:74
  });

  const result = await searchKleinanzeigenPublicRecovery(criteria, async url => {
    fetched.push(String(url));
    if (/s-suchanfrage\.html/u.test(String(url))) return htmlResponse(strict);
    return htmlResponse('<html><body>Keine Treffer</body></html>');
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].price, 600);
  assert.equal(result.listings[0].rooms, 3);
  assert.equal(result.listings[0].location, '24143 Gaarden');
  assert.equal(result.listings[0].distanceKm, 1);
  assert.match(result.listings[0].imageUrl, /^https:\/\/img\.kleinanzeigen\.de\//u);
  assert.ok(fetched.some(url => /locationId=663(?:&|$)/u.test(url)));
  assert.ok(fetched.some(url => /wohnung_mieten\.zimmer_d%5D=3%2C3/u.test(url)));
  assert.ok(fetched.some(url => /maxPrice=679/u.test(url)));
  assert.ok(fetched.some(url => /radius=15/u.test(url)));
  assert.equal(result.listings.some(item => item.rooms === 2.5), false);
  assert.equal(result.listings.some(item => item.location.includes('Büdelsdorf')), false);
});


test('expanded recovery rejects search requests and WG-room ads but keeps a real apartment offer', async () => {
  const criteria = { location:'Rendsburg', rooms:'3', amount:700, radiusKm:15 };
  const html = card('350000001', {
    city:'Rendsburg(1 km)', plz:'24768', title:'Zwei Personen Haushalt sucht Wohnung', price:650, rooms:3, area:70
  }) + card('350000002', {
    city:'Rendsburg(1 km)', plz:'24768', title:'Ein Zimmer (WG) in 3-Zimmer-Wohnung', price:400, rooms:3, area:55
  }) + card('350000003', {
    city:'Rendsburg(0,7 km)', plz:'24768', title:'3 Zimmer Dachgeschoss Wohnung in Rendsburg', price:535, rooms:3, area:55
  });

  const result = await searchKleinanzeigenPublicRecovery(criteria, async () => htmlResponse(html));
  assert.deepEqual(result.listings.map(item => item.id), ['350000003-203-477']);
  assert.equal(result.listings[0].distanceKm, 0.7);
});

test('scoped parser understands ca. distance and excludes a result beyond the requested radius', async () => {
  const criteria = { location:'Bad Segeberg', rooms:'3', amount:900, radiusKm:15 };
  const html = card('360000001', {
    city:'Bornhöved(ca. 15 km)', plz:'24619', title:'3-Zimmer-Wohnung in Bornhöved', price:700, rooms:3, area:68
  }) + card('360000002', {
    city:'Kalübbe(20 km)', plz:'24326', title:'3-Zimmer-Wohnung in Kalübbe', price:850, rooms:3, area:85
  });

  const result = await searchKleinanzeigenPublicRecovery(criteria, async () => htmlResponse(html));
  assert.deepEqual(result.listings.map(item => item.id), ['360000001-203-477']);
  assert.equal(result.listings[0].distanceKm, 15);
});


test('parser rejects Kleinanzeigen Gesuch cards even when the title looks like a normal apartment', () => {
  const criteria = { location:'Kiel', rooms:'3', amount:679, radiusKm:15 };
  const html = card('370000001', {
    city:'Gaarden(1 km)', plz:'24143', title:'3-Zimmer-Wohnung in Kiel', price:650, rooms:3, area:63, adType:'Gesuch'
  }) + card('370000002', {
    city:'Gaarden(1 km)', plz:'24143', title:'3-Zimmer-Wohnung zu vermieten', price:650, rooms:3, area:63
  });
  const listings = parseKleinanzeigenPublicPage(html, criteria, { locationScoped:true });
  assert.deepEqual(listings.map(item => item.id), ['370000002-203-477']);
});


test('scoped parser binds split sibling distance labels and rejects far other-city results', () => {
  const criteria = { location:'Kiel', rooms:'3', amount:679, radiusKm:15 };
  const html = `
    <article class="aditem" data-adid="380000001">
      <a href="/s-anzeige/kiel-3-zimmer/380000001-203-702"><img src="https://img.kleinanzeigen.de/api/v1/prod-ads/images/380000001.jpg"></a>
      <div><span>24143 Gaarden</span><span class="ml-xsmall">(1 km)</span></div>
      <h2><a href="/s-anzeige/kiel-3-zimmer/380000001-203-702">3-Zimmer-Wohnung in Kiel</a></h2>
      <p>53 m² · 3 Zi.</p><p>600 €</p>
    </article>
    <article class="aditem" data-adid="380000002">
      <a href="/s-anzeige/buedelsdorf-3-zimmer/380000002-203-477"><img src="https://img.kleinanzeigen.de/api/v1/prod-ads/images/380000002.jpg"></a>
      <div><span>24782 Büdelsdorf</span><span class="ml-xsmall">(29 km)</span></div>
      <h2><a href="/s-anzeige/buedelsdorf-3-zimmer/380000002-203-477">Sehr gepflegte 3-Zimmer-Wohnung</a></h2>
      <p>74 m² · 3 Zi.</p><p>670 €</p>
    </article>`;

  const listings = parseKleinanzeigenPublicPage(html, criteria, { locationScoped:true });
  assert.deepEqual(listings.map(item => item.id), ['380000001-203-702']);
  assert.equal(listings[0].distanceKm, 1);
  assert.equal(listings.some(item => item.location.includes('Büdelsdorf')), false);
});


test('district recovery omits radius parameter so administrative filtering owns the scope', async () => {
  const criteria = {
    location:'Kiel',
    rooms:'3',
    amount:679,
    radiusKm:50,
    districtJurisdiction:'Kiel'
  };
  const fetched = [];
  const html = card('390000001', {
    city:'Gaarden', plz:'24143', title:'3-Zimmer-Wohnung in Kiel-Gaarden', price:600, rooms:3, area:53
  });

  await searchKleinanzeigenPublicRecovery(criteria, async url => {
    fetched.push(String(url));
    return htmlResponse(html);
  });

  const strict = fetched.find(url => /s-suchanfrage\.html/u.test(url));
  assert.ok(strict);
  assert.match(strict, /locationId=663(?:&|$)/u);
  assert.doesNotMatch(strict, /(?:^|[?&])radius=/u);
});


test('expanded recovery deduplicates different ads that reuse the same photo', async () => {
  const criteria = { location:'Bad Segeberg', rooms:'3', amount:950, radiusKm:15 };
  const shared = 'https://img.kleinanzeigen.de/api/v1/prod-ads/images/shared-bad-segeberg.jpg';
  const html = card('410000001', {
    city:'Bad Segeberg', plz:'23795', title:'3-Zimmer-Wohnung Bad Segeberg A', price:790, rooms:3, area:70, imageUrl:shared
  }) + card('410000002', {
    city:'Bad Segeberg', plz:'23795', title:'3-Zimmer-Wohnung Bad Segeberg B', price:795, rooms:3, area:71, imageUrl:shared
  });

  const result = await searchKleinanzeigenPublicRecovery(criteria, async () => htmlResponse(html));
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].imageUrl, shared);
});


test('expanded recovery rejects Zimmer-in-WG and Anfragestopp cards from phone QA', async () => {
  const criteria = { location:'Pinneberg', rooms:'3', amount:1200, radiusKm:15 };
  const html = card('420000001', {
    city:'Pinneberg', plz:'25421', title:'Zimmer in 2er WG', price:650, rooms:3, area:75
  }) + card('420000002', {
    city:'Pinneberg', plz:'25421', title:'ANFRAGESTOPP!! Nachmieter für helle 3 Zimmer Wohnung gesucht', price:800, rooms:3, area:70
  }) + card('420000003', {
    city:'Pinneberg', plz:'25421', title:'3-Zimmer-Wohnung / 2er WG geeignet', price:900, rooms:3, area:72
  });

  const result = await searchKleinanzeigenPublicRecovery(criteria, async () => htmlResponse(html));
  assert.deepEqual(result.listings.map(item => item.id), ['420000003-203-477']);
});
