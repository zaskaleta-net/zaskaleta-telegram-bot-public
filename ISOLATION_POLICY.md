# Isolation policy

Allowed top-level paths:

- `.github/`
- `telegram-info/`
- `telegram-control/`
- `telegram-qa/`
- `ops/`
- `AGENTS.md`
- `README.md`
- `ISOLATION_MANIFEST.json`
- `ISOLATION_POLICY.md`
- `.gitignore`

`AGENTS.md` is the only repository-root agent-instruction file admitted by policy. Its presence does not authorize any additional top-level path.

No source file, test, workflow, deployment script, or operational helper may depend on Zaskaleta TV, Media Site, AI Twin/Clone, Android applications, TikTok, YouTube, or unrelated infrastructure.

Production/staging deployment workflows are manual-only. A normal push to `main` may run validation but must not deploy.

Any new top-level path or non-Telegram workflow is an isolation breach and must fail CI.
