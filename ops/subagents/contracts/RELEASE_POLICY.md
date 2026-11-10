# Subagent Release Policy

This policy is additive. Existing repository isolation, CI, staging, live-verification, and phone-smoke rules remain authoritative and cannot be weakened here.

## Canonical lifecycle

```text
REQUEST
  -> TRIAGE
  -> TASK_CONTRACT
  -> ASSIGN
  -> IMPLEMENT
  -> SELF_CHECK
  -> REVIEW
  -> CI
  -> STAGING (when required)
  -> ACCEPTANCE
  -> READY_FOR_MERGE
  -> CONTROLLER_MERGE
  -> LIVE_VERIFY (when release-impacting)
  -> PHONE_SMOKE (when user-facing/runtime-impacting)
  -> RELEASE_COMPLETE
```

Governance/docs-only work with no runtime, deployment, delivery, workflow, or release-fingerprint impact may move from green required CI to `ACCEPTANCE`. It MUST NOT trigger staging/live/phone smoke merely because the lifecycle contains those states.

## CI
Runtime/housing changes preserve the existing repository gate as applicable: Telegram-only isolation, syntax, targeted regression, full suite, stable baseline, statewide fuzz, 1,104-municipality routing, forensic P0=0, control validation, QA validation, and PR CI.

Governance/docs-only changes require repository isolation and normal PR CI but do not manufacture runtime gates with no runtime impact.

## Staging
Staging is required when the accepted change can affect deployed runtime, deployment configuration, Telegram delivery behavior, or release infrastructure. Guarded staging remains manual and may not bypass reviewed-tree checks.

For merge-readiness evidence record:

```text
STAGING_STATUS: PASS | NOT_REQUIRED
```

## Acceptance and merge readiness
Controller verifies acceptance criteria, actual test evidence, staging when applicable, absence of scope creep, and known side effects.

`READY_FOR_MERGE` evidence MUST include:

```text
TASK_ID
OWNER
REVIEWER
BRANCH
COMMIT_SHA
PR
CI_STATUS
STAGING_STATUS: PASS | NOT_REQUIRED
KNOWN_RISKS
ROLLBACK_POINT
```

Merge readiness requires PR review, green required CI, staging green when required, no unresolved P0/P1 blocker, reviewed-tree fingerprint verification when applicable, and a known rollback point. Agents cannot self-authorize merge.

## Live verification
For release-impacting work, live verification checks applicable bot identity, webhook URL, webhook-secret authentication, invalid-secret fail-closed behavior, delivery gate, deployment version, and Telegram API connectivity. Governance/docs-only work records `LIVE_VERIFY: NOT_REQUIRED`.

## Phone smoke
For user-facing/runtime-impacting releases, `PHONE_SMOKE` remains a separate final gate. Green CI and live verification do not imply release completion. Governance/docs-only work records `PHONE_SMOKE: NOT_REQUIRED`.

## Failure transitions

```text
TEST_FAILED        -> IMPLEMENT
REVIEW_REJECTED    -> IMPLEMENT
SCOPE_BREACH       -> BLOCKED
SECRET_EXPOSURE    -> BLOCKED + SECURITY
CI_FAILED          -> DIAGNOSE
STAGING_FAILED     -> DIAGNOSE
LIVE_VERIFY_FAILED -> RELEASE_BLOCKED
PHONE_SMOKE_FAILED -> IMPLEMENT
```

## Concurrency
Tasks may run in parallel only when they do not modify the same files, depend on the same mutable state contract, change the same callback interface, change the same workflow, or depend on the same unreleased implementation. Otherwise the Controller serializes them. Parallel tasks still require independent review and merge-order analysis.

## Audit trail
Each task retains enough evidence to reconstruct work after context loss:

```text
task id
branch
owner
reviewer
commits
changed files
test evidence
review verdict
CI run
staging run or NOT_REQUIRED
merge SHA
live verification result or NOT_REQUIRED
phone-smoke result or NOT_REQUIRED
known risks
rollback point
```

Secrets are never part of the audit trail.

## Production boundary
Agents MUST NOT merge to `main`, push directly to `main`, rotate/reveal production secrets, weaken tests or reviewed-tree guards, bypass manual gates, or independently perform production release actions. Controller authorization does not erase existing repository release requirements.
