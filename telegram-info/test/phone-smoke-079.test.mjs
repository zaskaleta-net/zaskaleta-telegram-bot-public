import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// TG-RUNTIME-079 (phone smoke 27.10.2026): #8 after the radius the bot only
// said "Критерії пошуку зібрано… Наступний крок…" and waited for a keyboard
// button nobody saw; #25 new sums right after a finished rent check got
// "Тема: житло. Вкажіть місто або район" (or, as a reply, mixed with the old
// sums).

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
      if (body) last = { message_id:body.message_id || 1, text:body.text, chat:{ id:555555, type:'private' }, from:{ id:999999999, is_bot:true, username:'ZaskaletaInfoBot' } };
    }
    return replies;
  } finally { f.close(); }
}

const SEARCH_REPLY = /^(?:Знайдено|За фільтром|Сервіс актуальних оголошень|Kleinanzeigen не дав)/u;

test('#079 the radius answer runs the search at once (typed, as a reply, or the radius keyboard)', async () => {
  for (const answer of ['r:10', '10', '10 км', 'r:25 km']) {
    const replies = await dialogue(['Kiel 2 кімнати 900 € warm', answer]);
    assert.match(replies[0], /^Параметри житла: Kiel, 2 кімнати, до 900 € Warmmiete\. Оберіть радіус пошуку/u);
    assert.doesNotMatch(replies[1], /Критерії пошуку зібрано|Наступний крок/u, answer);
    assert.match(replies[1], SEARCH_REPLY, `${answer}: ${replies[1]}`);
  }
});

test('#079 the full button flow ends in the search, not in a waiting message', async () => {
  const replies = await dialogue(['Kiel', 'cb:hkr:x:Kiel', 'cb:hkr:2:Kiel', 'cb:hkp:3:2:Kiel', 'cb:hka:s:3:2:Kiel', 'r:900', 'r:Warmmiete', 'r:10']);
  assert.match(replies.at(-1), SEARCH_REPLY, replies.join('\n---\n'));
});

test('#079 a wrong radius is still asked again', async () => {
  const replies = await dialogue(['Kiel 2 кімнати 900 € warm', 'r:7']);
  assert.match(replies[1], /^Для Kiel оберіть радіус: 5, 10, 15, 25 або 50 км\./u);
});

const CHECK = ['Житло в Kiel для 3 осіб', 'cb:hkr:2:Kiel', 'cb:hka:r:3:2:Kiel', 'r:Kaltmiete 600, Nebenkosten 150, Heizkosten 80'];

test('#079 new sums right after a finished rent check start a new check in the same town', async () => {
  const replies = await dialogue([...CHECK, 'Kaltmiete 700, Betriebskosten 120, Heizkosten 90']);
  assert.match(replies[3], /^Kaltmiete \+ Betriebskosten: 750 €\.$/mu, 'the first check is finished');
  assert.match(replies[4], /^Перевірка оренди — Kiel, 2 кімнати\.\nЗібрано: Kaltmiete 700 €; Betriebskosten 120 €; Heizkosten 90 €\nОсіб: 3/u, replies[4]);
  assert.match(replies[4], /^Kaltmiete \+ Betriebskosten: 820 €\.$/mu);
});

test('#079 a side cost with the heating included after a finished check asks for the parts and keeps the Kaltmiete', async () => {
  for (const message of ['Kaltmiete 600 €, Nebenkosten inkl. Heizung 200 €', 'r:Kaltmiete 600 €, Nebenkosten inkl. Heizung 200 €']) {
    const replies = await dialogue([...CHECK, message]);
    const reply = replies[4];
    assert.match(reply, /^Перевірка оренди — Kiel, 2 кімнати\.\nЗібрано: Kaltmiete 600 €\nОсіб: 3/u, `${message}: ${reply}`);
    assert.match(reply, /Надішліть окремо Betriebskosten \(без опалення\) і Heizkosten\./u);
    assert.match(reply, /^Ще потрібні: Betriebskosten, Heizkosten\.$/mu);
    assert.doesNotMatch(reply, /Kaltmiete \+ Betriebskosten:|Betriebskosten 150 €/u, 'no old sums and no verdict');
  }
});

test('#079 other text after a finished rent check is not taken into the check', async () => {
  const replies = await dialogue([...CHECK, 'Що таке Kaution?']);
  assert.doesNotMatch(replies[4], /^Перевірка оренди/u);
});

// Review findings (#079 round 1).
test('#079 a bare number after a finished rent check keeps its own meaning', async () => {
  const three = await dialogue([...CHECK, '3']);
  assert.match(three[4], /^3 кімнати розпізнано/u);
  const budget = await dialogue([...CHECK, '900']);
  assert.match(budget[4], /^Бюджет 900 € розпізнано/u);
});

test('#079 the Kaltmiete is kept without a comma before the heating sum, dropped when it includes the heating', async () => {
  const kept = await dialogue([...CHECK, 'Kaltmiete 600 und Nebenkosten inkl. Heizung 200']);
  assert.match(kept[4], /^Зібрано: Kaltmiete 600 €$/mu);
  const dropped = await dialogue([...CHECK, 'Kaltmiete 600 inkl. Heizung']);
  assert.doesNotMatch(dropped[4], /Зібрано: Kaltmiete 600 €/u);
});
