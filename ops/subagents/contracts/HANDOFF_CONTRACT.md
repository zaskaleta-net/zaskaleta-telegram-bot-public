# Handoff Contract

An implementer cannot finish a task with a simple “done”. A task is incomplete until the handoff package is complete.

Required format:

```text
TASK: TG-XXX
STATUS: READY_FOR_REVIEW

CHANGED:
- file/path

WHY:
- observed cause
- chosen fix rationale

TESTS:
- exact command/check: PASS

RISKS:
- known risk or NONE

OUT_OF_SCOPE:
- explicitly untouched area

COMMIT:
<sha>
```

## Rules
- `CHANGED` lists every changed file relevant to the task.
- `WHY` separates observed cause from implementation rationale.
- `TESTS` reports evidence actually run, never expected or assumed results.
- `RISKS` must be explicit; use `NONE` only after review, not by omission.
- `OUT_OF_SCOPE` prevents accidental expansion and records deferred dependencies.
- `COMMIT` identifies the exact implementation state being reviewed.
- No secret values, raw credentials, private Telegram identifiers, or sensitive payloads may appear in the handoff.
- Reviewer evaluates only the handed-off commit/range plus declared evidence; later changes require a refreshed handoff.
