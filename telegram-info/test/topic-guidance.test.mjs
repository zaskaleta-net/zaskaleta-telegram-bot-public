import test from 'node:test';
import assert from 'node:assert/strict';
import { placeFromText, topicGuidance, topicOfPrompt, OFFICIAL_LINKS, jobboerseSearchUrl } from '../src/topic-guidance.mjs';
import { landlordReply } from '../src/landlord-reply.mjs';
import { replyFor } from '../src/worker.mjs';
import { fixture } from './runtime-fixture.mjs';

const PROMPTS = {
  work:'Тема: робота. Вкажіть місто/район або що шукаєте: офлайн-робота, віддалена робота, резюме, вакансії чи підготовка звернення роботодавцю.',
  courses:'Тема: інтеграційні та мовні курси. Вкажіть місто або район і що потрібно: пошук курсу, Anmeldung, Einstufungstest, графік, пропуск або лист до Kursträger/BAMF.',
  school:'Тема: школа / Kita. Вкажіть місто або район, вік дитини та що потрібно: місце, лист, відвідування, харчування, квиток або інше організаційне питання.',
  transport:'Тема: транспорт. Вкажіть пункт відправлення, пункт призначення, дату й бажаний час. Я зможу підготувати запит для перевірки маршруту та пересадок.',
  documents:'Тема: документи та перебування. Вкажіть місто або район і тип питання: Aufenthalt, eAT, Fiktionsbescheinigung, Ausländerbehörde, запис на Termin або лист від органу.',
  kindergeld:'Тема: Familienkasse / Kindergeld. Вкажіть місто або район і що саме потрібно: заява, статус, лист, запит документів або строк. Не надсилайте повні номери справ чи банківські дані.'
};

test('places are found in mixed and declined Ukrainian input', () => {
  assert.equal(placeFromText('Kiel, шукаю роботу на складі'), 'Kiel');
  assert.equal(placeFromText('мені потрібна допомога з Jobcenter у Кілі'), 'Kiel');
  assert.equal(placeFromText('в Любеку'), 'Lübeck');
  assert.equal(placeFromText('Rendsburg, Fiktionsbescheinigung'), 'Rendsburg');
  assert.equal(placeFromText('просто питання'), null);
});

test('each menu topic prompt is recognised', () => {
  for (const [topic, prompt] of Object.entries(PROMPTS)) assert.equal(topicOfPrompt(prompt), topic);
  assert.equal(topicOfPrompt('Тема: житло. Вкажіть місто або район.'), null);
});

test('a reply to a topic prompt gets next steps with official links, not the prompt again', () => {
  const official = new Set([...Object.values(OFFICIAL_LINKS), 'https://www.jobcenter-kiel.de/']);
  for (const [topic, prompt] of Object.entries(PROMPTS)) {
    const answer = replyFor({ text:'Kiel', replyToText:prompt });
    assert.notEqual(answer, prompt, topic);
    assert.doesNotMatch(answer, /^Тема:/u, topic);
    const links = answer.match(/https:\/\/\S+/gu) || [];
    assert.ok(links.length >= 1, topic);
    for (const link of links) {
      assert.ok(official.has(link) || link.startsWith('https://www.arbeitsagentur.de/jobsuche/suche?'), `${topic}: ${link}`);
    }
  }
});

test('a topic reply without a place keeps the topic and asks for the town once', () => {
  const first = replyFor({ text:'не знаю', replyToText:PROMPTS.courses });
  assert.match(first, /^Тема: інтеграційні та мовні курси\./u);
  assert.match(first, /⚠️ Місто або громаду не знайдено/u);
  const second = replyFor({ text:'теж не знаю', replyToText:first });
  assert.equal(second.match(/⚠️/gu).length, 1, 'the warning is not stacked');
});

test('work guidance links the Jobbörse search for the town and the local Jobcenter', () => {
  const answer = topicGuidance('work', 'Kiel, Lagerhelfer').text;
  assert.ok(answer.includes(jobboerseSearchUrl('Kiel', 'Lagerhelfer')));
  assert.match(answer, /Jobcenter Kiel — https:\/\/www\.jobcenter-kiel\.de\//u);
});

test('transport guidance echoes the route and adds HVV only for Hamburg', () => {
  assert.match(topicGuidance('transport', 'з Trittau до Hamburg завтра о 8').text, /🧭 Trittau → Hamburg[\s\S]*hvv\.de/u);
  assert.doesNotMatch(topicGuidance('transport', 'з Kiel до Rendsburg').text, /hvv\.de/u);
});

test('Jobcenter guidance explains Bescheid and Mitwirkung without a legal citation', () => {
  const bescheid = topicGuidance('jobcenter', 'Kiel, Bescheid прийшов').text;
  assert.match(bescheid, /Rechtsbehelfsbelehrung/u);
  assert.match(bescheid, /Jobcenter Kiel\nhttps:\/\/www\.jobcenter-kiel\.de\//u);
  assert.doesNotMatch(bescheid, /§/u);
  assert.match(topicGuidance('jobcenter', 'Що таке Mitwirkungspflicht?').text, /Mitwirkungspflichten/u);
});

test('landlord replies pick a German template for the situation', () => {
  const prompt = 'Відповідь орендодавцю — Rendsburg, 2 кімнати. Коротко напишіть, на яке повідомлення потрібно відповісти і якою мовою.\nОсіб: 2';
  assert.match(landlordReply(prompt, 'Wann können Sie zur Besichtigung kommen?'), /Besichtigungstermin/u);
  assert.match(landlordReply(prompt, 'Bitte senden Sie mir Ihre Unterlagen und die Schufa.'), /Mieterselbstauskunft/u);
  assert.match(landlordReply(prompt, 'Die Kaltmiete beträgt 450 Euro.'), /Kaltmiete, Betriebskosten \(ohne Heizung\)/u);
  assert.match(landlordReply(prompt, 'Hallo'), /Ich interessiere mich sehr für die Wohnung/u);
  assert.equal(landlordReply('Тема: житло.', 'Hallo'), null);
  assert.match(replyFor({ text:'Guten Tag, die Wohnung ist noch frei.', replyToText:prompt }), /^✉️ Відповідь орендодавцю — Rendsburg/u);
});

test('menu button, then a town: the remembered topic prompt leads to the answer', async () => {
  const f = await fixture({ TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_MAINTENANCE_MODE:'false', TELEGRAM_DELIVERY_ENABLED:'false' });
  try {
    await f.send('', { callback:'nav:work', previous:{ message_id:5, text:'Оберіть потрібний розділ:' } });
    const answer = await f.send('Kiel');
    assert.match(String(answer.last?.text || ''), /^💼 Робота\n📍 Kiel/u);
  } finally { f.close(); }
});
