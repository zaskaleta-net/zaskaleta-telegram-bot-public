import test from 'node:test';
import assert from 'node:assert/strict';
import { replyFor, replyMarkupFor } from '../src/worker.mjs';
import { housingJobcenterOverview } from '../src/housing-jobcenter-overview.mjs';
import { normalizeHousingLocation, knownHousingLocation } from '../src/housing-language.mjs';
import { telegramTextStyle } from '../src/telegram-text-style.mjs';

const reply = (text, replyToText) => replyFor({ text, replyToText });
const input = "Потрібно житло для сім'ї 3 людини в плен для Джобцентер";
const source = 'https://www.jobcenter-kreis-ploen.de/pdf/2026-01-mog-jc-kreis-ploen.pdf';

test('a complete new request replaces an older housing prompt without requiring start again', () => {
  for (const old of [
    'Тема: житло. Вкажіть місто або район.',
    'Тема: житло — Lübeck. Локацію вже визначено.\nОсіб: 2',
    'Jobcenter-погодження житла — Kiel, 4 кімнати.\nОсіб: 4\nЗібрано: Kaltmiete 900 €'
  ]) {
    const prompt = reply(input, old);
    assert.match(prompt, /^Тема: житло — Plön\./u);
    assert.match(prompt, /^Осіб: 3$/mu);
    assert.match(prompt, /до 680 € на місяць/u);
    assert.doesNotMatch(prompt, /Lübeck|Kiel|Kaltmiete 900|Осіб: [24]/u);
  }
});

test('the first reply gives the official Plön three-person table and a separate room suggestion', () => {
  const prompt = reply(input, reply('/start'));
  assert.match(prompt, /^Тема: житло — Plön\./u);
  assert.match(prompt, /^Осіб: 3$/mu);
  assert.match(prompt, /Площа-орієнтир: 75 м²/u);
  assert.match(prompt, /Оренда без опалення: до 680 € на місяць/u);
  assert.match(prompt, /Bruttokaltmiete: Kaltmiete \+ Betriebskosten без опалення/u);
  assert.match(prompt, /Heizkosten.*окремо/u);
  assert.match(prompt, /Кімнати для пошуку: 2–3 — рекомендація, не норматив/u);
  assert.match(prompt, /01\.01\.2026/u);
  assert.ok(prompt.includes(source));
  assert.ok(prompt.indexOf('680') < prompt.indexOf('підтвердьте кількість кімнат'));
  assert.doesNotMatch(prompt, /Вкажіть місто|Тема: Jobcenter|^Кімнат:/mu);
  assert.equal(replyMarkupFor(prompt).force_reply, true);
});

test('Plön table values vary with household size and do not invent a split or warm-rent cap', () => {
  for (const [persons, area, cost] of [[1,50,480],[2,60,570],[3,75,680],[4,90,800],[5,105,940]]) {
    const result = housingJobcenterOverview('Plön', persons, '2026-09-11');
    assert.match(result.text, new RegExp(`Площа-орієнтир: ${area} м²`));
    assert.ok(result.text.includes(`${cost} €`));
    assert.doesNotMatch(result.text, /Kaltmiete \d|Heizkosten \d|до .*€ Warmmiete/u);
  }
});

test('room selection continues to search without using the gross-cold cap as a warm budget', () => {
  let prompt = reply('2-3', reply(input));
  assert.match(prompt, /^Житло — Plön, 2-3 кімнати\./u);
  assert.match(prompt, /^Осіб: 3$/mu);
  prompt = reply('пошук житла', prompt);
  assert.match(prompt, /Уточніть максимальний місячний бюджет/u);
  assert.doesNotMatch(prompt, /680.*Warmmiete/u);
  for (const text of ['850 Warmmiete', '10 км']) prompt = reply(text, prompt);
  assert.match(prompt, /Plön, 2-3 кімнати, до 850 € Warmmiete/u);
  assert.match(prompt, /^Осіб: 3$/mu);
  assert.ok(replyMarkupFor(prompt).keyboard[0][0].text.includes('Plön'));
});

test('explicit rooms remain the selected value instead of being replaced by a suggestion', () => {
  const prompt = reply('Житло для 3 людей, 4 кімнати в Plön під Jobcenter');
  assert.match(prompt, /^Житло — Plön, 4 кімнати\./u);
  assert.match(prompt, /Кімнати для пошуку: 4 \(ви зазначили\)/u);
  assert.match(prompt, /680 €/u);
  assert.doesNotMatch(prompt, /підтвердьте кількість кімнат/u);
});

test('only missing household size is requested before showing norms, including worded replies', () => {
  const start = reply('Житло під Джобцентер в Plön');
  assert.match(start, /Для нормативів Jobcenter вкажіть кількість осіб/u);
  assert.doesNotMatch(start, /680|кількість кімнат/u);
  assert.equal(replyMarkupFor(start).input_field_placeholder, 'Напр.: 3 особи');
  for (const answer of ['3', 'троє', 'три людини']) {
    const prompt = reply(answer, start);
    assert.match(prompt, /680 €/u, answer);
    assert.match(prompt, /^Осіб: 3$/mu, answer);
  }
  assert.match(reply('21', start), /Для нормативів Jobcenter вкажіть кількість осіб/u);
});

test('missing city keeps household size and shows the norms as soon as the city arrives', () => {
  const start = reply('Житло для трьох людей під Jobcenter');
  assert.match(start, /Вкажіть місто/u);
  const prompt = reply('плен', start);
  assert.match(prompt, /Площа-орієнтир: 75 м²/u);
  assert.match(prompt, /680 €/u);
  assert.match(prompt, /^Осіб: 3$/mu);
});

test('district ambiguity never silently selects Plön city and retains the family for clarification', () => {
  for (const district of ['Kreis Plön', 'kreis плен', 'районі плен']) {
    const start = reply(`Житло для 3 людей в ${district} під Jobcenter`);
    assert.match(start, /конкретне місто або громаду/u, district);
    assert.doesNotMatch(start, /680 €/u, district);
    assert.match(start, /^Осіб: 3$/mu, district);
    assert.match(reply('Preetz', start), /800 €/u, district);
  }
});

test('unverified, future and individually assessed limits do not produce a numeric cap', () => {
  for (const [city,persons,date] of [['Plön',6,'2026-09-11'],['Plön',3,'2025-12-31'],['Neumünster',3,'2026-09-11'],['Nowhere',3,'2026-09-11']]) {
    const result = housingJobcenterOverview(city, persons, date);
    assert.doesNotMatch(result.text, /\d[\d,.]* €|до \d+ м²/u, city);
  }
});

test('common Plön spellings normalize without matching unrelated words', () => {
  for (const city of ['плен', 'Плён', 'Пльоні', 'плені', 'плену', 'Plön', 'Ploen', 'Plon']) {
    assert.equal(normalizeHousingLocation(city), 'Plön');
    assert.equal(knownHousingLocation(`Житло в ${city} під Jobcenter`), 'Plön');
  }
  assert.equal(knownHousingLocation('Житло у Пленково'), null);
});

test('norm overview keeps Telegram formatting valid and administrative topics unchanged', () => {
  const prompt = reply(input);
  const styled = telegramTextStyle(prompt);
  assert.equal(styled.text, prompt);
  const bold = styled.entities.map(e => prompt.slice(e.offset,e.offset+e.length));
  assert.ok(bold.includes('680 €'));
  assert.ok(bold.includes('Площа-орієнтир:'));
  assert.ok(bold.includes('Кімнати для пошуку:'));
  const administrative = reply('Житло для 3 осіб у Plön: Widerspruch на Bescheid Jobcenter');
  assert.match(administrative, /^🏛 Jobcenter\n📍 Plön\n[\s\S]*Widerspruch/u);
  assert.doesNotMatch(administrative, /Площа-орієнтир|Тема: житло/u);
});
