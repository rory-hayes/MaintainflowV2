# Legal release inputs

Status: **blocking external input and professional review required before public checkout or domain cutover**

The current Terms and Privacy Policy describe the product, plans, deterministic-verdict boundary, providers, evidence, billing, safety rules, and retention behavior. They are not a complete launch contract until the operator supplies the facts below and a qualified adviser confirms the resulting documents for the intended markets. This checklist is release control, not legal advice.

## Operator facts that must be supplied

- Full contracting legal name and any registered trading name.
- Legal form, country of establishment, company or business-registration number where applicable.
- Registered or principal postal address and a legal-notice address.
- Dedicated legal/privacy contact email; confirm whether `sales@maintainflow.io` remains appropriate.
- Confirm whether Maintain Flow is strictly for business/professional customers. If consumers may buy, the checkout, cancellation, refund, conformity, information, and unfair-term flow needs a separate consumer-law review.
- Governing law and courts or another approved dispute process.
- VAT/tax registration and invoice information where applicable.

## Terms decisions for counsel

- Operator identity and contract formation, including who may accept for a workspace.
- Service licence, Maintain Flow intellectual property, customer ownership of submitted material, feedback, and permissions needed to process customer data.
- Suspension, restriction, notice, termination, export, and post-termination deletion rules.
- Service standard, support boundary, maintenance, provider dependencies, force majeure, and change notice.
- Warranty disclaimers that remain fair and enforceable in the chosen market.
- Liability exclusions and cap, including treatment of data loss, business interruption, indirect loss, confidentiality, security, infringement, fraud, wilful misconduct, death/personal injury, and liabilities that cannot legally be limited.
- Customer indemnity, if any, for unauthorized targets, unlawful content, or misuse.
- Governing law, venue, dispute escalation, notices, assignment, waiver, severability, survival, entire agreement, and order of precedence.
- Refund and cancellation wording reconciled with the actual Stripe checkout and target-customer classification.

## Privacy facts and decisions

- Identity and contact details of the controller and any representative or data-protection officer.
- A purpose-by-purpose Article 6 legal-basis map for account, contract, billing, security, abuse prevention, product analytics, support, and marketing activity; document any legitimate-interest assessment.
- Processor/controller role for customer journey, synthetic submission, recipient, evidence, and shared-report data; prepare a Data Processing Addendum if Maintain Flow acts as processor.
- Current subprocessors, processing locations, retention, deletion, incident support, and contract links for Supabase, Vercel, Stripe, Browserbase, Resend, OpenAI, and Sentry.
- Any international transfers, applicable adequacy decisions or Article 46 safeguards, and how a person can obtain information about those safeguards.
- Exact retention or decision criteria for account, billing/tax, audit, security, support, backups, provider diagnostics, and deleted-workspace data beyond plan evidence retention.
- Rights-request verification and response process, objection/withdrawal handling where relevant, and the correct supervisory-authority complaint route.
- Cookie/storage inventory and consent decision. The current public analytics contract excludes cross-visit identifiers; hosted auth, billing, and future provider changes must be rechecked before launch.

GDPR Article 13 requires, among other items, controller identity/contact details, purposes and legal bases, legitimate interests where used, transfer information, retention criteria, data-subject rights, and the right to complain to a supervisory authority: <https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679>. Irish CCPC guidance also highlights business identity/address, pricing/payment, cancellation, contract transparency, and fair terms for online services when consumers are in scope: <https://www.ccpc.ie/information-for-businesses/selling-goods-and-services/selling-digital-content-or-services>.

## Product and release evidence

- The signup or checkout flow presents accessible Terms and Privacy links before acceptance and records the accepted document versions.
- Stripe checkout shows the exact plan, interval, currency, amount, tax treatment, renewal, and cancellation route.
- Support, privacy, security, and legal inboxes are monitored and have an asynchronous response process.
- The final Terms, Privacy Policy, DPA, subprocessor list, security page, checkout copy, and provider contracts agree with the live system.
- The exact reviewed legal documents are saved with the release commit and their effective date is not in the future.

### Implemented acceptance control (still subject to the review above)

- The current code versions both documents as `2026-07-19`. The signup and Google controls start unchecked and require an explicit user action.
- Email signup sends the exact versions in Supabase auth metadata. An additive `auth.users` trigger writes the acceptance using server time, rejects new email-provider users without exact metadata, and deliberately does not backfill existing users. New self-serve email users also receive a private pending-activation marker: workspace membership and every protected API remain fail-closed until the verified confirmation callback activates that exact user, then revokes the temporary provider session before showing token-free success.
- Google OAuth stores a 20-minute, tab-scoped pending acceptance with a one-use idempotency key. After authentication, the callback records it through `/api/legal/acceptance`; no application session is stored if the record cannot be confirmed. A Google-created user cannot receive a workspace membership until the current acceptance exists.
- A genuine Supabase team invitation may reserve its intended workspace membership before activation, using GoTrue's trusted `invited_at` column rather than caller-controlled metadata. The invitation/password-reset screen starts unchecked and records exact current acceptance before it changes the password or stores an application session. A pending invitation is never represented as accepted.
- `public.legal_acceptances` has RLS enabled. Browser roles receive no table access; the service role has read access and can write only through the exact-version, idempotent `record_current_legal_acceptance(...)` RPC. Raw idempotency keys are not stored.
- Acceptance rows currently follow auth-user deletion through `on delete cascade`. Counsel must confirm whether any jurisdiction-specific defence, tax, or contract-retention requirement instead needs a documented pseudonymized retention period before launch.
- If professional review changes either document, update the rendered document, its TypeScript version constant, both SQL definitions, tests, and release notes together. Never silently treat an older or missing row as acceptance of a newer document.

Do not replace missing facts with placeholders or infer them from a domain, currency, time zone, or the founder's location. Public billing and DNS cutover remain blocked until every applicable item is resolved.
