# Housing search sources — Schleswig-Holstein

Verified/reviewed on: 2026-09-10

The housing flow intentionally separates source types. A source being listed here does **not** mean the bot scrapes it. Only approved public pages with a stable, conservative parser are fetched automatically. Restricted portals and profile-based providers remain click-through/profile sources until an authorised API or other permitted integration is available.

## Source catalogue

| Source | Mode | Current integration |
|---|---|---|
| Kleinanzeigen | `live_api` | Primary live provider through the existing Kleinanzeigen Agent API; current filtering/radius/media flow preserved |
| ImmoScout24 | `external_search` | Search link only; no unauthorised scraping/API use |
| Immowelt | `external_search` | Search link only; no unauthorised aggregation/API use |
| Wankendorfer | `public_live` | Bounded public-page fallback parser for location, rooms, area and Gesamtmiete |
| NEUE LÜBECKER | `public_search` | Official public offers page link |
| FAB Flensburg | `public_live` | Bounded public-page fallback parser; purchase-scale offers rejected |
| Immomio | `profile_matching` | Tenant/profile matching entry point |
| WG-Gesucht | `external_search` | Search link only |
| Ohne-Makler | `external_search` | Search link only |
| WOGE Kiel | `public_search` | Official rental-offers page link |
| WOBAU Neumünster | `public_live` | Location-scoped bounded public-page parser |
| SEMMELHAACK | `public_search` | Official rental-offers page link |
| KIP Schleswig-Holstein | `external_search` | Schleswig-Holstein municipal property search link |
| BG Kiel-Hassee | `interest_profile` | Cooperative/contact entry point |
| WBG Kiel-Ost | `public_live` | Kiel-only public parser; listings marked `ANFRAGESTOPP` are excluded |
| Lübecker Bauverein | `public_live` | Lübeck-area public parser for rooms, area and Gesamtmiete |
| Baugenossenschaft Mittelholstein | `interest_profile` | Cooperative interest/contact entry point; no fake live inventory |
| GEWOBA Nord | `profile_matching` | Official search process uses Immomio; bot links to the provider flow |
| SBV Flensburg | `profile_matching` | Official search process uses Immomio; bot links to current offers/profile flow |
| TRAVE Lübeck | `public_live` | Existing bounded parser; gross-cold price precedence fixed and fixture-tested; live fetch not reverified |

Additional registered entries present at the inspected HEAD:

| Source | Mode | Current integration |
|---|---|---|
| WOBAU Ostholstein | `public_live` | Existing bounded Kaltmiete parser |
| Wohnungsunternehmen Dithmarschen | `public_live` | Existing bounded Kaltmiete parser |
| GKB Pinneberg | `public_search` | Link only |
| Neue GeWoGe Pinneberg | `profile_matching` | Profile flow only |

The catalogue has 24 entries and eight registered public parsers. These counts describe code, not verified live inventory. Three public sources are currently general fallbacks; result-level location filtering still applies.

## Runtime order

1. Run the existing Kleinanzeigen live API search.
2. If Kleinanzeigen returns one or more safely filtered listings, return them immediately and do not call public fallback pages.
3. If Kleinanzeigen returns zero listings, call only public-live sources relevant to the requested location, plus the general Wankendorfer source.
4. Public-live requests are GET-only, bounded to 512 KiB, limited by a 5-second timeout, and accept redirects only inside the approved source hostname.
5. Results are filtered by location, requested room range and maximum price and de-duplicated before presentation.
6. Search/profile sources remain user-opened links and are never presented as bot-verified live listings.

## Safety invariants

- Never bypass login, CAPTCHA, robots/access controls or hidden APIs.
- Never send credentials to a housing source.
- Never expose `KLAZ_API_KEY` in URLs, messages or logs.
- Do not infer Kaltmiete/Warmmiete when the source only exposes another price measure such as Gesamtmiete.
- Do not attach a Jobcenter `✅` merely because a housing offer is under the advertised price; Jobcenter evaluation remains a separate verified-rule flow.
- Public-source photos are not proxied until image/detail URLs are individually validated; current public fallback is text + safe source button.
- One unavailable external source must not fail the whole search.
- `main`, production bindings, webhook, OUTBOX and Durable Objects are outside this source-catalogue change.

