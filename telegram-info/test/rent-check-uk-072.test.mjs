import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { housingCostFollowup, heatingRuleText, normalizeCostLabels } from '../src/housing-cost-dialogue.mjs';
import { opsReportText, opsAlertsFor } from '../src/ops-metrics.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// TG-RUNTIME-072: the rent check (Mietprüfung) understood only the German
// names (full analysis M1): "холодна 500" fell out of the dialogue with "Не
// вдалося однозначно зрозуміти запит". The heating rule came in German. The
// owner's screen recording of 24.10.2026 showed "3 спроб сьогодні" and the raw
// source id "housing_companies" in the daily report.

const STAGING = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' };
const PROMPT = 'Житло — Kiel, 2 кімнати.\nОсіб: 2\n\n✅ Дані збережено.\nЩо саме потрібно?';

test('#072 the rent check takes Ukrainian names of the three sums, typed one by one', async () => {
  const f = await fixture(STAGING);
  try {
    await handle(f.request('Житло Kiel 2 кімнати 2 особи', { user:555555 }), f.env, NOW, f.transport);
    await handle(f.request('', { user:555555, callback:'hka:r:2:2:Kiel', previous:{ message_id:9, text:PROMPT } }), f.env, NOW, f.transport);
    const replies = [];
    for (const text of ['холодна 500', 'комуналка 120', 'опалення 90']) {
      const before = f.calls.length;
      await handle(f.request(text, { user:555555 }), f.env, NOW, f.transport);
      replies.push(f.calls.slice(before).filter(call => call.method === 'sendMessage').at(-1)?.body?.text || '');
    }
    assert.match(replies[0], /^Перевірка оренди — Kiel, 2 кімнати\.\nЗібрано: Kaltmiete 500 €/u);
    assert.match(replies[1], /Зібрано: Kaltmiete 500 €; Betriebskosten 120 €/u);
    assert.match(replies[2], /Kaltmiete \+ Betriebskosten: 620/u);
    assert.doesNotMatch(replies.join('\n'), /Не вдалося однозначно зрозуміти/u);
    assert.match(replies[2], /\nУ джерелі: «/u, 'the final answer gives the heating rule in Ukrainian with the source');
  } finally { f.close(); }
});

test('#072 all three sums in one Ukrainian message; a bare sum named in Ukrainian', () => {
  const previous = 'Перевірка оренди — Kiel, 2 кімнати.\nОсіб: 2\nНадішліть основні суми з оголошення.';
  const all = housingCostFollowup(previous, 'Холодна оренда: 500, комунальні 120 і опалення 90');
  assert.match(all, /Зібрано: Kaltmiete 500 €; Betriebskosten 120 €; Heizkosten 90 €/u);
  const pending = 'Перевірка оренди — Kiel, 2 кімнати.\nОсіб: 2\nСума без призначення: 120 €.';
  assert.match(housingCostFollowup(pending, 'комуналка'), /Зібрано: Betriebskosten 120 €/u);
  // Words that only contain a name are not taken for it.
  assert.equal(normalizeCostLabels('холоднаватий 5'), 'холоднаватий 5');
  assert.equal(normalizeCostLabels('Warmmiete 900'), 'Warmmiete 900');
});

test('#072 the heating rule is in Ukrainian, with the official German wording', () => {
  const text = heatingRuleText('Kosten der Heizung werden gesondert geprüft.');
  assert.match(text, /^Витрати на опалення \(Kosten der Heizung\) перевіряються окремо\.\nУ джерелі: «Kosten der Heizung werden gesondert geprüft\.»$/u);
  assert.match(heatingRuleText('Neue Regel.'), /^Опалення, за джерелом: «Neue Regel\.»$/u, 'an unknown wording is quoted, not invented');
});

test('#072 every heating rule in the registries has a Ukrainian text', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const files = (await readdir(new URL('../src/', import.meta.url))).filter(name => name.endsWith('.mjs'));
  const rules = new Set();
  for (const name of files) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/heatingRule: ?'([^']+)'/gu)) rules.add(match[1]);
  }
  assert.ok(rules.size >= 10, `found ${rules.size}`);
  for (const rule of rules) assert.doesNotMatch(heatingRuleText(rule), /^Опалення, за джерелом/u, rule);
});

test('#072 report and alerts: "спроби/спроб" and readable source names', () => {
  const counts = { 'src_ok:housing_companies':0, 'src_fail:housing_companies':2, 'src_ok:trave':0, 'src_fail:trave':3, 'src_ok:kleinanzeigen_public':1, 'src_fail:kleinanzeigen_public':84 };
  const text = opsReportText({ day:'2026-10-23', counts });
  assert.doesNotMatch(text, /housing_companies/u);
  assert.match(text, /Житлові компанії 0\/2/u);
  assert.match(text, /TRAVE не відповідає \(3 спроби\)/u);
  assert.match(text, /відповідає рідко: 1 з 85 спроб/u);
  const alert = opsAlertsFor(counts, ['src_fail:trave'])[0];
  assert.match(alert.text, /TRAVE не відповідає: 3 спроби сьогодні/u);
  const five = opsAlertsFor({ 'src_fail:trave':5 }, ['src_fail:trave'])[0];
  assert.match(five.text, /5 спроб сьогодні/u);
  const one = opsReportText({ day:'2026-10-23', counts:{ 'src_ok:trave':1, 'src_fail:trave':20 } });
  assert.match(one, /1 з 21 спроби/u);
});

// Review findings (#072 round 1).
test('#072 "soweit" is translated as "in the amount", not "if"', () => {
  const text = heatingRuleText('Heizkosten werden zusätzlich übernommen, soweit sie angemessen sind.');
  assert.match(text, /в тому розмірі, в якому вони відповідні/u);
  assert.doesNotMatch(text, /якщо/u);
  assert.match(heatingRuleText('Heizkosten werden zusätzlich grundsätzlich in tatsächlicher Höhe berücksichtigt; bei unwirtschaftlichem Verhalten kann eine Begrenzung erfolgen.'), /неекономної поведінки \(unwirtschaftliches Verhalten\) суму можуть обмежити/u);
});

test('#072 dashes, "євро", "за комуналку" and NK stay in the rent check', async () => {
  const f = await fixture(STAGING);
  try {
    await handle(f.request('Житло Kiel 2 кімнати 2 особи', { user:555555 }), f.env, NOW, f.transport);
    await handle(f.request('', { user:555555, callback:'hka:r:2:2:Kiel', previous:{ message_id:9, text:PROMPT } }), f.env, NOW, f.transport);
    let last = '';
    for (const text of ['холодна 500 євро', 'за комуналку 120', 'опалення — 90']) {
      const before = f.calls.length;
      await handle(f.request(text, { user:555555 }), f.env, NOW, f.transport);
      last = f.calls.slice(before).filter(call => call.method === 'sendMessage').at(-1)?.body?.text || '';
      assert.doesNotMatch(last, /Не вдалося однозначно зрозуміти/u, text);
    }
    assert.match(last, /Зібрано: Kaltmiete 500 €; Betriebskosten 120 €; Heizkosten 90 €/u);
  } finally { f.close(); }
  const previous = 'Перевірка оренди — Kiel, 2 кімнати.\nОсіб: 2\nНадішліть основні суми з оголошення.';
  assert.match(housingCostFollowup(previous, 'NK 120'), /Зібрано: Betriebskosten 120 €/u);
  assert.match(housingCostFollowup(previous, 'опалення - 90'), /Зібрано: Heizkosten 90 €/u);
});

test('#072 "без опалення" qualifies the other part; a sum "with heating" is not taken as Heizkosten', async () => {
  const previous = 'Перевірка оренди — Kiel, 2 кімнати.\nОсіб: 2\nНадішліть основні суми з оголошення.';
  assert.match(housingCostFollowup(previous, 'комуналка без опалення 120'), /Зібрано: Betriebskosten 120 €/u);
  for (const text of ['Nebenkosten inkl. Heizung 200', 'комуналка з опаленням 200']) {
    const reply = housingCostFollowup(previous, text);
    assert.doesNotMatch(reply, /Heizkosten 200|Betriebskosten 200/u, text);
    assert.match(reply, /Надішліть окремо Betriebskosten \(без опалення\) і Heizkosten/u, text);
  }
  const f = await fixture(STAGING);
  try {
    await handle(f.request('Житло Kiel 2 кімнати 2 особи', { user:555555 }), f.env, NOW, f.transport);
    await handle(f.request('', { user:555555, callback:'hka:r:2:2:Kiel', previous:{ message_id:9, text:PROMPT } }), f.env, NOW, f.transport);
    const before = f.calls.length;
    await handle(f.request('Nebenkosten inkl. Heizung 200', { user:555555 }), f.env, NOW, f.transport);
    const reply = f.calls.slice(before).filter(call => call.method === 'sendMessage').at(-1)?.body?.text || '';
    assert.match(reply, /^Перевірка оренди — Kiel/u, 'stays in the rent check');
  } finally { f.close(); }
});

test('#072 the group and legacy rent answers also give the heating rule in Ukrainian', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const name of ['worker-entry.mjs', 'group-beta-runtime.mjs']) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^\s*rule\.heatingRule,$/mu, name);
    assert.match(source, /heatingRuleText\(rule\.heatingRule\)/u, name);
  }
});

test('#072 a dash is a separator only between spaces; a negative sum is still refused', () => {
  const previous = 'Перевірка оренди — Kiel, 2 кімнати.\nОсіб: 2\nНадішліть основні суми з оголошення.';
  for (const text of ['холодна -900', 'Kaltmiete -900']) assert.doesNotMatch(housingCostFollowup(previous, text), /Зібрано:/u, text);
  assert.match(housingCostFollowup(previous, 'холодна - 900'), /Зібрано: Kaltmiete 900 €/u);
  assert.match(housingCostFollowup(previous, 'холодна—900'), /Зібрано: Kaltmiete 900 €/u);
});

// Review findings (#072 round 2).
test('#072 a sum with heating after the number is not stored; HK is Heizkosten', async () => {
  const previous = 'Перевірка оренди — Kiel, 2 кімнати.\nОсіб: 2\nНадішліть основні суми з оголошення.';
  // TG-RUNTIME-081: the prompt names the sum the heating was attached to.
  for (const [text, part] of [['комуналка 200 з опаленням', 'Betriebskosten'], ['Kaltmiete 500 inkl. Heizung', 'Kaltmiete']]) {
    const reply = housingCostFollowup(previous, text);
    assert.doesNotMatch(reply, /Зібрано:/u, text);
    assert.match(reply, new RegExp(`Надішліть окремо ${part} \\(без опалення\\) і Heizkosten\\.`, 'u'), text);
  }
  assert.match(housingCostFollowup(previous, 'Kalt 500, NK 120, HK 90'), /Зібрано: Kaltmiete 500 €; Betriebskosten 120 €; Heizkosten 90 €/u);
  const f = await fixture(STAGING);
  try {
    await handle(f.request('Житло Kiel 2 кімнати 2 особи', { user:555555 }), f.env, NOW, f.transport);
    await handle(f.request('', { user:555555, callback:'hka:r:2:2:Kiel', previous:{ message_id:9, text:PROMPT } }), f.env, NOW, f.transport);
    for (const text of ['комуналка 200 з опаленням', 'Kalt 500, NK 120, HK 90']) {
      const before = f.calls.length;
      await handle(f.request(text, { user:555555 }), f.env, NOW, f.transport);
      const reply = f.calls.slice(before).filter(call => call.method === 'sendMessage').at(-1)?.body?.text || '';
      assert.match(reply, /^Перевірка оренди — Kiel/u, `${text}: stays in the rent check`);
    }
  } finally { f.close(); }
});

test('#072 a pending sum is kept after a message "з опаленням"', () => {
  const pending = 'Перевірка оренди — Kiel, 2 кімнати.\nОсіб: 2\nСума без призначення: 700 €.';
  for (const text of ['комуналка 200 з опаленням', 'комуналка з опаленням 200']) assert.match(housingCostFollowup(pending, text), /Сума без призначення: 700 €\./u, text);
});
