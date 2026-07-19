# Maintain Flow V2 Documentation Index

This index covers the canonical public V2 repository only. Start here:

1. `SOURCE_OF_TRUTH.md` — canonical repository, branch, domain, product contract, and release rules.
2. `README.md` — product summary, self-serve journey, pricing, and scope boundaries.
3. `PRD.md` — customer, problem, behaviour, success metrics, and launch requirements.
4. `docs/business-evals/README.md` — Business Evals implementation and operations index.
5. `docs/business-evals/PRICING_AND_ENTITLEMENTS.md` — locked plans, annual totals, trial, grandfathering, and release gates.
6. `docs/business-evals/PRODUCTION_CONNECTION_RUNBOOK.md` — provider connection, canary, launch, rollback, and domain sequence.

## Product and platform

- `DATA_MODEL.md` — canonical entities, versioning, evidence, tenancy, and compatibility model.
- `ARCHITECTURE.md` — application, API, runner, email, storage, and workflow architecture.
- `docs/business-evals/PRODUCT_CONTRACT.md` — customer promise, supported templates, verdicts, and safety boundaries.
- `docs/business-evals/LEGACY_MIGRATION.md` — additive migration, compatibility, cutover, and rollback rules.

## Production and security

- `SECURITY.md` — authorization, SSRF, evidence, email, webhook, and operational controls.
- `DEPLOYMENT_RUNBOOK.md` — V2 release sequence and exact-commit verification boundary.
- `PRODUCTION_PROVIDER_CHECKLIST.md` — provider configuration and launch evidence checklist.
- `docs/business-evals/ACCEPTANCE_RUNBOOK.md` — product, migration, browser, and release acceptance procedure.
- `docs/business-evals/BROWSERBASE_EGRESS_SECURITY_SPEC.md` — runner egress requirements and acceptance evidence.
- `STRIPE_BILLING.md` — billing plans, trials, grandfathering, checkout, webhooks, and portal behavior.
- `VERCEL_DASHBOARD_ENV.md` — Vercel project and environment-variable contract.
- `ENV_EXAMPLE.md` — environment-variable names and safe placeholder values.
- `supabase/README.md` — database migration and verification instructions.

## Historical boundary

The former private `rory-hayes/maintainflow` repository remains the historical record for retired outreach, paid-pilot, implementation-report, QA-screenshot, and design-audit material. Those artifacts are deliberately excluded from the public V2 source snapshot and never override the files listed above.

Retired SQL under `supabase/archive/` is also excluded from V2 and must never be applied to the active product.
