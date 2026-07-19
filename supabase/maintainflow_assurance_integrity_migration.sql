-- Additive production migration for truthful issue verification and immutable report evidence.
-- Historical rows and private PDF object pointers are preserved.

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

alter table public.check_runs
  add column if not exists evidence_origin public.check_run_evidence_origin
  not null default 'legacy_browser';

alter table public.issues
  add column if not exists repair_recorded_at timestamptz,
  add column if not exists verification_run_id uuid;

alter table public.reports
  add column if not exists snapshot_version integer not null default 0,
  add column if not exists snapshot_json jsonb not null default '{}'::jsonb,
  add column if not exists evidence_fingerprint text not null default '',
  add column if not exists stale_at timestamptz,
  add column if not exists pdf_snapshot_version integer;

alter table public.report_items
  add column if not exists snapshot_version integer not null default 0;

-- The old artifact may have produced another report during the expand window.
-- Preserve its row and storage pointer, but revoke readiness/PDF binding for any
-- snapshot that cites untrusted evidence before final contraction.
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

-- Older builds stored arbitrary header values under the misleading
-- encrypted_auth_config name and could classify custom credentials as safe.
-- Retain only a narrow set of request-format headers in plaintext; every other
-- value is irreversibly removed before the self-serve app reads it again.
update public.workflows w
set encrypted_auth_config = jsonb_set(
  coalesce(w.encrypted_auth_config, '{}'::jsonb),
  '{headers}',
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'key', header->>'key',
      'valuePreview', case
        when lower(btrim(header->>'key')) in ('accept', 'accept-language', 'content-type')
          then coalesce(header->>'valuePreview', '')
        else '••••'
      end,
      'sensitive', lower(btrim(header->>'key')) not in ('accept', 'accept-language', 'content-type')
    ))
    from jsonb_array_elements(
      case
        when jsonb_typeof(w.encrypted_auth_config->'headers') = 'array'
          then w.encrypted_auth_config->'headers'
        else '[]'::jsonb
      end
    ) as header
    where jsonb_typeof(header) = 'object'
      and jsonb_typeof(header->'key') = 'string'
      and jsonb_typeof(header->'valuePreview') = 'string'
  ), '[]'::jsonb),
  true
)
where w.encrypted_auth_config ? 'headers';

-- Pre-consolidation check rows could contain response excerpts or transport
-- errors. Keep status and timing evidence, but remove text that was not created
-- under the current report-safe contract. These predicates are idempotent so
-- later deployments preserve summaries produced by the current runner.
update public.check_runs
set safe_response_summary = 'Historical response details were withheld during the assurance migration.'
where btrim(coalesce(safe_response_summary, '')) <> ''
  and safe_response_summary !~ '^(JSON|HTML|Text) response was empty\.$'
  and safe_response_summary !~ '^(JSON|HTML|Text) response received \([0-9]+ bytes\); body content was not stored\.$'
  and safe_response_summary not in (
    'No response body was stored.',
    'Historical response details were withheld during the assurance migration.'
  );

update public.check_runs
set error_message = 'Historical check error details were withheld during the assurance migration.'
where btrim(coalesce(error_message, '')) <> ''
  and error_message !~ '^Expected( HTTP)? [0-9]{3} but received( HTTP)? [0-9]{3}\.$'
  and error_message !~ '^Timed out after [0-9]+ seconds\.$'
  and error_message not in (
    'Response was larger than the 128 KB safety cap.',
    'Endpoint request failed before a conclusive response was received.',
    'Historical check error details were withheld during the assurance migration.'
  );

create unique index if not exists check_runs_id_agency_uidx
  on public.check_runs (id, agency_id);

create index if not exists issues_repair_verification_idx
  on public.issues (agency_id, check_id, status, repair_recorded_at);

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'issues_verification_run_agency_fkey'
      and conrelid = 'public.issues'::regclass
      and (
        contype <> 'f'
        or confrelid <> 'public.check_runs'::regclass
        or confdeltype <> 'a'
      )
  ) then
    alter table public.issues drop constraint issues_verification_run_agency_fkey;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'issues_verification_run_agency_fkey'
      and conrelid = 'public.issues'::regclass
  ) then
    alter table public.issues
      add constraint issues_verification_run_agency_fkey
      foreign key (verification_run_id, agency_id)
      references public.check_runs (id, agency_id)
      on delete no action;
  end if;
end $$;

-- Treat the old resolved_at as the time the repair was recorded, then bind only a
-- genuinely newer passing run. Legacy claims without proof return to review.
update public.issues
set repair_recorded_at = coalesce(repair_recorded_at, resolved_at, updated_at)
where status::text = 'resolved'
  and btrim(resolution_note) <> ''
  and repair_recorded_at is null;

with latest_after_repair as (
  select
    i.id as issue_id,
    i.agency_id,
    i.resolution_note,
    i.repair_recorded_at,
    latest.id as run_id,
    latest.status,
    latest.started_at,
    latest.completed_at
  from public.issues i
  left join lateral (
    select cr.id, cr.status, cr.started_at, cr.completed_at
    from public.check_runs cr
    where cr.agency_id = i.agency_id
      and cr.client_id = i.client_id
      and cr.workflow_id = i.workflow_id
      and cr.check_id = i.check_id
      and cr.evidence_origin = 'service'::public.check_run_evidence_origin
      and cr.status::text <> 'skipped'
      and cr.started_at > i.repair_recorded_at
      and exists (
        select 1
        from public.check_runs source_run
        where source_run.id = i.check_run_id
          and source_run.agency_id = i.agency_id
          and source_run.client_id = i.client_id
          and source_run.workflow_id = i.workflow_id
          and source_run.check_id = i.check_id
          and source_run.evidence_origin = 'service'::public.check_run_evidence_origin
      )
    order by cr.started_at desc, cr.completed_at desc, cr.id desc
    limit 1
  ) latest on true
  where i.status::text = 'resolved'
    and i.repair_recorded_at is not null
)
update public.issues i
set status = case
      when btrim(latest_after_repair.resolution_note) <> ''
        and latest_after_repair.status::text = 'healthy'
        and latest_after_repair.completed_at >= latest_after_repair.started_at
        then 'resolved'::public.issue_status
      when latest_after_repair.status::text in ('degraded', 'failed')
        then 'open'::public.issue_status
      when btrim(latest_after_repair.resolution_note) <> ''
        then 'in_review'::public.issue_status
      else 'open'::public.issue_status
    end,
    verification_run_id = case
      when btrim(latest_after_repair.resolution_note) <> ''
        and latest_after_repair.status::text = 'healthy'
        and latest_after_repair.completed_at >= latest_after_repair.started_at
        then latest_after_repair.run_id
      else null
    end,
    resolved_at = case
      when btrim(latest_after_repair.resolution_note) <> ''
        and latest_after_repair.status::text = 'healthy'
        and latest_after_repair.completed_at >= latest_after_repair.started_at
        then latest_after_repair.completed_at
      else null
    end,
    repair_recorded_at = case
      when btrim(latest_after_repair.resolution_note) = ''
        or latest_after_repair.status::text in ('degraded', 'failed')
        then null
      else latest_after_repair.repair_recorded_at
    end
from latest_after_repair
where i.id = latest_after_repair.issue_id
  and i.agency_id = latest_after_repair.agency_id;

update public.issues
set status = 'open'::public.issue_status,
    repair_recorded_at = null,
    resolved_at = null,
    verification_run_id = null
where status::text = 'resolved'
  and (repair_recorded_at is null or btrim(resolution_note) = '');

update public.issues
set status = 'open'::public.issue_status,
    repair_recorded_at = null,
    resolved_at = null,
    verification_run_id = null
where status::text = 'in_review'
  and (repair_recorded_at is null or btrim(resolution_note) = '');

-- Internal repair notes must never be copied into client-safe report text.
-- Reopen reportable legacy rows that lack an explicit safe summary so they
-- remain stored but cannot qualify a client report as verified.
update public.issues
set status = 'open'::public.issue_status,
    repair_recorded_at = null,
    resolved_at = null,
    verification_run_id = null
where reportable
  and status::text in ('resolved', 'in_review')
  and btrim(report_safe_summary) = '';

update public.issues
set resolved_at = null,
    verification_run_id = null
where status::text <> 'resolved';

-- Legacy/browser runs may have left workflow and check cursors looking green.
-- Rebuild those customer-facing fields strictly from the latest service-issued
-- result per check; no trusted run means pending/inconclusive.
with check_truth as (
  select
    check_state.id,
    check_state.agency_id,
    latest.completed_at as service_last_run_at
  from public.checks check_state
  left join lateral (
    select run_state.completed_at
    from public.check_runs run_state
    where run_state.agency_id = check_state.agency_id
      and run_state.check_id = check_state.id
      and run_state.evidence_origin = 'service'::public.check_run_evidence_origin
    order by run_state.started_at desc, run_state.completed_at desc, run_state.id desc
    limit 1
  ) latest on true
)
update public.checks check_state
set last_run_at = check_truth.service_last_run_at,
    updated_at = now()
from check_truth
where check_state.id = check_truth.id
  and check_state.agency_id = check_truth.agency_id
  and check_state.last_run_at is distinct from check_truth.service_last_run_at;

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

create or replace function public.refresh_workflow_assurance_after_check_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_workflow_assurance(old.agency_id, old.workflow_id);
    return old;
  end if;

  if tg_op = 'UPDATE'
    and (old.agency_id, old.workflow_id) is distinct from (new.agency_id, new.workflow_id) then
    perform public.refresh_workflow_assurance(old.agency_id, old.workflow_id);
  end if;

  perform public.refresh_workflow_assurance(new.agency_id, new.workflow_id);
  return new;
end;
$$;

revoke all on function public.refresh_workflow_assurance_after_check_change()
  from public, anon, authenticated;

drop trigger if exists checks_refresh_workflow_assurance on public.checks;
create trigger checks_refresh_workflow_assurance
after insert or delete or update of enabled, pending_setup, workflow_id, agency_id
on public.checks
for each row execute function public.refresh_workflow_assurance_after_check_change();

do $$
declare
  workflow_scope record;
begin
  for workflow_scope in
    select workflow_state.agency_id, workflow_state.id
    from public.workflows workflow_state
  loop
    perform public.refresh_workflow_assurance(workflow_scope.agency_id, workflow_scope.id);
  end loop;
end;
$$;

do $$
begin
  alter table public.issues drop constraint if exists issues_verified_resolution_truth_check;
  alter table public.issues
    add constraint issues_verified_resolution_truth_check check (
      (
        status::text = 'resolved'
        and repair_recorded_at is not null
        and resolved_at is not null
        and verification_run_id is not null
        and (not reportable or btrim(report_safe_summary) <> '')
      )
      or (
        status::text <> 'resolved'
        and resolved_at is null
        and verification_run_id is null
      )
    );

  alter table public.issues drop constraint if exists issues_repair_review_truth_check;
  alter table public.issues
    add constraint issues_repair_review_truth_check check (
      status::text <> 'in_review'
      or (
        repair_recorded_at is not null
        and btrim(resolution_note) <> ''
        and (not reportable or btrim(report_safe_summary) <> '')
      )
    );

  if not exists (
    select 1 from pg_constraint
    where conname = 'reports_snapshot_version_nonnegative'
      and conrelid = 'public.reports'::regclass
  ) then
    alter table public.reports
      add constraint reports_snapshot_version_nonnegative check (snapshot_version >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'reports_pdf_snapshot_binding_check'
      and conrelid = 'public.reports'::regclass
  ) then
    alter table public.reports
      add constraint reports_pdf_snapshot_binding_check check (
        pdf_snapshot_version is null
        or (snapshot_version > 0 and pdf_snapshot_version = snapshot_version)
      );
  end if;
end $$;

create or replace function public.enforce_issue_verification_truth()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_origin text;
  verification_status text;
  verification_origin text;
  verification_started_at timestamptz;
  verification_completed_at timestamptz;
  latest_run_status text;
begin
  if new.status::text <> 'resolved' then
    return new;
  end if;

  if new.repair_recorded_at is null
    or new.resolved_at is null
    or new.verification_run_id is null
    or btrim(new.resolution_note) = ''
    or (new.reportable and btrim(new.report_safe_summary) = '') then
    raise exception using
      errcode = '23514',
      message = 'A resolved issue requires a recorded repair, a client-safe note, and a verification run.';
  end if;

  select source_run.evidence_origin::text
  into source_origin
  from public.check_runs source_run
  where source_run.id = new.check_run_id
    and source_run.agency_id = new.agency_id
    and source_run.client_id = new.client_id
    and source_run.workflow_id = new.workflow_id
    and source_run.check_id = new.check_id;

  select cr.status::text, cr.evidence_origin::text, cr.started_at, cr.completed_at
  into verification_status, verification_origin, verification_started_at, verification_completed_at
  from public.check_runs cr
  where cr.id = new.verification_run_id
    and cr.agency_id = new.agency_id
    and cr.client_id = new.client_id
    and cr.workflow_id = new.workflow_id
    and cr.check_id = new.check_id;

  if not found
    or source_origin is distinct from 'service'
    or verification_origin is distinct from 'service'
    or verification_status <> 'healthy'
    or verification_started_at <= new.repair_recorded_at
    or verification_completed_at < verification_started_at
    or new.resolved_at is distinct from verification_completed_at then
    raise exception using
      errcode = '23514',
      message = 'A resolved issue must be bound to a newer healthy run for the same check and journey.';
  end if;

  select cr.status::text
  into latest_run_status
  from public.check_runs cr
  where cr.agency_id = new.agency_id
    and cr.client_id = new.client_id
    and cr.workflow_id = new.workflow_id
    and cr.check_id = new.check_id
    and cr.evidence_origin = 'service'::public.check_run_evidence_origin
    and cr.status::text <> 'skipped'
    and cr.started_at > new.repair_recorded_at
  order by cr.started_at desc, cr.completed_at desc, cr.id desc
  limit 1;

  if latest_run_status is distinct from 'healthy' then
    raise exception using
      errcode = '23514',
      message = 'The latest non-skipped run recorded after the repair must still be healthy.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_issue_verification_truth() from public;

drop trigger if exists issues_enforce_verification_truth on public.issues;
create trigger issues_enforce_verification_truth
before insert or update of
  status,
  repair_recorded_at,
  resolved_at,
  verification_run_id,
  resolution_note,
  report_safe_summary,
  reportable,
  agency_id,
  client_id,
  workflow_id,
  check_id
on public.issues
for each row execute function public.enforce_issue_verification_truth();

-- Legacy reports have no immutable evidence snapshot. Preserve their rows and PDF
-- paths, but require a refresh before the old artifact can be downloaded as current.
update public.reports
set status = case when status::text = 'sent' then status else 'blocked'::public.report_status end,
    stale_at = coalesce(stale_at, now()),
    readiness_json = jsonb_set(
      jsonb_set(coalesce(readiness_json, '{}'::jsonb), '{snapshotCurrent}', 'false'::jsonb, true),
      '{pdfGenerated}',
      'false'::jsonb,
      true
    ),
    pdf_snapshot_version = null,
    updated_at = now()
where snapshot_version = 0;

create or replace function public.mark_assurance_reports_stale()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_agency_id uuid;
  target_client_id uuid;
  target_workflow_id uuid;
  target_issue_id uuid;
  evidence_at timestamptz;
  mark_new_scope boolean;
begin
  if tg_table_name = 'agencies' then
    if tg_op <> 'UPDATE' then
      if tg_op = 'DELETE' then return old; else return new; end if;
    end if;
    if row(old.name, old.report_sender_name, old.report_sender_email)
      is not distinct from row(new.name, new.report_sender_name, new.report_sender_email) then
      return new;
    end if;

    update public.reports r
    set status = 'blocked'::public.report_status,
        stale_at = coalesce(r.stale_at, now()),
        readiness_json = jsonb_set(
          jsonb_set(coalesce(r.readiness_json, '{}'::jsonb), '{snapshotCurrent}', 'false'::jsonb, true),
          '{pdfGenerated}', 'false'::jsonb, true
        ),
        pdf_snapshot_version = null,
        updated_at = now()
    where r.agency_id = old.id
      and r.snapshot_version > 0
      and r.status::text <> 'sent';
    return new;
  end if;

  if tg_table_name = 'clients' then
    if tg_op <> 'UPDATE' then
      if tg_op = 'DELETE' then return old; else return new; end if;
    end if;
    if row(old.name, old.website, old.report_recipient_email)
      is not distinct from row(new.name, new.website, new.report_recipient_email) then
      return new;
    end if;

    update public.reports r
    set status = 'blocked'::public.report_status,
        stale_at = coalesce(r.stale_at, now()),
        readiness_json = jsonb_set(
          jsonb_set(coalesce(r.readiness_json, '{}'::jsonb), '{snapshotCurrent}', 'false'::jsonb, true),
          '{pdfGenerated}', 'false'::jsonb, true
        ),
        pdf_snapshot_version = null,
        updated_at = now()
    where r.agency_id = old.agency_id
      and r.client_id = old.id
      and r.snapshot_version > 0
      and r.status::text <> 'sent';
    return new;
  end if;

  if tg_table_name = 'check_runs' then
    if tg_op = 'UPDATE' then
      if row(
        old.agency_id,
        old.client_id,
        old.workflow_id,
        old.check_id,
        old.evidence_origin,
        old.status,
        old.status_code,
        old.latency_ms,
        old.safe_response_summary,
        old.error_message,
        old.started_at,
        old.completed_at,
        old.created_at
      ) is not distinct from row(
        new.agency_id,
        new.client_id,
        new.workflow_id,
        new.check_id,
        new.evidence_origin,
        new.status,
        new.status_code,
        new.latency_ms,
        new.safe_response_summary,
        new.error_message,
        new.started_at,
        new.completed_at,
        new.created_at
      ) then
        return new;
      end if;
    end if;

    if tg_op in ('UPDATE', 'DELETE') then
      target_agency_id := old.agency_id;
      target_client_id := old.client_id;
      target_workflow_id := old.workflow_id;
      evidence_at := old.created_at;

      update public.reports r
      set status = 'blocked'::public.report_status,
          stale_at = coalesce(r.stale_at, now()),
          readiness_json = jsonb_set(
            jsonb_set(coalesce(r.readiness_json, '{}'::jsonb), '{snapshotCurrent}', 'false'::jsonb, true),
            '{pdfGenerated}', 'false'::jsonb, true
          ),
          pdf_snapshot_version = null,
          updated_at = now()
      where r.agency_id = target_agency_id
        and r.client_id = target_client_id
        and r.snapshot_version > 0
        and r.status::text <> 'sent'
        and evidence_at::date between r.period_start and r.period_end
        and (
          coalesce(r.snapshot_json->'workflowIds', '[]'::jsonb) ? target_workflow_id::text
          or exists (
            select 1 from public.workflows w
            where w.id = target_workflow_id
              and w.agency_id = target_agency_id
              and w.client_id = target_client_id
              and w.report_included
              and w.archived_at is null
          )
        );
    end if;

    mark_new_scope := false;
    if tg_op = 'INSERT' then
      mark_new_scope := true;
    elsif tg_op = 'UPDATE' then
      mark_new_scope := row(old.agency_id, old.client_id, old.workflow_id, old.created_at)
        is distinct from row(new.agency_id, new.client_id, new.workflow_id, new.created_at);
    end if;

    if mark_new_scope then
      target_agency_id := new.agency_id;
      target_client_id := new.client_id;
      target_workflow_id := new.workflow_id;
      evidence_at := new.created_at;

      update public.reports r
      set status = 'blocked'::public.report_status,
          stale_at = coalesce(r.stale_at, now()),
          readiness_json = jsonb_set(
            jsonb_set(coalesce(r.readiness_json, '{}'::jsonb), '{snapshotCurrent}', 'false'::jsonb, true),
            '{pdfGenerated}', 'false'::jsonb, true
          ),
          pdf_snapshot_version = null,
          updated_at = now()
      where r.agency_id = target_agency_id
        and r.client_id = target_client_id
        and r.snapshot_version > 0
        and r.status::text <> 'sent'
        and evidence_at::date between r.period_start and r.period_end
        and (
          coalesce(r.snapshot_json->'workflowIds', '[]'::jsonb) ? target_workflow_id::text
          or exists (
            select 1 from public.workflows w
            where w.id = target_workflow_id
              and w.agency_id = target_agency_id
              and w.client_id = target_client_id
              and w.report_included
              and w.archived_at is null
          )
        );
    end if;

    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_table_name = 'issues' then
    if tg_op = 'UPDATE' then
      if row(
        old.id,
        old.agency_id,
        old.client_id,
        old.workflow_id,
        old.check_id,
        old.check_run_id,
        old.verification_run_id,
        old.severity,
        old.status,
        old.title,
        old.reportable,
        old.occurrence_count,
        old.resolved_at,
        old.report_safe_summary,
        old.created_at
      ) is not distinct from row(
        new.id,
        new.agency_id,
        new.client_id,
        new.workflow_id,
        new.check_id,
        new.check_run_id,
        new.verification_run_id,
        new.severity,
        new.status,
        new.title,
        new.reportable,
        new.occurrence_count,
        new.resolved_at,
        new.report_safe_summary,
        new.created_at
      ) then
        return new;
      end if;
    end if;

    if tg_op in ('UPDATE', 'DELETE') then
      target_agency_id := old.agency_id;
      target_client_id := old.client_id;
      target_workflow_id := old.workflow_id;
      target_issue_id := old.id;

      update public.reports r
      set status = 'blocked'::public.report_status,
          stale_at = coalesce(r.stale_at, now()),
          readiness_json = jsonb_set(
            jsonb_set(coalesce(r.readiness_json, '{}'::jsonb), '{snapshotCurrent}', 'false'::jsonb, true),
            '{pdfGenerated}', 'false'::jsonb, true
          ),
          pdf_snapshot_version = null,
          updated_at = now()
      where r.agency_id = target_agency_id
        and r.client_id = target_client_id
        and r.snapshot_version > 0
        and r.status::text <> 'sent'
        and (
          coalesce(r.snapshot_json->'issueIds', '[]'::jsonb) ? target_issue_id::text
          or coalesce(r.snapshot_json->'workflowIds', '[]'::jsonb) ? target_workflow_id::text
        );
    end if;

    mark_new_scope := false;
    if tg_op = 'INSERT' then
      mark_new_scope := true;
    elsif tg_op = 'UPDATE' then
      mark_new_scope := row(old.id, old.agency_id, old.client_id, old.workflow_id)
        is distinct from row(new.id, new.agency_id, new.client_id, new.workflow_id);
    end if;

    if mark_new_scope then
      target_agency_id := new.agency_id;
      target_client_id := new.client_id;
      target_workflow_id := new.workflow_id;
      target_issue_id := new.id;

      update public.reports r
      set status = 'blocked'::public.report_status,
          stale_at = coalesce(r.stale_at, now()),
          readiness_json = jsonb_set(
            jsonb_set(coalesce(r.readiness_json, '{}'::jsonb), '{snapshotCurrent}', 'false'::jsonb, true),
            '{pdfGenerated}', 'false'::jsonb, true
          ),
          pdf_snapshot_version = null,
          updated_at = now()
      where r.agency_id = target_agency_id
        and r.client_id = target_client_id
        and r.snapshot_version > 0
        and r.status::text <> 'sent'
        and (
          coalesce(r.snapshot_json->'issueIds', '[]'::jsonb) ? target_issue_id::text
          or coalesce(r.snapshot_json->'workflowIds', '[]'::jsonb) ? target_workflow_id::text
        );
    end if;

    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_table_name = 'issue_notes' then
    if tg_op = 'UPDATE' then
      if row(old.agency_id, old.issue_id, old.body, old.report_safe, old.created_at)
        is not distinct from row(new.agency_id, new.issue_id, new.body, new.report_safe, new.created_at) then
        return new;
      end if;
    end if;

    if tg_op in ('UPDATE', 'DELETE') then
      if old.report_safe then
        target_agency_id := old.agency_id;
        target_issue_id := old.issue_id;

        update public.reports r
        set status = 'blocked'::public.report_status,
            stale_at = coalesce(r.stale_at, now()),
            readiness_json = jsonb_set(
              jsonb_set(coalesce(r.readiness_json, '{}'::jsonb), '{snapshotCurrent}', 'false'::jsonb, true),
              '{pdfGenerated}', 'false'::jsonb, true
            ),
            pdf_snapshot_version = null,
            updated_at = now()
        where r.agency_id = target_agency_id
          and r.snapshot_version > 0
          and r.status::text <> 'sent'
          and coalesce(r.snapshot_json->'issueIds', '[]'::jsonb) ? target_issue_id::text;
      end if;
    end if;

    mark_new_scope := false;
    if tg_op = 'INSERT' then
      mark_new_scope := new.report_safe;
    elsif tg_op = 'UPDATE' then
      mark_new_scope := new.report_safe
        and (
          not old.report_safe
          or row(old.agency_id, old.issue_id) is distinct from row(new.agency_id, new.issue_id)
        );
    end if;

    if mark_new_scope then
      target_agency_id := new.agency_id;
      target_issue_id := new.issue_id;

      update public.reports r
      set status = 'blocked'::public.report_status,
          stale_at = coalesce(r.stale_at, now()),
          readiness_json = jsonb_set(
            jsonb_set(coalesce(r.readiness_json, '{}'::jsonb), '{snapshotCurrent}', 'false'::jsonb, true),
            '{pdfGenerated}', 'false'::jsonb, true
          ),
          pdf_snapshot_version = null,
          updated_at = now()
      where r.agency_id = target_agency_id
        and r.snapshot_version > 0
        and r.status::text <> 'sent'
        and coalesce(r.snapshot_json->'issueIds', '[]'::jsonb) ? target_issue_id::text;
    end if;

    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_table_name = 'workflows' then
    if tg_op = 'UPDATE' then
      if row(
        old.id,
        old.agency_id,
        old.client_id,
        old.name,
        old.type,
        old.environment,
        old.endpoint_url,
        old.method,
        old.auth_type,
        old.encrypted_auth_config,
        old.request_body,
        old.expected_status,
        old.timeout_seconds,
        old.max_latency_ms,
        old.frequency_minutes,
        old.retries,
        old.store_raw_response,
        old.status,
        old.health_score,
        old.report_included,
        old.archived_at
      ) is not distinct from row(
        new.id,
        new.agency_id,
        new.client_id,
        new.name,
        new.type,
        new.environment,
        new.endpoint_url,
        new.method,
        new.auth_type,
        new.encrypted_auth_config,
        new.request_body,
        new.expected_status,
        new.timeout_seconds,
        new.max_latency_ms,
        new.frequency_minutes,
        new.retries,
        new.store_raw_response,
        new.status,
        new.health_score,
        new.report_included,
        new.archived_at
      ) then
        return new;
      end if;
    end if;

    if tg_op in ('UPDATE', 'DELETE') then
      target_agency_id := old.agency_id;
      target_client_id := old.client_id;
      target_workflow_id := old.id;

      update public.reports r
      set status = 'blocked'::public.report_status,
          stale_at = coalesce(r.stale_at, now()),
          readiness_json = jsonb_set(
            jsonb_set(coalesce(r.readiness_json, '{}'::jsonb), '{snapshotCurrent}', 'false'::jsonb, true),
            '{pdfGenerated}', 'false'::jsonb, true
          ),
          pdf_snapshot_version = null,
          updated_at = now()
      where r.agency_id = target_agency_id
        and r.client_id = target_client_id
        and r.snapshot_version > 0
        and r.status::text <> 'sent'
        and (
          coalesce(r.snapshot_json->'workflowIds', '[]'::jsonb) ? target_workflow_id::text
          or old.report_included
        );
    end if;

    if tg_op in ('INSERT', 'UPDATE') then
      target_agency_id := new.agency_id;
      target_client_id := new.client_id;
      target_workflow_id := new.id;

      update public.reports r
      set status = 'blocked'::public.report_status,
          stale_at = coalesce(r.stale_at, now()),
          readiness_json = jsonb_set(
            jsonb_set(coalesce(r.readiness_json, '{}'::jsonb), '{snapshotCurrent}', 'false'::jsonb, true),
            '{pdfGenerated}', 'false'::jsonb, true
          ),
          pdf_snapshot_version = null,
          updated_at = now()
      where r.agency_id = target_agency_id
        and r.client_id = target_client_id
        and r.snapshot_version > 0
        and r.status::text <> 'sent'
        and (
          coalesce(r.snapshot_json->'workflowIds', '[]'::jsonb) ? target_workflow_id::text
          or new.report_included
        );
    end if;

    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

revoke all on function public.mark_assurance_reports_stale() from public;

drop trigger if exists agencies_mark_assurance_reports_stale on public.agencies;
create trigger agencies_mark_assurance_reports_stale
after update of name, report_sender_name, report_sender_email on public.agencies
for each row execute function public.mark_assurance_reports_stale();

drop trigger if exists clients_mark_assurance_reports_stale on public.clients;
create trigger clients_mark_assurance_reports_stale
after update of name, website, report_recipient_email on public.clients
for each row execute function public.mark_assurance_reports_stale();

drop trigger if exists check_runs_mark_assurance_reports_stale on public.check_runs;
create trigger check_runs_mark_assurance_reports_stale
after insert or delete or update on public.check_runs
for each row execute function public.mark_assurance_reports_stale();

drop trigger if exists issues_mark_assurance_reports_stale on public.issues;
create trigger issues_mark_assurance_reports_stale
after insert or delete or update on public.issues
for each row execute function public.mark_assurance_reports_stale();

drop trigger if exists issue_notes_mark_assurance_reports_stale on public.issue_notes;
create trigger issue_notes_mark_assurance_reports_stale
after insert or delete or update on public.issue_notes
for each row execute function public.mark_assurance_reports_stale();

drop trigger if exists workflows_mark_assurance_reports_stale on public.workflows;
create trigger workflows_mark_assurance_reports_stale
after insert or delete or update of
  name,
  type,
  environment,
  endpoint_url,
  method,
  auth_type,
  encrypted_auth_config,
  request_body,
  expected_status,
  timeout_seconds,
  max_latency_ms,
  frequency_minutes,
  retries,
  store_raw_response,
  status,
  health_score,
  report_included,
  archived_at
on public.workflows
for each row execute function public.mark_assurance_reports_stale();

-- Snapshot PDF objects are immutable evidence. Browser JWTs have no direct
-- object access; authorized app routes validate live report state before the
-- server-only service role reads, creates, or explicitly removes an object.
drop policy if exists report_pdfs_select_members on storage.objects;
drop policy if exists report_pdfs_insert_members on storage.objects;
drop policy if exists report_pdfs_update_members on storage.objects;
drop policy if exists report_pdfs_delete_admins on storage.objects;

commit;
