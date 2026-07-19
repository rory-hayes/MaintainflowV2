import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Terms of Service | Maintain Flow",
  description: "Terms for self-serve Maintain Flow accounts, Business Evals journeys, evidence, and subscriptions.",
  alternates: { canonical: "/terms" },
  openGraph: {
    title: "Terms of Service | Maintain Flow",
    description: "Terms for self-serve Maintain Flow accounts, Business Evals journeys, evidence, and subscriptions.",
    url: "/terms",
  },
}

const terms = [
  {
    title: "Accounts and eligibility",
    body: [
      "Maintain Flow is a self-serve Business Evals service for organizations that test customer-facing journeys. A new user may sign up and create one workspace without an application, call, manual invitation, or founder approval.",
      "You must provide accurate account information, keep authentication methods secure, and allow access only to authorized users. You are responsible for activity performed through your workspace and for promptly reporting suspected unauthorized access.",
    ],
  },
  {
    title: "Free and paid plans",
    body: [
      "Free is €0 and includes 1 project, 1 journey, 35 runs per month, 7-day evidence retention, and 1 seat. Solo is €49 monthly for 3 projects, 5 journeys, 750 runs, 30-day evidence, and 2 seats. Team is €149 monthly for 15 projects, 30 journeys, 7,500 runs, 90-day evidence, and 5 seats. Agency is €399 monthly for 50 projects, 100 journeys, 30,000 runs, 365-day evidence, and 15 seats.",
      "Solo, Team, and Agency include email delivery, webhooks, live evidence links, and PDFs. Agency also includes white labelling. Annual billing is discounted by 10% from twelve monthly payments. Current taxes, interval, amount due, and renewal terms are shown before you authorize Stripe-hosted checkout.",
      "Free supports a browser-only Lead form journey. Trial signup and email assertions require Solo, Team, Agency, or an active card-free Team trial; browser-only coverage is never described as end-to-end.",
      "Each workspace may use one card-free 14-day Team trial. The workspace trial creates no automatic charge and returns to Free at expiry unless a paid or explicit complimentary entitlement applies. Purchasing a plan does not start or extend another trial.",
      "Existing paid subscriptions, including legacy Starter, Growth, Scale, or Agency+ contracts, keep their existing price, capacity, and feature terms until the customer explicitly accepts a migration. Maintain Flow will not silently move a legacy subscription to a new price or contract.",
    ],
  },
  {
    title: "Billing, cancellation, and refunds",
    body: [
      "Stripe processes payment methods, subscriptions, invoices, taxes, and billing changes. Maintain Flow does not ask you to send card or bank details by email, chat, support ticket, or product form. Stripe's checkout confirmation is the authoritative record of the paid plan, interval, amount, currency, tax, and renewal you authorize. The card-free workspace trial is recorded by Maintain Flow and is not a Stripe subscription.",
      "A workspace owner can open Stripe Customer Portal from Settings to update payment details or cancel without a call. Stripe displays when a cancellation takes effect. When Stripe no longer reports the subscription as trialing or active, paid capacity ends and Free limits apply; cancellation does not automatically delete workspace data.",
      "Subscription charges are non-refundable except where required by law or expressly stated at purchase. If you cannot access Customer Portal, email sales@maintainflow.io for asynchronous billing support before the next renewal date.",
    ],
  },
  {
    title: "Plan limits and entitlement",
    body: [
      "Project, journey, monthly run, evidence-retention, seat, delivery, and white-label limits are enforced according to the workspace's effective contract. A paid plan applies only while Stripe reports an eligible trialing or active subscription with valid linkage, or when Maintain Flow records an explicit complimentary entitlement with a reason.",
      "If a subscription is incomplete, past due, unpaid, paused, expired, canceled, unlinked, or otherwise ambiguous, Maintain Flow may apply Free limits until an eligible state is verified. Downgrade or expiry does not automatically delete projects or journeys, but may block new over-limit activity and remove evidence under the applicable retention policy after notice where required.",
    ],
  },
  {
    title: "Customer responsibilities and permission",
    body: [
      "You may run only browser or legacy endpoint journeys against targets you own, maintain, or have explicit permission to test. Before running or scheduling, an authorized workspace user must attest target authority and that the journey, frequency, synthetic data, and expected effects are safe and non-destructive.",
      "You are responsible for lawful data use, client authorization, accurate journey configuration, test-data cleanup, third-party charges, production change control, backups, and compliance obligations. Maintain Flow is not responsible for reduced coverage or inaccurate results caused by missing, stale, unsafe, or incorrect configuration or dependencies outside its control.",
    ],
  },
  {
    title: "Safe operating boundary",
    body: [
      "Maintain Flow may execute approved browser form or signup journeys and legacy credential-free public HTTPS GET endpoint journeys. It must restrict domains, network destinations, concurrency, retries, time, and evidence, and must stop when it encounters CAPTCHA, MFA, access controls, anti-bot challenges, payment controls, unexpected privileged authentication, destructive confirmation, or an unauthorized domain.",
      "Maintain Flow does not bypass CAPTCHA, MFA, access controls, anti-bot systems, or rate limits; complete real purchases; send uncontrolled messages; run penetration tests; or autonomously deploy or repair a customer system. CAPTCHA or comparable human gates produce an inconclusive run unless an approved test-mode path is available.",
    ],
  },
  {
    title: "Verdicts, AI assistance, and evidence limitations",
    body: [
      "Required deterministic assertions produce pass or fail. Runner, authorization, access, email-provider, CAPTCHA, policy, queue, timeout, persistence, or evidence uncertainty produces inconclusive. A verdict applies only to the configured journey version, run time, assertions, and captured evidence; it is not a guarantee that every defect, outage, security issue, data error, or business loss will be found or prevented.",
      "AI assistance may suggest supported steps or assertions and draft explanations from redacted evidence. AI does not set or override verdicts, invent evidence, attest authorization, or certify compliance. Suggestions become part of a journey only after authorized user confirmation.",
      "You must review live links, emails, webhook payloads, and PDFs for accuracy, confidentiality, audience, permissions, and necessary redactions before sharing. Maintain Flow is not a penetration test, security audit, compliance certification, backup service, or promise of uninterrupted availability.",
    ],
  },
  {
    title: "Acceptable use",
    body: [
      "Do not use Maintain Flow to attack or scrape systems, test targets without permission, bypass CAPTCHA/MFA/access controls, create fraudulent accounts, make real purchases, send spam or uncontrolled messages, transmit malware, run destructive actions, store unlawful material, evade limits, misrepresent evidence, or expose credentials or personal data unnecessarily.",
      "Maintain Flow may restrict or suspend access when reasonably necessary to protect customers, third parties, infrastructure, or the service, to investigate abuse, or to comply with law. Where practical, we will provide an asynchronous notice and a way to correct the issue.",
    ],
  },
  {
    title: "Confidentiality and data protection",
    body: [
      "Each side must use reasonable care to protect non-public business, technical, client, credential, and commercial information received through the service. Information may be used to provide or receive Maintain Flow and shared with service providers that need it for that purpose or where disclosure is legally required.",
      "Maintain Flow handles personal and workspace data as described in the Privacy Policy. Authorized workspace owners can request access, export, correction, or deletion of account and workspace data; Maintain Flow may verify account or workspace control before acting.",
    ],
    privacyLink: true,
  },
  {
    title: "Availability, changes, and support",
    body: [
      "Maintain Flow depends on third-party infrastructure and customer-controlled systems. We work to keep the service reliable but do not guarantee uninterrupted availability or the continued availability of a customer or third-party dependency.",
      "We may update the service, plans, limits, or these terms. Material changes will be communicated through the product, website, or account email before they take effect where reasonably practicable. Support is provided asynchronously; access and normal activation do not depend on a meeting.",
    ],
  },
]

export default function TermsPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-12 px-6 pb-20 pt-32 md:px-10">
      <header className="space-y-4">
        <p className="text-sm font-medium text-primary">Maintain Flow Terms</p>
        <h1 className="text-4xl font-medium tracking-tight md:text-5xl">Terms of Service</h1>
        <p className="max-w-2xl text-base leading-7 text-muted-foreground">
          Last updated: July 18, 2026. These terms cover self-serve accounts, Business Evals journeys, deterministic
          verdicts, evidence delivery, legacy endpoint journeys, workspace trials, and subscriptions in Maintain Flow.
        </p>
      </header>

      <div className="space-y-10">
        {terms.map((term) => (
          <section key={term.title} className="border-t pt-8">
            <h2 className="text-xl font-medium tracking-tight">{term.title}</h2>
            <div className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
              {term.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {term.privacyLink ? (
                <p>
                  <Link className="text-foreground underline underline-offset-4" href="/privacy">
                    Read the Privacy Policy.
                  </Link>
                </p>
              ) : null}
            </div>
          </section>
        ))}
      </div>

      <section className="border-t pt-8">
        <h2 className="text-xl font-medium tracking-tight">Contact</h2>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          Account, support, billing, legal, privacy, and data requests can be sent asynchronously to{" "}
          <a className="text-foreground underline underline-offset-4" href="mailto:sales@maintainflow.io">
            sales@maintainflow.io
          </a>
          .
        </p>
      </section>
    </main>
  )
}
