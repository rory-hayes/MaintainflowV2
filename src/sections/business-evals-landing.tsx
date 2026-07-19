import { ButtonLink } from "@/components/ui/button-link"
import { signupHref } from "@/lib/auth/signup-intent"
import Pricing from "@/sections/pricing"
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBan,
  IconBrowser,
  IconCheck,
  IconCircleCheck,
  IconClock,
  IconFileDescription,
  IconForms,
  IconLink,
  IconLock,
  IconMail,
  IconRefresh,
  IconReportAnalytics,
  IconRoute,
  IconShieldCheck,
  IconSparkles,
  IconTool,
  IconUserCheck,
} from "@tabler/icons-react"
import Image, { type StaticImageData } from "next/image"
import businessEvalReportProof from "../../public/product/business-eval-report.png"
import leadJourneyProof from "../../public/product/lead-journey-proof.png"

const freeLeadSignupHref = signupHref({ plan: "free", template: "lead_form", interval: "monthly" })
const teamTrialSignupHref = signupHref({ plan: "team", template: "trial_signup", interval: "monthly" })

const proofSteps = [
  { number: "1", title: "Authorize the journey", copy: "Create a Project, confirm you can test its public domain and define the business outcome that matters.", icon: IconUserCheck },
  { number: "2", title: "Run one supervised proof", copy: "Maintain Flow detects supported fields, applies synthetic markers and submits once under your supervision.", icon: IconRoute },
  { number: "3", title: "Keep the evidence current", copy: "Schedule the approved version, route failures into Incidents and share verified recovery in Reports.", icon: IconReportAnalytics },
] as const

const journeyStages = [
  { label: "Open page", icon: IconBrowser },
  { label: "Fill synthetic data", icon: IconForms },
  { label: "Submit once", icon: IconRoute },
  { label: "Prove outcome", icon: IconShieldCheck },
  { label: "Clean up", icon: IconRefresh },
] as const

const verdicts = [
  { label: "Passed", className: "text-emerald-700", marker: "bg-emerald-500" },
  { label: "Degraded", className: "text-amber-700", marker: "bg-amber-500" },
  { label: "Failed", className: "text-red-700", marker: "bg-red-500" },
  { label: "Inconclusive", className: "text-slate-600", marker: "bg-slate-400" },
] as const

const reportProof = [
  { title: "Immutable run evidence", copy: "Every conclusive verdict names the published journey version, required stages and retained evidence.", icon: IconLock },
  { title: "Verified recovery", copy: "A repair is not resolved until a newer passing verification run proves the outcome works again.", icon: IconRefresh },
  { title: "Expiring live links", copy: "Share a time-limited, revocable report without exposing raw email, credentials, traces or private systems.", icon: IconLink },
  { title: "Report-safe PDFs", copy: "Create a project-period snapshot with coverage, outcomes, incidents and verified recovery.", icon: IconFileDescription },
] as const

const compatibility = [
  {
    title: "Compatible",
    copy: "Can be evaluated as configured.",
    tone: "emerald",
    icon: IconCircleCheck,
    items: ["Public HTTPS Lead form", "Accessible labels or test IDs", "One unambiguous submit action", "URL, text or form-state success"],
  },
  {
    title: "Compatible with changes",
    copy: "Needs an explicit test-safe path.",
    tone: "amber",
    icon: IconTool,
    items: ["Email proof via autoresponse or forwarding", "Allowlisted verification link", "Deterministic in-product cleanup", "Customer-owned idempotent cleanup webhook"],
  },
  {
    title: "Unsupported",
    copy: "Maintain Flow stops instead of bypassing controls.",
    tone: "red",
    icon: IconBan,
    items: ["CAPTCHA or MFA", "Required phone or SMS", "Payments or file uploads", "Arbitrary scripts or private systems"],
  },
] as const

export default function BusinessEvalsLanding() {
  return (
    <div className="bg-white text-slate-950">
      <section className="px-5 pb-20 pt-32 sm:px-8 lg:px-12 lg:pb-28 lg:pt-40">
        <div className="mx-auto grid max-w-[1440px] items-center gap-12 lg:grid-cols-[0.78fr_1.42fr] lg:gap-16">
          <div className="max-w-2xl">
            <h1 className="text-balance text-[44px] font-semibold leading-[1.02] tracking-[-0.055em] text-slate-950 sm:text-6xl lg:text-[68px]">
              Continuously prove your critical customer journeys still work.
            </h1>
            <p className="mt-7 max-w-xl text-lg leading-8 text-slate-600">
              Maintain Flow runs approved customer journeys from the first page to the final business outcome—and keeps the evidence ready for your team and clients.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <ButtonLink href={freeLeadSignupHref} data-signup-cta="home_hero" size="lg" className="bg-blue-600 text-white hover:bg-blue-700">
                Start free <IconArrowRight data-icon="inline-end" />
              </ButtonLink>
              <ButtonLink href="#how-it-works" variant="outline" size="lg" className="border-slate-300 bg-white text-slate-900 hover:bg-slate-50">
                See how it works
              </ButtonLink>
            </div>
            <p className="mt-6 flex items-center gap-2 text-sm font-medium text-slate-500"><IconCircleCheck className="size-4 text-emerald-600" />No card. One Lead form journey free.</p>
          </div>

          <ProductScreenshot
            src={leadJourneyProof}
            alt="Synthetic Maintain Flow Lead form journey showing three passed deterministic stages"
            width={1440}
            height={1000}
            priority
            caption="Healthy Lead form journey · synthetic example data"
          />
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-24 border-t border-slate-200 px-5 py-20 sm:px-8 lg:px-12 lg:py-28">
        <div className="mx-auto max-w-[1440px]">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="text-balance text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">A working page is not a working outcome.</h2>
            <p className="mt-5 text-base leading-7 text-slate-600">A page can load while its form, email or account activation is broken. Maintain Flow follows the approved journey far enough to prove the business result.</p>
          </div>
          <ol className="mt-14 grid gap-px overflow-hidden border border-slate-200 bg-slate-200 lg:grid-cols-3">
            {proofSteps.map((step) => {
              const Icon = step.icon
              return (
                <li key={step.number} className="bg-white p-7 lg:p-8">
                  <div className="flex items-center justify-between gap-4">
                    <span className="flex size-9 items-center justify-center rounded-full bg-blue-50 text-sm font-semibold text-blue-700">{step.number}</span>
                    <Icon className="size-6 text-blue-600" />
                  </div>
                  <h3 className="mt-8 text-xl font-semibold tracking-tight">{step.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-600">{step.copy}</p>
                </li>
              )
            })}
          </ol>
        </div>
      </section>

      <section className="bg-slate-50 px-5 py-20 sm:px-8 lg:px-12 lg:py-28">
        <div className="mx-auto max-w-[1440px]">
          <div className="max-w-3xl">
            <h2 className="text-balance text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">From submission to business outcome.</h2>
            <p className="mt-5 max-w-2xl text-base leading-7 text-slate-600">Each published journey is immutable and evaluated with deterministic assertions. Timing can degrade an outcome; ambiguity never turns green.</p>
          </div>
          <ol className="mt-12 flex snap-x gap-3 overflow-x-auto pb-4 lg:grid lg:grid-cols-5 lg:overflow-visible">
            {journeyStages.map((stage, index) => {
              const Icon = stage.icon
              return (
                <li key={stage.label} className="relative min-w-[220px] snap-start border border-slate-200 bg-white p-6 lg:min-w-0">
                  <div className="flex items-center justify-between"><span className="text-xs font-semibold text-blue-600">Stage {index + 1}</span><Icon className="size-5 text-blue-600" /></div>
                  <h3 className="mt-12 text-lg font-semibold">{stage.label}</h3>
                  <p className="mt-2 text-sm text-slate-500">Restricted, reviewable action</p>
                </li>
              )
            })}
          </ol>
          <div className="mt-7 flex flex-wrap gap-x-7 gap-y-3">
            {verdicts.map((verdict) => <span key={verdict.label} className={`inline-flex items-center gap-2 text-sm font-medium ${verdict.className}`}><span className={`size-2.5 rounded-full ${verdict.marker}`} />{verdict.label}</span>)}
          </div>
        </div>
      </section>

      <section id="evidence" className="scroll-mt-24 border-t border-slate-200 px-5 py-20 sm:px-8 lg:px-12 lg:py-28">
        <div className="mx-auto grid max-w-[1440px] items-start gap-12 lg:grid-cols-[1.35fr_0.65fr] lg:gap-16">
          <div>
            <div className="max-w-3xl">
              <h2 className="text-balance text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">Evidence your team can act on—and your clients can trust.</h2>
              <p className="mt-5 text-base leading-7 text-slate-600">Failures become Incidents. Repairs require a passing verification rerun. Reports preserve the journey version, evidence boundary and verified recovery.</p>
            </div>
            <div className="mt-10 max-h-[760px] overflow-hidden border border-slate-200 bg-white shadow-[0_18px_55px_rgba(15,23,42,0.09)]">
              <Image src={businessEvalReportProof} alt="Synthetic Maintain Flow business eval report with journey coverage and report-safe evidence" width={1440} height={1000} sizes="(min-width: 1024px) 62vw, 100vw" className="h-auto w-full" />
            </div>
            <p className="mt-3 text-xs text-slate-500">Business eval report · synthetic example data</p>
          </div>
          <div className="divide-y divide-slate-200 lg:pt-36">
            {reportProof.map((item) => {
              const Icon = item.icon
              return (
                <div key={item.title} className="grid grid-cols-[44px_1fr] gap-4 py-6 first:pt-0">
                  <span className="flex size-11 items-center justify-center bg-blue-50 text-blue-600"><Icon className="size-5" /></span>
                  <div><h3 className="text-lg font-semibold tracking-tight">{item.title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{item.copy}</p></div>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      <section id="templates" className="scroll-mt-24 border-t border-slate-200 bg-slate-50 px-5 py-20 sm:px-8 lg:px-12 lg:py-28">
        <div className="mx-auto max-w-[1440px]">
          <div className="max-w-3xl">
            <h2 className="text-balance text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">Two launch templates, deliberately bounded.</h2>
            <p className="mt-5 text-base leading-7 text-slate-600">Maintain Flow is not generic browser automation. It ships with the public journeys that most directly affect acquisition and activation.</p>
          </div>
          <div className="mt-12 grid gap-px overflow-hidden border border-slate-200 bg-slate-200 lg:grid-cols-2">
            <Template
              icon={IconForms}
              title="Lead form"
              copy="Submit clearly synthetic values once and prove a thank-you URL, confirmation text or accessible form-state change. Add autoresponse evidence on a paid plan."
              outcome="Proves a prospect can complete the public enquiry path."
              href={freeLeadSignupHref}
              cta="Start a Lead form eval"
            />
            <Template
              icon={IconMail}
              title="Trial signup"
              copy="Create a synthetic identity, receive the verification email, open one allowlisted link, prove the expected account state and always run approved cleanup."
              outcome="Proves a visitor can activate a usable trial account."
              href={teamTrialSignupHref}
              cta="Start a Trial signup eval"
            />
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 bg-white px-5 py-20 sm:px-8 lg:px-12 lg:py-28">
        <div className="mx-auto max-w-[1440px]">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="text-balance text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">Know what can be tested before you configure it.</h2>
            <p className="mt-5 text-base leading-7 text-slate-600">Compatibility is a product result, not something you should discover after ten minutes of setup.</p>
          </div>
          <div className="mt-14 grid gap-px overflow-hidden border-y border-slate-200 bg-slate-200 lg:grid-cols-3">
            {compatibility.map((item) => <Compatibility key={item.title} {...item} />)}
          </div>
          <div className="mt-7 flex items-start gap-3 border border-blue-200 bg-blue-50 p-5 text-sm leading-6 text-blue-900"><IconAlertTriangle className="mt-0.5 size-5 shrink-0 text-blue-600" /><p>Maintain Flow never bypasses CAPTCHA, MFA, access controls, required phone verification or rate limits. Unsupported or ambiguous journeys return an honest Inconclusive result and cannot be scheduled.</p></div>
        </div>
      </section>

      <Pricing />

      <section className="border-t border-slate-200 bg-slate-50 px-5 py-20 sm:px-8 lg:px-12">
        <div className="mx-auto grid max-w-[1440px] gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
          <div>
            <h2 className="text-balance text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">Bounded by design for public journeys.</h2>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-600">Runs are designed to stay inside an owner-approved public boundary and use synthetic markers. AI can help draft or diagnose; deterministic rules own every verdict.</p>
          </div>
          <ul className="grid gap-px overflow-hidden border border-slate-200 bg-slate-200 sm:grid-cols-2">
            <TrustItem icon={IconShieldCheck} title="Owner authorization" copy="Immutable attestation for the project and action domains." />
            <TrustItem icon={IconSparkles} title="AI stays assistive" copy="Draft suggestions require approval; deterministic rules own truth." />
            <TrustItem icon={IconClock} title="Bounded scheduling" copy="Daily by default with hard safety floors and quota stops." />
            <TrustItem icon={IconLock} title="Private evidence" copy="Sanitized artifacts stay private behind short-lived access." />
          </ul>
        </div>
      </section>

      <section className="border-t border-slate-200 bg-white px-5 py-24 text-center sm:px-8 lg:px-12 lg:py-32">
        <h2 className="text-balance text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">Prove one critical journey today.</h2>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-slate-600">Start with one browser-only Lead form journey on Free. Upgrade when you need email evidence, team workflows and client-ready reports.</p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <ButtonLink href={freeLeadSignupHref} data-signup-cta="home_closing" size="lg" className="bg-blue-600 text-white hover:bg-blue-700">Start free <IconArrowRight data-icon="inline-end" /></ButtonLink>
          <ButtonLink href="/sign-in" variant="outline" size="lg" className="border-slate-300 bg-white text-slate-900">Log in</ButtonLink>
        </div>
      </section>
    </div>
  )
}

function ProductScreenshot({ src, alt, width, height, priority = false, caption }: { src: string | StaticImageData; alt: string; width: number; height: number; priority?: boolean; caption: string }) {
  return (
    <figure className="min-w-0">
      <div className="overflow-hidden border border-slate-200 bg-white shadow-[0_22px_70px_rgba(15,23,42,0.11)]">
        <Image src={src} alt={alt} width={width} height={height} priority={priority} sizes="(min-width: 1024px) 60vw, 100vw" className="h-auto w-full" />
      </div>
      <figcaption className="mt-3 text-xs text-slate-500">{caption}</figcaption>
    </figure>
  )
}

function Template({ icon: Icon, title, copy, outcome, href, cta }: { icon: typeof IconForms; title: string; copy: string; outcome: string; href: string; cta: string }) {
  return (
    <article className="bg-white p-7 lg:p-10">
      <Icon className="size-7 text-blue-600" />
      <h3 className="mt-10 text-2xl font-semibold tracking-tight">{title}</h3>
      <p className="mt-4 max-w-xl text-sm leading-6 text-slate-600">{copy}</p>
      <p className="mt-8 border-t border-slate-200 pt-5 text-sm font-medium text-slate-900">{outcome}</p>
      <ButtonLink href={href} data-signup-cta={`home_template_${title === "Lead form" ? "lead" : "trial"}`} variant="outline" className="mt-6 border-slate-300 bg-white text-slate-900">{cta}<IconArrowRight data-icon="inline-end" /></ButtonLink>
    </article>
  )
}

function Compatibility({ title, copy, tone, icon: Icon, items }: (typeof compatibility)[number]) {
  const toneClasses = tone === "emerald" ? "bg-emerald-50 text-emerald-700" : tone === "amber" ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-700"
  return (
    <article className="bg-white p-7 lg:p-9">
      <span className={`flex size-11 items-center justify-center rounded-full ${toneClasses}`}><Icon className="size-5" /></span>
      <h3 className="mt-7 text-2xl font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 min-h-12 text-sm leading-6 text-slate-600">{copy}</p>
      <ul className="mt-7 space-y-3 border-t border-slate-200 pt-6">
        {items.map((item) => <li key={item} className="flex items-start gap-2.5 text-sm leading-6 text-slate-700"><IconCheck className="mt-1 size-4 shrink-0 text-slate-500" />{item}</li>)}
      </ul>
    </article>
  )
}

function TrustItem({ icon: Icon, title, copy }: { icon: typeof IconShieldCheck; title: string; copy: string }) {
  return <li className="bg-white p-6"><Icon className="size-5 text-blue-600" /><h3 className="mt-6 font-semibold text-slate-950">{title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{copy}</p></li>
}
