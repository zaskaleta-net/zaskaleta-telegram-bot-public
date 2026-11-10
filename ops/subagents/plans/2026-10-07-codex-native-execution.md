# Codex-native Subagent Execution Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a thin Codex-native execution layer that auto-loads the existing Telegram subagent governance, enforces isolated branch/worktree execution, and preserves all current merge, secret, isolation, and release gates without changing Telegram runtime behavior.

**Architecture:** Add a minimal root `AGENTS.md` that points Codex to the existing `ops/subagents/**` authority, explicitly admit only that file through the repository root isolation allowlist, and add a Codex execution guide plus dispatch template under `ops/subagents/`. Existing role, task, review, and release contracts remain normative; the new layer only explains and bootstraps execution.

**Tech Stack:** Markdown, YAML-like task metadata, Git/GitHub, Git worktrees, GitHub Actions shell validation, existing Node 22 Telegram repository CI.

**Spec:** `ops/subagents/specs/2026-10-07-codex-native-execution-design.md`

## Global Constraints

- Task: `TG-CODEX-001`; owner `release-agent`; reviewer `security-reviewer`.
- Allowed implementation paths are exactly `AGENTS.md`, `ISOLATION_POLICY.md`, `.github/workflows/standalone-telegram-ci.yml`, and `ops/subagents/**`.
- `telegram-info/src/**`, `telegram-info/test/**`, `telegram-control/**`, `telegram-qa/**`, production secrets, and environment values are forbidden.
- Existing Subagent Architecture v1 remains authoritative; do not duplicate its full policy corpus into `AGENTS.md`.
- `AGENTS.md` is the only newly admitted top-level file.
- Root isolation must continue to fail closed for every unknown top-level path.
- Canonical task branches remain `agent/<role>/<task-id>-<slug>`.
- Implementation owners use isolated worktrees/branches; reviewer work is read-only unless a separate fix task exists.
- Owner and final reviewer must be different roles.
- `production_access: false` and `merge_access: false` remain defaults.
- No agent may retrieve, print, log, copy, or commit secret values.
- No agent may push directly to `main`, self-authorize merge, weaken review/test gates, or independently release production.
- No Telegram runtime, deployment behavior, delivery configuration, or runtime release fingerprint may change in this task.
- Staging, live verification, and phone smoke are `NOT_REQUIRED` for this governance-only change unless scope unexpectedly expands; such expansion blocks the task.

## Review Focus

1. **Root isolation accidentally broadened:** Task 1 must prove `AGENTS.md` passes while a synthetic unknown top-level sentinel is still rejected.
2. **Policy duplication/drift in `AGENTS.md`:** Task 1 must verify it points to authoritative contracts instead of copying role/release policy bodies.
3. **Codex guide expands agent authority:** Task 2 must verify merge, production, secret, and reviewer restrictions remain equal to or stricter than existing v1 contracts.
4. **Parallel agents collide on mutable scope:** Task 2 must pin explicit serialization conditions for same-file, same-callback, same-workflow, dirty-worktree, or unreleased-dependency overlap.
5. **Hidden runtime/release impact:** Task 3 must prove the final diff contains no runtime/test/deployment-behavior changes and no runtime fingerprint edits.

---

## File Map

- Create `AGENTS.md` — minimal Codex repository entrypoint; points to authoritative governance and hard safety boundaries.
- Modify `ISOLATION_POLICY.md` — add only `AGENTS.md` to allowed top-level files.
- Modify `.github/workflows/standalone-telegram-ci.yml` — add only `AGENTS.md` to the root allowlist regex; preserve validation-only behavior.
- Create `ops/subagents/codex/README.md` — Codex bootstrap, dispatch, worktree, concurrency, handoff, review, failure, and release-boundary guide.
- Create `ops/subagents/templates/dispatch.md` — copy-ready dispatch envelope with exact scope/access fields; no secrets.
- Modify `ops/subagents/README.md` — add a concise pointer to the Codex guide; do not duplicate the guide.
- Existing spec/plan remain design/audit artifacts only.

### Task 1: Add root Codex entrypoint without weakening isolation

**Files:**
- Create: `AGENTS.md`
- Modify: `ISOLATION_POLICY.md`
- Modify: `.github/workflows/standalone-telegram-ci.yml`

**Interfaces:**
- Consumes: `ops/subagents/README.md`, `ops/subagents/contracts/TASK_CONTRACT.md`, `ops/subagents/contracts/REVIEW_POLICY.md`, `ops/subagents/contracts/RELEASE_POLICY.md`, canonical role files.
- Produces: a repository-root Codex bootstrap instruction file and a narrowly updated root allowlist that later tasks rely on.

- [ ] **Step 1: Record the pre-change root-isolation behavior**

Run the current allowlist expression from `.github/workflows/standalone-telegram-ci.yml` against the repository root.

Expected: current root passes; `AGENTS.md` is not yet an allowed top-level entry.

- [ ] **Step 2: Create `AGENTS.md`**

Required statements:
- this is the standalone `@ZaskaletaInfoBot` repository;
- read `ops/subagents/README.md` before implementation;
- read the assigned role file and applicable contracts;
- no implementation without a valid Task Contract;
- obey `allowed_paths` / `forbidden_paths` as hard boundaries;
- implementation owners use isolated task branch/worktree;
- owner and final reviewer are different roles;
- no direct `main` write, secret retrieval/exposure, autonomous production release, or gate weakening;
- existing CI/staging/live/phone-smoke policy remains authoritative;
- ambiguity in scope/security/release impact returns `BLOCKED`.

Keep it concise and link to existing policy instead of copying detailed role/release rules.

- [ ] **Step 3: Modify `ISOLATION_POLICY.md`**

Add exactly one new allowed top-level file: `AGENTS.md`.

Do not add any other root path or relax the rule that unknown top-level paths are isolation breaches.

- [ ] **Step 4: Modify `.github/workflows/standalone-telegram-ci.yml` root regex**

Change only the `allowed=` expression in the `Enforce Telegram-only root` step so `AGENTS.md` is accepted.

Do not alter triggers, permissions, deployment behavior, test steps, or any other workflow logic.

- [ ] **Step 5: Verify the allowed root passes**

Run:
```bash
allowed='^(.git$|.github$|.gitignore$|AGENTS.md$|README.md$|ISOLATION_MANIFEST.json$|ISOLATION_POLICY.md$|ops$|telegram-control$|telegram-info$|telegram-qa$)$'
bad="$(find . -mindepth 1 -maxdepth 1 -printf '%f\n' | grep -Ev "$allowed" || true)"
test -z "$bad"
```
Expected: exit 0.

- [ ] **Step 6: Verify isolation still fails closed for an unknown root file**

Run:
```bash
touch __TG_CODEX_FORBIDDEN_SENTINEL__
allowed='^(.git$|.github$|.gitignore$|AGENTS.md$|README.md$|ISOLATION_MANIFEST.json$|ISOLATION_POLICY.md$|ops$|telegram-control$|telegram-info$|telegram-qa$)$'
bad="$(find . -mindepth 1 -maxdepth 1 -printf '%f\n' | grep -Ev "$allowed" || true)"
printf '%s\n' "$bad" | grep -Fx '__TG_CODEX_FORBIDDEN_SENTINEL__'
rm __TG_CODEX_FORBIDDEN_SENTINEL__
```
Expected: sentinel is detected; cleanup succeeds.

- [ ] **Step 7: Verify `AGENTS.md` references authority instead of duplicating it**

Run:
```bash
grep -F 'ops/subagents/README.md' AGENTS.md
grep -F 'Task Contract' AGENTS.md
grep -F 'BLOCKED' AGENTS.md
```
Expected: all exit 0. Manual review confirms detailed role/release tables are not copied into the file.

- [ ] **Step 8: Commit Task 1**

```bash
git add AGENTS.md ISOLATION_POLICY.md .github/workflows/standalone-telegram-ci.yml
git commit -m "chore(codex): add guarded repository agent entrypoint"
```

### Task 2: Add Codex execution and dispatch guidance

**Files:**
- Create: `ops/subagents/codex/README.md`
- Create: `ops/subagents/templates/dispatch.md`
- Modify: `ops/subagents/README.md`

**Interfaces:**
- Consumes: root `AGENTS.md`, all existing v1 roles/contracts/templates, branch naming and access defaults.
- Produces: the operator/subagent execution protocol used when real Codex multi-agent execution is available.

- [ ] **Step 1: Create `ops/subagents/codex/README.md`**

It must define:
- Controller bootstrap order;
- task decomposition and dependency analysis;
- when parallel dispatch is safe vs mandatory serialization;
- one owner task per isolated worktree/branch;
- Controller-approved base SHA;
- no two writers on one branch;
- reviewer default read-only behavior;
- dispatch envelope fields from the spec;
- self-check -> handoff -> independent review -> CI -> impact-based staging flow;
- three review verdicts only: `APPROVED`, `CHANGES_REQUIRED`, `BLOCKED`;
- recovery from stalled agents, dirty worktrees, and overlapping branches;
- merge/secret/production authority boundaries;
- GitHub as durable audit evidence.

- [ ] **Step 2: Create `ops/subagents/templates/dispatch.md`**

The template must contain exactly these semantic fields:

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

It must point the worker to its canonical role file and Task Contract. It must explicitly forbid secret values in the dispatch payload.

- [ ] **Step 3: Add a small Codex pointer to `ops/subagents/README.md`**

Add only:
- that real isolated execution is documented in `codex/README.md`;
- that the existing contracts remain authoritative;
- that root `AGENTS.md` is the Codex discovery entrypoint.

Do not duplicate the Codex guide.

- [ ] **Step 4: Verify access and reviewer invariants**

Run:
```bash
grep -F 'production_access: false' ops/subagents/contracts/TASK_CONTRACT.md
grep -F 'merge_access: false' ops/subagents/contracts/TASK_CONTRACT.md
grep -F 'PRODUCTION_ACCESS=false' ops/subagents/templates/dispatch.md
grep -F 'MERGE_ACCESS=false' ops/subagents/templates/dispatch.md
grep -F 'APPROVED' ops/subagents/codex/README.md
grep -F 'CHANGES_REQUIRED' ops/subagents/codex/README.md
grep -F 'BLOCKED' ops/subagents/codex/README.md
grep -F 'worktree' ops/subagents/codex/README.md
grep -F 'agent/<role>/<task-id>-<slug>' ops/subagents/codex/README.md
```
Expected: all commands exit 0.

- [ ] **Step 5: Verify collision rules are explicit**

Manual review must find explicit serialization for:
- same mutable file;
- same callback/state contract;
- same workflow;
- dirty/shared worktree or branch;
- dependency on unreleased implementation.

Expected: no ambiguous "parallel when possible" rule without these blockers.

- [ ] **Step 6: Commit Task 2**

```bash
git add ops/subagents/README.md ops/subagents/codex/README.md ops/subagents/templates/dispatch.md
git commit -m "docs(codex): define isolated subagent execution protocol"
```

### Task 3: Whole-branch governance, isolation, and no-runtime-diff validation

**Files:**
- Verify all TG-CODEX-001 changed files; no new implementation file should be added in this task.

**Interfaces:**
- Consumes: Tasks 1–2 completed branch.
- Produces: handoff evidence for Security Reviewer and normal PR CI.

- [ ] **Step 1: Verify changed-path scope**

Run:
```bash
git diff --name-only main...HEAD
```
Expected: every path is one of:
```text
AGENTS.md
ISOLATION_POLICY.md
.github/workflows/standalone-telegram-ci.yml
ops/subagents/**
```
Any other path is `SCOPE_BREACH`.

- [ ] **Step 2: Prove no Telegram runtime/test diff**

Run:
```bash
test -z "$(git diff --name-only main...HEAD -- telegram-info/src telegram-info/test telegram-control telegram-qa)"
```
Expected: exit 0.

- [ ] **Step 3: Prove workflow change is root-allowlist-only**

Run:
```bash
git diff main...HEAD -- .github/workflows/standalone-telegram-ci.yml
```
Expected: only the root `allowed=` expression changes; no trigger, permission, job, dependency, deploy, or test-step change.

- [ ] **Step 4: Re-run root allowlist and fail-closed sentinel checks**

Repeat Task 1 Steps 5–6 from final branch state.

Expected: allowed root passes; unknown sentinel is rejected.

- [ ] **Step 5: Check governance references and secret hygiene**

Inspect the new/modified governance files for credential-shaped examples and secret-value material. Confirm only names such as `production_access`, `TELEGRAM_*` concepts, or "secret" policy wording appear; no actual token, webhook secret, Cloudflare credential, or environment value is present.

Expected: no secret value is present.

- [ ] **Step 6: Run repository validation**

Run the repository's existing validation path, at minimum the isolation workflow-equivalent commands and, when execution environment permits, the full `Standalone Telegram Isolation CI` through the PR.

Expected: all mandatory checks green. A failure must be diagnosed; tests/workflow gates may not be weakened to force green.

- [ ] **Step 7: Produce handoff**

Create the TG-CODEX-001 handoff using `ops/subagents/templates/handoff.md` with:
- exact changed files;
- rationale;
- root-isolation PASS evidence;
- fail-closed sentinel PASS evidence;
- no-runtime-diff PASS evidence;
- CI evidence when available;
- risks;
- out-of-scope statement;
- commit SHA.

Expected status: `READY_FOR_REVIEW`.

- [ ] **Step 8: Security Reviewer gate**

Security Reviewer checks scope, secret handling, reviewer independence, root-isolation fail-closed behavior, merge/production boundaries, and workflow diff.

Expected terminal verdict: `APPROVED`, `CHANGES_REQUIRED`, or `BLOCKED`. Only `APPROVED` permits PR acceptance.

- [ ] **Step 9: Open/update PR and wait for normal CI**

PR must reference issue `#10`, identify the task as governance-only, and state:
```text
STAGING_STATUS: NOT_REQUIRED
LIVE_VERIFY_STATUS: NOT_REQUIRED
PHONE_SMOKE_STATUS: NOT_REQUIRED
```
provided no runtime/deploy/release behavior changed.

- [ ] **Step 10: Controller merge-readiness decision**

Controller may mark `READY_FOR_MERGE` only after approved independent review, green required CI, scope compliance, no runtime diff, and known rollback point.

No agent self-merges.

## Rollback

If the integration must be removed:

1. revert TG-CODEX-001 commits;
2. remove root `AGENTS.md`;
3. remove `AGENTS.md` from `ISOLATION_POLICY.md` and the CI root allowlist;
4. keep the pre-existing `ops/subagents/**` v1 governance intact;
5. no Telegram runtime or deployment rollback is required because this plan must never modify them.
