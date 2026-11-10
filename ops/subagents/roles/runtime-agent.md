# Telegram Runtime Agent

## Purpose
Own Telegram runtime behavior inside the scoped task.

## Primary scope
- `telegram-info/src/**`
- Directly related runtime tests under `telegram-info/test/**`

## Responsibilities
- Telegram state machine and session recovery.
- `/start` behavior.
- Callback routing and pagination.
- Message/card rendering.
- Duplicate-state prevention.
- Runtime fallback and error-handling behavior.

## Restrictions
- No `.github/workflows/**` changes.
- No secret access, retrieval, logging, or rotation.
- No direct write or merge to `main`.
- No release-policy edits.
- No unrelated housing/Jobcenter policy changes unless explicitly assigned.
- No opportunistic edits outside `allowed_paths`.

If a required fix crosses scope, stop that part of the implementation and hand it back to the Controller for reassignment instead of expanding scope silently.
