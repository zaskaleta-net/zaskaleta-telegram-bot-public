import { evaluateJobcenterHousing } from './jobcenter-registry-statewide.mjs';
import { formatEuro } from './jobcenter-rules.mjs';
import { roomsWord } from './rooms.mjs';

const labels = ['Kaltmiete', 'Betriebskosten', 'Heizkosten'];
const keys = ['kaltmiete', 'betriebskosten', 'heizkosten'];
const amount = '(\\d{1,5}(?:[.,]\\d{1,2})?)(?!\\d|[.,]\\d)';
// The prompt asks for "Betriebskosten/Nebenkosten": treat Nebenkosten as the same component.
// TG-RUNTIME-072 (full analysis M1): people also write the parts in Ukrainian
// or Russian ("холодна 500", "комуналка 120", "опалення 90"); these name the
// same three parts. Longer phrases first, whole words only.
const COST_SYNONYMS = Object.freeze([
  ['Kaltmiete', 'холодна\\s+оренда|холодна\\s+орендна\\s+плата|чиста\\s+оренда|холодна|холодная\\s+аренда|холодная|kaltmiete|nettokaltmiete|kalt'],
  ['Betriebskosten', 'комунальні\\s+послуги|комунальні\\s+платежі|комунальні|комуналка|комуналку|комуналки|nk|нк|побічні\\s+витрати|коммуналка|коммунальные|brtriebskosten|betriebskosten|nebenkosten'],
  ['Heizkosten', 'опалення|опалювання|отопление|heizkosten|heizung|hk']
]);
const SYNONYM_RE = COST_SYNONYMS.map(([label, words]) => [label, new RegExp(`(?<![\\p{L}])(?:${words})(?![\\p{L}])`, 'giu')]);
// "комуналка без опалення 120" names the Betriebskosten: the "without heating"
// qualifier is dropped. "Nebenkosten inkl. Heizung 200" mixes two parts, so
// the heating word becomes a marker that is no label and the sum is not read
// as Heizkosten (review #072).
const HEATING_WORDS = 'опаленням|опалення|опалювання|отоплением|отопления|отопление|heizkosten|heizung';
const WITHOUT_HEATING = new RegExp(`\\s*(?<![\\p{L}])(?:без|ohne|exkl\\.?|exklusive)\\s+(?:${HEATING_WORDS})(?![\\p{L}])`, 'giu');
const WITH_HEATING = new RegExp(`(?<![\\p{L}])(inkl\\.?|inklusive|mit|включно\\s+з|разом\\s+з|з|із|с)\\s+(?:${HEATING_WORDS})(?![\\p{L}])`, 'giu');
export function normalizeCostLabels(text) {
  const qualified = String(text || '').replace(WITHOUT_HEATING, '').replace(WITH_HEATING, '$1 heizanteil');
  const labelled = SYNONYM_RE.reduce((value, [label, re]) => value.replace(re, label), qualified);
  // "за комуналку 120": the preposition before a part is not part of it.
  return labelled.replace(/(?<![\p{L}])(?:за|für)\s+(?=(?:Kaltmiete|Betriebskosten|Heizkosten)(?![\p{L}]))/giu, '');
}
const normalize = normalizeCostLabels;

// TG-RUNTIME-072 (full analysis M1): the registries quote the official
// German rule on heating costs; the answer gives it in Ukrainian with the
// original in brackets. An unknown wording is shown as quoted.
const HEATING_RULES_UK = Object.freeze({
  'Heizkosten kommen zusätzlich hinzu und werden gesondert geprüft.':'Heizkosten (опалення) враховуються додатково й перевіряються окремо.',
  'Heizkosten werden im Einzelfall geprüft.':'Heizkosten (опалення) перевіряються в кожному випадку окремо.',
  'Heizkosten werden separat auf Angemessenheit geprüft.':'Heizkosten (опалення) окремо перевіряються на відповідність (Angemessenheit).',
  'Heizkosten werden separat geprüft. Eine größere Wohnfläche allein macht die Unterkunft nach der veröffentlichten Produkttheorie nicht unangemessen; bei größeren Wohnungen sind die Heizkosten besonders zu prüfen.':'Heizkosten (опалення) перевіряються окремо. За опублікованою Produkttheorie більша площа сама по собі не робить житло невідповідним; у більших квартирах Heizkosten перевіряють особливо ретельно.',
  'Heizkosten werden zusätzlich übernommen, soweit sie angemessen sind.':'Heizkosten (опалення) покриваються додатково в тому розмірі, в якому вони відповідні (angemessen).',
  'Angemessene Heizkosten kommen zusätzlich hinzu und werden separat geprüft.':'Відповідні (angemessene) Heizkosten (опалення) враховуються додатково й перевіряються окремо.',
  'Angemessene Heizkosten werden gesondert übernommen und geprüft.':'Відповідні (angemessene) Heizkosten (опалення) покриваються й перевіряються окремо.',
  'Heizkosten werden zusätzlich berücksichtigt und separat auf Angemessenheit geprüft.':'Heizkosten (опалення) враховуються додатково й окремо перевіряються на відповідність (Angemessenheit).',
  'Heizkosten werden zusätzlich grundsätzlich in tatsächlicher Höhe berücksichtigt; bei unwirtschaftlichem Verhalten kann eine Begrenzung erfolgen.':'Heizkosten (опалення), як правило, враховуються додатково у фактичному розмірі; за неекономної поведінки (unwirtschaftliches Verhalten) суму можуть обмежити.',
  'Kosten der Heizung werden gesondert geprüft.':'Витрати на опалення (Kosten der Heizung) перевіряються окремо.'
});

export function heatingRuleText(rule) {
  const original = String(rule || '').trim();
  const uk = HEATING_RULES_UK[original];
  return uk ? `${uk}\nУ джерелі: «${original}»` : `Опалення, за джерелом: «${original}»`;
}

function reviewReasonText(assessment) {
  switch (assessment?.reason) {
    case 'area_required_for_betriebskosten_check':
      return 'Для локальної перевірки Betriebskosten бракує площі квартири. Сама площа не є автоматичною причиною відмови.';
    case 'betriebskosten_below_published_minimum':
      return 'Betriebskosten нижчі за опублікований локальний мінімум для цього розрахунку; потрібна індивідуальна перевірка Jobcenter.';
    case 'large_household_individual_review':
      return 'Для такого складу домогосподарства опублікована таблиця передбачає індивідуальну перевірку Jobcenter.';
    default:
      return 'Потрібна індивідуальна перевірка локальних вимог Jobcenter.';
  }
}

// Only labelled amounts are accepted: a bare number never becomes a rent component.
function costs(text) {
  return Object.fromEntries(labels.flatMap((label, i) => {
    const match = new RegExp(`(?:^|[\\s,;])${label}(?:\\s*[:=–—]\\s*|\\s+-\\s+|\\s*)${amount}(?=\\s|€|[,;]|$)`, 'iu').exec(text);
    return match ? [[keys[i], Number(match[1].replace(',', '.'))]] : [];
  }));
}

export function housingCostFollowup(previous, input) {
  const context = /^(Jobcenter-погодження житла|Перевірка оренди) — ([^,\n]{1,80}),\s*(\d{1,2}(?:-\d{1,2})?) кімнат(?:а|и)?\./u.exec(previous);
  if (!context) return null;
  const text = normalize(input).trim();
  const title = `${context[1]} — ${context[2]}, ${context[3]} ${roomsWord(context[3])}.`;
  // Read only the explicit collected-data line, never numbers from examples.
  // TG-RUNTIME-079: after a finished check, new sums start a new check in
  // the same town instead of mixing with the old ones.
  const finished = /^(?:Kaltmiete \+ Betriebskosten: |Для цієї локації та кількості осіб автоматичний висновок недоступний)/mu.test(previous);
  const saved = finished ? '' : /^Зібрано: (.+)$/mu.exec(previous)?.[1] || '';
  // A sum given together with heating ("комуналка 200 з опаленням") is not
  // split by the bot, so no sum is taken from such a message.
  const mixed = /(?<![\p{L}])heizanteil(?![\p{L}])/iu.test(text);
  // TG-RUNTIME-079/081: every sum given on its own is still taken; only the
  // one with the heating attached ("Kaltmiete 600 inkl. Heizung",
  // "Betriebskosten 150 inkl. Heizung") is left out.
  const typed = costs(text);
  const withHeating = label => new RegExp(`${label}\\s*[:=–—-]?\\s*(?:\\d{1,5}(?:[.,]\\d{1,2})?\\s*(?:€|eur(?:o)?|євро|евро)?\\s*)?(?:inkl\\.?|inklusive|mit|включно\\s+з|разом\\s+з|з|із|с)\\s+heizanteil`, 'iu').test(text);
  // Review #081: only when the heating is clearly attached to one part are
  // the other parts kept; otherwise (heating phrase elsewhere, "разом із",
  // brackets) only a Kaltmiete without heating is kept, as before.
  const attached = labels.filter(label => withHeating(label));
  // Review #081 round 2: every heating phrase must belong to one part.
  const heatingPhrases = (text.match(/heizanteil/giu) || []).length;
  const separate = attached.length && attached.length === heatingPhrases
    ? Object.fromEntries(Object.entries(typed).filter(([key]) => !withHeating(labels[keys.indexOf(key)])))
    : (typed.kaltmiete !== undefined && !withHeating('Kaltmiete') ? { kaltmiete:typed.kaltmiete } : {});
  const data = { ...costs(saved), ...(mixed ? separate : typed) };
  let persons = Number(/^Осіб: (\d{1,2})$/mu.exec(previous)?.[1]) || null;
  const suppliedPersons = /^(?:осіб|особи|personen)\s*[:=]?\s*(\d{1,2})$/iu.exec(text);
  if (suppliedPersons) persons = Number(suppliedPersons[1]);
  if (previous.includes('\nВкажіть кількість осіб (1–20).') && /^\d{1,2}$/.test(text)) persons = Number(text);
  if (persons < 1 || persons > 20) persons = null;
  const pending = /^Сума без призначення: ([\d.,]+) €\.$/mu.exec(previous)?.[1];
  const labelOnly = labels.findIndex(label => label.toLowerCase() === text.toLowerCase());
  if (pending && labelOnly >= 0) data[keys[labelOnly]] = Number(pending.replace(',', '.'));
  const lines = [title];
  if (Object.keys(data).length) lines.push('Зібрано: ' + labels.flatMap((label, i) => data[keys[i]] !== undefined ? [`${label} ${data[keys[i]]} €`] : []).join('; '));
  if (persons) lines.push(`Осіб: ${persons}`);
  const bare = new RegExp(`^${amount}\\s*(?:€|eur(?:o)?|євро|евро)?$`, 'iu').exec(text);
  if (bare && !previous.includes('\nВкажіть кількість осіб (1–20).')) {
    lines.push(`Сума без призначення: ${bare[1]} €.`, 'Що означає ця сума? Напишіть Kaltmiete, Betriebskosten або Heizkosten. Якщо це загальна Warmmiete, потрібні окремі складові.');
    return lines.join('\n');
  }
  const missing = labels.filter((_, i) => data[keys[i]] === undefined);
  // TG-RUNTIME-081: name the sum the heating was attached to.
  const heated = attached.length === 1 && attached[0] === 'Kaltmiete' ? 'Kaltmiete' : 'Betriebskosten';
  if (mixed) lines.push(`Суму разом з опаленням бот не ділить сам. Надішліть окремо ${heated} (без опалення) і Heizkosten.`);
  if (missing.length) {
    if (pending && labelOnly < 0 && (mixed || !Object.keys(costs(text)).length)) lines.push(`Сума без призначення: ${pending} €.`);
    lines.push(`Ще потрібні: ${missing.join(', ')}.`, 'Надсилайте назву та суму, наприклад: Kaltmiete 700 або «холодна 700». Betriebskosten (комуналка) — витрати без опалення, Heizkosten — опалення. Можна надіслати всі три суми разом.');
    return lines.join('\n');
  }
  if (!persons) return [...lines, 'Вкажіть кількість осіб (1–20). Кількість кімнат не визначає кількість осіб.'].join('\n');
  const assessment = evaluateJobcenterHousing({ location: context[2], householdSize: persons, ...data });
  if (!['within_guideline', 'over_limit', 'needs_review'].includes(assessment?.status)) {
    return [...lines, 'Для цієї локації та кількості осіб автоматичний висновок недоступний. Потрібна індивідуальна перевірка Jobcenter.'].join('\n');
  }
  const { rule, module } = assessment;
  lines.push(`Kaltmiete + Betriebskosten: ${formatEuro(assessment.grossCold)}.`, `Орієнтир ${module.authority}: ${formatEuro(rule.grossColdLimit)}.`);
  lines.push(assessment.status === 'over_limit' ? 'Сума перевищує опублікований орієнтир.' : assessment.status === 'needs_review' ? reviewReasonText(assessment) : 'Сума не перевищує опублікований орієнтир.');
  if (rule.heatingRule) lines.push(heatingRuleText(rule.heatingRule));
  lines.push('Це попереднє порівняння сум, не Zusicherung. Остаточне погодження надає Jobcenter.');
  if (module.sources?.[0]?.url) lines.push(`Джерело: ${module.sources[0].url}`);
  return lines.join('\n');
}
