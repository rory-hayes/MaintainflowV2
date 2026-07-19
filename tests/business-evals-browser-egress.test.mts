import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { requireBrowserbaseExternalEgressProxy } from "../src/lib/runner/browserbase-egress-config.ts"

const validProxyEnv = {
  BROWSERBASE_EGRESS_PROXY_SERVER: "https://egress.example.com:8443",
  BROWSERBASE_EGRESS_PROXY_USERNAME: "maintainflow-production",
  BROWSERBASE_EGRESS_PROXY_PASSWORD: "a-long-rotated-proxy-password",
}

test("Browserbase egress config creates one authenticated catch-all external proxy rule", () => {
  const proxy = requireBrowserbaseExternalEgressProxy(validProxyEnv)
  assert.deepEqual(proxy, {
    type: "external",
    server: "https://egress.example.com:8443",
    username: "maintainflow-production",
    password: "a-long-rotated-proxy-password",
  })
  assert.equal("domainPattern" in proxy, false)
})

test("Browserbase egress config fails closed on missing or unsafe values", () => {
  assert.throws(() => requireBrowserbaseExternalEgressProxy({}), /configuration is incomplete/)
  assert.throws(
    () => requireBrowserbaseExternalEgressProxy({ ...validProxyEnv, BROWSERBASE_EGRESS_PROXY_SERVER: "http://egress.example.com" }),
    /must use HTTPS/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressProxy({ ...validProxyEnv, BROWSERBASE_EGRESS_PROXY_SERVER: "https://user:" + "pass@egress.example.com" }),
    /must not embed credentials/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressProxy({ ...validProxyEnv, BROWSERBASE_EGRESS_PROXY_SERVER: "https://127.0.0.1:8443" }),
    /public DNS hostname/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressProxy({ ...validProxyEnv, BROWSERBASE_EGRESS_PROXY_SERVER: "https://proxy.service.internal" }),
    /public DNS hostname/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressProxy({ ...validProxyEnv, BROWSERBASE_EGRESS_PROXY_PASSWORD: "too-short" }),
    /between 16 and 1024/
  )
})

test("eval and scan Browserbase sessions have no direct egress or raw provider evidence", () => {
  const evalProvider = readFileSync("src/lib/runner/browserbase-provider.server.ts", "utf8")
  const pageScan = readFileSync("src/lib/runner/page-scan.server.ts", "utf8")

  for (const source of [evalProvider, pageScan]) {
    assert.match(source, /requireBrowserbaseExternalEgressProxy/)
    assert.match(source, /proxies: \[.*externalEgressProxy\]/)
    assert.match(source, /advancedStealth: false/)
    assert.match(source, /solveCaptchas: false/)
    assert.match(source, /ignoreCertificateErrors: false/)
    assert.match(source, /recordSession: false/)
    assert.match(source, /logSession: false/)
    assert.doesNotMatch(source, /proxies:\s*(?:false|true)/)
    assert.doesNotMatch(source, /type:\s*["'](?:none|browserbase)["']/)
    assert.doesNotMatch(source, /userMetadata/)
  }
  assert.doesNotMatch(evalProvider, /maintainFlowRunId/)
  assert.match(evalProvider, /session connection failed securely/)
  assert.match(pageScan, /scan session connection failed securely/)
})

test("Browserbase connection secrets stay out of durable workflow session handles", () => {
  const types = readFileSync("src/lib/runner/types.ts", "utf8")
  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
  const handle = types.match(/export type BrowserSessionHandle = \{([\s\S]*?)\n\}/)?.[1] ?? ""
  assert.doesNotMatch(handle, /connectUrl|password|proxy/i)
  assert.doesNotMatch(workflow, /connectUrl/)
  assert.match(workflow, /\(\?:https\?\|wss\?\)/)
})

test("the in-process browser guard rejects unsafe targets before production traffic continues through the proxy", () => {
  const guard = readFileSync("src/lib/runner/browser-safety.server.ts", "utf8")
  const provider = readFileSync("src/lib/runner/browserbase-provider.server.ts", "utf8")
  const scan = readFileSync("src/lib/runner/page-scan.server.ts", "utf8")
  assert.match(guard, /protocol !== "https:"/)
  assert.match(guard, /UNSUPPORTED_SCHEME/)
  assert.match(guard, /networkMode === "external_proxy"[\s\S]+await route\.continue\(\)/)
  assert.match(guard, /fulfillFromPinnedPublicAddress/)
  assert.match(provider, /networkMode: "external_proxy"/)
  assert.match(scan, /networkMode: "external_proxy"/)
  assert.doesNotMatch(provider, /allowedDomains:/)
  assert.doesNotMatch(scan, /allowedDomains:/)
})

test("deployment tooling requires the proxy for global and selected-workspace cutovers", () => {
  const readiness = readFileSync("scripts/local-deploy-readiness.mjs", "utf8")
  const envPush = readFileSync("scripts/push-vercel-env.mjs", "utf8")
  const envExample = readFileSync("ENV_EXAMPLE.md", "utf8")

  for (const source of [readiness, envPush, envExample]) {
    assert.match(source, /BROWSERBASE_EGRESS_PROXY_SERVER/)
    assert.match(source, /BROWSERBASE_EGRESS_PROXY_USERNAME/)
    assert.match(source, /BROWSERBASE_EGRESS_PROXY_PASSWORD/)
  }
  for (const source of [readiness, envPush]) {
    assert.match(source, /BUSINESS_EVALS_WORKSPACE_ALLOWLIST/)
    assert.match(source, /businessEvalsWorkspaceAllowlist|stagedWorkspaceAllowlist/)
    assert.match(source, /validateBrowserbaseEgressProxy/)
  }
})

test("provider documentation requires production egress and escape-path canaries", () => {
  const security = readFileSync("SECURITY.md", "utf8")
  const architecture = readFileSync("ARCHITECTURE.md", "utf8")
  const checklist = readFileSync("PRODUCTION_PROVIDER_CHECKLIST.md", "utf8")
  const egressDecision = readFileSync("docs/business-evals/BROWSERBASE_EGRESS_SECURITY_SPEC.md", "utf8")

  assert.match(security, /authenticated external proxy rule with no domain pattern/)
  assert.match(security, /residential\/geolocation proxies, `none` rules, and direct fallback are forbidden/)
  assert.match(security, /ordinary CONNECT tunnel cannot distinguish HTTPS from encrypted WSS/)
  assert.match(architecture, /connection URLs exist only long enough/)
  assert.match(checklist, /cross-origin public subresource/)
  assert.match(checklist, /disallowed popup/)
  assert.match(checklist, /WebSocket handshake is rejected/)
  assert.match(checklist, /after Playwright disconnects while the Browserbase keep-alive session remains active/)
  assert.match(checklist, /proxy-policy fingerprint/)

  assert.match(egressDecision, /external policy gateway required/)
  assert.match(egressDecision, /cannot currently obtain a production-grade SSRF, DNS-rebinding, and unattended WebSocket boundary/)
  assert.match(egressDecision, /does not block iframe\/subframe navigations or in-page requests/)
  assert.match(egressDecision, /resolved_address_filter/)
  assert.match(egressDecision, /stock filter is \*\*not sufficient by itself\*\*/)
  assert.match(egressDecision, /proxySettings\.caCertificates/)
  assert.match(egressDecision, /after Playwright disconnects while the Browserbase keep-alive session remains active/)
  assert.match(egressDecision, /gateway outage cannot fall back|external gateway unavailable/)
})
