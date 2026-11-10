// "✉️ Відповідь орендодавцю" without an AI model: the landlord's message is
// matched to a common situation and a polite German template is returned for
// the user to complete and send. Placeholders stay in [brackets].
export const LANDLORD_PROMPT = /^Відповідь орендодавцю — ([^,\n]{1,80}),\s*(\d{1,2}(?:-\d{1,2})?)\s+кімнат(?:а|и)?\./u;

const SITUATIONS = Object.freeze([
  {
    id:'documents',
    match:/(?:unterlagen|schufa|einkommen|gehaltsnachweis|selbstauskunft|nachweis|mietschuldenfreiheit|документ)/iu,
    labelUk:'орендодавець просить документи',
    body:[
      'vielen Dank für Ihre Nachricht und Ihr Interesse an mir als Mieter/in.',
      'Gerne sende ich Ihnen folgende Unterlagen: [Mieterselbstauskunft, Kopie des Ausweises/Aufenthaltstitels, Einkommensnachweis bzw. Bescheid des Jobcenters].',
      'Die Miete wird [vom Jobcenter übernommen / von mir gezahlt]. Für die Zusage des Jobcenters benötige ich von Ihnen ein schriftliches Mietangebot mit Kaltmiete, Betriebskosten und Heizkosten sowie der Wohnfläche.'
    ]
  },
  {
    id:'viewing',
    match:/(?:besichtig|termin|vorbeikommen|anschauen|ansehen|kommen|uhr|огляд)/iu,
    labelUk:'орендодавець пропонує або питає про огляд',
    body:[
      'vielen Dank für Ihre schnelle Antwort.',
      'Den Besichtigungstermin am [Tag, Datum] um [Uhrzeit] nehme ich gerne wahr. Falls dieser Termin nicht mehr möglich ist, passe ich mich gerne an.',
      'Könnten Sie mir bitte vorab mitteilen, wie hoch die Kaltmiete, die Betriebskosten und die Heizkosten jeweils sind?'
    ]
  },
  {
    id:'costs',
    match:/(?:miete|nebenkosten|betriebskosten|heizkosten|kaution|warm|kalt|€|euro)/iu,
    labelUk:'питання про вартість',
    body:[
      'vielen Dank für Ihre Informationen.',
      'Damit ich die Wohnung beim Jobcenter prüfen lassen kann, bitte ich Sie um eine Aufstellung: Kaltmiete, Betriebskosten (ohne Heizung), Heizkosten, Kaution und Wohnfläche.',
      'Gerne können Sie mir diese Angaben auch als schriftliches Mietangebot schicken.'
    ]
  },
  {
    id:'interest',
    match:/.?/u,
    labelUk:'загальна відповідь із зацікавленістю',
    body:[
      'vielen Dank für Ihre Nachricht.',
      'Ich interessiere mich sehr für die Wohnung und würde sie gerne besichtigen. Wann wäre ein Termin für Sie möglich?',
      'Ich bin unter [Telefonnummer] erreichbar.'
    ]
  }
]);

export function landlordReply(previous, text) {
  const prompt = LANDLORD_PROMPT.exec(String(previous || '').trim());
  if (!prompt) return null;
  const message = String(text || '').trim();
  if (!message) return null;
  const situation = SITUATIONS.find(item => item.match.test(message));
  return [
    `✉️ Відповідь орендодавцю — ${prompt[1]}`,
    `Ситуація: ${situation.labelUk}.`,
    '',
    'Шаблон німецькою (заповніть поля в [дужках] і надішліть):',
    '',
    'Sehr geehrte Damen und Herren,',
    '',
    ...situation.body,
    '',
    'Mit freundlichen Grüßen',
    '[Vor- und Nachname]',
    '',
    'Перед відправкою перевірте дату, час і суми. Не надсилайте в чат номер документа чи банківські дані.'
  ].join('\n');
}
