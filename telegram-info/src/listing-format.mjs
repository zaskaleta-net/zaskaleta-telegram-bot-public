// How a listing's numbers read in a card: German/Ukrainian decimal comma,
// no thousands dot (captions are parsed back with /\d{1,5}(?:[.,]\d{1,2})?/),
// cents only when there are any, distances without a trailing ",0".
// Owner review 17.10.2026: "471.98 €", "54.01 м²", "≈1.0 км" looked foreign.
const decimal = (value, digits) => Number(value).toLocaleString('de-DE', { useGrouping:false, minimumFractionDigits:digits, maximumFractionDigits:digits });

export function formatEuro(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  return Number.isInteger(number) ? decimal(number, 0) : decimal(number, 2);
}

export function formatArea(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  return Number(value).toLocaleString('de-DE', { useGrouping:false, maximumFractionDigits:2 });
}

export function formatDistance(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  return number < 10 ? Number(number.toFixed(1)).toLocaleString('de-DE', { maximumFractionDigits:1 }) : decimal(Math.round(number), 0);
}

// A Kaltmiete is the rent before Nebenkosten; next to Warm-/Gesamtmiete
// offers in one list it must not read as the full monthly cost.
const KALT_TYPES = new Set(['Kaltmiete', 'Nettokaltmiete']);
export function priceTypeLabel(priceType) {
  const type = String(priceType || '');
  return KALT_TYPES.has(type) ? `${type} + Nebenkosten` : type;
}
