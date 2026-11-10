import { parseRoomSpec, roomValueInSpec, roomsWord } from './rooms.mjs';
import { suggestedHousingRooms } from './housing-jobcenter-overview.mjs';

function normalizeListingRooms(value) {
  const raw = String(value ?? '').trim().replace(',', '.');
  return /^\d{1,2}(?:\.\d+)?$/u.test(raw) ? raw : null;
}

function displayRoomRange(value) {
  return String(value || '').replace(/\s*[-–—]\s*/u, '–');
}

function normalizePriceType(value) {
  const text = String(value || '').trim().toLocaleLowerCase('de-DE');
  if (/bruttokaltmiete|brutto[-\s]?kalt/u.test(text)) return 'Bruttokaltmiete';
  if (/nettokaltmiete|kaltmiete|netto[-\s]?kalt/u.test(text)) return 'Kaltmiete';
  if (/warmmiete|gesamtmiete|warm/u.test(text)) return 'Warmmiete';
  return 'Unbekannt';
}

export function jobcenterSearchRoomFit({ listingRooms, targetRooms, persons } = {}) {
  const listing = normalizeListingRooms(listingRooms);
  if (!listing) return { status:'unknown', text:null };

  const explicit = parseRoomSpec(targetRooms);
  const suggestedLabel = suggestedHousingRooms(Number(persons));
  const suggested = parseRoomSpec(suggestedLabel);
  const expected = explicit || suggested;
  if (!expected) return { status:'unknown', text:null };
  if (roomValueInSpec(listing, expected)) return { status:'match', text:null };

  const shownListing = listing.replace('.', ',');
  if (explicit) {
    return {
      status:'mismatch',
      text:`⚠️ Не відповідає параметрам поточного пошуку: потрібно ${displayRoomRange(explicit.label)} ${roomsWord(displayRoomRange(explicit.label))}, в оголошенні ${shownListing}. Грошову межу Jobcenter можна перевірити окремо.`
    };
  }
  return {
    status:'mismatch',
    text:`⚠️ За пошуковою рекомендацією для ${persons} осіб: ${displayRoomRange(suggestedLabel || suggested.label)} ${roomsWord(displayRoomRange(suggestedLabel || suggested.label))}; в оголошенні ${shownListing}. Це рекомендація пошуку, не норматив Jobcenter.`
  };
}

export function jobcenterSearchCostFit({ price, priceType, bruttokaltLimit } = {}) {
  const amount = Number(price);
  const limit = Number(bruttokaltLimit);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(limit) || limit <= 0) {
    return {
      status:'unknown',
      badge:'⚠️',
      label:'потрібна перевірка ціни',
      text:'Не вдалося надійно зіставити ціну оголошення з межею Bruttokaltmiete.'
    };
  }

  const type = normalizePriceType(priceType);
  if (type === 'Bruttokaltmiete') {
    return amount <= limit
      ? {
          status:'likely',
          badge:'✅',
          label:'ймовірно в межах Jobcenter',
          text:'В оголошенні прямо вказана Bruttokaltmiete, і вона не перевищує пошуковий орієнтир. Остаточну Zusicherung надає Jobcenter.'
        }
      : {
          status:'over',
          badge:'❌',
          label:'вище орієнтиру Jobcenter',
          text:'Вказана Bruttokaltmiete вже перевищує пошуковий орієнтир Jobcenter.'
        };
  }

  if (type === 'Kaltmiete') {
    return amount > limit
      ? {
          status:'over',
          badge:'❌',
          label:'Kaltmiete вже вище орієнтиру',
          text:'Навіть Kaltmiete вже перевищує орієнтир Bruttokaltmiete; Betriebskosten додадуться зверху.'
        }
      : {
          status:'verify',
          badge:'⚠️',
          label:'перевірити Betriebskosten',
          text:'Kaltmiete не перевищує орієнтир, але для Bruttokaltmiete потрібно додати Betriebskosten без Heizkosten.'
        };
  }

  if (type === 'Warmmiete') {
    return amount <= limit
      ? {
          status:'likely',
          badge:'✅',
          label:'ймовірно в межах за ціною',
          text:'Warmmiete не перевищує орієнтир Bruttokaltmiete, але склад орендної плати все одно потрібно перевірити.'
        }
      : {
          status:'verify',
          badge:'⚠️',
          label:'перевірити склад Warmmiete',
          text:'Warmmiete вища за орієнтир Bruttokaltmiete, але вона може включати Heizkosten; потрібен розподіл Kaltmiete + Betriebskosten + Heizkosten.'
        };
  }

  return {
    status:'verify',
    badge:'⚠️',
    label:'тип ціни не підтверджено',
    text:'Тип ціни в оголошенні не підтверджено як Kaltmiete, Bruttokaltmiete або Warmmiete; не можна автоматично прирівнювати її до межі Jobcenter.'
  };
}
