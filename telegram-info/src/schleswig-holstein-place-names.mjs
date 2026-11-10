// Ukrainian/German place-name normalization for Schleswig-Holstein housing flows.
// The official state reports 1,104 municipalities, including 63 cities; this registry
// guarantees all 63 current cities plus frequently searched non-city municipalities.
// Sources used for coverage QA: Schleswig-Holstein state portal and Städteverband SH.

function key(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss')
    .toLowerCase().replace(/[()\/.,'’`´]/g, ' ').replace(/[-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const rows = Object.freeze([
  Object.freeze({ canonical:'Ahrensburg', jurisdiction:'Stormarn', ruleLocation:null, city:true, aliases:Object.freeze(['аренсбург']) }),
  Object.freeze({ canonical:'Arnis', jurisdiction:'Schleswig-Flensburg', ruleLocation:'Kreis Schleswig-Flensburg', city:true, aliases:Object.freeze(['арніс']) }),
  Object.freeze({ canonical:'Bad Bramstedt', jurisdiction:'Segeberg', ruleLocation:null, city:true, aliases:Object.freeze(['бад брамштедт', 'бад-брамштедт']) }),
  Object.freeze({ canonical:'Bad Oldesloe', jurisdiction:'Stormarn', ruleLocation:null, city:true, aliases:Object.freeze(['бад олдеслое', 'бад-олдеслое']) }),
  Object.freeze({ canonical:'Bad Schwartau', jurisdiction:'Ostholstein', ruleLocation:null, city:true, aliases:Object.freeze(['бад швартау', 'бад-швартау']) }),
  Object.freeze({ canonical:'Bad Segeberg', jurisdiction:'Segeberg', ruleLocation:null, city:true, aliases:Object.freeze(['бад зегеберг', 'бад-зегеберг', 'бад сегеберг', 'бад-сегеберг']) }),
  Object.freeze({ canonical:'Bargteheide', jurisdiction:'Stormarn', ruleLocation:null, city:true, aliases:Object.freeze(['баргтегайде']) }),
  Object.freeze({ canonical:'Barmstedt', jurisdiction:'Pinneberg', ruleLocation:null, city:true, aliases:Object.freeze(['бармштедт']) }),
  Object.freeze({ canonical:'Bredstedt', jurisdiction:'Nordfriesland', ruleLocation:'Amt Mittleres Nordfriesland', city:true, aliases:Object.freeze(['бредштедт']) }),
  Object.freeze({ canonical:'Brunsbüttel', jurisdiction:'Dithmarschen', ruleLocation:null, city:true, aliases:Object.freeze(['брунсбюттель', 'брунсбютель']) }),
  Object.freeze({ canonical:'Büdelsdorf', jurisdiction:'Rendsburg-Eckernförde', ruleLocation:null, city:true, aliases:Object.freeze(['бюдельсдорф', 'бюделсдорф']) }),
  Object.freeze({ canonical:'Eckernförde', jurisdiction:'Rendsburg-Eckernförde', ruleLocation:null, city:true, aliases:Object.freeze(['екернферде', 'еккернферде']) }),
  Object.freeze({ canonical:'Elmshorn', jurisdiction:'Pinneberg', ruleLocation:null, city:true, aliases:Object.freeze(['ельмсгорн', 'ельмшорн']) }),
  Object.freeze({ canonical:'Eutin', jurisdiction:'Ostholstein', ruleLocation:null, city:true, aliases:Object.freeze(['ойтін', 'еутін']) }),
  Object.freeze({ canonical:'Flensburg', jurisdiction:'Flensburg', ruleLocation:null, city:true, aliases:Object.freeze(['фленсбург']) }),
  Object.freeze({ canonical:'Friedrichstadt', jurisdiction:'Nordfriesland', ruleLocation:'Amt Nordsee-Treene', city:true, aliases:Object.freeze(['фрідріхштадт']) }),
  Object.freeze({ canonical:'Garding', jurisdiction:'Nordfriesland', ruleLocation:'Amt Eiderstedt', city:true, aliases:Object.freeze(['гардінг']) }),
  Object.freeze({ canonical:'Geesthacht', jurisdiction:'Herzogtum Lauenburg', ruleLocation:null, city:true, aliases:Object.freeze(['геестгахт', 'гестгахт']) }),
  Object.freeze({ canonical:'Glinde', jurisdiction:'Stormarn', ruleLocation:null, city:true, aliases:Object.freeze(['глінде']) }),
  Object.freeze({ canonical:'Glücksburg (Ostsee)', jurisdiction:'Schleswig-Flensburg', ruleLocation:'Kreis Schleswig-Flensburg', city:true, aliases:Object.freeze(['глюксбург', 'глюксбург остзее']) }),
  Object.freeze({ canonical:'Glückstadt', jurisdiction:'Steinburg', ruleLocation:null, city:true, aliases:Object.freeze(['глюкштадт']) }),
  Object.freeze({ canonical:'Heide', jurisdiction:'Dithmarschen', ruleLocation:null, city:true, aliases:Object.freeze(['гайде', 'хайде']) }),
  Object.freeze({ canonical:'Heiligenhafen', jurisdiction:'Ostholstein', ruleLocation:null, city:true, aliases:Object.freeze(['гайлігенгафен', 'хайлігенхафен', 'гайлігенхафен']) }),
  Object.freeze({ canonical:'Husum', jurisdiction:'Nordfriesland', ruleLocation:null, city:true, aliases:Object.freeze(['гузум', 'хузум']) }),
  Object.freeze({ canonical:'Itzehoe', jurisdiction:'Steinburg', ruleLocation:null, city:true, aliases:Object.freeze(['ітцего', 'ітцегое', 'ітцехое', 'итцего', 'итцегое', 'итцехое']) }),
  Object.freeze({ canonical:'Kaltenkirchen', jurisdiction:'Segeberg', ruleLocation:null, city:true, aliases:Object.freeze(['кальтенкірхен']) }),
  Object.freeze({ canonical:'Kappeln', jurisdiction:'Schleswig-Flensburg', ruleLocation:'Kreis Schleswig-Flensburg', city:true, aliases:Object.freeze(['каппельн', 'капельн']) }),
  Object.freeze({ canonical:'Kellinghusen', jurisdiction:'Steinburg', ruleLocation:null, city:true, aliases:Object.freeze(['келлінггузен', 'келінггузен']) }),
  Object.freeze({ canonical:'Kiel', jurisdiction:'Kiel', ruleLocation:null, city:true, aliases:Object.freeze(['кіль', 'кіл', 'киль', 'кил']) }),
  Object.freeze({ canonical:'Krempe', jurisdiction:'Steinburg', ruleLocation:'Amt Krempermarsch', city:true, aliases:Object.freeze(['кремпе']) }),
  Object.freeze({ canonical:'Lauenburg/Elbe', jurisdiction:'Herzogtum Lauenburg', ruleLocation:'Lauenburg', city:true, aliases:Object.freeze(['лауенбург', 'лауенбург ельба', 'лауенбург на ельбі']) }),
  Object.freeze({ canonical:'Lübeck', jurisdiction:'Lübeck', ruleLocation:null, city:true, aliases:Object.freeze(['любек']) }),
  Object.freeze({ canonical:'Lütjenburg', jurisdiction:'Plön', ruleLocation:'Lütjenburg', city:true, aliases:Object.freeze(['лютенбург', 'лютєнбург']) }),
  Object.freeze({ canonical:'Meldorf', jurisdiction:'Dithmarschen', ruleLocation:null, city:true, aliases:Object.freeze(['мельдорф']) }),
  Object.freeze({ canonical:'Mölln', jurisdiction:'Herzogtum Lauenburg', ruleLocation:null, city:true, aliases:Object.freeze(['мельн', 'мьольн', 'мьолльн']) }),
  Object.freeze({ canonical:'Neumünster', jurisdiction:'Neumünster', ruleLocation:null, city:true, aliases:Object.freeze(['ноймюнстер', 'ноймюнстр', 'ноймюнстер', 'ноймюнстр']) }),
  Object.freeze({ canonical:'Neustadt in Holstein', jurisdiction:'Ostholstein', ruleLocation:null, city:true, aliases:Object.freeze(['нойштадт ін гольштайн', 'нойштадт у гольштейні', 'нойштадт гольштайн']) }),
  Object.freeze({ canonical:'Niebüll', jurisdiction:'Nordfriesland', ruleLocation:'Amt Südtondern', city:true, aliases:Object.freeze(['нібюль', 'нібюлль']) }),
  Object.freeze({ canonical:'Norderstedt', jurisdiction:'Segeberg', ruleLocation:null, city:true, aliases:Object.freeze(['нордерштедт']) }),
  Object.freeze({ canonical:'Nortorf', jurisdiction:'Rendsburg-Eckernförde', ruleLocation:'Amt Nortorfer Land', city:true, aliases:Object.freeze(['норторф']) }),
  Object.freeze({ canonical:'Oldenburg in Holstein', jurisdiction:'Ostholstein', ruleLocation:null, city:true, aliases:Object.freeze(['ольденбург ін гольштайн', 'ольденбург у гольштейні', 'ольденбург в гольштейні', 'ольденбург-в-гольштейні', 'ольденбург гольштайн', 'ольденбург в гольштейне']) }),
  Object.freeze({ canonical:'Pinneberg', jurisdiction:'Pinneberg', ruleLocation:null, city:true, aliases:Object.freeze(['піннеберг', 'пеніберг', 'пеннеберг', 'пиннеберг']) }),
  Object.freeze({ canonical:'Plön', jurisdiction:'Plön', ruleLocation:'Plön', city:true, aliases:Object.freeze(['плен', 'пльон', 'плён']) }),
  Object.freeze({ canonical:'Preetz', jurisdiction:'Plön', ruleLocation:null, city:true, aliases:Object.freeze(['прец', 'претц', 'преетц']) }),
  Object.freeze({ canonical:'Quickborn', jurisdiction:'Pinneberg', ruleLocation:null, city:true, aliases:Object.freeze(['квікборн']) }),
  Object.freeze({ canonical:'Ratzeburg', jurisdiction:'Herzogtum Lauenburg', ruleLocation:null, city:true, aliases:Object.freeze(['рацебург']) }),
  Object.freeze({ canonical:'Reinbek', jurisdiction:'Stormarn', ruleLocation:null, city:true, aliases:Object.freeze(['райнбек']) }),
  Object.freeze({ canonical:'Reinfeld (Holstein)', jurisdiction:'Stormarn', ruleLocation:'Reinfeld', city:true, aliases:Object.freeze(['райнфельд', 'райнфельд гольштайн']) }),
  Object.freeze({ canonical:'Rendsburg', jurisdiction:'Rendsburg-Eckernförde', ruleLocation:null, city:true, aliases:Object.freeze(['рендсбург']) }),
  Object.freeze({ canonical:'Schenefeld', jurisdiction:'Pinneberg', ruleLocation:null, city:true, aliases:Object.freeze(['шенефельд']) }),
  Object.freeze({ canonical:'Schleswig', jurisdiction:'Schleswig-Flensburg', ruleLocation:'Kreis Schleswig-Flensburg', city:true, aliases:Object.freeze(['шлезвіг', 'шлезвиг']) }),
  Object.freeze({ canonical:'Schwarzenbek', jurisdiction:'Herzogtum Lauenburg', ruleLocation:null, city:true, aliases:Object.freeze(['шварценбек']) }),
  Object.freeze({ canonical:'Schwentinental', jurisdiction:'Plön', ruleLocation:null, city:true, aliases:Object.freeze(['швентіненталь']) }),
  Object.freeze({ canonical:'Tönning', jurisdiction:'Nordfriesland', ruleLocation:'Amt Eiderstedt', city:true, aliases:Object.freeze(['теннінг', 'тьоннінг']) }),
  Object.freeze({ canonical:'Tornesch', jurisdiction:'Pinneberg', ruleLocation:null, city:true, aliases:Object.freeze(['торнеш']) }),
  Object.freeze({ canonical:'Uetersen', jurisdiction:'Pinneberg', ruleLocation:null, city:true, aliases:Object.freeze(['ютерзен']) }),
  Object.freeze({ canonical:'Wahlstedt', jurisdiction:'Segeberg', ruleLocation:null, city:true, aliases:Object.freeze(['вальштедт']) }),
  Object.freeze({ canonical:'Wedel', jurisdiction:'Pinneberg', ruleLocation:null, city:true, aliases:Object.freeze(['ведель']) }),
  Object.freeze({ canonical:'Wesselburen', jurisdiction:'Dithmarschen', ruleLocation:null, city:true, aliases:Object.freeze(['вессельбурен']) }),
  Object.freeze({ canonical:'Wilster', jurisdiction:'Steinburg', ruleLocation:null, city:true, aliases:Object.freeze(['вільстер']) }),
  Object.freeze({ canonical:'Wyk auf Föhr', jurisdiction:'Nordfriesland', ruleLocation:'Föhr', city:true, aliases:Object.freeze(['вік ауф фер', 'вік-ауф-фер', 'вік на фері']) }),
  Object.freeze({ canonical:'Fehmarn', jurisdiction:'Ostholstein', ruleLocation:null, city:true, aliases:Object.freeze(['фемарн']) }),
  Object.freeze({ canonical:'Marne (Holstein)', jurisdiction:'Dithmarschen', ruleLocation:'Marne', city:true, aliases:Object.freeze(['марне', 'марне гольштайн']) }),

  // Frequently searched municipalities that are not legally cities.
  Object.freeze({ canonical:'Trittau', jurisdiction:'Stormarn', ruleLocation:null, city:false, aliases:Object.freeze(['тріттау', 'триттау', 'трітау']) }),
  Object.freeze({ canonical:'Halstenbek', jurisdiction:'Pinneberg', ruleLocation:null, city:false, aliases:Object.freeze(['гальстенбек', 'хальстенбек']) }),
  Object.freeze({ canonical:'Henstedt-Ulzburg', jurisdiction:'Segeberg', ruleLocation:null, city:false, aliases:Object.freeze(['генштедт ульцбург', 'хенштедт ульцбург', 'генштедт-ульцбург', 'хенштедт-ульцбург']) }),
  Object.freeze({ canonical:'Rellingen', jurisdiction:'Pinneberg', ruleLocation:null, city:false, aliases:Object.freeze(['реллінген', 'релінген']) }),
  Object.freeze({ canonical:'Ahrensbök', jurisdiction:'Ostholstein', ruleLocation:null, city:false, aliases:Object.freeze(['аренсбек', 'аренсбьок']) }),
  Object.freeze({ canonical:'Grömitz', jurisdiction:'Ostholstein', ruleLocation:null, city:false, aliases:Object.freeze(['греміц', 'грьоміц']) }),
  Object.freeze({ canonical:'Timmendorfer Strand', jurisdiction:'Ostholstein', ruleLocation:null, city:false, aliases:Object.freeze(['тіммендорфер штранд', 'тіммендорфер-штранд']) }),
  Object.freeze({ canonical:'Scharbeutz', jurisdiction:'Ostholstein', ruleLocation:null, city:false, aliases:Object.freeze(['шарбойц', 'шарбойтц']) }),
  Object.freeze({ canonical:'Stockelsdorf', jurisdiction:'Ostholstein', ruleLocation:null, city:false, aliases:Object.freeze(['штокельсдорф']) }),
  Object.freeze({ canonical:'Ratekau', jurisdiction:'Ostholstein', ruleLocation:null, city:false, aliases:Object.freeze(['ратекау']) }),
  Object.freeze({ canonical:'Malente', jurisdiction:'Ostholstein', ruleLocation:null, city:false, aliases:Object.freeze(['маленте']) }),
  Object.freeze({ canonical:'Handewitt', jurisdiction:'Schleswig-Flensburg', ruleLocation:'Kreis Schleswig-Flensburg', city:false, aliases:Object.freeze(['гандевітт', 'хандевітт']) }),
  Object.freeze({ canonical:'Harrislee', jurisdiction:'Schleswig-Flensburg', ruleLocation:'Kreis Schleswig-Flensburg', city:false, aliases:Object.freeze(['гарріслє', 'харрісле', 'гарріслей']) }),
  Object.freeze({ canonical:'Sylt', jurisdiction:'Nordfriesland', ruleLocation:'Sylt', city:false, aliases:Object.freeze(['зюльт', 'сільт']) }),
  Object.freeze({ canonical:'Büsum', jurisdiction:'Dithmarschen', ruleLocation:null, city:false, aliases:Object.freeze(['бюзум']) }),
  Object.freeze({ canonical:'Bordesholm', jurisdiction:'Rendsburg-Eckernförde', ruleLocation:'Amt Bordesholm', city:false, aliases:Object.freeze(['бордесгольм']) }),
  Object.freeze({ canonical:'Gettorf', jurisdiction:'Rendsburg-Eckernförde', ruleLocation:'Amt Dänischer Wohld', city:false, aliases:Object.freeze(['гетторф']) }),
  Object.freeze({ canonical:'Fockbek', jurisdiction:'Rendsburg-Eckernförde', ruleLocation:null, city:false, aliases:Object.freeze(['фокбек']) }),
  Object.freeze({ canonical:'Altenholz', jurisdiction:'Rendsburg-Eckernförde', ruleLocation:'Gemeinde Altenholz', city:false, aliases:Object.freeze(['альтенгольц', 'альтенхольц']) }),
  Object.freeze({ canonical:'Schwedeneck', jurisdiction:'Rendsburg-Eckernförde', ruleLocation:'Amt Dänischenhagen', city:false, aliases:Object.freeze(['шведенек', 'шведенекк']) }),
  Object.freeze({ canonical:'Wentorf bei Hamburg', jurisdiction:'Herzogtum Lauenburg', ruleLocation:'Wentorf', city:false, aliases:Object.freeze(['венторф бай гамбург', 'венторф біля гамбурга']) }),
  Object.freeze({ canonical:'Büchen', jurisdiction:'Herzogtum Lauenburg', ruleLocation:'Büchen', city:false, aliases:Object.freeze(['бюхен', 'бюкен']) }),
  Object.freeze({ canonical:'Aumühle', jurisdiction:'Herzogtum Lauenburg', ruleLocation:'Amt Hohe Elbgeest', city:false, aliases:Object.freeze(['аумюле', 'аумюлє']) }),
  Object.freeze({ canonical:'Sankt Peter-Ording', jurisdiction:'Nordfriesland', ruleLocation:'Amt Eiderstedt', city:false, aliases:Object.freeze(['санкт петер ордінг', 'санкт-петер-ордінг']) }),
  Object.freeze({ canonical:'List auf Sylt', jurisdiction:'Nordfriesland', ruleLocation:'Sylt', city:false, aliases:Object.freeze(['ліст ауф зюльт', 'ліст на зюльті']) })
]);

export const SH_CITY_COUNT = rows.filter(row => row.city).length;
export const SH_UKRAINIAN_PLACE_ROWS = rows;

const aliasIndex = new Map();
for (const row of rows) {
  for (const alias of [row.canonical, ...row.aliases]) {
    const k = key(alias);
    const existing = aliasIndex.get(k);
    if (!existing || existing.canonical === row.canonical) aliasIndex.set(k, row);
  }
}

export function canonicalSchleswigHolsteinPlace(value) {
  const row = aliasIndex.get(key(value));
  return row?.canonical || null;
}

export function placeRouteForJobcenter(value) {
  const row = aliasIndex.get(key(value));
  if (!row) return null;
  return Object.freeze({ canonical:row.canonical, jurisdiction:row.jurisdiction, ruleLocation:row.ruleLocation || row.canonical, city:row.city });
}
