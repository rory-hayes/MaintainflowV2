import { expect, test as base } from "@playwright/test"

const baseURL = process.env.BUSINESS_EVALS_E2E_BASE_URL ?? "http://127.0.0.1:3100"
const appOrigin = new URL(baseURL).origin
const previewToken = process.env.MAINTAINFLOW_PLAYWRIGHT_PREVIEW_TOKEN ?? ""

if (!/^[a-f0-9]{64}$/.test(previewToken)) {
  throw new Error("The Business Evals Playwright preview token is unavailable.")
}

const previewHeader = "x-maintainflow-e2e-preview-token"

const test = base.extend({
  page: async ({ page }, runTest) => {
    await page.route("**/*", async (route) => {
      const request = route.request()
      const requestUrl = new URL(request.url())
      if (requestUrl.origin !== appOrigin) {
        await route.continue()
        return
      }
      await route.continue({
        headers: {
          ...request.headers(),
          [previewHeader]: previewToken,
        },
      })
    })
    await runTest(page)
  },
})

export { expect, test }
