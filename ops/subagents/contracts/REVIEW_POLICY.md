# Review Policy

Final reviewer and implementer MUST be different roles.

## Default routing

```text
Runtime Agent  -> QA Agent
Housing Agent  -> QA Agent
QA Agent       -> Runtime or Housing owner
Release Agent  -> Security Reviewer
Security fix   -> Release Agent + QA Agent as applicable
```

## Review dimensions
1. **Spec compliance** — acceptance criteria, scope compliance, no unintended behavior.
2. **Code quality** — state safety, error handling, duplication, fallbacks, maintainability.
3. **Regression risk** — `/start`, callbacks, household state, pagination, Kreis/radius, no-result behavior, webhook/runtime boundaries as applicable.

## Allowed verdicts
Exactly one final verdict is permitted:

```text
APPROVED
CHANGES_REQUIRED
BLOCKED
```

No “almost approved”, “probably fine”, or implicit approval.

## Blocking codes

```text
SCOPE_BREACH
TEST_WEAKENING
SECRET_EXPOSURE
UNREVIEWED_DEPLOY
MAIN_DIRECT_WRITE
UNSAFE_MERGE
ISOLATION_BREACH
PRODUCTION_SIDE_EFFECT
```

`BLOCKED` is mandatory for security issues, isolation breaches, secret leakage, destructive migrations, failing mandatory checks, or unknown production impact.

## Test integrity
A failing implementation MUST NOT be made green by weakening the test contract. Prohibited actions include deleting assertions, lowering expected counts without a requirements change, removing edge-case fixtures, or skipping mandatory tests merely to obtain green CI. An intentional regression-contract change requires a separate Task Contract and independent review.

Review evidence must identify the commit/range reviewed and the checks actually examined. Secrets and sensitive user data must never be copied into review text.
