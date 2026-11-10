# Operations checklist

Before any Telegram staging deployment:

- [ ] Repository root is Telegram-only
- [ ] Current `main` commit is recorded
- [ ] Exact reviewed `telegram-info` tree SHA is recorded
- [ ] Syntax/static checks pass
- [ ] Full regression suite passes
- [ ] Stable baseline passes
- [ ] Statewide fuzz and 1,104-municipality routing audits pass
- [ ] Forensic P0 count is zero
- [ ] `telegram-control` validation passes
- [ ] `telegram-qa` dry-run passes
- [ ] Cloudflare staging deployment is started manually
- [ ] Staging health and contract verification pass
- [ ] Live Telegram/webhook verification passes
- [ ] Phone smoke is completed before declaring 100% readiness

Do not weaken tests to hide CI, provider, runner, or infrastructure failures. Do not deploy automatically from an ordinary push to `main`.
