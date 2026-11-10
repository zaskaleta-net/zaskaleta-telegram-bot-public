# Review

TASK: TG-XXX
IMPLEMENTER_ROLE: <role>
REVIEWER_ROLE: <different role>
REVIEWED_COMMIT_OR_RANGE: <sha or range>

## Independence
- [ ] Implementer and final reviewer are different roles.

## Scope check
- [ ] All changed files are inside the Task Contract allowed paths.
- [ ] No forbidden path or unrelated change is present.

## Spec compliance
- [ ] Acceptance criteria are satisfied.
- [ ] No unintended behavior or scope creep is identified.

## Code quality
- [ ] State/error/fallback behavior is sound where applicable.
- [ ] No avoidable duplication or unsafe shortcut is introduced.

## Regression risk
- [ ] Relevant `/start`, callbacks, household state, pagination, Kreis/radius, no-result, webhook/runtime boundaries were considered as applicable.

## Evidence
- <test/check/run and result>

## Blocking code
`NONE | SCOPE_BREACH | TEST_WEAKENING | SECRET_EXPOSURE | UNREVIEWED_DEPLOY | MAIN_DIRECT_WRITE | UNSAFE_MERGE | ISOLATION_BREACH | PRODUCTION_SIDE_EFFECT`

## Final verdict
Choose exactly one:

- `APPROVED`
- `CHANGES_REQUIRED`
- `BLOCKED`

Do not include secrets or sensitive user data in review evidence.
