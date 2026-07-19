import { ButtonLink } from "@/components/ui/button-link"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { absoluteUrl } from "@/lib/seo"
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowRight,
  IconBuilding,
  IconChecks,
  IconCircleCheck,
  IconFileAnalytics,
} from "@tabler/icons-react"
import Image from "next/image"
import Link from "next/link"

type SeoSection = {
  title: string
  body: string
  items: string[]
}

type RelatedPage = {
  title: string
  href: string
  description: string
}

type Faq = {
  question: string
  answer: string
}

export type SeoLandingPageContent = {
  path: string
  title: string
  description: string
  heroPoints: string[]
  outcomeCards: Array<{
    title: string
    description: string
  }>
  sections: SeoSection[]
  reportTitle: string
  reportDescription: string
  reportItems: string[]
  faqs: Faq[]
  related: RelatedPage[]
}

function jsonLd(content: SeoLandingPageContent) {
  const url = absoluteUrl(content.path)

  return [
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: content.title,
      description: content.description,
      url,
      isPartOf: {
        "@type": "WebSite",
        name: "Maintain Flow",
        url: absoluteUrl("/"),
      },
      publisher: {
        "@type": "Organization",
        name: "Maintain Flow",
        url: absoluteUrl("/"),
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Maintain Flow",
          item: absoluteUrl("/"),
        },
        {
          "@type": "ListItem",
          position: 2,
          name: content.title,
          item: url,
        },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: content.faqs.map((faq) => ({
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: faq.answer,
        },
      })),
    },
  ]
}

export function SeoLandingPage({ content }: { content: SeoLandingPageContent }) {
  return (
    <article className="relative overflow-hidden px-4 pb-24 pt-36 md:px-12 xl:px-0">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd(content)).replace(/</g, "\\u003c"),
        }}
      />
      <div className="absolute left-1/2 top-10 h-[32rem] w-[70rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative z-10 mx-auto max-w-7xl">
        <header className="mx-auto flex max-w-4xl flex-col items-center gap-6 text-center">
          <h1 className="text-balance text-4xl font-medium tracking-tight text-foreground md:text-6xl">
            {content.title}
          </h1>
          <p className="max-w-3xl text-balance text-sm leading-7 text-muted-foreground md:text-base">
            {content.description}
          </p>
          <div className="flex flex-col items-center gap-3">
            <ButtonLink href="/sign-up" data-signup-cta="seo_hero">
              Start free
              <IconArrowRight data-icon="inline-end" />
            </ButtonLink>
            <p className="max-w-xl text-balance text-xs leading-5 text-muted-foreground">
              1 client · 3 workflows · 1 report per month · no card required
            </p>
          </div>
          <ul className="grid w-full gap-3 pt-4 text-left md:grid-cols-3">
            {content.heroPoints.map((point) => (
              <li
                key={point}
                className="flex min-h-16 items-start gap-3 rounded-lg border bg-background/70 p-4 text-sm text-muted-foreground supports-backdrop-filter:backdrop-blur-md"
              >
                <IconCircleCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </header>

        <div className="mx-auto mt-12 max-w-6xl rounded-xl border bg-muted/30 p-1.5 shadow-2xl supports-backdrop-filter:backdrop-blur-md">
          <div className="relative aspect-[16/9] overflow-hidden rounded-lg border bg-background">
            <Image
              src="/assets/maintain-flow-mature-dashboard.png"
              alt="Maintain Flow dashboard showing workflow health, issues, checks, and report readiness"
              fill
              priority
              sizes="(min-width: 1280px) 1152px, 100vw"
              className="object-cover object-top"
            />
          </div>
        </div>

        <section className="grid gap-4 pt-20 md:grid-cols-3" aria-label="Key outcomes">
          {content.outcomeCards.map((card, index) => {
            const Icon = [IconActivity, IconAlertTriangle, IconFileAnalytics][index] ?? IconChecks

            return (
              <Card key={card.title} className="border-border bg-background/70">
                <CardHeader>
                  <CardTitle>{card.title}</CardTitle>
                  <CardAction>
                    <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon aria-hidden />
                    </span>
                  </CardAction>
                  <CardDescription>{card.description}</CardDescription>
                </CardHeader>
              </Card>
            )
          })}
        </section>

        <section className="grid gap-6 pt-20 lg:grid-cols-3">
          {content.sections.map((section) => (
            <Card key={section.title} className="border-border bg-muted/20">
              <CardHeader>
                <CardTitle className="text-xl">{section.title}</CardTitle>
                <CardDescription>{section.body}</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-3">
                  {section.items.map((item) => (
                    <li key={item} className="flex gap-3 text-sm leading-6 text-muted-foreground">
                      <IconCircleCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="grid gap-8 pt-20 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <div className="flex flex-col gap-4">
            <div className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <IconBuilding aria-hidden />
            </div>
            <h2 className="max-w-xl text-3xl font-medium tracking-tight text-balance md:text-4xl">
              {content.reportTitle}
            </h2>
            <p className="max-w-2xl text-sm leading-7 text-muted-foreground md:text-base">
              {content.reportDescription}
            </p>
          </div>
          <div className="grid gap-3">
            {content.reportItems.map((item) => (
              <div key={item} className="rounded-lg border bg-background/70 p-4 text-sm text-muted-foreground">
                {item}
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-8 pt-20 lg:grid-cols-[0.85fr_1.15fr]">
          <div>
            <h2 className="text-3xl font-medium tracking-tight md:text-4xl">Common questions</h2>
            <p className="mt-3 max-w-md text-sm leading-7 text-muted-foreground md:text-base">
              Straight answers for agencies evaluating Maintain Flow as a self-serve assurance layer.
            </p>
          </div>
          <div className="grid gap-3">
            {content.faqs.map((faq) => (
              <Card key={faq.question} className="border-border bg-background/70">
                <CardHeader>
                  <CardTitle>{faq.question}</CardTitle>
                  <CardDescription>{faq.answer}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>

        <section className="pt-20">
          <div className="rounded-xl border bg-muted/20 p-6 md:p-8">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-3xl font-medium tracking-tight md:text-4xl">
                  Monitor one critical public outcome endpoint.
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground md:text-base">
                  Create your workspace, connect a customer-owned public HTTPS GET outcome or health endpoint, define its expected status and safe structural evidence, record a linked passing rerun after repair, and generate a white-label Reliability Report. No call or approval required.
                </p>
              </div>
              <ButtonLink href="/sign-up" data-signup-cta="seo_closing">
                Start monitoring free
                <IconArrowRight data-icon="inline-end" />
              </ButtonLink>
            </div>
          </div>
        </section>

        <nav className="grid gap-4 pt-12 md:grid-cols-3" aria-label="Related Maintain Flow pages">
          {content.related.map((page) => (
            <Link
              key={page.href}
              href={page.href}
              className="rounded-lg border bg-background/70 p-4 transition-colors hover:bg-muted/40"
            >
              <span className="text-sm font-medium text-foreground">{page.title}</span>
              <span className="mt-2 block text-sm leading-6 text-muted-foreground">
                {page.description}
              </span>
            </Link>
          ))}
        </nav>
      </div>
    </article>
  )
}
