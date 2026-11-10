# Task Contract

Every implementation task MUST have a Task Contract before code changes begin.

## Triage record
Before the contract is issued, Controller records:

```text
SYMPTOM
EXPECTED
ACTUAL
LIKELY_ROOT_CAUSE
AFFECTED_FLOW
RISK
OWNER
REVIEWER
```

P0 and security work pre-empts ordinary feature work until triage identifies a safe path.

## Required contract fields

```yaml
task_id: TG-XXX
owner: runtime-agent | housing-agent | qa-agent | release-agent | security-reviewer
reviewer: <different role from owner>
severity: P0 | P1 | P2 | P3
type: runtime | housing | qa | release | security

goal: >
  Concrete observable outcome.

scope:
  allowed_paths:
    - <explicit path>
  forbidden_paths:
    - <explicit path>

acceptance:
  - <observable criterion>
  - <regression criterion when applicable>

required_checks:
  - syntax
  - targeted_tests
  - full_suite_if_runtime_changed

branch: agent/<role>/<task-id>-<slug>
production_access: false
merge_access: false
```

## Rules
- `owner` and final `reviewer` MUST be different roles.
- `allowed_paths` are a hard boundary, not guidance.
- Work outside scope requires Controller reassignment or an amended, reviewed Task Contract.
- A task without explicit acceptance criteria is not implementable.
- Branches MUST use `agent/<role>/<task-id>-<slug>`.
- `production_access` and `merge_access` default to `false`; changing either requires an explicit security/release decision outside ordinary agent autonomy.
- Secret values are never contract inputs. Secrets are opaque/write-only where possible.
