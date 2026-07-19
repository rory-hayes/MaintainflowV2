-- Expansion-safe database boundary for durable check evidence.
--
-- Run after maintainflow_assurance_expansion_migration.sql and
-- maintainflow_check_evidence_privacy_migration.sql. The privacy migration
-- installs the defensive check_runs sanitizer before this service-only RPC can
-- persist evidence. This migration does not delete production data and is safe
-- to rerun while either rollout phase is active.

begin;

do $$
begin
  if not exists (
    select 1
    from pg_type type_state
    join pg_namespace namespace_state on namespace_state.oid = type_state.typnamespace
    where namespace_state.nspname = 'public'
      and type_state.typname = 'check_run_evidence_origin'
  ) then
    create type public.check_run_evidence_origin as enum ('legacy_browser', 'service');
  end if;
end $$;

-- The fail-closed default keeps the previous artifact compatible during the
-- expand phase: existing rows and any direct browser insert remain visible but
-- cannot be mistaken for evidence issued by the Maintain Flow runner.
alter table public.check_runs
  add column if not exists evidence_origin public.check_run_evidence_origin
  not null default 'legacy_browser';

create index if not exists check_runs_service_client_period_idx
  on public.check_runs (agency_id, client_id, created_at desc)
  where evidence_origin = 'service'::public.check_run_evidence_origin;

-- Preserve the previous app's append/update surface only for legacy rows. A
-- browser JWT cannot name the provenance column, insert a service row, or
-- mutate/delete a service-issued row during the expand compatibility window.
alter table public.check_runs enable row level security;

drop policy if exists check_runs_members_all on public.check_runs;
drop policy if exists check_runs_members_select on public.check_runs;
drop policy if exists check_runs_members_insert_legacy on public.check_runs;
drop policy if exists check_runs_members_update_legacy on public.check_runs;
drop policy if exists check_runs_members_delete_legacy on public.check_runs;

create policy check_runs_members_select on public.check_runs
for select to authenticated
using ((select public.is_agency_member(agency_id)));

create policy check_runs_members_insert_legacy on public.check_runs
for insert to authenticated
with check (
  (select public.is_agency_member(agency_id))
  and evidence_origin = 'legacy_browser'::public.check_run_evidence_origin
);

create policy check_runs_members_update_legacy on public.check_runs
for update to authenticated
using (
  (select public.is_agency_member(agency_id))
  and evidence_origin = 'legacy_browser'::public.check_run_evidence_origin
)
with check (
  (select public.is_agency_member(agency_id))
  and evidence_origin = 'legacy_browser'::public.check_run_evidence_origin
);

create policy check_runs_members_delete_legacy on public.check_runs
for delete to authenticated
using (
  (select public.is_agency_member(agency_id))
  and evidence_origin = 'legacy_browser'::public.check_run_evidence_origin
);

revoke insert, update on public.check_runs from authenticated;
grant insert (
  id,
  agency_id,
  client_id,
  workflow_id,
  check_id,
  status,
  status_code,
  latency_ms,
  assertion_results_json,
  result_json,
  safe_response_summary,
  error_message,
  cost_estimate,
  model,
  prompt_version,
  started_at,
  completed_at,
  created_at
) on public.check_runs to authenticated;
grant update (
  id,
  agency_id,
  client_id,
  workflow_id,
  check_id,
  status,
  status_code,
  latency_ms,
  assertion_results_json,
  result_json,
  safe_response_summary,
  error_message,
  cost_estimate,
  model,
  prompt_version,
  started_at,
  completed_at,
  created_at
) on public.check_runs to authenticated;

-- Invalidate, without deleting, snapshots and PDF bindings that cite legacy
-- evidence. This also protects the compatibility window before contract phase;
-- the retained storage path remains available for audit/recovery but the app
-- cannot mint a new download for it.
update public.reports report_state
set status = case
      when report_state.status::text = 'sent' then report_state.status
      else 'blocked'::public.report_status
    end,
    stale_at = coalesce(report_state.stale_at, now()),
    readiness_json = jsonb_set(
      jsonb_set(coalesce(report_state.readiness_json, '{}'::jsonb), '{snapshotCurrent}', 'false'::jsonb, true),
      '{pdfGenerated}',
      'false'::jsonb,
      true
    ),
    pdf_snapshot_version = null,
    updated_at = now()
where report_state.snapshot_version > 0
  and (
    report_state.stale_at is null
    or report_state.pdf_snapshot_version is not null
    or report_state.readiness_json->'snapshotCurrent' is distinct from 'false'::jsonb
    or report_state.readiness_json->'pdfGenerated' is distinct from 'false'::jsonb
    or report_state.status::text not in ('blocked', 'sent')
  )
  and (
    exists (
      select 1
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(report_state.snapshot_json->'checkRunIds') = 'array'
            then report_state.snapshot_json->'checkRunIds'
          else '[]'::jsonb
        end
      ) snapshot_run(run_id)
      join public.check_runs legacy_run
        on legacy_run.id::text = snapshot_run.run_id
        and legacy_run.agency_id = report_state.agency_id
        and legacy_run.client_id = report_state.client_id
        and legacy_run.evidence_origin = 'legacy_browser'::public.check_run_evidence_origin
    )
    or exists (
      select 1
      from public.report_items report_item
      join public.check_runs legacy_run
        on legacy_run.id::text = report_item.source_id
        and legacy_run.agency_id = report_item.agency_id
        and legacy_run.client_id = report_item.client_id
        and legacy_run.evidence_origin = 'legacy_browser'::public.check_run_evidence_origin
      where report_item.report_id = report_state.id
        and report_item.agency_id = report_state.agency_id
        and report_item.source_type::text = 'check_run'
        and report_item.snapshot_version = report_state.snapshot_version
    )
  );

-- The additional timestamps let both scheduled and interactive callers use the
-- same compare-and-swap contract. Existing callers safely ignore extra fields.
drop function if exists public.claim_due_checks(integer, integer, text);

create or replace function public.claim_due_checks(
  max_batch integer default 5,
  lease_seconds integer default 180,
  worker_id text default gen_random_uuid()::text
)
returns table (
  check_id uuid,
  agency_id uuid,
  workflow_id uuid,
  client_id uuid,
  check_name text,
  plugin_id text,
  config_json jsonb,
  assertions_json jsonb,
  schedule_minutes integer,
  workflow_name text,
  endpoint_url text,
  method public.workflow_method,
  encrypted_auth_config jsonb,
  request_body text,
  expected_status integer,
  timeout_seconds integer,
  max_latency_ms integer,
  check_updated_at timestamptz,
  workflow_updated_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select c.id
    from public.checks c
    join public.workflows w
      on w.id = c.workflow_id
      and w.agency_id = c.agency_id
    where c.enabled
      and not c.pending_setup
      and c.next_run_at is not null
      and c.next_run_at <= now()
      and (c.lease_expires_at is null or c.lease_expires_at <= now())
      and w.archived_at is null
      and not exists (
        select 1
        from public.checks active_claim
        where active_claim.workflow_id = c.workflow_id
          and active_claim.agency_id = c.agency_id
          and active_claim.lease_expires_at > now()
      )
      and c.id = (
        select candidate.id
        from public.checks candidate
        where candidate.workflow_id = c.workflow_id
          and candidate.agency_id = c.agency_id
          and candidate.enabled
          and not candidate.pending_setup
          and candidate.next_run_at is not null
          and candidate.next_run_at <= now()
          and (candidate.lease_expires_at is null or candidate.lease_expires_at <= now())
        order by candidate.next_run_at asc, candidate.created_at asc, candidate.id asc
        limit 1
      )
    order by c.next_run_at asc, c.created_at asc
    limit greatest(1, least(coalesce(max_batch, 5), 5))
    for update of c skip locked
  ),
  claimed as (
    update public.checks c
    set lease_expires_at = now() + make_interval(secs => greatest(120, least(coalesce(lease_seconds, 180), 900))),
        leased_by = coalesce(nullif(worker_id, ''), gen_random_uuid()::text),
        last_claimed_at = now(),
        updated_at = now()
    from due
    where c.id = due.id
    returning c.*
  )
  select
    c.id as check_id,
    c.agency_id,
    c.workflow_id,
    w.client_id,
    c.name as check_name,
    coalesce(nullif(c.plugin_id, ''), 'endpoint') as plugin_id,
    coalesce(c.config_json, '{}'::jsonb) as config_json,
    c.assertions_json,
    c.schedule_minutes,
    w.name as workflow_name,
    w.endpoint_url,
    w.method,
    w.encrypted_auth_config,
    w.request_body,
    w.expected_status,
    w.timeout_seconds,
    w.max_latency_ms,
    c.updated_at as check_updated_at,
    w.updated_at as workflow_updated_at
  from claimed c
  join public.workflows w
    on w.id = c.workflow_id
    and w.agency_id = c.agency_id;
$$;

revoke all on function public.claim_due_checks(integer, integer, text) from public, anon, authenticated;
grant execute on function public.claim_due_checks(integer, integer, text) to service_role;

create or replace function public.refresh_workflow_assurance(
  p_agency_id uuid,
  p_workflow_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  aggregate_risk integer;
  aggregate_last_run_at timestamptz;
begin
  with active_checks as (
    select check_state.id, check_state.agency_id
    from public.checks check_state
    where check_state.agency_id = p_agency_id
      and check_state.workflow_id = p_workflow_id
      and check_state.enabled
      and not check_state.pending_setup
  ), check_truth as (
    select
      active_check.id,
      latest_attempt.status::text as latest_status,
      latest_attempt.completed_at as latest_completed_at,
      latest_conclusive.status::text as latest_conclusive_status
    from active_checks active_check
    left join lateral (
      select run_state.status, run_state.completed_at
      from public.check_runs run_state
      where run_state.agency_id = active_check.agency_id
        and run_state.check_id = active_check.id
        and run_state.evidence_origin = 'service'::public.check_run_evidence_origin
      order by run_state.started_at desc, run_state.completed_at desc, run_state.id desc
      limit 1
    ) latest_attempt on true
    left join lateral (
      select run_state.status
      from public.check_runs run_state
      where run_state.agency_id = active_check.agency_id
        and run_state.check_id = active_check.id
        and run_state.evidence_origin = 'service'::public.check_run_evidence_origin
        and run_state.status::text <> 'skipped'
      order by run_state.started_at desc, run_state.completed_at desc, run_state.id desc
      limit 1
    ) latest_conclusive on true
  )
  select
    coalesce(max(
      case
        when check_truth.latest_status = 'failed' then 4
        when check_truth.latest_status = 'degraded' then 3
        when check_truth.latest_status = 'skipped'
          and check_truth.latest_conclusive_status = 'failed' then 4
        when check_truth.latest_status = 'skipped'
          and check_truth.latest_conclusive_status = 'degraded' then 3
        when check_truth.latest_status is null
          or check_truth.latest_status = 'skipped' then 2
        when check_truth.latest_status = 'healthy' then 1
        else 2
      end
    ), 2),
    max(check_truth.latest_completed_at)
  into aggregate_risk, aggregate_last_run_at
  from check_truth;

  update public.workflows workflow_state
  set status = case aggregate_risk
        when 4 then 'failed'::public.workflow_status
        when 3 then 'degraded'::public.workflow_status
        when 1 then 'healthy'::public.workflow_status
        else 'pending'::public.workflow_status
      end,
      health_score = case aggregate_risk
        when 4 then 24
        when 3 then 68
        when 1 then 100
        else 0
      end,
      last_check_run_at = aggregate_last_run_at,
      updated_at = now()
  where workflow_state.id = p_workflow_id
    and workflow_state.agency_id = p_agency_id
    and row(workflow_state.status, workflow_state.health_score, workflow_state.last_check_run_at)
      is distinct from row(
        case aggregate_risk
          when 4 then 'failed'::public.workflow_status
          when 3 then 'degraded'::public.workflow_status
          when 1 then 'healthy'::public.workflow_status
          else 'pending'::public.workflow_status
        end,
        case aggregate_risk
          when 4 then 24
          when 3 then 68
          when 1 then 100
          else 0
        end,
        aggregate_last_run_at
      );
end;
$$;

revoke all on function public.refresh_workflow_assurance(uuid, uuid) from public, anon, authenticated;

create or replace function public.record_assurance_check_result(
  p_check_id uuid,
  p_run_id uuid,
  p_status public.check_status,
  p_status_code integer,
  p_latency_ms integer,
  p_assertion_results_json jsonb,
  p_safe_response_summary text,
  p_error_message text,
  p_issue_fingerprint text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_expected_check_updated_at timestamptz,
  p_expected_workflow_updated_at timestamptz,
  p_advance_schedule boolean default true
)
returns table (
  run_id uuid,
  agency_id uuid,
  workflow_id uuid,
  status public.check_status
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_check_identity record;
  saved_check public.checks%rowtype;
  saved_workflow public.workflows%rowtype;
  existing_run public.check_runs%rowtype;
  sanitized_assertions jsonb;
  sanitized_safe_summary text;
  sanitized_error_message text;
  sanitized_issue_fingerprint text;
  issue_dedupe_key text;
  issue_description text;
  run_is_latest_evidence boolean := false;
  run_is_latest_non_skipped boolean := false;
begin
  if p_check_id is null or p_run_id is null or p_status is null then
    raise exception using
      errcode = '22023',
      message = 'check_id, run_id, and status are required.';
  end if;

  if p_started_at is null or p_completed_at is null or p_completed_at < p_started_at then
    raise exception using
      errcode = '22023',
      message = 'A check result requires a valid start and completion time.';
  end if;

  if p_status_code is not null and (p_status_code < 100 or p_status_code > 599) then
    raise exception using
      errcode = '22023',
      message = 'status_code must be between 100 and 599.';
  end if;

  if p_latency_ms is not null and p_latency_ms < 0 then
    raise exception using
      errcode = '22023',
      message = 'latency_ms cannot be negative.';
  end if;

  -- Read only the immutable identity first. Workflow is locked before check to
  -- match the legacy writer's update order and avoid cross-version deadlocks.
  select c.agency_id, c.workflow_id
  into saved_check_identity
  from public.checks c
  where c.id = p_check_id;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'The saved check no longer exists.';
  end if;

  select w.*
  into saved_workflow
  from public.workflows w
  where w.id = saved_check_identity.workflow_id
    and w.agency_id = saved_check_identity.agency_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'The saved workflow no longer exists.';
  end if;

  select c.*
  into saved_check
  from public.checks c
  where c.id = p_check_id
    and c.agency_id = saved_workflow.agency_id
    and c.workflow_id = saved_workflow.id
  for update;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'The saved check changed while the result was running. Reload and retry.';
  end if;

  select coalesce(jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'id', 'assertion-' || assertion_item.ordinality::text,
      'label', case
        when assertion_item.value->>'passed' = 'true' then 'Assertion passed'
        else 'Assertion failed'
      end,
      'passed', assertion_item.value->>'passed' = 'true',
      'reason', case
        when assertion_item.value->>'passed' = 'true' then null
        else 'Assertion did not meet the configured condition.'
      end
    ))
    order by assertion_item.ordinality
  ), '[]'::jsonb)
  into sanitized_assertions
  from jsonb_array_elements(
    case
      when jsonb_typeof(p_assertion_results_json) = 'array' then p_assertion_results_json
      else '[]'::jsonb
    end
  ) with ordinality as assertion_item(value, ordinality)
  where jsonb_typeof(assertion_item.value) = 'object'
    and jsonb_typeof(assertion_item.value->'passed') = 'boolean';

  sanitized_safe_summary := left(
    btrim(regexp_replace(coalesce(p_safe_response_summary, ''), '[[:cntrl:]]+', ' ', 'g')),
    1000
  );
  sanitized_error_message := left(
    btrim(regexp_replace(coalesce(p_error_message, ''), '[[:cntrl:]]+', ' ', 'g')),
    1000
  );
  sanitized_issue_fingerprint := left(
    btrim(regexp_replace(coalesce(p_issue_fingerprint, ''), '[[:cntrl:]]+', ' ', 'g')),
    512
  );

  if p_status in ('degraded'::public.check_status, 'failed'::public.check_status)
    and sanitized_issue_fingerprint = '' then
    raise exception using
      errcode = '22023',
      message = 'A degraded or failed result requires an issue fingerprint.';
  end if;

  -- A committed call is an idempotent success. A conflicting reuse of the run
  -- id fails closed. This check intentionally precedes CAS so a lost response
  -- can be retried after the first call advanced the two updated_at values.
  select cr.*
  into existing_run
  from public.check_runs cr
  where cr.id = p_run_id;

  if found then
    if existing_run.agency_id is distinct from saved_check.agency_id
      or existing_run.client_id is distinct from saved_workflow.client_id
      or existing_run.workflow_id is distinct from saved_workflow.id
      or existing_run.check_id is distinct from saved_check.id
      or existing_run.evidence_origin is distinct from 'service'::public.check_run_evidence_origin
      or existing_run.status is distinct from p_status
      or existing_run.status_code is distinct from p_status_code
      or existing_run.latency_ms is distinct from p_latency_ms
      or existing_run.assertion_results_json is distinct from sanitized_assertions
      or existing_run.result_json is distinct from '{}'::jsonb
      or existing_run.safe_response_summary is distinct from sanitized_safe_summary
      or existing_run.error_message is distinct from sanitized_error_message
      or existing_run.started_at is distinct from p_started_at
      or existing_run.completed_at is distinct from p_completed_at then
      raise exception using
        errcode = '23505',
        message = 'run_id is already bound to different check evidence.';
    end if;

    return query
    select existing_run.id, existing_run.agency_id, existing_run.workflow_id, existing_run.status;
    return;
  end if;

  if saved_check.updated_at is distinct from p_expected_check_updated_at
    or saved_workflow.updated_at is distinct from p_expected_workflow_updated_at then
    raise exception using
      errcode = '40001',
      message = 'The saved check or workflow changed while the result was running. Reload and retry.';
  end if;

  insert into public.check_runs (
    id,
    agency_id,
    client_id,
    workflow_id,
    check_id,
    evidence_origin,
    status,
    status_code,
    latency_ms,
    assertion_results_json,
    result_json,
    safe_response_summary,
    error_message,
    started_at,
    completed_at,
    created_at
  ) values (
    p_run_id,
    saved_check.agency_id,
    saved_workflow.client_id,
    saved_workflow.id,
    saved_check.id,
    'service'::public.check_run_evidence_origin,
    p_status,
    p_status_code,
    p_latency_ms,
    sanitized_assertions,
    '{}'::jsonb,
    sanitized_safe_summary,
    sanitized_error_message,
    p_started_at,
    p_completed_at,
    p_completed_at
  );

  select latest_run.id = p_run_id
  into run_is_latest_evidence
  from public.check_runs latest_run
  where latest_run.agency_id = saved_check.agency_id
    and latest_run.client_id = saved_workflow.client_id
    and latest_run.workflow_id = saved_workflow.id
    and latest_run.check_id = saved_check.id
    and latest_run.evidence_origin = 'service'::public.check_run_evidence_origin
  order by latest_run.started_at desc, latest_run.completed_at desc, latest_run.id desc
  limit 1;

  select latest_run.id = p_run_id
  into run_is_latest_non_skipped
  from public.check_runs latest_run
  where latest_run.agency_id = saved_check.agency_id
    and latest_run.client_id = saved_workflow.client_id
    and latest_run.workflow_id = saved_workflow.id
    and latest_run.check_id = saved_check.id
    and latest_run.evidence_origin = 'service'::public.check_run_evidence_origin
    and latest_run.status <> 'skipped'::public.check_status
  order by latest_run.started_at desc, latest_run.completed_at desc, latest_run.id desc
  limit 1;

  if run_is_latest_non_skipped and p_status = 'healthy'::public.check_status then
    update public.issues issue_state
    set status = 'resolved'::public.issue_status,
        resolved_at = p_completed_at,
        verification_run_id = p_run_id,
        updated_at = now()
    where issue_state.agency_id = saved_check.agency_id
      and issue_state.client_id = saved_workflow.client_id
      and issue_state.workflow_id = saved_workflow.id
      and issue_state.check_id = saved_check.id
      and issue_state.status = 'in_review'::public.issue_status
      and issue_state.repair_recorded_at < p_started_at
      and btrim(issue_state.resolution_note) <> ''
      and exists (
        select 1
        from public.check_runs source_run
        where source_run.id = issue_state.check_run_id
          and source_run.agency_id = issue_state.agency_id
          and source_run.client_id = issue_state.client_id
          and source_run.workflow_id = issue_state.workflow_id
          and source_run.check_id = issue_state.check_id
          and source_run.evidence_origin = 'service'::public.check_run_evidence_origin
      );
  elsif run_is_latest_non_skipped
    and p_status in ('degraded'::public.check_status, 'failed'::public.check_status) then
    -- Any newer failure invalidates pending or completed repair verification for
    -- this check before the matching occurrence is atomically upserted.
    update public.issues issue_state
    set status = 'open'::public.issue_status,
        repair_recorded_at = null,
        resolved_at = null,
        verification_run_id = null,
        resolution_note = '',
        report_safe_summary = '',
        snoozed_until = null,
        updated_at = now()
    where issue_state.agency_id = saved_check.agency_id
      and issue_state.client_id = saved_workflow.client_id
      and issue_state.workflow_id = saved_workflow.id
      and issue_state.check_id = saved_check.id
      and issue_state.status in ('resolved'::public.issue_status, 'in_review'::public.issue_status)
      and (
        issue_state.repair_recorded_at is null
        or p_started_at > issue_state.repair_recorded_at
      );

    issue_dedupe_key := saved_check.id::text || ':' || sanitized_issue_fingerprint;
    issue_description := left(
      saved_workflow.name || ' produced a ' || p_status::text || ' check run'
      || case when p_status_code is null then '' else ' with HTTP ' || p_status_code::text end
      || '. '
      || coalesce(
        nullif(sanitized_error_message, ''),
        nullif(sanitized_safe_summary, ''),
        'No report-safe result detail was stored.'
      ),
      2000
    );

    insert into public.issues (
      id,
      agency_id,
      client_id,
      workflow_id,
      check_run_id,
      check_id,
      dedupe_key,
      severity,
      status,
      title,
      description,
      suggested_action,
      reportable,
      occurrence_count,
      repair_recorded_at,
      resolved_at,
      verification_run_id,
      resolution_note,
      report_safe_summary,
      created_at,
      updated_at
    ) values (
      gen_random_uuid(),
      saved_check.agency_id,
      saved_workflow.client_id,
      saved_workflow.id,
      p_run_id,
      saved_check.id,
      issue_dedupe_key,
      case
        when p_status = 'failed'::public.check_status then 'high'::public.issue_severity
        else 'medium'::public.issue_severity
      end,
      'open'::public.issue_status,
      left(saved_workflow.name || case
        when p_status = 'failed'::public.check_status then ' failed'
        else ' degraded'
      end, 180),
      issue_description,
      case
        when p_status_code = 401 then 'Check authorization headers and rotate credentials.'
        else 'Review the endpoint response and rerun the source check.'
      end,
      true,
      1,
      null,
      null,
      null,
      '',
      '',
      p_completed_at,
      p_completed_at
    )
    on conflict on constraint issues_agency_dedupe_unique do update
    set check_run_id = excluded.check_run_id,
        status = case
          when issues.status in (
            'resolved'::public.issue_status,
            'ignored'::public.issue_status,
            'in_review'::public.issue_status
          ) then 'open'::public.issue_status
          else issues.status
        end,
        occurrence_count = greatest(1, issues.occurrence_count) + 1,
        repair_recorded_at = case
          when issues.status in (
            'resolved'::public.issue_status,
            'ignored'::public.issue_status,
            'in_review'::public.issue_status
          ) then null
          else issues.repair_recorded_at
        end,
        resolved_at = null,
        verification_run_id = null,
        resolution_note = case
          when issues.status in (
            'resolved'::public.issue_status,
            'ignored'::public.issue_status,
            'in_review'::public.issue_status
          ) then ''
          else issues.resolution_note
        end,
        report_safe_summary = case
          when issues.status in (
            'resolved'::public.issue_status,
            'ignored'::public.issue_status,
            'in_review'::public.issue_status
          ) then ''
          else issues.report_safe_summary
        end,
        snoozed_until = case
          when issues.status in (
            'resolved'::public.issue_status,
            'ignored'::public.issue_status,
            'in_review'::public.issue_status
          ) then null
          else issues.snoozed_until
        end,
        description = excluded.description,
        updated_at = now()
    where not (
      issues.status in ('resolved'::public.issue_status, 'in_review'::public.issue_status)
      and issues.repair_recorded_at is not null
      and p_started_at <= issues.repair_recorded_at
    );
  end if;

  -- Evidence and issue truth are durable before the scheduling and workflow
  -- cursors move. A stale historical run is retained but cannot regress them.
  if run_is_latest_evidence then
    update public.checks check_state
    set last_run_at = case
          when check_state.last_run_at is null or p_completed_at >= check_state.last_run_at then p_completed_at
          else check_state.last_run_at
        end,
        next_run_at = case
          when coalesce(p_advance_schedule, true) then p_completed_at + make_interval(mins => saved_check.schedule_minutes)
          else check_state.next_run_at
        end,
        lease_expires_at = case
          when coalesce(p_advance_schedule, true) then null
          else check_state.lease_expires_at
        end,
        leased_by = case
          when coalesce(p_advance_schedule, true) then null
          else check_state.leased_by
        end,
        updated_at = now()
    where check_state.id = saved_check.id
      and check_state.agency_id = saved_check.agency_id
      and check_state.workflow_id = saved_workflow.id;

  end if;

  perform public.refresh_workflow_assurance(saved_workflow.agency_id, saved_workflow.id);

  return query
  select p_run_id, saved_check.agency_id, saved_workflow.id, p_status;
end;
$$;

revoke all on function public.record_assurance_check_result(
  uuid,
  uuid,
  public.check_status,
  integer,
  integer,
  jsonb,
  text,
  text,
  text,
  timestamptz,
  timestamptz,
  timestamptz,
  timestamptz,
  boolean
) from public, anon, authenticated;
grant execute on function public.record_assurance_check_result(
  uuid,
  uuid,
  public.check_status,
  integer,
  integer,
  jsonb,
  text,
  text,
  text,
  timestamptz,
  timestamptz,
  timestamptz,
  timestamptz,
  boolean
) to service_role;

commit;
