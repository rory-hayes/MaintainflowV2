import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { requireBrowserbaseExternalEgressConfiguration, requireBrowserbaseProjectId } from "../src/lib/runner/browserbase-egress-config.ts"

const validProxyEnv = {
  BROWSERBASE_EGRESS_PROXY_SERVER: "https://egress.example.com",
  BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID: "cert_maintainflow_public_ca_2026_01",
}
const validSessionCredentials = {
  username: "mf1.primary_2026",
  password: `${"a".repeat(96)}.${"b".repeat(86)}`,
}

test("Browserbase egress config binds one authenticated catch-all proxy to one reviewed public CA", () => {
  const configuration = requireBrowserbaseExternalEgressConfiguration(validSessionCredentials, validProxyEnv)
  assert.deepEqual(configuration, {
    proxies: [{
      type: "external",
      server: "https://egress.example.com",
      ...validSessionCredentials,
    }],
    proxySettings: {
      caCertificates: ["cert_maintainflow_public_ca_2026_01"],
    },
  })
  assert.equal(configuration.proxies.length, 1)
  assert.equal("domainPattern" in configuration.proxies[0], false)
})

test("Browserbase egress config fails closed on missing or unsafe values", () => {
  assert.throws(() => requireBrowserbaseExternalEgressConfiguration(validSessionCredentials, {}), /configuration is incomplete/)
  assert.throws(
    () => requireBrowserbaseExternalEgressConfiguration(validSessionCredentials, { ...validProxyEnv, BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID: "" }),
    /BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressConfiguration(validSessionCredentials, { ...validProxyEnv, BROWSERBASE_EGRESS_PROXY_SERVER: "http://egress.example.com" }),
    /must use HTTPS/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressConfiguration(validSessionCredentials, { ...validProxyEnv, BROWSERBASE_EGRESS_PROXY_SERVER: "https://user:" + "pass@egress.example.com" }),
    /must not embed credentials/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressConfiguration(validSessionCredentials, { ...validProxyEnv, BROWSERBASE_EGRESS_PROXY_SERVER: "https://127.0.0.1" }),
    /public DNS hostname/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressConfiguration(validSessionCredentials, { ...validProxyEnv, BROWSERBASE_EGRESS_PROXY_SERVER: "https://egress.example.com:8443" }),
    /port 443/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressConfiguration(validSessionCredentials, { ...validProxyEnv, BROWSERBASE_EGRESS_PROXY_SERVER: "https://proxy.service.internal" }),
    /public DNS hostname/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressConfiguration({ ...validSessionCredentials, password: "too-short" }, validProxyEnv),
    /per-session browser proxy token/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressConfiguration({ ...validSessionCredentials, password: "😀".repeat(300) }, validProxyEnv),
    /per-session browser proxy token/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressConfiguration({ ...validSessionCredentials, username: "unsafe:user" }, validProxyEnv),
    /per-session browser proxy username/
  )
  assert.throws(
    () => requireBrowserbaseExternalEgressConfiguration(validSessionCredentials, { ...validProxyEnv, BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID: "two certificate ids" }),
    /one structurally safe Browserbase certificate ID/
  )
})

test("Browserbase sessions require one reviewed project identity", () => {
  assert.equal(requireBrowserbaseProjectId({ BROWSERBASE_PROJECT_ID: "proj_maintainflow_production" }), "proj_maintainflow_production")
  assert.throws(() => requireBrowserbaseProjectId({}), /BROWSERBASE_PROJECT_ID/)
  assert.throws(() => requireBrowserbaseProjectId({ BROWSERBASE_PROJECT_ID: "two project ids" }), /BROWSERBASE_PROJECT_ID/)
})

test("eval and scan Browserbase sessions have no direct egress or identifying provider metadata", () => {
  const evalProvider = readFileSync("src/lib/runner/browserbase-provider.server.ts", "utf8")
  const pageScan = readFileSync("src/lib/runner/page-scan.server.ts", "utf8")

  for (const source of [evalProvider, pageScan]) {
    assert.match(source, /requireBrowserbaseExternalEgressConfiguration/)
    assert.match(source, /issueBrowserProxyCredentials/)
    assert.match(source, /requireBrowserbaseProjectId/)
    assert.match(source, /proxies: (?:this\.)?externalEgress\.proxies/)
    assert.match(source, /proxySettings: (?:this\.)?externalEgress\.proxySettings/)
    assert.match(source, /advancedStealth: false/)
    assert.match(source, /solveCaptchas: false/)
    assert.match(source, /ignoreCertificateErrors: false/)
    assert.match(source, /recordSession: false/)
    assert.match(source, /logSession: false/)
    assert.doesNotMatch(source, /proxies:\s*(?:false|true)/)
    assert.doesNotMatch(source, /type:\s*["'](?:none|browserbase)["']/)
    assert.match(source, /userMetadata: \{ mf_intent: creationIntent\.correlationToken \}/)
    assert.doesNotMatch(source, /userMetadata:\s*\{[^}]*(?:runId|agencyId|projectId|url|email)/)
  }
  assert.doesNotMatch(evalProvider, /maintainFlowRunId/)
  assert.match(evalProvider, /subject: browserProxySubjectForRun\(input\.runId\)/)
  assert.match(evalProvider, /sideEffectHosts: allowedDomains/)
  assert.match(evalProvider, /return `run:\$\{canonicalRunId\}`/)
  assert.match(evalProvider, /session connection failed securely/)
  assert.match(pageScan, /subject: `scan:\$\{allowedDomains\[0\]\}`/)
  assert.match(pageScan, /sideEffectHosts: \[\]/)
  assert.match(pageScan, /new Browserbase\(\{ apiKey, maxRetries: 0, timeout: 30_000 \}\)/)
  assert.doesNotMatch(pageScan, /new Browserbase\(\{ apiKey, maxRetries: [1-9]/)
  assert.match(pageScan, /scan session connection failed securely/)
})

test("Browserbase connection secrets stay out of durable workflow session handles", () => {
  const types = readFileSync("src/lib/runner/types.ts", "utf8")
  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
  const handle = types.match(/export type BrowserSessionHandle = \{([\s\S]*?)\n\}/)?.[1] ?? ""
  assert.doesNotMatch(handle, /connectUrl|password|proxy|cookie|storageState/i)
  assert.match(handle, /contextId/)
  assert.match(handle, /lastSessionId/)
  assert.match(handle, /resumeUrl/)
  assert.match(handle, /readyAt/)
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
  assert.match(provider, /allowedDomains,/)
  assert.match(scan, /allowedDomains,/)
  assert.match(provider, /requireBrowserbaseAllowedDomains\(input\.allowedHosts\)/)
  assert.match(scan, /const allowedDomains = requireBrowserbaseAllowedDomains\(input\.allowedHosts\)/)
  assert.match(scan, /assertPublicBrowserTarget\(input\.url, allowedDomains\)/)
  assert.match(scan, /installTopLevelNavigationGuard\(connection\.page, allowedDomains, connection\.networkMode, \{ blockSideEffects: true \}\)/)
  assert.match(scan, /connectScanBrowser\(allowedDomains,/)
  assert.match(provider, /context: \{ id: session\.contextId, persist: true \}/)
  assert.match(provider, /proxies: externalEgress\.proxies/)
  assert.match(scan, /proxies: externalEgress\.proxies/)
})

test("journey scans preserve the complete attested host allowlist across the route boundary", () => {
  const route = readFileSync("src/app/api/journey-scans/route.ts", "utf8")
  const scan = readFileSync("src/lib/runner/page-scan.server.ts", "utf8")

  assert.match(route, /allowedHosts: authorization\.allowedHosts/)
  assert.match(scan, /allowedHosts: string\[\]/)
  assert.match(scan, /connectScanBrowser\(allowedDomains,/)
  assert.doesNotMatch(scan, /assertPublicBrowserTarget\(input\.url, \[new URL\(input\.url\)\.hostname/)
  assert.doesNotMatch(scan, /installTopLevelNavigationGuard\(connection\.page, \[target\.url\.hostname\]/)
})

test("deployment tooling requires the proxy for global and selected-workspace cutovers", () => {
  const readiness = readFileSync("scripts/local-deploy-readiness.mjs", "utf8")
  const envPush = readFileSync("scripts/push-vercel-env.mjs", "utf8")
  const envExample = readFileSync("ENV_EXAMPLE.md", "utf8")

  for (const source of [readiness, envPush, envExample]) {
    assert.match(source, /BROWSERBASE_EGRESS_PROXY_SERVER/)
    assert.match(source, /BROWSERBASE_EGRESS_PROXY_SIGNING_KEY_ID/)
    assert.match(source, /BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64/)
    assert.match(source, /BROWSERBASE_EGRESS_PROXY_AUDIENCE/)
    assert.match(source, /BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID/)
  }
  assert.doesNotMatch(envExample, /BROWSERBASE_EGRESS_PROXY_USERNAME|BROWSERBASE_EGRESS_PROXY_PASSWORD/)
  for (const source of [readiness, envPush]) {
    assert.match(source, /BUSINESS_EVALS_WORKSPACE_ALLOWLIST/)
    assert.match(source, /businessEvalsWorkspaceAllowlist|stagedWorkspaceAllowlist/)
    assert.match(source, /validateBrowserbaseEgressProxy/)
    assert.match(source, /proxyUrl\.port/)
    assert.match(source, /createPrivateKey/)
    assert.match(source, /asymmetricKeyType (?:===|!==) "ed25519"/)
    assert.match(source, /Browserbase egress proxy signing key/)
    assert.match(source, /caCertificateId\.length (?:<=|>) 256/)
  }
  assert.match(readiness, /const required = \[[\s\S]*?BROWSERBASE_PROJECT_ID/)
  assert.match(readiness, /BROWSERBASE_PROJECT_ID identifies one structurally safe Browserbase project/)
  assert.match(readiness, /const required = \[[\s\S]*?BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID/)
  assert.match(envPush, /const businessEvalsCutoverKeys = \[[\s\S]*?BROWSERBASE_PROJECT_ID/)
  assert.match(envPush, /BROWSERBASE_PROJECT_ID must identify one structurally safe Browserbase project/)
  assert.match(envPush, /const businessEvalsCutoverKeys = \[[\s\S]*?BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID/)
  assert.match(envPush, /BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID must be one structurally safe Browserbase certificate ID/)
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
  assert.match(checklist, /prove Browserbase reports no live session during the simulated email wait/)
  assert.match(checklist, /proxy-policy fingerprint/)
  assert.match(checklist, /short-lived signed credential/)
  assert.match(checklist, /Browserbase SDK and gateway accept the full signed-token credential length/)

  assert.match(egressDecision, /external policy gateway required/)
  assert.match(egressDecision, /cannot currently obtain a production-grade SSRF, DNS-rebinding, and unattended WebSocket boundary/)
  assert.match(egressDecision, /does not block iframe\/subframe navigations or in-page requests/)
  assert.match(egressDecision, /resolved_address_filter/)
  assert.match(egressDecision, /stock filter is \*\*not sufficient by itself\*\*/)
  assert.match(egressDecision, /proxySettings\.caCertificates/)
  assert.match(egressDecision, /BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID/)
  assert.match(egressDecision, /BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64/)
  assert.match(egressDecision, /`run:<run UUID>`/)
  assert.match(egressDecision, /read-only scan credential/)
  assert.match(checklist, /BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID/)
  assert.match(egressDecision, /prove no live browser remains during a simulated email wait/)
  assert.match(egressDecision, /gateway outage cannot fall back|external gateway unavailable/)
})
