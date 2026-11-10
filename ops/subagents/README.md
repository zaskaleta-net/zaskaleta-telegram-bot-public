# Telegram Subagent Operations

This directory is the governance layer for **Subagent Architecture v1**. It does not replace the Telegram runtime, GitHub Actions, Cloudflare deployment flow, or existing release gates.

## Operating model

- **Primary Controller:** this ChatGPT conversation.
- **Durable contracts:** this `ops/subagents/` directory.
- **Real subagent execution:** Codex or another environment that supports true isolated subagent dispatch.
- **Autonomy level:** 2 — agents may branch, commit, open PRs, run CI, and run approved guarded staging; they may not merge `main`, expose/rotate production secrets, weaken gates, or independently release production.

## Codex execution

- Root `AGENTS.md` is the Codex discovery entrypoint for this repository.
- Real isolated multi-agent execution is documented in `codex/README.md`.
- The existing role and contract files under `ops/subagents/` remain authoritative; the Codex guide does not expand their permissions.

## Operator sequence

1. Controller performs triage.
2. Copy `templates/task.yaml` and complete the Task Contract.
3. Assign one scoped owner role and an independent reviewer role.
4. Controller decides whether work is safe to run in parallel or must be serialized.
5. Implement only inside `allowed_paths`, then self-check.
6. Produce `templates/handoff.md` with actual evidence.
7. Independent reviewer completes `templates/review.md` and returns exactly `APPROVED`, `CHANGES_REQUIRED`, or `BLOCKED`.
8. Run required CI and impact-based staging.
9. Controller decides `READY_FOR_MERGE`; agents cannot self-authorize merge.
10. For release-impacting/user-facing work, run the existing live-verification and phone-smoke gates as applicable.
11. Record the audit trail and rollback point.

## Governance changes after bootstrap

The bootstrap branch that creates v1 predates the contracts it installs. After v1 is active, `controller` is not an implementation-owner value. Substantive changes under `ops/subagents/**` use a scoped Task Contract; the default route is Release Agent with explicit governance access and independent Security Reviewer approval. Controller coordinates and authorizes the task but does not self-review it.

## Canonical roles

- `roles/controller.md`
- `roles/runtime-agent.md`
- `roles/housing-agent.md`
- `roles/qa-agent.md`
- `roles/release-agent.md`
- `roles/security-reviewer.md`

## Normative contracts

- `contracts/TASK_CONTRACT.md`
- `contracts/HANDOFF_CONTRACT.md`
- `contracts/REVIEW_POLICY.md`
- `contracts/RELEASE_POLICY.md`

## Templates

- `templates/task.yaml`
- `templates/dispatch.md`
- `templates/handoff.md`
- `templates/review.md`

## Design and implementation plan

- `specs/2026-10-06-subagent-architecture-v1-design.md`
- `plans/2026-10-06-subagent-architecture-v1.md`
- `specs/2026-10-07-codex-native-execution-design.md`
- `plans/2026-10-07-codex-native-execution.md`

## Isolation and release invariants

Durable subagent governance remains under the already-allowed `ops/` root. Root `AGENTS.md` is the single discovery pointer explicitly admitted by `ISOLATION_POLICY.md`; it does not create a second governance hierarchy or authorize additional top-level paths. Existing standalone Telegram isolation remains authoritative. Normal pushes validate only; guarded staging/live actions remain manual. Governance/docs-only changes record staging/live/phone gates as `NOT_REQUIRED` only when they have no runtime, delivery, deployment, workflow, or release-fingerprint impact.

Secret values and sensitive Telegram/user data must never be placed in these files, task contracts, handoffs, reviews, PR text, logs, screenshots, or chat.
