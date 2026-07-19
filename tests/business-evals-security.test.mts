import assert from "node:assert/strict"
import { generateKeyPairSync, verify } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"

import { journeyDraftSchema, projectAuthorizationSchema, restrictedActionSchema } from "../src/lib/api/business-evals-contracts.ts"
import { journeyTemplateDefinition } from "../src/lib/evals/templates.ts"
import {
  createEvalRecipient,
  createJourneyForwardingRecipient,
  deriveEvalEmailHookToken,
  extractAllowlistedVerificationLink,
  inboundMessageContainsMarker,
  journeyIdFromForwardingRecipient,
  recipientHash,
  recipientMatchesRun,
  safeInboundEmailMetadata,
  submittedMarkerForRun,
} from "../src/lib/email/eval-inbound.ts"
import { nextWebhookAttemptAt, signAlertWebhook } from "../src/lib/alerts/outbound-webhook.ts"
import {
  cleanupWebhookAudience,
  cleanupWebhookEventId,
  cleanupWebhookJwk,
  cleanupWebhookSigningInput,
  createCleanupWebhookEnvelope,
  loadCleanupSigningKey,
  signCleanupWebhook,
} from "../src/lib/runner/cleanup-webhook-signing.ts"
import {
  createReportShareToken,
  deriveIdempotentReportShareToken,
  hashReportShareToken,
  isReportShareToken,
  reportSafeScreenshotIds,
  redactSharedReportSnapshot,
  reportShareExpiry,
} from "../src/lib/reports/share-links.ts"

const secret = "maintain-flow-eval-email-routing-secret-for-tests"

test("restricted browser actions reject arbitrary scripts and selector escape hatches", () => {
  assert.equal(restrictedActionSchema.safeParse({
    id: "run-code",
    label: "Run JavaScript",
    type: "script",
    javascript: "document.cookie",
    timeoutMs: 1_000,
  }).success, false)
  assert.equal(restrictedActionSchema.safeParse({
    id: "css-click",
    label: "Click",
    type: "click",
    locator: { kind: "css", value: "#submit" },
    timeoutMs: 1_000,
  }).success, false)
  assert.equal(restrictedActionSchema.safeParse({
    id: "label-fill",
    label: "Email",
    type: "fill",
    locator: { kind: "label", value: "Email" },
    valueKey: "email",
    timeoutMs: 1_000,
  }).success, true)
})

test("journey drafts preserve an approved stage timing threshold", () => {
  const contracts = readFileSync("src/lib/api/business-evals-contracts.ts", "utf8")
  assert.match(contracts, /timingThresholdMs: z\.number\(\)\.int\(\)\.min\(1\)\.max\(120_000\)\.nullable\(\)/)
})

test("journey draft keys and cleanup modes fail at the API boundary when the database would reject them", () => {
  const projectId = "019f7576-dbaa-7a02-9787-d0f9a03b48e4"
  const invalidKey = journeyTemplateDefinition("lead_form", "https://www.example.com/contact")
  invalidKey.stages[0].key = "page-loaded"
  assert.equal(journeyDraftSchema.safeParse({ projectId, name: "Lead form", draftRevision: 0, ...invalidKey }).success, false)

  const mixedCleanup = journeyTemplateDefinition("trial_signup", "https://app.example.com/signup")
  const cleanup = mixedCleanup.stages.at(-1)?.actions.find((action) => action.type === "cleanup")
  assert.ok(cleanup?.type === "cleanup")
  Object.assign(cleanup, { webhookUrl: "https://app.example.com/cleanup" })
  assert.equal(journeyDraftSchema.safeParse({ projectId, name: "Trial signup", draftRevision: 0, ...mixedCleanup }).success, false)
})

test("journey URLs normalize to the database contract and malformed URLs fail without throwing", () => {
  const projectId = "019f7576-dbaa-7a02-9787-d0f9a03b48e4"
  const uppercase = journeyTemplateDefinition("lead_form", "HTTPS://APP.EXAMPLE.COM/contact path")
  const parsed = journeyDraftSchema.safeParse({ projectId, name: "Lead form", draftRevision: 0, ...uppercase })
  assert.equal(parsed.success, true)
  if (parsed.success) assert.equal(parsed.data.startUrl, "https://app.example.com/contact%20path")

  const credentialed = journeyTemplateDefinition("lead_form", "https://app.example.com/contact")
  credentialed.startUrl = "https://user:" + "secret@app.example.com/contact"
  const credentialedNavigation = credentialed.stages.flatMap((stage) => stage.actions).find((action) => action.type === "navigate")
  assert.ok(credentialedNavigation?.type === "navigate")
  credentialedNavigation.url = credentialed.startUrl
  assert.equal(journeyDraftSchema.safeParse({ projectId, name: "Lead form", draftRevision: 0, ...credentialed }).success, false)
  const malformed = journeyTemplateDefinition("lead_form", "https://app.example.com/contact")
  malformed.startUrl = "https://app.example.com:bad/contact"
  const navigation = malformed.stages.flatMap((stage) => stage.actions).find((action) => action.type === "navigate")
  assert.ok(navigation?.type === "navigate")
  navigation.url = malformed.startUrl
  const parseMalformed = () => journeyDraftSchema.safeParse({ projectId, name: "Lead form", draftRevision: 0, ...malformed })
  assert.doesNotThrow(parseMalformed)
  assert.equal(parseMalformed().success, false)
})

test("project authorizations accept only exact public project domains", () => {
  const contracts = readFileSync("src/lib/api/business-evals-contracts.ts", "utf8")
  const projects = readFileSync("src/lib/api/projects.server.ts", "utf8")
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
  assert.match(projects, /if \(domain !== projectHost\)/)
  assert.match(contracts, /isReservedPrivateHostname/)
  assert.match(migration, /localhost\|local\|internal\|home\\\.arpa/)

  for (const domain of ["foo_bar.com", "-foo.com", "foo-.com", "example.com."]) {
    assert.equal(projectAuthorizationSchema.safeParse({
      projectId: "019f7576-dbaa-7a02-9787-d0f9a03b48e4",
      domain,
      attestationVersion: "2026-07-18",
      attested: true,
      approvedActionDomains: [domain],
    }).success, false, `${domain} must fail before the database boundary`)
  }
})

test("launch templates cannot publish without their deterministic business outcome", () => {
  const projectId = "019f7576-dbaa-7a02-9787-d0f9a03b48e4"
  const lead = journeyTemplateDefinition("lead_form", "https://www.example.com/contact")
  assert.equal(journeyDraftSchema.safeParse({ projectId, name: "Lead form", draftRevision: 0, ...lead }).success, true)
  assert.equal(journeyDraftSchema.safeParse({
    projectId,
    name: "Reachable page only",
    draftRevision: 0,
    template: "lead_form",
    startUrl: "https://www.example.com/contact",
    emailProofConfigured: false,
    cleanupMode: "none",
    stages: [{
      key: "page",
      name: "Page",
      position: 0,
      required: true,
      cleanup: false,
      expected: "The page opens.",
      businessImpact: "None proved.",
      actions: [{ id: "open", label: "Open", type: "navigate", url: "https://www.example.com/contact", timeoutMs: 1_000 }],
    }],
  }).success, false)

  const trial = journeyTemplateDefinition("trial_signup", "https://app.example.com/signup")
  assert.equal(journeyDraftSchema.safeParse({ projectId, name: "Trial signup", draftRevision: 0, ...trial }).success, true)
})

test("opaque run recipients and workflow hook tokens are deterministic without exposing the run id", () => {
  const address = createEvalRecipient({ runId: "run-123", secret, domain: "inbound.maintainflow.io" })
  assert.match(address, /^run-[a-z0-9_-]{32}@inbound\.maintainflow\.io$/)
  assert.doesNotMatch(address, /run-123/)
  assert.equal(recipientMatchesRun(address, "run-123", secret), true)
  assert.equal(recipientMatchesRun(address, "run-456", secret), false)
  assert.match(recipientHash(address), /^[a-f0-9]{64}$/)
  assert.doesNotMatch(deriveEvalEmailHookToken("run-123", secret), /run-123/)
})

test("forwarded lead proof uses an authenticated stable journey alias and an exact run marker", () => {
  const journeyId = "019f7576-dbaa-7a02-9787-d0f9a03b48e4"
  const runId = "019f7576-1baa-7a02-9787-d0f9a03b48e4"
  const address = createJourneyForwardingRecipient({ journeyId, secret, domain: "inbound.maintainflow.io" })
  const marker = submittedMarkerForRun(runId)

  assert.match(address, /^journey-019f7576-dbaa-7a02-9787-d0f9a03b48e4-[a-f0-9]{16}@inbound\.maintainflow\.io$/)
  assert.equal(journeyIdFromForwardingRecipient(address, secret), journeyId)
  assert.equal(journeyIdFromForwardingRecipient(address.replace(/-[a-f0-9]{16}@/, "-0000000000000000@"), secret), null)
  assert.equal(inboundMessageContainsMarker({ marker, subject: `New lead ${marker}` }), true)
  assert.equal(inboundMessageContainsMarker({ marker, text: `${marker}EXTRA` }), false)
  assert.equal(inboundMessageContainsMarker({ marker, html: `<p>${marker}</p>` }), true)
})

test("one stored synthetic marker is used by enqueue, submission, forwarding proof, evidence and cleanup", () => {
  const marker = submittedMarkerForRun("019f7576-1baa-4a02-9787-d0f9a03b48e4")
  assert.match(marker, /^MF-EVAL-[A-F0-9]{20}$/)

  const manualEnqueue = readFileSync("src/lib/api/eval-runs.server.ts", "utf8")
  const scheduledEnqueue = readFileSync("src/lib/workflows/scheduled-evals.server.ts", "utf8")
  const runner = readFileSync("src/workflows/eval-run.ts", "utf8")
  const inbound = readFileSync("src/lib/email/resend-inbound.server.ts", "utf8")
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")

  assert.match(manualEnqueue, /p_synthetic_marker: submittedMarkerForRun\(markerSeed\)/)
  assert.match(scheduledEnqueue, /p_synthetic_marker: submittedMarkerForRun\(crypto\.randomUUID\(\)\)/)
  assert.match(runner, /const syntheticMarker = String\(run\.synthetic_marker\)/)
  assert.match(runner, /synthetic_marker: context\.syntheticMarker/)
  assert.match(runner, /syntheticMarker: context\.syntheticMarker/)
  assert.match(inbound, /recipient_hash,synthetic_marker,status/)
  assert.match(inbound, /marker: String\(candidate\.synthetic_marker\)/)
  assert.match(migration, /synthetic_marker ~ '\^MF-EVAL-\[A-F0-9\]\{20\}\$'/)
})

test("forwarded email proof requires a marker-bearing message fill and trial verification stays autoresponse-only", () => {
  const projectId = "019f7576-dbaa-7a02-9787-d0f9a03b48e4"
  const base = journeyTemplateDefinition("lead_form", "https://www.example.com/contact")
  const forwardedWait = {
    id: "wait-forwarded",
    label: "Wait for forwarded lead",
    timeoutMs: 60_000,
    type: "wait_for_email" as const,
    recipientKey: "forwarding" as const,
    proofMode: "forwarded_marker" as const,
    thresholdSeconds: 120,
    maximumWaitSeconds: 600,
  }
  const withoutMarker = {
    projectId,
    name: "Forwarded lead",
    draftRevision: 0,
    ...base,
    emailProofConfigured: true,
    stages: [...base.stages, {
      key: "email_proof",
      name: "Email proof",
      position: base.stages.length,
      required: true,
      cleanup: false,
      actions: [forwardedWait],
      expected: "The forwarded lead arrives.",
      businessImpact: "The destination inbox receives the enquiry.",
      timingThresholdMs: null,
    }],
  }
  assert.equal(journeyDraftSchema.safeParse(withoutMarker).success, false)

  const markerFill = {
    id: "fill-marker",
    label: "Add synthetic marker",
    timeoutMs: 10_000,
    type: "fill" as const,
    operation: "text" as const,
    locator: { kind: "label" as const, value: "Message" },
    valueKey: "message",
  }
  const withMarker = structuredClone(withoutMarker)
  withMarker.stages[1].actions.splice(withMarker.stages[1].actions.length - 1, 0, markerFill)
  assert.equal(journeyDraftSchema.safeParse(withMarker).success, true)

  const trial = journeyTemplateDefinition("trial_signup", "https://app.example.com/signup")
  const trialWait = trial.stages.flatMap((stage) => stage.actions).find((action) => action.type === "wait_for_email")
  assert.equal(trialWait?.type === "wait_for_email" && trialWait.proofMode, "autoresponse")
})

test("lead autoresponse proof requires the generated run email to be submitted", () => {
  const projectId = "019f7576-dbaa-7a02-9787-d0f9a03b48e4"
  const base = journeyTemplateDefinition("lead_form", "https://www.example.com/contact")
  const withoutEmail = structuredClone(base)
  withoutEmail.stages[1].actions = withoutEmail.stages[1].actions.map((action) =>
    action.type === "fill" ? { ...action, valueKey: "name" } : action)
  withoutEmail.stages.push({
    key: "email_proof",
    name: "Email proof",
    position: withoutEmail.stages.length,
    required: true,
    cleanup: false,
    actions: [{
      id: "wait-autoresponse",
      label: "Wait for autoresponse",
      timeoutMs: 60_000,
      type: "wait_for_email",
      recipientKey: "email",
      proofMode: "autoresponse",
      thresholdSeconds: 120,
      maximumWaitSeconds: 600,
    }],
    expected: "The autoresponse arrives.",
    businessImpact: "The sender receives confirmation.",
    timingThresholdMs: null,
  })
  withoutEmail.emailProofConfigured = true
  assert.equal(journeyDraftSchema.safeParse({ projectId, name: "Lead autoresponse", draftRevision: 0, ...withoutEmail }).success, false)
})

test("email extraction accepts only HTTPS links on approved hosts and stores safe metadata", () => {
  const link = extractAllowlistedVerificationLink({
    text: "Ignore http://accounts.example.com/unsafe and https://attacker.test/x",
    html: '<a href="https://verify.example.com/confirm?token=abc&amp;run=1">Verify</a>',
    rules: [{ host: "verify.example.com", pathPrefix: "/confirm", requiredText: "Verify", requiredQueryParameter: "token" }],
  })
  assert.equal(link, "https://verify.example.com/confirm?token=abc&run=1")

  const metadata = safeInboundEmailMetadata({
    emailId: "email-1",
    messageId: "<secret-message-id>",
    from: "Example <hello@example.com>",
    to: ["run-marker@inbound.maintainflow.io"],
    subject: "Verify secret marker",
    createdAt: "2026-07-18T12:00:00.000Z",
    link,
  })
  assert.equal(metadata.senderDomain, "example.com")
  assert.equal("subject" in metadata, false)
  assert.equal("messageId" in metadata, false)
})

test("signed inbound routing binds autoresponses to a run and forwarded notifications to one exact marker", () => {
  const inbound = readFileSync("src/lib/email/resend-inbound.server.ts", "utf8")
  assert.match(inbound, /resend\.webhooks\.verify/)
  assert.match(inbound, /recipientMatchesRun\(address, String\(candidate\.id\), routingSecret\)/)
  assert.match(inbound, /journeyIdFromForwardingRecipient\(address, routingSecret\)/)
  assert.match(inbound, /inboundMessageContainsMarker/)
  assert.match(inbound, /markerMatches\.length === 1/)
  assert.match(inbound, /rules\.proofMode === "forwarded_marker"/)
  assert.match(inbound, /markerMatched: proofMode === "forwarded_marker"/)
  assert.match(inbound, /retrievedContentBytes > 2_000_000/)
  assert.doesNotMatch(inbound, /payload_summary_json:\s*receiving\.data/)
  assert.doesNotMatch(inbound, /rawBody:\s*input\.rawBody/)
})

test("outbound webhook signing is stable and retry schedule backs off", () => {
  const payload = JSON.stringify({ id: "event-1" })
  assert.equal(
    signAlertWebhook(payload, "outbound-webhook-secret-with-at-least-thirty-two-chars", 1_700_000_000),
    signAlertWebhook(payload, "outbound-webhook-secret-with-at-least-thirty-two-chars", 1_700_000_000)
  )
  assert.equal(nextWebhookAttemptAt(8, 0), null)
  assert.equal(nextWebhookAttemptAt(1, 0), "1970-01-01T00:01:00.000Z")
  assert.equal(nextWebhookAttemptAt(4, 0), "1970-01-01T00:08:00.000Z")
})

test("customer-owned cleanup hooks use a platform-verifiable Ed25519 signature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const signingKey = loadCleanupSigningKey({
    EVAL_CLEANUP_SIGNING_KEY_ID: "cleanup-2026-01",
    EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  })
  const runId = "019f7576-1baa-4a02-9787-d0f9a03b48e4"
  const journeyId = "019f7576-dbaa-4a02-9787-d0f9a03b48e4"
  const timestamp = 1_700_000_000
  const target = "https://app.example.com/evals/cleanup?tenant=one#local-fragment"
  const envelope = createCleanupWebhookEnvelope({
    runId,
    journeyId,
    syntheticMarker: submittedMarkerForRun(runId),
    target,
    issuedAt: timestamp,
  })
  const payload = JSON.stringify(envelope)
  const signature = signCleanupWebhook(payload, envelope.issuedAt, signingKey)

  assert.equal(
    verify(null, cleanupWebhookSigningInput(payload, envelope.issuedAt), publicKey, Buffer.from(signature, "base64url")),
    true
  )
  assert.equal(envelope.eventId, cleanupWebhookEventId(runId))
  assert.equal(envelope.audience, cleanupWebhookAudience(target))
  assert.equal(envelope.audience, cleanupWebhookAudience(target.replace("#local-fragment", "#ignored")))
  assert.notEqual(envelope.audience, cleanupWebhookAudience(target.replace("tenant=one", "tenant=two")))

  const replayedToAnotherAudience = JSON.stringify({ ...envelope, audience: cleanupWebhookAudience("https://other.example.com/evals/cleanup") })
  const replayedWithAnotherEventId = JSON.stringify({ ...envelope, eventId: `${envelope.eventId}:replay` })
  assert.equal(
    verify(null, cleanupWebhookSigningInput(replayedToAnotherAudience, timestamp), publicKey, Buffer.from(signature, "base64url")),
    false
  )
  assert.equal(
    verify(null, cleanupWebhookSigningInput(replayedWithAnotherEventId, timestamp), publicKey, Buffer.from(signature, "base64url")),
    false
  )

  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
  assert.match(workflow, /"Idempotency-Key": envelope\.eventId/)
  assert.match(workflow, /"X-MaintainFlow-Timestamp": String\(envelope\.issuedAt\)/)
  assert.deepEqual(cleanupWebhookJwk(signingKey), {
    ...publicKey.export({ format: "jwk" }),
    alg: "EdDSA",
    kid: "cleanup-2026-01",
    use: "sig",
  })
  assert.throws(
    () => loadCleanupSigningKey({ EVAL_CLEANUP_SIGNING_KEY_ID: "bad key id", EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64: "x" }),
    /key identifier/
  )
})

test("report share links store only a peppered hash and redact private diagnostics", () => {
  const token = createReportShareToken()
  const hash = hashReportShareToken(token, "report-share-token-pepper-with-at-least-thirty-two-chars")
  assert.equal(isReportShareToken(token), true)
  assert.equal(isReportShareToken("not-a-valid-token"), false)
  assert.equal(isReportShareToken(`${"a".repeat(32)}?private=query`), false)
  assert.match(token, /^[A-Za-z0-9_-]+$/)
  assert.match(hash, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(hash, new RegExp(token))
  assert.equal(reportShareExpiry(1, 0), "1970-01-01T01:00:00.000Z")
  assert.equal(
    deriveIdempotentReportShareToken({
      reportId: "report-1",
      idempotencyKey: "share-request-123",
      expiresInHours: 24,
      pepper: "report-share-token-pepper-with-at-least-thirty-two-chars",
    }),
    deriveIdempotentReportShareToken({
      reportId: "report-1",
      idempotencyKey: "share-request-123",
      expiresInHours: 24,
      pepper: "report-share-token-pepper-with-at-least-thirty-two-chars",
    })
  )
  assert.notEqual(
    deriveIdempotentReportShareToken({
      reportId: "report-1",
      idempotencyKey: "share-request-123",
      expiresInHours: 1,
      pepper: "report-share-token-pepper-with-at-least-thirty-two-chars",
    }),
    deriveIdempotentReportShareToken({
      reportId: "report-1",
      idempotencyKey: "share-request-123",
      expiresInHours: 24,
      pepper: "report-share-token-pepper-with-at-least-thirty-two-chars",
    })
  )
  assert.deepEqual(
    redactSharedReportSnapshot({
      status: "passed",
      evidence: { reportSafe: true, signedUrl: "secret", storagePath: "private", caption: "Passed" },
      trace: { content: "private" },
    }),
    { status: "passed", evidence: { reportSafe: true, caption: "Passed" } }
  )
  assert.deepEqual([...reportSafeScreenshotIds({
    evidenceSummaries: [{ stages: [{ artifacts: [
      { artifactId: "55555555-5555-4555-8555-555555555555", kind: "screenshot", mimeType: "image/png" },
      { artifactId: "66666666-6666-4666-8666-666666666666", kind: "trace", mimeType: "application/zip" },
    ] }] }],
    futurePrivateField: { artifacts: [
      { artifactId: "77777777-7777-4777-8777-777777777777", kind: "screenshot", mimeType: "image/png" },
    ] },
  })], ["55555555-5555-4555-8555-555555555555"])
})
