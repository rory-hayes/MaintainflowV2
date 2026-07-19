import "server-only"

import { BrowserbasePlaywrightProvider } from "@/lib/runner/browserbase-provider.server"
import { LocalPlaywrightProvider } from "@/lib/runner/local-playwright-provider.server"
import type { BrowserEvalProvider } from "@/lib/runner/types"

export function getBrowserEvalProvider(env: Partial<Record<string, string | undefined>> = process.env): BrowserEvalProvider {
  if (env.NODE_ENV === "production" || env.BROWSERBASE_API_KEY?.trim()) {
    return new BrowserbasePlaywrightProvider(env)
  }
  return new LocalPlaywrightProvider()
}
