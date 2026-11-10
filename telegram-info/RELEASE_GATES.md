# Release gates

A Telegram release is complete only after **repository validation, staging verification, live verification, and phone smoke** all pass.

## 1. Repository / source gate

The standalone repository must contain only Telegram-scoped code and operations. Before any deploy:

- Telegram-only root isolation passes;
- syntax/static checks pass;
- the complete unit/regression suite passes;
- stable-baseline verification passes;
- statewide fuzz passes;
- all 1,104 Schleswig-Holstein municipalities route successfully;
- all 15 territories are covered;
- forensic P0 count is zero;
- `telegram-control` validation passes;
- `telegram-qa` Worker dry-run passes.

## 2. Reviewed-tree gate

Staging and live verification must enforce the exact reviewed `telegram-info` Git tree SHA. If the tree changes for any reason, the reviewed-tree value must be updated only after the complete repository gate passes again.

Never bypass or weaken this guard.

## 3. Staging gate

Deployment is manual-only. The guarded staging workflow must:

1. verify repository and branch ownership;
2. enforce the reviewed `telegram-info` tree;
3. run the pre-deploy test suite;
4. deploy the Cloudflare staging Worker;
5. verify the live staging contract.

A normal push to `main` must never deploy.

## 4. Live verification gate

After staging succeeds, verify:

- Worker health is HTTP 200 and delivery is enabled;
- an invalid Telegram webhook secret fails closed with HTTP 401;
- authenticated webhook traffic is accepted;
- Telegram bot identity is `@ZaskaletaInfoBot`;
- Telegram webhook points to the intended staging Worker;
- pending update count is inspected;
- forensic P0 remains zero.

Never expose token or secret values in logs.

## 5. Final acceptance

Perform a real phone smoke after server-side gates pass. The smoke must cover normal menu/composer behavior, local housing search, whole-Kreis search, session recovery/navigation, pagination/no-result controls, household parsing, and randomized Schleswig-Holstein municipalities.

The release is not called 100% complete until this phone smoke passes.

## Privacy and safety invariants

Do not send raw Telegram user IDs, chat IDs, usernames, private message text, captions, request bodies, personal documents, addresses, or secret values to analytics/logging systems. Missing or unverified Jobcenter/KdU numeric data must fail closed rather than be invented.
