import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Security | Maintain Flow",
  description: "Maintain Flow controls for Business Evals authorization, isolated journey execution, deterministic evidence, billing, and production-change safety.",
  alternates: { canonical: "/security" },
  openGraph: {
    title: "Security and trust | Maintain Flow",
    description: "The authorization, execution, evidence, billing, and production-change boundaries behind Maintain Flow Business Evals.",
    url: "/security",
  },
}

const controls = [
  {
    title: "Tenant isolation",
    detail:
      "Workspace data is scoped by workspace ID. Protected server routes enforce signed-in membership and role checks, and production database access is constrained by row-level security rather than client-side filtering.",
  },
  {
    title: "Target authorization",
    detail:
      "An owner or admin must record an attributable attestation that the workspace owns or has permission to test each target and that the journey is safe and non-destructive. Authorization can be revoked and is rechecked before scheduling.",
  },
  {
    title: "Isolated browser and endpoint runners",
    detail:
      "Browser attempts use clean isolated contexts, bounded egress, time, steps, redirects, storage, and per-workspace/domain concurrency. Legacy endpoint journeys retain public-HTTPS GET, DNS, redirect, response-size, and SSRF controls.",
  },
  {
    title: "Human and destructive gates",
    detail:
      "Maintain Flow stops as inconclusive on CAPTCHA, MFA, anti-bot challenges, payment controls, unexpected privileged login, destructive confirmation, or an unauthorized domain. It does not bypass controls, make real purchases, or autonomously modify production.",
  },
  {
    title: "Deterministic evidence",
    detail:
      "Only service-issued runs over an immutable journey version can produce a verdict. Required typed assertions determine pass or fail; runner, access, policy, email-provider, or evidence uncertainty is inconclusive. Retries preserve separate attempts.",
  },
  {
    title: "Private evidence and redaction",
    detail:
      "Screenshots, email metadata, live links, and PDFs are redacted, stored privately, scoped to one workspace/project/run, and retained according to entitlement. Initial journeys do not store customer login credentials or connect to a general inbox.",
  },
  {
    title: "AI-assist boundary",
    detail:
      "AI receives only minimum redacted context and may suggest supported steps or explain evidence. It cannot attest authorization, browse independently, execute customer code, change assertion results, set a verdict, or invent missing evidence.",
  },
  {
    title: "Billing security",
    detail:
      "Stripe-hosted surfaces and signature-verified webhooks determine paid state. The one card-free Team trial is workspace-controlled and non-resettable. Existing subscriptions remain grandfathered until an explicit contract migration; browser users cannot write entitlement fields.",
  },
  {
    title: "Release verification",
    detail:
      "Every production release is gated on isolation, authorization, SSRF, CAPTCHA, email-correlation, verdict, evidence, retention, billing, rollback, provider-smoke, and exact-deployment checks. A local build alone is not treated as live proof.",
  },
]

export default function SecurityPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-12 px-6 pb-20 pt-32 md:px-10">
      <header className="max-w-3xl space-y-4">
        <p className="text-sm font-medium text-primary">Maintain Flow Security</p>
        <h1 className="text-4xl font-medium tracking-tight md:text-5xl">Security and trust</h1>
        <p className="text-base leading-7 text-muted-foreground">
          Maintain Flow runs customer-authorized business journeys and stores evidence, so security is part of the product contract.
          These controls describe the enforced product boundary and the release checks required for a production deployment.
          They are not a third-party security or compliance certification.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        {controls.map((control) => (
          <article key={control.title} className="rounded-md border bg-background/80 p-6">
            <h2 className="text-lg font-medium tracking-tight">{control.title}</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{control.detail}</p>
          </article>
        ))}
      </section>

      <section className="border-t pt-8">
        <h2 className="text-xl font-medium tracking-tight">Vulnerability reports</h2>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
          If you believe you have found a security issue, email{" "}
          <a className="text-foreground underline underline-offset-4" href="mailto:sales@maintainflow.io">
            sales@maintainflow.io
          </a>
          {" "}with a clear description and reproduction steps. Please do not publicly disclose the issue until we
          have had a reasonable chance to investigate and fix it. A call is not required.
        </p>
      </section>
    </main>
  )
}
