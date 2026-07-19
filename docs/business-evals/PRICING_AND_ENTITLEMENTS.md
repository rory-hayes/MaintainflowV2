# Pricing and entitlements

Status: locked Business Evals contract, **18 July 2026**. Do not enable new Stripe prices until the rollout gates below are satisfied.

## Public plans

| Plan | Monthly | Projects | Journeys | Runs/month | Evidence retention | Seats | Delivery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Free | €0 | 1 | 1 | 35 | 7 days | 1 | Browser-only Lead form evidence |
| Solo | €49 | 3 | 5 | 750 | 30 days | 2 | Email, webhook, live link, PDF |
| Team | €149 | 15 | 30 | 7,500 | 90 days | 5 | Email, webhook, live link, PDF |
| Agency | €399 | 50 | 100 | 30,000 | 365 days | 15 | Paid delivery plus white label |

Trial signup and every email assertion require a paid entitlement or the active card-free Team trial. Free journeys remain browser-only and are labelled **Browser only**, never end-to-end.

Annual price is exactly 90% of twelve monthly payments:

| Plan | Annual total | Monthly equivalent |
| --- | ---: | ---: |
| Solo | €529.20 | €44.10 |
| Team | €1,609.20 | €134.10 |
| Agency | €4,309.20 | €359.10 |

Taxes are additional where applicable and the Stripe-hosted surface is authoritative for the charge the customer approves.

## Workspace trial

- Exactly one 14-day Team trial per workspace.
- No card and no Stripe subscription are required.
- The original trial expiry remains the auditable one-trial marker; it is not cleared and recreated.
- At expiry the effective entitlement becomes Free unless a paid or explicit complimentary entitlement applies.
- Buying Solo, Team, or Agency does not start or extend a second trial.
- A canceled/past-due subscription does not reactivate a stale workspace trial.

Stripe checkout does not create or restart a trial. The only Business Evals trial is the one card-free 14-day Team trial recorded on the workspace.

## Stable storage-ID mapping

The current database enum and Stripe metadata remain stable during the additive transition:

| Persisted ID | Business Evals public plan | Legacy plan before explicit migration |
| --- | --- | --- |
| `free` | Free | Free is not a paid grandfathered subscription |
| `starter` | Solo | Starter €99 and its purchased limits |
| `growth` | Team | Growth €199 and its purchased limits |
| `scale` | Agency | Scale €499 and its purchased limits |
| `agency_plus` | Not sold | Agency+ legacy contract |

`business_evals_v1` is the explicit entitlement contract version. An active paid or complimentary workspace without that version remains grandfathered. Storage ID alone must never silently change a customer's price or limits.

## Grandfathering and migration

- Existing subscriptions continue on their current Stripe Price and legacy entitlement.
- Do not bulk-update Stripe Prices, metadata, plan fields, limits, or renewal amounts.
- Show the customer the new plan, price, limits, retention, feature changes, and effective date before migration.
- Record explicit acceptance and update Stripe through a hosted, auditable path.
- Verify the signed webhook/current subscription, then record `business_evals_v1` idempotently.
- Snapshot the pre-migration entitlement and retain a reversible audit record.
- If a workspace exceeds the selected target plan, do not delete data. Require archive/export or a larger plan; block only new over-limit activity where safe.

## Entitlement precedence

1. Valid explicit complimentary entitlement with a reason.
2. Valid Stripe `trialing` or `active` subscription with customer/subscription linkage.
3. Active card-free workspace trial with no conflicting Stripe state.
4. Free.

Incomplete, expired, past-due, unpaid, paused, canceled, unlinked, or ambiguous paid state fails closed to Free. Existing paid access is grandfathered unless `business_evals_v1` is recorded.

## Pre-enable gates

- schema/API support for projects, journeys, runs, evidence retention, seats, and contract version
- one-workspace trial provisioning and non-resettable expiry
- run-quota and retention enforcement in service/database paths
- new Stripe monthly/annual products and verified price mapping
- checkout with no automatic second trial
- webhook and Customer Portal migration behavior
- public pricing and legal copy reconciled with the same code commit
- downgrade/overage/export behavior and customer notices
- tests plus live test-mode checkout, webhook, renewal/cancel, and rollback evidence

Until these gates pass, plan definitions and documentation are target contract, not proof that the prices are purchasable or deployed.
