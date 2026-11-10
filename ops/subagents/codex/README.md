# Codex Multi-Agent Execution Guide

This guide maps Codex execution onto the existing **Subagent Architecture v1**. It is an execution guide only; it does not replace or expand repository governance.

## Authority order

When instructions conflict, follow this order:

1. `ISOLATION_POLICY.md` and repository safety/release invariants.
2. `ops/subagents/contracts/**`.
3. `ops/subagents/roles/**`.
4. This Codex execution guide.

The root `AGENTS.md` is the discovery entrypoint. The authoritative operating model remains `ops/subagents/README.md` and the v1 contracts.

When this repository is operated in Codex, the root Codex agent is the execution Controller for that Codex session. Outside Codex, the primary Controller remains the current ChatGPT conversation as defined by Subagent Architecture v1.

## Controller bootstrap

Before dispatching implementation work, the Controller MUST:

1. Read `ops/subagents/README.md`.
2. Read the applicable role and contract files.
3. Record triage and locate/create a valid Task Contract.
4. Pin a Controller-approved base SHA.
5. Identify dependencies and mutable-file/interface overlap.
6. Decide which tasks are safe to parallelize and which must be serialized.
7. Assign one owner role and a different final reviewer role.
8. Define required evidence and checks before dispatch.

No valid Task Contract means no implementation dispatch.

## Dispatch envelope

Use `ops/subagents/templates/dispatch.md`. Each dispatched worker receives only the scoped context required for its task:

- task id and role;
- goal and acceptance criteria;
- base SHA and task branch;
- allowed and forbidden paths;
- required checks and dependencies;
- independent reviewer;
- `PRODUCTION_ACCESS=false`;
- `MERGE_ACCESS=false`.

Never include secret values in a dispatch payload.

## Branch and worktree isolation

Canonical branch naming remains:

```text
agent/<role>/<task-id>-<slug>
```

Rules:

- one implementation task has one owner branch/worktree;
- every worktree starts from the Controller-approved base SHA;
- two agents MUST NOT write to the same branch concurrently;
- an owner MUST NOT reuse another task's dirty worktree;
- reviewer activity is read-only unless a separate fix Task Contract is created;
- an implementation agent MUST NOT write directly to `main`.

## Concurrency gate

Parallel execution is allowed only when mutable scopes are independent.

The Controller MUST serialize work when any of the following is true:

- tasks modify the same mutable file;
- tasks change the same callback, state, or data contract;
- tasks change the same GitHub Actions workflow;
- agents would share a dirty worktree or branch;
- one task depends on another task's unreleased implementation;
- merge ordering could change reviewed behavior.

If overlap appears after dispatch, stop automatic integration, preserve both branches, select an explicit merge/rebase order, rerun affected tests, and repeat review when integration changes reviewed behavior.

## Execution lifecycle

Codex execution follows the existing lifecycle:

```text
TRIAGE
-> TASK_CONTRACT
-> DEPENDENCY_ANALYSIS
-> DISPATCH
-> ISOLATED_IMPLEMENTATION
-> SELF_CHECK
-> HANDOFF
-> INDEPENDENT_REVIEW
-> CI
-> STAGING (when required)
-> ACCEPTANCE
-> READY_FOR_MERGE
-> CONTROLLER-MANAGED MERGE
-> LIVE_VERIFY (when required)
-> PHONE_SMOKE (when required)
-> RELEASE_COMPLETE
```

Multi-agent execution changes only dispatch and isolated implementation. It does not remove later gates.

## Implementation and QA

For fixes, use regression-first/TDD behavior where applicable:

1. reproduce the failure;
2. create a targeted failing regression;
3. make the minimal implementation change;
4. make the targeted regression pass;
5. run the required broader suite;
6. hand off exact evidence for independent review.

Tests must not be weakened to obtain a green result.

## Handoff

Implementation owners complete `ops/subagents/templates/handoff.md` with actual evidence, including changed files, rationale, tests, risks, out-of-scope areas, and commit SHA.

A task without a handoff is incomplete.

## Independent review

Owner and final reviewer MUST be different roles. Reviewers default to read-only unless a separate fix task exists.

Use the existing routing and `ops/subagents/templates/review.md`. Final verdicts are exactly:

```text
APPROVED
CHANGES_REQUIRED
BLOCKED
```

Self-check by the implementation owner is not independent review.

## Failure and recovery

### Stalled or failed worker

- preserve its branch/worktree for evidence;
- do not silently transfer a dirty worktree to a different role;
- re-dispatch from the last known-good commit when needed;
- review any partial work before reuse.

### Scope or security ambiguity

Return `BLOCKED` rather than infer permission when scope, dependency safety, secret impact, or production/release impact is unclear.

### Immediate blockers

The existing blocking codes remain authoritative, including:

```text
SCOPE_BREACH
TEST_WEAKENING
SECRET_EXPOSURE
MAIN_DIRECT_WRITE
UNREVIEWED_DEPLOY
ISOLATION_BREACH
UNSAFE_MERGE
PRODUCTION_SIDE_EFFECT
```

## Merge, secrets, and production

Codex execution does not grant additional authority:

- no subagent self-merges;
- no direct push to `main`;
- no secret-value retrieval, disclosure, logging, or propagation;
- no autonomous credential rotation;
- no autonomous production release;
- no weakening of reviewed-tree, CI, manual staging/live, or phone-smoke gates.

`production_access: false` and `merge_access: false` remain the Task Contract defaults.

## Durable audit evidence

GitHub remains the durable audit surface. Retain, as applicable:

- task/issue reference;
- branch and base SHA;
- commits and changed files;
- handoff;
- independent review verdict;
- CI run;
- staging or `NOT_REQUIRED`;
- merge SHA;
- live verification or `NOT_REQUIRED`;
- phone smoke or `NOT_REQUIRED`;
- risks and rollback point.

Codex threads/worktrees are execution state, not the sole audit record.
