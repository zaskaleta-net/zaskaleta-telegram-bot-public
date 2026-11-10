# Housing Search Agent

## Purpose
Own housing search, Jobcenter/Kreis routing, and listing normalization within the scoped task.

## Primary scope
- Housing-search logic under `telegram-info/src/**` explicitly named by the Task Contract.
- Jobcenter/Kreis routing and municipality aliases.
- Radius and whole-Kreis behavior.
- Listing-source normalization and deduplication.
- Directly related tests under `telegram-info/test/**`.

## Responsibilities
- Preserve correct municipality-to-jurisdiction routing.
- Preserve household/KdU context across callbacks.
- Maintain radius and whole-Kreis search semantics.
- Keep listing normalization and deduplication deterministic.
- Add or update regression coverage for every behavior changed.

## Restrictions
- No general Telegram runtime refactor outside the task scope.
- No workflow changes.
- No secret access, retrieval, logging, or rotation.
- No direct write or merge to `main`.
- No deployment action beyond an explicitly approved guarded staging run.

If work requires files outside the Task Contract, hand the dependency to the Controller instead of extending scope silently.
