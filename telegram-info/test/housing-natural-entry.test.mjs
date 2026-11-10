import test from 'node:test';
import assert from 'node:assert/strict';
import { replyFor, replyMarkupFor } from '../src/worker.mjs';

const screenshot = "Житло для сім'ї 4 людини під Джобцентер в Аренсбургу";
const reply = (text, replyToText) => replyFor({ text, replyToText });

test('Lübeck screenshot preserves two people separately from the next answer of three rooms', () => {
  let prompt = reply('Житло для двух людей в Любику під Джобцентер', reply('/start'));
  assert.match(prompt, /^Тема: житло — Lübeck\./u);
  assert.match(prompt, /^Осіб: 2$/mu);
  assert.match(prompt, /кількість кімнат/u);
  assert.doesNotMatch(prompt, /2 кімнати|Вкажіть місто/u);
  for (const input of ['3', 'Джобцентер', '900', 'Kaltmiete']) {
    prompt = reply(input, prompt);
    assert.match(prompt, /Lübeck, 3 кімнати/u, input);
    assert.match(prompt, /^Осіб: 2$/mu, input);
    assert.doesNotMatch(prompt, /Вкажіть місто|Вкажіть кількість осіб/u, input);
    assert.equal(replyMarkupFor(prompt).force_reply, true);
  }
  assert.match(prompt, /Зібрано: Kaltmiete 900 €/u);
});

test('worded household size and inline rooms survive a missing city and search continuation', () => {
  let prompt = reply('Житло для двох людей, 3 кімнати під Jobcenter');
  assert.match(prompt, /^Осіб: 2$/mu);
  assert.match(prompt, /^Кімнат: 3$/mu);
  for (const input of ['любику', 'пошук житла для Jobcenter', '900 Warmmiete', '10 км']) {
    prompt = reply(input, prompt);
    assert.match(prompt, /Lübeck, 3 кімнати/u, input);
    assert.match(prompt, /^Осіб: 2$/mu, input);
  }
  assert.match(prompt, /^Критерії пошуку зібрано:/u);
  assert.ok(replyMarkupFor(prompt).keyboard[0][0].text.includes('Lübeck'));
});

test('the screenshot request enters housing with Ahrensburg and four people, without inventing rooms', () => {
  const prompt = reply(screenshot, reply('/start'));
  assert.match(prompt, /^Тема: житло — Ahrensburg\./u);
  assert.match(prompt, /^Осіб: 4$/mu);
  assert.match(prompt, /Jobcenter/u);
  assert.match(prompt, /кількість кімнат/u);
  assert.doesNotMatch(prompt, /Вкажіть місто|4 кімнати|Тема: Jobcenter/u);
  assert.equal(replyMarkupFor(prompt).force_reply, true);
});

test('Ahrensburg case forms and explicit people labels normalize without guessing a household size', () => {
  for (const city of ['Аренсбург', 'Аренсбургу', 'Аренсбурзі', 'Аренсбурге', 'аренсбургу', 'Ahrensburg']) {
    const prompt = reply(`Житло для 4 осіб під Jobcenter в ${city}`);
    assert.match(prompt, /^Тема: житло — Ahrensburg\./u, city);
    assert.match(prompt, /^Осіб: 4$/mu, city);
  }
  const unknown = reply('Житло під Jobcenter в Аренсбургу');
  assert.doesNotMatch(unknown, /^Осіб:/mu);
  for (const size of ['0', '21', '-4', '104']) assert.doesNotMatch(reply(`Житло для ${size} людей в Аренсбургу`), /^Осіб:/mu, size);
});

test('family size and Jobcenter condition survive room selection, ambiguous action and costs', () => {
  let prompt = reply(screenshot);
  prompt = reply('3-4', prompt);
  assert.match(prompt, /^Житло — Ahrensburg, 3-4 кімнати\./u);
  assert.match(prompt, /^Осіб: 4$/mu);
  prompt = reply('800', prompt);
  assert.match(prompt, /Спочатку оберіть дію/u);
  assert.match(prompt, /^Осіб: 4$/mu);
  prompt = reply('Джобцентер', prompt);
  assert.match(prompt, /^Jobcenter-погодження житла — Ahrensburg, 3-4 кімнати\./u);
  assert.match(prompt, /^Осіб: 4$/mu);
  prompt = reply('Kaltmiete 700, Betriebskosten 150, Heizkosten 100', prompt);
  assert.match(prompt, /^Осіб: 4$/mu);
  assert.doesNotMatch(prompt, /Вкажіть кількість осіб|Вкажіть місто/u);
});

test('search stays distinct from approval and retains the household through budget and radius prompts', () => {
  let prompt = reply('3-4', reply(screenshot));
  for (const input of ['пошук житла для Jobcenter', '900', 'Warmmiete', '10 км']) {
    prompt = reply(input, prompt);
    assert.match(prompt, /Ahrensburg/u, input);
    assert.match(prompt, /^Осіб: 4$/mu, input);
    assert.doesNotMatch(prompt, /Jobcenter-погодження житла|Вкажіть місто/u, input);
  }
  assert.match(prompt, /^Критерії пошуку зібрано:/u);
  assert.ok(replyMarkupFor(prompt).keyboard[0][0].text.includes('Ahrensburg'));
});

test('inline rooms and people are separate; missing city preserves both until it is supplied', () => {
  let prompt = reply('Житло для 4 людей, 3-4 кімнати під Jobcenter');
  assert.match(prompt, /Вкажіть місто/u);
  assert.match(prompt, /^Осіб: 4$/mu);
  prompt = reply('Аренсбургу', prompt);
  assert.match(prompt, /^Житло — Ahrensburg, 3-4 кімнати\./u);
  assert.match(prompt, /^Осіб: 4$/mu);
  assert.doesNotMatch(prompt, /Уточніть кількість кімнат/u);
});

test('plain administrative Jobcenter requests and entry commands keep their routing', () => {
  assert.match(reply('Джобцентер'), /^Тема: Jobcenter\./u);
  // A concrete Bescheid question is answered directly, never as a housing request.
  for (const text of ['Jobcenter Bescheid', 'Житло: питання про Bescheid Jobcenter']) {
    assert.match(reply(text), /^🏛 Jobcenter\n[\s\S]*Bescheid/u);
    assert.doesNotMatch(reply(text), /Тема: житло/u);
  }
  const start = reply('/start', reply(screenshot));
  assert.match(start, /^Вітаємо/u);
  assert.doesNotMatch(start, /^Осіб:|Ahrensburg/mu);
});

test('Stormarn district screenshot request keeps the district and four-person household', () => {
  const prompt = reply("Потрібно житло в районі штормарн для сім'ї з 4 людей", reply('/start'));
  assert.match(prompt, /^Тема: житло — Kreis Stormarn\./u);
  assert.match(prompt, /^Осіб: 4$/mu);
  assert.doesNotMatch(prompt, /Вкажіть місто або район/u);
  assert.match(prompt, /кількість кімнат/u);

  const jobcenterPrompt = reply("Потрібно житло в районі штормарн для сім'ї з 4 людей під Джобцентер", reply('/start'));
  assert.match(jobcenterPrompt, /Kreis Stormarn/u);
  assert.match(jobcenterPrompt, /^Осіб: 4$/mu);
  assert.match(jobcenterPrompt, /уточнити конкретне місто або громаду/u);
});

test('Schleswig-Flensburg screenshot request uses Kreis rules, never Flensburg city rules', () => {
  const prompt = reply("Потрібно житло для сім'ї 4 людей в районі Шлезвіг-Фленсбург під Джобцентр", reply('/start'));
  assert.match(prompt, /^Тема: житло — Kreis Schleswig-Flensburg\./u);
  assert.match(prompt, /^Осіб: 4$/mu);
  assert.match(prompt, /Kreis Schleswig-Flensburg \/ Sozialzentren-Jobcenter/u);
  assert.match(prompt, /Площа-орієнтир: 90 м²/u);
  assert.match(prompt, /Оренда без опалення: до 818 €/u);
  assert.match(prompt, /Дані чинні з: 01\.03\.2026/u);
  assert.doesNotMatch(prompt, /Орієнтири Jobcenter Flensburg|до 772 €|01\.07\.2025/u);
});
