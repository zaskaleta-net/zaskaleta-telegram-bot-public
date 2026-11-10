# Schleswig-Holstein Помічник — Schleswig-Holstein scope

## Product coverage

The housing product is statewide for Schleswig-Holstein. Kreis Stormarn is a verified Jobcenter/KdU module, not the product boundary.

Schleswig-Holstein consists of 11 Kreise and 4 kreisfreie Städte. The top-level routing registry supports all 15 units:

- Dithmarschen
- Herzogtum Lauenburg
- Nordfriesland
- Ostholstein
- Pinneberg
- Plön
- Rendsburg-Eckernförde
- Schleswig-Flensburg
- Segeberg
- Steinburg
- Stormarn
- Flensburg
- Kiel
- Lübeck
- Neumünster

Official state source: https://www.schleswig-holstein.de/DE/landesportal/land-und-leute/kreise-kreisfreie-staedte

## Housing search

Housing search must not be restricted to Stormarn or to a hardcoded city list. Natural Ukrainian/Russian/German location names are normalized where known; the Kleinanzeigen provider remains the final authority for whether a free-form location can be searched.

## Jobcenter rules

KdU rules are local. Never apply the limits of one Kreis, city or Vergleichsraum to another.

The statewide rules registry is the only source used by the Telegram Jobcenter flow. Each active module must contain its authority, official source, validity date, cost-measure definition, household-size limits and local subzones where applicable.

A numeric module is enabled only after the published values are verified. If the Kreis is verified but a listing location cannot yet be mapped to the correct local comparison space, the bot returns a warning and never guesses a threshold.

Current active source-verified modules are documented in `JOBCENTER-SH-COVERAGE.md`. Territories whose current numeric rules are not yet fully verified remain routed but blocked from automatic green results.

## Safety invariant

An automatic `✅` requires:
1. a verified territorial/local rule;
2. an unambiguous location-to-rule mapping;
3. Kaltmiete, Betriebskosten and Heizkosten as separate values;
4. compliance with the published Bruttokaltmiete threshold and local safeguards.

The bot result is an orientation only and is never a Jobcenter `Zusicherung`.