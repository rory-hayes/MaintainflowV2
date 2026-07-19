import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Privacy Policy | Maintain Flow",
  description: "How Maintain Flow handles account, Business Evals journey, evidence, product-usage, and subscription data.",
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: "Privacy Policy | Maintain Flow",
    description: "How Maintain Flow handles account, Business Evals journey, evidence, product-usage, and subscription data.",
    url: "/privacy",
  },
}

const sections = [
  {
    title: "Information we collect",
    body: [
      "Account information such as name, email address, authentication provider, email-confirmation state, and workspace membership.",
      "Workspace records such as users, memberships, projects, approved domains, authorization attestations, journeys, journey versions, steps, assertions, schedules, run attempts, verdicts, delivery settings, and legacy endpoint-assurance records.",
      "Run evidence such as timestamps, safe URLs and origins, step and assertion results, redacted screenshots, runner/evaluator versions, error categories, and immutable delivery snapshots. We aim to collect the minimum evidence needed and do not store reusable browser profiles or unrestricted network archives by default.",
      "For an email-verification step, minimum run-correlated metadata such as the run-specific alias, sender, recipient, subject, timestamps, safe link properties, and a marker or digest. Maintain Flow does not connect to a customer's general mailbox for the initial Business Evals product.",
      "Legacy endpoint-journey data such as credential-free public HTTPS URLs, schedules, expected status and latency, structural assertions, status codes, and safe summaries. Legacy monitors do not store URL queries, custom headers, request bodies, or raw responses.",
      "Billing metadata from Stripe and Maintain Flow such as customer and subscription references, stored plan ID, public plan, billing interval, subscription status, workspace-trial end, contract version, migration state, payment-failure state, and signed-webhook event IDs and payload fingerprints used for idempotency. Raw Stripe webhook bodies are not retained. Maintain Flow does not store full card or bank-account numbers.",
      "Authenticated product events used to understand signup and activation, such as workspace, project, journey, first terminal run, trial, delivery, and paid-conversion milestones.",
      "On public pages, first-party acquisition events contain only an allowlisted page path, event type, fixed signup-CTA placement where relevant, and server timestamp. These records exclude query strings, referrers, cookies, visitor or session identifiers, IP addresses, user agents, form contents, and free-text metadata.",
      "Information you voluntarily send in an asynchronous support, billing, privacy, or security request.",
    ],
  },
  {
    title: "How we use information",
    body: [
      "To create workspaces and projects, run authorized Business Evals journeys, calculate deterministic assertion results and verdicts, retain evidence, and provide configured delivery or export.",
      "To authenticate users, confirm signup, protect tenant boundaries, enforce plan limits and evidence retention, and authorize private evidence, live-link, and PDF access.",
      "To open Stripe-hosted checkout and Customer Portal, distinguish the one card-free workspace trial from paid billing, reconcile subscription and contract-version state, preserve grandfathered subscriptions, and provide billing support.",
      "To deliver service and security messages, answer support requests asynchronously, investigate abuse, and operate product reliability.",
      "To understand aggregate acquisition and product activation without requiring applications, qualification calls, or cross-visit public tracking.",
      "To improve the product using aggregated operational patterns. We do not sell customer workspace data or use it for unrelated advertising.",
    ],
  },
  {
    title: "Data sharing",
    body: [
      "Supabase provides authentication, database, storage, and scheduled job infrastructure.",
      "Stripe provides hosted checkout, subscription billing, invoices, tax and payment processing, Customer Portal, and signed billing events.",
      "Vercel hosts the application and server-side API routes.",
      "Configured browser-worker, queue, storage, and email-verification providers may process approved target content and redacted run evidence only where those Business Evals capabilities are enabled.",
      "Our configured outbound email provider may process account confirmation, password recovery, security, evidence-delivery, or service emails. Recipient addresses are used only for the requested operational message.",
      "Where optional AI assistance is enabled, a configured AI provider may receive the minimum redacted context needed to suggest supported steps or draft an explanation. AI does not determine verdicts, and customer workspace data is not authorized for unrelated advertising or shared-model training.",
      "We may share information when required to comply with law, protect users or third parties, investigate abuse, or enforce service terms.",
    ],
  },
  {
    title: "Retention and deletion",
    body: [
      "Account, authorization, billing, and workspace records are retained while the account or workspace is active and as needed for security, disputes, tax, and audit obligations.",
      "Run evidence follows the effective plan: 7 days on Free, 30 days on Solo, 90 days on Team, and 365 days on Agency. Grandfathered subscriptions retain their existing contract until explicit migration. Evidence already subject to a legal or security hold may follow a separate documented period.",
      "Canceling a subscription does not automatically delete the account or workspace; the workspace returns to the applicable Free entitlement when paid access ends.",
      "Authorized workspace owners can request deletion of account, workspace, project, journey, run evidence, legacy endpoint record, live link, or stored PDF data by contacting sales@maintainflow.io. We verify control before deleting workspace-level records.",
      "Backups, provider logs, subscription and invoice records, fraud-prevention records, and security logs may persist for a limited period after deletion where required for infrastructure, tax, accounting, dispute, or legal obligations.",
      "Raw public acquisition events are deleted after 90 days. Aggregated counts may be retained longer without visitor or session identifiers.",
    ],
  },
  {
    title: "Security and access",
    body: [
      "Maintain Flow uses tenant-scoped database policies, server-side workspace checks, and isolated per-run browser contexts to separate customer records and execution state.",
      "Private evidence and PDFs are stored outside public buckets and retrieved through authorized application routes or short-lived scoped links.",
      "Billing-entitlement fields are server-controlled, and database limits apply even when requests do not originate from the normal product interface.",
      "Browser and endpoint journeys require target authorization and URL/network safety controls intended to reduce SSRF, cross-domain escape, and abuse risk before requests run.",
    ],
  },
  {
    title: "Your choices and data rights",
    body: [
      "Workspace owners can request access, correction, export, or deletion of personal data associated with their account or workspace.",
      "Where privacy laws such as GDPR apply, we handle requests according to the rights available in the relevant jurisdiction.",
      "Customers are responsible for having permission to test target domains and enter project, journey, recipient, test, and evidence information. They should use synthetic data and the minimum personal data necessary.",
    ],
  },
  {
    title: "Data controller and processor roles",
    body: [
      "For project, journey, test-submission, recipient, and evidence records entered by a customer workspace, the workspace owner generally decides what data is entered and why.",
      "Maintain Flow processes workspace data to provide authentication, Business Evals execution, evidence, delivery, storage, billing, security, and support.",
      "Privacy, legal, support, access, export, correction, and deletion requests can be sent using the contact address below. No meeting is required to exercise a data right.",
    ],
  },
]

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-12 px-6 pb-20 pt-32 md:px-10">
      <header className="space-y-4">
        <p className="text-sm font-medium text-primary">Maintain Flow Privacy Policy</p>
        <h1 className="text-4xl font-medium tracking-tight md:text-5xl">Privacy Policy</h1>
        <p className="max-w-2xl text-base leading-7 text-muted-foreground">
          Last updated: July 18, 2026. This policy explains how Maintain Flow handles data for self-serve accounts,
          Business Evals workspaces, journey runs, evidence, product usage, legacy endpoint journeys, and subscriptions.
        </p>
      </header>

      <div className="space-y-10">
        {sections.map((section) => (
          <section key={section.title} className="border-t pt-8">
            <h2 className="text-xl font-medium tracking-tight">{section.title}</h2>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
              {section.body.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <section className="border-t pt-8">
        <h2 className="text-xl font-medium tracking-tight">Contact</h2>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          Privacy, legal, support, access, export, correction, or deletion requests can be sent asynchronously to{" "}
          <a className="text-foreground underline underline-offset-4" href="mailto:sales@maintainflow.io">
            sales@maintainflow.io
          </a>
          .
        </p>
      </section>
    </main>
  )
}
