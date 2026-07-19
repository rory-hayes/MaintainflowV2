# Core Loop

Maintain Flow must obsess over one evidence loop:

```txt
Workspace -> Project -> Journey -> Immutable version -> Eval run -> Stage assertions -> Verdict and evidence -> Incident -> Repair -> Passing verification rerun -> Report
```

This loop is the product. `SOURCE_OF_TRUTH.md` and `docs/business-evals/PRODUCT_CONTRACT.md` define the detailed contract.

## 1. Workspace

The tenant boundary. Membership, billing, projects, journeys, runs, incidents, evidence, alerts, and reports are workspace-scoped. The physical `agencies` table remains for compatibility, but customer-facing language is **Workspace**.

## 2. Project

A customer site, the team's own product, or a personal project. A project records its public HTTPS domain, owner, current health, report status, and the exact authorization attestation that permits testing. The physical `clients` table may remain during migration; the product label is **Project**.

## 3. Journey and immutable version

A journey represents a critical customer outcome. Launch templates are:

- Lead form
- Trial signup
- Legacy endpoint

Published configuration is immutable. Changes remain drafts until reviewed and published as a new version. AI may propose supported mappings, locators, impact copy, and diagnosis, but it cannot publish, schedule, change a verdict, or invent evidence.

## 4. Eval run and stage assertions

Every run executes the exact published journey version. Each stage stores deterministic assertions, timing, safe diagnostics, and private evidence.

Verdicts are:

- `passed`: every enabled stage and required cleanup passed
- `degraded`: the outcome worked but an approved timing threshold was exceeded
- `failed`: the target was reachable and a business assertion definitively failed
- `inconclusive`: access, CAPTCHA, ambiguity, runner failure, or missing evidence prevented a trustworthy result
- `cancelled`: the run was explicitly stopped
- `not_run`: a stage was not reached

No failed, inconclusive, ambiguous, or cleanup-broken run can become green. Maintain Flow never retries an uncertain side-effecting submission.

## 5. Incident, repair, and verification

A definitive failed or degraded business assertion opens or updates a deduplicated incident. Infrastructure and access problems remain inconclusive and do not create false customer failures.

Recording a repair note moves the incident into review; it does not resolve it. Resolution requires a newer passing rerun of the relevant journey version after the repair was recorded. A later recurrence reopens the deduplicated incident.

## 6. Report

A report is an immutable, project-scoped period snapshot generated from real journey and run data. It includes coverage, pass rate, incidents, verified recoveries, evidence provenance, limitations, and report-safe redacted images. Paid plans support email delivery, signed outbound webhooks, revocable live links, and PDFs; Agency also supports white labelling.

## Safety boundary

Only authorized public HTTPS destinations and approved form/action domains may run. Maintain Flow blocks private, loopback, link-local, metadata, rebinding, and denied destinations. It does not execute arbitrary scripts, bypass CAPTCHA or MFA, complete real purchases, upload files, access private CRMs, or provide generic browser automation. Trial signup scheduling requires proven cleanup, and cleanup failure pauses the journey.

## Definition of core-loop readiness

A new user can:

1. sign up and create a workspace
2. create and authorize a project
3. configure a Lead form or Trial signup journey in under ten minutes
4. scan and map only supported deterministic controls
5. publish an immutable version
6. complete and inspect a supervised run with stage evidence
7. enable a safe schedule only after all required gates pass
8. receive a deduplicated incident for a definitive failure
9. record a repair and prove recovery with a linked passing rerun
10. create, share, revoke, deliver, and download a truthful project report

Legacy endpoint journeys and their provenance must continue operating throughout migration and rollback.
