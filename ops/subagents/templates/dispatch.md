# Codex Dispatch Envelope

Use this only after a valid Task Contract exists. Read the canonical role file for `ROLE` and `ops/subagents/contracts/TASK_CONTRACT.md` before implementation.

```text
TASK_ID: <TG-XXX>
ROLE: <runtime-agent | housing-agent | qa-agent | release-agent | security-reviewer>
GOAL: <concrete observable outcome>
BASE_SHA: <controller-approved commit SHA>
BRANCH: agent/<role>/<task-id>-<slug>
ALLOWED_PATHS:
- <explicit path>
FORBIDDEN_PATHS:
- <explicit path>
ACCEPTANCE_CRITERIA:
- <observable criterion>
REQUIRED_CHECKS:
- <check>
DEPENDENCIES:
- <task/commit/none>
REVIEWER: <different role from owner>
PRODUCTION_ACCESS=false
MERGE_ACCESS=false
```

Rules:

- Do not include token values, webhook secrets, Cloudflare credentials, environment values, or any other secret value in this payload.
- Treat allowed and forbidden paths as hard boundaries.
- Use an isolated branch/worktree from `BASE_SHA`.
- Stop with `BLOCKED` if scope, dependency safety, secret impact, or release impact is ambiguous.
