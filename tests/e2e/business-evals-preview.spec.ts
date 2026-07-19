import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.describe("Business Evals preview acceptance", () => {
  test("Journey evidence and debug capture stay truthful", async ({ page }) => {
    await page.goto("/evals-preview")

    await expect(page).toHaveTitle(/Maintain Flow/)
    await expect(page.getByRole("heading", { level: 1, name: "Trial signup to first login" })).toBeVisible()
    await expect(page.getByRole("list", { name: "Journey stages" })).toBeVisible()

    await page.getByRole("button", { name: /Signup submitted/ }).click()
    await expect(page.getByText("Stage 2 of 6")).toBeVisible()
    await expect(page.getByText("A valid trial signup is accepted without an error.")).toBeVisible()

    await page.getByRole("button", { name: "Run with debug capture" }).click()
    await expect(page.getByText(/Run run-\d+ is passed/)).toBeVisible({ timeout: 5_000 })
    // Desktop/tablet render a table row (whose last cell may begin inside the
    // horizontal scroll area); mobile renders one linked card. Prove the
    // visible run record carries the trigger in either responsive layout.
    const visibleDebugRun = page.getByRole("row").filter({ hasText: "Debug capture" })
      .or(page.getByRole("link").filter({ hasText: "Debug capture" }))
      .filter({ visible: true })
    await expect(visibleDebugRun).toHaveCount(1)
    await expect(visibleDebugRun).toBeVisible()
    await expect(visibleDebugRun).toContainText("Debug capture")

    const documentWidth = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }))
    expect(documentWidth.content).toBeLessThanOrEqual(documentWidth.viewport)

    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? ""))).toEqual([])
  })

  test("Product routes expose the project, incident, report and settings surfaces", async ({ page }) => {
    // This test deliberately cold-compiles seven independent App Router pages
    // under the local development server. Keep the individual assertions
    // strict while allowing enough total time for those first compilations.
    test.setTimeout(180_000)

    const routes = [
      { path: "/projects", heading: "Projects" },
      { path: "/projects/beacon-crm", heading: "Beacon CRM" },
      { path: "/journeys", heading: "Journeys" },
      { path: "/incidents", heading: "Incidents" },
      { path: "/reports", heading: "Reports" },
      { path: "/settings/workspace", heading: "Settings" },
      { path: "/onboarding", heading: "Prove your first business journey" },
    ] as const

    for (const route of routes) {
      await page.goto(route.path)
      await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible()
      await expect(page.getByText(/Application error|Unhandled Runtime Error|Build Error/)).toHaveCount(0)
    }
  })

  test("Lead builder reaches a supervised pass and daily schedule without preview API fallthrough", async ({ page }) => {
    const browserErrors: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text())
    })

    await page.goto("/journeys/new")
    await page.getByLabel("Journey name").fill("Contact lead proof")
    await page.getByLabel("Public HTTPS start URL").fill("https://example.com/contact")
    await page.getByRole("button", { name: "Scan public page" }).click()
    await expect(page.getByText("Controlled lead form")).toBeVisible()
    await expect(page.getByRole("combobox", { name: "Single submit action" })).toHaveValue("0")

    await page.getByRole("button", { name: "Review assertions" }).click()
    await expect(page.getByText("Thank you is visible after submission.")).toBeVisible()
    await page.getByRole("button", { name: "Save and publish version" }).click()
    await expect(page.getByText("Published immutable journey version")).toBeVisible()

    await page.getByRole("button", { name: "Start supervised run" }).click()
    await expect(page.getByText("Supervised proof passed")).toBeVisible({ timeout: 5_000 })
    await page.getByRole("button", { name: "Enable daily schedule" }).click()
    // The dynamic Journey detail route is cold-compiled by the local Next.js
    // development server. Keep the product assertion strict while allowing the
    // compile to finish on clean machines and CI runners.
    await expect(page).toHaveURL(/\/journeys\/contact-lead-proof-/, { timeout: 45_000 })
    await expect(page.getByRole("heading", { level: 1, name: "Contact lead proof" })).toBeVisible()
    expect(browserErrors).toEqual([])
  })

  test("Trial builder proves email, verification, cleanup and the schedule gate", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("desktop"), "The full builder path is covered once at the reference viewport")
    const browserErrors: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text())
    })

    await page.goto("/journeys/new")
    await page.getByLabel("Launch template").selectOption("trial_signup")
    await page.getByLabel("Journey name").fill("Trial signup proof")
    await page.getByLabel("Public HTTPS start URL").fill("https://example.com/signup")
    await page.getByRole("button", { name: "Scan public page" }).click()
    await expect(page.getByText("Controlled trial signup")).toBeVisible()
    await expect(page.getByLabel("Synthetic value")).toHaveCount(5)

    await page.getByRole("button", { name: "Review assertions" }).click()
    await expect(page.getByText("Trial signup proof and cleanup")).toBeVisible()
    await expect(page.getByLabel("Verification-link host")).toHaveValue("example.com")
    await expect(page.getByRole("radio", { name: /In-product delete/ })).toBeChecked()
    await expect(page.getByText("6. Cleanup test account · cleanup")).toBeVisible()

    await page.getByRole("button", { name: "Save and publish version" }).click()
    await expect(page.getByText("Published immutable journey version")).toBeVisible()
    await page.getByRole("button", { name: "Start supervised run" }).click()
    await expect(page.getByText("Supervised proof passed")).toBeVisible({ timeout: 5_000 })
    await page.getByRole("button", { name: "Enable daily schedule" }).click()
    await expect(page).toHaveURL(/\/journeys\/trial-signup-proof-/, { timeout: 45_000 })
    await expect(page.getByText("Coverage: Browser + email + cleanup")).toBeVisible()
    await expect(page.getByText("Daily", { exact: true })).toBeVisible()
    expect(browserErrors).toEqual([])
  })

  test("Reports preserve coverage, outcomes, incidents, recoveries and provenance", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("desktop"), "The full report contract is covered once at the reference viewport")
    await page.goto("/reports/report-july")
    await expect(page.getByRole("button", { name: "Create share link" })).toBeEnabled()
    for (const section of ["Journey coverage", "Report-safe eval evidence", "Incidents", "Verified recoveries", "Evidence provenance"]) {
      await expect(page.getByRole("heading", { level: 3, name: section })).toBeVisible()
    }
    await expect(page.getByText("Trial signup to first login", { exact: true })).toBeVisible()
    const verifiedRecoveries = page.getByRole("heading", { level: 3, name: "Verified recoveries" }).locator("..")
    await expect(verifiedRecoveries.getByText("A newer passing verification rerun proved the repaired confirmation state.")).toBeVisible()
    await expect(page.getByText(/aaaaaaaaaaaaaaaa/)).toBeVisible()
  })

  test("Mobile navigation and stage rail are operable", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("mobile"), "Mobile-only interaction")
    await page.goto("/evals-preview")

    await page.getByRole("button", { name: "Open product navigation" }).click()
    await expect(page.getByRole("navigation", { name: "Mobile product navigation" })).toBeVisible()
    await page.getByRole("link", { name: "Projects", exact: true }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible()

    await page.goto("/evals-preview")
    const stageRail = page.getByRole("list", { name: "Journey stages" })
    await expect(stageRail).toBeVisible()
    await expect.poll(async () => stageRail.evaluate((element) => getComputedStyle(element.parentElement!).scrollSnapType)).toContain("x")
    const firstStage = page.getByRole("button", { name: /Pricing page/ })
    await firstStage.focus()
    await expect(firstStage).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.getByRole("button", { name: /Signup submitted/ })).toBeFocused()
  })

  test("Tablet layout keeps the Journey canvas and report routes free of page overflow", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("tablet"), "Tablet-only layout")
    for (const path of ["/evals-preview", "/reports/report-july"]) {
      await page.goto(path)
      const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
      expect(width.content).toBeLessThanOrEqual(width.viewport)
    }
  })
})
