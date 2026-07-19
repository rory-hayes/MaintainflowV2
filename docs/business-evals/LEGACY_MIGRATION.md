# Legacy migration and rollback

The migration must preserve customer access, evidence, and subscription terms while the endpoint-assurance product becomes Business Evals.

## Legacy concepts

| Legacy concept | Business Evals representation | Rule |
| --- | --- | --- |
| Agency workspace | Workspace | Preserve identity and memberships. |
| Client | Project | Additive reference; do not destroy the client record. |
| Workflow/check | Legacy endpoint journey | Preserve IDs, config, schedule, and service provenance. |
| Check run | Legacy endpoint run | Do not fabricate browser steps or change evidence origin. |
| Issue/resolution/rerun | Historical incident evidence | Preserve links and audit visibility. |
| Reliability Report/PDF | Legacy evidence artifact | Keep private authorization and snapshot/version semantics. |
| `legacy_browser` run | Untrusted historical record | Never promote to service-issued evidence. |

Endpoint journeys can coexist with browser journeys. A run counts under the applicable new run quota only after the workspace explicitly adopts `business_evals_v1`; grandfathered workspaces retain their purchased contract.

## Additive rollout

1. **Inventory:** snapshot workspaces, memberships, stored plans, Stripe linkage/status/Price, usage, reports, evidence, schedules, and over-limit conditions.
2. **Contract compatibility:** deploy stable-ID plan catalog and fail-closed entitlement resolution without changing subscriptions.
3. **Add schema:** add projects, journey versions, run attempts, attestations, evidence, quota/retention, and contract version with reversible migrations and tenant policies.
4. **Backfill references:** create project/legacy-journey links idempotently while retaining original records and IDs.
5. **Provision infrastructure:** queue, isolated browser workers, mail aliases, private evidence storage, retention jobs, monitoring, and kill switches.
6. **Internal canary:** run synthetic and explicitly authorized journeys; verify verdict, evidence, quota, retention, delivery, abuse, and rollback behavior.
7. **New-workspace cohort:** enable projects/browser journeys and the one card-free Team trial for a bounded cohort.
8. **General new workspaces:** expand only after inconclusive/error/support rates meet the release threshold.
9. **Legacy subscription offer:** present an explicit migration choice; never auto-migrate price or renewal.
10. **Retire compatibility:** remove old creation/UI paths only after exported evidence, customer notice, and rollback window.

## Subscription migration transaction

1. Re-read the current workspace and Stripe subscription.
2. Verify it still matches the inventory snapshot or require a fresh review.
3. Show and capture acceptance of the target plan and effective amount/date.
4. Use Stripe-hosted change/checkout; never trust a browser-supplied Price or plan ID.
5. Wait for a signature-verified, idempotent webhook and retrieve current subscription state if ambiguous.
6. Record the new Price mapping and `business_evals_v1` together with the prior snapshot/audit event.
7. Recompute entitlement and usage; do not delete over-limit records.
8. Send the customer an asynchronous confirmation and export path.

Failed or partial migration leaves the legacy contract effective until reconciliation proves the new subscription and contract version agree.

## Rollback triggers

- cross-tenant access or evidence exposure
- unauthorized domain execution or SSRF/navigation escape
- uncontrolled messages, destructive submissions, CAPTCHA bypass behavior, or target overload
- queue duplication, lease loss, runaway concurrency, or material quota miscount
- verdict/evidence mismatch or unacceptable false results
- retention deletion outside the intended scope
- incorrect Stripe amount, entitlement, trial, or legacy migration
- provider failure that cannot be isolated safely

## Rollback procedure

1. Disable new browser journey creation/scheduling with the server-side kill switch.
2. Stop new dispatch, then safely drain or cancel claimed/queued runs; mark unresolved attempts inconclusive.
3. Disable new live-link/email/webhook/PDF publication if evidence integrity is uncertain.
4. Restore the prior endpoint-assurance UI/API path without rewriting data.
5. Keep new tables/objects read-only and preserve audit/evidence for investigation.
6. Do not revert or cancel Stripe subscriptions automatically. Reconcile affected customers individually from the pre-migration snapshot.
7. Restore legacy entitlement when the new contract version and Stripe state cannot be proven consistent.
8. Verify tenant isolation, legacy endpoint execution, report access, billing, and public routes on the exact rollback commit.
9. Document affected workspaces, evidence, provider state, and customer communication before re-enabling.

Rollback is complete only when the old safe path is verified and no run, artifact, trial, or subscription is left in an ambiguous state.
