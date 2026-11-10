import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { replyFor } from '../src/worker.mjs';
import { HAMBURG_STADTTEILE } from '../src/hamburg-place-names.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// TG-RUNTIME-074 (full analysis H6): a town with a small typo ("Elmschorn",
// "Lübek") got "Не вдалося однозначно зрозуміти запит", and "Житло в
// Elmschorn для 3 осіб" took "Elmschorn" as the town. Review: a silent
// correction is dangerous (Wandsbek → Wasbek with another Kreis's Jobcenter
// limits, Kiew → Kiel), so the bot asks, and only when one letter is off.

const STAGING = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' };

async function say(text, previous = null) {
  const f = await fixture(STAGING);
  try {
    await handle(f.request(text, { user:555555 }), f.env, NOW, f.transport);
    const body = f.calls.filter(call => call.method === 'sendMessage' && call.body?.text).at(-1)?.body;
    if (!previous) return body;
    const before = f.calls.length;
    await handle(f.request('', { user:555555, callback:previous, previous:{ message_id:9, text:body.text } }), f.env, NOW, f.transport);
    return { first:body, next:f.calls.slice(before).filter(call => call.method === 'sendMessage').at(-1)?.body };
  } finally { f.close(); }
}

const buttons = body => (body?.reply_markup?.inline_keyboard || []).flat().map(button => button.callback_data).filter(Boolean);
const QUESTION = (typed, town) => new RegExp(`^❓ Місто «${typed}» не знайдено\\. Можливо, ви мали на увазі ${town}\\?`, 'u');

test('#074 a bare town one letter off gets a question with the topics for the suggested town', async () => {
  for (const [typed, town] of [['Elmschorn', 'Elmshorn'], ['Lübek', 'Lübeck'], ['Trittaw', 'Trittau'], ['Ahrensbrug', 'Ahrensburg']]) {
    const reply = await say(typed);
    assert.match(reply.text, QUESTION(typed, town), typed);
    assert.ok(buttons(reply).includes(`hkr:x:${encodeURIComponent(town)}`), `${typed}: ${buttons(reply)}`);
    assert.ok(buttons(reply).includes('nav:menu'));
  }
});

test('#074 a housing request with a typo asks first; the household size rides along', async () => {
  const { first, next } = await say('Житло в Elmschorn для 3 осіб', 'hkr:x:Elmshorn');
  assert.match(first.text, QUESTION('Elmschorn', 'Elmshorn'));
  assert.match(first.text, /\nОсіб: 3$/u);
  assert.doesNotMatch(first.text, /Тема: житло — Elmshorn/u, 'no silent correction');
  assert.match(next.text, /^Тема: житло — Elmshorn\.[\s\S]*Осіб: 3/u, 'the button continues with the town and the persons');
});

test('#074 Hamburg districts are never "corrected" into Schleswig-Holstein villages', () => {
  for (const name of HAMBURG_STADTTEILE) {
    for (const text of [name, `житло в ${name} для 3 осіб`, `житло в ${name} Jobcenter 3 особи`]) {
      assert.doesNotMatch(replyFor({ text, chatType:'private' }), /^❓ Місто/u, text);
    }
  }
});

test('#074 ordinary words and towns outside Schleswig-Holstein get no town question', () => {
  const words = ['Kiew', 'Kiev', 'Kyiv', 'Köln', 'Koeln', 'Kassel', 'Halle', 'Krakow', 'Stettin', 'Hamburgh', 'Berlin', 'München', 'Bremen',
    'Strand', 'Strasse', 'Hostel', 'Morgen', 'Gestern', 'Berg', 'Lehrer', 'Studium', 'Schimmel', 'Film', 'Möbel', 'Rad', 'Hebamme', 'Husten',
    'Schmerzen', 'Nase', 'Name', 'Kosten', 'Schufa', 'Schüler', 'Schnell', 'Toll', 'Week', 'Brother', 'Sister', 'Selo', 'Bela', 'Lina',
    'Привіт', 'Hallo', 'Danke', 'Termin', 'Miete', 'Hilfe', 'Kino', 'Arzt', 'Bank', 'Post', 'Markt', 'Hund', 'Jobcentr', 'Bürgergeld'];
  const hits = words.filter(text => /^❓ Місто|^📍/u.test(replyFor({ text, chatType:'private' })) && !/^📍 (Kiel|Berlin)/u.test(replyFor({ text, chatType:'private' })));
  assert.deepEqual(hits, [], `false town replies: ${hits}`);
  for (const text of ['житло в Kiew для 3 осіб', 'житло в Köln для 3 осіб', 'житло в Kassel для 3 осіб']) {
    assert.doesNotMatch(replyFor({ text, chatType:'private' }), /^❓ Місто|Kiel|Köhn|Kosel/u, text);
  }
});

test('#074 right names get no question; groups get no question', () => {
  assert.match(replyFor({ text:'Kiel', chatType:'private' }), /^📍 Kiel — що потрібно\?/u);
  assert.doesNotMatch(replyFor({ text:'Житло в Kiel для 3 осіб', chatType:'private' }), /^❓/u);
  assert.match(replyFor({ text:'Hamburg', chatType:'private' }), /^📍 Hamburg — що потрібно\?/u);
  assert.doesNotMatch(replyFor({ text:'Житло в Elmschorn для 3 осіб', chatType:'supergroup' }), /^❓/u);
  assert.doesNotMatch(replyFor({ text:'Elmschorn', chatType:'supergroup' }), /^❓/u);
});

// Review findings (#074 round 2).
test('#074 the question keeps rooms and the Jobcenter condition; the button continues with them', async () => {
  const { first, next } = await say('Житло в Elmschorn, 2 кімнати, Jobcenter, 3 особи', 'hkp:3:2:Elmshorn');
  assert.match(first.text, /Осіб: 3\nКімнат: 2\nУмова: житло під Jobcenter\./u);
  assert.ok(buttons(first).includes('hka:j:3:2:Elmshorn'), `Jobcenter search button: ${buttons(first)}`);
  const plain = await say('Житло в Elmschorn, 2 кімнати, 3 особи');
  assert.ok(buttons(plain).includes('hkp:3:2:Elmshorn'), `persons and rooms known: ${buttons(plain)}`);
  assert.ok(next?.text, 'the persons/rooms button answers');
});

test('#074 a typed "так" or the suggested name answers the question with the saved details', async () => {
  for (const answer of ['так', 'Elmshorn']) {
    const f = await fixture(STAGING);
    try {
      await handle(f.request('Житло в Elmschorn для 3 осіб', { user:555555 }), f.env, NOW, f.transport);
      const before = f.calls.length;
      await handle(f.request(answer, { user:555555 }), f.env, NOW, f.transport);
      const reply = f.calls.slice(before).filter(call => call.method === 'sendMessage').at(-1)?.body?.text || '';
      assert.match(reply, /^Тема: житло — Elmshorn\.[\s\S]*Осіб: 3/u, answer);
    } finally { f.close(); }
  }
});

test('#074 spellings without umlauts are the town, not a typo', () => {
  for (const [text, town] of [['neumuenster', 'Neumünster'], ['ECKERNFOERDE', 'Eckernförde'], ['buesum', 'Büsum'], ['Niebuell', 'Niebüll']]) {
    assert.match(replyFor({ text, chatType:'private' }), new RegExp(`^📍 ${town} — що потрібно\\?`, 'u'), text);
  }
  assert.match(replyFor({ text:'Житло в Neumuenster для 3 осіб', chatType:'private' }), /^Тема: житло — Neumünster\./u);
  assert.match(replyFor({ text:'Uetersen', chatType:'private' }), /^📍 Uetersen/u, 'a real "Ue" name is not changed');
});
