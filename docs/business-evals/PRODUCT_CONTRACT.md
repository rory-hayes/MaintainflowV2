# Business Evals product contract

Status: approved target contract, **18 July 2026**. Deployment must be verified separately.

## Product unit

Maintain Flow evaluates an authorized business journey, not a model response in isolation.

```text
Workspace -> Project -> Journey -> Version -> Run -> Evidence -> Verdict
```

Initial browser templates cover:

- a public form that validates, submits synthetic data, and reaches a deterministic confirmation, with optional correlated email proof; and
- a signup journey that creates a marked test account, receives a correlated verification email, opens an allowlisted verification link, proves the expected account/workspace state, and always executes approved cleanup.

A lead journey without configured email proof is labelled **Browser only**. It is never represented as end-to-end coverage.

Existing public HTTPS GET checks continue as legacy endpoint journeys.

## Deterministic verdict contract

| Verdict | Required meaning |
| --- | --- |
| `passed` | Every enabled stage and every required cleanup action produced valid evidence and passed. |
| `degraded` | The business outcome worked, but an approved timing threshold was exceeded. |
| `failed` | The target was reachable and at least one required business assertion conclusively failed. |
| `inconclusive` | Authorization, runner, queue, access, email-provider, CAPTCHA, policy, timeout, or evidence conditions prevented a trustworthy business verdict. |
| `cancelled` | An authorized user or system control explicitly stopped the run. |

An unreached stage is recorded as `not_run`; `not_run` is stage evidence, not a green terminal run verdict.

The saved journey version contains the complete verdict contract. A user must explicitly accept changes to steps or assertions before a new version can run. Retries create new attempts; they do not erase prior results.

## AI-assist boundary

AI may:

- turn a user's goal into suggested supported steps/assertions;
- label or summarize redacted evidence;
- group similar failures and draft likely causes or repair notes; and
- draft a client-safe explanation with explicit limitations.

AI may not:

- set, change, or overrule a verdict or assertion result;
- create facts absent from service-issued evidence;
- attest domain ownership or permission;
- execute arbitrary customer code or browse beyond the approved journey;
- receive secrets or unredacted personal/payment data; or
- describe an inconclusive run as a customer failure.

## Evidence contract

A shareable run identifies the workspace/project, immutable journey version, start/end time, runner/evaluator version, attempt history, step outcomes, assertion outcomes, terminal verdict, redacted evidence, and limitations.

Screenshots and email data are evidence, not truth by themselves. Store the minimum necessary, redact before persistence, and build live links/PDFs from an immutable evidence snapshot. Never infer browser success from a legacy endpoint response.

## Authorization and attestation

The workspace owner must attest that:

- the workspace owns the target or has explicit permission to test it;
- listed domains/subdomains and redirects are within that permission;
- synthetic submissions and the configured frequency are safe;
- no real payment, destructive action, or uncontrolled message is expected; and
- the customer accepts responsibility for test data and cleanup.

Attestations are attributable, versioned, revocable, and rechecked before scheduling. The service may require technical domain verification or suspend a target when authority is unclear.

The Project detail surface shows the latest immutable attestation: primary domain, approved action domains, attestation version, actor identity, recorded time, and current or revoked state. Recording a replacement appends a new attestation and revokes the prior one; history is never overwritten.

## Journey lifecycle

Journey archive and restore are owner/admin actions. Archive retains the Journey, immutable versions, runs, incidents, reports, and evidence. It disables browser schedules and legacy endpoint checks, clears scheduler leases, and requests cancellation for queued or active evals so required cleanup can still finish without starting another customer-visible submission. Restore is quota-checked and blocked while the parent Project is archived. A restored Journey remains paused and unscheduled until an owner or administrator deliberately reviews and resumes it.

## CAPTCHA, authentication, and email

- CAPTCHA, MFA, anti-bot challenges, or unexpected privileged authentication stop as inconclusive. Maintain Flow does not bypass them.
- The initial product does not store customer login credentials or payment instruments.
- Email proof uses one of two explicit routes: an autoresponse to the opaque run-scoped address, or a destination-mailbox forwarding rule to an authenticated stable journey alias that is visible only to workspace owners/admins. Forwarded proof is accepted only when the message preserves the exact unique run marker submitted in the synthetic form data. Both modes publish a target threshold and a final maximum wait: arrival by the target passes, arrival after the target but by the maximum is degraded, and arrival after the maximum fails. Allowlisted verification links are encrypted at rest and inbound event rows are service-only. Receiving health is not an environment flag or operator assertion: it is a service-only observation written only after a signed Resend `email.received` webhook for the exact inbound domain successfully retrieves message content. If no correlated email arrives by the maximum, it may fail only when such an observation covers that final deadline within five minutes. Missing, stale, or unreadable health evidence makes the email stage `inconclusive`.
- Do not automatically execute attachments, load remote email content, or follow arbitrary email links.

## Explicit exclusions

- unauthorized targets or third-party scraping
- CAPTCHA/MFA/access-control bypass
- real purchases or payment verification
- destructive or irreversible production actions
- uncontrolled outbound email/SMS/messages
- vulnerability scanning or penetration testing
- compliance certification or a guarantee that every defect will be found
- arbitrary customer JavaScript, browser extensions, executable uploads, or unrestricted downloads
- autonomous repair or deployment

Privileged login, payment, file, and custom-script journeys require a separate product/security decision and are not implied by the platform label.
