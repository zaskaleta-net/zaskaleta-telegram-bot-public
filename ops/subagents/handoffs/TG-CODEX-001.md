# Handoff

TASK: TG-CODEX-001
STATUS: READY_FOR_REVIEW

## CHANGED
- `AGENTS.md`
- `ISOLATION_POLICY.md`
- `.github/workflows/standalone-telegram-ci.yml`
- `ops/subagents/README.md`
- `ops/subagents/codex/README.md`
- `ops/subagents/templates/dispatch.md`
- `ops/subagents/specs/2026-10-07-codex-native-execution-design.md`
- `ops/subagents/plans/2026-10-07-codex-native-execution.md`
- `ops/subagents/handoffs/TG-CODEX-001.md`

## WHY
- Observed cause: Subagent Architecture v1 existed as durable governance, but the repository had no Codex discovery entrypoint or Codex-specific isolated execution guide; the existing root isolation allowlist also rejected `AGENTS.md`.
- Fix rationale: add the smallest Codex-native bridge: one root `AGENTS.md`, a narrow allowlist exception for that file, a Codex execution guide, and a dispatch envelope while keeping existing v1 contracts authoritative.
- Independent Codex review later found a P1 `ISOLATION_BREACH`: the workflow regex used `AGENTS.md$`, where the unescaped dot also accepted near-miss names such as `AGENTSXmd`.
- The P1 fix keeps a permanent near-miss regression check and changes the allowlist to the literal filename match `AGENTS\.md$`.

## TESTS
- Pre-integration root allowlist rejected the new `AGENTS.md`: expected RED for the architecture addition.
- Approved root set with the architecture allowlist: PASS.
- Unknown-root sentinel check: PASS; unknown top-level paths remain rejected.
- GitHub compare `main...agent/release/TG-CODEX-001-codex-native-execution`: changed paths remain limited to the approved TG-CODEX-001 governance scope.
- No `telegram-info/src/**`, `telegram-info/test/**`, `telegram-control/**`, or `telegram-qa/**` changes are present.
- Independent Codex review on `bd1591373d2198ee11ba56df784316ed6eed437d` found P1 `ISOLATION_BREACH` for the unescaped dot in `AGENTS.md$`.
- RED regression commit `099abd4a9ece5dc92a770992844f776185661a1d`: CI #79 / run `37640409643` failed exactly at `Enforce Telegram-only root` with `ROOT_ALLOWLIST_NEAR_MISS_ACCEPTED` and `AGENTSXmd`.
- GREEN implementation commit `242182bb34c3cfb5a93e281c019a3c59abb55413`: allowlist uses `AGENTS\.md$`; the permanent `AGENTSXmd` near-miss regression remains in the workflow.
- GREEN CI #80 / run `37640524075`: PASS; all 14 workflow steps completed successfully, including root isolation, runtime syntax, full Telegram suite, stable baseline, statewide fuzz/runtime audit, municipality audit, forensic P0 gate, control validation, and QA dry-run.
- Current workflow diff versus `main` includes the narrow literal `AGENTS\.md$` admission plus the permanent near-miss regression guard; it is no longer the earlier 1-addition/1-deletion diff.
- Fresh independent Codex re-review is required on the post-fix tree before merge readiness.

## RISKS
- Root `AGENTS.md` relies on Codex honoring repository instruction discovery; repository governance remains authoritative and fail-closed if execution behavior differs.
- The only code-like workflow change is validation logic for root isolation; no deploy trigger, permission, runtime, secret, or production behavior is changed.
- Independent Security Reviewer approval remains mandatory before merge readiness.

## OUT_OF_SCOPE
- `telegram-info/src/**`
- `telegram-info/test/**`
- `telegram-control/**`
- `telegram-qa/**`
- production secrets or environment values
- Telegram runtime, webhook behavior, staging/production deployment behavior, and runtime release fingerprints

## COMMIT
Implementation state under re-review: `242182bb34c3cfb5a93e281c019a3c59abb55413`.

Review range: `main...HEAD`. This handoff refresh changes audit documentation only; no runtime or workflow implementation changed after `242182bb34c3cfb5a93e281c019a3c59abb55413`.

Do not include secret values, credentials, private Telegram identifiers, or sensitive payloads.
