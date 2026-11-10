# Zaskaleta Telegram Bot — Codex-native Subagent Execution Layer

Date: 2026-10-07  
Task: `TG-CODEX-001`  
Status: Design specification — approved by user  
Repository: `sergokharkov/zaskaleta-telegram-bot`  
Base architecture: `ops/subagents/specs/2026-10-06-subagent-architecture-v1-design.md`

## 1. Purpose

Add a real execution layer for the existing Subagent Architecture v1 when the repository is used in Codex, without creating a second governance system and without changing Telegram runtime behavior.

The existing `ops/subagents/**` contracts remain authoritative. Codex supplies the execution substrate: separate agent threads, isolated worktrees, repository instructions through `AGENTS.md`, and multi-agent coordination. This design only bridges those capabilities to the repository's existing roles and release gates.

## 2. Success criteria

The design is successful when all of the following are true:

1. Opening the repository in Codex gives the root agent repository governance automatically.
2. The Controller can split work into independent Runtime, Housing, QA, Release, and Security workstreams.
3. Parallel implementation work is isolated by branch/worktree.
4. Every implementation task still has a Task Contract before code changes begin.
5. Owner and final reviewer remain different roles.
6. Agents cannot self-authorize merge to `main`.
7. Agents cannot retrieve or expose production secrets.
8. Agents cannot autonomously perform a production release.
9. Existing CI, staging, live-verification, and phone-smoke gates remain authoritative.
10. The Codex integration itself produces no Telegram runtime diff.
11. `AGENTS.md` is the only newly admitted top-level file and root isolation continues to fail closed for any unknown top-level path.

## 3. Non-goals

This task does NOT:

- replace GitHub Actions or Cloudflare deployment workflows;
- replace `ops/subagents/**` contracts;
- add a custom message bus, queue, database, scheduler, or Agents API service;
- change `telegram-info/src/**` or housing business logic;
- change runtime release fingerprints;
- grant automatic merge or production-release authority;
- move secrets into repository files, task contracts, prompts, or logs.

## 4. External execution assumptions

The design relies on Codex capabilities that support:

- concurrent agent tasks in separate threads;
- isolated Git worktrees for concurrent work on one repository;
- repository instructions loaded from `AGENTS.md`;
- delegation of independent work to separate subagents.

These are execution capabilities only. Repository policy remains the source of truth for what agents are allowed to do.

## 5. Architectural principle

The execution layer is intentionally thin:

```text
User / Controller intent
        |
        v
root AGENTS.md
        |
        v
ops/subagents/** authoritative governance
        |
        v
Controller creates/validates Task Contract
        |
        +-------------------------------+
        |               |               |
        v               v               v
 isolated Runtime   isolated Housing   isolated QA
 thread/worktree    thread/worktree    thread/worktree
        |               |               |
        +------- handoff/review --------+
                        |
                        v
                  CI / staging gates
                        |
                        v
                 Controller decision
```

Codex is the executor. `ops/subagents/**` is the policy layer. GitHub remains the durable source of code, review, CI, and audit evidence.

## 6. Repository integration

### 6.1 Root `AGENTS.md`

Implementation will add one repository-root `AGENTS.md`.

Its purpose is to make Codex discover the existing governance immediately. It will be concise and point to authoritative files rather than duplicate them.

Required content:

- repository identity and Telegram-only isolation rule;
- instruction to read `ops/subagents/README.md` before implementation work;
- instruction to obey the role file matching the assigned task;
- requirement for a Task Contract before implementation;
- owner/reviewer separation;
- worktree/branch isolation requirement;
- prohibition on direct `main` writes;
- prohibition on secret retrieval/exposure;
- prohibition on autonomous production release;
- instruction to preserve existing release gates.

`AGENTS.md` must not copy the entire governance corpus because duplicated policy can drift.

### 6.2 Codex execution guide

Implementation will add:

```text
ops/subagents/codex/README.md
```

This guide will define:

- Controller bootstrap sequence;
- role-to-task mapping;
- dispatch rules;
- worktree rules;
- concurrency rules;
- handoff rules;
- review rules;
- merge/release authority boundaries;
- failure and recovery behavior.

### 6.3 No new policy hierarchy

The Codex guide is subordinate to:

1. `ISOLATION_POLICY.md`;
2. `ops/subagents/contracts/**`;
3. `ops/subagents/roles/**`;
4. existing Telegram release gates.

If Codex execution guidance conflicts with an existing contract, the existing contract wins.

### 6.4 Narrow root-isolation exception

The current repository root allowlist rejects unlisted top-level files. Because Codex repository discovery requires root `AGENTS.md`, implementation must make one narrow policy change:

- add `AGENTS.md` to `ISOLATION_POLICY.md` allowed top-level entries;
- add `AGENTS.md` to the root allowlist in `.github/workflows/standalone-telegram-ci.yml`;
- do not add any other new top-level path;
- preserve fail-closed behavior for every unknown top-level file.

This is a governance/instruction-file exception only. It must not alter runtime, deployment, webhook, secret, or release-fingerprint behavior.

## 7. Controller behavior in Codex

Before dispatch the Controller MUST:

1. read `ops/subagents/README.md`;
2. classify the request;
3. record triage fields;
4. create or locate a valid Task Contract;
5. determine dependencies between subtasks;
6. determine whether scopes are safe to parallelize;
7. assign one owner role and an independent reviewer role per task;
8. define expected evidence before dispatch.

The Controller may coordinate tasks but does not bypass role boundaries.

## 8. Role mapping

| Repository role | Codex execution responsibility |
| --- | --- |
| Controller / Orchestrator | decomposition, dispatch, dependency management, acceptance, merge readiness |
| Runtime Agent | Telegram runtime/state/callback/output behavior within explicit scope |
| Housing Search Agent | housing search, Kreis/radius, source normalization and related tests |
| QA / Regression Agent | reproduction, RED tests, regression suites, independent verification |
| Release / Infrastructure Agent | CI, guarded staging, release diagnostics, reviewed-tree infrastructure |
| Security Reviewer | read-only trust-boundary and secret-handling review by default |

No new privileged role is introduced.

## 9. Worktree and branch isolation

Each implementation owner gets an isolated Codex worktree backed by a task branch.

Canonical branch format remains:

```text
agent/<role>/<task-id>-<slug>
```

Rules:

- one implementation task -> one owner worktree;
- two agents MUST NOT write concurrently to the same branch;
- two agents MUST NOT modify the same mutable files in parallel unless the Controller serializes or re-scopes the work;
- reviewer work is read-only unless a separate fix Task Contract is created;
- an agent does not reuse another task's dirty worktree;
- worktrees start from a Controller-approved base SHA;
- merge ordering is re-evaluated when parallel branches depend on the same base behavior.

## 10. Concurrency model

Parallelism is permitted only for genuinely independent tasks.

Safe example:

```text
TG-A: runtime callback finalization
  owner: runtime-agent
  files: telegram-info/src/runtime-jobcenter.mjs

TG-B: independent no-photo regression fixture/test
  owner: qa-agent
  files: a non-overlapping test-only path
```

Unsafe cases that MUST be serialized include:

- two agents changing `runtime-jobcenter.mjs`;
- Runtime and Housing agents changing the same callback contract;
- a Release agent changing a workflow while another task depends on that unreleased workflow;
- implementation and reviewer both modifying the same branch;
- two tasks changing the same release-fingerprint assumption.

The default is safety over maximum parallelism.

## 11. Dispatch contract

Every dispatched agent receives only the context needed for its task:

```text
TASK_ID
ROLE
GOAL
BASE_SHA
BRANCH
ALLOWED_PATHS
FORBIDDEN_PATHS
ACCEPTANCE_CRITERIA
REQUIRED_CHECKS
DEPENDENCIES
REVIEWER
PRODUCTION_ACCESS=false
MERGE_ACCESS=false
```

The dispatched prompt points to authoritative role and contract files. It must not paste secret values or expand permissions beyond the Task Contract.

## 12. Implementation lifecycle

```text
REQUEST
 -> TRIAGE
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

Codex multi-agent execution changes only dispatch/isolated execution; it does not remove later gates.

## 13. QA model

TDD/regression-first behavior remains mandatory where applicable.

For bug fixes:

1. reproduce the failure;
2. add a targeted regression test and show it fails for the expected reason;
3. change only the minimal root cause;
4. make the targeted regression green;
5. run required broader suites;
6. independently verify that the test contract was not weakened.

A QA agent cannot change expected behavior merely to make a branch green.

## 14. Review independence

Final review routing remains authoritative:

```text
Runtime Agent -> QA Agent
Housing Agent -> QA Agent
QA Agent -> Runtime or Housing owner, as appropriate
Release Agent -> Security Reviewer
Security-sensitive fix -> Release Agent + QA as applicable
```

A reviewer returns exactly one terminal verdict:

```text
APPROVED
CHANGES_REQUIRED
BLOCKED
```

Self-check is not independent review.

## 15. Security model

### 15.1 Secrets

Agents may verify presence/configured use of secrets through non-disclosing checks, but MUST NOT retrieve, print, copy, log, or place secret values into prompts, `AGENTS.md`, task contracts, commits, PR bodies, CI logs, screenshots, handoffs, or reviews.

### 15.2 Production authority

Defaults remain:

```yaml
production_access: false
merge_access: false
```

Production deployment or credential rotation requires a separate explicitly authorized security/release task and existing manual protections.

### 15.3 Fail closed

If scope, secret impact, release impact, or dependency safety is ambiguous, the agent returns `BLOCKED` rather than inferring permission.

## 16. GitHub integration

GitHub remains the durable audit and coordination surface. Evidence should include, as applicable:

- issue/Task Contract;
- branch and commit SHA;
- changed files;
- handoff;
- independent review verdict;
- PR and CI run;
- staging or `NOT_REQUIRED`;
- merge SHA;
- live verification or `NOT_REQUIRED`;
- phone smoke or `NOT_REQUIRED`;
- rollback point.

Codex threads/worktrees are execution state, not the sole audit record.

## 17. Merge policy

No subagent may merge its own work.

A branch reaches `READY_FOR_MERGE` only when the Controller has evidence that scope is compliant, acceptance criteria are met, independent review is approved, mandatory CI is green, staging is green when required, no release blocker remains, and rollback is known.

This design grants no new automatic merge capability.

## 18. Release policy

The Telegram release chain is unchanged.

For this governance-only Codex integration:

```text
spec/review
 -> implementation
 -> governance/security review
 -> repository isolation validation
 -> no-runtime-diff validation
 -> READY_FOR_MERGE
```

Runtime-impacting work executed later by Codex still requires staging/live/phone-smoke where applicable. A green multi-agent run is never equivalent to a completed Telegram release.

## 19. Failure and recovery

If an implementation agent fails or stalls:

- preserve its branch/worktree for evidence;
- do not silently continue on its dirty worktree with another role;
- re-dispatch from the last known-good commit when appropriate;
- review any partial change before reuse.

If parallel branches overlap unexpectedly:

- stop automatic integration;
- classify the overlap;
- choose an explicit merge/rebase order;
- rerun affected tests;
- re-review if integration changes reviewed behavior.

Immediate blockers:

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

## 20. Planned implementation files

After plan approval, implementation is expected to be limited to:

```text
AGENTS.md
ISOLATION_POLICY.md
.github/workflows/standalone-telegram-ci.yml
ops/subagents/README.md
ops/subagents/codex/README.md
ops/subagents/templates/dispatch.md   # only if the implementation plan proves it useful
```

No Telegram runtime or runtime test file is part of this architecture task.

## 21. Validation strategy

Implementation must verify at least:

1. `AGENTS.md` references existing governance rather than duplicating it.
2. The Codex guide does not expand role permissions.
3. `production_access=false` and `merge_access=false` remain defaults.
4. `telegram-info/src/**`, runtime tests, deployment behavior, and runtime fingerprints are unchanged.
5. `AGENTS.md` is explicitly permitted by root isolation.
6. An arbitrary unknown top-level file still fails the same isolation rule.
7. Existing subagent contract language remains internally consistent.
8. No secret values are present in new/modified governance files.
9. Git diff contains only Task Contract-approved paths.

Because this task is governance-only, staging, live verification, and phone smoke are `NOT_REQUIRED` unless implementation unexpectedly changes runtime, delivery, deployment behavior, or release fingerprints. Such scope expansion blocks the task pending a revised contract.

## 22. Initial real-use target

After this execution layer is merged, its first intended operational use is the current phone-smoke failure work:

```text
Runtime Agent
  -> whole-Kreis completion/finalization root cause

Housing/Output owner
  -> no-photo listing output normalization if scope is independent

QA Agent
  -> RED regression coverage and independent verification

Security/Release
  -> review and release-gate evidence after implementation branches converge
```

Actual parallelization is decided from concrete file overlap at dispatch time.

## 23. Rollback

Rollback is:

- revert the Codex integration commit(s);
- remove root `AGENTS.md` and Codex-specific guide additions;
- remove `AGENTS.md` from the root isolation policy/CI allowlist;
- keep existing Subagent Architecture v1 intact;
- leave Telegram runtime/deployment state unaffected.

## 24. Acceptance

The user approved this specification on 2026-10-07 with these fixed decisions:

- Codex-native execution is the chosen approach;
- existing v1 governance remains authoritative;
- isolated worktrees/branches are required for implementation agents;
- reviewer independence remains mandatory;
- agents have no automatic merge, secret, or production-release authority;
- Telegram runtime remains out of scope;
- root `AGENTS.md` is admitted only through the narrow isolation exception in §6.4.

Implementation still requires an approved implementation plan and execution-method selection.