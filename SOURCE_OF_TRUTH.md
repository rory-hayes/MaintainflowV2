# Maintain Flow Source of Truth

Effective product and release contract: **19 July 2026**

Read this file before changing Maintain Flow. If another repository, branch, worktree, document, task, mockup, or deployment conflicts with this file and `origin/main` in the canonical V2 repository, it is not authoritative.

This contract defines the approved destination for the Business Evals refactor. It does **not** prove that every described capability, price, provider setting, or migration is deployed. Production claims still require exact-commit and live-provider evidence.

The public V2 release decision is explicit and superseding: `rory-hayes/MaintainflowV2` and Vercel `maintainflow-v2` replace the former repository and project as release targets. This changes the destination, not the historical record; legacy Git history, deployments, data, and evidence must remain intact unless the user separately approves an archival or deletion action.

## Canonical production line

| Item | Source of truth |
| --- | --- |
| GitHub repository | `https://github.com/rory-hayes/MaintainflowV2.git` |
| Production branch | `main` |
| Production domain | `https://www.maintainflow.io` |
| Apex domain | `https://maintainflow.io` |
| Vercel project | `maintainflow-v2` (`rorys-projects-accf0d71/maintainflow-v2`) |
| Legacy release history | `rory-hayes/maintainflow` and Vercel `maintainflow`; preserve, but never release V2 from them |
| Customer-facing name | **Maintain Flow** |
| Business Evals contract | `docs/business-evals/PRODUCT_CONTRACT.md` |
| Pricing and entitlements | `docs/business-evals/PRICING_AND_ENTITLEMENTS.md` |
| Migration and rollback | `docs/business-evals/LEGACY_MIGRATION.md` |
| Commercial operating ledger | [Maintain Flow GTM — SOURCE OF TRUTH](https://docs.google.com/spreadsheets/d/1sGKhnpDJC-6IPOFt4sc6p9PIEoF4Pq0dpt_eyWo9Htg/edit) |

Vercel production must deploy a commit on `origin/main` from `https://github.com/rory-hayes/MaintainflowV2.git` to `rorys-projects-accf0d71/maintainflow-v2`. A preview, localhost route, alternate Vercel URL, legacy repository, legacy Vercel project, or unmerged worktree is never V2 production.

The workbook above is the only editable GTM ledger. Its [read-only view](https://docs.google.com/spreadsheets/d/1iWXfV8sN900hML7aX-4IWooRLLwy5xX3G9XTQH8BRO8/edit) imports from it and is not a second source.

## Product decision

Maintain Flow is a **Business Evals platform** for teams that need repeatable evidence that customer-facing journeys still produce the intended business result.

The previous boundary saying Maintain Flow was “not a full evals platform” is explicitly superseded. The product remains deliberately narrow: it is not a general model-evaluation lab or trace warehouse. Its eval unit is an approved business journey, its truth comes from deterministic assertions, and its output is reviewable run evidence.

The launch wedge is browser-based form and signup journeys. A workspace contains projects; a project contains journeys; a journey contains versioned steps and assertions; a run produces a deterministic verdict and evidence.

```text
Workspace -> Project -> Journey -> Run -> Step result -> Assertion result -> Verdict -> Evidence -> Share/export
```

Existing public HTTPS GET monitors remain supported as **legacy endpoint journeys**. Their history is preserved; they are not silently deleted, rewritten, or presented as browser evidence.

## Verdict and AI contract

- Only versioned deterministic assertions produce `passed`, `degraded`, or `failed`.
- Runner, access, email, CAPTCHA, policy, and infrastructure problems produce `inconclusive`, never `failed`.
- Explicitly stopped runs are `cancelled`; unreached stages are `not_run` and never make a run green.
- AI may propose steps and assertions, explain evidence, cluster failures, and draft summaries.
- AI may not invent evidence, override an assertion, change a verdict, attest authorization, or claim that a customer system is healthy.
- Every shared result identifies the journey version, run time, assertion outcomes, evidence provenance, and any limitations.

## Safety and authorization contract

Before a journey can run, the workspace owner must attest that the workspace owns the target or has explicit permission to test it, and that the journey is safe and non-destructive. Maintain Flow must apply domain authorization, tenant checks, SSRF defenses, bounded queues, concurrency limits, timeouts, evidence redaction, and auditable service-issued runs.

The product does not bypass CAPTCHA, MFA, access controls, anti-bot systems, or rate limits. It does not complete real purchases, send uncontrolled production messages, mutate customer data, or test third-party domains without permission. CAPTCHA or required human approval makes the run inconclusive unless the customer provides an approved test-mode route.

## Plans

| Plan | Monthly price | Projects | Journeys | Runs/month | Evidence | Seats |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Free | €0 | 1 | 1 | 35 | 7 days | 1 |
| Solo | €49 | 3 | 5 | 750 | 30 days | 2 |
| Team | €149 | 15 | 30 | 7,500 | 90 days | 5 |
| Agency | €399 | 50 | 100 | 30,000 | 365 days | 15 |

Paid plans include email delivery, webhooks, live evidence links, and PDF exports. Agency also includes white labelling. Annual billing is exactly 10% below twelve monthly payments.

Each workspace is eligible for one card-free 14-day Team trial. It does not create a Stripe subscription or automatic charge. At expiry the workspace returns to Free unless it has an active paid or explicit complimentary entitlement. Buying a plan does not start a second trial.

The database and Stripe integration currently retain storage IDs for compatibility: `starter` maps to Solo, `growth` to Team, and `scale` to Agency. Existing paid subscriptions stay on the price, capacity, and feature contract they bought until an explicit migration is recorded. See `docs/business-evals/PRICING_AND_ENTITLEMENTS.md`.

## Production route contract

- `/` is the public landing page.
- `/sign-up` is the new-customer entry point.
- `/sign-in` is for existing customers.
- `/signup` and `/login` are legacy aliases.
- `/client-journey-assurance` and `/contact-sales` are historical aliases and must not become competing funnels.
- Authenticated Business Evals routes must use the canonical workspace, billing, evidence, and authorization boundaries rather than a parallel demo store.

## Legacy preservation

- Preserve the former `rory-hayes/maintainflow` repository, its branches and tags, and the prior `maintainflow` Vercel deployment history. Do not delete, rewrite, force-push, or reuse them as the V2 release destination.
- Do not detach the public domain from the currently serving project or delete rollback evidence until the exact V2 commit is verified on `maintainflow-v2` and the cutover step is explicitly approved.
- Preserve endpoint-journey data, service-issued provenance, issue history, report snapshots, and private PDFs.
- Preserve active legacy Stripe subscriptions and `agency_plus` until an explicit customer migration.
- Do not reinterpret `legacy_browser` evidence as service-issued evidence.
- Do not delete over-limit projects, journeys, runs, reports, or evidence during plan migration. Block new creation where required and offer export/archive paths.
- Rollback disables new Business Evals entry points and workers without destroying new or legacy data.

## Retired directions

The following must not drive new implementation or copy:

- the claim that Maintain Flow is not an evals platform
- endpoint-only monitoring as the permanent product boundary
- application or founder approval as a condition of self-serve access
- manually issued product access
- the former `rory-hayes/maintainflow` and Vercel `maintainflow` targets as the current release line; the approved V2 decision supersedes them
- any additional unapproved repository or parallel production product beyond the approved V2 line
- the TuesdayOps donor name as a customer-facing brand
- any claim that an unverified local build, Stripe configuration, or browser worker is live

Historical outreach and pilot artifacts may remain for audit, but must not be reused as current product or pricing instructions unless reconciled with this contract.

## Change-control rules

1. Confirm `origin` is exactly `https://github.com/rory-hayes/MaintainflowV2.git`, then start from current `origin/main`.
2. Keep product docs, entitlement tests, schema/API behavior, and customer copy consistent in the same reviewed rollout.
3. Use additive, reversible migrations; snapshot affected workspaces and subscriptions first.
4. Run tests, lint, type checking, build, runner security tests, and relevant browser/provider smoke checks before merge.
5. Follow the exact merged commit to Vercel `READY` and verify the public domain and configured workers/providers separately.
6. Roll out by workspace cohort with telemetry and a kill switch; do not bulk-migrate subscriptions automatically.
7. Record rollback evidence and preserve both new and legacy data.

## External-action guard

No agent may publish, comment, connect, react, or send a message on LinkedIn without the user's explicit permission for that exact action. Read-only inspection is allowed when requested. The same evidence discipline applies to billing and launch claims: documentation or code is not proof of deployment, subscription migration, active use, or revenue.
