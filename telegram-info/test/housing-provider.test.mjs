import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOUSING_SEARCH_SOURCES,
  parseHousingSearchAction,
  housingSearchAction,
  searchLiveHousing,
  formatHousingListings,
  housingListingMedia,
  housingListingsMarkup,
  externalHousingSearchMarkup
} from '../src/housing-provider.mjs';

const KEY = 'klaz_live_' + 'A'.repeat(24);
const criteria = { location: 'Hamburg', rooms: 2, amount: 950, type: 'Warmmiete' };

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('housing search action round-trips criteria without durable state', () => {
  const action = housingSearchAction(criteria);
  assert.equal(action, '🔎 Hamburg · 2 · 950 · W');
  assert.deepEqual(parseHousingSearchAction(action), criteria);
  assert.equal(parseHousingSearchAction('🔎 Hamburg · 0 · 950 · W'), null);
  assert.equal(parseHousingSearchAction('🔎 Hamburg · 2 · 50 · W'), null);
});

test('housing source catalog includes live, public and external Schleswig-Holstein sources', () => {
  assert.equal(HOUSING_SEARCH_SOURCES.length, 24);
  const ids = new Set(HOUSING_SEARCH_SOURCES.map(source => source.id));
  assert.equal(ids.size, 24);
  for (const required of [
    'kleinanzeigen','immoscout24','immowelt','wankendorfer','neue-luebecker','fab','immomio','wg-gesucht','ohne-makler',
    'woge-kiel','wobau-neumuenster','semmelhaack','kip-sh','bgh-kiel','wbg-kiel-ost','luebecker-bauverein','bgm','gewoba-nord','sbv-flensburg','trave-luebeck','wobau-ostholstein','wodi-dithmarschen','gkb-pinneberg','neue-gewoge'
  ]) assert.ok(ids.has(required), `missing ${required}`);
  assert.equal(HOUSING_SEARCH_SOURCES.find(source => source.id === 'kleinanzeigen')?.mode, 'live_api');
  for (const id of ['wankendorfer','wobau-neumuenster','fab','wbg-kiel-ost','luebecker-bauverein']) {
    assert.equal(HOUSING_SEARCH_SOURCES.find(source => source.id === id)?.mode, 'public_live');
  }
});

test('live provider stays offline without a configured key', async () => {
  let calls = 0;
  const result = await searchLiveHousing(criteria, '', async () => { calls++; throw Error('must not call'); });
  assert.deepEqual(result, { status: 'not_configured', listings: [] });
  assert.equal(calls, 0);
});

test('live provider uses category search without keyword bias and filters structured rental offers', async () => {
  const calls = [];
  const transport = async (url, options = {}) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers?.klaz_key, KEY);
    assert.equal(options.headers?.authorization, `Bearer ${KEY}`);
    assert.ok(!url.includes(KEY));
    if (url.includes('/locations?')) {
      assert.match(url, /q=Hamburg/);
      return json({ success: true, data: { locations: [{ id: '9409', name: 'Hamburg', city: 'Hamburg' }] } });
    }
    assert.match(url, /\/search\?/);
    const parsed = new URL(url);
    assert.ok(['203','205'].includes(parsed.searchParams.get('category_id')));
    assert.equal(parsed.searchParams.get('location_id'), '9409');
    assert.equal(parsed.searchParams.get('max_price'), '950');
    assert.equal(parsed.searchParams.get('picture_required'), 'false', 'listings without photos are shown as text cards');
    assert.equal(parsed.searchParams.get('size'), '100');
    assert.equal(parsed.searchParams.get('q'), null);
    assert.equal(parsed.searchParams.get('ad_type'), null);
    return json({
      success: true,
      data: {
        ads: [
          {
            ad_id: '1', title: 'Helle Wohnung mit Balkon', description: 'Langfristig zu vermieten.',
            price: { amount: 617, price_type: 'SPECIFIED_AMOUNT' }, status: 'ACTIVE', deleted: false,
            ad_url: 'https://www.kleinanzeigen.de/s-anzeige/helle-wohnung/1',
            location: { name: 'Hamburg Farmsen-Berne' }, details: { Zimmer: '2' },
            attributes: [{ name: 'wohnung_mieten.zimmer', label: 'Zimmer', values: [{ value: '2', label: '2' }] }]
          },
          {
            ad_id: '2', title: 'Zuverlässige Familie sucht eine 2-Zimmer-Wohnung', description: '',
            price: { amount: 700, price_type: 'SPECIFIED_AMOUNT' }, status: 'ACTIVE', deleted: false,
            ad_url: 'https://www.kleinanzeigen.de/s-anzeige/suche/2',
            location: { name: 'Hamburg' }, details: { Zimmer: '2' }
          },
          {
            ad_id: '3', title: 'Wohnungsswap - 2 Zimmer in Hamburg', description: '',
            price: { amount: 800, price_type: 'SPECIFIED_AMOUNT' }, status: 'ACTIVE', deleted: false,
            ad_url: 'https://www.kleinanzeigen.de/s-anzeige/swap/3',
            location: { name: 'Hamburg' }, details: { Zimmer: '2' }
          },
          {
            ad_id: '4', title: 'Schöne 2-Zimmer Wohnung', description: '',
            price: { amount: 1, price_type: 'PLEASE_CONTACT' }, status: 'ACTIVE', deleted: false,
            ad_url: 'https://www.kleinanzeigen.de/s-anzeige/kontakt/4',
            location: { name: 'Hamburg' }, details: { Zimmer: '2' }
          },
          {
            ad_id: '5', title: 'Schöne Wohnung', description: '',
            price: { amount: 700, price_type: 'SPECIFIED_AMOUNT' }, status: 'ACTIVE', deleted: false,
            ad_url: 'https://www.kleinanzeigen.de/s-anzeige/falsch/5',
            location: { name: 'Hamburg' }, details: { Zimmer: '3' }
          },
          {
            ad_id: '6', title: 'Nachmieter gesucht – schöne Wohnung mit Balkon', description: 'Wohnung wird frei.',
            price: { amount: 850, price_type: 'SPECIFIED_AMOUNT' }, status: 'ACTIVE', deleted: false,
            ad_url: 'https://www.kleinanzeigen.de/s-anzeige/nachmieter/6',
            location: { name: 'Hamburg' }, details: { Zimmer: '2' }
          }
        ]
      }
    });
  };

  const result = await searchLiveHousing(criteria, KEY, transport);
  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 3);
  assert.deepEqual(result.listings.map(item => item.id), ['1', '6']);
  assert.equal(result.listings[0].price, 617);
  assert.deepEqual(result.criteria, { ...criteria, rooms: String(criteria.rooms), radiusKm: 15 });
  const formatted = formatHousingListings(criteria, result);
  assert.match(formatted, /Helle Wohnung mit Balkon/);
  assert.match(formatted, /Kaltmiete\/Warmmiete/);
});

test('room range accepts decimal structured Zimmer values', async () => {
  const range = { location: 'Trittau', rooms: '3-4', roomsMin: 3, roomsMax: 4, amount: 1000, type: 'Warmmiete' };
  let searchSeen = false;
  const result = await searchLiveHousing(range, KEY, async url => {
    if (url.includes('/locations?')) return json({ success: true, data: { locations: [{ id: '10410', name: 'Trittau' }] } });
    searchSeen = true;
    return json({ success: true, data: { ads: [
      {
        ad_id: '35', title: 'Charmante Wohnung im Bauernhaus', description: '',
        price: { amount: 795, price_type: 'SPECIFIED_AMOUNT' }, status: 'ACTIVE', deleted: false,
        ad_url: 'https://www.kleinanzeigen.de/s-anzeige/charmant/35', location: { name: 'Siebenbäumen' },
        details: { Zimmer: '3,5' }, attributes: [{ name: 'wohnung_mieten.zimmer', label: 'Zimmer', values: [{ value: '3.5', label: '3,5' }] }]
      },
      {
        ad_id: '25', title: 'Helle Wohnung', description: '',
        price: { amount: 700, price_type: 'SPECIFIED_AMOUNT' }, status: 'ACTIVE', deleted: false,
        ad_url: 'https://www.kleinanzeigen.de/s-anzeige/klein/25', location: { name: 'Trittau' }, details: { Zimmer: '2.5' }
      }
    ] } });
  });
  assert.equal(searchSeen, true);
  assert.deepEqual(result.listings.map(item => item.id), ['35']);
});

test('provider errors are classified without disclosing the key', async () => {
  const auth = await searchLiveHousing(criteria, KEY, async () => json({ success: false, error_code: 'API_KEY_INVALID', request_id: 'req-auth' }, 401));
  assert.equal(auth.status, 'auth_error');
  assert.equal(auth.requestId, 'req-auth');
  assert.match(formatHousingListings(criteria, auth), /авторизацію/);

  const credits = await searchLiveHousing(criteria, KEY, async () => json({ success: false, error_code: 'INSUFFICIENT_CREDITS' }, 402));
  assert.equal(credits.status, 'insufficient_credits');
  assert.match(formatHousingListings(criteria, credits), /credits/);

  const rate = await searchLiveHousing(criteria, KEY, async () => json({ success: false, error_code: 'RATE_LIMITED' }, 429));
  assert.equal(rate.status, 'rate_limited');

  const upstream = await searchLiveHousing(criteria, KEY, async () => json({ success: false, error_code: 'UPSTREAM_UNAVAILABLE' }, 502));
  assert.equal(upstream.status, 'upstream_unavailable');
  assert.match(formatHousingListings(criteria, upstream), /Kleinanzeigen тимчасово/);

  const redirect = await searchLiveHousing(criteria, KEY, async () => new Response(null, { status: 302, headers: { location: 'https://example.invalid/' } }));
  assert.equal(redirect.status, 'unavailable');
  assert.equal(redirect.providerError, 'UNEXPECTED_REDIRECT');

  const markup = externalHousingSearchMarkup(criteria);
  assert.equal(markup.inline_keyboard.length, 12);
  const buttons = markup.inline_keyboard.flat();
  assert.equal(buttons.length, 24);
  const labels = buttons.map(button => button.text);
  for (const required of [
    '↗ Kleinanzeigen','↗ ImmoScout24','↗ Immowelt','↗ Wankendorfer','↗ NEUE LÜBECKER','↗ FAB Flensburg','↗ WOGE Kiel','↗ WOBAU Neumünster',
    '↗ SEMMELHAACK','↗ KIP Schleswig-Holstein','↗ BG Kiel-Hassee','↗ WBG Kiel-Ost','↗ Lübecker Bauverein','↗ Baugenossenschaft Mittelholstein',
    '↗ GEWOBA Nord','↗ SBV Flensburg','↗ TRAVE Lübeck'
  ]) assert.ok(labels.includes(required), `missing button ${required}`);
  for (const button of buttons) {
    assert.match(button.url, /^https:\/\//);
    assert.ok(!button.url.includes(KEY));
  }
});

test('live provider enforces a local 15 km geofence when coordinates are available', async () => {
  const geoCriteria = { location: 'Trittau', rooms: 3, amount: 1000, type: 'Warmmiete' };
  const result = await searchLiveHousing(geoCriteria, KEY, async url => {
    if (url.includes('/locations?')) return json({ success: true, data: { locations: [{ id: '10410', name: 'Trittau (Schleswig-Holstein)', latitude: 53.610954, longitude: 10.404719 }] } });
    return json({ success: true, data: { ads: [
      {
        ad_id: 'near', title: 'Sanierte 3 Zimmerwohnung', description: '',
        price: { amount: 887, price_type: 'SPECIFIED_AMOUNT' }, status: 'ACTIVE', deleted: false,
        ad_url: 'https://www.kleinanzeigen.de/s-anzeige/near/1',
        location: { name: '22926 Ahrensburg', latitude: 53.6766, longitude: 10.234 }, details: { Zimmer: '3' }
      },
      {
        ad_id: 'far', title: 'Barrierefreie 3 Zimmerwohnung', description: '',
        price: { amount: 900, price_type: 'SPECIFIED_AMOUNT' }, status: 'ACTIVE', deleted: false,
        ad_url: 'https://www.kleinanzeigen.de/s-anzeige/far/2',
        location: { name: '21514 Büchen', latitude: 53.482903, longitude: 10.613955 }, details: { Zimmer: '3' }
      }
    ] } });
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.listings.map(item => item.id), ['near']);
  assert.ok(result.listings[0].distanceKm > 0 && result.listings[0].distanceKm <= 15);
});

test('listing output is compact and uses Telegram buttons instead of raw URLs', () => {
  const result = { status: 'ok', listings: [{ id: '1', title: 'Helle Wohnung', price: 800, location: 'Trittau', distanceKm: 2.4, url: 'https://www.kleinanzeigen.de/s-anzeige/helle/1' }] };
  const output = formatHousingListings({ location: 'Trittau', rooms: 3, amount: 1000, type: 'Warmmiete' }, result);
  assert.doesNotMatch(output, /https:\/\//);
  assert.match(output, /≈2,4 км/);
  const markup = housingListingsMarkup(result);
  assert.equal(markup.inline_keyboard[0][0].text, '1. Відкрити оголошення');
  assert.equal(markup.inline_keyboard[0][0].url, result.listings[0].url);
});

test('approved public live domains get safe listing buttons', () => {
  for (const [source, url] of [
    ['Wankendorfer','https://www.wankendorfer.de/wohnungssuche/'],
    ['WOBAU Neumünster','https://www.wobau-neumuenster.de/mieten/mietangebote'],
    ['FAB Flensburg','https://www.fab.sh/main/aktuelle-wohnungsangebote/'],
    ['WBG Kiel-Ost','https://www.wbg-kiel-ost.de/mieten/objekte/mietwohnungen.html'],
    ['Lübecker Bauverein','https://www.luebecker-bauverein.de/angebotsfinder.html']
  ]) {
    const markup = housingListingsMarkup({ status:'ok', listings:[{ publicSource:true, source, url }] });
    assert.equal(markup.inline_keyboard[0][0].url, url);
    assert.match(markup.inline_keyboard[0][0].text, /^1\./);
  }
  assert.equal(housingListingsMarkup({ status:'ok', listings:[{ publicSource:true, source:'Bad', url:'https://evil.example/' }] }), null);
});

test('radius-aware search action supports explicit user choice', () => {
  const action = housingSearchAction({ ...criteria, radiusKm: 25 });
  assert.equal(action, '🔎 Hamburg · 2 · 950 · W · 25km');
  assert.deepEqual(parseHousingSearchAction(action), { ...criteria, radiusKm: 25 });
  assert.deepEqual(parseHousingSearchAction('🔎 Hamburg · 2 · 950 · W'), criteria);
});

test('provider uses selected radius, sorts nearest first and exposes image metadata', async () => {
  const result = await searchLiveHousing({ ...criteria, radiusKm: 25 }, KEY, async url => {
    if (url.includes('/locations?')) return json({ success: true, data: { locations: [{ id: '9409', name: 'Hamburg', latitude: 53.55, longitude: 10.0 }] } });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('distance'), '25');
    return json({ success: true, data: { ads: [
      { ad_id:'far', title:'Helle 2 Zimmer Wohnung', description:'', price:{amount:900,price_type:'FIXED'}, status:'ACTIVE', deleted:false, ad_url:'https://www.kleinanzeigen.de/s-anzeige/far/1', created_at:'2026-09-10T08:00:00.000Z', images:[{url:'https://img.example.test/far.jpg'}], location:{name:'Far',latitude:53.65,longitude:10.0}, details:{Zimmer:'2','Wohnfläche':'70 m²'} },
      { ad_id:'near', title:'Schöne 2 Zimmer Wohnung', description:'', price:{amount:850,price_type:'FIXED'}, status:'ACTIVE', deleted:false, ad_url:'https://www.kleinanzeigen.de/s-anzeige/near/2', created_at:'2026-09-10T09:00:00.000Z', images:[{image_url:'https://img.example.test/near.jpg'}], location:{name:'Near',latitude:53.56,longitude:10.0}, details:{Zimmer:'2','Wohnfläche':'65 m²'} }
    ] } });
  });
  assert.deepEqual(result.listings.map(x => x.id), ['near','far']);
  assert.equal(result.listings[0].imageUrl, 'https://img.example.test/near.jpg');
  assert.equal(result.listings[0].areaSqm, 65);
  const media = housingListingMedia(result);
  assert.equal(media.length, 2);
  assert.equal(media[0].type, 'photo');
  assert.match(media[0].caption, /Відкрити оголошення/);
  assert.match(media[0].caption, /65 м²/);
  assert.match(media[0].caption, /Пошук ще у 23 джерелах/);
});



test('provider location resolver fails closed instead of falling back to an unrelated first result', async () => {
  const result = await searchLiveHousing(
    { location:'Schleswig', rooms:3, amount:900, type:'Warmmiete' },
    KEY,
    async url => {
      if (url.includes('/locations?')) {
        return json({ success:true, data:{ locations:[
          { id:'100', name:'Schleswig-Holstein' },
          { id:'200', name:'Kiel' }
        ] } });
      }
      throw new Error('search must not run without an exact normalized location');
    }
  );
  assert.equal(result.status, 'location_not_found');
  assert.deepEqual(result.listings, []);
});

test('provider location resolver accepts normalized Schleswig-Holstein suffixes', async () => {
  let searchCalls = 0;
  const result = await searchLiveHousing(
    { location:'Trittau', rooms:3, amount:1000, type:'Warmmiete' },
    KEY,
    async url => {
      if (url.includes('/locations?')) {
        return json({ success:true, data:{ locations:[
          { id:'10410', name:'Trittau (Schleswig-Holstein)' }
        ] } });
      }
      searchCalls += 1;
      return json({ success:true, data:{ ads:[] } });
    }
  );
  assert.equal(searchCalls, 2);
  assert.equal(result.status, 'ok');
});

test('Jobcenter-scoped provider rejects foreign-jurisdiction cards inside the geographic radius', async () => {
  const result = await searchLiveHousing(
    {
      location:'Ratzeburg',
      rooms:2,
      amount:800,
      type:'Bruttokaltmiete',
      radiusKm:15,
      jobcenterJurisdiction:'Herzogtum Lauenburg'
    },
    KEY,
    async url => {
      if (url.includes('/locations?')) {
        return json({ success:true, data:{ locations:[{ id:'300', name:'Ratzeburg' }] } });
      }
      return json({ success:true, data:{ ads:[
        {
          ad_id:'molln', title:'Schöne 2-Zimmer-Wohnung in Mölln', description:'',
          price:{ amount:650, price_type:'FIXED' }, status:'ACTIVE', deleted:false,
          ad_url:'https://www.kleinanzeigen.de/s-anzeige/molln/molln-203-1',
          location:{ name:'23879 Mölln' }, details:{ Zimmer:'2' }
        },
        {
          ad_id:'mv', title:'Schöne 2-Zimmer-Wohnung in Schönberg MV', description:'',
          price:{ amount:600, price_type:'FIXED' }, status:'ACTIVE', deleted:false,
          ad_url:'https://www.kleinanzeigen.de/s-anzeige/schoenberg-mv/mv-203-1',
          location:{ name:'23923 Schönberg (Mecklenburg)' }, details:{ Zimmer:'2' }
        }
      ] } });
    }
  );
  assert.deepEqual(result.listings.map(item => item.id), ['molln']);
});

test('provider rejects WG-room and Anfragestopp cards while keeping a full apartment suitable for a WG', async () => {
  const result = await searchLiveHousing(
    { location:'Pinneberg', rooms:3, amount:1200, type:'Warmmiete' },
    KEY,
    async url => {
      if (url.includes('/locations?')) {
        return json({ success:true, data:{ locations:[{ id:'400', name:'Pinneberg' }] } });
      }
      return json({ success:true, data:{ ads:[
        {
          ad_id:'wg-room', title:'Zimmer in 2er WG', description:'',
          price:{ amount:650, price_type:'FIXED' }, status:'ACTIVE', deleted:false,
          ad_url:'https://www.kleinanzeigen.de/s-anzeige/wg-room/wg-room-203-1',
          location:{ name:'25421 Pinneberg' }, details:{ Zimmer:'3' }
        },
        {
          ad_id:'stopp', title:'ANFRAGESTOPP!! Nachmieter für helle 3 Zimmer Wohnung gesucht', description:'',
          price:{ amount:800, price_type:'FIXED' }, status:'ACTIVE', deleted:false,
          ad_url:'https://www.kleinanzeigen.de/s-anzeige/stopp/stopp-203-1',
          location:{ name:'25421 Pinneberg' }, details:{ Zimmer:'3' }
        },
        {
          ad_id:'full-flat', title:'3-Zimmer-Wohnung / 2er WG geeignet', description:'Komplette Wohnung zu vermieten.',
          price:{ amount:900, price_type:'FIXED' }, status:'ACTIVE', deleted:false,
          ad_url:'https://www.kleinanzeigen.de/s-anzeige/full-flat/full-flat-203-1',
          location:{ name:'25421 Pinneberg' }, details:{ Zimmer:'3' }
        }
      ] } });
    }
  );
  assert.deepEqual(result.listings.map(item => item.id), ['full-flat']);
});


test('live provider keeps a valid upstream-radius listing when ad-level coordinates are absent', async () => {
  const radiusCriteria = { location:'Niebüll', rooms:1, amount:495, type:'Kaltmiete', radiusKm:15 };
  const calls = [];
  const result = await searchLiveHousing(radiusCriteria, KEY, async url => {
    calls.push(String(url));
    if (String(url).includes('/locations?')) {
      return json({ success:true, data:{ locations:[{
        id:'12891', name:'Niebüll', city:'Niebüll', latitude:54.7866, longitude:8.8285
      }] } });
    }
    return json({ success:true, data:{ ads:[{
      ad_id:'niebuell-1',
      title:'Schöne 1-Zimmerwohnung in Niebüll zu vergeben.',
      description:'Mietshaus mit 6 Wohnungen.',
      price:{ amount:290, price_type:'FIXED' },
      status:'ACTIVE',
      deleted:false,
      ad_url:'https://www.kleinanzeigen.de/s-anzeige/schoene-1-zimmerwohnung/123',
      location:{ name:'25899 Niebüll' },
      details:{ Zimmer:'1', 'Wohnfläche':'30 m²' },
      images:[{ url:'https://img.example.test/niebuell.jpg' }]
    }] } });
  }, { includePublic:false });

  assert.equal(result.status, 'ok');
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].id, 'niebuell-1');
  assert.equal(result.listings[0].price, 290);
  assert.equal(result.listings[0].distanceKm, null);
  assert.ok(calls.some(url => /distance=15/u.test(url)));
});
