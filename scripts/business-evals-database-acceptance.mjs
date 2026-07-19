import assert from "node:assert/strict"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Client } from "pg"

const adminUrl = process.env.BUSINESS_EVALS_TEST_ADMIN_URL || "postgresql:///postgres"
const databaseName = `mf_business_evals_acceptance_${randomBytes(6).toString("hex")}`
assert.match(databaseName, /^[a-z0-9_]+$/)

const admin = new Client({ connectionString: adminUrl })
let database
let adminConnected = false

try {
  await admin.connect()
  adminConnected = true
  await admin.query(`create database "${databaseName}"`)
  database = new Client({ connectionString: databaseUrl(adminUrl, databaseName) })
  await database.connect()

  await database.query(supabasePrelude())
  const canonical = readFileSync("supabase/maintainflow_schema.sql", "utf8")
  const extensionMarker = "-- Business-evals fresh-schema extension."
  const markerIndex = canonical.indexOf(extensionMarker)
  assert.ok(markerIndex > 0, "The canonical schema must retain the legacy-to-additive split marker.")
  await database.query(`${canonical.slice(0, markerIndex)}\ncommit;`)

  const ids = await seedLegacyWorkspace(database)
  const before = await legacySnapshot(database, ids)
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
  await database.query(migration)
  await database.query(migration)
  const after = await legacySnapshot(database, ids)

  assert.deepEqual(after.counts, before.counts, "The additive migration must not drop or duplicate legacy rows.")
  assert.equal(after.client.project_kind, "client_site")
  assert.equal(after.workflow.journey_template, "legacy_endpoint")
  assert.equal(after.workflow.endpoint_url, before.workflow.endpoint_url)
  assert.equal(after.issue.status, "resolved")
  assert.equal(after.issue.verification_run_id, before.issue.verification_run_id)
  assert.equal(after.issue.report_safe_summary, before.issue.report_safe_summary)
  assert.equal(after.report.evidence_fingerprint, before.report.evidence_fingerprint)
  assert.equal(after.report.snapshot_json.legacyProof, true)

  const claimed = await database.query(
    "select * from public.claim_due_checks($1,$2,$3)",
    [10, 180, "business-evals-acceptance"]
  )
  assert.equal(claimed.rowCount, 1, "The migrated legacy endpoint check must remain schedulable.")
  assert.equal(claimed.rows[0].workflow_id, ids.workflowId)

  await proveTenantAndPrivilegeBoundaries(database, ids)
  const safetyProof = await proveQueuedKillAndCaptchaSafety(database, ids)
  const archiveProof = await proveJourneyArchiveRestore(database, ids)
  const lifecycleProof = await proveBusinessEvalsLifecycle(database, ids)

  process.stdout.write(`${JSON.stringify({
    result: "passed",
    migratedRows: after.counts,
    legacyEndpointClaimed: claimed.rows[0].workflow_id,
    evidenceFingerprintPreserved: after.report.evidence_fingerprint,
    resolvedIncidentPreserved: after.issue.id,
    crossTenantDenied: true,
    authenticatedClientWorkflowWritesDenied: true,
    queuedRunStoppedBeforeExecution: safetyProof.queuedRunStoppedBeforeExecution,
    captchaPausedJourneyAndSchedule: safetyProof.captchaPausedJourneyAndSchedule,
    captchaVerdict: safetyProof.captchaVerdict,
    journeyArchivePreservedEvidence: archiveProof.preservedEvidence,
    journeyRestoreRemainedPaused: archiveProof.restoredPaused,
    journeyArchiveTenantBoundaryDenied: archiveProof.crossTenantDenied,
    launchTemplatesPublished: lifecycleProof.launchTemplatesPublished,
    supervisedSchedulesEnabled: lifecycleProof.supervisedSchedulesEnabled,
    incidentRecoveryVerified: lifecycleProof.incidentRecoveryVerified,
    cancellationReplaySafe: lifecycleProof.cancellationReplaySafe,
    reportSnapshotCreated: lifecycleProof.reportSnapshotCreated,
    shareLinkRevoked: lifecycleProof.shareLinkRevoked,
    shareRevocationReplaySafe: lifecycleProof.shareRevocationReplaySafe,
    hardRunQuotaEnforced: lifecycleProof.hardRunQuotaEnforced,
    publishContractParity: lifecycleProof.publishContractParity,
  }, null, 2)}\n`)
} finally {
  if (database) await database.end().catch(() => undefined)
  if (adminConnected) {
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [databaseName]
    ).catch(() => undefined)
    await admin.query(`drop database if exists "${databaseName}"`).catch(() => undefined)
    await admin.end().catch(() => undefined)
  }
}

function databaseUrl(connectionString, nextDatabase) {
  const parsed = new URL(connectionString)
  parsed.pathname = `/${nextDatabase}`
  return parsed.toString()
}

function supabasePrelude() {
  return `
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text not null default '',
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select string_to_array(name, '/')
$$;
grant usage on schema auth, storage to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;
`
}

async function seedLegacyWorkspace(client) {
  const userId = randomUUID()
  const otherUserId = randomUUID()
  const agencyId = randomUUID()
  const otherAgencyId = randomUUID()
  const clientId = randomUUID()
  const otherClientId = randomUUID()
  const workflowId = randomUUID()
  const checkId = randomUUID()
  const issueId = randomUUID()
  const sourceRunId = randomUUID()
  const verificationRunId = randomUUID()
  const reportId = randomUUID()
  const fingerprint = "legacy-fingerprint-preserved"

  await client.query(
    "insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3::jsonb),($4,$5,$6::jsonb)",
    [userId, "owner@example.com", JSON.stringify({ name: "Owner" }), otherUserId, "other@example.com", JSON.stringify({ name: "Other" })]
  )
  await client.query(
    "insert into public.agencies(id,name,slug) values ($1,$2,$3),($4,$5,$6)",
    [agencyId, "Acceptance workspace", `acceptance-${agencyId.slice(0, 8)}`, otherAgencyId, "Other workspace", `other-${otherAgencyId.slice(0, 8)}`]
  )
  await client.query(
    "insert into public.memberships(agency_id,user_id,role) values ($1,$2,'owner'),($3,$4,'owner')",
    [agencyId, userId, otherAgencyId, otherUserId]
  )
  await client.query(
    "insert into public.clients(id,agency_id,name,slug,website,owner_user_id) values ($1,$2,$3,$4,$5,$6),($7,$8,$9,$10,$11,$12)",
    [
      clientId, agencyId, "Legacy client", "legacy-client", "https://legacy.example.com", userId,
      otherClientId, otherAgencyId, "Other client", "other-client", "https://other.example.com", otherUserId,
    ]
  )
  await client.query(
    `insert into public.workflows(
      id,agency_id,client_id,name,endpoint_url,method,auth_type,encrypted_auth_config,request_body,
      expected_status,timeout_seconds,max_latency_ms,frequency_minutes,retries,report_included,store_raw_response,status
    ) values ($1,$2,$3,$4,$5,'GET','none',$6::jsonb,'',200,10,5000,60,2,true,false,'healthy')`,
    [workflowId, agencyId, clientId, "Legacy health endpoint", "https://legacy.example.com/health", JSON.stringify({ headers: [] })]
  )
  await client.query(
    `insert into public.checks(
      id,agency_id,workflow_id,name,type,plugin_id,enabled,pending_setup,config_json,assertions_json,
      schedule_minutes,next_run_at
    ) values ($1,$2,$3,$4,'health','endpoint',true,false,'{}'::jsonb,'[]'::jsonb,60,now() - interval '1 minute')`,
    [checkId, agencyId, workflowId, "Legacy endpoint check"]
  )
  const sourceStartedAt = new Date(Date.now() - 4 * 60 * 60_000).toISOString()
  const sourceCompletedAt = new Date(Date.parse(sourceStartedAt) + 2_000).toISOString()
  const repairRecordedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
  const verificationStartedAt = new Date(Date.now() - 90 * 60_000).toISOString()
  const verificationCompletedAt = new Date(Date.parse(verificationStartedAt) + 1_000).toISOString()
  await client.query(
    `insert into public.check_runs(
      id,agency_id,client_id,workflow_id,check_id,evidence_origin,status,status_code,latency_ms,
      assertion_results_json,result_json,safe_response_summary,error_message,started_at,completed_at
    ) values
      ($1,$2,$3,$4,$5,'service','failed',500,900,'[]'::jsonb,'{}'::jsonb,'Endpoint returned 500.','HTTP 500',$6,$7),
      ($8,$2,$3,$4,$5,'service','healthy',200,420,'[]'::jsonb,'{}'::jsonb,'Endpoint returned 200.','',$9,$10)`,
    [
      sourceRunId, agencyId, clientId, workflowId, checkId, sourceStartedAt, sourceCompletedAt,
      verificationRunId, verificationStartedAt, verificationCompletedAt,
    ]
  )
  await client.query(
    `insert into public.issues(
      id,agency_id,client_id,workflow_id,check_run_id,check_id,dedupe_key,severity,status,title,description,reportable,
      occurrence_count,repair_recorded_at,resolved_at,verification_run_id,resolution_note,report_safe_summary
    ) values ($1,$2,$3,$4,$5,$6,$7,'medium','resolved',$8,$9,true,1,$10,$11,$12,$13,$14)`,
    [
      issueId, agencyId, clientId, workflowId, sourceRunId, checkId, `legacy:${issueId}`, "Resolved legacy incident",
      "The endpoint was repaired.", repairRecordedAt, verificationCompletedAt, verificationRunId, "Updated the endpoint configuration.",
      "A newer passing deterministic endpoint check proved recovery.",
    ]
  )
  await client.query(
    `insert into public.reports(
      id,agency_id,client_id,period_start,period_end,status,narrative,metrics_json,snapshot_version,
      snapshot_json,evidence_fingerprint
    ) values ($1,$2,$3,current_date - 7,current_date,'draft',$4,$5::jsonb,1,$6::jsonb,$7)`,
    [
      reportId, agencyId, clientId, "Legacy evidence snapshot",
      JSON.stringify({ checksRun: 1, passRate: 100 }),
      JSON.stringify({ legacyProof: true, workflowId }), fingerprint,
    ]
  )

  return { userId, otherUserId, agencyId, otherAgencyId, clientId, otherClientId, workflowId, checkId, issueId, reportId }
}

async function legacySnapshot(client, ids) {
  const counts = (await client.query(`
    select
      (select count(*)::integer from public.clients) as clients,
      (select count(*)::integer from public.workflows) as workflows,
      (select count(*)::integer from public.checks) as checks,
      (select count(*)::integer from public.issues) as issues,
      (select count(*)::integer from public.reports) as reports
  `)).rows[0]
  const clientRow = (await client.query("select * from public.clients where id=$1", [ids.clientId])).rows[0]
  const workflow = (await client.query("select * from public.workflows where id=$1", [ids.workflowId])).rows[0]
  const issue = (await client.query("select * from public.issues where id=$1", [ids.issueId])).rows[0]
  const report = (await client.query("select * from public.reports where id=$1", [ids.reportId])).rows[0]
  return { counts, client: clientRow, workflow, issue, report }
}

async function proveTenantAndPrivilegeBoundaries(client, ids) {
  const privileges = await client.query(`
    select
      has_table_privilege('authenticated','public.clients','select') as clients_select,
      has_table_privilege('authenticated','public.clients','insert') as clients_insert,
      has_table_privilege('authenticated','public.clients','update') as clients_update,
      has_table_privilege('authenticated','public.clients','delete') as clients_delete,
      has_table_privilege('authenticated','public.workflows','select') as workflows_select,
      has_table_privilege('authenticated','public.workflows','insert') as workflows_insert,
      has_table_privilege('authenticated','public.workflows','update') as workflows_update,
      has_table_privilege('authenticated','public.workflows','delete') as workflows_delete
  `)
  assert.deepEqual(privileges.rows[0], {
    clients_select: true,
    clients_insert: false,
    clients_update: false,
    clients_delete: false,
    workflows_select: true,
    workflows_insert: false,
    workflows_update: false,
    workflows_delete: false,
  })

  await client.query("set role authenticated")
  try {
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [ids.userId])
    const own = await client.query("select id from public.clients order by id")
    assert.deepEqual(own.rows.map((row) => row.id), [ids.clientId])
    const crossTenant = await client.query("select id from public.clients where id=$1", [ids.otherClientId])
    assert.equal(crossTenant.rowCount, 0)
    await assert.rejects(
      client.query("update public.clients set name='Bypass' where id=$1", [ids.clientId]),
      /permission denied/
    )
  } finally {
    await client.query("reset role")
  }
}

async function proveQueuedKillAndCaptchaSafety(client, ids) {
  const journeyId = randomUUID()
  const authorizationId = randomUUID()
  const versionId = randomUUID()
  const businessStageId = randomUUID()
  const cleanupStageId = randomUUID()
  const scheduleId = randomUUID()
  const cancelledRunId = randomUUID()
  const captchaRunId = randomUUID()
  const dispatchWorkerId = "database-acceptance-dispatch"
  const runWorkerId = "database-acceptance-runner"

  await client.query(
    `insert into public.workflows(
      id,agency_id,client_id,name,endpoint_url,method,auth_type,encrypted_auth_config,request_body,
      expected_status,timeout_seconds,max_latency_ms,frequency_minutes,retries,report_included,store_raw_response,
      status,journey_template,draft_definition_json,draft_revision
    ) values ($1,$2,$3,'CAPTCHA safety journey','https://app.example.com/signup','GET','none','{}'::jsonb,'',
      200,10,5000,360,0,true,false,'pending','trial_signup','{}'::jsonb,0)`,
    [journeyId, ids.agencyId, ids.clientId]
  )
  await client.query(
    `insert into public.project_authorizations(
      id,agency_id,client_id,hostname,attestation_version,attested_by_user_id,attested_at,approved_action_domains
    ) values ($1,$2,$3,'app.example.com','2026-07-18',$4,now(),$5::jsonb)`,
    [authorizationId, ids.agencyId, ids.clientId, ids.userId, JSON.stringify(["app.example.com", "verify.example.com", "cleanup.example.com"])]
  )
  await client.query(
    `insert into public.journey_versions(
      id,agency_id,workflow_id,authorization_id,version_number,template,start_url,definition_json,definition_hash,created_by_user_id
    ) values ($1,$2,$3,$4,1,'trial_signup','https://app.example.com/signup','{}'::jsonb,$5,$6)`,
    [versionId, ids.agencyId, journeyId, authorizationId, "a".repeat(64), ids.userId]
  )
  await client.query(
    `insert into public.journey_stage_definitions(
      id,agency_id,journey_version_id,position,stage_key,name,action_manifest_json,expected_text,business_impact,is_cleanup
    ) values
      ($1,$2,$3,0,'submit','Submit','{"required":true,"actions":[]}'::jsonb,'Submit once.','A trial can start.',false),
      ($4,$2,$3,1,'cleanup','Cleanup','{"required":true,"actions":[]}'::jsonb,'Delete the account.','Synthetic data is removed.',true)`,
    [businessStageId, ids.agencyId, versionId, cleanupStageId]
  )
  await client.query(
    "update public.workflows set active_journey_version_id=$1 where id=$2 and agency_id=$3",
    [versionId, journeyId, ids.agencyId]
  )
  await client.query(
    `insert into public.journey_schedules(
      id,agency_id,workflow_id,journey_version_id,interval_minutes,enabled,next_run_at,
      cleanup_verified,lease_expires_at,leased_by
    ) values ($1,$2,$3,$4,360,true,now(),true,now() + interval '5 minutes','acceptance-scheduler')`,
    [scheduleId, ids.agencyId, journeyId, versionId]
  )
  await client.query(
    `insert into public.eval_runs(
      id,agency_id,client_id,workflow_id,journey_version_id,schedule_id,trigger_source,status,
      idempotency_key,synthetic_marker,dispatch_state,dispatch_worker_id,dispatch_lease_expires_at
    ) values ($1,$2,$3,$4,$5,$6,'scheduled','queued',$7,'MF-EVAL-AAAAAAAAAAAAAAAAAAAA',
      'dispatching',$8,now() + interval '5 minutes')`,
    [cancelledRunId, ids.agencyId, ids.clientId, journeyId, versionId, scheduleId, `kill-${cancelledRunId}`, dispatchWorkerId]
  )
  await client.query(
    "select * from public.cancel_business_eval_run_before_execution($1,$2,$3,$4)",
    [ids.agencyId, cancelledRunId, dispatchWorkerId, "Runner paused by database acceptance."]
  )
  const stopped = (await client.query(
    "select status,verdict,cleanup_status,quota_counted from public.eval_runs where id=$1",
    [cancelledRunId]
  )).rows[0]
  assert.deepEqual(stopped, {
    status: "cancelled",
    verdict: "cancelled",
    cleanup_status: "skipped",
    quota_counted: false,
  })
  assert.equal((await client.query(
    "select count(*)::integer as count from public.eval_run_side_effect_attempts where eval_run_id=$1",
    [cancelledRunId]
  )).rows[0].count, 0)

  await client.query(
    `insert into public.eval_runs(
      id,agency_id,client_id,workflow_id,journey_version_id,schedule_id,trigger_source,status,
      idempotency_key,synthetic_marker,dispatch_state,worker_id,claimed_at,started_at,lease_expires_at
    ) values ($1,$2,$3,$4,$5,$6,'manual','running',$7,'MF-EVAL-BBBBBBBBBBBBBBBBBBBB',
      'dispatched',$8,now(),now(),now() + interval '5 minutes')`,
    [captchaRunId, ids.agencyId, ids.clientId, journeyId, versionId, scheduleId, `captcha-${captchaRunId}`, runWorkerId]
  )
  const completedAt = new Date().toISOString()
  const stageResults = [
    {
      stageId: businessStageId,
      verdict: "inconclusive",
      observedText: "A CAPTCHA prevented trustworthy execution.",
      errorCode: "CAPTCHA_DETECTED",
      diagnostics: {},
      assertionResults: [],
      evidenceArtifactIds: [],
      startedAt: completedAt,
      completedAt,
      durationMs: 0,
    },
    {
      stageId: cleanupStageId,
      verdict: "failed",
      observedText: "Cleanup could not be proven after the CAPTCHA.",
      errorCode: "CLEANUP_RUNNER_FAILED",
      diagnostics: {},
      assertionResults: [],
      evidenceArtifactIds: [],
      startedAt: completedAt,
      completedAt,
      durationMs: 0,
    },
  ]
  await client.query(
    "select * from public.finalize_business_eval_run($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)",
    [captchaRunId, runWorkerId, JSON.stringify(stageResults), "CAPTCHA detected.", "Trial state is unknown.", "captcha-fingerprint", "failed", "Cleanup could not be proven.", completedAt]
  )
  const captchaRun = (await client.query(
    "select verdict,cleanup_status from public.eval_runs where id=$1",
    [captchaRunId]
  )).rows[0]
  const journey = (await client.query(
    "select paused_at is not null as paused,pause_reason from public.workflows where id=$1",
    [journeyId]
  )).rows[0]
  const schedule = (await client.query(
    "select enabled,paused_at is not null as paused,pause_reason from public.journey_schedules where id=$1",
    [scheduleId]
  )).rows[0]
  assert.deepEqual(captchaRun, { verdict: "inconclusive", cleanup_status: "failed" })
  assert.deepEqual(journey, { paused: true, pause_reason: "captcha_detected" })
  assert.deepEqual(schedule, { enabled: false, paused: true, pause_reason: "captcha_detected" })

  return {
    queuedRunStoppedBeforeExecution: true,
    captchaPausedJourneyAndSchedule: true,
    captchaVerdict: captchaRun.verdict,
  }
}

async function proveBusinessEvalsLifecycle(client, ids) {
  const projectId = randomUUID()
  const leadJourneyId = randomUUID()
  const trialJourneyId = randomUUID()

  await client.query(
    `update public.agencies set
      plan='growth',
      team_trial_started_at=now(),
      team_trial_ends_at=now() + interval '14 days',
      team_trial_used_at=now(),
      trial_ends_at=now() + interval '14 days'
    where id=$1`,
    [ids.agencyId]
  )
  const project = await client.query(
    "select * from public.create_business_eval_project($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      ids.agencyId, 15, projectId, "Lifecycle project", `lifecycle-${projectId.slice(0, 8)}`,
      "https://app.example.com", "own_product", ids.userId, "", "Disposable database acceptance project.",
    ]
  )
  assert.equal(project.rowCount, 1)
  assert.equal(project.rows[0].id, projectId)

  await assert.rejects(
    client.query(
      "select * from public.create_business_eval_project($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        ids.agencyId, 2, randomUUID(), "Over project limit", `over-${randomBytes(4).toString("hex")}`,
        "https://limits.example.com", "own_product", ids.userId, "", "",
      ]
    ),
    /PROJECT_LIMIT_REACHED/
  )

  const authorization = await client.query(
    "select * from public.record_project_authorization($1,$2,$3,$4,$5,$6::jsonb)",
    [
      ids.agencyId, projectId, ids.userId, "app.example.com", "2026-07-18",
      JSON.stringify(["app.example.com"]),
    ]
  )
  assert.equal(authorization.rowCount, 1)
  assert.match(authorization.rows[0].id, /^[a-f0-9-]{36}$/)

  const leadDraft = acceptanceLeadDefinition(projectId)
  const trialDraft = acceptanceTrialDefinition(projectId)
  const leadVersion = await createAndPublishAcceptanceJourney(client, {
    agencyId: ids.agencyId,
    projectId,
    userId: ids.userId,
    authorizationId: authorization.rows[0].id,
    journeyId: leadJourneyId,
    name: "Lead form lifecycle",
    draft: leadDraft,
  })
  const trialVersion = await createAndPublishAcceptanceJourney(client, {
    agencyId: ids.agencyId,
    projectId,
    userId: ids.userId,
    authorizationId: authorization.rows[0].id,
    journeyId: trialJourneyId,
    name: "Trial signup lifecycle",
    draft: trialDraft,
  })

  const persistedTrial = (await client.query(
    "select definition_json from public.journey_versions where id=$1 and agency_id=$2",
    [trialVersion.versionId, ids.agencyId]
  )).rows[0].definition_json
  const persistedTrialActions = persistedTrial.stages.flatMap((stage) => stage.actions)
  const emailWait = persistedTrialActions.find((action) => action.type === "wait_for_email")
  const emailLink = persistedTrialActions.find((action) => action.type === "open_email_link")
  assert.equal(emailWait.maximumWaitSeconds, 600)
  assert.deepEqual(emailLink.linkRule, { host: "app.example.com", pathPrefix: "/verify", requiredQueryParameter: "token" })

  const leadSupervised = await enqueueAndFinalizeAcceptanceRun(client, {
    agencyId: ids.agencyId,
    journeyId: leadJourneyId,
    versionId: leadVersion.versionId,
    userId: ids.userId,
    triggerSource: "supervised",
    expectedVerdict: "passed",
  })
  const trialSupervised = await enqueueAndFinalizeAcceptanceRun(client, {
    agencyId: ids.agencyId,
    journeyId: trialJourneyId,
    versionId: trialVersion.versionId,
    userId: ids.userId,
    triggerSource: "supervised",
    expectedVerdict: "passed",
  })
  assert.equal(leadSupervised.cleanupStatus, "not_required")
  assert.equal(trialSupervised.cleanupStatus, "passed")

  const leadSchedule = await client.query(
    "select * from public.configure_journey_schedule($1,$2,$3,$4,$5,$6)",
    [ids.agencyId, leadJourneyId, leadVersion.nextDraftRevision, 1440, true, null]
  )
  const trialSchedule = await client.query(
    "select * from public.configure_journey_schedule($1,$2,$3,$4,$5,$6)",
    [ids.agencyId, trialJourneyId, trialVersion.nextDraftRevision, 1440, true, null]
  )
  assert.equal(leadSchedule.rows[0].enabled, true)
  assert.equal(trialSchedule.rows[0].enabled, true)
  assert.equal(trialSchedule.rows[0].cleanup_verified, true)

  const failedLead = await enqueueAndFinalizeAcceptanceRun(client, {
    agencyId: ids.agencyId,
    journeyId: leadJourneyId,
    versionId: leadVersion.versionId,
    userId: ids.userId,
    triggerSource: "manual",
    expectedVerdict: "failed",
    failedStageKey: "form_submitted",
  })
  assert.ok(failedLead.incidentId)
  await client.query(
    `update public.issues set
      status='in_review',
      repair_recorded_at=now() - interval '1 minute',
      resolved_at=null,
      verification_eval_run_id=null,
      verification_run_id=null,
      resolution_note='The controlled form handler was repaired.',
      report_safe_summary='The controlled form handler was repaired.',
      snoozed_until=null,
      updated_at=now()
    where id=$1 and agency_id=$2`,
    [failedLead.incidentId, ids.agencyId]
  )
  const verification = await enqueueAndFinalizeAcceptanceRun(client, {
    agencyId: ids.agencyId,
    journeyId: leadJourneyId,
    versionId: leadVersion.versionId,
    userId: ids.userId,
    triggerSource: "verification",
    verificationIssueId: failedLead.incidentId,
    expectedVerdict: "passed",
  })
  const recovered = (await client.query(
    "select status,verification_eval_run_id,resolution_note,report_safe_summary from public.issues where id=$1",
    [failedLead.incidentId]
  )).rows[0]
  assert.deepEqual(recovered, {
    status: "resolved",
    verification_eval_run_id: verification.runId,
    resolution_note: "The controlled form handler was repaired.",
    report_safe_summary: "The controlled form handler was repaired.",
  })

  const cancellationTarget = (await client.query(
    "select * from public.enqueue_business_eval_run($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      ids.agencyId, leadJourneyId, leadVersion.versionId, null, "manual", `cancel-${randomUUID()}`,
      null, acceptanceMarker(), 7_500, ids.userId, null,
    ]
  )).rows[0]
  const cancellationKeyHash = createHash("sha256").update(`cancel-key-${cancellationTarget.eval_run_id}`).digest("hex")
  const cancellationRequestHash = createHash("sha256").update(JSON.stringify({
    operation: "eval_run.cancel",
    agencyId: ids.agencyId,
    evalRunId: cancellationTarget.eval_run_id,
    userId: ids.userId,
  })).digest("hex")
  const cancellation = await client.query(
    "select * from public.request_business_eval_cancellation($1,$2,$3,$4,$5)",
    [ids.agencyId, cancellationTarget.eval_run_id, ids.userId, cancellationKeyHash, cancellationRequestHash]
  )
  const cancellationReplay = await client.query(
    "select * from public.request_business_eval_cancellation($1,$2,$3,$4,$5)",
    [ids.agencyId, cancellationTarget.eval_run_id, ids.userId, cancellationKeyHash, cancellationRequestHash]
  )
  assert.equal(cancellation.rowCount, 1)
  assert.equal(cancellationReplay.rowCount, 1)
  assert.equal(cancellationReplay.rows[0].eval_run_id, cancellation.rows[0].eval_run_id)
  assert.equal(
    cancellationReplay.rows[0].cancel_requested_at.toISOString(),
    cancellation.rows[0].cancel_requested_at.toISOString(),
  )
  await assert.rejects(
    client.query(
      "select * from public.request_business_eval_cancellation($1,$2,$3,$4,$5)",
      [ids.agencyId, randomUUID(), ids.userId, cancellationKeyHash, cancellationRequestHash]
    ),
    /EVAL_RUN_CANCELLATION_IDEMPOTENCY_KEY_REUSED/
  )
  assert.equal(Number((await client.query(
    "select count(*) from public.audit_events where agency_id=$1 and entity_id=$2 and action='business_eval_cancellation_requested'",
    [ids.agencyId, cancellationTarget.eval_run_id]
  )).rows[0].count), 1)

  const report = (await client.query(
    "select * from public.create_business_eval_report_snapshot($1,$2,current_date,current_date,$3,$4)",
    [ids.agencyId, projectId, ids.userId, `report-${projectId}`]
  )).rows[0]
  assert.equal(report.status, "ready")
  assert.equal(report.snapshot_json.metrics.journeysCovered, 2)
  assert.equal(report.snapshot_json.metrics.recoveries, 1)
  assert.ok(report.snapshot_json.metrics.evalRuns >= 4)

  const tokenHash = createHash("sha256").update(`acceptance-share-${report.id}`).digest("hex")
  const snapshotHash = createHash("sha256").update(JSON.stringify(report.snapshot_json)).digest("hex")
  const shareId = randomUUID()
  await client.query(
    `insert into public.report_share_links(
      id,agency_id,report_id,token_hash,idempotency_key,snapshot_version,evidence_fingerprint,
      snapshot_hash,expires_at,created_by_user_id
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,now() + interval '7 days',$9)`,
    [
      shareId, ids.agencyId, report.id, tokenHash, `share-${report.id}`,
      report.snapshot_version, report.evidence_fingerprint, snapshotHash, ids.userId,
    ]
  )
  const consumed = await client.query("select * from public.consume_report_share_link($1)", [tokenHash])
  assert.equal(consumed.rowCount, 1)
  assert.equal(consumed.rows[0].share_link_id, shareId)
  const revocationKeyHash = createHash("sha256").update(`revoke-key-${shareId}`).digest("hex")
  const revocationRequestHash = createHash("sha256").update(JSON.stringify({
    operation: "report_share_link.revoke",
    agencyId: ids.agencyId,
    reportId: report.id,
    linkId: shareId,
    userId: ids.userId,
  })).digest("hex")
  const revocation = await client.query(
    "select * from public.revoke_report_share_link_idempotent($1,$2,$3,$4,$5,$6)",
    [ids.agencyId, report.id, shareId, ids.userId, revocationKeyHash, revocationRequestHash]
  )
  const revocationReplay = await client.query(
    "select * from public.revoke_report_share_link_idempotent($1,$2,$3,$4,$5,$6)",
    [ids.agencyId, report.id, shareId, ids.userId, revocationKeyHash, revocationRequestHash]
  )
  assert.equal(revocation.rowCount, 1)
  assert.equal(revocationReplay.rowCount, 1)
  assert.equal(revocationReplay.rows[0].share_link_id, revocation.rows[0].share_link_id)
  assert.equal(revocationReplay.rows[0].revoked_at.toISOString(), revocation.rows[0].revoked_at.toISOString())
  await assert.rejects(
    client.query(
      "select * from public.revoke_report_share_link_idempotent($1,$2,$3,$4,$5,$6)",
      [ids.agencyId, report.id, randomUUID(), ids.userId, revocationKeyHash, revocationRequestHash]
    ),
    /REPORT_SHARE_REVOCATION_IDEMPOTENCY_KEY_REUSED/
  )
  assert.equal(Number((await client.query(
    "select count(*) from public.audit_events where agency_id=$1 and entity_id=$2 and action='report_share_link_revoked'",
    [ids.agencyId, shareId]
  )).rows[0].count), 1)
  assert.equal((await client.query("select * from public.consume_report_share_link($1)", [tokenHash])).rowCount, 0)

  const quotaUsed = Number((await client.query(
    "select count(*) from public.eval_runs where agency_id=$1 and quota_counted and quota_period_start=date_trunc('month',now())::date",
    [ids.agencyId]
  )).rows[0].count)
  await assert.rejects(
    client.query(
      "select * from public.enqueue_business_eval_run($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        ids.agencyId, leadJourneyId, leadVersion.versionId, null, "manual", `quota-${randomUUID()}`,
        null, acceptanceMarker(), quotaUsed, ids.userId, null,
      ]
    ),
    /Monthly business-eval run quota reached/
  )
  const publishContractParity = await proveJourneyPublishContractParity(client, {
    agencyId: ids.agencyId,
    projectId,
    userId: ids.userId,
    authorizationId: authorization.rows[0].id,
  })

  return {
    launchTemplatesPublished: [leadVersion.versionId, trialVersion.versionId],
    supervisedSchedulesEnabled: [leadSchedule.rows[0].id, trialSchedule.rows[0].id],
    incidentRecoveryVerified: failedLead.incidentId,
    cancellationReplaySafe: cancellationTarget.eval_run_id,
    reportSnapshotCreated: report.id,
    shareLinkRevoked: shareId,
    shareRevocationReplaySafe: true,
    hardRunQuotaEnforced: true,
    publishContractParity,
  }
}

async function proveJourneyPublishContractParity(client, input) {
  for (const valueKey of ["number", "url"]) {
    const draft = acceptanceLeadDefinition(input.projectId)
    draft.name = `Synthetic ${valueKey} lifecycle`
    const fill = draft.stages.flatMap((stage) => stage.actions).find((action) => action.type === "fill")
    assert.ok(fill)
    fill.valueKey = valueKey
    await createAndPublishAcceptanceJourney(client, {
      ...input,
      journeyId: randomUUID(),
      name: draft.name,
      draft,
    })
  }

  const selectOnly = acceptanceLeadDefinition(input.projectId)
  const selectFill = selectOnly.stages.flatMap((stage) => stage.actions).find((action) => action.type === "fill")
  assert.ok(selectFill)
  delete selectFill.valueKey
  Object.assign(selectFill, { operation: "select", optionValue: "acceptance-option" })
  assert.equal((await client.query(
    "select public.restricted_journey_template_is_valid('lead_form',$1::jsonb) as valid",
    [JSON.stringify(selectOnly)]
  )).rows[0].valid, false)

  const leadCleanupStage = acceptanceLeadDefinition(input.projectId)
  leadCleanupStage.stages.at(-1).cleanup = true
  assert.equal((await client.query(
    "select public.restricted_journey_template_is_valid('lead_form',$1::jsonb) as valid",
    [JSON.stringify(leadCleanupStage)]
  )).rows[0].valid, false)

  const splitTrialCleanup = acceptanceTrialDefinition(input.projectId)
  const cleanupStage = splitTrialCleanup.stages.at(-1)
  const confirmation = cleanupStage.actions.pop()
  assert.ok(confirmation)
  splitTrialCleanup.stages.push({
    ...acceptanceStage(
      "cleanup_confirmed",
      "Cleanup confirmed",
      cleanupStage.position + 1,
      [confirmation],
      "The synthetic account remains deleted.",
      "Cleanup remains proven."
    ),
    cleanup: true,
  })
  assert.equal((await client.query(
    "select public.restricted_journey_template_is_valid('trial_signup',$1::jsonb) as valid",
    [JSON.stringify(splitTrialCleanup)]
  )).rows[0].valid, false)

  const scratchId = randomUUID()
  const scratchName = "Publish rejection scratch"
  const validScratch = acceptanceLeadDefinition(input.projectId)
  validScratch.name = scratchName
  await client.query(
    "select * from public.create_business_eval_journey($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [
      input.agencyId, 30, scratchId, input.projectId, scratchName,
      validScratch.template, validScratch.startUrl, JSON.stringify(validScratch),
    ]
  )
  const expectRejected = async (mutate, messagePattern, endpointUrl = validScratch.startUrl) => {
    const invalid = structuredClone(validScratch)
    mutate(invalid)
    await assert.rejects(
      async () => {
        await client.query(
          "update public.workflows set draft_definition_json=$1::jsonb,endpoint_url=$2 where id=$3 and agency_id=$4",
          [JSON.stringify(invalid), endpointUrl, scratchId, input.agencyId]
        )
        await client.query(
          "select * from public.publish_journey_version($1,$2,0,$3,$4)",
          [input.agencyId, scratchId, input.authorizationId, input.userId]
        )
      },
      messagePattern
    )
    assert.equal(Number((await client.query(
      "select count(*) from public.journey_versions where workflow_id=$1 and agency_id=$2",
      [scratchId, input.agencyId]
    )).rows[0].count), 0)
  }

  await expectRejected((draft) => { draft.stages[0].position = "0" }, /invalid stage/)
  await expectRejected((draft) => { draft.stages[0].actions[0].timeoutMs = "10000" }, /unsupported restricted action/)
  await expectRejected((draft) => {
    const fill = draft.stages.flatMap((stage) => stage.actions).find((action) => action.type === "fill")
    fill.operation = null
  }, /explicit supported operation/)
  await expectRejected((draft) => { draft.unexpected = "must-not-publish" }, /canonical workflow revision/)
  await expectRejected((draft) => { draft.stages[0].unexpected = "must-not-publish" }, /invalid stage/)
  const malformedUrl = "https://app.example.com:bad/contact"
  await expectRejected((draft) => {
    draft.startUrl = malformedUrl
    draft.stages[0].actions[0].url = malformedUrl
  }, /workflows_saved_endpoint_safe|public HTTPS/, malformedUrl)
  const oversizedUrl = `https://app.example.com/${"a".repeat(2_100)}`
  await expectRejected((draft) => {
    draft.startUrl = oversizedUrl
    draft.stages[0].actions[0].url = oversizedUrl
  }, /workflows_saved_endpoint_safe|public HTTPS/, oversizedUrl)

  const trialScratchId = randomUUID()
  const trialScratch = acceptanceTrialDefinition(input.projectId)
  trialScratch.name = "Trial publish rejection scratch"
  const emailWait = trialScratch.stages.flatMap((stage) => stage.actions).find((action) => action.type === "wait_for_email")
  assert.ok(emailWait)
  emailWait.maximumWaitSeconds = "600"
  await client.query(
    "select * from public.create_business_eval_journey($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [
      input.agencyId, 30, trialScratchId, input.projectId, trialScratch.name,
      trialScratch.template, trialScratch.startUrl, JSON.stringify(trialScratch),
    ]
  )
  await assert.rejects(
    client.query(
      "select * from public.publish_journey_version($1,$2,0,$3,$4)",
      [input.agencyId, trialScratchId, input.authorizationId, input.userId]
    ),
    /synthetic recipient key and safe threshold/
  )

  return true
}

async function createAndPublishAcceptanceJourney(client, input) {
  const created = await client.query(
    "select * from public.create_business_eval_journey($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [
      input.agencyId, 30, input.journeyId, input.projectId, input.name,
      input.draft.template, input.draft.startUrl, JSON.stringify(input.draft),
    ]
  )
  assert.equal(created.rowCount, 1)
  const published = await client.query(
    "select * from public.publish_journey_version($1,$2,$3,$4,$5)",
    [input.agencyId, input.journeyId, 0, input.authorizationId, input.userId]
  )
  assert.equal(published.rowCount, 1)
  const versionId = published.rows[0].journey_version_id
  assert.equal(Number((await client.query(
    "select count(*) from public.journey_stage_definitions where journey_version_id=$1 and agency_id=$2",
    [versionId, input.agencyId]
  )).rows[0].count), input.draft.stages.length)
  return { versionId, nextDraftRevision: published.rows[0].next_draft_revision }
}

async function enqueueAndFinalizeAcceptanceRun(client, input) {
  const enqueued = await client.query(
    "select * from public.enqueue_business_eval_run($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      input.agencyId, input.journeyId, input.versionId, null, input.triggerSource,
      `${input.triggerSource}-${randomUUID()}`, null, acceptanceMarker(), 7500, input.userId,
      input.verificationIssueId ?? null,
    ]
  )
  assert.equal(enqueued.rowCount, 1)
  const runId = enqueued.rows[0].eval_run_id
  const workerId = `database-lifecycle-${runId}`
  const claimed = await client.query(
    "select * from public.claim_business_eval_run($1,$2,$3)",
    [runId, workerId, 1800]
  )
  assert.equal(claimed.rowCount, 1)
  const stages = (await client.query(
    "select id,stage_key,position,is_cleanup,expected_text from public.journey_stage_definitions where journey_version_id=$1 and agency_id=$2 order by position",
    [input.versionId, input.agencyId]
  )).rows
  const failedIndex = input.failedStageKey
    ? stages.findIndex((stage) => stage.stage_key === input.failedStageKey)
    : -1
  assert.equal(input.failedStageKey ? failedIndex >= 0 : true, true)
  const completedAt = new Date().toISOString()
  const stageResults = stages.map((stage, index) => {
    const verdict = stage.is_cleanup
      ? "passed"
      : failedIndex < 0
        ? "passed"
        : index < failedIndex
          ? "passed"
          : index === failedIndex
            ? "failed"
            : "not_run"
    const observedText = verdict === "passed"
      ? "The controlled deterministic assertion passed."
      : verdict === "failed"
        ? "The controlled business assertion failed."
        : "The stage was not reached after the deterministic failure."
    return {
      stageId: stage.id,
      verdict,
      observedText,
      errorCode: verdict === "failed" ? "BUSINESS_ASSERTION_FAILED" : "",
      diagnostics: {},
      assertionResults: [{
        assertionId: `stage:${stage.id}`,
        required: true,
        expectedRule: stage.expected_text,
        safeObservation: observedText,
        observationDigest: createHash("sha256").update(observedText).digest("hex"),
        result: verdict,
        evaluatedAt: completedAt,
        evaluatorVersion: "database-acceptance-v1",
      }],
      evidenceArtifactIds: [],
      startedAt: completedAt,
      completedAt,
      durationMs: 25,
    }
  })
  const cleanupStatus = stages.some((stage) => stage.is_cleanup) ? "passed" : "not_required"
  const finalized = await client.query(
    "select * from public.finalize_business_eval_run($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)",
    [
      runId, workerId, JSON.stringify(stageResults),
      input.expectedVerdict === "passed" ? "The controlled business outcome passed." : "The controlled business outcome failed.",
      input.expectedVerdict === "passed" ? "The customer journey remains available." : "Prospective customers cannot complete the journey.",
      input.expectedVerdict === "passed" ? "" : `acceptance:${input.journeyId}:${input.failedStageKey}`,
      cleanupStatus, "", completedAt,
    ]
  )
  assert.equal(finalized.rows[0].final_verdict, input.expectedVerdict)
  const run = (await client.query(
    "select status,verdict,cleanup_status from public.eval_runs where id=$1 and agency_id=$2",
    [runId, input.agencyId]
  )).rows[0]
  assert.deepEqual(run, { status: "finalized", verdict: input.expectedVerdict, cleanup_status: cleanupStatus })
  return {
    runId,
    incidentId: finalized.rows[0].incident_id,
    cleanupStatus,
  }
}

function acceptanceLeadDefinition(projectId) {
  const startUrl = "https://app.example.com/contact"
  return {
    projectId,
    name: "Lead form lifecycle",
    draftRevision: 0,
    template: "lead_form",
    startUrl,
    emailProofConfigured: false,
    cleanupMode: "none",
    stages: [
      acceptanceStage("page_loaded", "Page loaded", 0, [
        { id: "open_lead_form", label: "Open lead form", timeoutMs: 10000, type: "navigate", url: startUrl },
        { id: "lead_form_visible", label: "Lead form is visible", timeoutMs: 10000, type: "assert_visible", locator: { kind: "role", role: "form", name: "Lead form" } },
      ], "The lead form is available.", "Prospects can begin an enquiry."),
      acceptanceStage("form_submitted", "Form submitted", 1, [
        { id: "fill_lead_email", label: "Enter synthetic email", timeoutMs: 10000, type: "fill", operation: "text", locator: { kind: "label", value: "Email" }, valueKey: "email" },
        { id: "submit_lead_form", label: "Submit lead form", timeoutMs: 10000, type: "click", locator: { kind: "role", role: "button", name: "Submit" } },
      ], "The form accepts marked synthetic test data.", "A prospect can submit a lead."),
      acceptanceStage("success_confirmed", "Success confirmed", 2, [
        { id: "wait_for_success", label: "Wait for success confirmation", timeoutMs: 10000, type: "wait_for_text", text: "Thank you" },
      ], "A success state is visible.", "The prospect knows the enquiry was received."),
    ],
  }
}

function acceptanceTrialDefinition(projectId) {
  const startUrl = "https://app.example.com/signup"
  return {
    projectId,
    name: "Trial signup lifecycle",
    draftRevision: 0,
    template: "trial_signup",
    startUrl,
    emailProofConfigured: true,
    cleanupMode: "in_product",
    stages: [
      acceptanceStage("signup_opened", "Signup opened", 0, [
        { id: "open_trial_signup", label: "Open trial signup", timeoutMs: 10000, type: "navigate", url: startUrl },
        { id: "signup_form_visible", label: "Signup form is visible", timeoutMs: 10000, type: "assert_visible", locator: { kind: "role", role: "form", name: "Trial signup" } },
      ], "The signup form is available.", "A buyer can start a trial."),
      acceptanceStage("signup_submitted", "Signup submitted", 1, [
        { id: "fill_signup_email", label: "Enter synthetic email", timeoutMs: 10000, type: "fill", operation: "text", locator: { kind: "label", value: "Email" }, valueKey: "email" },
        { id: "submit_signup", label: "Create synthetic account", timeoutMs: 10000, type: "click", locator: { kind: "role", role: "button", name: "Create account" } },
      ], "Synthetic signup data is accepted.", "A buyer can request an account."),
      acceptanceStage("verification_received", "Verification email received", 2, [
        { id: "wait_for_verification_email", label: "Wait for verification email", timeoutMs: 60000, type: "wait_for_email", recipientKey: "email", proofMode: "autoresponse", thresholdSeconds: 120, maximumWaitSeconds: 600 },
      ], "The verification email arrives.", "The buyer can continue onboarding."),
      acceptanceStage("verification_opened", "Verification opened", 3, [
        { id: "open_verification_link", label: "Open approved verification link", timeoutMs: 10000, type: "open_email_link", allowedHosts: ["app.example.com"], linkRule: { host: "app.example.com", pathPrefix: "/verify", requiredQueryParameter: "token" } },
      ], "The approved verification link opens.", "The buyer can verify the account."),
      acceptanceStage("workspace_created", "Workspace created", 4, [
        { id: "workspace_visible", label: "Workspace is visible", timeoutMs: 10000, type: "assert_visible", locator: { kind: "role", role: "main", name: "Workspace" } },
      ], "The first authenticated workspace loads.", "The buyer reaches product value."),
      {
        ...acceptanceStage("cleanup_test_account", "Cleanup test account", 5, [
          { id: "delete_test_account", label: "Delete synthetic test account", timeoutMs: 10000, type: "cleanup", mode: "in_product", locator: { kind: "role", role: "button", name: "Delete test account" } },
          { id: "confirm_test_account_deleted", label: "Confirm test account deletion", timeoutMs: 10000, type: "wait_for_text", text: "Account deleted" },
        ], "The synthetic test account is removed.", "Scheduled tests do not pollute customer or billing data."),
        cleanup: true,
      },
    ],
  }
}

function acceptanceStage(key, name, position, actions, expected, businessImpact) {
  return { key, name, position, required: true, cleanup: false, actions, expected, businessImpact, timingThresholdMs: null }
}

function acceptanceMarker() {
  return `MF-EVAL-${randomBytes(10).toString("hex").toUpperCase()}`
}

async function proveJourneyArchiveRestore(client, ids) {
  const before = (await client.query(`
    select
      (select count(*)::integer from public.check_runs where workflow_id=$1) as runs,
      (select count(*)::integer from public.issues where workflow_id=$1) as incidents,
      (select count(*)::integer from public.reports where client_id=$2) as reports
  `, [ids.workflowId, ids.clientId])).rows[0]

  await assert.rejects(
    client.query(
      "select * from public.set_business_eval_journey_archived($1,$2,$3,true,null)",
      [ids.agencyId, ids.workflowId, ids.otherUserId]
    ),
    /WORKSPACE_ROLE_REQUIRED/
  )
  await assert.rejects(
    client.query(
      "select * from public.set_business_eval_journey_archived($1,$2,$3,true,null)",
      [ids.otherAgencyId, ids.workflowId, ids.otherUserId]
    ),
    /JOURNEY_NOT_FOUND/
  )

  await client.query(
    "select * from public.set_business_eval_journey_archived($1,$2,$3,true,null)",
    [ids.agencyId, ids.workflowId, ids.userId]
  )
  const archived = (await client.query(
    "select archived_at is not null as archived,paused_at is not null as paused,pause_reason from public.workflows where id=$1",
    [ids.workflowId]
  )).rows[0]
  const archivedCheck = (await client.query(
    "select enabled,lease_expires_at,leased_by from public.checks where id=$1",
    [ids.checkId]
  )).rows[0]
  assert.deepEqual(archived, { archived: true, paused: true, pause_reason: "journey_archived" })
  assert.deepEqual(archivedCheck, { enabled: false, lease_expires_at: null, leased_by: null })
  assert.equal((await client.query("select count(*)::integer as count from public.claim_due_checks($1,$2,$3)", [10, 180, "archive-proof"])).rows[0].count, 0)

  await client.query(
    "select * from public.set_business_eval_journey_archived($1,$2,$3,false,$4)",
    [ids.agencyId, ids.workflowId, ids.userId, 10]
  )
  const restored = (await client.query(
    "select archived_at,paused_at is not null as paused,pause_reason from public.workflows where id=$1",
    [ids.workflowId]
  )).rows[0]
  assert.deepEqual(restored, { archived_at: null, paused: true, pause_reason: "journey_restored" })
  assert.equal((await client.query("select enabled from public.checks where id=$1", [ids.checkId])).rows[0].enabled, false)

  const after = (await client.query(`
    select
      (select count(*)::integer from public.check_runs where workflow_id=$1) as runs,
      (select count(*)::integer from public.issues where workflow_id=$1) as incidents,
      (select count(*)::integer from public.reports where client_id=$2) as reports,
      (select count(*)::integer from public.audit_events where entity_id=$1 and action in ('business_eval_journey_archived','business_eval_journey_restored')) as lifecycle_events
  `, [ids.workflowId, ids.clientId])).rows[0]
  assert.deepEqual({ runs: after.runs, incidents: after.incidents, reports: after.reports }, before)
  assert.equal(after.lifecycle_events, 2)
  return { preservedEvidence: true, restoredPaused: true, crossTenantDenied: true }
}
