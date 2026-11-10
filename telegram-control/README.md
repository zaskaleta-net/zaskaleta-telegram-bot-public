# Zaskaleta Cloudflare Control

Isolated, read-only MCP-style control Worker for Telegram staging diagnostics.

## Initial tools

- `telegram_worker_health` — reads the configured Telegram Worker's public `/health` endpoint.
- `telegram_webhook_status` — calls Telegram `getWebhookInfo` server-side and returns diagnostics without returning the bot token.

## Required secrets

Set these only in the control Worker's Cloudflare environment. Never commit them:

- `CONTROL_AUTH_TOKEN` — random bearer token, minimum 32 characters.
- `TELEGRAM_BOT_TOKEN` — Telegram bot token used only server-side for read-only Telegram diagnostics.

## Non-secret variable

- `TELEGRAM_WORKER_URL` — fixed staging Worker URL.

## Security boundary

The initial version is deliberately read-only. It has no Cloudflare API token and cannot deploy, mutate Worker settings, write secrets, register/delete Telegram webhooks, replay queues, migrate Durable Objects, or perform billing operations.

`GET /health` is public and contains no secrets. `POST /mcp` requires `Authorization: Bearer <CONTROL_AUTH_TOKEN>`.

Do not merge or deploy until the code and deployment path are reviewed.
