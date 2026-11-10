# MASTER — Українці Schleswig-Holstein 🇺🇦🇩🇪
Updated 2026-09-10. Consolidated from the owner's “Стадія проєкту” and “План покращення бота” handoffs. Handoff claims are not live deployment evidence.

## Identity
Group: Українці Schleswig-Holstein 🇺🇦🇩🇪.
Bot display name: Schleswig-Holstein Помічник 🇺🇦🇩🇪.
Username remains @ZaskaletaInfoBot. Replace the old Zaskaleta Info brand gradually.
No standalone Z logo. Separate group/bot identities use the Schleswig-Holstein map and Ukrainian/German colors.
Owner reports private test group created, avatar installed, owner + bot present, Privacy Mode enabled.
Owner reports no reply to /start@ZaskaletaInfoBot or @ZaskaletaInfoBot Житло.

## Repository and operating constraints
Repository sergokharkov/zaskaleta-media; branch feat/telegram-durable-pilot.
PR #8 stays open/draft; no merge or main writes.
No paid changes. No changes to secrets, KLAZ_API_KEY, OUTBOX or Durable Objects.
Keep TELEGRAM_DELIVERY_ENABLED=false. No replay or purge of old messages.
Work autonomously in coherent batches: offline QA then at most one reviewed control CI/deployment if needed.
Owner reports approximately 90% Actions quota used. No repeated small Actions.
Check current branch HEAD before each write. The exported f32adda544624f582f5c0c2ac63a91a69d5a6bfa is historical.

## Jobcenter handoff
15/15 jurisdictions route; 13/15 have numerical rules according to the owner.
Kreise: Dithmarschen, Herzogtum Lauenburg, Nordfriesland, Ostholstein, Pinneberg, Plön, Rendsburg-Eckernförde, Schleswig-Flensburg, Segeberg, Steinburg, Stormarn.
Kreisfreie Städte: Flensburg, Kiel, Lübeck, Neumünster.
Ostholstein and Neumünster stay fail-safe until direct official numerical verification.
Owner reports Ostholstein revised values effective 2026-07-01 and Neumünster changes effective 2026-10-01; independently verify sources before implementing.
Never apply future limits early. Unknown or ambiguous municipality yields warning.
No automatic green without separate Kaltmiete, Betriebskosten excluding heat, and Heizkosten.
Keep heating separate. Preserve ✅ / ⚠️ / ❌ and explain final Jobcenter decision; bot output is not Zusicherung.
Do not invent figures or listing facts.

## Housing architecture and UX
Preserve Kleinanzeigen Agent live search, API key handling, photo albums, price, rooms, area, distance, date, source and listing links.
Keep location normalization, natural Ukrainian/Russian requests, room ranges such as 3-4, radii 5/10/15/25/50 km, stateless flow.
Input: city → rooms → budget → Warm/Kalt → radius.
Current architecture: Kleinanzeigen first; relevant public-live fallback only when no suitable results.
Registered sources in handoff:
Kleinanzeigen, ImmoScout24, Immowelt, Wankendorfer, NEUE LÜBECKER, FAB Flensburg, Immomio, WG-Gesucht, Ohne-Makler, WOGE Kiel, WOBAU Neumünster, SEMMELHAACK, KIP Schleswig-Holstein, BG Kiel-Hassee, WBG Kiel-Ost, Lübecker Bauverein, Baugenossenschaft Mittelholstein, GEWOBA Nord, SBV Flensburg, TRAVE Lübeck.
Handoff public-live implementations: Wankendorfer, WOBAU Neumünster, FAB Flensburg, WBG Kiel-Ost, Lübecker Bauverein.
Public reads: GET only, timeout, size bound, host allowlist, redirect validation, location/room/budget filters, dedup, failure isolation.
ImmoScout24/Immowelt remain links absent authorized API; no unauthorized scraping.
Cards preserve photo, title, price, rooms, area, distance, date, source, open button and Jobcenter check.
Up to five images, parallel downloads, renumber surviving captions; 2+ images use one sendMediaGroup; one uses sendPhoto; text fallback.
Attach markup after album. Markup edit failure must not resend album.
4xx media rejection except 429 may fall back; 5xx/429/ambiguous delivery must not replay.
Never conflate Kaltmiete, Warmmiete, Gesamtmiete, Betriebskosten or Heizkosten; ambiguous price composition produces warning.

## Ordered continuation
1. Diagnose actual active entry point and obtain test group ID through existing authorized access. Keep IDs out of commits/logs.
2. Preserve private ID and add group to beta allowlist using existing approved configuration path.
3. Complete stateless multi-chat addressing; verify actual deployed behavior for commands, mentions and housing flow.
4. Review existing TRAVE parser and fix QA before declaring it live-ready.
5. Investigate GEWOBA Nord, SBV Flensburg, Baugenossenschaft Mittelholstein, then WOGE Kiel / NEUE LÜBECKER / SEMMELHAACK. Profile-only sources must not become fabricated live feeds.
6. Implement combined results and cross-source dedup, distance → relevance → freshness sort, and Jobcenter actions for external listings.
7. Run syntax, provider, public parser, Telegram media, Jobcenter and Worker regressions locally before a controlled staging operation.

## Verified repository inspection and this batch
Inspected immutable HEAD f7b0b6f500dde8d411a153fcdffedd68ca192d25, newer than export. PR #8 is open/draft/unmerged.
worker.mjs stateless ingress and sender still use the first chat ID. This batch checks allowlist membership and binds the send configuration to the incoming allowed chat.
Durable webhook, audit and queue paths are unchanged.
worker-entry-beta.mjs already intercepts groups through group-beta-runtime.mjs. Therefore legacy single-chat checks alone do not establish the live root cause; active entry point and allowlist still need inspection.
TRAVE parser and tests already exist; HOUSING-SOURCES.md still labels TRAVE public_search. Do not duplicate implementation.
Local syntax check passes.
Baseline full suite: 192 tests, 175 pass, 17 fail.
With three multi-chat regressions: 195 tests, 178 pass, same 17 failures; no new failures.
New tests cover group/supergroup commands, mentions, full parameter flow, private routing, disallowed groups, unrelated chat traffic and wrong-chat acknowledgements without replay.
Existing failures include provider/catalog expectations, public fallback/TRAVE, Jobcenter, staging entry configuration and media call expectations. They require triage before deploy; do not claim full QA success.
No deployment, live group test, allowlist change, secret change or Actions dispatch in this batch.

## QA repair batch — supersedes previous 17-failure blocker
All 17 initial failures resolved. Final offline suite: 200 tests, 200 passed, 0 failed, 0 skipped; npm run check passes.
Behavior repairs:
- TRAVE explicitly prefers Bruttokaltmiete over Nettokaltmiete regardless of field order; source type is preserved.
- TRAVE public-live catalogue and safe output URL handling now agree with the existing parser registry.
- HTML captions are no longer sliced through tags/href attributes. Visible-text bounding remains in the media sender; single photo and album tests preserve complete long links.
- Supplemental search actually contains all 23 advertised domains from the 24-entry catalogue.
- Kreis/Landkreis Steinburg and ambiguous bare Steinburg cannot inherit Stormarn municipality limits; explicitly qualified Steinburg, Kreis Stormarn remains supported.
- Base Jobcenter registry no longer reports verified without a numerical rule when only facade metadata exists.
Stale tests updated for 24 catalogue entries, eight parser entries, 12 button rows, normalized room strings, 11 base versus 13 statewide modules, beta entry point and post-album markup edits.
The fallback regression retains three configured general public sources and verifies that failed sources do not hide successful results.
Telegram caption reference: https://core.telegram.org/bots/api#inputmediaphoto (limit applies after entity parsing).
No numerical KdU limits were changed. No Actions dispatch or deploy; no production/main/secret/OUTBOX/DO/queue change.
Live group response and live TRAVE retrieval remain unverified. Passing offline fixtures is not evidence of live delivery or current listing availability.
Next: inspect active staging entry point and allowlist through existing authorized access, obtain group ID without exposing it, then a single controlled staging verification if appropriate.


## Next-step verification — 2026-09-10
Direct network probes: staging /health HTTP 200, {"ok":true,"service":"zaskaleta-info-telegram","delivery":false}; unauthenticated POST /telegram/stateless HTTP 401.
These probes do not reveal active version, allowlist or group delivery.
TRAVE direct GET: HTTP 200, 76913 bytes (within 512 KiB), explicit "0 Wohnungen gefunden", parser returns zero for Lübeck / 1-10 rooms / budget 5000. No fabricated inventory.
Official source review:
- https://www.trave.de/interessenten/wohnung-mieten — zero listings at observation.
- https://www.gewoba-nord.de/wohne-mit-uns/wohnungssuche/ — Immomio registration/profile route.
- https://www.sbv-flensburg.de/fuer-wohnungssuchende/immobiliensuche/aktuelle-angebote — Immomio registration/profile route.
- https://bgm-wohnen.de/wohnen/vermietung/ — contact/interest file route.
Keep the last three as profile/contact entries; no new direct API or live parser established.
Public-feed merge now preserves city-only lookalikes across sources, requires explicit address and identical price measure for cross-source matching, and orders by known distance, room relevance, freshness. Missing distance is not zero.
Full suite: 202/202 pass, zero failures; changed module syntax passes.
The existing Kleinanzeigen-first short-circuit is preserved. A simultaneous mixed Kleinanzeigen/public feed is still pending, including presentation of photo and text-only results together.
Operational blocker: current connector exposes no Cloudflare account operations or new workflow dispatch. No local authorized deployment credentials. Browser plugin-failure policy prohibits using browser as a connector workaround.
No deploy, allowlist mutation, live Telegram send, main change, secret/OUTBOX/DO/queue operation.
Resume with an authorized Cloudflare/workflow control connection, verify active state, obtain group ID, configure allowlist and run one controlled staging deployment and live group/private tests.
