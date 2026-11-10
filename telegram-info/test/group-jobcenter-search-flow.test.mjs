import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceGroupHousingFlow, jobcenterSearchFromReply } from '../src/group-beta-state.mjs';

function trittauJobcenterRoomPlan(text = '3-4') {
  return jobcenterSearchFromReply({
    text,
    replyToText: [
      'Тема: житло — Trittau. Локацію вже визначено.',
      'Осіб: 4',
      'Орієнтири Jobcenter Stormarn',
      'Кімнати для пошуку: 3–4 — рекомендація, не норматив Jobcenter.',
      'Умова: житло під Jobcenter.'
    ].join('\n')
  });
}

test('Jobcenter room reply offers guideline or custom budget choice', () => {
  const plan = trittauJobcenterRoomPlan();

  assert.ok(plan);
  assert.equal(plan.handled, true);
  assert.equal(plan.state.step, 'budget_choice');
  assert.equal(plan.state.location, 'Trittau');
  assert.equal(plan.state.rooms, '3-4');
  assert.equal(plan.state.amount, 943.8);
  assert.equal(plan.state.type, 'Bruttokaltmiete');
  assert.equal(plan.state.jobcenter, true);
  assert.equal(plan.state.persons, 4);
  assert.match(plan.reply, /943,80 € Bruttokaltmiete/u);
  assert.match(plan.reply, /1\. 🏛 Використати норматив Jobcenter/u);
  assert.match(plan.reply, /2\. ✍️ Вказати свій бюджет/u);
  assert.doesNotMatch(plan.reply, /Вкажіть максимальний.*бюджет/iu);
});

test('choice 1 uses verified Jobcenter guideline and moves to radius', () => {
  const plan = trittauJobcenterRoomPlan();
  const chosen = advanceGroupHousingFlow(plan.state, '1');

  assert.equal(chosen.handled, true);
  assert.equal(chosen.state.step, 'radius');
  assert.equal(chosen.state.amount, 943.8);
  assert.equal(chosen.state.type, 'Bruttokaltmiete');
  assert.match(chosen.reply, /Використовую норматив Jobcenter/u);
  assert.match(chosen.reply, /Оберіть радіус:/u);

  const search = advanceGroupHousingFlow(chosen.state, '15 км');
  assert.equal(search.criteria.location, 'Trittau');
  assert.equal(search.criteria.rooms, '3-4');
  assert.equal(search.criteria.amount, 943.8);
  assert.equal(search.criteria.type, 'Bruttokaltmiete');
  assert.equal(search.criteria.radiusKm, 15);
  assert.equal(search.criteria.jobcenter, true);
  assert.equal(search.criteria.householdSize, 4);
});

test('choice 2 lets user enter own budget while preserving Jobcenter context', () => {
  const plan = trittauJobcenterRoomPlan();
  const custom = advanceGroupHousingFlow(plan.state, '2');

  assert.equal(custom.handled, true);
  assert.equal(custom.state.step, 'budget');
  assert.equal(custom.state.location, 'Trittau');
  assert.equal(custom.state.rooms, '3-4');
  assert.equal(custom.state.jobcenter, true);
  assert.equal(custom.state.persons, 4);
  assert.equal(custom.state.amount, undefined);
  assert.match(custom.reply, /Вкажіть свій максимальний бюджет/u);

  const budget = advanceGroupHousingFlow(custom.state, '1100 € Warmmiete');
  assert.equal(budget.state.step, 'radius');
  assert.equal(budget.state.amount, 1100);
  assert.equal(budget.state.type, 'Warmmiete');
  assert.equal(budget.state.jobcenter, true);
  assert.equal(budget.state.persons, 4);

  const search = advanceGroupHousingFlow(budget.state, '25 км');
  assert.equal(search.criteria.amount, 1100);
  assert.equal(search.criteria.type, 'Warmmiete');
  assert.equal(search.criteria.jobcenter, true);
  assert.equal(search.criteria.householdSize, 4);
});

test('existing action-menu reply also offers the same two budget choices', () => {
  const plan = jobcenterSearchFromReply({
    text: 'Пошук житла',
    replyToText: [
      'Житло — Trittau, 3-4 кімнати. Що саме потрібно? Напишіть один варіант: пошук житла, перевірка оренди, Jobcenter-погодження або відповідь орендодавцю.',
      'Осіб: 4',
      'Умова: житло під Jobcenter.'
    ].join('\n')
  });

  assert.ok(plan);
  assert.equal(plan.state.step, 'budget_choice');
  assert.equal(plan.state.rooms, '3-4');
  assert.equal(plan.state.type, 'Bruttokaltmiete');
  assert.match(plan.reply, /Використати норматив Jobcenter/u);
  assert.match(plan.reply, /Вказати свій бюджет/u);
});

test('ordinary housing replies do not inherit Jobcenter search limits', () => {
  assert.equal(jobcenterSearchFromReply({
    text: '3-4',
    replyToText: 'Тема: житло — Trittau. Локацію вже визначено.\nОсіб: 4'
  }), null);
});
