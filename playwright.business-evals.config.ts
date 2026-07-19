import { defineConfig, devices } from "@playwright/test"

const baseURL = process.env.BUSINESS_EVALS_E2E_BASE_URL ?? "http://127.0.0.1:3100"

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "business-evals-preview.spec.ts",
  // These tests intentionally exercise cold App Router pages against an
  // isolated development server. The budget covers compilation; individual
  // product assertions still use tighter explicit timeouts.
  timeout: 120_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    colorScheme: "light",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1_487, height: 1_058 },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "tablet-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1_024, height: 768 },
        hasTouch: true,
      },
    },
  ],
  webServer: process.env.BUSINESS_EVALS_E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm exec next dev --hostname 127.0.0.1 --port 3100",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: {
          BUSINESS_EVALS_PREVIEW: "1",
        },
      },
})
