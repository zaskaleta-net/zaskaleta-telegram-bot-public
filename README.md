# Zaskaleta Telegram Bot

Public source snapshot repository for **@ZaskaletaInfoBot**.

This repository contains only Telegram bot runtime, Telegram control/QA services, Telegram-specific operations, tests, and CI/CD.

## Top-level layout

- `telegram-info/` — bot runtime, housing/Jobcenter logic, tests and Cloudflare staging configuration
- `telegram-control/` — isolated Telegram control Worker
- `telegram-qa/` — isolated Telegram QA Worker
- `ops/telegram-qa-render/` — Railway QA gate
- `.github/qa/` — statewide/fuzz audits
- `.github/workflows/` — Telegram-only CI/CD

## Permanent workflows

- `standalone-telegram-ci.yml` — automatic validation on `main`
- `telegram-staging-deploy.yml` — manual guarded staging deployment
- `telegram-live-verify.yml` — manual live Telegram/webhook verification
- `telegram-qa-deploy.yml` — Telegram QA Worker deployment

Normal pushes run validation only. Staging and live operations are manual gates.

## Isolation invariant

This repository must not contain or depend on Zaskaleta TV, Media Site, AI Twin/Clone, Android applications, TikTok, YouTube, or unrelated services.

The bot was originally extracted from `sergokharkov/zaskaleta-media`; that repository is provenance only and is not the working repository for Telegram development.

## Release gate

A release must pass:

`Telegram-only isolation → syntax → full suite → stable baseline → statewide fuzz → 1104/1104 municipality routing → forensic P0=0 → control/QA validation → reviewed-tree guard → staging → live verification → phone smoke`.
