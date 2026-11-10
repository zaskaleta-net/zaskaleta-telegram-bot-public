export function parseRoomSpec(value) {
  const source = String(value ?? '').trim().replace(/\s+/g, ' ');
  const match = /^(\d{1,2})(?:\s*(?:[-–—/]|або|чи|oder|bis|to)\s*(\d{1,2}))?(?:\s*(?:кімнат(?:а|и)?|кімн\.?|zimmer|rooms?))?$/iu.exec(source);
  if (!match) return null;
  const first = Number(match[1]);
  const second = match[2] ? Number(match[2]) : first;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 1 || second < 1 || first > 20 || second > 20) return null;
  const min = Math.min(first, second);
  const max = Math.max(first, second);
  return { min, max, label: min === max ? String(min) : `${min}-${max}` };
}

export function roomSpecFromCriteria(criteria) {
  if (!criteria) return null;
  if (Number.isSafeInteger(criteria.roomsMin) && Number.isSafeInteger(criteria.roomsMax)) {
    return parseRoomSpec(`${criteria.roomsMin}-${criteria.roomsMax}`);
  }
  return parseRoomSpec(criteria.rooms);
}

export function roomValueInSpec(value, spec) {
  const room = Number(String(value ?? '').replace(',', '.'));
  return !!spec && Number.isFinite(room) && room >= spec.min && room <= spec.max;
}

// TG-RUNTIME-077: "1 кімната", "2–4 кімнати", "5 кімнат"; a range takes the
// form of its last number ("2-3 кімнати", "4-5 кімнат").
export function roomsWord(label) {
  const last = String(label ?? '').split(/\s*[-–—]\s*/u).pop().trim();
  const n = Number(last);
  if (!/^\d{1,3}$/u.test(last) || n < 1) return 'кімнати';
  if (n % 10 === 1 && n % 100 !== 11) return 'кімната';
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 'кімнати';
  return 'кімнат';
}
