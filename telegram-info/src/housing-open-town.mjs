// TG-RUNTIME-070: is a typed housing message a new request, or the next
// answer in the open dialogue? Shared by the saved-prompt owner
// (runtime-housing-state.mjs) and the reply builder (worker.mjs), so both
// decide the same way.
import { knownHousingLocation, parseHouseholdSize } from './housing-language.mjs';
import { parseRoomSpec } from './rooms.mjs';
import { budgetFromText, budgetOfPrompt } from './housing-budget-line.mjs';

const ROOMS_IN_TEXT = /(?:^|[\s,])(\d{1,2}(?:\s*[-–—/]\s*\d{1,2})?)\s*(?:кімнат(?:а|и)?|кімн\.?|zimmer|rooms?)(?=$|[^\p{L}])/iu;

export function foldTown(value) {
  return String(value || '').toLocaleLowerCase('de-DE').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-zа-яіїєґß]/gu, '');
}

// The button flow's own synthetic message ("Trittau. пошук житла. …") may
// carry more than the town, so one name containing the other is the same town.
export function sameHousingTown(a, b) {
  const x = foldTown(a);
  const y = foldTown(b);
  return Boolean(x && y) && (x.includes(y) || y.includes(x));
}

// Town, persons and rooms of an open housing dialogue, from the bot's own
// prompt texts.
export function openHousingDialogue(previous) {
  const source = String(previous || '');
  const match = /^(?:Тема: житло\s*[—–-]\s*([^.\n]{1,80})\.|(?:Пошук житла|Житло|Перевірка оренди|Jobcenter-погодження житла|Відповідь орендодавцю)\s*[—–-]\s*([^,.\n]{1,80})[,.]|Параметри житла: ([^,\n]{1,80}),|🏠 Дані пошуку житла збережено\.\n📍 Локація: ([^\n]{1,80}))/u.exec(source);
  const town = (match?.slice(1).find(Boolean) || '').trim();
  if (!town) return null;
  const persons = Number(/^Осіб: (\d{1,2})$/mu.exec(source)?.[1]) || null;
  const rooms = /(?:^|[,\s])(\d{1,2}(?:-\d{1,2})?)\s+кімнат(?:а|и)?[.,]|^(?:🛏 )?Кімнат: (\d{1,2}(?:-\d{1,2})?)$/mu.exec(source);
  return { town, persons, rooms: rooms?.[1] || rooms?.[2] || null };
}

// A typed message that names a known town and differs from the open dialogue
// (another town, or the same town with other persons or rooms).
export function startsNewHousingDialogue(text, previous) {
  const open = openHousingDialogue(previous);
  if (!open) return false;
  const town = knownHousingLocation(text);
  if (!town) return false;
  if (!sameHousingTown(town, open.town)) return true;
  const persons = parseHouseholdSize(text);
  const rooms = parseRoomSpec(ROOMS_IN_TEXT.exec(String(text || ''))?.[1])?.label || null;
  // TG-RUNTIME-075: another budget is a new request too.
  const budget = budgetFromText(text)?.amount || null;
  const openBudget = budgetOfPrompt(previous)?.amount || null;
  return Boolean((persons && persons !== open.persons) || (rooms && rooms !== open.rooms) || (budget && budget !== openBudget));
}
