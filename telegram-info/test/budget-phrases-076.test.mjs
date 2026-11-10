import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { budgetFromText } from '../src/housing-budget-line.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// TG-RUNTIME-076 (follow-up to #075): common phrasings lost the budget or
// its type: "з опаленням і комуналкою до 1000 €" and "без опалення до 700"
// were taken as a limit on a side cost, "700 € warm" was not seen, and
// inflected words ("теплої", "холодну") gave no type.

const STAGING = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' };

async function dialogue(steps) {
  const f = await fixture(STAGING);
  const replies = [];
  let last = null;
  try {
    for (const step of steps) {
      const before = f.calls.length;
      const callback = step.startsWith('cb:') ? step.slice(3) : null;
      await handle(f.request(callback ? '' : step, { user:555555, callback, previous:callback ? last : null }), f.env, NOW, f.transport);
      const body = f.calls.slice(before).filter(call => call.method === 'sendMessage' && call.body?.text).at(-1)?.body;
      replies.push(body?.text || '');
      if (body) last = { message_id:body.message_id || 1, text:body.text, chat:{ id:555555, type:'private' }, from:{ id:999999999, is_bot:true, username:'ZaskaletaInfoBot' } };
    }
    return replies;
  } finally { f.close(); }
}

test('#076 several included costs before "до": a Warmmiete budget', () => {
  for (const text of ['Kiel 2 кімнати з опаленням і комуналкою до 1000 €', 'Kiel з комуналкою та опаленням до 1000 €',
    'Wohnung Kiel inkl. Heizung und Nebenkosten bis 1000 €', 'Kiel з опаленням, комуналкою до 1000']) {
    assert.deepEqual(budgetFromText(text), { amount:1000, type:'Warmmiete' }, text);
  }
});

test('#076 a cost that is left out before "до" does not block the budget; the type stays open', () => {
  for (const text of ['Kiel без опалення до 700', 'Wohnung Kiel ohne Heizung bis 700 €', 'Kiel без комуналки до 700 €', 'Kiel exkl. Nebenkosten bis 700']) {
    assert.deepEqual(budgetFromText(text), { amount:700, type:null }, text);
  }
});

test('#076 a sum with € followed by warm/kalt is a budget with its type', () => {
  assert.deepEqual(budgetFromText('Kiel 700 € warm'), { amount:700, type:'Warmmiete' });
  assert.deepEqual(budgetFromText('Kiel 3 особи, 650 € kalt'), { amount:650, type:'Kaltmiete' });
  assert.deepEqual(budgetFromText('Wohnung Kiel 800 EUR Warmmiete'), { amount:800, type:'Warmmiete' });
  assert.equal(budgetFromText('Kiel 700 warm'), null, 'no currency: not taken');
});

test('#076 inflected Ukrainian and Russian type words give the type', () => {
  for (const [text, type] of [['Kiel до 900 € теплої', 'Warmmiete'], ['Kiel шукаю теплу оренду до 900', 'Warmmiete'], ['Kiel до 600 € холодної', 'Kaltmiete'],
    ['Kiel холодну оренду до 600', 'Kaltmiete'], ['Kiel до 900 евро теплая', 'Warmmiete']]) {
    assert.equal(budgetFromText(text)?.type, type, text);
  }
  assert.equal(budgetFromText('Kiel до 900 € тепла чи холодна')?.type, null, 'both named: the type is open');
  assert.equal(budgetFromText('Kiel до 900 €, теплиця поруч')?.type, null, 'another word is no type');
});

test('#076 side-cost limits stay no budget', () => {
  for (const text of ['Nebenkosten до 300 €', 'комуналка до 200 €', 'опалення до 120 €', 'NK bis 200 €', 'Heizung und Strom bis 150 €', 'опалення і комуналка до 250 €']) {
    assert.equal(budgetFromText(text), null, text);
  }
});

test('#076 the included-costs budget reaches the search step as Warmmiete', async () => {
  const replies = await dialogue(['Шукаю квартиру в Kiel з опаленням і комуналкою до 1000 € для 2 осіб', 'cb:hkr:2:Kiel', 'cb:hka:s:2:2:Kiel']);
  assert.match(replies.at(-1), /^Параметри житла: Kiel, 2 кімнати, до 1000 € Warmmiete\. Оберіть радіус пошуку/u, replies.join('\n---\n'));
});

test('#076 "N 900 € kalt" with no word before stays ambiguous; deposits stay no budget', () => {
  assert.equal(budgetFromText('Житло Kiel 3 900 € kalt'), null);
  assert.equal(budgetFromText('Kaution 1400 € warm'), null);
  assert.equal(budgetFromText('Kiel 1.200 € warm')?.amount, 1200);
});

// Review findings (#076 round 1).
test('#076 a side cost with a qualifier before "до" is still that cost\'s limit', () => {
  for (const text of ['Nebenkosten ohne Heizung bis 200 €', 'комуналка без опалення до 150 €', 'Nebenkosten exkl. Heizung bis 180 €',
    'Heizkosten ohne Strom bis 120 €', 'Nebenkosten inkl. Heizung bis 250 €', 'NK 200 € warm', 'Kiel Heizung 150 € warm', 'Kiel Strom 150 € warm']) {
    assert.equal(budgetFromText(text), null, text);
  }
});

test('#076 heating that is paid apart is no Warmmiete', () => {
  for (const text of ['Kiel з комуналкою, опалення окремо до 800', 'Kiel з комуналкою, опалення не входить, до 800 €',
    'Wohnung Kiel inkl. Nebenkosten, Heizung extra bis 800 €', 'Kiel inkl. NK, Heizung separat, bis 800 €', 'Kiel з комуналкою та опаленням окремо до 800']) {
    assert.deepEqual(budgetFromText(text), { amount:800, type:null }, text);
  }
});

test('#076 a typed sum is found next to a deposit; a deposit far before "до" does not block', () => {
  assert.deepEqual(budgetFromText('Kiel 700 € warm, Kaution 2100 €'), { amount:700, type:'Warmmiete' });
  assert.equal(budgetFromText('Kaution 1400 € ist ok, aber Miete bitte bis 800 €')?.amount, 800);
});

// Review findings (#076 round 2).
test('#076 a cost inside an included list is no limit; a compound word is no cost', () => {
  assert.deepEqual(budgetFromText('Kiel з комуналкою з опаленням до 1000'), { amount:1000, type:'Warmmiete' });
  assert.deepEqual(budgetFromText('Kiel ohne Strom mit Heizung bis 900'), { amount:900, type:'Warmmiete' });
  assert.equal(budgetFromText('Kiel mit Fußbodenheizung inkl. NK bis 900')?.amount, 900);
  assert.equal(budgetFromText('Nebenkosten ohne Heizung bis 200 €'), null);
});

// Review findings (#076 round 3).
test('#076 a "до" sum after a list of costs does not override a priced rent', () => {
  assert.deepEqual(budgetFromText('Kiel холодна 600 €, з комуналкою без опалення до 200 €'), { amount:600, type:'Kaltmiete' });
  assert.equal(budgetFromText('Kiel за 600 €, з комуналкою без опалення до 200 €')?.amount, 600);
  assert.deepEqual(budgetFromText('Kiel з комуналкою без опалення до 750'), { amount:750, type:null });
  assert.equal(budgetFromText('Kiel Kaltmiete 600, mit Nebenkosten ohne Heizung bis 200 €'), null, 'not clear: the search step asks');
  assert.equal(budgetFromText('Stromkosten bis 150 €'), null);
  assert.equal(budgetFromText('Kiel Fernwärme, Stromkosten bis 100 €'), null);
});

// Review findings (#076 round 4).
test('#076 a sum written after the budget never replaces it; a list with the heating always stands', () => {
  for (const [text, amount, type] of [
    ['Шукаю квартиру в Kiel з опаленням і комуналкою до 1000 € для 2 осіб. Зараз живу в кімнаті за 450 €', 1000, 'Warmmiete'],
    ['Wohnung Kiel inkl. Heizung und Nebenkosten bis 1000 €, aktuell zahle ich Miete 500 €', 1000, 'Warmmiete'],
    ['Kiel з опаленням до 1000 €, зараз плачу за 600 €', 1000, 'Warmmiete'],
    ['Kiel без опалення до 700, раніше платили за 550 €', 700, null],
    ['Kiel inkl. Heizung bis 900 €, Miete 700 € wäre super', 900, 'Warmmiete'],
    ['Kiel оренда 750, з опаленням до 900', 900, 'Warmmiete'],
    ['Miete 1000, з опаленням до 1000', 1000, 'Warmmiete'],
    ['Kiel за 600 €, з комуналкою до 200 €', 600, null]]) {
    assert.deepEqual(budgetFromText(text), { amount, type }, text);
  }
});
