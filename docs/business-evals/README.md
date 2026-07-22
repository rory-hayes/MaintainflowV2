# Business Evals documentation

This directory defines the approved Business Evals product contract and the reversible transition from the legacy endpoint-assurance product.

- [PRODUCT_CONTRACT.md](PRODUCT_CONTRACT.md): product vocabulary, deterministic verdicts, AI-assist boundary, evidence, attestation, and exclusions.
- [PRICING_AND_ENTITLEMENTS.md](PRICING_AND_ENTITLEMENTS.md): locked plans, features, trial, annual pricing, storage-ID compatibility, and grandfathering.
- [LEGACY_MIGRATION.md](LEGACY_MIGRATION.md): additive migration, rollout gates, customer subscription migration, and rollback.
- [PRODUCTION_CONNECTION_RUNBOOK.md](PRODUCTION_CONNECTION_RUNBOOK.md): exact Supabase, Browserbase, Resend, Stripe, Vercel, canary, and domain sequence.
- [LEGAL_RELEASE_INPUTS.md](LEGAL_RELEASE_INPUTS.md): operator facts, privacy decisions, professional review, and public-checkout release block.
- [BROWSERBASE_EGRESS_SECURITY_SPEC.md](BROWSERBASE_EGRESS_SECURITY_SPEC.md): fail-closed Browserbase egress decision, gateway contract, deployment route, and Context-handoff canaries.
- [BROWSERBASE_USAGE_COST_CONTROLS.md](BROWSERBASE_USAGE_COST_CONTROLS.md): provider-derived browser-minute/proxy-byte accounting, pre-session ceilings, daily reconciliation, and the unresolved provider billing-period contract gate.
- [BROWSER_EGRESS_PROXY_IMPLEMENTATION_CONTRACT.md](BROWSER_EGRESS_PROXY_IMPLEMENTATION_CONTRACT.md): two-service gateway implementation, deployment topology, CI, and canary evidence contract.
- [BROWSER_EGRESS_CONTAINER_VULNERABILITY_POLICY.md](BROWSER_EGRESS_CONTAINER_VULNERABILITY_POLICY.md): complete container scan evidence and the fixable high/critical release gate.
- [BROWSER_EGRESS_CONTAINER_RESIDUAL_RISK.md](BROWSER_EGRESS_CONTAINER_RESIDUAL_RISK.md): dated reachability review for the currently unfixed Debian findings; exact-release CI evidence is still required.

`SOURCE_OF_TRUTH.md` remains the repository-level authority. These files define target behavior; they are not proof that schema, providers, browser workers, public copy, Stripe products, or migrations are live.
