import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { budgetFromText } from '../src/housing-budget-line.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// TG-RUNTIME-078 (follow-ups of #074, #076, #077): typed rooms under the
// Jobcenter condition asked for the action again; a town with a typo during
// another town's rooms step got "кімнати для Kiel"; "за 6000 €, без опалення
// до 700" took 6000 as the budget.

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
      replies.push({ text:body?.text || '', buttons:(body?.reply_markup?.inline_keyboard || []).flat().map(button => button.callback_data).filter(Boolean) });
      if (body) last = { message_id:body.message_id || 1, text:body.text, chat:{ id:555555, type:'private' }, from:{ id:999999999, is_bot:true, username:'ZaskaletaInfoBot' } };
    }
    return replies;
  } finally { f.close(); }
}

const SEARCH_START = /📖 Ознайомтеся з нормою Jobcenter\. Коли будете готові, натисніть «🔎 Почати пошук»\.$/u;

test('#078 rooms typed under the Jobcenter limits start the Jobcenter search, as the button does', async () => {
  for (const [answer, rooms] of [['r:2', '2'], ['r:3 кімнати', '3'], ['2-3', '2-3']]) {
    const replies = await dialogue(['Житло в Elmshorn під Jobcenter для 3 осіб', answer]);
    assert.match(replies[1].text, SEARCH_START, `${answer}: ${replies[1].text}`);
    assert.ok(replies[1].buttons.includes(`jcr:15:3:${rooms}:Elmshorn`), `${answer}: ${replies[1].buttons}`);
  }
});

test('#078 the manual rooms step under the Jobcenter condition starts the Jobcenter search too', async () => {
  const replies = await dialogue(['Житло в Elmshorn під Jobcenter для 3 осіб', 'cb:hkr:x:Elmshorn', 'r:3']);
  assert.match(replies[2].text, SEARCH_START);
  assert.ok(replies[2].buttons.includes('jcr:15:3:3:Elmshorn'));
});

test('#078 without the Jobcenter condition typed rooms still give the action menu', async () => {
  const replies = await dialogue(['Житло в Elmshorn для 3 осіб', 'r:2']);
  assert.match(replies[1].text, /^Житло — Elmshorn, 2 кімнати\.\nОсіб: 3[\s\S]*Що саме потрібно\?/u);
});

test('#078 a town with a typo during another town\'s rooms step gets the town question', async () => {
  for (const steps of [['Житло в Kiel для 3 осіб', 'Житло в Elmschorn для 2 осіб'], ['Житло в Kiel для 3 осіб', 'r:Elmschorn'],
    ['Житло в Kiel під Jobcenter для 3 осіб', 'Житло в Elmschorn під Jobcenter для 2 осіб']]) {
    const replies = await dialogue(steps);
    assert.match(replies[1].text, /^❓ Місто «Elmschorn» не знайдено\. Можливо, ви мали на увазі Elmshorn\?/u, steps.join(' → '));
  }
  const known = await dialogue(['Житло в Kiel під Jobcenter для 3 осіб', 'Житло в Elmshorn під Jobcenter для 2 осіб']);
  assert.match(known[1].text, /^Тема: житло — Elmshorn\./u, 'a correct new town starts its own dialogue');
});

test('#078 ordinary words and wrong answers during the rooms step are still asked again', async () => {
  for (const answer of ['r:Strand', 'abc']) {
    const replies = await dialogue(['Житло в Kiel для 3 осіб', answer]);
    assert.match(replies[1].text, /вкажіть кількість кімнат числом або діапазоном/u, answer);
  }
  const jobcenter = await dialogue(['Житло в Kiel під Jobcenter для 3 осіб', 'abc']);
  assert.match(jobcenter[1].text, /^Для пошуку житла — Kiel вкажіть кількість кімнат/u);
});

test('#078 an earlier priced sum wins only when it is a plausible rent above the side-cost limit', () => {
  assert.deepEqual(budgetFromText('Kiel за 6000 €, без опалення до 700'), { amount:700, type:null });
  assert.deepEqual(budgetFromText('Kiel за 600 €, без опалення до 700'), { amount:700, type:null });
  assert.deepEqual(budgetFromText('Kiel холодна 600 €, з комуналкою без опалення до 200 €'), { amount:600, type:'Kaltmiete' });
  assert.equal(budgetFromText('Kiel за 600 €, з комуналкою до 200 €')?.amount, 600);
});

// Review findings (#078 round 1).
test('#078 an ordinary word at the budget step is no town question', async () => {
  const replies = await dialogue(['Шукаю квартиру в Kiel для 3 осіб', 'cb:hkr:2:Kiel', 'cb:hka:s:3:2:Kiel', 'r:Heidi']);
  assert.match(replies[3].text, /^Пошук житла — Kiel, 2 кімнати\. Вкажіть бюджет числом/u, replies[3].text);
});

test('#078 the Hamburg Jobcenter guideline shows no zero area and says it is not Schleswig-Holstein', async () => {
  const replies = await dialogue(['Житло в Hamburg під Jobcenter для 3 осіб', 'r:2']);
  assert.match(replies[1].text, SEARCH_START);
  assert.doesNotMatch(replies[1].text, /Площа-орієнтир: 0 м²/u);
  assert.match(replies[1].text, /^📍 Hamburg — окрема федеральна земля, НЕ Schleswig-Holstein\.$/mu);
  const button = await dialogue(['Житло в Hamburg під Jobcenter для 3 осіб', 'cb:hkr:2:Hamburg']);
  assert.doesNotMatch(button[1].text, /Площа-орієнтир: 0 м²/u, 'the button path too');
});
