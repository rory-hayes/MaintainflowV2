import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string) => readFileSync(path, "utf8")

test("the sitemap contains only the canonical Business Evals public surface", () => {
  const source = read("src/app/sitemap.ts")

  assert.match(source, /import \{ siteUrl \} from "@\/lib\/seo"/)
  for (const route of ["", "/security", "/privacy", "/terms"]) {
    assert.match(source, new RegExp(`path: "${route}"`))
  }
  for (const retired of [
    "/agency-workflow-maintenance",
    "/use-cases/n8n-maintenance",
    "/use-cases/make-zapier-client-monitoring",
    "/templates/monthly-automation-report",
    "/contact-sales",
    "/sign-in",
    "/sign-up",
  ]) {
    assert.doesNotMatch(source, new RegExp(`path: "${retired.replaceAll("/", "\\/")}"`))
  }
  assert.doesNotMatch(source, /lastModified: new Date\(\)/)
})

test("retired endpoint-monitoring funnels permanently redirect into the current Business Evals story", () => {
  const redirects = new Map([
    ["src/app/agency-workflow-maintenance/page.tsx", "/#templates"],
    ["src/app/use-cases/n8n-maintenance/page.tsx", "/#how-it-works"],
    ["src/app/use-cases/make-zapier-client-monitoring/page.tsx", "/#how-it-works"],
    ["src/app/templates/monthly-automation-report/page.tsx", "/#evidence"],
  ])

  for (const [path, destination] of redirects) {
    const source = read(path)
    assert.match(source, /import \{ permanentRedirect \} from "next\/navigation"/)
    assert.match(source, new RegExp(`permanentRedirect\\("${destination.replaceAll("/", "\\/")}\\"\\)`))
    assert.doesNotMatch(source, /SeoLandingPage|public HTTPS GET|workflow maintenance/)
  }
})

test("legacy public aliases use direct permanent redirects", () => {
  const aliases = new Map([
    ["src/app/contact-sales/page.tsx", "/sign-up"],
    ["src/app/client-journey-assurance/page.tsx", "/sign-up"],
    ["src/app/login/page.tsx", "/sign-in"],
    ["src/app/signup/page.tsx", "/sign-up"],
  ])

  for (const [path, destination] of aliases) {
    const source = read(path)
    assert.match(source, /permanentRedirect/)
    assert.match(source, new RegExp(`permanentRedirect\\("${destination.replaceAll("/", "\\/")}\\"\\)`))
    assert.doesNotMatch(source, /\bredirect\(/)
  }
})

test("public navigation exposes the Business Evals sections and direct self-serve access", () => {
  const source = read("src/sections/navigation.tsx")

  assert.match(source, /href: "\/#how-it-works"/)
  assert.match(source, /href: "\/#evidence"/)
  assert.match(source, /href: "\/#pricing"/)
  assert.match(source, /href="\/sign-in"[\s\S]*?Log in/)
  assert.match(source, /signupHref\(\{ plan: "free", template: "lead_form", interval: "monthly" \}\)/)
  assert.match(source, /href=\{startFreeHref\} data-signup-cta="nav_desktop"[\s\S]*?Start free/)
  assert.doesNotMatch(source, /contact-sales|Existing customers|workflow maintenance/)
})

test("private Business Evals and onboarding routes emit noindex metadata", () => {
  for (const path of ["src/app/(evals)/layout.tsx", "src/app/onboarding/page.tsx", "src/app/reports/layout.tsx"]) {
    const source = read(path)
    assert.match(source, /robots: \{ index: false, follow: false, nocache: true \}/)
  }
})

test("public policy pages declare their own canonical URL", () => {
  for (const [path, canonical] of [
    ["src/app/security/page.tsx", "/security"],
    ["src/app/privacy/page.tsx", "/privacy"],
    ["src/app/terms/page.tsx", "/terms"],
  ]) {
    const source = read(path)
    assert.match(source, new RegExp(`alternates: \\{ canonical: "${canonical.replaceAll("/", "\\/")}\\" \\}`))
    assert.match(source, new RegExp(`url: "${canonical.replaceAll("/", "\\/")}\\"`))
  }
})

test("robots uses the shared canonical origin and excludes every private surface", () => {
  const source = read("src/app/robots.ts")

  assert.match(source, /import \{ siteUrl \} from "@\/lib\/seo"/)
  assert.doesNotMatch(source, /localhost:3000|NEXT_PUBLIC_SITE_URL/)
  for (const route of [
    "/api/",
    "/business-evals-fixtures/",
    "/control-room/",
    "/share/reports/",
    "/projects",
    "/journeys",
    "/eval-runs",
    "/incidents",
    "/reports",
    "/settings",
    "/onboarding",
    "/dashboard",
    "/sign-in",
    "/sign-up",
  ]) {
    assert.match(source, new RegExp(`"${route.replaceAll("/", "\\/")}"`))
  }
})
