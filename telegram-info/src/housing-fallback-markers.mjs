// The provider texts after which the active housing transport appends its own
// public-source result (housing-active-v21). A reply that carries one of them
// gets its terminal statement from that transport.
export const HOUSING_FALLBACK_MARKERS = Object.freeze([
  '🔎 Автоматичний пошук виконано через доступні відкриті житлові джерела.',
  'Живий пошук оголошень підготовлено, але провайдер ще не підключено.',
  'Провайдер не прийняв API-авторизацію.',
  'Провайдер тимчасово обмежив частоту live-запитів.',
  'Kleinanzeigen тимчасово не відповідає провайдеру.',
  'Сервіс актуальних оголошень тимчасово недоступний.'
]);

export function hasHousingFallbackMarker(text) {
  const source = String(text || '');
  return HOUSING_FALLBACK_MARKERS.some(marker => source.includes(marker));
}
