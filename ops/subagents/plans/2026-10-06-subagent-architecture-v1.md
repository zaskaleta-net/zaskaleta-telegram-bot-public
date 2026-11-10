# Subagent Architecture v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the governance-only Subagent Architecture v1 under `ops/subagents/` without changing Telegram runtime, CI/deploy behavior, release fingerprints, secrets, or production state.

**Architecture:** Keep this chat as the Controller/Orchestrator, persist six role definitions plus task/handoff/review/release contracts in the repository, and make those files the durable handoff surface for future Codex subagents. This first PR is policy/documentation only; it reuses all existing repository isolation and release gates rather than creating a second runtime or dispatcher.

**Tech Stack:** Markdown, YAML templates, Git/GitHub, existing Node 22 Telegram repository CI.

**Spec:** `ops/subagents/specs/2026-10-06-subagent-architecture-v1-design.md`

## Global Constraints

- All subagent architecture files MUST live under `ops/subagents/`; no new top-level path is allowed.
- Execution mode is Hybrid C: this ChatGPT conversation is the primary Controller/Orchestrator; repository files are durable contracts; real subagents are dispatched only where the execution environment supports them.
- Autonomy level is 2: agents may branch, commit, open PRs, run CI, and trigger approved guarded staging; they MUST NOT merge to `main`, push directly to `main`, rotate/reveal production secrets, weaken tests/reviewed-tree guards, bypass manual gates, or independently release production.
- Implementer and final reviewer MUST be different roles.
- Secret values MUST NOT appear in repository files, logs, PR text, task files, screenshots, or chat.
- The first v1 implementation PR is governance-only and MUST NOT modify bot runtime, CI/deploy workflow behavior, live-verification behavior, production behavior, or reviewed-tree fingerprints.
- Governance/docs-only work skips staging, live verification, and phone smoke when no deploy/runtime/release behavior changed; repository isolation and normal PR CI remain required.
- Existing Telegram isolation and release policy remain authoritative and cannot be weakened by subagent governance.

## Review Focus

1. **Scope overlap / self-review:** no role may gain implicit authority over another role's domain, and implementer/final reviewer must be different roles. Task 1 pins scopes; Task 2 pins reviewer independence and routing.
2. **Release-agent overreach:** `release-agent.md` must exclude `ops/subagents/**` unless a separate governance task grants access. Task 1 pins this rule.
3. **Hidden runtime/CI change:** this bootstrap branch must contain only `ops/subagents/**` changes. Task 4 verifies the diff against `main`.
4. **Secret leakage:** all contracts/templates must describe secret values as opaque/write-only and contain no example token/credential values. Tasks 2–4 verify this.
5. **Wrong release gating for docs-only work:** contracts must state `STAGING_STATUS: NOT_REQUIRED` and equivalent live/phone states when impact does not require them, while preserving full gates for runtime/release-impacting work. Task 2 verifies this distinction.

---

## File Map

### Role definitions
- Create `ops/subagents/roles/controller.md` — Controller authority, triage, assignment, concurrency, merge-readiness and release-status boundaries.
- Create `ops/subagents/roles/runtime-agent.md` — Telegram runtime scope and prohibitions.
- Create `ops/subagents/roles/housing-agent.md` — housing/Jobcenter/routing scope and prohibitions.
- Create `ops/subagents/roles/qa-agent.md` — regression/audit scope, test-integrity rules and review responsibilities.
- Create `ops/subagents/roles/release-agent.md` — workflow/release infrastructure scope with explicit exclusion of `ops/subagents/**` by default.
- Create `ops/subagents/roles/security-reviewer.md` — default read-only security review, secret/auth/trust-boundary rules.

### Contracts
- Create `ops/subagents/contracts/TASK_CONTRACT.md` — mandatory triage/task fields, scope, acceptance criteria, checks, branch naming and access flags.
- Create `ops/subagents/contracts/HANDOFF_CONTRACT.md` — required completion package and evidence fields.
- Create `ops/subagents/contracts/REVIEW_POLICY.md` — reviewer independence, routing, review dimensions, verdicts, blocking codes, test-integrity rules.
- Create `ops/subagents/contracts/RELEASE_POLICY.md` — state machine, CI/staging/live/phone impact rules, merge-readiness evidence, failure transitions, concurrency policy and audit-trail requirements.

### Templates and entrypoint
- Create `ops/subagents/templates/task.yaml` — machine-copyable Task Contract skeleton.
- Create `ops/subagents/templates/handoff.md` — handoff skeleton.
- Create `ops/subagents/templates/review.md` — review/verdict skeleton.
- Create `ops/subagents/README.md` — concise usage sequence for this chat and Codex, linking the spec, plan, roles, contracts and templates.

No existing runtime, workflow, manifest, release-gate, or root README file is modified in v1 bootstrap.

### Task 1: Create the six role contracts

**Files:**
- Create: `ops/subagents/roles/controller.md`
- Create: `ops/subagents/roles/runtime-agent.md`
- Create: `ops/subagents/roles/housing-agent.md`
- Create: `ops/subagents/roles/qa-agent.md`
- Create: `ops/subagents/roles/release-agent.md`
- Create: `ops/subagents/roles/security-reviewer.md`

**Interfaces:**
- Consumes: role definitions and autonomy rules from spec §§6–8.
- Produces: canonical role names and boundaries consumed by Task 2 contracts and Task 3 templates/README.

- [ ] **Step 1: Record the pre-implementation role-file state**

Run a shell check that confirms the six role files do not yet exist on the current branch. Record that result in the task handoff as the before-state; do not add CI or runtime code for this check.

- [ ] **Step 2: Create `controller.md`**

Document: purpose; responsibilities; allowed actions; prohibited actions; Controller-only merge-readiness/final-release authority; triage fields; parallelization decision; rule that governance writing outside Controller metadata requires a separately scoped task.

- [ ] **Step 3: Create `runtime-agent.md` and `housing-agent.md`**

Pin exact scopes from the spec. Runtime owns Telegram state/callback/render/fallback work; Housing owns housing search, Jobcenter/Kreis routing, municipality aliases, radius/whole-Kreis and listing normalization. State that crossing scope requires Controller handoff rather than opportunistic edits.

- [ ] **Step 4: Create `qa-agent.md`**

Pin `telegram-info/test/**`, `.github/qa/**`, `telegram-qa/**`, test fixtures/audits, prohibition on weakening tests, and independent review responsibility for runtime/housing work.

- [ ] **Step 5: Create `release-agent.md` and `security-reviewer.md`**

`release-agent.md` MUST state that its operational `ops/**` authority excludes `ops/subagents/**` unless an explicit governance Task Contract grants access. `security-reviewer.md` defaults to read-only and forbids secret-value retrieval/logging, independent deploy and merge.

- [ ] **Step 6: Verify role boundaries**

Run:
```bash
test -f ops/subagents/roles/controller.md && \
test -f ops/subagents/roles/runtime-agent.md && \
test -f ops/subagents/roles/housing-agent.md && \
test -f ops/subagents/roles/qa-agent.md && \
test -f ops/subagents/roles/release-agent.md && \
test -f ops/subagents/roles/security-reviewer.md

grep -F 'ops/subagents/**' ops/subagents/roles/release-agent.md
grep -F 'read-only' ops/subagents/roles/security-reviewer.md
```
Expected: all commands exit 0; release scope exclusion and read-only security default are present.

- [ ] **Step 7: Commit**

```bash
git add ops/subagents/roles
git commit -m "docs(subagents): define v1 agent roles"
```

### Task 2: Create task, handoff, review and release contracts

**Files:**
- Create: `ops/subagents/contracts/TASK_CONTRACT.md`
- Create: `ops/subagents/contracts/HANDOFF_CONTRACT.md`
- Create: `ops/subagents/contracts/REVIEW_POLICY.md`
- Create: `ops/subagents/contracts/RELEASE_POLICY.md`

**Interfaces:**
- Consumes: canonical role names from Task 1 and state/review policy from spec §§9–20.
- Produces: normative contracts used verbatim by Task 3 templates and README.

- [ ] **Step 1: Create `TASK_CONTRACT.md`**

Require: `task_id`, owner, different-role reviewer, severity, type, goal, allowed/forbidden paths, observable acceptance criteria, required checks, branch, `production_access: false`, `merge_access: false`. Include triage fields `SYMPTOM`, `EXPECTED`, `ACTUAL`, `LIKELY_ROOT_CAUSE`, `AFFECTED_FLOW`, `RISK`, `OWNER`, `REVIEWER`; require branch pattern `agent/<role>/<task-id>-<slug>`; state that a task without explicit acceptance criteria is not implementable.

- [ ] **Step 2: Create `HANDOFF_CONTRACT.md`**

Require: task/status, changed files, cause/rationale, exact test evidence, risks, out-of-scope declaration and commit SHA. A missing handoff means incomplete work.

- [ ] **Step 3: Create `REVIEW_POLICY.md`**

Define implementer/final-reviewer role inequality, default reviewer routing (`Runtime -> QA`, `Housing -> QA`, `QA -> Runtime or Housing owner`, `Release -> Security`, security fixes -> Release + QA as applicable), review dimensions (spec compliance, code quality, regression risk), only three verdicts (`APPROVED`, `CHANGES_REQUIRED`, `BLOCKED`), blocking codes, and prohibition on test weakening.

- [ ] **Step 4: Create `RELEASE_POLICY.md`**

Encode the state machine:
`REQUEST -> TRIAGE -> TASK_CONTRACT -> ASSIGN -> IMPLEMENT -> SELF_CHECK -> REVIEW -> CI -> STAGING (when required) -> ACCEPTANCE -> READY_FOR_MERGE -> CONTROLLER_MERGE -> LIVE_VERIFY (when release-impacting) -> PHONE_SMOKE (when user-facing/runtime-impacting) -> RELEASE_COMPLETE`.
Document:
- failure transitions from spec §16;
- merge-readiness evidence and impact-based `NOT_REQUIRED` statuses;
- preservation of current Telegram release gates;
- concurrency rule: parallel work only when tasks do not touch the same files, mutable state contract, callback interface, workflow, or unreleased dependency; otherwise Controller serializes them;
- audit trail fields from spec §18, including task/branch/owner/reviewer/commits/files/tests/review/CI/staging-or-NOT_REQUIRED/merge/live-or-NOT_REQUIRED/phone-or-NOT_REQUIRED/risks/rollback.

- [ ] **Step 5: Verify critical policy invariants**

Run:
```bash
grep -F 'agent/<role>/<task-id>-<slug>' ops/subagents/contracts/TASK_CONTRACT.md
grep -F 'different' ops/subagents/contracts/REVIEW_POLICY.md
grep -F 'APPROVED' ops/subagents/contracts/REVIEW_POLICY.md
grep -F 'CHANGES_REQUIRED' ops/subagents/contracts/REVIEW_POLICY.md
grep -F 'BLOCKED' ops/subagents/contracts/REVIEW_POLICY.md
grep -F 'TEST_WEAKENING' ops/subagents/contracts/REVIEW_POLICY.md
grep -F 'STAGING_STATUS' ops/subagents/contracts/RELEASE_POLICY.md
grep -F 'NOT_REQUIRED' ops/subagents/contracts/RELEASE_POLICY.md
grep -F 'PHONE_SMOKE' ops/subagents/contracts/RELEASE_POLICY.md
grep -F 'parallel' ops/subagents/contracts/RELEASE_POLICY.md
grep -F 'rollback' ops/subagents/contracts/RELEASE_POLICY.md
```
Expected: every command exits 0; reviewer independence, branch naming, concurrency/audit requirements, and docs-only-vs-runtime release impact are explicit.

- [ ] **Step 6: Commit**

```bash
git add ops/subagents/contracts
git commit -m "docs(subagents): add task review and release contracts"
```

### Task 3: Add reusable templates and operator README

**Files:**
- Create: `ops/subagents/templates/task.yaml`
- Create: `ops/subagents/templates/handoff.md`
- Create: `ops/subagents/templates/review.md`
- Create: `ops/subagents/README.md`

**Interfaces:**
- Consumes: exact field names/verdicts/states from Task 2.
- Produces: copy-ready artifacts used by the Controller in this chat and by future Codex subagent executions.

- [ ] **Step 1: Create `task.yaml`**

Mirror the mandatory Task Contract fields exactly. Include branch placeholder in `agent/<role>/<task-id>-<slug>` form. Keep `production_access: false` and `merge_access: false` as explicit defaults. Do not include real IDs, tokens, webhook secrets or credential-shaped examples.

- [ ] **Step 2: Create `handoff.md`**

Mirror the Handoff Contract headings exactly: TASK, STATUS, CHANGED, WHY, TESTS, RISKS, OUT_OF_SCOPE, COMMIT.

- [ ] **Step 3: Create `review.md`**

Require reviewer identity, implementer identity, explicit confirmation that they are different roles, scope check, spec compliance, code quality, regression risk, evidence, blocking-code field and exactly one final verdict from the approved three-value set.

- [ ] **Step 4: Create `ops/subagents/README.md`**

Document the operator sequence:
1. Controller triages.
2. Copy `templates/task.yaml` and fill a Task Contract.
3. Assign a scoped role/branch.
4. Controller decides whether work is safe to parallelize or must be serialized.
5. Implement/self-check.
6. Produce handoff.
7. Independent reviewer produces review.
8. Run required CI and impact-based staging.
9. Controller decides merge readiness.
10. For release-impacting work, perform existing live/phone gates.
11. Record the required audit trail and rollback point.
Also state that this chat is the primary Controller and Codex is the preferred real-subagent execution environment when true subagent dispatch is needed.

- [ ] **Step 5: Verify template/contract field consistency**

Run:
```bash
grep -F 'agent/<role>/<task-id>-<slug>' ops/subagents/templates/task.yaml
grep -F 'production_access: false' ops/subagents/templates/task.yaml
grep -F 'merge_access: false' ops/subagents/templates/task.yaml
grep -F 'READY_FOR_REVIEW' ops/subagents/templates/handoff.md
grep -F 'APPROVED' ops/subagents/templates/review.md
grep -F 'CHANGES_REQUIRED' ops/subagents/templates/review.md
grep -F 'BLOCKED' ops/subagents/templates/review.md
```
Expected: all commands exit 0 and templates use the same vocabulary as the normative contracts.

- [ ] **Step 6: Commit**

```bash
git add ops/subagents/README.md ops/subagents/templates
git commit -m "docs(subagents): add v1 templates and operator guide"
```

### Task 4: Validate governance-only isolation and prepare the PR

**Files:**
- Verify only; no runtime/workflow file modification is permitted.
- Existing design: `ops/subagents/specs/2026-10-06-subagent-architecture-v1-design.md`
- Existing plan: `ops/subagents/plans/2026-10-06-subagent-architecture-v1.md`

**Interfaces:**
- Consumes: all artifacts from Tasks 1–3.
- Produces: evidence that the branch is governance-only, internally consistent, isolated, secret-clean by inspection, and ready for normal PR CI/review.

- [ ] **Step 1: Verify complete file set**

Run:
```bash
find ops/subagents -maxdepth 3 -type f | sort
```
Expected: spec, plan, README, six roles, four contracts, and three templates; no unexpected executable/runtime files.

- [ ] **Step 2: Verify branch diff is governance-only**

Run:
```bash
git diff --name-only main...HEAD
```
Expected: every path starts with `ops/subagents/`. Any other path is `SCOPE_BREACH` and blocks the PR.

- [ ] **Step 3: Verify repository root isolation remains valid**

Run the same root rule used by `standalone-telegram-ci.yml`:
```bash
allowed='^(.git$|.github$|.gitignore$|README.md$|ISOLATION_MANIFEST.json$|ISOLATION_POLICY.md$|ops$|telegram-control$|telegram-info$|telegram-qa$)$'
bad="$(find . -mindepth 1 -maxdepth 1 -printf '%f\n' | grep -Ev "$allowed" || true)"
test -z "$bad"
```
Expected: exit 0.

- [ ] **Step 4: Verify no accidental deploy/release-fingerprint change**

Run:
```bash
git diff --quiet main...HEAD -- .github/workflows telegram-info/src telegram-info/wrangler.jsonc ISOLATION_MANIFEST.json
```
Expected: exit 0.

- [ ] **Step 5: Review for secret-shaped content and unsafe instructions**

Inspect the diff and confirm there are no actual Telegram/Cloudflare tokens, webhook secret values, private IDs, or instructions to print/retrieve secret values. Any finding is `SECRET_EXPOSURE` and blocks completion.

- [ ] **Step 6: Run repository validation**

Run the existing repository checks appropriate to this governance-only PR. At minimum verify the isolation rule; when CI is available, open the PR and require `Standalone Telegram Isolation CI` to pass. Do not trigger staging/live/phone smoke solely for this docs-only bootstrap.

- [ ] **Step 7: Final self-review against the spec**

Check every acceptance criterion in spec §22 and record PASS/FAIL. Confirm all six roles, four contracts, three templates, reviewer independence, branch/scope rules, concurrency/failure policy, audit trail, secret policy, and Controller-only merge/release authority are present.

- [ ] **Step 8: Commit any review-only documentation correction if needed**

If Task 4 finds a documentation inconsistency, fix only `ops/subagents/**`, rerun Steps 1–7, and commit with:
```bash
git add ops/subagents
git commit -m "docs(subagents): finalize v1 governance contracts"
```
If no correction is needed, do not create an empty commit.

- [ ] **Step 9: Open PR to `main`**

PR title: `docs: bootstrap Telegram subagent architecture v1`

PR body must state:
- governance-only;
- changed paths restricted to `ops/subagents/**`;
- no runtime/workflow/release-fingerprint change;
- staging/live/phone smoke: `NOT_REQUIRED` for this PR;
- normal PR CI required;
- merge remains Controller-authorized only.
