import test from 'node:test';
import assert from 'node:assert/strict';
import { SH_JURISDICTIONS } from '../src/jobcenter-jurisdictions.mjs';
import { SH_UKRAINIAN_PLACE_ROWS } from '../src/schleswig-holstein-place-names.mjs';
import {
  matchStatewideHousingPlace,
  normalizeStatewideHousingRequest,
  normalizeStatewideHousingText
} from '../src/housing-statewide-input.mjs';

function privateTelegramRequest(text, type = 'private') {
  return new Request('https://worker.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-test':'statewide' },
    body:JSON.stringify({
      update_id:1,
      message:{ message_id:2, chat:{ id:type === 'private' ? 123 : -123, type }, from:{ id:123, is_bot:false }, text }
    })
  });
}

test('natural housing input covers every curated Schleswig-Holstein place, not only Büsum', () => {
  assert.ok(SH_UKRAINIAN_PLACE_ROWS.length >= 63);
  const jurisdictions = new Set();
  for (const row of SH_UKRAINIAN_PLACE_ROWS) {
    jurisdictions.add(row.jurisdiction);
    const alias = row.aliases?.[0] || row.canonical;
    const source = `Житло для сім'ї двоє дітей та двоє дорослих ${alias}`;
    const matched = matchStatewideHousingPlace(source);
    assert.equal(matched?.canonical, row.canonical, `place not recognized: ${alias}`);
    assert.equal(matched?.jurisdiction, row.jurisdiction, `wrong jurisdiction: ${alias}`);
    const normalized = normalizeStatewideHousingText(source);
    assert.match(normalized, new RegExp(`^${row.canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} житло(?:\\s|$)`, 'u'));
    assert.match(normalized, /двоє дітей/u);
    assert.match(normalized, /двоє дорослих/u);
  }
  assert.deepEqual(jurisdictions, new Set(SH_JURISDICTIONS));
});

test('German canonical names with umlauts and Ukrainian aliases normalize to canonical place names', () => {
  const cases = [
    ['Житло 4 особи бюзум', 'Büsum'],
    ['Квартира для 4 осіб Любек', 'Lübeck'],
    ['wohnung für familie Ноймюнстер', 'Neumünster'],
    ['Оренда для сімʼї Пльон', 'Plön'],
    ['Житло для сім’ї Рендсбург', 'Rendsburg']
  ];
  for (const [source, canonical] of cases) {
    const normalized = normalizeStatewideHousingText(source);
    assert.ok(normalized.startsWith(`${canonical} житло`), `${source} -> ${normalized}`);
  }
});

test('housing normalizer preserves already canonical city-first input', () => {
  const source = 'Kiel житло для 4 осіб 3-4 кімнати';
  assert.equal(normalizeStatewideHousingText(source), source);
});

test('non-housing messages are not rewritten just because they contain a Schleswig-Holstein place', () => {
  const source = 'Я завтра їду до Kiel на вокзал';
  assert.equal(normalizeStatewideHousingText(source), source);
});

test('private Telegram housing update is normalized without changing headers or unrelated fields', async () => {
  const request = privateTelegramRequest("Житло для сім'ї двоє дітей та двоє дорослих Husum");
  const normalized = await normalizeStatewideHousingRequest(request);
  assert.notEqual(normalized, request);
  assert.equal(normalized.headers.get('x-test'), 'statewide');
  const payload = await normalized.json();
  assert.ok(payload.message.text.startsWith('Husum житло'));
  assert.equal(payload.update_id, 1);
  assert.equal(payload.message.message_id, 2);
});

test('group Telegram messages remain untouched for privacy-first housing flow', async () => {
  const request = privateTelegramRequest('Житло для 4 осіб Kiel', 'group');
  const normalized = await normalizeStatewideHousingRequest(request);
  assert.equal(normalized, request);
});

test('non-Telegram paths remain untouched', async () => {
  const request = new Request('https://worker.example/health', {
    method:'POST', headers:{ 'content-type':'application/json' }, body:'{}'
  });
  const normalized = await normalizeStatewideHousingRequest(request);
  assert.equal(normalized, request);
});
