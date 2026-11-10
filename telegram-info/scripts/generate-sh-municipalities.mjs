import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import ExcelJS from 'exceljs';

const STATISTIK_NORD_URLS = [
  'https://www.statistik-nord.de/fileadmin/Dokumente/A_I_2_vj_26-1_Zensus22_SH.xlsx',
  'https://www.statistik-nord.de/fileadmin/Dokumente/Statistische_Berichte/bevoelkerung/A_I_2_S/A_I_2_vj_26-1_Zensus22_SH.xlsx'
];
const GV_ISYS_ADDRESS_URL = 'https://www.statistikportal.de/sites/default/files/2026-05/20260131_Anschriften_der_Gemeinde_und_Stadtverwaltungen.xlsx';
const SOURCE_PAGE = 'https://www.statistik-nord.de/zahlen-fakten/bevoelkerung/bevoelkerungsstand-und-entwicklung';
const GV_ISYS_PAGE = 'https://www.statistikportal.de/de/veroeffentlichungen/anschriftenverzeichnis';
const SOURCE_DATE = '2026-07-15';
const DATA_DATE = '2026-03-31';
const ARS_DATE = '2026-01-31';
const EXPECTED_COUNT = 1104;

const KREIS_BY_CODE = Object.freeze({
  '01':'Flensburg', '02':'Kiel', '03':'Lübeck', '04':'Neumünster',
  '51':'Dithmarschen', '53':'Herzogtum Lauenburg', '54':'Nordfriesland',
  '55':'Ostholstein', '56':'Pinneberg', '57':'Plön', '58':'Rendsburg-Eckernförde',
  '59':'Schleswig-Flensburg', '60':'Segeberg', '61':'Steinburg', '62':'Stormarn'
});

function digits(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'object') {
    if ('result' in value) return digits(value.result);
    if ('text' in value) return digits(value.text);
    if ('richText' in value && Array.isArray(value.richText)) return digits(value.richText.map(part => part.text || '').join(''));
  }
  const raw = String(value).trim().replace(/\.0$/u, '').replace(/\s+/gu, '');
  return /^\d+$/u.test(raw) ? raw : null;
}

function ags(value) {
  let code = digits(value);
  if (!code || ![7,8].includes(code.length)) return null;
  code = code.padStart(8, '0');
  return code.startsWith('010') && KREIS_BY_CODE[code.slice(3,5)] ? code : null;
}

function ars(value) {
  let code = digits(value);
  if (!code || ![11,12].includes(code.length)) return null;
  code = code.padStart(12, '0');
  return code.startsWith('010') && KREIS_BY_CODE[code.slice(3,5)] ? code : null;
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  let name = value.replace(/\s+/gu, ' ').trim();
  if (!name || name.length > 120) return null;
  if (/(?:AGS|Gemeinde|Kreis|Geschlecht|insgesamt|männlich|weiblich)$/iu.test(name)) return null;
  name = name.replace(/,\s*(?:Stadt|Landeshauptstadt|Hansestadt)\s*$/iu, '').trim();
  return name || null;
}

async function fetchWorkbook(url) {
  const response = await fetch(url, {
    headers: { 'user-agent':'zaskaleta-info-statewide-qa/1.0' },
    redirect:'follow',
    signal:AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 50_000) throw new Error(`download too small (${bytes.length}) ${url}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook;
}

function extractCurrentMunicipalities(workbook) {
  const found = new Map();
  for (const sheet of workbook.worksheets) {
    sheet.eachRow({ includeEmpty:false }, row => {
      const values = [];
      for (let i = 1; i <= Math.min(row.cellCount, 12); i += 1) values.push(row.getCell(i).value);
      for (let i = 0; i < Math.min(values.length, 6); i += 1) {
        const code = ags(values[i]);
        if (!code) continue;
        let name = null;
        for (const candidate of values.slice(i + 1, i + 6)) {
          name = cleanName(candidate);
          if (name) break;
        }
        if (name) found.set(code, Object.freeze({ ags:code, canonical:name, jurisdiction:KREIS_BY_CODE[code.slice(3,5)] }));
        break;
      }
    });
  }
  return new Map([...found.entries()].sort(([a],[b]) => a.localeCompare(b)));
}

function extractArsMap(workbook) {
  const found = new Map();
  for (const sheet of workbook.worksheets) {
    sheet.eachRow({ includeEmpty:false }, row => {
      const arsCandidates = [];
      const agsCandidates = [];
      for (let i = 1; i <= row.cellCount; i += 1) {
        const value = row.getCell(i).value;
        const a12 = ars(value);
        const a8 = ags(value);
        if (a12) arsCandidates.push(a12);
        if (a8) agsCandidates.push(a8);
      }
      for (const code8 of agsCandidates) {
        const matching = arsCandidates.find(code12 =>
          code12.slice(0,5) === code8.slice(0,5) && code12.slice(9) === code8.slice(5)
        );
        if (!matching) continue;
        const previous = found.get(code8);
        if (previous && previous !== matching) throw new Error(`conflicting ARS for AGS ${code8}: ${previous} vs ${matching}`);
        found.set(code8, matching);
      }
    });
  }
  return found;
}

function validate(current, arsMap) {
  if (current.size !== EXPECTED_COUNT) throw new Error(`Statistik Nord municipality count ${current.size}; expected ${EXPECTED_COUNT}`);
  const missing = [...current.keys()].filter(code => !arsMap.has(code));
  if (missing.length) throw new Error(`GV-ISys ARS missing for ${missing.length} current AGS; sample=${missing.slice(0,20).join(',')}`);
  const rows = [...current.values()].map(item => Object.freeze({ ...item, ars:arsMap.get(item.ags) }));
  if (new Set(rows.map(item => item.ars)).size !== EXPECTED_COUNT) throw new Error('ARS values are not unique across the 1,104 current municipalities');
  if (new Set(rows.map(item => item.jurisdiction)).size !== 15) throw new Error('current registry does not cover all 15 Schleswig-Holstein territories');
  const husum = rows.filter(item => item.canonical.toLocaleLowerCase('de-DE') === 'husum');
  if (husum.length !== 1 || husum[0].jurisdiction !== 'Nordfriesland') throw new Error(`Husum missing/misrouted: ${JSON.stringify(husum)}`);
  return rows;
}

function js(value) { return JSON.stringify(value); }

function render(rows, statistikUrl) {
  const lines = [
    '// AUTO-GENERATED DURING QA BUILD. Do not edit by hand.',
    '// Current municipality set/names: Statistikamt Nord, 1. Quartal 2026 (data 31.03.2026).',
    '// ARS/AGS hierarchy: Statistische Ämter des Bundes und der Länder, Anschriftenverzeichnis 2026 (31.01.2026).',
    `export const SH_MUNICIPALITY_SOURCE = Object.freeze({ statistikNordUrl:${js(statistikUrl)}, statistikNordPage:${js(SOURCE_PAGE)}, statistikNordPublished:${js(SOURCE_DATE)}, dataDate:${js(DATA_DATE)}, gvIsysUrl:${js(GV_ISYS_ADDRESS_URL)}, gvIsysPage:${js(GV_ISYS_PAGE)}, arsDate:${js(ARS_DATE)} });`,
    'export const SH_OFFICIAL_MUNICIPALITIES = Object.freeze(['
  ];
  for (const item of rows) lines.push(`  Object.freeze({ ags:${js(item.ags)}, ars:${js(item.ars)}, canonical:${js(item.canonical)}, jurisdiction:${js(item.jurisdiction)} }),`);
  lines.push(']);', 'export const SH_OFFICIAL_MUNICIPALITY_COUNT = SH_OFFICIAL_MUNICIPALITIES.length;', '');
  return lines.join('\n');
}

async function acquireStatistikNord() {
  const errors = [];
  for (const url of STATISTIK_NORD_URLS) {
    try {
      const workbook = await fetchWorkbook(url);
      const current = extractCurrentMunicipalities(workbook);
      if (current.size === EXPECTED_COUNT) return { current, url };
      errors.push(`${url}: parsed ${current.size}, expected ${EXPECTED_COUNT}`);
    } catch (error) {
      errors.push(`${url}: ${error?.message || error}`);
    }
  }
  throw new Error(`all official Statistik Nord XLSX sources failed: ${errors.join(' | ')}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', 'src', 'sh-municipalities-generated.mjs');
const { current, url:statistikUrl } = await acquireStatistikNord();
const gvWorkbook = await fetchWorkbook(GV_ISYS_ADDRESS_URL);
const arsMap = extractArsMap(gvWorkbook);
const rows = validate(current, arsMap);
writeFileSync(target, render(rows, statistikUrl), 'utf8');
console.log(`generated ${rows.length} current Schleswig-Holstein municipalities with ARS+AGS -> ${target}`);
