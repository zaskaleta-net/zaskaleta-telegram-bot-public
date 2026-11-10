import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SH_JURISDICTIONS,
  SH_ADMINISTRATIVE_AREAS,
  normalizeSchleswigHolsteinJurisdiction,
  administrativeAreaForJurisdiction,
  jobcenterModuleForJurisdiction
} from '../src/jobcenter-jurisdictions.mjs';

test('routing registry covers all 15 Schleswig-Holstein top-level jurisdictions', () => {
  assert.equal(SH_JURISDICTIONS.length,15);
  assert.equal(new Set(SH_JURISDICTIONS).size,15);
});

test('administrative registry covers 11 Kreise and 4 kreisfreie Städte with their centres', () => {
  assert.equal(Object.keys(SH_ADMINISTRATIVE_AREAS).length,15);
  const areas=SH_JURISDICTIONS.map(jurisdiction => ({ jurisdiction, ...SH_ADMINISTRATIVE_AREAS[jurisdiction] }));
  assert.equal(areas.filter(area => area.type === 'kreis').length,11);
  assert.equal(areas.filter(area => area.type === 'kreisfreie_stadt').length,4);
  assert.deepEqual(
    areas.filter(area => area.type === 'kreisfreie_stadt').map(area => area.jurisdiction).sort(),
    ['Flensburg','Kiel','Lübeck','Neumünster'].sort()
  );
  assert.deepEqual(administrativeAreaForJurisdiction('Dithmarschen'),{ jurisdiction:'Dithmarschen',type:'kreis',kreisstadt:'Heide',administrativeSeat:'Heide' });
  assert.deepEqual(administrativeAreaForJurisdiction('Herzogtum Lauenburg'),{ jurisdiction:'Herzogtum Lauenburg',type:'kreis',kreisstadt:'Ratzeburg',administrativeSeat:'Ratzeburg' });
  assert.deepEqual(administrativeAreaForJurisdiction('Nordfriesland'),{ jurisdiction:'Nordfriesland',type:'kreis',kreisstadt:'Husum',administrativeSeat:'Husum' });
  assert.deepEqual(administrativeAreaForJurisdiction('Ostholstein'),{ jurisdiction:'Ostholstein',type:'kreis',kreisstadt:'Eutin',administrativeSeat:'Eutin' });
  assert.deepEqual(administrativeAreaForJurisdiction('Pinneberg'),{ jurisdiction:'Pinneberg',type:'kreis',kreisstadt:'Pinneberg',administrativeSeat:'Elmshorn' });
  assert.deepEqual(administrativeAreaForJurisdiction('Plön'),{ jurisdiction:'Plön',type:'kreis',kreisstadt:'Plön',administrativeSeat:'Plön' });
  assert.deepEqual(administrativeAreaForJurisdiction('Rendsburg-Eckernförde'),{ jurisdiction:'Rendsburg-Eckernförde',type:'kreis',kreisstadt:'Rendsburg',administrativeSeat:'Rendsburg' });
  assert.deepEqual(administrativeAreaForJurisdiction('Schleswig-Flensburg'),{ jurisdiction:'Schleswig-Flensburg',type:'kreis',kreisstadt:'Schleswig',administrativeSeat:'Schleswig' });
  assert.deepEqual(administrativeAreaForJurisdiction('Segeberg'),{ jurisdiction:'Segeberg',type:'kreis',kreisstadt:'Bad Segeberg',administrativeSeat:'Bad Segeberg' });
  assert.deepEqual(administrativeAreaForJurisdiction('Steinburg'),{ jurisdiction:'Steinburg',type:'kreis',kreisstadt:'Itzehoe',administrativeSeat:'Itzehoe' });
  assert.deepEqual(administrativeAreaForJurisdiction('Stormarn'),{ jurisdiction:'Stormarn',type:'kreis',kreisstadt:'Bad Oldesloe',administrativeSeat:'Bad Oldesloe' });
});

test('district centres route to their correct Jobcenter jurisdiction', () => {
  const expected=new Map([
    ['Heide','Dithmarschen'],['Ratzeburg','Herzogtum Lauenburg'],['Husum','Nordfriesland'],['Eutin','Ostholstein'],
    ['Pinneberg','Pinneberg'],['Plön','Plön'],['Rendsburg','Rendsburg-Eckernförde'],['Schleswig','Schleswig-Flensburg'],
    ['Bad Segeberg','Segeberg'],['Itzehoe','Steinburg'],['Bad Oldesloe','Stormarn']
  ]);
  for (const [centre,jurisdiction] of expected) assert.equal(normalizeSchleswigHolsteinJurisdiction(centre),jurisdiction,centre);
});

test('statewide aliases route verified and pending territories without limiting provider search', () => {
  assert.equal(normalizeSchleswigHolsteinJurisdiction('Кіль'),'Kiel');
  assert.equal(normalizeSchleswigHolsteinJurisdiction('Рендсбург'),'Rendsburg-Eckernförde');
  assert.equal(normalizeSchleswigHolsteinJurisdiction('Любек'),'Lübeck');
  assert.equal(normalizeSchleswigHolsteinJurisdiction('Elmshorn'),'Pinneberg');
  assert.equal(normalizeSchleswigHolsteinJurisdiction('Eutin'),'Ostholstein');
  assert.equal(normalizeSchleswigHolsteinJurisdiction('Oldenburg in Holstein'),'Ostholstein');
  assert.equal(normalizeSchleswigHolsteinJurisdiction('Neumünster'),'Neumünster');
});

test('14 source-verified modules are exposed and only Neumünster remains numeric-pending', () => {
  for (const jurisdiction of [
    'Stormarn','Dithmarschen','Herzogtum Lauenburg','Nordfriesland','Pinneberg','Plön',
    'Rendsburg-Eckernförde','Schleswig-Flensburg','Segeberg','Steinburg','Kiel','Flensburg','Lübeck','Ostholstein'
  ]) assert.equal(jobcenterModuleForJurisdiction(jurisdiction).status,'verified',jurisdiction);
  assert.equal(jobcenterModuleForJurisdiction('Eutin').status,'verified');
  assert.equal(jobcenterModuleForJurisdiction('Neumünster').status,'not_yet_verified');
  assert.equal(jobcenterModuleForJurisdiction('unknown').status,'unknown_jurisdiction');
});
