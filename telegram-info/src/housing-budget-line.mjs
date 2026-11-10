// TG-RUNTIME-075 (full analysis H5): a budget given in the first message ("до
// 800 €") was lost on the way through the rooms and persons steps. It now
// rides along in the bot's own prompts as one line, like "Осіб: N":
//   Бюджет: до 800 €            or   Бюджет: до 800 € Warmmiete
const LINE_RE = /^Бюджет: до (\d{2,5}(?:,\d{1,2})?) €(?: (Warmmiete|Kaltmiete))?$/mu;
// "800", "1200", "1 200", "1.200" (with a thousands separator), cents optional.
const AMOUNT = '(?<!\\d)(\\d{1,2}[ .]\\d{3}|\\d{3,4})(?:,(\\d{1,2}))?(?!\\d|[.,]\\d)';
const CURRENCY = '(?:€|eur(?:o)?|євро|евро)';
// Review #075: "до 150 км", "до 2026 року", "до 100 м²" are no budget.
const UNIT_AFTER = /^\s*(?:км|km|м²|м2|m²|m2|qm|кв|метр|м(?![\p{L}])|m(?![\p{L}])|тис|тыс|tsd|tausend|днів|дня|дні|дн|рок|рік|років|р\.|jahr|jahre|tage|tag|%|осіб|особи|кімнат|кімн|zimmer|хв|min|год)/iu;
// After "до/bis/max/бюджет …" (a currency is optional).
const MARKED = new RegExp(`(?:^|[\\s,(])(?:до|не більше|не дорожче|не дороже|бюджет(?:ом)?|bis|max\\.?|maximal|höchstens|hoechstens|макс\\.?)\\s*[:=]?\\s*${AMOUNT}\\s*(${CURRENCY})?`, 'giu');
// A currency amount after a rent or price word ("за 700 €", "Warmmiete 800 €").
const PRICED = new RegExp(`(?:^|[\\s,(])(?:за|ціна|оренда|орендою|miete|warmmiete|kaltmiete|warm|kalt|тепла|холодна)\\s*[:=]?\\s*${AMOUNT}\\s*${CURRENCY}`, 'giu');
// Sums that are never the rent budget.
const NOT_BUDGET = /(?:kaution|застав|депозит|борг|schulden|зарплат|lohn|gehalt|bürgergeld|buergergeld|kindergeld|heizkosten|nebenkosten|betriebskosten|stromkosten|комуналк|опален|доход|einkommen)/iu;
// Money that is never rent, even right before "до N" (review #075: "з
// опаленням до 900 €" is a Warmmiete budget, "Kaution до 2400" is not).
const NOT_RENT_MONEY = /(?:kaution|застав|депозит|борг|schulden|зарплат|lohn|gehalt|bürgergeld|buergergeld|kindergeld|доход|einkommen)/iu;

// A side cost right before "до/bis/max" limits that cost, not the rent
// ("Nebenkosten до 300 €", review #075 round 3), unless it is the heating
// that comes with the flat ("з опаленням до 900 €", a Warmmiete budget) or a
// cost that is left out ("без опалення до 700", TG-RUNTIME-076).
const COST = '(?<![\\p{L}])(?:nebenkosten|heizkosten|betriebskosten|heizung|strom(?:kosten)?|комуналк\\p{L}*|опаленн\\p{L}*|(?<![\\p{L}])(?:nk|hk|нк))';
// "опаленням і комуналкою", "Heizung und Nebenkosten", "опаленням, комуналкою".
const COSTS = `${COST}(?:\\s*(?:,|і|й|та|и|und|&)\\s*${COST})*`;
const SIDE_COST_BEFORE = new RegExp(`${COST}\\s*[:=]?\\s*$`, 'iu');
// "… inkl. Nebenkosten до 900", "з опаленням і комуналкою до 1000": included.
const WITH_HEATING_BEFORE = new RegExp(`(?:^|\\s)(?:з|із|inkl\\.?|inklusive|mit|разом з|включно з)\\s+${COSTS}\\s*$`, 'iu');
// "без опалення до 700", "ohne Heizung bis 700": the cost is not in the sum.
const WITHOUT_BEFORE = new RegExp(`(?:^|\\s)(?:без|ohne|exkl\\.?|exklusive|zzgl\\.?)\\s+${COSTS}\\s*$`, 'iu');
// Review #076: "Nebenkosten ohne Heizung bis 200 €", "Nebenkosten inkl. Heizung
// bis 250 €": a side cost before the qualifier, so it is still that cost's limit.
// A cost that is itself in an included or left-out list ("з комуналкою з
// опаленням до 1000") is no limit.
const QUALIFIER = '(?:з|із|inkl\\.?|inklusive|mit|разом з|включно з|без|ohne|exkl\\.?|exklusive|zzgl\\.?)';
const COST_QUALIFIED_BEFORE = new RegExp(`(?<!(?:^|\\s)${QUALIFIER}\\s+)${COST}\\s*[:=]?\\s*(?:з|із|inkl\\.?|inklusive|mit|разом з|включно з|без|ohne|exkl\\.?|exklusive|zzgl\\.?)\\s+${COSTS}\\s*$`, 'iu');
// "опалення окремо", "Heizung extra": the heating is not in the sum.
const PAID_APART_AFTER = /^\s*(?:окремо|отдельно|не входить|не включ\p{L}*|не входит|extra|separat|zusätzlich|zzgl\.?|exkl\.?)/iu;
// "700 € warm", "650 € kalt" (a currency is required).
const TYPED_AFTER = new RegExp(`(?:^|[\\s,(])${AMOUNT}\\s*${CURRENCY}\\s*(?:warmmiete|kaltmiete|warm|kalt)(?![\\p{L}])`, 'giu');
// "тепла", "теплої", "теплу", "теплая"; never "теплиця".
const WARM_WORD = '(?<![\\p{L}])тепл(?:а|ої|у|ій|ая|ой|ую)(?![\\p{L}])';
const KALT_WORD = '(?<![\\p{L}])холодн(?:а|ої|у|ій|ая|ой|ую)(?![\\p{L}])';

// The heating is one of the included costs ("з комуналкою та опаленням").
// Review #076: a comma ends the list ("з комуналкою, опалення окремо"), and a
// cost "окремо/extra" right after is not included.
const INCLUDED_COSTS = `${COST}(?:\\s*(?:і|й|та|и|und|&)\\s*${COST})*`;
const HEATING = /опаленн|heizung|heizkosten|(?<![\p{L}])hk(?![\p{L}])/iu;
function includedHeating(text) {
  const source = String(text);
  const re = new RegExp(`(?:^|\\s)(?:з|із|inkl\\.?|inklusive|mit|разом з|включно з)\\s+(${INCLUDED_COSTS})(?![\\p{L}])`, 'giu');
  for (const match of source.matchAll(re)) {
    if (!HEATING.test(match[1]) || PAID_APART_AFTER.test(source.slice(match.index + match[0].length))) continue;
    // A side cost right before ("Nebenkosten inkl. Heizung") is no rent type.
    if (new RegExp(`(?<!(?:^|\\s)${QUALIFIER}\\s+)${COST}\\s*[:=]?\\s*$`, 'iu').test(source.slice(Math.max(0, match.index - 60), match.index + 1))) continue;
    return true;
  }
  return false;
}

function typeOf(text) {
  const warm = new RegExp(`warmmiete|(?<![\\p{L}])warm(?![\\p{L}])|${WARM_WORD}`, 'iu').test(text) || includedHeating(text);
  const kalt = new RegExp(`kaltmiete|(?<![\\p{L}])kalt(?![\\p{L}])|${KALT_WORD}`, 'iu').test(text);
  // Both named ("Kaltmiete … чи warm"): the type is not clear.
  return warm && !kalt ? 'Warmmiete' : kalt && !warm ? 'Kaltmiete' : null;
}

function amountOf(match) {
  const whole = Number(match[1].replace(/[ .]/gu, ''));
  return match[2] ? whole + Number(`0.${match[2]}`) : whole;
}

function acceptable(source, match, hasCurrency, marked, typed = false) {
  const after = source.slice(match.index + match[0].length);
  if (UNIT_AFTER.test(after)) return false;
  const amount = amountOf(match);
  if (!Number.isFinite(amount) || amount < 100 || amount > 10000) return false;
  // A year ("до 2026 року", "до 2027") is no budget unless it carries €.
  if (!hasCurrency && /^(?:19|20)\d\d$/u.test(match[1])) return false;
  if (COST_QUALIFIED_BEFORE.test(source.slice(Math.max(0, match.index - 60), match.index))) return false;
  const before = source.slice(Math.max(0, match.index - 30), match.index);
  // TG-RUNTIME-076: also "NK 200 € warm", "Strom 150 € warm".
  if ((marked || typed) && SIDE_COST_BEFORE.test(before) && !WITH_HEATING_BEFORE.test(before) && !WITHOUT_BEFORE.test(before)) return false;
  return !(marked ? NOT_RENT_MONEY : NOT_BUDGET).test(before);
}

// Review #076 rounds 3–4: "Kiel холодна 600 €, з комуналкою без опалення до
// 200 €": a "до" sum right after a cost list that leaves the heating out may
// limit those costs, so an earlier priced rent wins. A list with the heating
// ("з опаленням до 1000") is a Warmmiete budget and always stands.
function sideLimitLike(source, match) {
  const before = source.slice(Math.max(0, match.index - 30), match.index);
  if (WITHOUT_BEFORE.test(before)) return true;
  return WITH_HEATING_BEFORE.test(before) && !HEATING.test(before.match(WITH_HEATING_BEFORE)[0]);
}

// The first acceptable match, only before `limit` when one is given.
function firstMatch(source, re, limit = Infinity) {
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(source)) && match.index < limit) {
    const hasCurrency = re !== MARKED || Boolean(match[3]);
    // "3 900 € kalt" with no word before: 3 persons and 900, or 3900? Not taken.
    if (re === TYPED_AFTER && /\s/u.test(match[1])) continue;
    if (acceptable(source, match, hasCurrency, re === MARKED, re === TYPED_AFTER)) return match;
  }
  return null;
}

export function budgetFromText(text) {
  const source = String(text || '');
  if (NOT_BUDGET.test(source) && !/(?:бюджет|до\s+\d|bis\s+\d|max|\d\s*(?:€|eur\p{L}*|євро|евро)\s*(?:warm|kalt))/iu.test(source)) return null;
  let match = firstMatch(source, MARKED);
  if (match && sideLimitLike(source, match)) {
    // A sum written after it ("зараз плачу за 450 €") never replaces it.
    const priced = firstMatch(source, PRICED, match.index) || firstMatch(source, TYPED_AFTER, match.index);
    // TG-RUNTIME-078 (review #076): a side-cost limit is below the rent, and
    // a rent above 4000 € is no plausible override ("за 6000 €, без опалення
    // до 700" keeps 700; "за 600 €, без опалення до 700" keeps 700 too).
    if (priced && amountOf(priced) > amountOf(match) && amountOf(priced) <= 4000) match = priced;
    // "Kaltmiete 600, mit Nebenkosten ohne Heizung bis 200 €": a rent without €
    // came first, so the "bis" sum is not clear; the search step asks.
    else if (/(?:miete|оренд\p{L}*|холодна|тепла)\s*[:=]?\s*\d{3,4}(?!\d)/iu.test(source.slice(0, match.index))) return null;
  }
  match ||= firstMatch(source, PRICED) || firstMatch(source, TYPED_AFTER);
  return match ? { amount:Math.round(amountOf(match) * 100) / 100, type:typeOf(source) } : null;
}

function formatAmount(amount) {
  return Number.isInteger(amount) ? String(amount) : Number(amount).toFixed(2).replace('.', ',');
}

// The budget as words for a rewritten request ("Kiel житло для 3 осіб до 800 €").
export function budgetPhrase(budget) {
  return budget ? `до ${formatAmount(budget.amount)} €${budget.type ? ` ${budget.type}` : ''}` : null;
}

export function budgetLine(budget) {
  return budget ? `Бюджет: до ${formatAmount(budget.amount)} €${budget.type ? ` ${budget.type}` : ''}` : null;
}

// The budget line of one of the bot's own prompts, as { amount, type } or null.
export function budgetOfPrompt(text) {
  const match = LINE_RE.exec(String(text || ''));
  if (!match) return null;
  return { amount:Number(match[1].replace(',', '.')), type:match[2] || null };
}

export function budgetLineOfPrompt(text) {
  return budgetLine(budgetOfPrompt(text));
}

// Insert the line after "Осіб: N" when there is one (the final and action
// prompts keep "Осіб" on line 2), else at the end; never twice.
export function withBudgetLine(text, line) {
  const value = String(text || '');
  if (!line || LINE_RE.test(value)) return value;
  const persons = /^Осіб: \d{1,2}$/mu.exec(value);
  if (!persons) return `${value}\n${line}`;
  const end = persons.index + persons[0].length;
  return `${value.slice(0, end)}\n${line}${value.slice(end)}`;
}
