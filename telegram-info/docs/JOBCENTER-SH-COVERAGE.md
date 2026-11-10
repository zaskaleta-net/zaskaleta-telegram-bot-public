# Jobcenter / KdU coverage — Schleswig-Holstein

Verified/reviewed on: 2026-09-10

The product scope is the whole Land Schleswig-Holstein: 11 Kreise and 4 kreisfreie Städte. `active` means numeric accommodation rules are sourced from an official authority and can be used only when the location is mapped to the correct local rule or comparison zone. `pending` still routes to the correct territory, but never produces an automatic green result.

| Territory | Status | Rule basis | Routing / safety |
|---|---|---|---|
| Stormarn | active | from 2025-01-01 | full municipality map; local groups |
| Dithmarschen | active | from 2025-01-01 | full municipality map; Nord/Süd |
| Herzogtum Lauenburg | active | from 2025-03-01 | comparison zones; unresolved zone => no green |
| Nordfriesland | active | from 2026-01-01 | local Mietpreisregionen |
| Ostholstein | pending | official new table from 2026-07-01 exists | territory/service-area routing enabled; numeric values blocked until direct table extraction |
| Pinneberg | active | official Kreis table “ab 2025” | all 49 municipalities represented; Mietstufen 4/5/6/7; ambiguity guards for duplicate place names |
| Plön | active | from 2026-01-01 | three comparison zones |
| Rendsburg-Eckernförde | active | from 2026-07-01 | four comparison zones |
| Schleswig-Flensburg | active | from 2026-03-01 | district rule; conservative location routing |
| Segeberg | active | current official table verified | no invented effective date |
| Steinburg | active | from 2025-07-01 | local groups; ambiguous Schenefeld protected |
| Flensburg | active | from 2025-07-01 | full city |
| Kiel | active | from 2025-01-01 | full city |
| Lübeck | active | from 2026-05-01 | full city; larger households may require individual review |
| Neumünster | pending | official 09.09.2026 agenda announces new limits from 2026-10-01 | current/future numeric thresholds blocked until direct official verification; future rule is never applied early |

## Pinneberg official sources

- Kreis Pinneberg KdU table: `https://www.kreis-pinneberg.de/media/Dokumente/Fachdienst%2B35/35-2/Richtwerte%2BUnterkunftskosten%2B%28KdU%29.pdf`
- Kreis Pinneberg social-security page: `https://www.kreis-pinneberg.de/Verwaltung/Fachbereich%2BFamilie_%2BTeilhabe%2Bund%2BSoziales/Fachdienst%2BSoziales/Team%2BSoziale%2BSicherung.html`
- Kreis Pinneberg municipalities: `https://www.kreis-pinneberg.de/Kreis%2BPinneberg/St%C3%A4dte_%2B%C3%84mter%2Bund%2BGemeinden.html`

## Remaining official-source blockers

Ostholstein publishes `NEU - Richtwerte und absolute Obergrenzen für angemessene Kosten der Unterkunft ab 01.07.26`, but the numeric table has not been directly retrievable in the current verification path. Neumünster officially announced a rule change from 01.10.2026, but the numeric attachment/current official table has not been directly retrieved. These are deliberate fail-safe blocks, not missing product geography.

## Invariants

- Never reuse one Kreis' values in another Kreis.
- Never choose a random comparison zone from a district-only label.
- Never return `✅` without separate Kaltmiete, Betriebskosten and Heizkosten.
- Heating is evaluated separately from the published cold accommodation threshold.
- Ambiguous duplicate place names require disambiguation instead of threshold guessing.
- The bot result is informational and is never represented as a Jobcenter `Zusicherung`.
