# Maintain Flow

Maintain Flow is a Business Evals platform that continuously proves critical customer journeys still work—from the first page to the final business outcome.

The first browser journeys cover form submission and signup flows. Existing credential-free public HTTPS GET monitors remain available as legacy endpoint journeys with their original evidence provenance.

The canonical repository, production line, product decision, pricing contract, and change-control rules are in [SOURCE_OF_TRUTH.md](SOURCE_OF_TRUTH.md). Read it before starting work. Detailed Business Evals documents are indexed in [docs/business-evals/README.md](docs/business-evals/README.md).

## Customer-facing name

Use **Maintain Flow** in product UI, landing pages, emails, live links, and reports. **TuesdayOps** is a historical donor-repository name only.

## Core promise

> Prove the customer journey still reaches the intended business outcome.

## Product loop

```text
Workspace -> Project -> Journey -> Run -> Step/assertion evidence -> Verdict -> Share/export
```

Run verdicts are deterministic:

- `passed` means every enabled stage and required cleanup passed;
- `degraded` means the outcome worked but exceeded an approved timing threshold;
- `failed` means the target was reachable and a required business assertion conclusively failed;
- `inconclusive` means the runner, authorization, access, email, CAPTCHA, policy, queue, or evidence path could not establish the result; and
- `cancelled` means the run was explicitly stopped.

Unreached stages are `not_run` and can never make a run green.

AI may suggest supported steps/assertions and explain redacted evidence. It cannot set or override a verdict, invent evidence, or attest customer authorization.

## Plans

| Plan | Monthly | Projects | Journeys | Runs/month | Evidence | Seats |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Free | €0 | 1 | 1 | 35 | 7 days | 1 |
| Solo | €49 | 3 | 5 | 750 | 30 days | 2 |
| Team | €149 | 15 | 30 | 7,500 | 90 days | 5 |
| Agency | €399 | 50 | 100 | 30,000 | 365 days | 15 |

Paid plans include email delivery, webhooks, live evidence links, and PDFs. Agency also includes white labelling. Annual billing receives a 10% discount.

Free is browser-only and supports the Lead form template without email proof. Trial signup and any email assertion require Solo, Team, Agency, or the active card-free Team trial.

Each workspace receives one card-free 14-day Team trial, then returns to Free unless a paid or explicit complimentary entitlement applies. Purchasing a subscription does not start another trial.

The persisted IDs remain `free`, `starter`, `growth`, `scale`, and `agency_plus` during migration. New-contract labels map `starter -> Solo`, `growth -> Team`, and `scale -> Agency`. Existing paid subscriptions remain on their legacy price and limits until explicitly migrated.

## Safety contract

Customers may run only journeys they own or are authorized to test, after recording an attestation. Maintain Flow must isolate browser runs, restrict targets and concurrency, redact evidence, and stop on CAPTCHA, MFA, payment controls, destructive confirmation, or unauthorized domain changes. It does not bypass controls, complete real purchases, send uncontrolled production messages, or make autonomous production changes.

## Repository status

This branch contains the additive Business Evals domain, APIs, runner orchestration, evidence controls, billing/reporting integration, compatibility migration, and feature-flagged product surfaces alongside the existing endpoint-assurance product. Local code and passing checks do not prove that provider configuration, new Stripe prices, subscription migrations, or the public product are deployed. Follow the [production connection runbook](docs/business-evals/PRODUCTION_CONNECTION_RUNBOOK.md) for the canary-to-domain sequence and [legacy migration guide](docs/business-evals/LEGACY_MIGRATION.md) for staged data rollout and rollback.

## Build philosophy

Build one safe, deterministic business journey end to end before adding breadth. Keep the control plane, runner, evidence, billing, and public copy on the same reviewed contract. Preserve legacy data and subscriptions, fail closed on authorization and entitlement ambiguity, and verify the exact deployed commit before making production claims.

## License

Copyright © 2026 Maintain Flow. All rights reserved. The public repository is source-available for transparency and evaluation; see [LICENSE](LICENSE).
