# AGENTS.md

These instructions guide Codex and any coding agents working in this repo.

## Role

You are building Maintain Flow, a horizontal Business Evals SaaS for agencies, SaaS teams, and independent builders that need deterministic proof that critical customer journeys still produce the intended business outcome.

Act like a senior product engineer. Build carefully, avoid scope drift, add tests, and preserve the UI template.

## Source of truth and release discipline

Read `SOURCE_OF_TRUTH.md` before taking action. The canonical V2 code line is `https://github.com/rory-hayes/MaintainflowV2.git` on `main`; the Vercel project is `maintainflow-v2`, and the production domain is `https://www.maintainflow.io`.

- Confirm `origin` is exactly `https://github.com/rory-hayes/MaintainflowV2.git`, then start from current `origin/main`.
- Use one short-lived delivery branch at a time.
- The approved V2 repository and Vercel project explicitly supersede the former `rory-hayes/maintainflow` / `maintainflow` release targets. Do not create another repository, competing product funnel, parallel production branch, or new rebuild without explicit approval.
- Preserve the legacy repository, branches, tags, deployments, and release evidence as history. Never delete, rewrite, force-push, or present a legacy artifact as V2 production.
- A localhost route, preview deployment, alternate Vercel URL, or unmerged worktree is not production.
- After a verified merge and deployment, remove the delivery branch and worktree.
- Never publish, comment, connect, react, or send a LinkedIn message without the user's explicit permission for that exact action.

## Critical product loop

The app is only correct if this loop works end-to-end:

```txt
Workspace -> Project -> Journey -> Immutable version -> Eval run -> Stage assertions -> Verdict and evidence -> Incident -> Repair -> Passing verification rerun -> Report
```

Everything must support this loop. Existing endpoint monitors remain available as labelled legacy endpoint journeys; their data and evidence provenance must not be reinterpreted as browser eval evidence.

## Customer-facing name

Use **Maintain Flow** in all customer-facing UI and copy.

TuesdayOps is a historical donor-repository name only. Do not use it for new code, branches, tasks, files, product copy, or deployments.

## Hard scope boundaries

Do not build:

- CRM
- invoicing
- time tracking
- project management
- generic client portal
- workflow builder
- native n8n/Make/Zapier OAuth integrations
- general-purpose browser automation or arbitrary scripts
- model-evaluation lab, trace warehouse, or model gateway
- payments/checkouts, file uploads, CAPTCHA bypassing, or private CRM access in launch journeys
- unsupported journey templates beyond Lead form, Trial signup, and labelled Legacy endpoint journeys
- trace explorer
- marketplace
- enterprise SSO
- custom domains
- complex permissions beyond owner/admin/member unless requested

## UI template preservation rules

This repo starts from a ShadCN/Tailwind template. The template is the design source of truth.

Before implementing any UI:

1. Inspect existing routes, layouts, components, and styles.
2. Identify which template pattern should be reused.
3. Compose existing components first.
4. Only create a new component if the template cannot support the need.
5. Document any design-system changes.

Do not:

- reinitialize ShadCN
- replace `components/ui` wholesale
- overwrite the theme
- replace `globals.css` unless absolutely necessary
- replace `tailwind.config` unless absolutely necessary
- introduce a competing design system
- copy old UI from the previous repo
- add random gradients/neon/AI-slop visuals
- create duplicate components when template components exist

The template owns the UI. Maintain Flow owns the product logic.

## Engineering rules

- Prefer TypeScript strictness.
- Keep server-side tenant checks even if RLS exists.
- Add tests for business logic.
- Never commit secrets.
- Never log raw auth headers, tokens, API keys, or private payloads.
- Never assume placeholder/demo data is real functionality.
- Update docs when changing product behaviour.
- Run lint, typecheck, tests, and build before declaring done.

## Security rules

Endpoint monitoring is an SSRF surface.

All outgoing workflow check requests must block:

- localhost
- 127.0.0.1
- private IP ranges
- link-local IPs
- cloud metadata IPs such as 169.254.169.254
- non-http(s) protocols
- redirects to blocked destinations
- oversized responses
- slow requests beyond timeout

Secrets must be encrypted or securely stored, masked after save, and redacted from logs/reports.

## Reporting rules

Reports are the money feature.

Reports must use real selected-client, selected-period, report-included workflow data. Do not use dashboard-capped metrics, global agency metrics, or fake data unless clearly labelled as demo data.

## Definition of done

A feature is done only when:

- the relevant user flow works end-to-end
- loading/error/success states exist
- validation errors are clear
- tenant isolation is enforced
- tests are added or updated
- docs/changelog are updated
- lint/typecheck/tests/build pass or failures are documented
