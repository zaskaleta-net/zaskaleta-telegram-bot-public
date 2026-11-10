export const SH_JURISDICTIONS = Object.freeze([
  'Dithmarschen','Herzogtum Lauenburg','Nordfriesland','Ostholstein','Pinneberg','Plön','Rendsburg-Eckernförde','Schleswig-Flensburg','Segeberg','Steinburg','Stormarn','Flensburg','Kiel','Lübeck','Neumünster'
]);

// Official Schleswig-Holstein structure: 11 Kreise + 4 kreisfreie Städte.
// Source: Landesplanung overview map (03/2025) and state portal list of Kreise/kreisfreie Städte.
// Pinneberg is special: Kreisstadt = Pinneberg, while the Kreisverwaltung is seated in Elmshorn.
export const SH_ADMINISTRATIVE_AREAS = Object.freeze({
  Dithmarschen: Object.freeze({ type:'kreis', kreisstadt:'Heide', administrativeSeat:'Heide' }),
  'Herzogtum Lauenburg': Object.freeze({ type:'kreis', kreisstadt:'Ratzeburg', administrativeSeat:'Ratzeburg' }),
  Nordfriesland: Object.freeze({ type:'kreis', kreisstadt:'Husum', administrativeSeat:'Husum' }),
  Ostholstein: Object.freeze({ type:'kreis', kreisstadt:'Eutin', administrativeSeat:'Eutin' }),
  Pinneberg: Object.freeze({ type:'kreis', kreisstadt:'Pinneberg', administrativeSeat:'Elmshorn' }),
  Plön: Object.freeze({ type:'kreis', kreisstadt:'Plön', administrativeSeat:'Plön' }),
  'Rendsburg-Eckernförde': Object.freeze({ type:'kreis', kreisstadt:'Rendsburg', administrativeSeat:'Rendsburg' }),
  'Schleswig-Flensburg': Object.freeze({ type:'kreis', kreisstadt:'Schleswig', administrativeSeat:'Schleswig' }),
  Segeberg: Object.freeze({ type:'kreis', kreisstadt:'Bad Segeberg', administrativeSeat:'Bad Segeberg' }),
  Steinburg: Object.freeze({ type:'kreis', kreisstadt:'Itzehoe', administrativeSeat:'Itzehoe' }),
  Stormarn: Object.freeze({ type:'kreis', kreisstadt:'Bad Oldesloe', administrativeSeat:'Bad Oldesloe' }),
  Flensburg: Object.freeze({ type:'kreisfreie_stadt', kreisstadt:'Flensburg', administrativeSeat:'Flensburg' }),
  Kiel: Object.freeze({ type:'kreisfreie_stadt', kreisstadt:'Kiel', administrativeSeat:'Kiel' }),
  Lübeck: Object.freeze({ type:'kreisfreie_stadt', kreisstadt:'Lübeck', administrativeSeat:'Lübeck' }),
  Neumünster: Object.freeze({ type:'kreisfreie_stadt', kreisstadt:'Neumünster', administrativeSeat:'Neumünster' })
});

export const SH_ADMINISTRATIVE_SOURCES = Object.freeze([
  'https://www.schleswig-holstein.de/DE/landesportal/land-und-leute/kreise-kreisfreie-staedte',
  'https://www.schleswig-holstein.de/DE/fachinhalte/L/landesplanung/Downloads/uebersichtskarte_schleswigHolstein.pdf?__blob=publicationFile&v=6',
  'https://www.kreis-pinneberg.de/'
]);

const aliases = new Map([
  ['stormarn','Stormarn'],['kreis stormarn','Stormarn'],['bad oldesloe','Stormarn'],
  ['kiel','Kiel'],['кіль','Kiel'],['киль','Kiel'],
  ['schleswig-flensburg','Schleswig-Flensburg'],['schleswig flensburg','Schleswig-Flensburg'],['kreis schleswig-flensburg','Schleswig-Flensburg'],
  ['шлезвіг-фленсбург','Schleswig-Flensburg'],['шлезвіг фленсбург','Schleswig-Flensburg'],
  ['шлезвиг-фленсбург','Schleswig-Flensburg'],['шлезвиг фленсбург','Schleswig-Flensburg'],
  ['flensburg','Flensburg'],['фленсбург','Flensburg'],
  ['lübeck','Lübeck'],['lubeck','Lübeck'],['любек','Lübeck'],
  ['neumünster','Neumünster'],['neumunster','Neumünster'],['ноймюнстер','Neumünster'],
  ['rendsburg-eckernförde','Rendsburg-Eckernförde'],['rendsburg eckernforde','Rendsburg-Eckernförde'],['kreis rendsburg-eckernförde','Rendsburg-Eckernförde'],['kreis rendsburg eckernforde','Rendsburg-Eckernförde'],['rendsburg','Rendsburg-Eckernförde'],['рендсбург','Rendsburg-Eckernförde'],
  ['segeberg','Segeberg'],['kreis segeberg','Segeberg'],['bad segeberg','Segeberg'],['бад зегеберг','Segeberg'],
  ['steinburg','Steinburg'],['kreis steinburg','Steinburg'],['itzehoe','Steinburg'],
  ['pinneberg','Pinneberg'],['kreis pinneberg','Pinneberg'],['elmshorn','Pinneberg'],['wedel','Pinneberg'],['uetersen','Pinneberg'],['halstenbek','Pinneberg'],['rellingen','Pinneberg'],['tornesch','Pinneberg'],['barmstedt','Pinneberg'],['helgoland','Pinneberg'],
  ['plön','Plön'],['ploen','Plön'],['kreis plön','Plön'],['kreis ploen','Plön'],
  ['ostholstein','Ostholstein'],['kreis ostholstein','Ostholstein'],['eutin','Ostholstein'],['ahrensbök','Ostholstein'],['ahrensbok','Ostholstein'],['bosau','Ostholstein'],['süsel','Ostholstein'],['susel','Ostholstein'],['malente','Ostholstein'],['fehmarn','Ostholstein'],['neustadt in holstein','Ostholstein'],['grömitz','Ostholstein'],['gromitz','Ostholstein'],['grube','Ostholstein'],['ostholstein-mitte','Ostholstein'],['ostholstein mitte','Ostholstein'],['oldenburg in holstein','Ostholstein'],['oldenburg-land','Ostholstein'],['oldenburg land','Ostholstein'],['heiligenhafen','Ostholstein'],['lensahn','Ostholstein'],['bad schwartau','Ostholstein'],['stockelsdorf','Ostholstein'],['timmendorfer strand','Ostholstein'],['ratekau','Ostholstein'],['scharbeutz','Ostholstein'],
  ['nordfriesland','Nordfriesland'],['kreis nordfriesland','Nordfriesland'],['husum','Nordfriesland'],
  ['dithmarschen','Dithmarschen'],['kreis dithmarschen','Dithmarschen'],['heide','Dithmarschen'],
  ['herzogtum lauenburg','Herzogtum Lauenburg'],['kreis herzogtum lauenburg','Herzogtum Lauenburg'],['ratzeburg','Herzogtum Lauenburg']
]);

const VERIFIED_MODULES = Object.freeze({
  Stormarn:'jobcenter-stormarn-kdu-2025-01-01',
  Dithmarschen:'jobcenter-dithmarschen-kdu-2025-01-01',
  'Herzogtum Lauenburg':'jobcenter-herzogtum-lauenburg-kdu-2025-03-01',
  Nordfriesland:'jobcenter-nordfriesland-kdu-2026-01-01',
  Pinneberg:'jobcenter-pinneberg-kdu-2025-table',
  Plön:'jobcenter-ploen-kdu-2026-01-01',
  'Rendsburg-Eckernförde':'jobcenter-rendsburg-eckernfoerde-kdu-2026-07-01',
  'Schleswig-Flensburg':'jobcenter-schleswig-flensburg-kdu-2026-03-01',
  Segeberg:'jobcenter-segeberg-kdu-current-2025-table',
  Steinburg:'jobcenter-steinburg-kdu-2025-07-01',
  Kiel:'jobcenter-kiel-kdu-2025-01-01',
  Flensburg:'jobcenter-flensburg-kdu-2025-07-01',
  Lübeck:'jobcenter-luebeck-kdu-2026-05-01',
  Ostholstein:'jobcenter-ostholstein-kdu-2025-05-01'
});

function key(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/ß/g,'ss').toLowerCase().replace(/\b\d{5}\b/g,' ').replace(/[^a-zа-яіїєґ0-9 -]+/giu,' ').replace(/\s+/g,' ').trim();
}

function aliasInLocation(locationKey) {
  const candidates=[...aliases.entries()].sort((a,b)=>b[0].length-a[0].length);
  for (const [alias,jurisdiction] of candidates) {
    const normalizedAlias=key(alias);
    if (!normalizedAlias) continue;
    const escaped=normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    if (new RegExp(`(?:^|[ -])${escaped}(?:$|[ -])`,'u').test(locationKey)) return jurisdiction;
  }
  return null;
}

export function normalizeSchleswigHolsteinJurisdiction(value) {
  const normalized=key(value);
  // Schleswig is the Kreisstadt of Schleswig-Flensburg, but only as an exact place name.
  // Never match it as a substring of the federal-state name Schleswig-Holstein.
  if (normalized === 'schleswig') return 'Schleswig-Flensburg';
  return aliases.get(normalized) || aliasInLocation(normalized);
}

export function administrativeAreaForJurisdiction(value) {
  const jurisdiction=normalizeSchleswigHolsteinJurisdiction(value);
  if (!jurisdiction) return null;
  return Object.freeze({ jurisdiction, ...SH_ADMINISTRATIVE_AREAS[jurisdiction] });
}

export function jobcenterModuleForJurisdiction(value) {
  const jurisdiction=normalizeSchleswigHolsteinJurisdiction(value);
  if (!jurisdiction) return {status:'unknown_jurisdiction',jurisdiction:null,module:null};
  const module=VERIFIED_MODULES[jurisdiction] || null;
  return module ? {status:'verified',jurisdiction,module} : {status:'not_yet_verified',jurisdiction,module:null};
}
