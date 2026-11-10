// Hamburg place directory for housing and Jobcenter routing.
// Coverage: all 7 Bezirke and all 104 official Stadtteile.
// Official structural sources: hamburg.de Bezirke/Stadtteile and Statistikamt Nord.

function key(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss')
    .toLowerCase().replace(/[()\/.,'’`´]/g, ' ').replace(/[-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export const HAMBURG_BOROUGHS = Object.freeze([
  'Altona', 'Bergedorf', 'Eimsbüttel', 'Hamburg-Mitte', 'Hamburg-Nord', 'Harburg', 'Wandsbek'
]);

const BOROUGH_STADTTEILE = Object.freeze({
  Altona: Object.freeze(['Altona-Altstadt','Altona-Nord','Bahrenfeld','Blankenese','Groß Flottbek','Iserbrook','Lurup','Nienstedten','Osdorf','Othmarschen','Ottensen','Rissen','Sternschanze','Sülldorf']),
  Bergedorf: Object.freeze(['Allermöhe','Altengamme','Bergedorf','Billwerder','Curslack','Kirchwerder','Lohbrügge','Moorfleet','Neuallermöhe','Neuengamme','Ochsenwerder','Reitbrook','Spadenland','Tatenberg']),
  'Eimsbüttel': Object.freeze(['Eidelstedt','Eimsbüttel','Harvestehude','Hoheluft-West','Lokstedt','Niendorf','Rotherbaum','Schnelsen','Stellingen']),
  Harburg: Object.freeze(['Altenwerder','Cranz','Eißendorf','Francop','Gut Moor','Harburg','Hausbruch','Heimfeld','Langenbek','Marmstorf','Moorburg','Neuenfelde','Neugraben-Fischbek','Neuland','Rönneburg','Sinstorf','Wilstorf']),
  'Hamburg-Mitte': Object.freeze(['Billbrook','Billstedt','Borgfelde','Finkenwerder','HafenCity','Hamburg-Altstadt','Hamm','Hammerbrook','Horn','Kleiner Grasbrook','Neustadt','Neuwerk','Rothenburgsort','St. Georg','St. Pauli','Steinwerder','Veddel','Waltershof','Wilhelmsburg']),
  'Hamburg-Nord': Object.freeze(['Alsterdorf','Barmbek-Nord','Barmbek-Süd','Dulsberg','Eppendorf','Fuhlsbüttel','Groß Borstel','Hoheluft-Ost','Hohenfelde','Langenhorn','Ohlsdorf','Uhlenhorst','Winterhude']),
  Wandsbek: Object.freeze(['Bergstedt','Bramfeld','Duvenstedt','Eilbek','Farmsen-Berne','Hummelsbüttel','Jenfeld','Lemsahl-Mellingstedt','Marienthal','Poppenbüttel','Rahlstedt','Sasel','Steilshoop','Tonndorf','Volksdorf','Wandsbek','Wellingsbüttel','Wohldorf-Ohlstedt'])
});

export const HAMBURG_STADTTEILE = Object.freeze(Object.values(BOROUGH_STADTTEILE).flat());

const UK_ALIASES = Object.freeze({
  'Altona':['альтона'], 'Altona-Altstadt':['альтона альтштадт'], 'Altona-Nord':['альтона норд'],
  'Bahrenfeld':['баренфельд'], 'Blankenese':['бланкенезе'], 'Groß Flottbek':['грос флотбек','ґрос флотбек'],
  'Iserbrook':['ізербрук'], 'Lurup':['луруп'], 'Nienstedten':['нінштедтен'], 'Osdorf':['осдорф'],
  'Othmarschen':['отмаршен'], 'Ottensen':['оттензен'], 'Rissen':['ріссен'], 'Sternschanze':['штерншанце'], 'Sülldorf':['зюльдорф'],
  'Bergedorf':['бергедорф'], 'Allermöhe':['аллермьое','аллермее'], 'Altengamme':['альтенгамме'], 'Billwerder':['більвердер'],
  'Curslack':['курслек'], 'Kirchwerder':['кірхвердер'], 'Lohbrügge':['лобрюгге','лобрюґґе'], 'Moorfleet':['морфліт'],
  'Neuallermöhe':['нойаллермьое'], 'Neuengamme':['нойенгамме'], 'Ochsenwerder':['оксенвердер'], 'Reitbrook':['райтбрук'],
  'Spadenland':['шпаденланд'], 'Tatenberg':['татенберг'],
  'Eimsbüttel':['аймсбюттель','аймсбютель'], 'Eidelstedt':['айдельштедт'], 'Harvestehude':['гарвестегуде'],
  'Hoheluft-West':['гоелуфт вест','хохелуфт вест'], 'Lokstedt':['локштедт'], 'Niendorf':['ніендорф'],
  'Rotherbaum':['ротербаум'], 'Schnelsen':['шнельзен'], 'Stellingen':['штеллінген'],
  'Harburg':['гарбург'], 'Altenwerder':['альтенвердер'], 'Cranz':['кранц'], 'Eißendorf':['айсендорф'], 'Francop':['франкоп'],
  'Gut Moor':['гут мор'], 'Hausbruch':['гаусбрух'], 'Heimfeld':['гаймфельд','хаймфельд'], 'Langenbek':['лангенбек'],
  'Marmstorf':['мармсторф'], 'Moorburg':['морбург'], 'Neuenfelde':['нойенфельде'], 'Neugraben-Fischbek':['нойграбен фішбек'],
  'Neuland':['нойланд'], 'Rönneburg':['реннебург','рьоннебург'], 'Sinstorf':['зінсторф'], 'Wilstorf':['вільсторф'],
  'Hamburg-Mitte':['гамбург мітте'], 'Billbrook':['більбрук'], 'Billstedt':['більштедт'], 'Borgfelde':['боргфельде'],
  'Finkenwerder':['фінкенвердер'], 'HafenCity':['гафенсіті','хафенсіті'], 'Hamburg-Altstadt':['гамбург альтштадт'],
  'Hamm':['гамм'], 'Hammerbrook':['гаммербрук'], 'Horn':['горн'], 'Kleiner Grasbrook':['кляйнер грасбрук'],
  'Neustadt':['нойштадт'], 'Neuwerk':['нойверк'], 'Rothenburgsort':['ротенбургсорт'], 'St. Georg':['санкт георг'],
  'St. Pauli':['санкт паулі'], 'Steinwerder':['штайнвердер'], 'Veddel':['веддель'], 'Waltershof':['вальтерсгоф'], 'Wilhelmsburg':['вільгельмсбург'],
  'Hamburg-Nord':['гамбург норд'], 'Alsterdorf':['альстердорф'], 'Barmbek-Nord':['бармбек норд'], 'Barmbek-Süd':['бармбек зюд'],
  'Dulsberg':['дульсберг'], 'Eppendorf':['еппендорф'], 'Fuhlsbüttel':['фульсбюттель','фульсбютель'], 'Groß Borstel':['грос борстель'],
  'Hoheluft-Ost':['гоелуфт ост','хохелуфт ост'], 'Hohenfelde':['гоенфельде','хохенфельде'], 'Langenhorn':['лангенгорн'],
  'Ohlsdorf':['ольсдорф'], 'Uhlenhorst':['уленгорст'], 'Winterhude':['вінтергуде'],
  'Wandsbek':['вандсбек'], 'Bergstedt':['бергштедт'], 'Bramfeld':['брамфельд'], 'Duvenstedt':['дувенштедт'], 'Eilbek':['айльбек'],
  'Farmsen-Berne':['фармзен берне','фармсен берне'], 'Hummelsbüttel':['гуммельсбюттель','гуммельсбютель'], 'Jenfeld':['єнфельд'],
  'Lemsahl-Mellingstedt':['лемзаль меллінгштедт'], 'Marienthal':['марієнталь'], 'Poppenbüttel':['поппенбюттель','поппенбютель'],
  'Rahlstedt':['ральштедт'], 'Sasel':['зазель'], 'Steilshoop':['штайльсгоп'], 'Tonndorf':['тонндорф'], 'Volksdorf':['фольксдорф'],
  'Wellingsbüttel':['веллінгсбюттель','веллінгсбютель'], 'Wohldorf-Ohlstedt':['вольдорф ольштедт']
});

const rows = [];
for (const [borough, places] of Object.entries(BOROUGH_STADTTEILE)) {
  for (const canonical of places) rows.push(Object.freeze({
    canonical, borough, aliases:Object.freeze(UK_ALIASES[canonical] || [])
  }));
}

export const HAMBURG_PLACE_ROWS = Object.freeze(rows);

const direct = new Map();
direct.set('hamburg', Object.freeze({ canonical:'Hamburg', borough:null }));
direct.set('гамбург', Object.freeze({ canonical:'Hamburg', borough:null }));
for (const borough of HAMBURG_BOROUGHS) {
  direct.set(key(borough), Object.freeze({ canonical:borough, borough }));
  for (const alias of UK_ALIASES[borough] || []) direct.set(key(alias), Object.freeze({ canonical:borough, borough }));
}
for (const row of HAMBURG_PLACE_ROWS) {
  direct.set(key(row.canonical), row);
  for (const alias of row.aliases) direct.set(key(alias), row);
}

const searchable = [...direct.entries()].sort((a,b) => b[0].length - a[0].length);

function stripHamburgContext(value) {
  return key(value).replace(/^\d{5}\s+/, '').replace(/^hamburg\s+/, '').replace(/\s+hamburg$/, '').trim();
}

export function hamburgPlaceRoute(value) {
  const raw = key(value);
  if (!raw) return null;
  const exact = direct.get(raw) || direct.get(stripHamburgContext(raw));
  if (exact) return { ...exact, jurisdiction:'Hamburg', ruleLocation:exact.canonical };

  const cleaned = raw.replace(/^\d{5}\s+/, ' ');
  if (/\bhamburg\b/u.test(cleaned)) {
    for (const [alias, row] of searchable) {
      if (alias === 'hamburg') continue;
      if (new RegExp(`(?:^| )${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$| )`, 'u').test(cleaned)) {
        return { ...row, jurisdiction:'Hamburg', ruleLocation:row.canonical };
      }
    }
    return { canonical:'Hamburg', borough:null, jurisdiction:'Hamburg', ruleLocation:'Hamburg' };
  }
  return null;
}

export function canonicalHamburgPlace(value) {
  return hamburgPlaceRoute(value)?.canonical || null;
}

export function hamburgBoroughFor(value) {
  return hamburgPlaceRoute(value)?.borough || null;
}
