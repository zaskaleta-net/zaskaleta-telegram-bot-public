import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// TG-RUNTIME-075 (full analysis H5): "Шукаю квартиру в Kiel до 800 € для 3
// осіб" → rooms → persons → «🔎 Пошук житла» asked "Уточніть максимальний
// місячний бюджет" again: the budget was lost on the way. It now rides along
// as a "Бюджет: до N €" line, like "Осіб: N".

const STAGING = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' };

async function dialogue(steps) {
  const f = await fixture(STAGING);
  const replies = [];
  let last = null;
  try {
    for (const step of steps) {
      const before = f.calls.length;
      const callback = step.startsWith('cb:') ? step.slice(3) : null;
      const reply = step.startsWith('r:') ? step.slice(2) : null;
      await handle(f.request(callback ? '' : (reply ?? step), { user:555555, callback, previous:callback || reply !== null ? last : null }), f.env, NOW, f.transport);
      const body = f.calls.slice(before).filter(call => call.method === 'sendMessage' && call.body?.text).at(-1)?.body;
      replies.push(body?.text || '');
      // A real Telegram reply quotes the bot's own message (from.is_bot).
      if (body) last = { message_id:body.message_id || 1, text:body.text, chat:{ id:555555, type:'private' }, from:{ id:999999999, is_bot:true, username:'ZaskaletaInfoBot' } };
    }
    return replies;
  } finally { f.close(); }
}

test('#075 the budget from the first message reaches the search step (buttons)', async () => {
  const replies = await dialogue(['Шукаю квартиру в Kiel до 800 € для 3 осіб', 'cb:hkr:3:Kiel', 'cb:hka:s:3:3:Kiel']);
  assert.match(replies[0], /Бюджет: до 800 €/u);
  assert.match(replies[1], /Бюджет: до 800 €/u, 'kept on the action step');
  assert.doesNotMatch(replies[2], /Уточніть максимальний місячний бюджет/u);
  assert.match(replies[2], /^Пошук житла — Kiel, 3 кімнати, бюджет до 800 €\. Це Warmmiete чи Kaltmiete\?/u);
});

test('#075 the budget also rides along when rooms and persons are typed', async () => {
  const replies = await dialogue(['Житло в Kiel до 900 €', '3', '2', 'пошук житла']);
  assert.match(replies.at(-1), /^Пошук житла — Kiel, 3 кімнати, бюджет до 900 €\. Це Warmmiete чи Kaltmiete\?/u, replies.join('\n---\n'));
});

test('#075 a budget with its type goes straight to the radius', async () => {
  const replies = await dialogue(['Житло в Kiel до 800 € Warmmiete для 2 осіб', 'cb:hkr:2:Kiel', 'cb:hka:s:2:2:Kiel']);
  assert.match(replies.at(-1), /^Параметри житла: Kiel, 2 кімнати, до 800 € Warmmiete\. Оберіть радіус пошуку/u, replies.join('\n---\n'));
});

test('#075 no budget given: the search step still asks for it', async () => {
  const replies = await dialogue(['Житло в Kiel для 3 осіб', 'cb:hkr:3:Kiel', 'cb:hka:s:3:3:Kiel']);
  assert.match(replies.at(-1), /Уточніть максимальний місячний бюджет/u);
});

// Review findings (#075 round 1).
import { budgetFromText } from '../src/housing-budget-line.mjs';
import { housingCostFollowup } from '../src/housing-cost-dialogue.mjs';

test('#075 numbers that are no budget are not taken', () => {
  for (const text of ['Житло до 150 км від Kiel', 'Шукаю житло в Kiel до 2026 року', 'до 100 м²', 'Житло в Kiel до 24103', 'Kaution 2400 €', 'борг 3000 €',
    'зарплата 2500 €', 'Bürgergeld 563 €', 'до 3 кімнат', '22946 Trittau', '900 150 100', 'Heizkosten 90 €', 'Житло Kiel 3 900 € kalt']) {
    assert.equal(budgetFromText(text), null, text);
  }
  assert.deepEqual(budgetFromText('до 1 200 €'), { amount:1200, type:null });
  assert.deepEqual(budgetFromText('Kaltmiete до 600 € і не знаю чи warm'), { amount:600, type:null }, 'both types named: no type');
});

test('#075 a far radius is no budget: the search step still asks for it', async () => {
  const replies = await dialogue(['Житло до 150 км від Kiel для 2 осіб', 'cb:hkr:3:Kiel', 'cb:hka:s:2:3:Kiel']);
  assert.match(replies.at(-1), /Уточніть максимальний місячний бюджет/u, replies.join('\n---\n'));
});

test('#075 a new budget corrects the first one', async () => {
  const replies = await dialogue(['Житло в Kiel до 800 € для 3 осіб', 'cb:hkr:3:Kiel', 'r:пошук житла до 1000 € warm']);
  assert.match(replies.at(-1), /^Параметри житла: Kiel, 3 кімнати, до 1000 € Warmmiete\./u, replies.join('\n---\n'));
});

test('#075 the compact form keeps its rooms', async () => {
  const replies = await dialogue(['Житло Kiel 3 900 € kalt']);
  assert.match(replies[0], /3 кімнати, до 900 € Kaltmiete\. Оберіть радіус пошуку/u, replies[0]);
});

test('#075 the budget survives the town step answered by reply and the typo question', async () => {
  const town = await dialogue(['Житло до 800 €', 'r:Kiel']);
  assert.match(town.at(-1), /Бюджет: до 800 €/u, town.join('\n---\n'));
  const typo = await dialogue(['Житло в Elmschorn до 800 € для 3 осіб', 'так']);
  assert.match(typo[0], /Бюджет: до 800 €/u);
  assert.match(typo.at(-1), /^Тема: житло — Elmshorn\.[\s\S]*Бюджет: до 800 €/u, typo.join('\n---\n'));
});

test('#075 the rent check, the Jobcenter path and the search parameters carry no budget line', async () => {
  const rent = await dialogue(['Житло в Kiel до 800 € для 3 осіб', 'cb:hkr:3:Kiel', 'cb:hka:r:3:3:Kiel']);
  assert.match(rent.at(-1), /^Перевірка оренди — Kiel/u);
  assert.doesNotMatch(rent.at(-1), /Бюджет:/u);
  const jobcenter = await dialogue(['Житло під Jobcenter в Kiel для 3 осіб квартира за 700 €']);
  assert.doesNotMatch(jobcenter[0], /Бюджет:/u);
  const typed = await dialogue(['Житло в Kiel до 800 € Warmmiete для 2 осіб', 'cb:hkr:2:Kiel', 'cb:hka:s:2:2:Kiel']);
  assert.doesNotMatch(typed.at(-1), /Бюджет:/u, 'the parameters line already states it');
});

// Review findings (#075 round 2).
test('#075 metres and thousands are no budget; a full stop after the sum is fine; more phrasings', () => {
  for (const text of ['Квартира в Kiel до 300 м від вокзалу', 'до 500 m zur Schule', 'до 100 тис', 'Kaution до 2400']) assert.equal(budgetFromText(text), null, text);
  for (const [text, amount] of [['Шукаю квартиру в Kiel до 900.', 900], ['Житло в Kiel, бюджет 900.', 900], ['бюджет: 1000', 1000],
    ['ищу квартиру не дороже 700 евро', 700], ['Wohnung Kiel höchstens 800 €', 800], ['Шукаю квартиру з опаленням до 900 €', 900]]) {
    assert.equal(budgetFromText(text)?.amount, amount, text);
  }
});

test('#075 a budget at the end of a sentence reaches the search step', async () => {
  const replies = await dialogue(['Шукаю квартиру в Kiel до 900. Нас 3 особи', 'cb:hkr:3:Kiel', 'cb:hka:s:3:3:Kiel']);
  assert.match(replies.at(-1), /бюджет до 900 €\. Це Warmmiete чи Kaltmiete\?/u, replies.join('\n---\n'));
});

// Review findings (#075 round 3).
test('#075 a limit on a side cost is no rent budget; included costs are', async () => {
  for (const text of ['Nebenkosten до 300 €', 'Heizkosten bis 150', 'Betriebskosten до 250 €', 'комуналка до 200 €', 'опалення до 120 €',
    'Wohnung Kiel, Nebenkosten max. 250 €', 'Strom bis 100 €', 'Heizung до 150 €']) assert.equal(budgetFromText(text), null, text);
  assert.deepEqual(budgetFromText('Квартира в Kiel, Kaltmiete 600 €, Nebenkosten до 200 €'), { amount:600, type:'Kaltmiete' });
  assert.deepEqual(budgetFromText('Шукаю квартиру з опаленням до 900 €'), { amount:900, type:'Warmmiete' });
  assert.deepEqual(budgetFromText('Warmmiete inkl. Nebenkosten до 900'), { amount:900, type:'Warmmiete' });
  const replies = await dialogue(['Житло в Kiel, Nebenkosten до 300 € для 3 осіб', 'cb:hkr:3:Kiel', 'cb:hka:s:3:3:Kiel']);
  assert.match(replies.at(-1), /Уточніть максимальний місячний бюджет/u, replies.join('\n---\n'));
});

test('#075 a word that only ends in "nk" does not block a budget', () => {
  assert.equal(budgetFromText('Wohnung mit Bank bis 900 €')?.amount, 900);
  assert.equal(budgetFromText('NK bis 200 €'), null);
});
