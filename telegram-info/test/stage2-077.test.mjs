import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { roomsWord } from '../src/rooms.mjs';
import { replyFor } from '../src/worker.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// TG-RUNTIME-077: "Житло — Kiel, 1 кімнати." / "5 кімнати." read wrong; and
// under a Jobcenter request the rooms buttons lost "Умова: житло під
// Jobcenter." and asked for the action again.

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

test('#077 roomsWord follows Ukrainian number agreement', () => {
  for (const [label, word] of [['1', 'кімната'], ['2', 'кімнати'], ['3', 'кімнати'], ['4', 'кімнати'], ['5', 'кімнат'], ['11', 'кімнат'], ['12', 'кімнат'],
    ['21', 'кімната'], ['22', 'кімнати'], ['2-3', 'кімнати'], ['3-4', 'кімнати'], ['4-5', 'кімнат'], ['1–2', 'кімнати'], ['', 'кімнати']]) {
    assert.equal(roomsWord(label), word, label);
  }
});

test('#077 one room and five rooms read correctly through the whole search', async () => {
  const one = await dialogue(['Житло в Kiel для 1 особи до 600 € warm', 'cb:hkr:1:Kiel', 'cb:hka:s:1:1:Kiel', 'r:10']);
  assert.match(one[1].text, /^Житло — Kiel, 1 кімната\.\nОсіб: 1/u);
  assert.match(one[2].text, /^Параметри житла: Kiel, 1 кімната, до 600 € Warmmiete\. Оберіть радіус пошуку/u);
  // TG-RUNTIME-079: the radius answer now starts the search; the criteria
  // text (still the reply where the search does not start) keeps its grammar.
  assert.doesNotMatch(one[3].text, /Критерії пошуку зібрано/u);
  assert.match(replyFor({ text:'10', replyToText:one[2].text, chatType:'private' }), /^Критерії пошуку зібрано: Kiel, 1 кімната, до 600 € Warmmiete, радіус 10 км\./u);
  const five = await dialogue(['Житло в Kiel для 6 осіб', 'cb:hkr:5:Kiel', 'cb:hka:r:6:5:Kiel']);
  assert.match(five[1].text, /^Житло — Kiel, 5 кімнат\./u);
  assert.match(five[2].text, /^Перевірка оренди — Kiel, 5 кімнат\. Надішліть основні суми/u);
  const three = await dialogue(['Житло в Kiel для 3 осіб', 'cb:hkr:3:Kiel']);
  assert.match(three[1].text, /^Житло — Kiel, 3 кімнати\./u, 'two to four keep "кімнати"');
});

test('#077 the typed compact form agrees too', async () => {
  const replies = await dialogue(['Kiel 1 кімната 500 € kalt', 'r:10']);
  assert.match(replies[0].text, /^Параметри житла: Kiel, 1 кімната, до 500 € Kaltmiete\./u);
  assert.match(replyFor({ text:'10', replyToText:replies[0].text, chatType:'private' }), /^Критерії пошуку зібрано: Kiel, 1 кімната, до 500 € Kaltmiete, радіус 10 км\./u);
  assert.match(replies[1].text, /^(?:Знайдено|За фільтром|Сервіс актуальних оголошень|Kleinanzeigen не дав)/u, 'the radius answer starts the search');
});

test('#077 the town question of a Jobcenter request continues with the Jobcenter limits', async () => {
  const replies = await dialogue(['Житло в Elmschorn під Jobcenter для 3 осіб', 'cb:hkr:x:Elmshorn']);
  assert.match(replies[0].text, /^❓ Місто «Elmschorn» не знайдено/u);
  assert.match(replies[1].text, /^Тема: житло — Elmshorn\. Локацію вже визначено\.\nОсіб: 3\n\nОрієнтири Jobcenter Kreis Pinneberg/u, replies[1].text);
  assert.match(replies[1].text, /^Умова: житло під Jobcenter\.$/mu);
});

test('#077 a rooms button under the Jobcenter limits goes to the Jobcenter search', async () => {
  const replies = await dialogue(['Житло в Elmshorn під Jobcenter для 3 осіб', 'cb:hkr:2:Elmshorn']);
  assert.match(replies[0].text, /Для пошуку підтвердьте кількість кімнат/u);
  assert.ok(replies[1].buttons.includes('jcr:15:3:2:Elmshorn'), `the Jobcenter search start: ${replies[1].buttons}`);
  assert.doesNotMatch(replies[1].text, /Що саме потрібно\?/u, 'no second question for the action');
});

test('#077 the manual rooms step keeps the Jobcenter condition; plain requests are unchanged', async () => {
  const manual = await dialogue(['Житло в Elmshorn під Jobcenter для 3 осіб', 'cb:hkr:x:Elmshorn']);
  assert.match(manual[1].text, /Вкажіть кількість кімнат[\s\S]*\nОсіб: 3\nУмова: житло під Jobcenter\.$/u, manual[1].text);
  const plain = await dialogue(['Житло в Elmshorn для 3 осіб', 'cb:hkr:2:Elmshorn']);
  assert.match(plain[1].text, /^Житло — Elmshorn, 2 кімнати\.\nОсіб: 3[\s\S]*Що саме потрібно\?/u);
  assert.ok(plain[1].buttons.includes('hka:j:3:2:Elmshorn') && plain[1].buttons.includes('hka:s:3:2:Elmshorn'));
});
