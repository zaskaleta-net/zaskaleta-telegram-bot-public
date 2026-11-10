# Zaskaleta Telegram Bot — Subagent Architecture v1

Date: 2026-10-06
Status: Design specification
Repository: `sergokharkov/zaskaleta-telegram-bot`
Primary controller surface: current ChatGPT conversation
Execution mode: Hybrid C
Autonomy level: 2 (extended)

## 1. Purpose

Define a disciplined multi-agent operating model for the standalone Telegram bot repository without weakening the existing isolation, CI, staging, live-verification, or phone-smoke release gates.

The current ChatGPT conversation remains the primary Controller/Orchestrator. The repository stores durable role definitions, task contracts, handoff rules, review policy, and release policy. When work is executed in Codex or another environment with real subagent support, the same role contracts are used to dispatch real specialized agents.

## 2. Goals

- Preserve the standalone Telegram-only repository boundary.
- Allow specialized agents to work independently on well-scoped tasks.
- Require explicit task ownership, file scope, acceptance criteria, tests, review, and audit evidence.
- Permit agents to create branches, commits, pull requests, run CI, and run guarded staging verification.
- Prevent agents from independently merging to `main`, changing production secrets, or performing production release actions.
- Reuse the existing release chain instead of creating a parallel release system.
- Make agent work reproducible and auditable after context loss.

## 3. Non-goals

- No autonomous production deployment.
- No replacement of GitHub Actions, Cloudflare deployment gates, or existing QA systems.
- No new general-purpose agent framework, state database, message bus, or scheduler in v1.
- No cross-project access to Zaskaleta Media, TV, AI Twin/Clone, Android, TikTok, YouTube, or unrelated infrastructure.
- No secret extraction, secret logging, or secret propagation between repositories.
- No automatic merge to `main`.

## 4. Architectural model

Hybrid C has three layers:

1. **Controller layer** — the current ChatGPT conversation is the decision and orchestration surface.
2. **Repository contract layer** — durable role definitions, task contracts, handoff contracts, review rules, and release policy live under `ops/subagents/`.
3. **Execution layer** — when Codex/subagent execution is available, fresh specialized agents are dispatched from the repository contracts.

The repository contract layer must not become a second runtime. It is governance and execution metadata only.

## 5. Repository placement

All subagent architecture files MUST live under the already-allowed top-level `ops/` path.

Target layout:

```text
ops/subagents/
├── README.md
├── roles/
│   ├── controller.md
│   ├── runtime-agent.md
│   ├── housing-agent.md
│   ├── qa-agent.md
│   ├── release-agent.md
│   └── security-reviewer.md
├── contracts/
│   ├── TASK_CONTRACT.md
│   ├── HANDOFF_CONTRACT.md
│   ├── REVIEW_POLICY.md
│   └── RELEASE_POLICY.md
├── templates/
│   ├── task.yaml
│   ├── handoff.md
│   └── review.md
└── specs/
    └── 2026-10-06-subagent-architecture-v1-design.md
```

No new top-level path may be introduced for agent infrastructure.

## 6. Roles

### 6.1 Controller / Orchestrator

Responsibilities:
- triage incoming requests;
- classify severity and task type;
- create Task Contracts;
- assign owner and reviewer;
- decide whether tasks may run in parallel;
- collect handoff evidence;
- enforce review and CI gates;
- authorize merge readiness;
- coordinate live verification and phone smoke;
- maintain final release status.

Permissions:
- may coordinate PRs, CI, staging, and review;
- may write only orchestration/governance metadata unless acting under a separate scoped implementation task.

Restrictions:
- must not bypass reviewer independence;
- must not expose secrets;
- must not treat green CI as equivalent to completed release;
- production release remains an explicit controlled action.

### 6.2 Telegram Runtime Agent

Primary scope:
- `telegram-info/src/**`
- directly related runtime tests under `telegram-info/test/**`

Responsibilities:
- Telegram state machine;
- `/start` recovery;
- callback routing;
- pagination;
- message/card rendering behavior;
- duplicate-state prevention;
- runtime fallback behavior.

Restrictions:
- no workflow changes;
- no secret access;
- no merge to `main`;
- no release-policy edits;
- no unrelated housing-policy changes unless explicitly assigned.

### 6.3 Housing Search Agent

Primary scope:
- housing search logic;
- Jobcenter/Kreis routing;
- municipality aliases;
- radius and whole-Kreis behavior;
- listing-source normalization and deduplication;
- directly related tests.

Restrictions:
- no general runtime refactor outside the task scope;
- no workflow or secret changes;
- no deployment actions beyond approved staging execution.

### 6.4 QA / Regression Agent

Primary scope:
- `telegram-info/test/**`
- `.github/qa/**`
- `telegram-qa/**`
- test fixtures and forensic/statewide audits.

Responsibilities:
- regression coverage;
- failure reproduction;
- statewide and municipality validation;
- phone-smoke preparation;
- independent review of runtime/housing changes.

Restrictions:
- must not weaken tests merely to obtain green CI;
- must not change production logic to fit an incorrect test expectation;
- any intentional regression-contract change requires its own task and review.

### 6.5 Release / Infrastructure Agent

Primary scope:
- `.github/workflows/**`
- Telegram-specific operational files under `ops/**`, excluding `ops/subagents/**` unless a separate governance Task Contract explicitly grants access;
- deployment/verification configuration.

Responsibilities:
- CI workflows;
- guarded staging workflows;
- live-verification workflows;
- reviewed-tree guards;
- release diagnostics;
- rollback metadata.

Restrictions:
- no business-logic changes;
- no implicit authority over subagent governance files;
- no production deploy without Controller authorization;
- no weakening of reviewed-tree, manual-gate, or isolation rules.

### 6.6 Security Reviewer

Default mode: read-only review.

Responsibilities:
- secret handling;
- webhook authentication;
- permission boundaries;
- workflow trust boundaries;
- scope and isolation breaches;
- unsafe deployment behavior.

Restrictions:
- no secret-value retrieval or logging;
- no independent deploy or merge;
- security fixes require a separately scoped branch and independent review.

## 7. Autonomy level 2

Agents MAY:
- inspect repository state;
- create a scoped working branch;
- write code within allowed paths;
- write tests;
- commit changes;
- open a PR;
- trigger CI;
- trigger approved guarded staging verification;
- inspect resulting logs and artifacts.

Agents MUST NOT:
- merge to `main`;
- push directly to `main`;
- rotate or reveal production secrets;
- disable tests;
- weaken reviewed-tree guards;
- bypass manual staging/live gates;
- perform production release actions independently.

## 8. Branch naming

All implementation branches use:

```text
agent/<role>/<task-id>-<slug>
```

Examples:

```text
agent/runtime/TG-142-fix-start-recovery
agent/housing/TG-143-nortorf-alias-regression
agent/release/TG-144-live-verify-preflight
```

This namespace provides a visible audit trail and prevents unrelated work from being mixed.

## 9. Task Contract

Every implementation task MUST have a Task Contract before code changes begin.

Required fields:

```yaml
task_id: TG-XXX
owner: runtime-agent | housing-agent | qa-agent | release-agent | security-reviewer
reviewer: <different role>
severity: P0 | P1 | P2 | P3
type: runtime | housing | qa | release | security

goal: >
  Concrete outcome.

scope:
  allowed_paths:
    - ...
  forbidden_paths:
    - ...

acceptance:
  - explicit observable criterion
  - explicit regression criterion

required_checks:
  - syntax
  - targeted_tests
  - full_suite_if_runtime_changed

branch: agent/<role>/<task-id>-<slug>
production_access: false
merge_access: false
```

A task without explicit acceptance criteria is not implementable.

## 10. Triage contract

Before Task Contract creation, Controller records:

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

## 11. Handoff Contract

An implementer cannot finish with a simple “done”. The handoff package MUST contain:

```text
TASK: TG-XXX
STATUS: READY_FOR_REVIEW

CHANGED:
- file A
- file B

WHY:
- observed cause
- chosen fix rationale

TESTS:
- test X: PASS
- test Y: PASS

RISKS:
- known risk

OUT_OF_SCOPE:
- explicitly untouched area

COMMIT:
<sha>
```

A missing handoff package means the task is incomplete.

## 12. Reviewer independence

Implementer and final reviewer MUST be different roles.

Default routing:

```text
Runtime Agent  -> QA Agent
Housing Agent  -> QA Agent
QA Agent       -> Runtime or Housing owner
Release Agent  -> Security Reviewer
Security fix   -> Release Agent + QA Agent as applicable
```

Review has three dimensions:

1. **Spec compliance** — acceptance criteria, scope compliance, no unintended behavior.
2. **Code quality** — state safety, error handling, duplication, fallbacks, maintainability.
3. **Regression risk** — start recovery, callbacks, household state, pagination, Kreis/radius, no-result behavior, webhook/runtime boundaries.

Allowed verdicts only:

```text
APPROVED
CHANGES_REQUIRED
BLOCKED
```

## 13. Blocking conditions

Controller or reviewer MUST block on:

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

`BLOCKED` is mandatory for security issues, isolation breaches, secret leakage, destructive migrations, failing mandatory tests, or unknown production impact.

## 14. Test integrity policy

A failing implementation MUST NOT be made green by weakening the test contract.

Prohibited examples:
- deleting an assertion because the implementation fails it;
- lowering expected counts without a requirements change;
- removing an edge-case fixture to make CI pass;
- skipping a mandatory test without a separate reviewed task.

Any intentional change to a regression contract requires its own Task Contract and reviewer approval.

## 15. Controller state machine

Canonical task lifecycle:

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

Governance/docs-only work may proceed directly from green CI to `ACCEPTANCE`; it MUST NOT trigger staging, live verification, or phone smoke solely because this state machine exists.

### 15.1 SELF_CHECK

Before review, implementer verifies:

```text
git diff
scope compliance
syntax
targeted tests
regression coverage
no secret exposure
no debug leftovers
no unrelated files
```

### 15.2 CI

Runtime/housing changes use the existing repository validation chain as applicable:

```text
Telegram-only isolation
-> syntax
-> targeted regression
-> full suite
-> stable baseline
-> statewide fuzz
-> 1104 municipality routing
-> forensic P0=0
-> control validation
-> QA validation
-> PR CI
```

This architecture does not replace those gates.

Governance/docs-only changes require at minimum repository isolation validation plus any documentation/policy checks introduced by the implementation plan; they do not manufacture runtime gates with no runtime impact.

### 15.3 STAGING

Staging is required only for a task whose accepted change can affect deployed runtime, deployment configuration, Telegram delivery behavior, or release infrastructure.

A governance/docs-only change skips staging after green required CI and proceeds to `ACCEPTANCE`.

When staging is required, Release Agent may trigger the existing guarded staging workflow but may not weaken the manual approval contract, reviewed-tree check, or production boundary.

### 15.4 ACCEPTANCE

Controller verifies:
- every acceptance criterion;
- regression evidence when applicable;
- staging result when applicable;
- no scope creep;
- no new side effect.

Failed acceptance returns the task to `IMPLEMENT`.

### 15.5 READY_FOR_MERGE

Required evidence:

```text
TASK_ID
OWNER
REVIEWER
BRANCH
COMMIT_SHA
PR
CI_STATUS
STAGING_STATUS: <PASS | NOT_REQUIRED>
KNOWN_RISKS
ROLLBACK_POINT
```

### 15.6 CONTROLLER_MERGE

Merge readiness requires:

```text
PR approved
CI green
staging green when required
no unresolved P0/P1 blocker
tree fingerprint verified when applicable
rollback point known
```

Agents cannot self-authorize this state.

### 15.7 LIVE_VERIFY

For release-impacting changes, after merge, live verification checks as applicable:
- bot identity;
- expected webhook URL;
- webhook-secret authentication;
- invalid-secret fail-closed behavior;
- delivery gate;
- current deployment version;
- Telegram API connectivity.

Governance/docs-only changes do not require live verification.

### 15.8 PHONE_SMOKE

Phone smoke is a distinct final gate for user-facing/runtime-impacting releases. Green CI and live verification do not imply release completion for such releases.

Baseline smoke matrix:

```text
/start
Trittau / Stormarn
Wentorf bei Hamburg / Herzogtum Lauenburg
Friedrichstadt / Nordfriesland
Itzehoe / Steinburg
Plön
Norderstedt / Segeberg
Eckernförde / Rendsburg-Eckernförde
Neumünster
Nortorf / Rendsburg-Eckernförde
Rendsburg alias/typo
radius search
whole-Kreis search
pagination
final notice
no-photo listing
/start recovery
no duplicated household prompt
```

Only after this gate passes may Controller mark a user-facing/runtime-impacting release `RELEASE_COMPLETE` / `100% READY`.

Governance/docs-only changes can complete after merge once their own acceptance contract is satisfied.

## 16. Failure state machine

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

Failures return to a named state rather than initiating ad-hoc edits.

## 17. Concurrency policy

Tasks may run in parallel only if they do not:
- modify the same files;
- depend on the same mutable state contract;
- change the same callback interface;
- change the same workflow;
- depend on the same unreleased implementation.

Otherwise Controller serializes them.

Parallel tasks still require independent review and merge ordering analysis.

## 18. Audit trail

Each task must retain enough evidence to reconstruct what happened after context loss:

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

The audit trail may be represented by PR metadata, task files, review packages, CI URLs, and Controller ledger entries. Secrets are never part of the audit trail.

## 19. Security and secrets

- Agents treat secret values as write-only/opaque whenever possible.
- No role may print a token, webhook secret, Cloudflare credential, or equivalent value into logs, PRs, comments, task files, screenshots, or chat.
- Presence checks are allowed; secret-value retrieval is not.
- Secret rotation is a dedicated security-sensitive task with explicit Controller authorization.
- Existing environment boundaries such as `telegram-registration` and `telegram-staging` remain authoritative.
- A migration between repositories does not imply secret migration.

## 20. Integration with existing repository policy

The current standalone repository remains authoritative.

Existing invariants remain unchanged:
- only Telegram-specific top-level paths are allowed;
- ordinary push to `main` validates but does not deploy;
- staging and live operations are guarded/manual;
- user-facing/runtime release completion requires the existing Telegram-only release chain through phone smoke.

Subagent governance is additive. It cannot weaken or supersede existing repository policy.

## 21. Implementation deliverables for v1

After this design is approved, implementation should create:

1. six role files under `ops/subagents/roles/`;
2. four contract/policy files under `ops/subagents/contracts/`;
3. reusable task/handoff/review templates under `ops/subagents/templates/`;
4. a concise `ops/subagents/README.md` explaining how this chat and Codex use the contracts;
5. validation that all files remain within allowed top-level repository paths;
6. no runtime, CI, staging, live-verification, production behavior, or reviewed-tree fingerprint changes in the first governance-only PR unless separately scoped and approved.

## 22. Acceptance criteria for Subagent Architecture v1

The v1 architecture is accepted when:

- all six roles are explicitly defined;
- autonomy level 2 permissions and prohibitions are unambiguous;
- task, handoff, review, and release contracts are documented;
- reviewer independence is enforced by policy;
- branch naming and file-scope rules are documented;
- failure and concurrency rules are documented;
- existing isolation and release gates remain unchanged;
- no secret value is introduced into repository content;
- initial implementation is governance-only and does not alter bot runtime, CI/deploy workflow behavior, or release fingerprints;
- Controller remains the only authority for merge readiness and final release status.

## 23. Future versions

Potential later additions, intentionally out of scope for v1:
- machine-readable task registry;
- automatic PR labels/status checks for agent roles;
- policy validation script for agent branch naming and scoped paths;
- Codex-native dispatcher integration;
- persistent SDD ledger integration;
- automatic review-package generation;
- metrics on agent task lead time and regression rate.

These require separate design and approval before implementation.
