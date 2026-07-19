import { readFile } from "node:fs/promises"
import process from "node:process"

const isProductionBuild = process.env.VERCEL_ENV === "production"
const isDryRun = process.env.MIGRATION_DRY_RUN === "true"
const migrationPhase = process.env.MAINTAINFLOW_MIGRATION_PHASE ?? "expand"
const isContractPhase = migrationPhase === "contract"

if (!isProductionBuild && !isDryRun) {
  console.log("Self-serve workspace access: skipped outside a Vercel production build.")
  process.exit(0)
}

if (!new Set(["expand", "contract"]).has(migrationPhase)) {
  throw new Error("MAINTAINFLOW_MIGRATION_PHASE must be either expand or contract.")
}

if (!process.env.DATABASE_URL) {
  throw new Error("Self-serve workspace access requires DATABASE_URL.")
}

const { default: pg } = await import("pg")
const supabaseRootCa = await readFile(
  new URL("../supabase/prod-ca-2021.crt", import.meta.url),
  "utf8"
)
const freePlanMigration = await readFile(
  new URL("../supabase/maintainflow_free_plan_migration.sql", import.meta.url),
  "utf8"
)
const workspaceMigration = await readFile(
  new URL("../supabase/maintainflow_self_serve_workspace_provisioning.sql", import.meta.url),
  "utf8"
)
const entitlementMigration = await readFile(
  new URL("../supabase/maintainflow_billing_entitlements_migration.sql", import.meta.url),
  "utf8"
)
const assuranceExpansionMigration = await readFile(
  new URL("../supabase/maintainflow_assurance_expansion_migration.sql", import.meta.url),
  "utf8"
)
const checkEvidencePrivacyMigration = await readFile(
  new URL("../supabase/maintainflow_check_evidence_privacy_migration.sql", import.meta.url),
  "utf8"
)
const atomicCheckEvidenceMigration = await readFile(
  new URL("../supabase/maintainflow_atomic_check_evidence_migration.sql", import.meta.url),
  "utf8"
)
const schedulerCapacityMigration = await readFile(
  new URL("../supabase/maintainflow_scheduler_capacity_migration.sql", import.meta.url),
  "utf8"
)
const businessEvalsMigration = await readFile(
  new URL("../supabase/maintainflow_business_evals_migration.sql", import.meta.url),
  "utf8"
)
const schedulerCapacityContractMigration = await readFile(
  new URL("../supabase/maintainflow_scheduler_capacity_contract_migration.sql", import.meta.url),
  "utf8"
)
const assuranceIntegrityMigration = await readFile(
  new URL("../supabase/maintainflow_assurance_integrity_migration.sql", import.meta.url),
  "utf8"
)
const serviceEvidenceRlsContractMigration = await readFile(
  new URL("../supabase/maintainflow_service_evidence_rls_contract_migration.sql", import.meta.url),
  "utf8"
)
const publicMonitorContractMigration = await readFile(
  new URL("../supabase/maintainflow_public_monitor_contract_migration.sql", import.meta.url),
  "utf8"
)
const paidPilotRetirementMigration = await readFile(
  new URL("../supabase/maintainflow_retire_paid_pilot_runtime.sql", import.meta.url),
  "utf8"
)
const { client, connectionLabel } = await connectDatabase(process.env.DATABASE_URL)
let transactionOpen = false
let publicMonitorImpactBeforeContract = null

try {
  await client.query("begin")
  transactionOpen = true
  await client.query("set local statement_timeout = '5min'")
  await client.query("select pg_advisory_xact_lock(hashtextextended('maintainflow:production-migrations', 0))")
  await client.query("set local lock_timeout = '10s'")
  const historicalLeadTable = await client.query(`
    select to_regclass('public.contact_sales_leads') is not null as existed
  `)
  const historicalContactSalesLeadsExisted = historicalLeadTable.rows[0]?.existed === true
  const historicalContactSalesLeadCountBefore = historicalContactSalesLeadsExisted
    ? String((await client.query("select count(*)::bigint as count from public.contact_sales_leads")).rows[0]?.count ?? "0")
    : null
  const planLabels = await client.query(`
    select enumlabel
    from pg_enum
    join pg_type on pg_type.oid = pg_enum.enumtypid
    join pg_namespace on pg_namespace.oid = pg_type.typnamespace
    where pg_namespace.nspname = 'public'
      and pg_type.typname = 'agency_plan'
    order by pg_enum.enumsortorder
  `)
  const planLabelSet = new Set(planLabels.rows.map((row) => row.enumlabel))

  if (!planLabelSet.has("free")) {
    await client.query(withoutTransactionWrapper(freePlanMigration))
  }

  await client.query(withoutTransactionWrapper(entitlementMigration))
  await client.query(withoutTransactionWrapper(workspaceMigration))
  await client.query(withoutTransactionWrapper(assuranceExpansionMigration))
  await client.query(withoutTransactionWrapper(checkEvidencePrivacyMigration))
  await client.query(withoutTransactionWrapper(atomicCheckEvidenceMigration))
  await client.query(withoutTransactionWrapper(schedulerCapacityMigration))
  await client.query(withoutTransactionWrapper(businessEvalsMigration))

  if (isContractPhase) {
    const impact = await client.query(`
      select
        count(*)::integer as total_checks,
        count(*) filter (where check_state.enabled and not check_state.pending_setup)::integer as active_checks,
        count(*) filter (
          where (
            workflow_state.endpoint_url = ''
            or workflow_state.endpoint_url <> btrim(workflow_state.endpoint_url)
            or workflow_state.endpoint_url !~* '^https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::[0-9]{1,5})?(/[^?#[:space:]]*)?$'
            or workflow_state.endpoint_url ~* '^https://[0-9.]+(?::[0-9]{1,5})?(/|$)'
            or workflow_state.endpoint_url ~* '^https://[^/:]+\\.(?:localhost|local|internal|home\\.arpa)(?::[0-9]{1,5})?(/|$)'
            or workflow_state.endpoint_url ~* '^https://demo\\.maintainflow\\.test(?::[0-9]{1,5})?(/|$)'
            or workflow_state.method <> 'GET'::public.workflow_method
            or workflow_state.auth_type <> 'none'
            or workflow_state.request_body <> ''
            or workflow_state.store_raw_response
            or workflow_state.encrypted_auth_config not in ('{}'::jsonb, '{"headers":[]}'::jsonb)
            or exists (
              select 1
              from jsonb_array_elements(
                case
                  when jsonb_typeof(check_state.assertions_json) = 'array' then check_state.assertions_json
                  else '[]'::jsonb
                end
              ) as assertion_item(value)
              where assertion_item.value->>'type' not in ('response_exists', 'json_field_exists')
                 or assertion_item.value ?| array['expected', 'pattern']
            )
          )
        )::integer as checks_requiring_scrub,
        count(*) filter (
          where check_state.enabled
            and not check_state.pending_setup
            and (
              workflow_state.endpoint_url = ''
              or workflow_state.endpoint_url <> btrim(workflow_state.endpoint_url)
              or workflow_state.endpoint_url !~* '^https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::[0-9]{1,5})?(/[^?#[:space:]]*)?$'
              or workflow_state.endpoint_url ~* '^https://[0-9.]+(?::[0-9]{1,5})?(/|$)'
              or workflow_state.endpoint_url ~* '^https://[^/:]+\\.(?:localhost|local|internal|home\\.arpa)(?::[0-9]{1,5})?(/|$)'
              or workflow_state.endpoint_url ~* '^https://demo\\.maintainflow\\.test(?::[0-9]{1,5})?(/|$)'
              or workflow_state.method <> 'GET'::public.workflow_method
              or workflow_state.auth_type <> 'none'
              or workflow_state.request_body <> ''
              or workflow_state.store_raw_response
              or workflow_state.encrypted_auth_config not in ('{}'::jsonb, '{"headers":[]}'::jsonb)
              or exists (
                select 1
                from jsonb_array_elements(
                  case
                    when jsonb_typeof(check_state.assertions_json) = 'array' then check_state.assertions_json
                    else '[]'::jsonb
                  end
                ) as assertion_item(value)
                where assertion_item.value->>'type' not in ('response_exists', 'json_field_exists')
                   or assertion_item.value ?| array['expected', 'pattern']
              )
            )
        )::integer as active_checks_requiring_disable,
        (
          select count(*)::integer
          from public.reports report_state
          where report_state.snapshot_version > 0
            and report_state.status::text <> 'sent'
            and report_state.pdf_snapshot_version is not null
        ) as prepared_reports_to_stale
      from public.checks check_state
      join public.workflows workflow_state
        on workflow_state.id = check_state.workflow_id
        and workflow_state.agency_id = check_state.agency_id
    `)
    publicMonitorImpactBeforeContract = impact.rows[0] ?? null
    await client.query(withoutTransactionWrapper(schedulerCapacityContractMigration))
    await client.query(withoutTransactionWrapper(assuranceIntegrityMigration))
    await client.query(withoutTransactionWrapper(serviceEvidenceRlsContractMigration))
    await client.query(withoutTransactionWrapper(publicMonitorContractMigration))
    await client.query(withoutTransactionWrapper(paidPilotRetirementMigration))
  }

  const permissions = await client.query(`
    select
      has_function_privilege('authenticated', 'public.create_agency_workspace(text,text,text,citext)', 'execute') as authenticated_can_create,
      has_column_privilege('authenticated', 'public.agencies', 'plan', 'update') as authenticated_can_update_plan,
      has_column_privilege('authenticated', 'public.agencies', 'stripe_subscription_id', 'update') as authenticated_can_update_subscription,
      has_table_privilege('authenticated', 'public.agencies', 'insert') as authenticated_can_insert_agency,
      has_table_privilege('authenticated', 'public.agencies', 'delete') as authenticated_can_delete_agency,
      has_table_privilege('authenticated', 'public.memberships', 'delete') as authenticated_can_delete_membership,
      has_column_privilege('authenticated', 'public.memberships', 'role', 'update') as authenticated_can_update_membership_role,
      has_column_privilege('authenticated', 'public.memberships', 'user_id', 'update') as authenticated_can_reassign_membership_user,
      has_column_privilege('authenticated', 'public.memberships', 'agency_id', 'update') as authenticated_can_reassign_membership_agency,
      exists (
        select 1
        from pg_enum
        join pg_type on pg_type.oid = pg_enum.enumtypid
        join pg_namespace on pg_namespace.oid = pg_type.typnamespace
        where pg_namespace.nspname = 'public'
          and pg_type.typname = 'agency_plan'
          and pg_enum.enumlabel = 'free'
      ) as free_plan_ready,
      exists (
        select 1
        from pg_indexes
        where schemaname = 'public'
          and tablename = 'memberships'
          and indexname = 'memberships_user_id_unique_idx'
          and indexdef ilike 'create unique index%'
      ) as one_workspace_per_user_ready,
      exists (
        select 1 from pg_trigger
        where tgname = 'clients_enforce_billing_limit' and not tgisinternal
      ) as client_limit_trigger_ready,
      exists (
        select 1 from pg_trigger
        where tgname = 'workflows_enforce_billing_limit' and not tgisinternal
      ) as workflow_limit_trigger_ready,
      exists (
        select 1 from pg_trigger
        where tgname = 'reports_enforce_billing_limit' and not tgisinternal
      ) as report_limit_trigger_ready,
      exists (
        select 1 from pg_constraint
        where conname = 'workflows_frequency_safe'
          and conrelid = 'public.workflows'::regclass
      ) as workflow_frequency_guard_ready,
      exists (
        select 1 from pg_constraint
        where conname = 'checks_schedule_safe'
          and conrelid = 'public.checks'::regclass
      ) as check_frequency_guard_ready
      ,(
        select count(*) = 13
        from pg_class relation_state
        join pg_namespace relation_namespace on relation_namespace.oid = relation_state.relnamespace
        where relation_namespace.nspname = 'public'
          and relation_state.relname in (
            'project_authorizations',
            'journey_versions',
            'journey_stage_definitions',
            'journey_schedules',
            'eval_runs',
            'eval_run_side_effect_attempts',
            'eval_stage_runs',
            'evidence_artifacts',
            'inbound_email_events',
            'provider_webhook_receipts',
            'alert_endpoints',
            'alert_deliveries',
            'report_share_links'
          )
          and relation_state.relkind in ('r', 'p')
      ) as business_evals_foundation_ready
      ,(
        to_regprocedure('public.publish_journey_version(uuid,uuid,integer,uuid,uuid)') is not null
        and to_regprocedure('public.restore_business_eval_project(uuid,uuid,integer,integer)') is not null
        and to_regprocedure('public.restore_business_eval_project(uuid,uuid,integer)') is null
        and to_regprocedure('public.get_business_eval_run_replay(uuid,text,uuid,uuid,uuid,text,timestamptz,uuid,uuid)') is not null
        and to_regprocedure('public.enqueue_business_eval_run(uuid,uuid,uuid,uuid,text,text,timestamptz,text,integer,uuid,uuid)') is not null
        and to_regprocedure('public.get_business_eval_project_summaries(uuid,uuid[])') is not null
        and to_regprocedure('public.get_business_eval_journey_summaries(uuid,uuid[])') is not null
        and to_regprocedure('public.get_business_eval_report_active_share_flags(uuid,uuid[])') is not null
        and to_regprocedure('public.finalize_business_eval_run(uuid,text,jsonb,text,text,text,text,text,timestamptz)') is not null
        and to_regprocedure('public.create_business_eval_report_snapshot(uuid,uuid,date,date,uuid,text)') is not null
        and to_regprocedure('public.consume_report_share_link(text)') is not null
        and to_regprocedure('public.claim_provider_webhook_receipt(text,text,text,text,integer)') is not null
        and to_regprocedure('public.finish_provider_webhook_receipt(uuid,uuid,text,boolean,text)') is not null
      ) as business_evals_rpcs_ready
      ,(
        not has_table_privilege('authenticated', 'public.eval_runs', 'insert')
        and not has_table_privilege('authenticated', 'public.eval_runs', 'update')
        and not has_table_privilege('authenticated', 'public.eval_runs', 'delete')
        and not has_table_privilege('authenticated', 'public.evidence_artifacts', 'insert')
        and not has_table_privilege('authenticated', 'public.report_share_links', 'insert')
        and not has_table_privilege('authenticated', 'public.provider_webhook_receipts', 'select')
        and has_table_privilege('service_role', 'public.eval_runs', 'insert')
        and has_table_privilege('service_role', 'public.evidence_artifacts', 'insert')
      ) as business_evals_service_boundary_ready
      ,(
        select count(*) = 2
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'issues'
          and column_name in ('repair_recorded_at', 'verification_run_id')
      ) as issue_verification_columns_ready
      ,(
        select count(*) = 5
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'reports'
          and column_name in ('snapshot_version', 'snapshot_json', 'evidence_fingerprint', 'stale_at', 'pdf_snapshot_version')
      ) as report_snapshot_columns_ready
      ,exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'report_items'
          and column_name = 'snapshot_version'
      ) as report_item_snapshot_column_ready
      ,exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'check_runs'
          and column_name = 'evidence_origin'
          and udt_schema = 'public'
          and udt_name = 'check_run_evidence_origin'
          and is_nullable = 'NO'
          and column_default like '%legacy_browser%'
      ) as check_run_provenance_column_ready
      ,(
        not has_column_privilege('authenticated', 'public.check_runs', 'evidence_origin', 'insert')
        and not has_column_privilege('authenticated', 'public.check_runs', 'evidence_origin', 'update')
      ) as authenticated_cannot_name_service_origin
      ,(
        select count(*) = 4
        from pg_policies policy_state
        where policy_state.schemaname = 'public'
          and policy_state.tablename = 'check_runs'
          and 'authenticated' = any(policy_state.roles)
          and (
            (policy_state.policyname = 'check_runs_members_select' and policy_state.cmd = 'SELECT')
            or (
              policy_state.policyname = 'check_runs_members_insert_legacy'
              and policy_state.cmd = 'INSERT'
              and policy_state.with_check like '%legacy_browser%'
            )
            or (
              policy_state.policyname = 'check_runs_members_update_legacy'
              and policy_state.cmd = 'UPDATE'
              and policy_state.qual like '%legacy_browser%'
              and policy_state.with_check like '%legacy_browser%'
            )
            or (
              policy_state.policyname = 'check_runs_members_delete_legacy'
              and policy_state.cmd = 'DELETE'
              and policy_state.qual like '%legacy_browser%'
            )
          )
      ) as expand_check_run_provenance_policies_ready
      ,exists (
        select 1
        from pg_trigger trigger_state
        where trigger_state.tgname = 'check_runs_sanitize_evidence'
          and trigger_state.tgrelid = 'public.check_runs'::regclass
          and trigger_state.tgfoid = to_regprocedure('public.sanitize_check_run_evidence()')
          and not trigger_state.tgisinternal
          and trigger_state.tgenabled <> 'D'
          and pg_get_triggerdef(trigger_state.oid) like '% BEFORE %'
      ) as check_evidence_privacy_trigger_ready
      ,not exists (
        select 1
        from public.check_runs cr
        where coalesce(cr.result_json, '{}'::jsonb) <> '{}'::jsonb
          or jsonb_typeof(cr.assertion_results_json) is distinct from 'array'
          or exists (
            select 1
            from jsonb_array_elements(
              case
                when jsonb_typeof(cr.assertion_results_json) = 'array' then cr.assertion_results_json
                else '[]'::jsonb
              end
            ) with ordinality as assertion_item(value, ordinality)
            where jsonb_typeof(assertion_item.value) <> 'object'
              or jsonb_typeof(assertion_item.value->'passed') <> 'boolean'
              or assertion_item.value->>'id' is distinct from 'assertion-' || assertion_item.ordinality::text
              or assertion_item.value->>'label' not in ('Assertion passed', 'Assertion failed')
              or (assertion_item.value->>'passed' = 'true' and assertion_item.value ? 'reason')
              or (
                assertion_item.value->>'passed' = 'false'
                and assertion_item.value->>'reason' is distinct from 'Assertion did not meet the configured condition.'
              )
              or exists (
                select 1
                from jsonb_object_keys(assertion_item.value) as key_name
                where key_name not in ('id', 'label', 'passed', 'reason')
              )
          )
      ) as check_evidence_rows_privacy_safe
      ,exists (
        select 1
        from pg_proc function_state
        where function_state.oid = to_regprocedure(
          'public.record_assurance_check_result(uuid,uuid,public.check_status,integer,integer,jsonb,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz,boolean)'
        )
          and function_state.prosecdef
          and has_function_privilege('service_role', function_state.oid, 'execute')
          and not has_function_privilege('authenticated', function_state.oid, 'execute')
          and not has_function_privilege('anon', function_state.oid, 'execute')
          and pg_get_function_result(function_state.oid)
            like 'TABLE(run_id uuid, agency_id uuid, workflow_id uuid, status %check_status)'
          and pg_get_functiondef(function_state.oid) like '%evidence_origin%service%'
      ) as atomic_check_result_rpc_ready
      ,exists (
        select 1
        from pg_proc function_state
        where function_state.oid = to_regprocedure('public.refresh_workflow_assurance(uuid,uuid)')
          and function_state.prosecdef
          and pg_get_function_result(function_state.oid) = 'void'
          and not has_function_privilege('authenticated', function_state.oid, 'execute')
          and not has_function_privilege('anon', function_state.oid, 'execute')
          and pg_get_functiondef(function_state.oid) like '%check_state.enabled%'
          and pg_get_functiondef(function_state.oid) like '%not check_state.pending_setup%'
          and pg_get_functiondef(function_state.oid) like '%evidence_origin = ''service''%'
          and pg_get_functiondef(function_state.oid) like '%latest_conclusive%'
      ) as workflow_assurance_function_ready
      ,exists (
        select 1
        from pg_proc function_state
        where function_state.oid = to_regprocedure('public.claim_due_checks(integer,integer,text)')
          and array_position(function_state.proargnames, 'check_updated_at') is not null
          and array_position(function_state.proargnames, 'workflow_updated_at') is not null
      ) as claim_due_checks_cas_columns_ready
      ,(
        has_table_privilege('authenticated', 'public.check_runs', 'select')
        and not has_table_privilege('authenticated', 'public.check_runs', 'insert')
        and not has_table_privilege('authenticated', 'public.check_runs', 'update')
        and not has_table_privilege('authenticated', 'public.check_runs', 'delete')
        and has_table_privilege('authenticated', 'public.check_job_runs', 'select')
        and not has_table_privilege('authenticated', 'public.check_job_runs', 'insert')
        and not has_table_privilege('authenticated', 'public.check_job_runs', 'update')
        and not has_table_privilege('authenticated', 'public.check_job_runs', 'delete')
        and has_table_privilege('service_role', 'public.check_runs', 'insert')
        and has_table_privilege('service_role', 'public.check_job_runs', 'insert')
        and (
          select count(*) = 2 and bool_and(table_state.relrowsecurity)
          from pg_class table_state
          where table_state.oid in ('public.check_runs'::regclass, 'public.check_job_runs'::regclass)
        )
      ) as authenticated_evidence_tables_select_only
      ,not exists (
        select 1
        from information_schema.column_privileges privilege_state
        where privilege_state.grantee = 'authenticated'
          and privilege_state.table_schema = 'public'
          and privilege_state.table_name in ('check_runs', 'check_job_runs')
          and privilege_state.privilege_type in ('INSERT', 'UPDATE')
      ) as authenticated_evidence_column_writes_absent
      ,(
        select count(*) = 2
        from pg_policies policy_state
        where policy_state.schemaname = 'public'
          and policy_state.tablename in ('check_runs', 'check_job_runs')
          and policy_state.policyname in ('check_runs_members_select', 'check_job_runs_members_select')
          and policy_state.cmd = 'SELECT'
          and 'authenticated' = any(policy_state.roles)
      ) and not exists (
        select 1
        from pg_policies policy_state
        where policy_state.schemaname = 'public'
          and policy_state.tablename in ('check_runs', 'check_job_runs')
          and (
            'authenticated' = any(policy_state.roles)
            or 'public' = any(policy_state.roles)
          )
          and policy_state.cmd <> 'SELECT'
      ) as authenticated_evidence_write_policies_absent
      ,(
        select count(*) = 4
        from pg_constraint constraint_state
        where constraint_state.conname in (
          'workflows_saved_endpoint_safe',
          'workflows_saved_execution_safe',
          'checks_saved_config_safe',
          'checks_saved_assertions_safe'
        )
          and constraint_state.conrelid in ('public.workflows'::regclass, 'public.checks'::regclass)
          and constraint_state.contype = 'c'
          and constraint_state.convalidated
      ) as public_monitor_constraints_ready
      ,(
        select count(*) = 4
        from (
          values
            ('checks_enforce_active_saved_endpoint', 'public.checks'::regclass),
            ('checks_refresh_workflow_assurance', 'public.checks'::regclass),
            ('checks_mark_assurance_reports_stale', 'public.checks'::regclass),
            ('workflows_prevent_active_endpoint_removal', 'public.workflows'::regclass)
        ) as expected(trigger_name, relation_id)
        join pg_trigger trigger_state
          on trigger_state.tgname = expected.trigger_name
          and trigger_state.tgrelid = expected.relation_id
          and not trigger_state.tgisinternal
          and trigger_state.tgenabled <> 'D'
      ) as public_monitor_triggers_ready
      ,exists (
        select 1
        from pg_trigger trigger_state
        where trigger_state.tgname = 'checks_refresh_workflow_assurance'
          and trigger_state.tgrelid = 'public.checks'::regclass
          and trigger_state.tgfoid = to_regprocedure('public.refresh_workflow_assurance_after_check_change()')
          and not trigger_state.tgisinternal
          and trigger_state.tgenabled <> 'D'
          and pg_get_triggerdef(trigger_state.oid) like '% AFTER %'
          and pg_get_triggerdef(trigger_state.oid) like '%enabled%'
          and pg_get_triggerdef(trigger_state.oid) like '%pending_setup%'
          and pg_get_triggerdef(trigger_state.oid) like '%workflow_id%'
          and pg_get_triggerdef(trigger_state.oid) like '%agency_id%'
      ) as workflow_assurance_trigger_ready
      ,${isContractPhase ? `not exists (
        select 1
        from public.workflows workflow_state
        where not public.saved_monitor_endpoint_is_safe(workflow_state.endpoint_url)
           or workflow_state.method <> 'GET'::public.workflow_method
           or workflow_state.auth_type <> 'none'
           or workflow_state.request_body <> ''
           or workflow_state.store_raw_response
           or not public.saved_monitor_headers_are_safe(workflow_state.encrypted_auth_config)
      ) and not exists (
        select 1
        from public.checks check_state
        where not public.saved_monitor_check_config_is_safe(check_state.config_json)
           or not public.saved_monitor_assertions_are_safe(check_state.assertions_json)
      ) and not exists (
        select 1
        from public.checks check_state
        join public.workflows workflow_state
          on workflow_state.id = check_state.workflow_id
          and workflow_state.agency_id = check_state.agency_id
        where check_state.enabled
          and not check_state.pending_setup
          and workflow_state.endpoint_url = ''
      )` : "false"} as public_monitor_rows_safe
      ,${isContractPhase ? `not exists (
        select 1
        from public.workflows workflow_state
        left join lateral (
          select
            coalesce(max(case
              when latest_attempt.status::text = 'failed' then 4
              when latest_attempt.status::text = 'degraded' then 3
              when latest_attempt.status::text = 'skipped'
                and latest_conclusive.status::text = 'failed' then 4
              when latest_attempt.status::text = 'skipped'
                and latest_conclusive.status::text = 'degraded' then 3
              when latest_attempt.status is null
                or latest_attempt.status::text = 'skipped' then 2
              when latest_attempt.status::text = 'healthy' then 1
              else 2
            end), 2) as risk_rank,
            max(latest_attempt.completed_at) as service_last_run_at
          from public.checks check_state
          left join lateral (
            select run_state.status, run_state.completed_at
            from public.check_runs run_state
            where run_state.agency_id = check_state.agency_id
              and run_state.check_id = check_state.id
              and run_state.evidence_origin::text = 'service'
            order by run_state.started_at desc, run_state.completed_at desc, run_state.id desc
            limit 1
          ) latest_attempt on true
          left join lateral (
            select run_state.status
            from public.check_runs run_state
            where run_state.agency_id = check_state.agency_id
              and run_state.check_id = check_state.id
              and run_state.evidence_origin::text = 'service'
              and run_state.status::text <> 'skipped'
            order by run_state.started_at desc, run_state.completed_at desc, run_state.id desc
            limit 1
          ) latest_conclusive on true
          where check_state.agency_id = workflow_state.agency_id
            and check_state.workflow_id = workflow_state.id
            and check_state.enabled
            and not check_state.pending_setup
        ) workflow_truth on true
        where row(workflow_state.status, workflow_state.health_score, workflow_state.last_check_run_at)
          is distinct from row(
            case workflow_truth.risk_rank
              when 4 then 'failed'::public.workflow_status
              when 3 then 'degraded'::public.workflow_status
              when 1 then 'healthy'::public.workflow_status
              else 'pending'::public.workflow_status
            end,
            case workflow_truth.risk_rank
              when 4 then 24
              when 3 then 68
              when 1 then 100
              else 0
            end,
            workflow_truth.service_last_run_at
          )
      )` : "false"} as workflow_assurance_rows_valid
      ,(
        select count(*) = 6
        from (
          values
            ('agencies_mark_assurance_reports_stale', 'public.agencies'::regclass),
            ('clients_mark_assurance_reports_stale', 'public.clients'::regclass),
            ('check_runs_mark_assurance_reports_stale', 'public.check_runs'::regclass),
            ('issues_mark_assurance_reports_stale', 'public.issues'::regclass),
            ('issue_notes_mark_assurance_reports_stale', 'public.issue_notes'::regclass),
            ('workflows_mark_assurance_reports_stale', 'public.workflows'::regclass)
        ) as expected(trigger_name, relation_id)
        join pg_trigger trigger_state
          on trigger_state.tgname = expected.trigger_name
          and trigger_state.tgrelid = expected.relation_id
          and trigger_state.tgfoid = to_regprocedure('public.mark_assurance_reports_stale()')
          and not trigger_state.tgisinternal
          and trigger_state.tgenabled <> 'D'
          and pg_get_triggerdef(trigger_state.oid) like '% AFTER %'
      ) as assurance_staleness_triggers_ready
      ,exists (
        select 1
        from pg_trigger trigger_state
        where trigger_state.tgname = 'issues_enforce_verification_truth'
          and trigger_state.tgrelid = 'public.issues'::regclass
          and trigger_state.tgfoid = to_regprocedure('public.enforce_issue_verification_truth()')
          and not trigger_state.tgisinternal
          and trigger_state.tgenabled <> 'D'
          and pg_get_triggerdef(trigger_state.oid) like '% BEFORE %'
      ) as issue_verification_trigger_ready
      ,exists (
        select 1
        from pg_constraint constraint_state
        where constraint_state.conname = 'issues_verification_run_agency_fkey'
          and constraint_state.conrelid = 'public.issues'::regclass
          and constraint_state.contype = 'f'
          and constraint_state.confrelid = 'public.check_runs'::regclass
          and constraint_state.confdeltype = 'a'
          and constraint_state.convalidated
          and replace(pg_get_constraintdef(constraint_state.oid), 'public.', '')
            like 'FOREIGN KEY (verification_run_id, agency_id) REFERENCES check_runs(id, agency_id)%'
      ) as issue_verification_fk_ready
      ,(
        select count(*) = 2
          and bool_and(pg_get_constraintdef(constraint_state.oid) like '%report_safe_summary%')
        from pg_constraint constraint_state
        where constraint_state.conrelid = 'public.issues'::regclass
          and constraint_state.conname in (
            'issues_verified_resolution_truth_check',
            'issues_repair_review_truth_check'
          )
          and constraint_state.contype = 'c'
          and constraint_state.convalidated
      ) as issue_truth_constraints_ready
      ,exists (
        select 1
        from pg_constraint constraint_state
        where constraint_state.conname = 'reports_pdf_snapshot_binding_check'
          and constraint_state.conrelid = 'public.reports'::regclass
          and constraint_state.contype = 'c'
          and constraint_state.convalidated
          and pg_get_constraintdef(constraint_state.oid) like '%pdf_snapshot_version%'
          and pg_get_constraintdef(constraint_state.oid) like '%snapshot_version > 0%'
      ) as report_pdf_binding_ready
      ,not exists (
        select 1
        from pg_policies
        where schemaname = 'storage'
          and tablename = 'objects'
          and policyname in (
            'report_pdfs_select_members',
            'report_pdfs_insert_members',
            'report_pdfs_update_members',
            'report_pdfs_delete_admins'
          )
      ) as report_pdf_write_policies_absent
      ,not exists (
        select 1
        from public.issues issue_state
        left join public.check_runs verification_run
          on verification_run.id = issue_state.verification_run_id
          and verification_run.agency_id = issue_state.agency_id
          and verification_run.client_id = issue_state.client_id
          and verification_run.workflow_id = issue_state.workflow_id
          and verification_run.check_id = issue_state.check_id
        left join public.check_runs source_run
          on source_run.id = issue_state.check_run_id
          and source_run.agency_id = issue_state.agency_id
          and source_run.client_id = issue_state.client_id
          and source_run.workflow_id = issue_state.workflow_id
          and source_run.check_id = issue_state.check_id
        where (
          issue_state.status::text = 'resolved'
          and (
            issue_state.repair_recorded_at is null
            or issue_state.resolved_at is null
            or issue_state.verification_run_id is null
            or btrim(issue_state.resolution_note) = ''
            or (issue_state.reportable and btrim(issue_state.report_safe_summary) = '')
            or verification_run.id is null
            or source_run.evidence_origin::text is distinct from 'service'
            or verification_run.evidence_origin::text is distinct from 'service'
            or verification_run.status::text <> 'healthy'
            or verification_run.started_at <= issue_state.repair_recorded_at
            or verification_run.completed_at < verification_run.started_at
            or issue_state.resolved_at is distinct from verification_run.completed_at
            or (
              select latest_run.status::text
              from public.check_runs latest_run
              where latest_run.agency_id = issue_state.agency_id
                and latest_run.client_id = issue_state.client_id
                and latest_run.workflow_id = issue_state.workflow_id
                and latest_run.check_id = issue_state.check_id
                and latest_run.evidence_origin::text = 'service'
                and latest_run.status::text <> 'skipped'
                and latest_run.started_at > issue_state.repair_recorded_at
              order by latest_run.started_at desc, latest_run.completed_at desc, latest_run.id desc
              limit 1
            ) is distinct from 'healthy'
          )
        ) or (
          issue_state.status::text <> 'resolved'
          and (issue_state.resolved_at is not null or issue_state.verification_run_id is not null)
        ) or (
          issue_state.status::text = 'in_review'
          and (
            issue_state.repair_recorded_at is null
            or btrim(issue_state.resolution_note) = ''
            or (issue_state.reportable and btrim(issue_state.report_safe_summary) = '')
          )
        )
      ) as issue_verification_rows_valid
      ,not exists (
        select 1
        from pg_proc
        join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
        where pg_namespace.nspname = 'public'
          and pg_proc.proname in (
            'claim_contact_sales_lead_notifications',
            'record_contact_sales_lead_notification_result',
            'requeue_contact_sales_lead_notification',
            'provision_accepted_pilot_workspace'
          )
      ) as paid_pilot_functions_absent
      ,to_regclass('public.contact_sales_leads') is not null as historical_contact_sales_leads_present
  `)
  const cronCatalog = await client.query(`
    select to_regclass('cron.job') is not null as available
  `)
  const historicalContactSalesLeadCountAfter = permissions.rows[0]?.historical_contact_sales_leads_present === true
    ? String((await client.query("select count(*)::bigint as count from public.contact_sales_leads")).rows[0]?.count ?? "0")
    : null
  let paidPilotRetryJobAbsent = true
  let schedulerCapacityReady = !isProductionBuild
  const expectedSchedulerBatchSize = isContractPhase ? 5 : 1

  if (cronCatalog.rows[0]?.available) {
    const cronState = await client.query(`
      select
        not exists (
          select 1
          from cron.job
          where jobname = 'maintainflow-retry-pilot-lead-notifications'
        ) as paid_pilot_absent,
        (
          select count(*) = 2
            and count(distinct jobname) = 2
            and bool_and(active)
            and bool_and(schedule = '* * * * *')
            and bool_and(command like '%/api/cron/run-checks%')
            and bool_and(command ~* 'timeout_milliseconds\\s*:=\\s*60000')
            and bool_and(command ~* '''batchSize''\\s*,\\s*${expectedSchedulerBatchSize}')
          from cron.job
          where jobname in ('maintainflow-run-checks', 'maintainflow-run-checks-2')
        ) as scheduler_capacity_ready
    `)
    paidPilotRetryJobAbsent = cronState.rows[0]?.paid_pilot_absent === true
    schedulerCapacityReady = cronState.rows[0]?.scheduler_capacity_ready === true
  }

  const state = {
    ...permissions.rows[0],
    historical_contact_sales_leads_preserved:
      !historicalContactSalesLeadsExisted
      || (
        permissions.rows[0]?.historical_contact_sales_leads_present === true
        && historicalContactSalesLeadCountAfter === historicalContactSalesLeadCountBefore
    ),
    paid_pilot_retry_job_absent: paidPilotRetryJobAbsent,
    scheduler_capacity_ready: schedulerCapacityReady,
    scheduler_batch_size: expectedSchedulerBatchSize,
  }

  if (
    !state
    || !state.authenticated_can_create
    || state.authenticated_can_update_plan
    || state.authenticated_can_update_subscription
    || state.authenticated_can_insert_agency
    || state.authenticated_can_delete_agency
    || state.authenticated_can_delete_membership
    || state.authenticated_can_update_membership_role
    || state.authenticated_can_reassign_membership_user
    || state.authenticated_can_reassign_membership_agency
    || !state.free_plan_ready
    || !state.one_workspace_per_user_ready
    || !state.client_limit_trigger_ready
    || !state.workflow_limit_trigger_ready
    || !state.report_limit_trigger_ready
    || !state.workflow_frequency_guard_ready
    || !state.check_frequency_guard_ready
    || !state.business_evals_foundation_ready
    || !state.business_evals_rpcs_ready
    || !state.business_evals_service_boundary_ready
    || !state.issue_verification_columns_ready
    || !state.report_snapshot_columns_ready
    || !state.report_item_snapshot_column_ready
    || !state.check_run_provenance_column_ready
    || !state.authenticated_cannot_name_service_origin
    || !state.check_evidence_privacy_trigger_ready
    || !state.check_evidence_rows_privacy_safe
    || !state.atomic_check_result_rpc_ready
    || !state.workflow_assurance_function_ready
    || !state.claim_due_checks_cas_columns_ready
    || !state.scheduler_capacity_ready
    || (!isContractPhase && !state.expand_check_run_provenance_policies_ready)
    || (
      isContractPhase
      && (
        !state.authenticated_evidence_tables_select_only
        || !state.authenticated_evidence_column_writes_absent
        || !state.authenticated_evidence_write_policies_absent
        || !state.public_monitor_constraints_ready
        || !state.public_monitor_triggers_ready
        || !state.public_monitor_rows_safe
        || !state.workflow_assurance_trigger_ready
        || !state.workflow_assurance_rows_valid
        || !state.assurance_staleness_triggers_ready
        || !state.issue_verification_trigger_ready
        || !state.issue_verification_fk_ready
        || !state.issue_truth_constraints_ready
        || !state.issue_verification_rows_valid
        || !state.report_pdf_binding_ready
        || !state.report_pdf_write_policies_absent
        || !state.paid_pilot_functions_absent
        || !state.historical_contact_sales_leads_preserved
        || !state.paid_pilot_retry_job_absent
      )
    )
  ) {
    throw new Error(`Self-serve workspace access has unexpected privileges: ${JSON.stringify(state)}`)
  }

  await client.query(isDryRun ? "rollback" : "commit")
  transactionOpen = false

  console.log(
    isDryRun
      ? "Self-serve workspace access: dry run verified and rolled back."
      : "Self-serve workspace access: applied and verified.",
    {
      migrationPhase,
      databaseConnection: connectionLabel,
      authenticatedCanCreate: state.authenticated_can_create,
      billingColumnsProtected: !state.authenticated_can_update_plan && !state.authenticated_can_update_subscription,
      agencyCreationRestrictedToRpc: !state.authenticated_can_insert_agency && !state.authenticated_can_delete_agency,
      membershipIdentityProtected:
        !state.authenticated_can_delete_membership
        && !state.authenticated_can_update_membership_role
        && !state.authenticated_can_reassign_membership_user
        && !state.authenticated_can_reassign_membership_agency,
      businessEvalsFoundationReady:
        state.business_evals_foundation_ready
        && state.business_evals_rpcs_ready
        && state.business_evals_service_boundary_ready,
      freePlanReady: state.free_plan_ready,
      oneWorkspacePerUserReady: state.one_workspace_per_user_ready,
      billingLimitTriggersReady:
        state.client_limit_trigger_ready && state.workflow_limit_trigger_ready && state.report_limit_trigger_ready,
      minimumScheduleGuardsReady: state.workflow_frequency_guard_ready && state.check_frequency_guard_ready,
      assuranceExpansionReady:
        state.issue_verification_columns_ready
        && state.report_snapshot_columns_ready
        && state.report_item_snapshot_column_ready
        && state.check_evidence_privacy_trigger_ready
        && state.check_evidence_rows_privacy_safe
        && state.atomic_check_result_rpc_ready
        && state.claim_due_checks_cas_columns_ready,
      atomicCheckEvidenceReady:
        state.atomic_check_result_rpc_ready
        && state.workflow_assurance_function_ready
        && state.claim_due_checks_cas_columns_ready
        && state.check_run_provenance_column_ready
        && state.authenticated_cannot_name_service_origin,
      evidenceProvenanceReady: isContractPhase
        ? state.authenticated_evidence_column_writes_absent
        : state.expand_check_run_provenance_policies_ready,
      schedulerCapacityReady: state.scheduler_capacity_ready,
      schedulerBatchSize: state.scheduler_batch_size,
      serviceEvidenceWriteBoundaryReady: isContractPhase
        ? state.authenticated_evidence_tables_select_only
          && state.authenticated_evidence_write_policies_absent
          && state.authenticated_evidence_column_writes_absent
        : null,
      publicMonitorPersistenceBoundaryReady: isContractPhase
        ? state.public_monitor_constraints_ready
          && state.public_monitor_triggers_ready
          && state.public_monitor_rows_safe
        : null,
      publicMonitorImpactBeforeContract: isContractPhase ? publicMonitorImpactBeforeContract : null,
      assuranceContractReady: isContractPhase
        ? state.issue_verification_fk_ready
          && state.issue_verification_trigger_ready
          && state.issue_truth_constraints_ready
          && state.issue_verification_rows_valid
          && state.workflow_assurance_trigger_ready
          && state.workflow_assurance_rows_valid
          && state.report_pdf_binding_ready
          && state.report_pdf_write_policies_absent
          && state.assurance_staleness_triggers_ready
        : null,
      paidPilotRuntimeRetired: isContractPhase
        ? state.paid_pilot_functions_absent && state.paid_pilot_retry_job_absent
        : null,
      historicalContactSalesLeadsPreserved: isContractPhase
        ? state.historical_contact_sales_leads_preserved
        : null,
    },
  )
} catch (error) {
  if (transactionOpen) await client.query("rollback").catch(() => undefined)
  throw error
} finally {
  await client.end()
}

function withoutTransactionWrapper(source) {
  return source
    .replace(/(^|\n)\s*begin;\s*(?=\n)/i, "$1")
    .replace(/\n\s*commit;\s*$/i, "\n")
}

async function connectDatabase(connectionString) {
  try {
    return { client: await connectClient(connectionString), connectionLabel: "configured" }
  } catch (configuredError) {
    const configuredUrl = new URL(connectionString)
    const projectMatch = configuredUrl.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i)

    const configuredErrorCode = errorCode(configuredError)

    if (!projectMatch || !["ENETUNREACH", "ENOTFOUND"].includes(configuredErrorCode)) {
      throw configuredError
    }

    const projectRef = projectMatch[1]
    const regions = [
      "eu-west-1",
      "eu-central-1",
      "eu-west-2",
      "eu-west-3",
      "eu-central-2",
      "eu-north-1",
      "us-east-1",
      "us-west-1",
      "us-west-2",
      "ca-central-1",
      "ap-south-1",
      "ap-southeast-1",
      "ap-southeast-2",
      "ap-northeast-1",
      "ap-northeast-2",
      "sa-east-1",
    ]
    let lastError = configuredError

    for (const region of regions) {
      const poolerUrl = new URL(connectionString)
      poolerUrl.hostname = `aws-0-${region}.pooler.supabase.com`
      poolerUrl.port = "6543"
      poolerUrl.username = `postgres.${projectRef}`

      try {
        return { client: await connectClient(poolerUrl.toString()), connectionLabel: `supabase-pooler:${region}` }
      } catch (poolerError) {
        lastError = poolerError
      }
    }

    throw new Error(`Self-serve workspace access could not reach the configured database or a Supabase pooler. Last error: ${errorCode(lastError)}`)
  }
}

async function connectClient(connectionString) {
  const databaseUrl = new URL(connectionString)
  const localDatabase = !databaseUrl.hostname
    || databaseUrl.hostname === "localhost"
    || databaseUrl.hostname === "127.0.0.1"
    || databaseUrl.hostname === "::1"
  const supabaseDatabase = databaseUrl.hostname.endsWith(".supabase.co")
    || databaseUrl.hostname.endsWith(".pooler.supabase.com")
  const strictConnectionUrl = new URL(databaseUrl)
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    strictConnectionUrl.searchParams.delete(parameter)
  }
  const client = new pg.Client({
    connectionString: strictConnectionUrl.toString(),
    ssl: localDatabase
      ? false
      : {
          rejectUnauthorized: true,
          ...(supabaseDatabase ? { ca: supabaseRootCa } : {}),
        },
    connectionTimeoutMillis: 5_000,
  })

  try {
    await client.connect()
    return client
  } catch (error) {
    await client.end().catch(() => undefined)
    throw error
  }
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN"
}
