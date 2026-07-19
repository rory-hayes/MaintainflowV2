# Maintain Flow PRD — Business Evals

## Product summary

Maintain Flow repeatedly runs approved customer-facing business journeys and produces deterministic verdicts with reviewable evidence. The first browser journeys cover form submission and signup flows; existing public endpoint checks continue as legacy endpoint journeys.

This PRD supersedes the former endpoint-only Client Journey Assurance scope and the statement that Maintain Flow is not a full evals platform. Maintain Flow is a Business Evals platform, but not a generic model benchmark, prompt playground, trace warehouse, or autonomous QA consultancy.

## Problem

Teams often know that infrastructure responded but not whether the customer completed the outcome the business depends on:

- a form can return success without creating or delivering the lead;
- signup can render while verification email, account activation, or first-login completion is broken;
- browser, API, email, and downstream behavior can drift independently;
- screenshots and manual spot checks are inconsistent and difficult to share;
- probabilistic summaries can make a failure look more certain than the evidence supports.

The customer needs a repeatable, outside-in eval with a deterministic verdict, evidence, and explicit limitations.

## Primary customer

Agencies, product teams, QA operators, and operations teams responsible for customer-facing forms, signup journeys, and automations across several projects.

The best-fit customer owns or is authorized to test the target domains, has recurring regression risk, and values asynchronous evidence more than a one-off manual audit.

## Core promise

> Prove the customer journey still reaches the intended business outcome.

## Product model

```text
Workspace -> Project -> Journey -> Version -> Run -> Evidence -> Share/export
```

- **Project:** one product, client, or approved domain set.
- **Journey:** a versioned browser or legacy endpoint procedure.
- **Step:** a navigation, input, click, wait, email lookup, or observation.
- **Assertion:** a deterministic condition over the resulting browser, email, or endpoint state.
- **Run:** one service-issued execution of one immutable journey version.
- **Verdict:** `passed`, `degraded`, `failed`, `inconclusive`, or `cancelled`; unreached stages are `not_run`.
- **Evidence:** redacted screenshots, timestamps, URLs, step/assertion results, email metadata, and runner provenance.

## Verdict rules

- `passed`: every enabled stage and required cleanup passed deterministically.
- `degraded`: the intended outcome worked, but an approved timing threshold was exceeded.
- `failed`: at least one required business assertion conclusively failed after the runner reached the assertion safely.
- `inconclusive`: the runner, authorization, access, email, CAPTCHA, policy, timeout, queue, or evidence path could not establish the outcome.
- `cancelled`: an authorized user or system control explicitly stopped the run.
- An unreached stage is `not_run` and can never make a run green.
- Warnings and optional assertions may qualify a result but cannot silently change the required-assertion contract.
- A retry is a separate attempt with its own evidence. It cannot overwrite the first attempt.

AI may suggest steps/assertions, generate human-readable labels, summarize evidence, and draft remediation ideas. AI output is advisory and visibly labelled. It never supplies the verdict, changes assertion results, invents missing evidence, or attests target authorization.

## First-value journey

1. Sign up and create one workspace.
2. Receive the one-time, card-free 14-day Team trial.
3. Create a project and add an approved domain.
4. Attest authority and safe-test conditions.
5. Choose a form or signup journey template.
6. Record steps and required deterministic assertions.
7. Run once, review the verdict and evidence, then schedule if safe.
8. Share or export evidence on a paid entitlement.

First useful evidence should be achievable in under ten minutes for a simple public form without CAPTCHA or privileged login.

## MVP requirements

- public landing, pricing, authentication, recovery, and one-workspace onboarding
- projects, memberships, seats, and approved-domain scope
- browser form and signup journey templates
- immutable journey versions and service-issued runs
- bounded queue, leases, concurrency, timeout, retry, cancellation, and terminal failure states
- domain authorization and per-journey customer attestation
- deterministic URL, visible text, element, validation, navigation, and email-arrival assertions
- unique test markers for safe email/result correlation
- CAPTCHA/MFA/human-approval detection that stops as inconclusive
- evidence redaction, retention, private storage, and authorized retrieval
- optional AI assistance that cannot alter verdicts
- schedule controls and run quotas
- paid email, webhook, live-link, and PDF delivery
- Agency-only white labelling
- Stripe-hosted payment management, one card-free workspace trial, and fail-closed entitlements
- preserved legacy endpoint journeys and evidence
- audit, security, and operational events sufficient to investigate every run and entitlement decision

## Pricing

| Plan | Price | Projects | Journeys | Runs/month | Evidence retention | Seats |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Free | €0/month | 1 | 1 | 35 | 7 days | 1 |
| Solo | €49/month | 3 | 5 | 750 | 30 days | 2 |
| Team | €149/month | 15 | 30 | 7,500 | 90 days | 5 |
| Agency | €399/month | 50 | 100 | 30,000 | 365 days | 15 |

Annual billing receives a 10% discount. Each workspace can use one card-free 14-day Team trial, then returns to Free. Paid plans include email, webhook, live-link, and PDF delivery; Agency also includes white labelling. Existing subscriptions are grandfathered until explicit migration.

Free supports one browser-only Lead form journey. Trial signup and email proof are paid capabilities and are also available during the active card-free Team trial.

## Activation and success metrics

Activation requires an authorized project, one saved journey version, one service-issued terminal run, and reviewed evidence. A draft, preview, locally fabricated record, or run without authorization does not count.

Measure:

- time from workspace creation to first terminal run;
- percentage reaching first deterministic verdict within ten minutes;
- scheduled journeys with at least two valid run periods;
- straight-through pass/fail rate versus inconclusive rate;
- assertion-level false-positive and false-negative reports;
- paid conversion after the Team trial;
- retained workspaces running journeys in consecutive months;
- delivery success for email, webhooks, live links, and PDFs.

Commercial proof requires paid subscriptions and retained use. Code completion, deployment, trials, page views, or generated evidence alone are not revenue proof.

## Safety boundaries and exclusions

- Customers may run only journeys they own or are explicitly authorized to test.
- No CAPTCHA, MFA, access-control, anti-bot, or rate-limit bypass.
- No real purchases, irreversible submissions, destructive actions, uncontrolled outbound messages, or autonomous production changes.
- No penetration testing, vulnerability certification, compliance certification, or guarantee that every defect will be found.
- No hidden AI verdicts or unsupported claims that a downstream system succeeded.
- No testing of unrelated third-party domains merely because a browser journey redirects there.
- Privileged authenticated journeys, payment journeys, arbitrary file uploads/downloads, and custom executable scripts are deferred until separately designed and approved.

## Legacy endpoint journeys

Existing credential-free public HTTPS GET monitors remain available as legacy endpoint journeys with their original service-issued provenance. Their data is not rewritten into browser steps, and browser evidence is never inferred from an endpoint response. Legacy subscriptions, prices, and limits remain intact until explicit customer migration. See `docs/business-evals/LEGACY_MIGRATION.md`.
