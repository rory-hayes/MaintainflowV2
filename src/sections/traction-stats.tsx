import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { TextAnimate } from "@/components/ui/text-animate"

const stats = [
  {
    value: "€0",
    label: "to start",
    detail: "Create your workspace and monitor the first public outcome or health endpoint without a card, call, or approval.",
  },
  {
    value: "3",
    label: "workflows on Free",
    detail: "Connect one client and monitor up to three public endpoint signals before upgrading.",
  },
  {
    value: "1",
    label: "report each month",
    detail: "Generate client-ready reliability proof from real checks, issues, resolutions, and reruns.",
  },
]

export default function TractionStats() {
  return (
    <section className="px-4 py-16 md:px-12 lg:py-24 xl:px-0">
      <div className="mx-auto max-w-7xl">
        <div className="mx-auto max-w-2xl text-center">
          <Badge variant="secondary">Start free</Badge>
          <TextAnimate as="h2" animation="blurInUp" className="mt-4 text-4xl tracking-tight text-balance md:text-5xl">
            Prove the endpoint assurance loop before you pay
          </TextAnimate>
          <p className="mt-4 text-sm leading-6 text-muted-foreground lg:text-base">
            Sign up, add a customer-owned public endpoint, run checks, resolve issues, and create a report on the Free plan.
          </p>
        </div>

        <Card className="mt-12 border-border bg-muted/40">
          <CardContent className="grid gap-0 p-0 md:grid-cols-3">
            {stats.map((stat, index) => (
              <div
                key={stat.label}
                className={index === 0 ? "p-6 text-center md:p-8" : "border-t border-border p-6 text-center md:border-l md:border-t-0 md:p-8"}
              >
                <p className="text-5xl font-medium tracking-tight text-foreground">{stat.value}</p>
                <p className="mt-3 text-sm font-medium text-foreground">{stat.label}</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{stat.detail}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
