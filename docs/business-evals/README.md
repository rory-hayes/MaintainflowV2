# Business Evals documentation

This directory defines the approved Business Evals product contract and the reversible transition from the legacy endpoint-assurance product.

- [PRODUCT_CONTRACT.md](PRODUCT_CONTRACT.md): product vocabulary, deterministic verdicts, AI-assist boundary, evidence, attestation, and exclusions.
- [PRICING_AND_ENTITLEMENTS.md](PRICING_AND_ENTITLEMENTS.md): locked plans, features, trial, annual pricing, storage-ID compatibility, and grandfathering.
- [LEGACY_MIGRATION.md](LEGACY_MIGRATION.md): additive migration, rollout gates, customer subscription migration, and rollback.
- [PRODUCTION_CONNECTION_RUNBOOK.md](PRODUCTION_CONNECTION_RUNBOOK.md): exact Supabase, Browserbase, Resend, Stripe, Vercel, canary, and domain sequence.
- [BROWSERBASE_EGRESS_SECURITY_SPEC.md](BROWSERBASE_EGRESS_SECURITY_SPEC.md): fail-closed Browserbase egress decision, gateway contract, deployment route, and disconnected-session canaries.

`SOURCE_OF_TRUTH.md` remains the repository-level authority. These files define target behavior; they are not proof that schema, providers, browser workers, public copy, Stripe products, or migrations are live.
