# Browserbase usage and commercial cost controls

## Decision

Every production Browserbase session is guarded by provider-derived usage before it is created and accounted from the terminal provider session after it ends. This applies to eval phases and read-only journey page scans. It does not change Maintain Flow's locked public prices, run quotas, or entitlements.

The production runner requires explicit internal ceilings:

- `BROWSERBASE_MONTHLY_BROWSER_MINUTES_LIMIT`
- `BROWSERBASE_MONTHLY_PROXY_BYTES_LIMIT`
- `BROWSERBASE_USAGE_WARNING_PERCENT` (50–95; recommended starting alert is 80)
- `BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS` (3–100; reviewed starting value is 12)
- `BROWSERBASE_SESSION_METERING_MAX_AGE_MINUTES` (15–1,440; reviewed starting value is 60)

No default financial ceiling exists. Missing, invalid, unavailable, conflicting, or over-limit metering fails closed before a new Browserbase session is created.

## Authoritative provider fields

Browserbase's official Project Usage API returns integer `browserMinutes` and `proxyBytes`. Its official Session API and pinned Node SDK 2.16.0 return `startedAt`, optional terminal `endedAt`, terminal status, project ID, and integer `proxyBytes`.

Maintain Flow records:

- exact terminal duration derived from provider `endedAt - startedAt`;
- the provider-returned session `proxyBytes` value;
- provider-returned project `browserMinutes` and `proxyBytes` totals sampled before session creation and during daily reconciliation.

Maintain Flow does not invent per-session billed minutes, estimate proxy bytes, or infer a green metering result when a session is not terminal. The workspace Billing screen labels the timestamp-derived aggregate as session active time for the current calendar month and explicitly says it is not Browserbase billed project minutes; project-level billed-minute control comes only from the Project Usage API.

Browserbase applies its billed-minute rules at project usage level, including a one-minute minimum. Summing raw session timestamp durations would therefore understate billable usage for short sessions, so Maintain Flow never presents that workspace allocation as a bill or spend figure.

The `proxyBytes` field is authoritative provider telemetry, but the public documentation does not establish whether traffic sent through a customer-supplied external proxy is billed under Browserbase proxy allowance. Confirm that commercial treatment in writing before using the byte ceiling as evidence of maximum payable proxy spend.

Primary references:

- [Browserbase usage tracking](https://docs.browserbase.com/optimizations/cost/measuring-usage)
- [Browserbase Project Usage API](https://docs.browserbase.com/reference/api/get-project-usage)
- [Browserbase Create Session API](https://docs.browserbase.com/reference/api/create-a-session)
- [Browserbase List Sessions API](https://docs.browserbase.com/reference/api/list-sessions)
- [Browserbase session metadata](https://docs.browserbase.com/platform/browser/core-features/session-metadata)
- [Browserbase proxy measurement](https://docs.browserbase.com/platform/identity/proxies)
- [Browserbase pricing](https://www.browserbase.com/pricing)

## Runtime sequence

1. Validate the reviewed project ID, both commercial ceilings, and the bounded metering-retry policy before any provider request.
2. Acquire the shared project-usage sampling lease used by request preflight and daily reconciliation. Only its current worker may call `projects.usage(projectId)` and persist that response; an expired or superseded worker is rejected, so two samples cannot land out of order and imitate a counter reset.
3. Persist the provider totals through a service-only database function and block before `sessions.create` when either ceiling is reached, the sample fails, a previous creation or terminal record is unresolved, a counter decreased, or another metering fault is open.
4. Create a tenant-bound, service-only creation intent with a random opaque correlation token. Then call `sessions.create` exactly once, with SDK retries disabled and only that token in `userMetadata.mf_intent`.
5. Immediately after Browserbase returns, register the provider session ID and its immutable purpose in the private metering ledger. This happens before the connection URL, Context, or browser is used. If registration fails or its response is ambiguous, request provider release, keep the project paused, and reconcile from the creation intent; do not replay `sessions.create`.
6. The registration starts in `active` state with a six-minute crash-recovery deadline. End or request release of the session, then transition it to `pending` under the request worker's short terminal-poll lease. The scheduler cannot claim either lease while the request owns it.
7. Poll the read-only Session API for a terminal record. When it arrives, persist the provider timestamps, active duration, status, and `proxyBytes` exactly once and resolve the ledger idempotently.
8. If Browserbase has not terminalized the record, release the request lease and let the every-minute scheduler claim at most four due retries with bounded backoff. A process crash after registration becomes scheduler-claimable after the active deadline.
9. If a create response is lost, query `sessions.list` with the exact opaque metadata token and require one exact same-project match. Zero matches remain bounded-retry pending, multiple matches are stopped and fail closed, and one match is registered, released if still live, and metered. A `prepared` intent whose worker died before `sessions.create` or before writing `uncertain` becomes claimable after 60 seconds—longer than the 30-second create timeout—so it cannot freeze the project forever.
10. Escalate only after the explicit reviewed attempt or age threshold. A service-role-only operator can reopen either a permanent terminal-metering fault or a permanent creation-reconciliation fault using an expected-attempt compare-and-set plus a required reason; the action is audited without storing the provider session ID or correlation token. Reopen is idempotent, and late provider evidence must still pass the normal deterministic recording path.

The every-minute eval scheduler first claims at most four uncertain session creations, then at most four due terminal-metering retries, then at most one daily project reconciliation. A successful daily sample stores an immutable project snapshot. An unavailable daily sample or unresolved creation/metering ledger pauses scheduled eval dispatch. Existing runner and scheduler kill switches remain the operator's immediate rollback controls.

This launch design intentionally serializes Browserbase session creation across the single shared Browserbase project: while one creation intent or active/pending session exists, another preflight fails closed. That reduces throughput but bounds unobserved cost to one five-minute session plus provider terminalization lag. Do not remove the serialization until usage reservation is atomic at a narrower scope and concurrent cost headroom is explicitly approved and canary-proven.

## Privacy and tenancy

Provider session IDs, project fingerprints, creation intents, and correlation tokens are private service data. Browser users cannot read or mutate cost-control, session-usage, creation-intent, or reconciliation tables. Browserbase receives only the random opaque `mf_intent` value—never a workspace, Project, run, user, URL, email, credential, or connection URL. The service-only recording function derives the workspace from the eval run or page-scan project and rejects a mismatched tenant. Billing receives only aggregate minutes, megabytes, session count, measured-through time, and a customer-safe status message.

## Required commercial headroom

The Project Usage API reports observed totals; it is not a prospective reservation API. The one serialized session already running can cross the configured ceiling before its terminal usage appears in the next sample. Production ceilings must therefore sit below the maximum payable amount by at least one full five-minute session plus the reviewed proxy-data allowance for that session. Accounting remains provider-derived; headroom is an operator-selected financial limit, not synthetic usage.

## Unresolved external release gate

The official Project Usage schema exposes totals but no billing-period ID, start, end, or reset timestamp. It is therefore unsafe to infer whether a lower total is a legitimate billing-cycle reset, a project change, or provider inconsistency. Maintain Flow treats any decreasing browser-minute or proxy-byte counter as a metering error and blocks new sessions.

Before public launch, obtain one of:

1. a documented Browserbase contract that identifies the Project Usage counter period and reset semantics; or
2. a reviewed, audited operator procedure that verifies the provider invoice/dashboard and explicitly re-baselines the control at each legitimate reset.

Until that gate is resolved and canary-proven, the implementation is fail-closed but not evidence that Browserbase billing is production-ready.
