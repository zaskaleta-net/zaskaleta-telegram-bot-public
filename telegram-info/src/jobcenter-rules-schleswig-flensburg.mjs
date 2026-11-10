const freeze = value => Object.freeze(value);

export const SCHLESWIG_FLENSBURG_KDU_REGISTRY = freeze({
  id: 'jobcenter-schleswig-flensburg-kdu-2026-03-01',
  authority: 'Kreis Schleswig-Flensburg / Sozialzentren-Jobcenter',
  jurisdiction: 'Schleswig-Flensburg',
  validFrom: '2026-03-01',
  verifiedOn: '2026-09-10',
  costMeasure: 'Bruttokaltmiete (Kaltmiete + kalte Betriebskosten, ohne Heizkosten)',
  heatingRule: 'Heizkosten werden separat auf Angemessenheit geprüft.',
  areaPolicy: 'orientation_only',
  limits: freeze({
    1: freeze([448, 50]),
    2: freeze([580, 60]),
    3: freeze([669, 75]),
    4: freeze([818, 90]),
    5: freeze([950, 105])
  }),
  extraAfter: 5,
  extraCost: 91,
  extraArea: 10,
  sources: freeze([
    freeze({
      type: 'official-kdu',
      url: 'https://www.schleswig-flensburg.de/output/download.php?fid=3333.1387.1.PDF'
    }),
    freeze({
      type: 'official-kdu-page',
      url: 'https://www.schleswig-flensburg.de/Navigation/Sozialzentrum-Jobcenter/Leistungen/'
    })
  ])
});
