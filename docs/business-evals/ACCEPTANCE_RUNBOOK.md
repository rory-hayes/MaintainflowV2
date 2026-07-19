# Business Evals acceptance runbook

This runbook separates repository acceptance from production-provider proof. A green local build does not enable a rollout flag or prove a live canary.

## Repository gates

Run the unit, contract, schema, migration, type, lint and production-build gates. Then run the dedicated browser suite:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:business-evals:database
pnpm test:business-evals:e2e
```

The disposable-PostgreSQL acceptance command builds the legacy schema, seeds two tenants plus a resolved issue and legacy endpoint schedule, and applies the additive migration twice. It proves row-count and evidence preservation, continued legacy claiming, cross-tenant denial, authenticated write revocation, Journey archive/restore safety, both exact launch-template publishes, supervised scheduling, deterministic failure and verified recovery, report snapshots, revocable share links, destructive-mutation replay safety, hard quota enforcement, and API/database publish-contract parity. The parity checks reject string-valued numeric fields, mixed cleanup modes, select-only submissions, invalid cleanup-stage layouts, unknown fields, malformed or oversized URLs, and stale draft metadata. The command drops its temporary database even when an assertion fails.

The browser suite uses the feature-flagged preview at 1487×1058, 1024×768 and 390×844. It checks both launch builders, the Option 2 Journey evidence interaction, debug-trigger truth, rich report rendering, route rendering, mobile menu, keyboard focus, snap scrolling, horizontal overflow and serious/critical accessibility violations.

## Controlled runner fixtures

Fixture routes are available automatically outside production and return 404 in production unless `BUSINESS_EVALS_FIXTURES_ENABLED=true` is explicitly set. Keep that flag off except during a bounded canary window.

| Scenario | Route | Expected truth |
| --- | --- | --- |
| Healthy Lead | `/business-evals-fixtures/healthy-lead` | Browser assertion and marked autoresponse pass |
| Failed Lead | `/business-evals-fixtures/failed-lead` | Reachable target returns a definitive failed business assertion |
| Delayed email | `/business-evals-fixtures/delayed-email` | Email arrives after the target threshold but before maximum wait, so the run degrades |
| CAPTCHA | `/business-evals-fixtures/captcha-blocked` | Scan/run is inconclusive and scheduling is blocked |
| Missing email | `/business-evals-fixtures/missing-email` | Browser outcome passes; email absence is failed only with independently healthy receiving evidence, otherwise inconclusive |
| Malicious link | `/business-evals-fixtures/malicious-link` | Email is received but its non-allowlisted link is never opened |
| Healthy Trial | `/business-evals-fixtures/healthy-trial` | Signup, email, verification, workspace state and cleanup pass |
| Cleanup failure | `/business-evals-fixtures/cleanup-failure` | Cleanup fails, the run cannot be green and the journey pauses |

Fixture submissions accept only an exact `MF-EVAL-...` marker and an address on `EVAL_INBOUND_DOMAIN`. They cannot be used as a general-purpose mail sender. Verification tokens are signed, expire after 15 minutes and contain no credential.

## Production-only gates

Before internal rollout, record direct evidence for:

- production Supabase migration, RLS denial, private artifact storage and retention;
- exact Stripe prices, webhook signatures, Portal and grandfathered subscriptions;
- verified Resend inbound DNS/webhook, content retrieval and receiving-health canary;
- Browserbase plus the external policy-enforcing egress proxy, including redirect, rebinding, private-IP, metadata and WebSocket denial;
- healthy Lead and Trial fixtures, malicious-link and cleanup-failure fixtures;
- a repair note followed by a newer passing verification run;
- revocable live link and report-safe PDF;
- every plan quota and cross-tenant denial;
- the first compatible Lead journey completed within ten minutes;
- internal, selected-workspace and global cohort controls; and
- seven consecutive days of stable scheduled canaries.

Turn `BUSINESS_EVALS_FIXTURES_ENABLED` back off after the canary window. Do not enable the global authenticated UI or point production DNS at this release until all provider and billing smoke gates are recorded.
