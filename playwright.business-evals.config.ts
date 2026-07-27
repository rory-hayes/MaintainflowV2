import { defineConfig, devices } from "@playwright/test"
import { randomBytes } from "node:crypto"

const baseURL = process.env.BUSINESS_EVALS_E2E_BASE_URL ?? "http://127.0.0.1:3100"
const inheritedPreviewToken = process.env.MAINTAINFLOW_PLAYWRIGHT_PREVIEW_TOKEN
const previewToken = inheritedPreviewToken && /^[a-f0-9]{64}$/.test(inheritedPreviewToken)
  ? inheritedPreviewToken
  : randomBytes(32).toString("hex")
// Playwright may evaluate this config in both the coordinator and worker
// process. Inherit one per-run token so the browser and local server agree.
process.env.MAINTAINFLOW_PLAYWRIGHT_PREVIEW_TOKEN = previewToken

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "business-evals-preview.spec.ts",
  // Release acceptance runs against an isolated production build so strict
  // CSP remains enabled without development-only React eval diagnostics.
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
        command: "pnpm exec next build --webpack && cp -R .next/static .next/standalone/.next/static && cp -R public .next/standalone/public && node .next/standalone/server.js",
        url: baseURL,
        reuseExistingServer: false,
        timeout: 300_000,
        env: {
          BUSINESS_EVALS_PREVIEW: "1",
          BUSINESS_EVALS_E2E_PREVIEW_TOKEN: previewToken,
          HOSTNAME: "127.0.0.1",
          NEXT_TELEMETRY_DISABLED: "1",
          PORT: "3100",
          // The linked local environment intentionally carries Vercel metadata.
          // Clear it only for this token-bound localhost build so the preview
          // policy continues to reject fixture access on real deployments.
          // Use non-empty tombstones because Next's env loader may restore an
          // empty value from .env.local. The preview policy accepts these only
          // with this test-only acknowledgement and the random request token.
          BUSINESS_EVALS_LOCAL_E2E_ENV_CLEARED: "1",
          VERCEL: "0",
          VERCEL_ENV: "0",
          NEXT_PUBLIC_VERCEL_ENV: "0",
        },
      },
})
