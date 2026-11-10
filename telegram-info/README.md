# Zaskaleta Telegram Bot — Schleswig-Holstein

`telegram-info/` contains the active Cloudflare Worker runtime for **@ZaskaletaInfoBot**.

## Runtime

- Entrypoint: `src/worker-entry-pilot-v21.mjs`
- Cloudflare configuration: `wrangler.jsonc`
- Staging Worker: `zaskaleta-info-telegram-staging`
- Conversation state: Cloudflare Durable Object / approved runtime storage
- GitHub is source control and CI/CD only; it is not a runtime dependency.

## Product scope

The bot provides Telegram flows for Schleswig-Holstein, including housing search and Jobcenter/KdU guidance. Statewide routing is validated against 1,104 municipalities and 15 administrative territories. Missing or unverified KdU data must fail closed rather than invent a numeric result.

## Development branch

`main` in `zaskaleta-net/zaskaleta-telegram-bot` is the canonical standalone Telegram source.

No Zaskaleta TV, Media Site, AI Twin/Clone, Android, TikTok, YouTube, or unrelated project files may be introduced into this repository.

## Required validation

A candidate must pass, in order:

1. Telegram-only repository isolation check.
2. Syntax/static validation.
3. Full unit/regression suite.
4. Stable-baseline verification.
5. Statewide fuzz and municipality routing audits.
6. Forensic P0 gate.
7. `telegram-control` validation and `telegram-qa` dry-run.
8. Exact reviewed `telegram-info` tree guard.
9. Manual guarded Cloudflare staging deploy.
10. Live Telegram/webhook verification.
11. Phone smoke test before calling the release complete.

Deployment workflows are manual-only. A normal push to `main` runs validation and must not deploy.
