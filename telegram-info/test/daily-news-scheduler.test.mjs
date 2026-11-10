import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNewsCardsV2 } from '../src/news-v2.mjs';

const NOW = Date.UTC(2026, 8, 13, 7, 15, 0);

function env() {
  return {
    AI:{
      async run(_model, input) {
        return { translated_text:`Українською: ${input.text ?? input.messages.at(-1).content.split('\n').at(-1)}` };
      }
    }
  };
}

function rss(items) {
  return `<?xml version="1.0"?><rss><channel>${items.map(item => `<item><title>${item.title}</title><link>${item.link}</link><description>${item.description || ''}</description></item>`).join('')}</channel></rss>`;
}

function detail(title, description, image, event = null) {
  const ld = event ? `<script type="application/ld+json">${JSON.stringify({ '@context':'https://schema.org', '@type':'Event', ...event })}</script>` : '';
  return `<!doctype html><html><head><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:image" content="${image}">${ld}</head><body></body></html>`;
}

function index(link, title) {
  return `<!doctype html><html><body><a href="${link}">${title}</a></body></html>`;
}

async function transport(url) {
  const value = String(url);
  if (value.includes('index~rss2.xml')) {
    return new Response(rss([{ title:'Ukraine-Flüchtlinge: neue Integrationshilfe', description:'Hilfe für ukrainische Geflüchtete', link:'https://www.ndr.de/nachrichten/schleswig-holstein/ukraine-fluechtlinge-test.html' }]), { status:200 });
  }
  if (value.includes('RSSNewsfeed_PI_alle.xml')) return new Response(rss([]), { status:200 });
  if (value.includes('germany4ukraine.de/DE/aktuelles/')) return new Response('<html><body></body></html>', { status:200 });
  if (value === 'https://www.hamburg.de/politik-und-verwaltung/senat/senatsthemen/ukraine') return new Response('<html><body></body></html>', { status:200 });

  if (value === 'https://www.hamburg.de/kultur/veranstaltungen') return new Response(index('https://www.hamburg.de/kultur/veranstaltungen/reeperbahn-test','Reeperbahn Festival 2026'), { status:200 });
  if (value.startsWith('https://www.luebeck.de/de/stadtleben/veranstaltungen/veranstaltungen?')) return new Response(index('https://www.luebeck.de/de/stadtleben/veranstaltungen/konzert-test','Konzert Festival 2026'), { status:200 });
  if (value === 'https://www.kiel.de/de/_info/_veranstaltungskalender.php') return new Response(index('https://www.kiel.de/de/kultur_freizeit/festival-test.php','Kultur Festival 2026'), { status:200 });

  if (value.includes('ukraine-fluechtlinge-test.html')) return new Response(detail('Ukraine-Flüchtlinge: neue Integrationshilfe','Neue Informationen für ukrainische Geflüchtete.','https://img.example.test/ukraine.jpg'), { status:200 });
  if (value.includes('reeperbahn-test')) return new Response(detail(
    'Reeperbahn Festival 2026',
    'Konzerte und Kultur in Hamburg.',
    'https://img.example.test/hamburg.jpg',
    {
      startDate:'2026-09-19T18:30:00+02:00',
      location:{ name:'Festivalgelände', address:{ streetAddress:'Spielbudenplatz 1', postalCode:'20359', addressLocality:'Hamburg' } },
      offers:{ price:'19.90', priceCurrency:'EUR' }
    }
  ), { status:200 });
  if (value.includes('konzert-test')) return new Response(detail('Konzert Festival 2026','Musik und Kultur in Lübeck.','https://img.example.test/luebeck.jpg'), { status:200 });
  if (value.includes('festival-test.php')) return new Response(detail('Kultur Festival 2026','Kultur und Musik in Kiel.','https://img.example.test/kiel.jpg'), { status:200 });

  throw new Error(`Unexpected URL: ${value}`);
}

// 2026-10-13: the Kiel/Lübeck calendars render with JavaScript and never gave a
// card, and only Ukraine+refugee items qualified, so the digest was empty. The
// digest now carries fresh NDR Schleswig-Holstein headlines, practical first.
test('news v2 adds translated NDR headlines, practical topics first, no crime or sport', async () => {
  const fresh = new Date(NOW - 3 * 60 * 60 * 1000).toUTCString();
  const old = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toUTCString();
  const week = new Date(NOW - 4 * 24 * 60 * 60 * 1000).toUTCString();
  const feed = [
    { title:'Ukraine-Flüchtlinge: neue Integrationshilfe', description:'Hilfe für ukrainische Geflüchtete', link:'https://www.ndr.de/nachrichten/schleswig-holstein/ukraine-fluechtlinge-test.html', pubDate:fresh },
    { title:'Katastrophenschutz in SH: Das sollten Haushalte wissen', description:'Vorrat und Warnung', link:'https://www.ndr.de/nachrichten/schleswig-holstein/katastrophenschutz.html', pubDate:fresh },
    { title:'Mordprozess in Kiel: Angeklagter schweigt', description:'Gericht', link:'https://www.ndr.de/nachrichten/schleswig-holstein/prozess.html', pubDate:fresh },
    { title:'THW Kiel gewinnt Spitzenspiel', description:'Handball', link:'https://www.ndr.de/sport/thw.html', pubDate:fresh },
    { title:'Licht-Events in SH: Wo es im Herbst leuchtet', description:'Tipps', link:'https://www.ndr.de/nachrichten/schleswig-holstein/licht.html', pubDate:week },
    { title:'Alte Meldung zur Bahn', description:'Bahn', link:'https://www.ndr.de/nachrichten/schleswig-holstein/alt.html', pubDate:old }
  ];
  const feedTransport = async url => {
    const value = String(url);
    if (value.includes('index~rss2.xml')) {
      return new Response(`<?xml version="1.0"?><rss><channel>${feed.map(item => `<item><title>${item.title}</title><link>${item.link}</link><description>${item.description}</description><pubDate>${item.pubDate}</pubDate></item>`).join('')}</channel></rss>`, { status:200 });
    }
    if (value.includes('RSSNewsfeed_PI_alle.xml')) return new Response(rss([]), { status:200 });
    if (value.startsWith('https://www.ndr.de/')) return new Response(detail(value.split('/').at(-1), 'Beschreibung', `https://img.example.test/${value.split('/').at(-1)}.jpg`), { status:200 });
    return new Response('<html><body></body></html>', { status:200 });
  };
  const cards = await buildNewsCardsV2(env(), NOW, feedTransport);
  const links = cards.map(card => card.link);
  assert.ok(cards.some(card => card.kind === 'refugee'));
  assert.ok(links.includes('https://www.ndr.de/nachrichten/schleswig-holstein/katastrophenschutz.html'));
  assert.ok(cards.find(card => card.link.endsWith('/licht.html'))?.eventLike, 'an event article up to 10 days old is a "Куди піти" card');
  assert.ok(!links.some(link => /prozess|thw|alt\.html/u.test(link)), JSON.stringify(links));
  assert.equal(new Set(links).size, links.length, 'no story twice');
  assert.ok(cards.every(card => card.titleUk.startsWith('Українською:')));
});
