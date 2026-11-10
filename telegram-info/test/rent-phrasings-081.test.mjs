import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// TG-RUNTIME-081 (review #079 follow-up): after a finished rent check,
// "Kaltmiete 600 inkl. Heizung, Nebenkosten 150", "Kaltmiete: 600 mit
// Heizung" and "Kaltmiete 600, Betriebskosten 150 inkl. Heizung" got
// "Тема: житло. Вкажіть місто або район".

const STAGING = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' };
const CHECK = ['Житло в Kiel для 3 осіб', 'cb:hkr:2:Kiel', 'cb:hka:r:3:2:Kiel', 'r:Kaltmiete 600, Nebenkosten 150, Heizkosten 80'];

async function last(message) {
  const f = await fixture(STAGING);
  let previous = null;
  let text = '';
  try {
    for (const step of [...CHECK, message]) {
      const before = f.calls.length;
      const callback = step.startsWith('cb:') ? step.slice(3) : null;
      const reply = step.startsWith('r:') ? step.slice(2) : null;
      await handle(f.request(callback ? '' : (reply ?? step), { user:555555, callback, previous:callback || reply !== null ? previous : null }), f.env, NOW, f.transport);
      const body = f.calls.slice(before).filter(call => call.method === 'sendMessage' && call.body?.text).at(-1)?.body;
      text = body?.text || '';
      if (body) previous = { message_id:1, text, chat:{ id:555555, type:'private' }, from:{ id:999999999, is_bot:true, username:'ZaskaletaInfoBot' } };
    }
    return text;
  } finally { f.close(); }
}

test('#081 a sum with the heating attached after a finished check keeps the other sums and names the part to split', async () => {
  for (const [message, kept, split, missing] of [
    ['Kaltmiete 600 inkl. Heizung, Nebenkosten 150', 'Betriebskosten 150 €', 'Kaltmiete', 'Kaltmiete, Heizkosten'],
    ['Kaltmiete: 600 mit Heizung', null, 'Kaltmiete', 'Kaltmiete, Betriebskosten, Heizkosten'],
    ['Kaltmiete 600, Betriebskosten 150 inkl. Heizung', 'Kaltmiete 600 €', 'Betriebskosten', 'Betriebskosten, Heizkosten'],
    ['Kaltmiete 600, Heizkosten 80, Nebenkosten inkl. Heizung 200', 'Kaltmiete 600 €; Heizkosten 80 €', 'Betriebskosten', 'Betriebskosten']]) {
    const reply = await last(message);
    assert.match(reply, /^Перевірка оренди — Kiel, 2 кімнати\./u, `${message}: ${reply}`);
    if (kept) assert.match(reply, new RegExp(`^Зібрано: ${kept}$`, 'mu'), message);
    else assert.doesNotMatch(reply, /^Зібрано:/mu, message);
    assert.match(reply, new RegExp(`Надішліть окремо ${split} \\(без опалення\\) і Heizkosten\\.`, 'u'), message);
    assert.match(reply, new RegExp(`^Ще потрібні: ${missing}\\.$`, 'mu'), message);
    assert.doesNotMatch(reply, /Kaltmiete \+ Betriebskosten:/u, 'no verdict from mixed sums');
  }
});

// Review findings (#081 round 1).
test('#081 a side cost with the heating phrase elsewhere is never stored', async () => {
  const { housingCostFollowup } = await import('../src/housing-cost-dialogue.mjs');
  const previous = 'Перевірка оренди — Kiel, 2 кімнати.\nОсіб: 3\nНадішліть основні суми з оголошення.';
  for (const [text, kept] of [['Nebenkosten 150 €, inkl. Heizung', null], ['Kaltmiete 600, Nebenkosten 150,- € inkl. Heizung', 'Kaltmiete 600 €'],
    ['Kaltmiete 600, комуналка 150 разом із опаленням', 'Kaltmiete 600 €'], ['холодна 500, коммуналка 150 вместе с отоплением', 'Kaltmiete 500 €'],
    ['Kaltmiete 600, Nebenkosten 150 (inkl. Heizung)', 'Kaltmiete 600 €']]) {
    const reply = housingCostFollowup(previous, text);
    assert.doesNotMatch(reply, /Betriebskosten 150 €/u, `${text}: ${reply}`);
    if (kept) assert.match(reply, new RegExp(`^Зібрано: ${kept}$`, 'mu'), text);
  }
});

test('#081 a bare sum with heating after a finished check keeps its old meaning', async () => {
  const reply = await last('900 з опаленням');
  assert.doesNotMatch(reply, /^Перевірка оренди/u, reply);
});

// Review findings (#081 round 2).
test('#081 a second heating phrase not linked to a part keeps the old behaviour', async () => {
  const { housingCostFollowup } = await import('../src/housing-cost-dialogue.mjs');
  const previous = 'Перевірка оренди — Kiel, 2 кімнати.\nОсіб: 3\nНадішліть основні суми з оголошення.';
  for (const text of ['Kaltmiete 600 inkl. Heizung, Nebenkosten 150 (inkl. Heizung)', 'Kaltmiete 600 з опаленням, комуналка 150 разом із опаленням', 'Kaltmiete 600 inkl. Heizung, NK 150, inkl. Heizung']) {
    const reply = housingCostFollowup(previous, text);
    assert.doesNotMatch(reply, /^Зібрано:/mu, `${text}: ${reply}`);
  }
});
