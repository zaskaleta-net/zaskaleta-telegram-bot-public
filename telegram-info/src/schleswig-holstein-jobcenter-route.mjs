// Schleswig-Holstein municipality -> Jobcenter rule-location routing.
//
// The visible/search location stays the municipality name. ruleLocation is an internal
// routing hint used only to select the correct Kreis/Amt/Vergleichsraum KdU module.
// ARS structure follows the official GV-ISys definition: Land(2) + Regierungsbezirk(1)
// + Kreis(2) + Gemeindeverband(4) + Gemeinde(3). The 9-digit prefix therefore identifies
// the Gemeindeverband/Amt for amtsangehörige Gemeinden.

const AMT_RULE_LOCATION_BY_ARS_PREFIX = Object.freeze({
  '010535308':'Berkenthin','010535313':'Breitenfelde','010535318':'Büchen','010535323':'Amt Hohe Elbgeest','010535343':'Amt Lütau','010535358':'Lauenburgische Seen','010535373':'Schwarzenbek-Land','010535391':'Sandesneben',
  '010545417':'Amt Eiderstedt','010545439':'Sylt','010545453':'Amt Viöl','010545459':'Amt Pellworm','010545488':'Föhr-Amrum','010545489':'Amt Südtondern','010545492':'Amt Nordsee-Treene','010545494':'Amt Mittleres Nordfriesland',
  '010575727':'Amt Lütjenburg','010575739':'Amt Großer Plöner See','010575747':'Amt Preetz-Land','010575755':'Amt Probstei','010575775':'Amt Selent-Schlesen','010575782':'Amt Schrevenborn','010575785':'Amt Bokhorst-Wankendorf',
  '010585803':'Amt Achterwehr','010585822':'Amt Dänischenhagen','010585824':'Amt Dänischer Wohld','010585833':'Amt Fockbek','010585847':'Amt Hohner Harde','010585853':'Amt Jevenstedt','010585864':'Amt Nortorfer Land','010585888':'Amt Eiderkanal','010585889':'Amt Bordesholm','010585890':'Amt Hüttener Berge','010585893':'Amt Schlei-Ostsee','010585895':'Amt Mittelholstein','010585896':'Amt Eidertal',
  '010615104':'Amt Breitenburg','010615134':'Amt Horst-Herzhorn','010615138':'Amt Itzehoe-Land','010615153':'Amt Krempermarsch','010615168':'Amt Schenefeld','010615179':'Amt Wilstermarsch','010615189':'Amt Kellinghusen'
});

// Deterministic rule hints for amtsfreie edge cases. These are internal KdU-zone hints;
// they never replace the municipality name shown to the user.
const DIRECT_RULE_LOCATION_BY_AGS = Object.freeze({
  '01053129':'Gemeinde Wentorf',
  // Friedrichstadt belongs to the same published Nordfriesland Mietpreisregion Süd as Husum.
  '01054033':'Husum'
});

const CANONICAL_RULE_JURISDICTIONS = new Set(['Dithmarschen','Ostholstein','Pinneberg','Segeberg','Stormarn']);
const FLAT_OR_FAIL_CLOSED_JURISDICTIONS = new Set(['Flensburg','Kiel','Lübeck','Neumünster','Schleswig-Flensburg']);

function digits(value) { return String(value || '').replace(/\D/gu, ''); }

export function jobcenterRuleLocationForMunicipality(input = {}) {
  const canonical = String(input.canonical || '').replace(/\s+/gu, ' ').trim();
  const jurisdiction = String(input.jurisdiction || '').replace(/\s+/gu, ' ').trim();
  const explicit = String(input.ruleLocation || '').replace(/\s+/gu, ' ').trim();
  if (explicit) return explicit;

  const ags = digits(input.ags);
  const direct = DIRECT_RULE_LOCATION_BY_AGS[ags];
  if (direct) return jurisdiction ? `${direct} Kreis ${jurisdiction}` : direct;

  const ars = digits(input.ars);
  if (/^010\d{9}$/u.test(ars)) {
    const mapped = AMT_RULE_LOCATION_BY_ARS_PREFIX[ars.slice(0, 9)];
    if (mapped) return jurisdiction ? `${mapped} Kreis ${jurisdiction}` : mapped;
  }

  if (canonical && CANONICAL_RULE_JURISDICTIONS.has(jurisdiction)) return `${canonical} Kreis ${jurisdiction}`;
  if (FLAT_OR_FAIL_CLOSED_JURISDICTIONS.has(jurisdiction)) return jurisdiction;
  if (canonical && jurisdiction) return `${canonical} Kreis ${jurisdiction}`;
  return canonical || jurisdiction || null;
}

export function arsRuleLocation(ars) {
  const value = digits(ars);
  return /^010\d{9}$/u.test(value) ? AMT_RULE_LOCATION_BY_ARS_PREFIX[value.slice(0, 9)] || null : null;
}
