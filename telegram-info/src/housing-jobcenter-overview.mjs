import { resolveJobcenterRule, SH_KDU_CAVEATS } from './jobcenter-registry-statewide.mjs';
import { formatEuro } from './jobcenter-rules.mjs';

// Search suggestions are a product choice, never a room entitlement from a KdU table.
export function suggestedHousingRooms(persons) {
  return persons === 1 ? '1' : persons >= 2 && persons <= 5 ? `${persons - 1}–${persons}` : null;
}

function formatDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(String(value || '')) ? value.split('-').reverse().join('.') : null;
}

function segebergDistrictOverview(resolved, persons) {
  const module = resolved?.module;
  if (resolved?.jurisdiction !== 'Segeberg' || resolved?.status !== 'not_yet_mapped' || !module?.zones) return null;
  const count = Number(persons);
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) return null;
  const baseIndex = Math.min(count, 5) - 1;
  const extra = Math.max(0, count - 5);
  const amount = zone => Math.round((zone.limits[baseIndex] + zone.extraCost * extra) * 100) / 100;
  const area = module.maxAreas[baseIndex] + module.extraArea * extra;
  const source = module.sources?.find(item => item.type === 'official-live-linked-table')?.url || module.sources?.[0]?.url;
  const checked = formatDate(module.verifiedCurrentOn);
  const rows = [
    ['Norderstedt', module.zones.norderstedt],
    ['Henstedt-Ulzburg', module.zones['henstedt-ulzburg']],
    ['Kaltenkirchen', module.zones.kaltenkirchen],
    ['Bad Segeberg', module.zones['bad-segeberg']],
    ['Bad Bramstedt', module.zones['bad-bramstedt']],
    ['інші громади Kreis Segeberg', module.zones.remaining]
  ];
  return [
    `Kreis Segeberg визначено. Для ${count} осіб у районі діють різні Mietstufen, тому точна сума залежить від конкретного міста або громади.`,
    `Площа-орієнтир: ${area} м² за опублікованою таблицею (довідково; сама по собі більша площа не є автоматичною відмовою).`,
    'Bruttokaltmiete (Kaltmiete + Betriebskosten без опалення):',
    ...rows.map(([label, zone]) => `• ${label} — ${zone.label}: до ${formatEuro(amount(zone))} на місяць.`),
    'Heizkosten: окремо, після перевірки Jobcenter. Warmmiete без суми опалення визначити не можна.',
    module.validityLabel ? `Статус: ${module.validityLabel}${checked ? `; перевірено ${checked}` : ''}.` : null,
    source ? `Джерело: ${source}` : null,
    'Напишіть конкретне місто або громаду в Kreis Segeberg — бот вибере правильну Mietstufe.',
    'Остаточне погодження конкретного житла надає Jobcenter.'
  ].filter(Boolean).join('\n');
}

export function housingJobcenterOverview(location, persons, today = new Date().toISOString().slice(0, 10)) {
  const resolved = resolveJobcenterRule(location, persons);
  const { rule, module } = resolved || {};

  const districtOverview = segebergDistrictOverview(resolved, persons);
  if (districtOverview) return { needsLocation: true, text: districtOverview };

  const effective = rule && (!rule.validFrom || rule.validFrom <= today);
  const verified = resolved?.status === 'verified' && rule && effective;
  if (!verified) {
    const needsLocation = ['unknown_jurisdiction', 'not_yet_mapped', 'ambiguous_location', 'ambiguous_municipality'].includes(resolved?.status);
    const source = module?.sources?.[0]?.url || resolved?.pending?.sourceUrl;
    const candidates = Array.isArray(resolved?.candidates) && resolved.candidates.length > 1 ? resolved.candidates : null;
    const message = candidates
      ? `«${resolved.municipality || location}» є в кількох районах: ${candidates.map(name => `Kreis ${name}`).join(', ')}. Напишіть назву разом із районом, наприклад «${resolved.municipality || location} Kreis ${candidates[0]}».`
      : needsLocation
      ? `Для «${location}» потрібно уточнити конкретне місто або громаду: в одному районі можуть діяти різні суми.`
      : resolved?.status === 'individual_review'
        ? `Для ${persons} осіб у ${location} потрібна індивідуальна перевірка Jobcenter.`
        : resolved?.pending?.messageUk || `Чинні числові нормативи для ${location} я не можу підтвердити.`;
    return { needsLocation, text: [message, 'Непідтверджені суми не підставляю.', source ? `Джерело: ${source}` : null].filter(Boolean).join('\n') };
  }
  const date = formatDate(rule.validFrom);
  const checked = formatDate(rule.verifiedCurrentOn || module?.verifiedCurrentOn || module?.verifiedOn);
  const validityLine = date
    ? `Дані чинні з: ${date}.`
    : rule.validityLabel || module?.validityLabel
      ? `Статус: ${rule.validityLabel || module.validityLabel}${checked ? `; перевірено ${checked}` : ''}.`
      : checked ? `Актуальність перевірено: ${checked}.` : null;
  const caveat = SH_KDU_CAVEATS[resolved.jurisdiction];
  const caveatText = caveat && caveat.householdSize === persons
    ? `Важливе судове застереження: ${caveat.noteUk}\nСправа: ${caveat.caseReference}.\nСудове джерело: ${caveat.sourceUrl}`
    : null;
  const area = Number(rule.maxAreaSqm);
  const areaLine = Number.isFinite(area) && area > 0
    ? `Площа-орієнтир: ${area} м² за опублікованою таблицею (довідково; сама по собі більша площа не є автоматичною відмовою).`
    : module?.areaNoteUk || null;
  const surchargeText = rule.surchargePercent
    ? `Stadtteil-Zuschlag: до +${rule.surchargePercent}% до базової Bruttokaltmiete; базова межа для ${persons} осіб — ${formatEuro(rule.baseGrossColdLimit)}.`
    : null;
  const lines = [
    `Орієнтири ${rule.authority || module.authority}`,
    rule.zoneLabel ? `Територія: ${rule.zoneLabel}.` : null,
    areaLine,
    `Оренда без опалення: до ${formatEuro(rule.grossColdLimit)} на місяць.`,
    'Це Bruttokaltmiete: Kaltmiete + Betriebskosten без опалення.',
    surchargeText,
    rule.surchargeNoteUk || null,
    'Опалення (Heizkosten): окремо, після перевірки Jobcenter. Загальну Warmmiete без суми опалення визначити не можна.',
    validityLine,
    `Джерело: ${rule.sourceUrl || module.sources[0].url}`,
    caveatText,
    'Це орієнтир для пошуку. Остаточне погодження конкретного житла надає Jobcenter.'
  ];
  return { needsLocation: false, text: lines.filter(Boolean).join('\n') };
}
