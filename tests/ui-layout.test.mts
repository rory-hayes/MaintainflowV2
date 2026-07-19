import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("report readiness pills keep labels and status badges on separate rows", () => {
  const source = readFileSync("src/components/app/maintainflow-screen.tsx", "utf8")

  assert.match(source, /function ReportReadinessPill/)
  assert.match(source, /min-h-24 flex-col items-start justify-between/)
  assert.match(source, /block text-wrap text-xs leading-5/)
  assert.match(source, /flex w-full items-center justify-between/)
  assert.match(source, /className="shrink-0"/)
})

test("guided workflow retries retain the inline client created before endpoint testing", () => {
  const source = readFileSync("src/components/app/maintainflow-screen.tsx", "utf8")

  assert.match(
    source,
    /if \(activeClientId === "new"\) \{[\s\S]*?const existingClientIds = new Set[\s\S]*?await core\.createClient[\s\S]*?!existingClientIds\.has\(client\.id\)[\s\S]*?activeClientId = createdClient\.id[\s\S]*?setClientId\(activeClientId\)[\s\S]*?testResult/
  )
})

test("workflow and issue switches expose explicit accessible names", () => {
  const source = readFileSync("src/components/app/maintainflow-screen.tsx", "utf8")

  assert.match(source, /aria-label="Include workflow in client reports"/)
  assert.match(source, /aria-label="Include issue in client reports"/)
  assert.match(source, /aria-label="Mark note as report-safe"/)
})

test("workflow setup refuses credential-dependent scheduled monitors before creating records", () => {
  const source = readFileSync("src/components/app/maintainflow-screen.tsx", "utf8")

  assert.match(source, /const workflowHeaders = currentHeaders\(\)[\s\S]*?const monitorViolation = savedMonitorPolicyViolation\([\s\S]*?headers: workflowHeaders[\s\S]*?if \(monitorViolation\) throw new Error\(monitorViolation\)[\s\S]*?if \(activeClientId === "new"\)/)
  assert.match(source, /Saved monitors cannot include authentication, query secrets, custom headers, or a request body/)
})

test("report and Scale limit controls keep customers inside valid self-serve actions", () => {
  const source = readFileSync("src/components/app/maintainflow-screen.tsx", "utf8")

  assert.match(source, /disabled=\{!clientId \|\| !!reportEvidenceError \|\| generating\}/)
  assert.match(source, /const highestSelfServeLimit = currentPlan\.id === "scale" \|\| currentPlan\.id === "agency_plus"/)
  assert.match(source, /Self-serve capacity reached/)
  assert.match(source, /Archive inactive clients or workflows, or wait for the monthly report allowance to reset/)
  assert.match(source, /highestSelfServeLimit \? \([\s\S]*?Review clients[\s\S]*?Review workflows[\s\S]*?: \([\s\S]*?Upgrade plan/)
})

test("multi-check workflow UI uses aggregate state and runs every active check", () => {
  const screen = readFileSync("src/components/app/maintainflow-screen.tsx", "utf8")
  const hook = readFileSync("src/hooks/use-core-loop.ts", "utf8")
  const localStore = readFileSync("src/lib/core/local-store.ts", "utf8")

  assert.match(screen, /<Badge variant=\{statusVariant\(workflow\.status\)\}>[\s\S]*?workflowStatusLabel\(workflow\)/)
  assert.doesNotMatch(screen, /statusVariant\(lastRun\?\.status \?\? workflow\.status\)/)
  assert.match(screen, /<CardTitle>Active check states<\/CardTitle>/)
  assert.match(screen, /checks\.length \? checks\.map\(\(check\) =>/)
  assert.match(screen, /activeChecks\.length > 1[\s\S]*?`Run all \(\$\{activeChecks\.length\}\)`/)
  assert.match(screen, /workflowChecksForWorkflow\(core, workflow\)\.some\(\(check\) =>/)

  assert.match(hook, /const activeChecks = currentDatabase\.checks\.filter[\s\S]*?for \(const check of activeChecks\)/)
  assert.match(hook, /endpointInputFromSavedCheck\(\{[\s\S]*?configJson: check\.configJson[\s\S]*?assertions: check\.assertions/)
  assert.match(hook, /workflow\.id,[\s\S]*?check\.id,[\s\S]*?result/)
  assert.match(localStore, /attempt\.workflowId,[\s\S]*?attempt\.checkId,[\s\S]*?attempt\.result/)
})
