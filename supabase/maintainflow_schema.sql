-- Maintain Flow Supabase schema
-- Run this file in the Supabase SQL editor for the MaintainFlow project.
-- It creates the core-loop database, RLS policies, helper RPCs, and a private
-- report PDF storage bucket. It intentionally does not contain project secrets.

begin;

create extension if not exists pgcrypto;
create extension if not exists citext;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'agency_role') then
    create type public.agency_role as enum ('owner', 'admin', 'member');
  end if;
  if not exists (select 1 from pg_type where typname = 'agency_plan') then
    create type public.agency_plan as enum ('free', 'starter', 'growth', 'scale', 'agency_plus');
  end if;
  if not exists (select 1 from pg_type where typname = 'report_cadence') then
    create type public.report_cadence as enum ('monthly', 'quarterly');
  end if;
  if not exists (select 1 from pg_type where typname = 'workflow_type') then
    create type public.workflow_type as enum ('http_endpoint', 'webhook', 'n8n', 'make', 'zapier', 'mcp_server', 'custom_api', 'manual_log');
  end if;
  if not exists (select 1 from pg_type where typname = 'workflow_environment') then
    create type public.workflow_environment as enum ('production', 'staging', 'development');
  end if;
  if not exists (select 1 from pg_type where typname = 'workflow_method') then
    create type public.workflow_method as enum ('GET', 'POST', 'PUT', 'PATCH', 'DELETE');
  end if;
  if not exists (select 1 from pg_type where typname = 'workflow_status') then
    create type public.workflow_status as enum ('pending', 'healthy', 'degraded', 'failed', 'archived');
  end if;
  if not exists (select 1 from pg_type where typname = 'check_type') then
    create type public.check_type as enum ('health', 'synthetic', 'manual_log');
  end if;
  if not exists (select 1 from pg_type where typname = 'check_status') then
    create type public.check_status as enum ('healthy', 'degraded', 'failed', 'skipped');
  end if;
  if not exists (select 1 from pg_type where typname = 'check_run_evidence_origin') then
    create type public.check_run_evidence_origin as enum ('legacy_browser', 'service');
  end if;
  if not exists (select 1 from pg_type where typname = 'check_job_status') then
    create type public.check_job_status as enum ('success', 'partial', 'failed', 'skipped');
  end if;
  if not exists (select 1 from pg_type where typname = 'issue_severity') then
    create type public.issue_severity as enum ('low', 'medium', 'high', 'critical');
  end if;
  if not exists (select 1 from pg_type where typname = 'issue_status') then
    create type public.issue_status as enum ('open', 'in_review', 'snoozed', 'resolved', 'ignored');
  end if;
  if not exists (select 1 from pg_type where typname = 'report_status') then
    create type public.report_status as enum ('draft', 'ready', 'sent', 'blocked');
  end if;
  if not exists (select 1 from pg_type where typname = 'report_item_source_type') then
    create type public.report_item_source_type as enum ('workflow', 'check_run', 'issue', 'recommendation', 'synthetic_test');
  end if;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email citext not null,
  name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  logo_url text,
  primary_color text,
  plan public.agency_plan not null default 'free',
  trial_ends_at timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_subscription_status text,
  complimentary_entitlement boolean not null default false,
  complimentary_entitlement_reason text,
  report_sender_name text not null default '',
  report_sender_email citext,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agencies_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint agencies_primary_color_format check (primary_color is null or primary_color ~ '^#[0-9a-fA-F]{6}$'),
  constraint agencies_stripe_subscription_status_valid check (
    stripe_subscription_status is null
    or stripe_subscription_status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')
  ),
  constraint agencies_complimentary_entitlement_reason_required check (
    not complimentary_entitlement
    or (plan <> 'free'::public.agency_plan and length(trim(coalesce(complimentary_entitlement_reason, ''))) > 0)
  )
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.agency_role not null default 'member',
  created_at timestamptz not null default now(),
  constraint memberships_agency_user_unique unique (agency_id, user_id)
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  name text not null,
  slug text not null,
  website text not null default '',
  logo_url text,
  owner_user_id uuid references public.profiles(id) on delete set null,
  report_recipient_email citext,
  report_cadence public.report_cadence not null default 'monthly',
  notes text not null default '',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clients_agency_slug_unique unique (agency_id, slug),
  constraint clients_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create or replace function public.saved_monitor_endpoint_is_safe(endpoint_url text)
returns boolean
language sql
immutable
strict
as $$
  select
    endpoint_url = ''
    or (
      endpoint_url = btrim(endpoint_url)
      and length(endpoint_url) <= 2048
      and endpoint_url ~* '^https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::[0-9]{1,5})?(/[^?#[:space:]]*)?$'
      and endpoint_url !~* '^https://[0-9.]+(?::[0-9]{1,5})?(/|$)'
      and endpoint_url !~* '^https://[^/:]+\.(?:localhost|local|internal|home\.arpa)(?::[0-9]{1,5})?(/|$)'
      and endpoint_url !~* '^https://demo\.maintainflow\.test(?::[0-9]{1,5})?(/|$)'
    );
$$;

create or replace function public.saved_monitor_headers_are_safe(auth_config jsonb)
returns boolean
language sql
immutable
strict
as $$
  select case
    when jsonb_typeof(auth_config) <> 'object' then false
    when exists (
      select 1 from jsonb_object_keys(auth_config) as config_key
      where config_key <> 'headers'
    ) then false
    when auth_config ? 'headers' and jsonb_typeof(auth_config->'headers') <> 'array' then false
    when not (auth_config ? 'headers') then true
    else jsonb_array_length(auth_config->'headers') = 0
  end;
$$;

create or replace function public.saved_monitor_check_config_is_safe(check_config jsonb)
returns boolean
language sql
immutable
strict
as $$
  select case
    when jsonb_typeof(check_config) <> 'object' then false
    when exists (
      select 1 from jsonb_object_keys(check_config) as config_key
      where config_key not in ('expectedStatus', 'timeoutSeconds', 'maxLatencyMs')
    ) then false
    else
      case
        when not (check_config ? 'expectedStatus') then true
        when jsonb_typeof(check_config->'expectedStatus') <> 'number' then false
        else
          (check_config->>'expectedStatus')::numeric = trunc((check_config->>'expectedStatus')::numeric)
          and (check_config->>'expectedStatus')::numeric between 100 and 599
      end
      and case
        when not (check_config ? 'timeoutSeconds') then true
        when jsonb_typeof(check_config->'timeoutSeconds') <> 'number' then false
        else (check_config->>'timeoutSeconds')::numeric between 1 and 30
      end
      and case
        when not (check_config ? 'maxLatencyMs') then true
        when jsonb_typeof(check_config->'maxLatencyMs') <> 'number' then false
        else (check_config->>'maxLatencyMs')::numeric between 100 and 60000
      end
  end;
$$;

create or replace function public.saved_monitor_assertions_are_safe(assertions jsonb)
returns boolean
language sql
immutable
strict
as $$
  select case
    when jsonb_typeof(assertions) <> 'array' then false
    when jsonb_array_length(assertions) > 10 then false
    else not exists (
      select 1
      from jsonb_array_elements(assertions) as assertion_item(value)
      where case
        when jsonb_typeof(assertion_item.value) <> 'object' then true
        when jsonb_typeof(assertion_item.value->'id') <> 'string' then true
        when assertion_item.value->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' then true
        when jsonb_typeof(assertion_item.value->'enabled') <> 'boolean' then true
        when assertion_item.value->>'type' = 'response_exists' then
          not (assertion_item.value ?& array['id', 'type', 'enabled'])
          or (
            select count(*) <> 3
            from jsonb_object_keys(assertion_item.value)
          )
        when assertion_item.value->>'type' = 'json_field_exists' then
          not (assertion_item.value ?& array['id', 'type', 'path', 'enabled'])
          or (
            select count(*) <> 4
            from jsonb_object_keys(assertion_item.value)
          )
          or jsonb_typeof(assertion_item.value->'path') <> 'string'
          or length(assertion_item.value->>'path') > 128
          or assertion_item.value->>'path'
            !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$'
        else true
      end
    )
  end;
$$;

create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null,
  type public.workflow_type not null default 'http_endpoint',
  environment public.workflow_environment not null default 'production',
  endpoint_url text not null default '',
  method public.workflow_method not null default 'GET',
  auth_type text not null default 'none',
  encrypted_auth_config jsonb not null default '{}'::jsonb,
  request_body text not null default '',
  expected_status integer not null default 200,
  timeout_seconds integer not null default 10,
  max_latency_ms integer not null default 5000,
  frequency_minutes integer not null default 60,
  retries integer not null default 2,
  report_included boolean not null default true,
  store_raw_response boolean not null default false,
  status public.workflow_status not null default 'pending',
  health_score integer not null default 0,
  last_check_run_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflows_status_code_range check (expected_status between 100 and 599),
  constraint workflows_timeout_range check (timeout_seconds between 1 and 30),
  constraint workflows_latency_positive check (max_latency_ms > 0),
  constraint workflows_frequency_safe check (frequency_minutes >= 60),
  constraint workflows_retries_range check (retries between 0 and 10),
  constraint workflows_health_score_range check (health_score between 0 and 100),
  constraint workflows_endpoint_protocol check (endpoint_url = '' or endpoint_url ~* '^https?://'),
  constraint workflows_saved_endpoint_safe check (public.saved_monitor_endpoint_is_safe(endpoint_url)),
  constraint workflows_saved_execution_safe check (
    method = 'GET'::public.workflow_method
    and auth_type = 'none'
    and request_body = ''
    and not store_raw_response
    and public.saved_monitor_headers_are_safe(encrypted_auth_config)
  )
);

create table if not exists public.checks (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  name text not null,
  type public.check_type not null default 'health',
  plugin_id text not null default 'endpoint',
  enabled boolean not null default true,
  pending_setup boolean not null default false,
  config_json jsonb not null default '{}'::jsonb,
  assertions_json jsonb not null default '[]'::jsonb,
  schedule_minutes integer not null default 60,
  last_run_at timestamptz,
  next_run_at timestamptz,
  lease_expires_at timestamptz,
  leased_by text,
  last_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint checks_schedule_safe check (schedule_minutes >= 60),
  constraint checks_plugin_id_not_blank check (length(trim(plugin_id)) > 0),
  constraint checks_config_object check (jsonb_typeof(config_json) = 'object'),
  constraint checks_assertions_array check (jsonb_typeof(assertions_json) = 'array'),
  constraint checks_saved_config_safe check (public.saved_monitor_check_config_is_safe(config_json)),
  constraint checks_saved_assertions_safe check (public.saved_monitor_assertions_are_safe(assertions_json))
);

create or replace function public.enforce_active_saved_check_endpoint()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_endpoint text;
begin
  if new.enabled and not new.pending_setup then
    select workflow_state.endpoint_url
    into saved_endpoint
    from public.workflows workflow_state
    where workflow_state.id = new.workflow_id
      and workflow_state.agency_id = new.agency_id
    for share;

    if saved_endpoint is null or saved_endpoint = '' then
      raise exception 'Enabled saved checks require a public HTTPS endpoint.'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_active_saved_check_endpoint() from public, anon, authenticated;

drop trigger if exists checks_enforce_active_saved_endpoint on public.checks;
create trigger checks_enforce_active_saved_endpoint
before insert or update of agency_id, workflow_id, enabled, pending_setup
on public.checks
for each row execute function public.enforce_active_saved_check_endpoint();

create or replace function public.prevent_active_saved_endpoint_removal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.endpoint_url = '' and exists (
    select 1
    from public.checks check_state
    where check_state.workflow_id = new.id
      and check_state.agency_id = new.agency_id
      and check_state.enabled
      and not check_state.pending_setup
  ) then
    raise exception 'Disable saved checks before removing their endpoint.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_active_saved_endpoint_removal() from public, anon, authenticated;

drop trigger if exists workflows_prevent_active_endpoint_removal on public.workflows;
create trigger workflows_prevent_active_endpoint_removal
before update of endpoint_url
on public.workflows
for each row execute function public.prevent_active_saved_endpoint_removal();

create table if not exists public.check_runs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  check_id uuid not null references public.checks(id) on delete cascade,
  evidence_origin public.check_run_evidence_origin not null default 'legacy_browser',
  status public.check_status not null,
  status_code integer,
  latency_ms integer,
  assertion_results_json jsonb not null default '[]'::jsonb,
  result_json jsonb not null default '{}'::jsonb,
  safe_response_summary text not null default '',
  error_message text not null default '',
  cost_estimate numeric(12, 6),
  model text,
  prompt_version text,
  started_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint check_runs_status_code_range check (status_code is null or status_code between 100 and 599),
  constraint check_runs_latency_nonnegative check (latency_ms is null or latency_ms >= 0),
  constraint check_runs_result_object check (jsonb_typeof(result_json) = 'object'),
  constraint check_runs_assertions_array check (jsonb_typeof(assertion_results_json) = 'array')
);

create table if not exists public.check_job_runs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  status public.check_job_status not null,
  checks_due integer not null default 0,
  checks_run integer not null default 0,
  failures integer not null default 0,
  error_message text not null default '',
  started_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint check_job_runs_counts_nonnegative check (checks_due >= 0 and checks_run >= 0 and failures >= 0)
);

create table if not exists public.issues (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  check_run_id uuid references public.check_runs(id) on delete set null,
  check_id uuid references public.checks(id) on delete set null,
  dedupe_key text not null,
  severity public.issue_severity not null default 'medium',
  status public.issue_status not null default 'open',
  title text not null,
  description text not null default '',
  suggested_action text not null default '',
  owner_user_id uuid references public.profiles(id) on delete set null,
  reportable boolean not null default true,
  occurrence_count integer not null default 1,
  snoozed_until timestamptz,
  repair_recorded_at timestamptz,
  resolved_at timestamptz,
  verification_run_id uuid,
  resolution_note text not null default '',
  report_safe_summary text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint issues_agency_dedupe_unique unique (agency_id, dedupe_key),
  constraint issues_occurrence_positive check (occurrence_count > 0),
  constraint issues_verified_resolution_truth_check check (
    (
      status = 'resolved'::public.issue_status
      and repair_recorded_at is not null
      and resolved_at is not null
      and verification_run_id is not null
      and (not reportable or btrim(report_safe_summary) <> '')
    )
    or (
      status <> 'resolved'::public.issue_status
      and resolved_at is null
      and verification_run_id is null
    )
  ),
  constraint issues_repair_review_truth_check check (
    status <> 'in_review'::public.issue_status
    or (
      repair_recorded_at is not null
      and btrim(resolution_note) <> ''
      and (not reportable or btrim(report_safe_summary) <> '')
    )
  )
);

create table if not exists public.issue_notes (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  issue_id uuid not null references public.issues(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  body text not null,
  report_safe boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.test_packs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  name text not null,
  description text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.test_cases (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  test_pack_id uuid not null references public.test_packs(id) on delete cascade,
  name text not null,
  input_json jsonb not null default '{}'::jsonb,
  assertions_json jsonb not null default '[]'::jsonb,
  expected_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint test_cases_assertions_array check (jsonb_typeof(assertions_json) = 'array')
);

create table if not exists public.test_runs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  test_pack_id uuid references public.test_packs(id) on delete set null,
  status public.check_status not null,
  pass_rate numeric(5, 2) not null default 0,
  results_json jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint test_runs_pass_rate_range check (pass_rate between 0 and 100),
  constraint test_runs_results_array check (jsonb_typeof(results_json) = 'array')
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status public.report_status not null default 'draft',
  narrative text not null default '',
  readiness_json jsonb not null default '{}'::jsonb,
  metrics_json jsonb not null default '{}'::jsonb,
  snapshot_version integer not null default 0,
  snapshot_json jsonb not null default '{}'::jsonb,
  evidence_fingerprint text not null default '',
  stale_at timestamptz,
  pdf_storage_path text,
  pdf_snapshot_version integer,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reports_period_order check (period_end >= period_start),
  constraint reports_snapshot_version_nonnegative check (snapshot_version >= 0),
  constraint reports_pdf_snapshot_binding_check check (
    pdf_snapshot_version is null
    or (snapshot_version > 0 and pdf_snapshot_version = snapshot_version)
  )
);

create table if not exists public.report_items (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  report_id uuid not null references public.reports(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  source_type public.report_item_source_type not null,
  source_id text,
  title text not null,
  body text not null default '',
  report_safe boolean not null default true,
  snapshot_version integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  actor_user_id uuid references public.profiles(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.run_log_keys (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  key_hash text not null unique,
  label text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists memberships_user_id_idx on public.memberships (user_id);
create unique index if not exists memberships_user_id_unique_idx
  on public.memberships (user_id);
create index if not exists memberships_agency_id_idx on public.memberships (agency_id);
create index if not exists clients_agency_id_idx on public.clients (agency_id);
create unique index if not exists clients_id_agency_uidx on public.clients (id, agency_id);
create index if not exists clients_owner_user_id_idx on public.clients (owner_user_id);
create index if not exists workflows_agency_id_idx on public.workflows (agency_id);
create unique index if not exists workflows_id_agency_uidx on public.workflows (id, agency_id);
create index if not exists workflows_client_id_idx on public.workflows (client_id);
create index if not exists workflows_report_included_idx on public.workflows (agency_id, client_id) where report_included and archived_at is null;
create index if not exists checks_agency_id_idx on public.checks (agency_id);
create unique index if not exists checks_id_agency_uidx on public.checks (id, agency_id);
create index if not exists checks_workflow_id_idx on public.checks (workflow_id);
create index if not exists checks_due_idx on public.checks (agency_id, next_run_at) where enabled and not pending_setup;
create index if not exists checks_due_claim_idx on public.checks (next_run_at, lease_expires_at) where enabled and not pending_setup;
create index if not exists check_runs_agency_created_idx on public.check_runs (agency_id, created_at desc);
create unique index if not exists check_runs_id_agency_uidx on public.check_runs (id, agency_id);
create index if not exists check_runs_client_period_idx on public.check_runs (agency_id, client_id, created_at desc);
create index if not exists check_runs_service_client_period_idx
  on public.check_runs (agency_id, client_id, created_at desc)
  where evidence_origin = 'service'::public.check_run_evidence_origin;
create index if not exists check_runs_workflow_idx on public.check_runs (workflow_id, created_at desc);
create index if not exists check_runs_check_idx on public.check_runs (check_id, created_at desc);
create index if not exists check_job_runs_agency_created_idx on public.check_job_runs (agency_id, created_at desc);
create index if not exists issues_agency_status_idx on public.issues (agency_id, status, updated_at desc);
create unique index if not exists issues_id_agency_uidx on public.issues (id, agency_id);
create index if not exists issues_client_status_idx on public.issues (agency_id, client_id, status);
create index if not exists issues_workflow_id_idx on public.issues (workflow_id);
create index if not exists issues_owner_user_id_idx on public.issues (owner_user_id);
create index if not exists issues_repair_verification_idx on public.issues (agency_id, check_id, status, repair_recorded_at);
create index if not exists issue_notes_issue_id_idx on public.issue_notes (issue_id, created_at desc);
create index if not exists test_packs_workflow_id_idx on public.test_packs (workflow_id);
create unique index if not exists test_packs_id_agency_uidx on public.test_packs (id, agency_id);
create index if not exists test_cases_pack_id_idx on public.test_cases (test_pack_id);
create index if not exists test_runs_workflow_created_idx on public.test_runs (workflow_id, created_at desc);
create index if not exists reports_client_period_idx on public.reports (agency_id, client_id, period_start desc, period_end desc);
create unique index if not exists reports_id_agency_uidx on public.reports (id, agency_id);
create index if not exists report_items_report_id_idx on public.report_items (report_id);
create index if not exists report_items_client_id_idx on public.report_items (client_id);
create index if not exists audit_events_agency_created_idx on public.audit_events (agency_id, created_at desc);
create index if not exists run_log_keys_workflow_id_idx on public.run_log_keys (workflow_id);
create index if not exists run_log_keys_agency_id_idx on public.run_log_keys (agency_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workflows_client_agency_fkey' and conrelid = 'public.workflows'::regclass) then
    alter table public.workflows
      add constraint workflows_client_agency_fkey
      foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'checks_workflow_agency_fkey' and conrelid = 'public.checks'::regclass) then
    alter table public.checks
      add constraint checks_workflow_agency_fkey
      foreign key (workflow_id, agency_id) references public.workflows (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'check_runs_client_agency_fkey' and conrelid = 'public.check_runs'::regclass) then
    alter table public.check_runs
      add constraint check_runs_client_agency_fkey
      foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'check_runs_workflow_agency_fkey' and conrelid = 'public.check_runs'::regclass) then
    alter table public.check_runs
      add constraint check_runs_workflow_agency_fkey
      foreign key (workflow_id, agency_id) references public.workflows (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'check_runs_check_agency_fkey' and conrelid = 'public.check_runs'::regclass) then
    alter table public.check_runs
      add constraint check_runs_check_agency_fkey
      foreign key (check_id, agency_id) references public.checks (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'issues_client_agency_fkey' and conrelid = 'public.issues'::regclass) then
    alter table public.issues
      add constraint issues_client_agency_fkey
      foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'issues_workflow_agency_fkey' and conrelid = 'public.issues'::regclass) then
    alter table public.issues
      add constraint issues_workflow_agency_fkey
      foreign key (workflow_id, agency_id) references public.workflows (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'issues_verification_run_agency_fkey' and conrelid = 'public.issues'::regclass) then
    alter table public.issues
      add constraint issues_verification_run_agency_fkey
      foreign key (verification_run_id, agency_id) references public.check_runs (id, agency_id)
      on delete no action;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'issue_notes_issue_agency_fkey' and conrelid = 'public.issue_notes'::regclass) then
    alter table public.issue_notes
      add constraint issue_notes_issue_agency_fkey
      foreign key (issue_id, agency_id) references public.issues (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'test_packs_workflow_agency_fkey' and conrelid = 'public.test_packs'::regclass) then
    alter table public.test_packs
      add constraint test_packs_workflow_agency_fkey
      foreign key (workflow_id, agency_id) references public.workflows (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'test_cases_pack_agency_fkey' and conrelid = 'public.test_cases'::regclass) then
    alter table public.test_cases
      add constraint test_cases_pack_agency_fkey
      foreign key (test_pack_id, agency_id) references public.test_packs (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'test_runs_workflow_agency_fkey' and conrelid = 'public.test_runs'::regclass) then
    alter table public.test_runs
      add constraint test_runs_workflow_agency_fkey
      foreign key (workflow_id, agency_id) references public.workflows (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'reports_client_agency_fkey' and conrelid = 'public.reports'::regclass) then
    alter table public.reports
      add constraint reports_client_agency_fkey
      foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'report_items_report_agency_fkey' and conrelid = 'public.report_items'::regclass) then
    alter table public.report_items
      add constraint report_items_report_agency_fkey
      foreign key (report_id, agency_id) references public.reports (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'report_items_client_agency_fkey' and conrelid = 'public.report_items'::regclass) then
    alter table public.report_items
      add constraint report_items_client_agency_fkey
      foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'run_log_keys_workflow_agency_fkey' and conrelid = 'public.run_log_keys'::regclass) then
    alter table public.run_log_keys
      add constraint run_log_keys_workflow_agency_fkey
      foreign key (workflow_id, agency_id) references public.workflows (id, agency_id) on delete cascade;
  end if;
end $$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists agencies_set_updated_at on public.agencies;
create trigger agencies_set_updated_at before update on public.agencies for each row execute function public.set_updated_at();
drop trigger if exists clients_set_updated_at on public.clients;
create trigger clients_set_updated_at before update on public.clients for each row execute function public.set_updated_at();
drop trigger if exists workflows_set_updated_at on public.workflows;
create trigger workflows_set_updated_at before update on public.workflows for each row execute function public.set_updated_at();
drop trigger if exists checks_set_updated_at on public.checks;
create trigger checks_set_updated_at before update on public.checks for each row execute function public.set_updated_at();
drop trigger if exists issues_set_updated_at on public.issues;
create trigger issues_set_updated_at before update on public.issues for each row execute function public.set_updated_at();
drop trigger if exists test_packs_set_updated_at on public.test_packs;
create trigger test_packs_set_updated_at before update on public.test_packs for each row execute function public.set_updated_at();
drop trigger if exists test_cases_set_updated_at on public.test_cases;
create trigger test_cases_set_updated_at before update on public.test_cases for each row execute function public.set_updated_at();
drop trigger if exists reports_set_updated_at on public.reports;
create trigger reports_set_updated_at before update on public.reports for each row execute function public.set_updated_at();
create or replace function public.enforce_issue_source_client_mutation_boundary()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon')
    and new.check_run_id is distinct from old.check_run_id then
    raise exception 'Incident source evidence may only be changed by the trusted service boundary.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_issue_source_client_mutation_boundary() from public;

drop trigger if exists issues_source_client_mutation_boundary on public.issues;
create trigger issues_source_client_mutation_boundary
before update of check_run_id on public.issues
for each row execute function public.enforce_issue_source_client_mutation_boundary();

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
  check_run_id,
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

create or replace function public.sanitize_check_run_evidence()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.assertion_results_json := coalesce((
    select jsonb_agg(
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
    )
    from jsonb_array_elements(
      case
        when jsonb_typeof(new.assertion_results_json) = 'array' then new.assertion_results_json
        else '[]'::jsonb
      end
    ) with ordinality as assertion_item(value, ordinality)
    where jsonb_typeof(assertion_item.value) = 'object'
      and jsonb_typeof(assertion_item.value->'passed') = 'boolean'
  ), '[]'::jsonb);
  new.result_json := '{}'::jsonb;
  return new;
end;
$$;

revoke all on function public.sanitize_check_run_evidence() from public;

drop trigger if exists check_runs_sanitize_evidence on public.check_runs;
create trigger check_runs_sanitize_evidence
before insert or update of assertion_results_json, result_json
on public.check_runs
for each row execute function public.sanitize_check_run_evidence();

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

create or replace function public.mark_check_definition_reports_stale()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and row(
    old.agency_id,
    old.workflow_id,
    old.name,
    old.type,
    old.plugin_id,
    old.enabled,
    old.pending_setup,
    old.config_json,
    old.assertions_json,
    old.schedule_minutes
  ) is not distinct from row(
    new.agency_id,
    new.workflow_id,
    new.name,
    new.type,
    new.plugin_id,
    new.enabled,
    new.pending_setup,
    new.config_json,
    new.assertions_json,
    new.schedule_minutes
  ) then
    return new;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    update public.reports report_state
    set
      status = 'blocked'::public.report_status,
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
      and report_state.status::text <> 'sent'
      and exists (
        select 1
        from public.workflows workflow_state
        where workflow_state.id = old.workflow_id
          and workflow_state.agency_id = old.agency_id
          and report_state.agency_id = workflow_state.agency_id
          and report_state.client_id = workflow_state.client_id
          and coalesce(report_state.snapshot_json->'workflowIds', '[]'::jsonb) ? workflow_state.id::text
      );
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    update public.reports report_state
    set
      status = 'blocked'::public.report_status,
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
      and report_state.status::text <> 'sent'
      and exists (
        select 1
        from public.workflows workflow_state
        where workflow_state.id = new.workflow_id
          and workflow_state.agency_id = new.agency_id
          and report_state.agency_id = workflow_state.agency_id
          and report_state.client_id = workflow_state.client_id
          and coalesce(report_state.snapshot_json->'workflowIds', '[]'::jsonb) ? workflow_state.id::text
      );
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

revoke all on function public.mark_check_definition_reports_stale() from public, anon, authenticated;

drop trigger if exists checks_mark_assurance_reports_stale on public.checks;
create trigger checks_mark_assurance_reports_stale
after insert or delete or update of
  agency_id,
  workflow_id,
  name,
  type,
  plugin_id,
  enabled,
  pending_setup,
  config_json,
  assertions_json,
  schedule_minutes
on public.checks
for each row execute function public.mark_check_definition_reports_stale();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1), ''),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
  set email = excluded.email,
      name = coalesce(nullif(public.profiles.name, ''), excluded.name),
      avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url),
      updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_agency_member(target_agency_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.agency_id = target_agency_id
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.has_agency_role(target_agency_id uuid, allowed_roles public.agency_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.agency_id = target_agency_id
      and m.user_id = (select auth.uid())
      and m.role = any(allowed_roles)
  );
$$;

create or replace function public.create_agency_workspace(
  agency_name text,
  agency_slug text,
  sender_name text default null,
  sender_email citext default null
)
returns public.agencies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := (select auth.uid());
  clean_slug text;
  created_agency public.agencies;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.';
  end if;

  if nullif(trim(coalesce(agency_name, '')), '') is null then
    raise exception 'Agency name is required.';
  end if;

  if length(trim(agency_name)) > 120 then
    raise exception 'Agency name must be 120 characters or fewer.';
  end if;

  perform pg_advisory_xact_lock(hashtext('self-serve-workspace-user:' || current_user_id::text));

  if exists (select 1 from public.memberships where user_id = current_user_id) then
    raise exception 'This account already belongs to a workspace.';
  end if;

  clean_slug := lower(regexp_replace(trim(coalesce(nullif(agency_slug, ''), agency_name)), '[^a-zA-Z0-9]+', '-', 'g'));
  clean_slug := trim(both '-' from left(clean_slug, 72));
  if clean_slug = '' then
    clean_slug := 'workspace-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  end if;

  perform pg_advisory_xact_lock(hashtext('self-serve-workspace-slug:' || clean_slug));

  if exists (select 1 from public.agencies where slug = clean_slug) then
    clean_slug := clean_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
  end if;

  insert into public.profiles (id, email, name)
  select u.id, u.email, coalesce(nullif(trim(sender_name), ''), split_part(u.email, '@', 1), '')
  from auth.users u
  where u.id = current_user_id
  on conflict (id) do update
  set email = excluded.email,
      name = coalesce(nullif(public.profiles.name, ''), excluded.name),
      updated_at = now();

  insert into public.agencies (name, slug, report_sender_name, report_sender_email, plan)
  values (trim(agency_name), clean_slug, coalesce(sender_name, ''), sender_email, 'free')
  returning * into created_agency;

  insert into public.memberships (agency_id, user_id, role)
  values (created_agency.id, current_user_id, 'owner');

  return created_agency;
end;
$$;

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

create or replace function public.storage_agency_id(object_name text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, storage
as $$
declare
  folder text;
begin
  folder := (storage.foldername(object_name))[1];
  return folder::uuid;
exception
  when others then
    return null;
end;
$$;

alter table public.profiles enable row level security;
alter table public.agencies enable row level security;
alter table public.memberships enable row level security;
alter table public.clients enable row level security;
alter table public.workflows enable row level security;
alter table public.checks enable row level security;
alter table public.check_runs enable row level security;
alter table public.check_job_runs enable row level security;
alter table public.issues enable row level security;
alter table public.issue_notes enable row level security;
alter table public.test_packs enable row level security;
alter table public.test_cases enable row level security;
alter table public.test_runs enable row level security;
alter table public.reports enable row level security;
alter table public.report_items enable row level security;
alter table public.audit_events enable row level security;
alter table public.run_log_keys enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
for select to authenticated
using (
  id = (select auth.uid())
  or exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.agency_id = mine.agency_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = profiles.id
  )
);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
for insert to authenticated
with check (id = (select auth.uid()));

drop policy if exists agencies_select_members on public.agencies;
create policy agencies_select_members on public.agencies
for select to authenticated
using ((select public.is_agency_member(id)));

drop policy if exists agencies_update_admins on public.agencies;
create policy agencies_update_admins on public.agencies
for update to authenticated
using ((select public.has_agency_role(id, array['owner', 'admin']::public.agency_role[])))
with check ((select public.has_agency_role(id, array['owner', 'admin']::public.agency_role[])));

drop policy if exists memberships_select_members on public.memberships;
create policy memberships_select_members on public.memberships
for select to authenticated
using ((select public.is_agency_member(agency_id)));

drop policy if exists memberships_manage_admins on public.memberships;
drop policy if exists memberships_insert_admins on public.memberships;
create policy memberships_insert_admins on public.memberships
for insert to authenticated
with check ((select public.has_agency_role(agency_id, array['owner', 'admin']::public.agency_role[])));

drop policy if exists memberships_update_admins on public.memberships;
create policy memberships_update_admins on public.memberships
for update to authenticated
using ((select public.has_agency_role(agency_id, array['owner', 'admin']::public.agency_role[])))
with check ((select public.has_agency_role(agency_id, array['owner', 'admin']::public.agency_role[])));

drop policy if exists clients_members_all on public.clients;
create policy clients_members_all on public.clients
for all to authenticated
using ((select public.is_agency_member(agency_id)))
with check ((select public.is_agency_member(agency_id)));

drop policy if exists workflows_members_all on public.workflows;
create policy workflows_members_all on public.workflows
for all to authenticated
using ((select public.is_agency_member(agency_id)))
with check ((select public.is_agency_member(agency_id)));

drop policy if exists checks_members_all on public.checks;
create policy checks_members_all on public.checks
for all to authenticated
using ((select public.is_agency_member(agency_id)))
with check ((select public.is_agency_member(agency_id)));

drop policy if exists check_runs_members_all on public.check_runs;
drop policy if exists check_runs_members_select on public.check_runs;
drop policy if exists check_runs_members_insert_legacy on public.check_runs;
drop policy if exists check_runs_members_update_legacy on public.check_runs;
drop policy if exists check_runs_members_delete_legacy on public.check_runs;
create policy check_runs_members_select on public.check_runs
for select to authenticated
using ((select public.is_agency_member(agency_id)));

drop policy if exists check_job_runs_members_all on public.check_job_runs;
drop policy if exists check_job_runs_members_select on public.check_job_runs;
create policy check_job_runs_members_select on public.check_job_runs
for select to authenticated
using ((select public.is_agency_member(agency_id)));

drop policy if exists issues_members_all on public.issues;
create policy issues_members_all on public.issues
for all to authenticated
using ((select public.is_agency_member(agency_id)))
with check ((select public.is_agency_member(agency_id)));

drop policy if exists issue_notes_members_all on public.issue_notes;
create policy issue_notes_members_all on public.issue_notes
for all to authenticated
using ((select public.is_agency_member(agency_id)))
with check ((select public.is_agency_member(agency_id)));

drop policy if exists test_packs_members_all on public.test_packs;
create policy test_packs_members_all on public.test_packs
for all to authenticated
using ((select public.is_agency_member(agency_id)))
with check ((select public.is_agency_member(agency_id)));

drop policy if exists test_cases_members_all on public.test_cases;
create policy test_cases_members_all on public.test_cases
for all to authenticated
using ((select public.is_agency_member(agency_id)))
with check ((select public.is_agency_member(agency_id)));

drop policy if exists test_runs_members_all on public.test_runs;
create policy test_runs_members_all on public.test_runs
for all to authenticated
using ((select public.is_agency_member(agency_id)))
with check ((select public.is_agency_member(agency_id)));

drop policy if exists reports_members_all on public.reports;
create policy reports_members_all on public.reports
for all to authenticated
using ((select public.is_agency_member(agency_id)))
with check ((select public.is_agency_member(agency_id)));

drop policy if exists report_items_members_all on public.report_items;
create policy report_items_members_all on public.report_items
for all to authenticated
using ((select public.is_agency_member(agency_id)))
with check ((select public.is_agency_member(agency_id)));

drop policy if exists audit_events_members_select on public.audit_events;
create policy audit_events_members_select on public.audit_events
for select to authenticated
using ((select public.is_agency_member(agency_id)));

drop policy if exists audit_events_members_insert on public.audit_events;
create policy audit_events_members_insert on public.audit_events
for insert to authenticated
with check ((select public.is_agency_member(agency_id)));

drop policy if exists run_log_keys_members_all on public.run_log_keys;
create policy run_log_keys_members_all on public.run_log_keys
for all to authenticated
using ((select public.is_agency_member(agency_id)))
with check ((select public.is_agency_member(agency_id)));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('maintainflow-reports', 'maintainflow-reports', false, 10485760, array['application/pdf'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists report_pdfs_select_members on storage.objects;
drop policy if exists report_pdfs_insert_members on storage.objects;
drop policy if exists report_pdfs_update_members on storage.objects;
drop policy if exists report_pdfs_delete_admins on storage.objects;

-- Browser JWTs have no direct report-object access. The authorized app route
-- validates current evidence, then the service role reads or creates the
-- immutable snapshot object.

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.check_runs, public.check_job_runs from authenticated;
grant select on public.check_runs, public.check_job_runs to authenticated;
grant select, insert on public.check_runs, public.check_job_runs to service_role;
revoke update, delete on public.memberships from authenticated;
grant update (role) on public.memberships to authenticated;
grant select, insert, update, delete on public.memberships to service_role;
revoke insert, update, delete on public.agencies from authenticated;
grant update (name, slug, logo_url, primary_color, report_sender_name, report_sender_email, updated_at)
on public.agencies to authenticated;
revoke all on function public.create_agency_workspace(text, text, text, citext) from public, anon;
grant execute on function public.create_agency_workspace(text, text, text, citext) to authenticated;
revoke all on function public.claim_due_checks(integer, integer, text) from public;
revoke all on function public.claim_due_checks(integer, integer, text) from anon;
revoke all on function public.claim_due_checks(integer, integer, text) from authenticated;
grant execute on function public.claim_due_checks(integer, integer, text) to service_role;
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
grant execute on function public.is_agency_member(uuid) to authenticated;
grant execute on function public.has_agency_role(uuid, public.agency_role[]) to authenticated;

-- Business-evals fresh-schema extension. Keep this block in parity with
-- maintainflow_business_evals_migration.sql.
alter table public.agencies
  add column if not exists team_trial_started_at timestamptz,
  add column if not exists team_trial_ends_at timestamptz,
  add column if not exists team_trial_used_at timestamptz,
  add column if not exists eval_run_monthly_limit_override integer,
  add column if not exists billing_contract_version text not null default 'legacy';

alter table public.clients
  add column if not exists project_kind text not null default 'client_site';

alter table public.clients alter column project_kind set default 'client_site';
update public.clients set project_kind = 'client_site'
where project_kind not in ('own_product', 'client_site', 'personal');

alter table public.workflows
  add column if not exists journey_template text not null default 'legacy_endpoint',
  add column if not exists draft_definition_json jsonb not null default '{}'::jsonb,
  add column if not exists draft_revision integer not null default 0,
  add column if not exists active_journey_version_id uuid,
  add column if not exists paused_at timestamptz,
  add column if not exists pause_reason text not null default '';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agencies_team_trial_window_valid') then
    alter table public.agencies add constraint agencies_team_trial_window_valid check (
      (team_trial_started_at is null and team_trial_ends_at is null and team_trial_used_at is null)
      or (
        team_trial_started_at is not null
        and team_trial_ends_at is not null
        and team_trial_used_at is not null
        and team_trial_ends_at > team_trial_started_at
        and team_trial_used_at <= team_trial_started_at
      )
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agencies_eval_run_limit_valid') then
    alter table public.agencies add constraint agencies_eval_run_limit_valid check (
      eval_run_monthly_limit_override is null or eval_run_monthly_limit_override >= 0
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agencies_billing_contract_version_valid') then
    alter table public.agencies add constraint agencies_billing_contract_version_valid check (
      billing_contract_version in ('legacy', 'business_evals_v1')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'clients_project_kind_valid') then
    alter table public.clients add constraint clients_project_kind_valid check (
      project_kind in ('own_product', 'client_site', 'personal')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workflows_journey_template_valid') then
    alter table public.workflows add constraint workflows_journey_template_valid check (
      journey_template in ('lead_form', 'trial_signup', 'legacy_endpoint')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workflows_draft_definition_object') then
    alter table public.workflows add constraint workflows_draft_definition_object check (
      jsonb_typeof(draft_definition_json) = 'object'
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workflows_draft_revision_nonnegative') then
    alter table public.workflows add constraint workflows_draft_revision_nonnegative check (draft_revision >= 0);
  end if;
end $$;

create or replace function public.enforce_team_trial_one_time()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.team_trial_used_at is not null and (
    new.team_trial_used_at is distinct from old.team_trial_used_at
    or new.team_trial_started_at is distinct from old.team_trial_started_at
    or new.team_trial_ends_at is distinct from old.team_trial_ends_at
  ) then
    raise exception 'The card-free Team trial can only be used once.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists agencies_enforce_team_trial_one_time on public.agencies;
create trigger agencies_enforce_team_trial_one_time
before update of team_trial_started_at, team_trial_ends_at, team_trial_used_at
on public.agencies for each row execute function public.enforce_team_trial_one_time();

create or replace function public.approved_action_domains_are_safe(domains jsonb)
returns boolean
language sql
immutable
strict
set search_path = public
as $$
  select jsonb_typeof(domains) = 'array'
    and jsonb_array_length(domains) between 1 and 20
    and not exists (
      select 1 from jsonb_array_elements(domains) item
      where jsonb_typeof(item) <> 'string'
        or item #>> '{}' <> lower(item #>> '{}')
        or item #>> '{}' !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$'
        or item #>> '{}' ~ '(?:^|\.)(?:localhost|local|internal|home\.arpa)$'
        or item #>> '{}' = 'metadata.google.internal'
    );
$$;

create or replace function public.hostname_is_covered_by_project_authorization(
  target_hostname text,
  attested_hostname text,
  approved_domains jsonb
)
returns boolean
language sql
immutable
strict
set search_path = public
as $$
  select case
    when lower(target_hostname) !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$'
      or jsonb_typeof(approved_domains) <> 'array' then false
    else lower(target_hostname) = lower(attested_hostname)
      or exists (
        select 1
        from jsonb_array_elements_text(approved_domains) approved(hostname)
        where lower(target_hostname) = lower(approved.hostname)
          or lower(target_hostname) like '%.' || lower(approved.hostname)
      )
  end;
$$;

create or replace function public.restricted_journey_locator_is_valid(locator jsonb)
returns boolean
language sql
immutable
strict
set search_path = public
as $$
  select case
    when jsonb_typeof(locator) <> 'object' then false
    when locator->>'kind' = 'role' then
      jsonb_typeof(locator->'role') = 'string'
      and length(trim(locator->>'role')) between 1 and 50
      and jsonb_typeof(locator->'name') = 'string'
      and length(trim(locator->>'name')) between 1 and 200
      and locator - array['kind','role','name']::text[] = '{}'::jsonb
    when locator->>'kind' in ('label', 'placeholder', 'test_id') then
      jsonb_typeof(locator->'value') = 'string'
      and length(trim(locator->>'value')) between 1 and 200
      and locator - array['kind','value']::text[] = '{}'::jsonb
    when locator->>'kind' = 'text' then
      jsonb_typeof(locator->'value') = 'string'
      and length(trim(locator->>'value')) between 1 and 200
      and (not (locator ? 'exact') or jsonb_typeof(locator->'exact') = 'boolean')
      and locator - array['kind','value','exact']::text[] = '{}'::jsonb
    else false
  end;
$$;

create or replace function public.restricted_journey_template_is_valid(
  p_template text,
  p_definition jsonb
)
returns boolean
language sql
immutable
strict
set search_path = public
as $$
  with stage_rows as (
    select stage.value as stage, (stage.value->>'position')::integer as stage_position,
      coalesce((stage.value->>'cleanup')::boolean, false) as stage_cleanup
    from jsonb_array_elements(p_definition->'stages') as stage(value)
  ), action_rows as (
    select
      stage_rows.stage_position * 100 + action.ordinality::integer as action_sequence,
      stage_rows.stage_position,
      stage_rows.stage_cleanup,
      action.value as action
    from stage_rows
    cross join lateral jsonb_array_elements(stage_rows.stage->'actions')
      with ordinality as action(value, ordinality)
  ), stats as (
    select
      count(*) filter (where action->>'type' = 'navigate') as navigate_count,
      count(*) filter (where action->>'type' = 'fill') as fill_count,
      count(*) filter (where action->>'type' = 'fill' and action->>'operation' = 'text') as text_fill_count,
      count(*) filter (where action->>'type' = 'fill' and action->>'operation' = 'text' and action->>'valueKey' = 'email') as email_fill_count,
      count(*) filter (where action->>'type' = 'fill' and action->>'operation' = 'text' and action->>'valueKey' = 'message') as message_fill_count,
      count(*) filter (where action->>'type' = 'click') as click_count,
      count(*) filter (where not stage_cleanup and action->>'type' in ('wait_for_url', 'wait_for_text', 'assert_visible')) as business_assertion_count,
      count(*) filter (where stage_cleanup and action->>'type' in ('wait_for_url', 'wait_for_text', 'assert_visible')) as cleanup_assertion_count,
      count(*) filter (where action->>'type' = 'wait_for_email') as email_wait_count,
      count(*) filter (
        where action->>'type' = 'wait_for_email'
          and coalesce(action->>'proofMode', 'autoresponse') = 'autoresponse'
      ) as autoresponse_email_wait_count,
      count(*) filter (
        where action->>'type' = 'wait_for_email'
          and action->>'proofMode' = 'forwarded_marker'
      ) as forwarded_email_wait_count,
      count(*) filter (where action->>'type' = 'open_email_link') as email_link_count,
      count(*) filter (where action->>'type' = 'cleanup') as cleanup_count,
      count(distinct stage_position) filter (where stage_cleanup) as cleanup_stage_count,
      max(stage_position) as final_stage_position,
      max(stage_position) filter (where stage_cleanup) as cleanup_stage_position,
      min(action_sequence) filter (where action->>'type' = 'navigate') as navigate_sequence,
      min(action_sequence) filter (where action->>'type' = 'fill') as first_fill_sequence,
      max(action_sequence) filter (where action->>'type' = 'fill') as last_fill_sequence,
      min(action_sequence) filter (where action->>'type' = 'click') as submit_sequence,
      max(action_sequence) filter (where not stage_cleanup and action->>'type' in ('wait_for_url', 'wait_for_text', 'assert_visible')) as last_business_assertion_sequence,
      min(action_sequence) filter (where stage_cleanup and action->>'type' in ('wait_for_url', 'wait_for_text', 'assert_visible')) as first_cleanup_assertion_sequence,
      max(action_sequence) filter (where stage_cleanup and action->>'type' in ('wait_for_url', 'wait_for_text', 'assert_visible')) as last_cleanup_assertion_sequence,
      min(action_sequence) filter (where action->>'type' = 'wait_for_email') as email_wait_sequence,
      min(action_sequence) filter (where action->>'type' = 'open_email_link') as email_link_sequence,
      min(action_sequence) filter (where action->>'type' = 'cleanup') as cleanup_sequence,
      max(action_sequence) as final_action_sequence,
      bool_and(
        action->>'type' <> 'fill'
        or action->>'operation' <> 'text'
        or action->>'valueKey' in ('marker', 'first_name', 'last_name', 'full_name', 'name', 'email', 'company', 'workspace', 'message', 'password', 'number', 'url')
      ) as fill_keys_valid,
      bool_and(
        action->>'type' <> 'wait_for_email'
        or (
          coalesce(action->>'proofMode', 'autoresponse') = 'autoresponse'
          and action->>'recipientKey' = 'email'
        )
        or (
          action->>'proofMode' = 'forwarded_marker'
          and action->>'recipientKey' = 'forwarding'
        )
      ) as email_recipient_valid,
      min(action->>'mode') filter (where action->>'type' = 'cleanup') as cleanup_mode
    from action_rows
  )
  select
    jsonb_typeof(p_definition) = 'object'
    and p_definition->>'template' = p_template
    and jsonb_typeof(p_definition->'emailProofConfigured') = 'boolean'
    and jsonb_typeof(p_definition->'cleanupMode') = 'string'
    and stats.navigate_count = 1
    and stats.text_fill_count >= 1
    and stats.click_count = 1
    and stats.business_assertion_count >= 1
    and stats.fill_keys_valid
    and stats.email_recipient_valid
    and stats.navigate_sequence < stats.first_fill_sequence
    and stats.last_fill_sequence < stats.submit_sequence
    and stats.last_business_assertion_sequence > stats.submit_sequence
    and coalesce((p_definition->>'emailProofConfigured')::boolean, false) = (stats.email_wait_count > 0)
    and case p_template
      when 'lead_form' then
        p_definition->>'cleanupMode' = 'none'
        and stats.cleanup_count = 0
        and stats.cleanup_stage_count = 0
        and stats.email_link_count = 0
        and stats.email_wait_count <= 1
        and (stats.autoresponse_email_wait_count = 0 or stats.email_fill_count >= 1)
        and (stats.forwarded_email_wait_count = 0 or stats.message_fill_count >= 1)
        and (stats.email_wait_sequence is null or stats.email_wait_sequence > stats.submit_sequence)
      when 'trial_signup' then
        p_definition->>'cleanupMode' in ('in_product', 'webhook')
        and stats.email_fill_count >= 1
        and stats.email_wait_count = 1
        and stats.autoresponse_email_wait_count = 1
        and stats.forwarded_email_wait_count = 0
        and stats.email_link_count = 1
        and stats.cleanup_count = 1
        and stats.cleanup_stage_count = 1
        and stats.cleanup_stage_position = stats.final_stage_position
        and stats.cleanup_mode = p_definition->>'cleanupMode'
        and stats.submit_sequence < stats.email_wait_sequence
        and stats.email_wait_sequence < stats.email_link_sequence
        and stats.email_link_sequence < stats.last_business_assertion_sequence
        and stats.last_business_assertion_sequence < stats.cleanup_sequence
        and case stats.cleanup_mode
          when 'webhook' then
            stats.cleanup_assertion_count = 0
            and stats.cleanup_sequence = stats.final_action_sequence
          when 'in_product' then
            stats.cleanup_assertion_count >= 1
            and stats.cleanup_sequence < stats.first_cleanup_assertion_sequence
            and stats.last_cleanup_assertion_sequence = stats.final_action_sequence
          else false
        end
      else false
    end
  from stats;
$$;

create table if not exists public.project_authorizations (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  hostname citext not null,
  attestation_version text not null,
  attested_by_user_id uuid not null references public.profiles(id) on delete restrict,
  attested_at timestamptz not null,
  approved_action_domains jsonb not null default '[]'::jsonb,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_authorizations_hostname_valid check (
    hostname = lower(hostname::text) and hostname::text ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$'
  ),
  constraint project_authorizations_attestation_version_present check (length(trim(attestation_version)) > 0),
  constraint project_authorizations_action_domains_safe check (
    public.approved_action_domains_are_safe(approved_action_domains)
    and approved_action_domains ? hostname::text
  ),
  constraint project_authorizations_id_agency_unique unique (id, agency_id)
);

alter table public.project_authorizations
  drop constraint if exists project_authorizations_agency_host_unique;
create unique index if not exists project_authorizations_active_host_uidx
  on public.project_authorizations(agency_id, client_id, hostname)
  where revoked_at is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_authorizations_client_agency_fkey') then
    alter table public.project_authorizations add constraint project_authorizations_client_agency_fkey
      foreign key (client_id, agency_id) references public.clients(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_authorizations_attestor_membership_fkey') then
    alter table public.project_authorizations add constraint project_authorizations_attestor_membership_fkey
      foreign key (agency_id, attested_by_user_id) references public.memberships(agency_id, user_id) on delete restrict;
  end if;
end $$;

create or replace function public.enforce_project_owner_attestation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.memberships m
    where m.agency_id = new.agency_id and m.user_id = new.attested_by_user_id
      and m.role = 'owner'::public.agency_role
  ) then
    raise exception 'Project authorization requires an owner attestation.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists project_authorizations_require_owner on public.project_authorizations;
create trigger project_authorizations_require_owner
before insert on public.project_authorizations
for each row execute function public.enforce_project_owner_attestation();

create or replace function public.enforce_project_authorization_immutability()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.revoked_at is not null
    or new.revoked_at is null
    or new.id is distinct from old.id
    or new.agency_id is distinct from old.agency_id
    or new.client_id is distinct from old.client_id
    or new.hostname is distinct from old.hostname
    or new.attestation_version is distinct from old.attestation_version
    or new.attested_by_user_id is distinct from old.attested_by_user_id
    or new.attested_at is distinct from old.attested_at
    or new.approved_action_domains is distinct from old.approved_action_domains
    or new.created_at is distinct from old.created_at then
    raise exception 'Project authorizations are append-only and may only be revoked once.' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists project_authorizations_immutable on public.project_authorizations;
create trigger project_authorizations_immutable
before update on public.project_authorizations
for each row execute function public.enforce_project_authorization_immutability();

create or replace function public.record_project_authorization(
  p_agency_id uuid,
  p_client_id uuid,
  p_attested_by_user_id uuid,
  p_hostname text,
  p_attestation_version text,
  p_approved_action_domains jsonb
)
returns setof public.project_authorizations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_project public.clients%rowtype;
  created_id uuid;
begin
  select * into saved_project from public.clients c
  where c.id = p_client_id and c.agency_id = p_agency_id and c.archived_at is null
  for update;
  if not found then raise exception 'Project was not found.' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.memberships m
    where m.agency_id = p_agency_id and m.user_id = p_attested_by_user_id
      and m.role = 'owner'::public.agency_role
  ) then
    raise exception 'Project authorization requires a workspace owner.' using errcode = '42501';
  end if;

  update public.project_authorizations a
  set revoked_at = now(), updated_at = now()
  where a.agency_id = p_agency_id and a.client_id = p_client_id
    and a.hostname = lower(trim(p_hostname))::citext and a.revoked_at is null;

  insert into public.project_authorizations (
    agency_id, client_id, hostname, attestation_version, attested_by_user_id,
    attested_at, approved_action_domains
  ) values (
    p_agency_id, p_client_id, lower(trim(p_hostname))::citext,
    trim(p_attestation_version), p_attested_by_user_id, now(), p_approved_action_domains
  ) returning id into created_id;

  -- Published versions reference the exact attestation they were approved
  -- against. Re-attesting creates a new immutable record, so existing schedule
  -- proof is no longer current until each journey is republished and supervised.
  update public.journey_schedules schedule set
    enabled = false,
    paused_at = now(),
    pause_reason = 'project_authorization_changed',
    lease_expires_at = null,
    leased_by = null,
    updated_at = now()
  from public.workflows journey
  where journey.id = schedule.workflow_id
    and journey.agency_id = schedule.agency_id
    and journey.agency_id = p_agency_id
    and journey.client_id = p_client_id
    and journey.journey_template in ('lead_form', 'trial_signup');

  return query select * from public.project_authorizations a where a.id = created_id;
end;
$$;

create table if not exists public.journey_versions (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  authorization_id uuid references public.project_authorizations(id) on delete restrict,
  version_number integer not null,
  template text not null,
  start_url text not null,
  definition_json jsonb not null default '{}'::jsonb,
  definition_hash text not null,
  source text not null default 'published',
  created_by_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint journey_versions_number_positive check (version_number > 0),
  constraint journey_versions_template_valid check (template in ('lead_form', 'trial_signup', 'legacy_endpoint')),
  constraint journey_versions_start_url_https check (start_url = '' or start_url ~* '^https://'),
  constraint journey_versions_definition_object check (jsonb_typeof(definition_json) = 'object'),
  constraint journey_versions_hash_present check (length(trim(definition_hash)) >= 32),
  constraint journey_versions_source_valid check (source in ('published', 'legacy_backfill')),
  constraint journey_versions_workflow_version_unique unique (workflow_id, version_number),
  constraint journey_versions_id_agency_unique unique (id, agency_id)
);

create table if not exists public.journey_stage_definitions (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  journey_version_id uuid not null references public.journey_versions(id) on delete cascade,
  position integer not null,
  stage_key text not null,
  name text not null,
  action_manifest_json jsonb not null,
  expected_text text not null default '',
  business_impact text not null default '',
  timing_threshold_ms integer,
  is_cleanup boolean not null default false,
  created_at timestamptz not null default now(),
  constraint journey_stage_position_nonnegative check (position >= 0),
  constraint journey_stage_key_valid check (stage_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint journey_stage_manifest_object check (jsonb_typeof(action_manifest_json) = 'object'),
  constraint journey_stage_timing_positive check (timing_threshold_ms is null or timing_threshold_ms > 0),
  constraint journey_stage_version_position_unique unique (journey_version_id, position),
  constraint journey_stage_version_key_unique unique (journey_version_id, stage_key),
  constraint journey_stage_id_agency_unique unique (id, agency_id)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workflows_active_journey_version_fkey') then
    alter table public.workflows add constraint workflows_active_journey_version_fkey
      foreign key (active_journey_version_id, agency_id)
      references public.journey_versions(id, agency_id) on delete restrict;
  end if;
end $$;

create table if not exists public.journey_schedules (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  journey_version_id uuid not null references public.journey_versions(id) on delete restrict,
  interval_minutes integer not null default 1440,
  enabled boolean not null default false,
  next_run_at timestamptz not null default (now() + interval '1 day'),
  last_run_at timestamptz,
  supervised_run_id uuid,
  cleanup_verified boolean not null default false,
  paused_at timestamptz,
  pause_reason text not null default '',
  lease_expires_at timestamptz,
  leased_by text,
  last_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint journey_schedules_interval_floor check (interval_minutes >= 60),
  constraint journey_schedules_pause_state_valid check (
    (paused_at is null and pause_reason = '') or (paused_at is not null and length(trim(pause_reason)) > 0)
  ),
  constraint journey_schedules_workflow_unique unique (workflow_id),
  constraint journey_schedules_id_agency_unique unique (id, agency_id)
);

create table if not exists public.eval_runs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  journey_version_id uuid not null references public.journey_versions(id) on delete restrict,
  schedule_id uuid references public.journey_schedules(id) on delete set null,
  verification_issue_id uuid references public.issues(id) on delete restrict,
  trigger_source text not null,
  status text not null default 'queued',
  verdict text not null default 'not_run',
  idempotency_key text not null,
  scheduled_for timestamptz,
  requested_by_user_id uuid references public.profiles(id) on delete set null,
  runner_provider text not null default '',
  orchestration_run_id text not null default '',
  dispatch_state text not null default 'pending',
  dispatch_lease_expires_at timestamptz,
  dispatch_worker_id text not null default '',
  dispatch_attempts integer not null default 0,
  runner_session_json jsonb not null default '{}'::jsonb,
  recipient_hash text not null default '',
  worker_id text not null default '',
  lease_expires_at timestamptz,
  claimed_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_requested_by_user_id uuid references public.profiles(id) on delete set null,
  cancel_idempotency_key_hash text,
  cancel_request_hash text,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer,
  quota_period_start date not null default date_trunc('month', now())::date,
  quota_counted boolean not null default true,
  synthetic_marker text not null,
  summary text not null default '',
  business_impact text not null default '',
  failure_fingerprint text not null default '',
  cleanup_status text not null default 'pending',
  cleanup_error_summary text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint eval_runs_trigger_valid check (trigger_source in ('manual', 'supervised', 'verification', 'debug', 'scheduled', 'api', 'legacy_backfill')),
  constraint eval_runs_status_valid check (status in ('queued', 'claimed', 'running', 'finalized', 'cancelled')),
  constraint eval_runs_dispatch_state_valid check (dispatch_state in ('pending', 'dispatching', 'dispatched')),
  constraint eval_runs_dispatch_attempts_nonnegative check (dispatch_attempts >= 0),
  constraint eval_runs_verdict_valid check (verdict in ('passed', 'degraded', 'failed', 'inconclusive', 'cancelled', 'not_run')),
  constraint eval_runs_cleanup_valid check (cleanup_status in ('pending', 'passed', 'failed', 'not_required', 'skipped')),
  constraint eval_runs_duration_nonnegative check (duration_ms is null or duration_ms >= 0),
  constraint eval_runs_idempotency_present check (length(trim(idempotency_key)) > 0),
  constraint eval_runs_synthetic_marker_present check (synthetic_marker ~ '^MF-EVAL-[A-F0-9]{20}$'),
  constraint eval_runs_runner_session_object check (jsonb_typeof(runner_session_json) = 'object'),
  constraint eval_runs_cancel_hashes_valid check (
    (cancel_idempotency_key_hash is null and cancel_request_hash is null)
    or (
      cancel_idempotency_key_hash ~ '^[a-f0-9]{64}$'
      and cancel_request_hash ~ '^[a-f0-9]{64}$'
      and cancel_requested_at is not null
      and cancel_requested_by_user_id is not null
    )
  ),
  constraint eval_runs_agency_idempotency_unique unique (agency_id, idempotency_key),
  constraint eval_runs_id_agency_unique unique (id, agency_id)
);

-- Scheduled runs are system-attributed, while user-triggered runs retain a
-- profile-bound audit actor for as long as that profile exists.
alter table public.eval_runs alter column requested_by_user_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'eval_runs_requested_by_user_fkey'
      and conrelid = 'public.eval_runs'::regclass
  ) then
    alter table public.eval_runs add constraint eval_runs_requested_by_user_fkey
      foreign key (requested_by_user_id) references public.profiles(id) on delete set null not valid;
  end if;
end $$;

alter table public.eval_runs validate constraint eval_runs_requested_by_user_fkey;

create index if not exists eval_runs_requested_by_user_idx
  on public.eval_runs(requested_by_user_id)
  where requested_by_user_id is not null;

alter table public.eval_runs
  add column if not exists dispatch_state text not null default 'pending',
  add column if not exists dispatch_lease_expires_at timestamptz,
  add column if not exists dispatch_worker_id text not null default '',
  add column if not exists dispatch_attempts integer not null default 0,
  add column if not exists cancel_idempotency_key_hash text,
  add column if not exists cancel_request_hash text;

alter table public.eval_runs drop constraint if exists eval_runs_cancel_hashes_valid;
alter table public.eval_runs add constraint eval_runs_cancel_hashes_valid check (
  (cancel_idempotency_key_hash is null and cancel_request_hash is null)
  or (
    cancel_idempotency_key_hash ~ '^[a-f0-9]{64}$'
    and cancel_request_hash ~ '^[a-f0-9]{64}$'
    and cancel_requested_at is not null
    and cancel_requested_by_user_id is not null
  )
);

create unique index if not exists eval_runs_cancel_idempotency_uidx
  on public.eval_runs(agency_id, cancel_idempotency_key_hash)
  where cancel_idempotency_key_hash is not null;

alter table public.eval_runs drop constraint if exists eval_runs_trigger_valid;
alter table public.eval_runs add constraint eval_runs_trigger_valid
  check (trigger_source in ('manual', 'supervised', 'verification', 'debug', 'scheduled', 'api', 'legacy_backfill'));

update public.eval_runs
set dispatch_state = 'dispatched', dispatch_lease_expires_at = null, dispatch_worker_id = ''
where orchestration_run_id <> '' and dispatch_state <> 'dispatched';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'eval_runs_dispatch_state_valid') then
    alter table public.eval_runs add constraint eval_runs_dispatch_state_valid
      check (dispatch_state in ('pending', 'dispatching', 'dispatched'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_runs_dispatch_attempts_nonnegative') then
    alter table public.eval_runs add constraint eval_runs_dispatch_attempts_nonnegative
      check (dispatch_attempts >= 0);
  end if;
end $$;

create unique index if not exists eval_runs_schedule_slot_uidx
  on public.eval_runs(schedule_id, scheduled_for)
  where schedule_id is not null and scheduled_for is not null;

create table if not exists public.browser_context_leases (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  eval_run_id uuid not null,
  context_id text not null,
  context_id_hash text not null,
  last_session_id text not null default '',
  resume_url text not null default '',
  sync_ready_at timestamptz,
  delete_after timestamptz not null,
  session_owner_token uuid,
  session_lease_expires_at timestamptz,
  cleanup_status text not null default 'active',
  cleanup_requested_at timestamptz,
  cleanup_reason_code text not null default '',
  cleanup_attempts integer not null default 0,
  cleanup_worker_id text not null default '',
  cleanup_lease_expires_at timestamptz,
  next_cleanup_at timestamptz,
  last_cleanup_error_code text not null default '',
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint browser_context_leases_eval_run_fkey foreign key (eval_run_id, agency_id)
    references public.eval_runs(id, agency_id) on delete cascade,
  constraint browser_context_leases_eval_run_unique unique (eval_run_id),
  constraint browser_context_leases_context_unique unique (context_id),
  constraint browser_context_leases_context_id_valid check (
    length(trim(context_id)) between 8 and 255
    and context_id !~ '[[:space:][:cntrl:]]'
    and context_id_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint browser_context_leases_session_id_valid check (
    last_session_id = '' or (
      length(last_session_id) between 8 and 255
      and last_session_id !~ '[[:space:][:cntrl:]]'
    )
  ),
  constraint browser_context_leases_resume_url_safe check (
    resume_url = '' or (
      length(resume_url) <= 2048
      and resume_url = trim(resume_url)
      and resume_url ~ '^https://'
      and resume_url !~ '[?#[:space:][:cntrl:]]'
      and resume_url !~ '^https://[^/]*@'
    )
  ),
  constraint browser_context_leases_delete_after_create check (delete_after > created_at),
  constraint browser_context_leases_session_claim_valid check (
    (session_owner_token is null and session_lease_expires_at is null)
    or (session_owner_token is not null and session_lease_expires_at is not null)
  ),
  constraint browser_context_leases_cleanup_status_valid check (
    cleanup_status in ('active', 'pending', 'claimed', 'deleted', 'failed')
  ),
  constraint browser_context_leases_cleanup_attempts_valid check (
    cleanup_attempts >= 0
  ),
  constraint browser_context_leases_cleanup_state_valid check (
    (
      cleanup_status = 'active'
      and cleanup_requested_at is null
      and cleanup_reason_code = ''
      and cleanup_worker_id = ''
      and cleanup_lease_expires_at is null
      and next_cleanup_at = delete_after
      and released_at is null
    ) or (
      cleanup_status = 'pending'
      and cleanup_requested_at is not null
      and cleanup_reason_code ~ '^[A-Z0-9_]{3,64}$'
      and cleanup_worker_id = ''
      and cleanup_lease_expires_at is null
      and next_cleanup_at is not null
      and released_at is null
    ) or (
      cleanup_status = 'claimed'
      and cleanup_requested_at is not null
      and cleanup_reason_code ~ '^[A-Z0-9_]{3,64}$'
      and cleanup_worker_id ~ '^[A-Za-z0-9:_-]{8,128}$'
      and cleanup_lease_expires_at is not null
      and next_cleanup_at = cleanup_lease_expires_at
      and released_at is null
      and session_owner_token is null
      and session_lease_expires_at is null
    ) or (
      cleanup_status = 'deleted'
      and cleanup_worker_id = ''
      and cleanup_lease_expires_at is null
      and next_cleanup_at is null
      and released_at is not null
      and session_owner_token is null
      and session_lease_expires_at is null
    ) or (
      cleanup_status = 'failed'
      and cleanup_attempts > 0
      and cleanup_worker_id = ''
      and cleanup_lease_expires_at is null
      and next_cleanup_at is not null
      and last_cleanup_error_code ~ '^[A-Z0-9_]{3,64}$'
      and released_at is null
      and session_owner_token is null
      and session_lease_expires_at is null
    )
  ),
  constraint browser_context_leases_id_agency_unique unique (id, agency_id)
);

create index if not exists browser_context_leases_agency_created_idx
  on public.browser_context_leases(agency_id, created_at desc);
create index if not exists browser_context_leases_cleanup_due_idx
  on public.browser_context_leases(next_cleanup_at, id)
  where cleanup_status in ('active', 'pending', 'claimed', 'failed');

drop trigger if exists browser_context_leases_set_updated_at on public.browser_context_leases;
create trigger browser_context_leases_set_updated_at
before update on public.browser_context_leases
for each row execute function public.set_updated_at();

create table if not exists public.eval_run_side_effect_attempts (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  eval_run_id uuid not null references public.eval_runs(id) on delete cascade,
  phase_key text not null,
  state text not null default 'started',
  worker_id text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint eval_run_side_effect_attempts_phase_key_present check (length(trim(phase_key)) between 12 and 128),
  constraint eval_run_side_effect_attempts_worker_present check (length(trim(worker_id)) > 0),
  constraint eval_run_side_effect_attempts_state_valid check (state in ('started', 'completed')),
  constraint eval_run_side_effect_attempts_completion_valid check (
    (state = 'started' and completed_at is null) or (state = 'completed' and completed_at is not null)
  ),
  constraint eval_run_side_effect_attempts_run_phase_unique unique (eval_run_id, phase_key),
  constraint eval_run_side_effect_attempts_id_agency_unique unique (id, agency_id)
);

create table if not exists public.eval_rate_limit_buckets (
  scope_type text not null,
  scope_key_hash text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint eval_rate_limit_buckets_scope_valid check (scope_type in ('user', 'workspace', 'project', 'destination_domain', 'ai_user', 'ai_workspace', 'ai_project')),
  constraint eval_rate_limit_buckets_hash_valid check (scope_key_hash ~ '^[a-f0-9]{64}$'),
  constraint eval_rate_limit_buckets_count_positive check (request_count > 0),
  constraint eval_rate_limit_buckets_primary_key primary key (scope_type, scope_key_hash, window_started_at)
);

create index if not exists eval_rate_limit_buckets_expiry_idx
  on public.eval_rate_limit_buckets(updated_at);

alter table public.eval_rate_limit_buckets drop constraint if exists eval_rate_limit_buckets_scope_valid;
alter table public.eval_rate_limit_buckets add constraint eval_rate_limit_buckets_scope_valid
  check (scope_type in ('user', 'workspace', 'project', 'destination_domain', 'ai_user', 'ai_workspace', 'ai_project'));

create table if not exists public.ai_assistance_requests (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  project_id uuid not null,
  workflow_id uuid,
  eval_run_id uuid,
  legacy_check_run_id uuid,
  actor_user_id uuid not null,
  request_kind text not null,
  status text not null default 'processing',
  idempotency_key_hash text not null,
  request_hash text not null,
  model text not null,
  reasoning_effort text not null,
  provider_response_id text not null default '',
  output_json jsonb not null default '{}'::jsonb,
  usage_json jsonb not null default '{}'::jsonb,
  error_code text not null default '',
  attempt_count integer not null default 1,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_assistance_requests_project_fkey foreign key (project_id, agency_id)
    references public.clients(id, agency_id) on delete cascade,
  constraint ai_assistance_requests_workflow_fkey foreign key (workflow_id, agency_id)
    references public.workflows(id, agency_id) on delete cascade,
  constraint ai_assistance_requests_eval_run_fkey foreign key (eval_run_id, agency_id)
    references public.eval_runs(id, agency_id) on delete cascade,
  constraint ai_assistance_requests_legacy_run_fkey foreign key (legacy_check_run_id, agency_id)
    references public.check_runs(id, agency_id) on delete cascade,
  constraint ai_assistance_requests_actor_profile_fkey foreign key (actor_user_id)
    references public.profiles(id) on delete restrict,
  constraint ai_assistance_requests_kind_valid check (request_kind in ('journey_draft', 'run_diagnosis')),
  constraint ai_assistance_requests_status_valid check (status in ('processing', 'completed', 'refused', 'failed')),
  constraint ai_assistance_requests_hashes_valid check (
    idempotency_key_hash ~ '^[a-f0-9]{64}$' and request_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint ai_assistance_requests_reasoning_valid check (reasoning_effort in ('low', 'medium')),
  constraint ai_assistance_requests_attempt_positive check (attempt_count > 0),
  constraint ai_assistance_requests_json_objects check (
    jsonb_typeof(output_json) = 'object' and jsonb_typeof(usage_json) = 'object'
  ),
  constraint ai_assistance_requests_source_binding check (
    (request_kind = 'journey_draft' and eval_run_id is null and legacy_check_run_id is null)
    or (
      request_kind = 'run_diagnosis' and workflow_id is not null
      and ((eval_run_id is not null) <> (legacy_check_run_id is not null))
    )
  ),
  constraint ai_assistance_requests_completion_state check (
    (status = 'processing' and completed_at is null)
    or (status <> 'processing' and completed_at is not null)
  ),
  constraint ai_assistance_requests_agency_idempotency_unique unique (agency_id, idempotency_key_hash),
  constraint ai_assistance_requests_id_agency_unique unique (id, agency_id)
);

-- Membership is authorization state, not the durable identity of the actor.
-- Historical AI requests must survive a later workspace-member removal.
alter table public.ai_assistance_requests
  drop constraint if exists ai_assistance_requests_actor_membership_fkey;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_assistance_requests_actor_profile_fkey'
      and conrelid = 'public.ai_assistance_requests'::regclass
  ) then
    alter table public.ai_assistance_requests add constraint ai_assistance_requests_actor_profile_fkey
      foreign key (actor_user_id) references public.profiles(id) on delete restrict not valid;
  end if;
end $$;

alter table public.ai_assistance_requests validate constraint ai_assistance_requests_actor_profile_fkey;

create index if not exists ai_assistance_requests_agency_created_idx
  on public.ai_assistance_requests(agency_id, created_at desc);
create index if not exists ai_assistance_requests_processing_idx
  on public.ai_assistance_requests(updated_at) where status = 'processing';
create index if not exists ai_assistance_requests_actor_user_idx
  on public.ai_assistance_requests(actor_user_id);

create table if not exists public.eval_stage_runs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  eval_run_id uuid not null references public.eval_runs(id) on delete cascade,
  stage_definition_id uuid not null references public.journey_stage_definitions(id) on delete restrict,
  position integer not null,
  status text not null default 'completed',
  verdict text not null,
  expected_text text not null default '',
  observed_text text not null default '',
  error_code text not null default '',
  diagnostics_json jsonb not null default '{}'::jsonb,
  assertion_results_json jsonb not null default '[]'::jsonb,
  evidence_artifact_ids uuid[] not null default '{}'::uuid[],
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer,
  created_at timestamptz not null default now(),
  constraint eval_stage_runs_position_nonnegative check (position >= 0),
  constraint eval_stage_runs_status_valid check (status in ('completed', 'cancelled', 'not_run')),
  constraint eval_stage_runs_verdict_valid check (verdict in ('passed', 'degraded', 'failed', 'inconclusive', 'cancelled', 'not_run')),
  constraint eval_stage_runs_diagnostics_object check (jsonb_typeof(diagnostics_json) = 'object'),
  constraint eval_stage_runs_assertions_array check (jsonb_typeof(assertion_results_json) = 'array'),
  constraint eval_stage_runs_duration_nonnegative check (duration_ms is null or duration_ms >= 0),
  constraint eval_stage_runs_run_stage_unique unique (eval_run_id, stage_definition_id),
  constraint eval_stage_runs_run_position_unique unique (eval_run_id, position),
  constraint eval_stage_runs_id_agency_unique unique (id, agency_id)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'journey_schedules_supervised_run_agency_fkey') then
    alter table public.journey_schedules add constraint journey_schedules_supervised_run_agency_fkey
      foreign key (supervised_run_id, agency_id) references public.eval_runs(id, agency_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_runs_verification_issue_agency_fkey') then
    alter table public.eval_runs add constraint eval_runs_verification_issue_agency_fkey
      foreign key (verification_issue_id, agency_id) references public.issues(id, agency_id) on delete restrict;
  end if;
end $$;

create table if not exists public.evidence_artifacts (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  eval_run_id uuid not null references public.eval_runs(id) on delete cascade,
  eval_stage_run_id uuid references public.eval_stage_runs(id) on delete cascade,
  artifact_kind text not null,
  storage_bucket text not null default 'maintainflow-eval-evidence',
  storage_path text not null,
  mime_type text not null,
  byte_size bigint not null,
  sha256 text not null,
  redacted boolean not null default true,
  report_safe boolean not null default false,
  synthetic_marker text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint evidence_artifacts_kind_valid check (artifact_kind in ('screenshot', 'trace', 'network_log', 'dom_snapshot', 'email_event', 'runner_log', 'report_json')),
  constraint evidence_artifacts_size_valid check (byte_size >= 0 and byte_size <= 52428800),
  constraint evidence_artifacts_sha256_valid check (sha256 ~ '^[a-f0-9]{64}$'),
  constraint evidence_artifacts_report_safe_redaction check (
    artifact_kind not in ('screenshot', 'report_json', 'email_event') or redacted
  ),
  constraint evidence_artifacts_report_safe_contract check (
    not report_safe or (artifact_kind = 'screenshot' and redacted)
  ),
  constraint evidence_artifacts_path_private check (storage_path !~ '^/' and storage_path !~ '\.\.'),
  constraint evidence_artifacts_path_scope check (
    storage_path like agency_id::text || '/%/runs/' || eval_run_id::text || '/%'
  ),
  constraint evidence_artifacts_marker_valid check (synthetic_marker ~ '^MF-EVAL-[A-F0-9]{20}$'),
  constraint evidence_artifacts_expiry_after_create check (expires_at > created_at),
  constraint evidence_artifacts_id_agency_unique unique (id, agency_id),
  constraint evidence_artifacts_storage_unique unique (storage_bucket, storage_path)
);

alter table public.evidence_artifacts
  add column if not exists report_safe boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'evidence_artifacts_report_safe_contract') then
    alter table public.evidence_artifacts add constraint evidence_artifacts_report_safe_contract
      check (not report_safe or (artifact_kind = 'screenshot' and redacted));
  end if;
end $$;

-- BEGIN canonical synthetic marker reconciliation
-- Earlier builds stored lowercase, UUID-shaped markers. Drop the old checks
-- before normalizing those rows, then make every artifact inherit the exact
-- marker owned by its eval run. The fallback from the run UUID handles any
-- legacy value that satisfied the former broad alphanumeric constraint but
-- does not contain twenty hexadecimal characters.
alter table public.evidence_artifacts
  drop constraint if exists evidence_artifacts_marker_valid;
alter table public.eval_runs
  drop constraint if exists eval_runs_synthetic_marker_present;

with legacy_markers as (
  select
    id,
    regexp_replace(
      regexp_replace(lower(synthetic_marker), '^mf-eval-', ''),
      '[^a-f0-9]',
      '',
      'g'
    ) as hexadecimal_payload
  from public.eval_runs
  where synthetic_marker !~ '^MF-EVAL-[A-F0-9]{20}$'
)
update public.eval_runs run
set synthetic_marker = 'MF-EVAL-' || upper(
  case
    when length(legacy.hexadecimal_payload) >= 20 then left(legacy.hexadecimal_payload, 20)
    else left(replace(run.id::text, '-', ''), 20)
  end
)
from legacy_markers legacy
where run.id = legacy.id;

update public.evidence_artifacts artifact
set synthetic_marker = run.synthetic_marker
from public.eval_runs run
where run.id = artifact.eval_run_id
  and artifact.synthetic_marker is distinct from run.synthetic_marker;

alter table public.eval_runs
  add constraint eval_runs_synthetic_marker_present
  check (synthetic_marker ~ '^MF-EVAL-[A-F0-9]{20}$');
alter table public.evidence_artifacts
  add constraint evidence_artifacts_marker_valid
  check (synthetic_marker ~ '^MF-EVAL-[A-F0-9]{20}$');
-- END canonical synthetic marker reconciliation

create table if not exists public.inbound_email_events (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  eval_run_id uuid not null references public.eval_runs(id) on delete cascade,
  stage_definition_id uuid references public.journey_stage_definitions(id) on delete set null,
  provider text not null,
  provider_event_id text not null,
  recipient_hash text not null,
  sender_domain text not null default '',
  subject_safe text not null default '',
  match_key_hash text not null,
  payload_summary_json jsonb not null default '{}'::jsonb,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint inbound_email_payload_object check (jsonb_typeof(payload_summary_json) = 'object'),
  constraint inbound_email_payload_no_plaintext_link check (not payload_summary_json ? 'verificationLink'),
  constraint inbound_email_recipient_hash_present check (length(recipient_hash) >= 32),
  constraint inbound_email_match_hash_present check (length(match_key_hash) >= 32),
  constraint inbound_email_provider_event_unique unique (provider, provider_event_id)
);

-- A health observation is written only after a signed Resend email.received
-- webhook for the configured inbound domain has successfully retrieved its
-- message content. It contains no address or message data and is service-only.
create table if not exists public.eval_email_receiving_health_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  inbound_domain text not null,
  provider_event_id_hash text not null,
  observed_at timestamptz not null default clock_timestamp(),
  constraint eval_email_receiving_health_provider_valid check (provider = 'resend'),
  constraint eval_email_receiving_health_domain_valid check (
    inbound_domain = lower(trim(inbound_domain))
    and length(inbound_domain) between 4 and 253
    and inbound_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
  ),
  constraint eval_email_receiving_health_event_hash_valid check (provider_event_id_hash ~ '^[a-f0-9]{64}$'),
  constraint eval_email_receiving_health_provider_event_unique unique (provider, provider_event_id_hash)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inbound_email_payload_no_plaintext_link') then
    alter table public.inbound_email_events add constraint inbound_email_payload_no_plaintext_link
      check (not payload_summary_json ? 'verificationLink');
  end if;
end $$;

-- Signed provider webhooks are claimed before any billing mutation. Only the
-- payload fingerprint is retained; raw webhook bodies and secrets are not.
create table if not exists public.provider_webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text not null,
  payload_hash text not null,
  status text not null default 'processing',
  claim_token uuid not null default gen_random_uuid(),
  attempt_count integer not null default 1,
  last_error_safe text not null default '',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint provider_webhook_receipts_provider_valid check (provider in ('stripe')),
  constraint provider_webhook_receipts_event_id_present check (length(trim(event_id)) between 1 and 255),
  constraint provider_webhook_receipts_event_type_present check (length(trim(event_type)) between 1 and 255),
  constraint provider_webhook_receipts_payload_hash_valid check (payload_hash ~ '^[a-f0-9]{64}$'),
  constraint provider_webhook_receipts_status_valid check (status in ('processing', 'processed', 'failed')),
  constraint provider_webhook_receipts_attempt_valid check (attempt_count >= 1),
  constraint provider_webhook_receipts_error_safe check (length(last_error_safe) <= 300),
  constraint provider_webhook_receipts_processed_at_valid check (
    (status = 'processed' and processed_at is not null)
    or (status <> 'processed' and processed_at is null)
  ),
  constraint provider_webhook_receipts_provider_event_unique unique (provider, event_id)
);

create table if not exists public.alert_endpoints (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  display_name text not null default 'Alert destination',
  endpoint_type text not null,
  target_ciphertext text not null,
  target_preview text not null,
  signing_secret_ciphertext text not null default '',
  enabled boolean not null default true,
  created_by_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint alert_endpoints_type_valid check (endpoint_type in ('email', 'webhook')),
  constraint alert_endpoints_display_name_present check (length(trim(display_name)) between 1 and 120),
  constraint alert_endpoints_target_present check (length(trim(target_ciphertext)) > 0 and length(trim(target_preview)) > 0),
  constraint alert_endpoints_id_agency_unique unique (id, agency_id)
);

alter table public.alert_endpoints
  add column if not exists display_name text not null default 'Alert destination';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'alert_endpoints_display_name_present') then
    alter table public.alert_endpoints add constraint alert_endpoints_display_name_present
      check (length(trim(display_name)) between 1 and 120);
  end if;
end $$;

create table if not exists public.alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  alert_endpoint_id uuid not null references public.alert_endpoints(id) on delete cascade,
  eval_run_id uuid references public.eval_runs(id) on delete cascade,
  issue_id uuid references public.issues(id) on delete cascade,
  event_type text not null,
  idempotency_key text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  last_error_safe text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint alert_deliveries_event_type_valid check (event_type in ('eval_run.completed', 'incident.opened', 'incident.recovered', 'report.ready')),
  constraint alert_deliveries_status_valid check (status in ('pending', 'sending', 'delivered', 'failed', 'suppressed')),
  constraint alert_deliveries_attempts_nonnegative check (attempt_count >= 0),
  constraint alert_deliveries_source_present check ((eval_run_id is not null) <> (issue_id is not null)),
  constraint alert_deliveries_agency_idempotency_unique unique (agency_id, idempotency_key)
);

alter table public.alert_deliveries drop constraint if exists alert_deliveries_source_present;
alter table public.alert_deliveries add constraint alert_deliveries_source_present
  check ((eval_run_id is not null) <> (issue_id is not null));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'alert_deliveries_event_type_valid') then
    alter table public.alert_deliveries add constraint alert_deliveries_event_type_valid
      check (event_type in ('eval_run.completed', 'incident.opened', 'incident.recovered', 'report.ready'));
  end if;
end $$;

create table if not exists public.eval_alert_outbox (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  eval_run_id uuid not null references public.eval_runs(id) on delete cascade,
  issue_id uuid references public.issues(id) on delete set null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz default now(),
  processed_at timestamptz,
  last_error_safe text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint eval_alert_outbox_status_valid check (status in ('pending', 'processing', 'failed', 'processed')),
  constraint eval_alert_outbox_attempts_nonnegative check (attempt_count >= 0),
  constraint eval_alert_outbox_processed_state_valid check (
    (status = 'processed' and processed_at is not null) or (status <> 'processed' and processed_at is null)
  ),
  constraint eval_alert_outbox_run_unique unique (eval_run_id),
  constraint eval_alert_outbox_id_agency_unique unique (id, agency_id)
);

create index if not exists eval_alert_outbox_pending_idx
  on public.eval_alert_outbox(next_attempt_at, updated_at)
  where status in ('pending', 'failed', 'processing');

create table if not exists public.report_share_links (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  report_id uuid not null references public.reports(id) on delete cascade,
  token_hash text not null unique,
  idempotency_key text not null,
  snapshot_version integer not null,
  evidence_fingerprint text not null,
  snapshot_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_user_id uuid references public.profiles(id) on delete set null,
  revocation_idempotency_key_hash text,
  revocation_request_hash text,
  access_count integer not null default 0,
  last_accessed_at timestamptz,
  created_by_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint report_share_links_hash_present check (length(token_hash) >= 32),
  constraint report_share_links_idempotency_present check (length(trim(idempotency_key)) > 0),
  constraint report_share_links_snapshot_positive check (snapshot_version > 0),
  constraint report_share_links_evidence_fingerprint_present check (length(trim(evidence_fingerprint)) >= 32),
  constraint report_share_links_snapshot_hash_valid check (snapshot_hash ~ '^[a-f0-9]{64}$'),
  constraint report_share_links_expiry_valid check (expires_at > created_at),
  constraint report_share_links_access_nonnegative check (access_count >= 0),
  constraint report_share_links_revocation_hashes_valid check (
    (revocation_idempotency_key_hash is null and revocation_request_hash is null)
    or (
      revocation_idempotency_key_hash ~ '^[a-f0-9]{64}$'
      and revocation_request_hash ~ '^[a-f0-9]{64}$'
      and revoked_at is not null
      and revoked_by_user_id is not null
    )
  ),
  constraint report_share_links_agency_idempotency_unique unique (agency_id, idempotency_key)
);

alter table public.report_share_links
  add column if not exists snapshot_hash text,
  add column if not exists revoked_by_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists revocation_idempotency_key_hash text,
  add column if not exists revocation_request_hash text;

alter table public.report_share_links drop constraint if exists report_share_links_revocation_hashes_valid;
alter table public.report_share_links add constraint report_share_links_revocation_hashes_valid check (
  (revocation_idempotency_key_hash is null and revocation_request_hash is null)
  or (
    revocation_idempotency_key_hash ~ '^[a-f0-9]{64}$'
    and revocation_request_hash ~ '^[a-f0-9]{64}$'
    and revoked_at is not null
    and revoked_by_user_id is not null
  )
);

create unique index if not exists report_share_links_revocation_idempotency_uidx
  on public.report_share_links(agency_id, revocation_idempotency_key_hash)
  where revocation_idempotency_key_hash is not null;

-- Share links created before exact snapshot hashing are revoked rather than
-- silently promoted to the stronger contract.
update public.report_share_links
set snapshot_hash = repeat('0', 64),
    revoked_at = coalesce(revoked_at, now())
where snapshot_hash is null or snapshot_hash !~ '^[a-f0-9]{64}$';

alter table public.report_share_links alter column snapshot_hash set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'report_share_links_snapshot_hash_valid') then
    alter table public.report_share_links add constraint report_share_links_snapshot_hash_valid
      check (snapshot_hash ~ '^[a-f0-9]{64}$');
  end if;
end $$;

alter table public.issues
  add column if not exists eval_run_id uuid,
  add column if not exists eval_stage_run_id uuid,
  add column if not exists verification_eval_run_id uuid;

alter table public.reports
  add column if not exists eval_coverage_snapshot_json jsonb not null default '{}'::jsonb,
  add column if not exists eval_evidence_fingerprint text not null default '',
  add column if not exists eval_snapshot_idempotency_key text;

-- Fail closed for any pre-constraint row that claimed Business Evals provenance
-- without the service-issued fingerprint contract. Existing public links are
-- revoked before the row is demoted to a stale legacy report.
update public.report_share_links link
set revoked_at = coalesce(link.revoked_at, now())
where link.report_id in (
  select report.id from public.reports report
  where report.eval_snapshot_idempotency_key is not null
    and not (
      report.eval_evidence_fingerprint ~ '^[a-f0-9]{64}$'
      and report.evidence_fingerprint = report.eval_evidence_fingerprint
      and report.snapshot_version > 0
      and report.snapshot_json->>'evidenceFingerprint' = report.eval_evidence_fingerprint
    )
);

update public.reports report
set eval_snapshot_idempotency_key = null,
    eval_evidence_fingerprint = '',
    eval_coverage_snapshot_json = '{}'::jsonb,
    stale_at = coalesce(report.stale_at, now())
where report.eval_snapshot_idempotency_key is not null
  and not (
    report.eval_evidence_fingerprint ~ '^[a-f0-9]{64}$'
    and report.evidence_fingerprint = report.eval_evidence_fingerprint
    and report.snapshot_version > 0
    and report.snapshot_json->>'evidenceFingerprint' = report.eval_evidence_fingerprint
  );

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'issues_eval_run_agency_fkey') then
    alter table public.issues add constraint issues_eval_run_agency_fkey
      foreign key (eval_run_id, agency_id) references public.eval_runs(id, agency_id) on delete set null (eval_run_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'issues_eval_stage_run_agency_fkey') then
    alter table public.issues add constraint issues_eval_stage_run_agency_fkey
      foreign key (eval_stage_run_id, agency_id) references public.eval_stage_runs(id, agency_id) on delete set null (eval_stage_run_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'issues_verification_eval_run_agency_fkey') then
    alter table public.issues add constraint issues_verification_eval_run_agency_fkey
      foreign key (verification_eval_run_id, agency_id) references public.eval_runs(id, agency_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reports_eval_coverage_object') then
    alter table public.reports add constraint reports_eval_coverage_object check (jsonb_typeof(eval_coverage_snapshot_json) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reports_eval_snapshot_idempotency_present') then
    alter table public.reports add constraint reports_eval_snapshot_idempotency_present check (
      eval_snapshot_idempotency_key is null or length(trim(eval_snapshot_idempotency_key)) > 0
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reports_eval_snapshot_provenance') then
    alter table public.reports add constraint reports_eval_snapshot_provenance check (
      eval_snapshot_idempotency_key is null
      or (
        eval_evidence_fingerprint ~ '^[a-f0-9]{64}$'
        and evidence_fingerprint = eval_evidence_fingerprint
        and snapshot_version > 0
        and snapshot_json->>'evidenceFingerprint' = eval_evidence_fingerprint
      )
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'journey_versions_workflow_agency_fkey') then
    alter table public.journey_versions add constraint journey_versions_workflow_agency_fkey
      foreign key (workflow_id, agency_id) references public.workflows(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'journey_versions_authorization_agency_fkey') then
    alter table public.journey_versions add constraint journey_versions_authorization_agency_fkey
      foreign key (authorization_id, agency_id) references public.project_authorizations(id, agency_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'journey_stage_definitions_version_agency_fkey') then
    alter table public.journey_stage_definitions add constraint journey_stage_definitions_version_agency_fkey
      foreign key (journey_version_id, agency_id) references public.journey_versions(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'journey_schedules_workflow_agency_fkey') then
    alter table public.journey_schedules add constraint journey_schedules_workflow_agency_fkey
      foreign key (workflow_id, agency_id) references public.workflows(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'journey_schedules_version_agency_fkey') then
    alter table public.journey_schedules add constraint journey_schedules_version_agency_fkey
      foreign key (journey_version_id, agency_id) references public.journey_versions(id, agency_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_runs_client_agency_fkey') then
    alter table public.eval_runs add constraint eval_runs_client_agency_fkey
      foreign key (client_id, agency_id) references public.clients(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_runs_workflow_agency_fkey') then
    alter table public.eval_runs add constraint eval_runs_workflow_agency_fkey
      foreign key (workflow_id, agency_id) references public.workflows(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_runs_version_agency_fkey') then
    alter table public.eval_runs add constraint eval_runs_version_agency_fkey
      foreign key (journey_version_id, agency_id) references public.journey_versions(id, agency_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_runs_schedule_agency_fkey') then
    alter table public.eval_runs add constraint eval_runs_schedule_agency_fkey
      foreign key (schedule_id, agency_id) references public.journey_schedules(id, agency_id) on delete set null (schedule_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_stage_runs_run_agency_fkey') then
    alter table public.eval_stage_runs add constraint eval_stage_runs_run_agency_fkey
      foreign key (eval_run_id, agency_id) references public.eval_runs(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_stage_runs_definition_agency_fkey') then
    alter table public.eval_stage_runs add constraint eval_stage_runs_definition_agency_fkey
      foreign key (stage_definition_id, agency_id) references public.journey_stage_definitions(id, agency_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'evidence_artifacts_run_agency_fkey') then
    alter table public.evidence_artifacts add constraint evidence_artifacts_run_agency_fkey
      foreign key (eval_run_id, agency_id) references public.eval_runs(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'evidence_artifacts_stage_run_agency_fkey') then
    alter table public.evidence_artifacts add constraint evidence_artifacts_stage_run_agency_fkey
      foreign key (eval_stage_run_id, agency_id) references public.eval_stage_runs(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbound_email_events_client_agency_fkey') then
    alter table public.inbound_email_events add constraint inbound_email_events_client_agency_fkey
      foreign key (client_id, agency_id) references public.clients(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbound_email_events_run_agency_fkey') then
    alter table public.inbound_email_events add constraint inbound_email_events_run_agency_fkey
      foreign key (eval_run_id, agency_id) references public.eval_runs(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbound_email_events_stage_agency_fkey') then
    alter table public.inbound_email_events add constraint inbound_email_events_stage_agency_fkey
      foreign key (stage_definition_id, agency_id) references public.journey_stage_definitions(id, agency_id) on delete set null (stage_definition_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'alert_deliveries_endpoint_agency_fkey') then
    alter table public.alert_deliveries add constraint alert_deliveries_endpoint_agency_fkey
      foreign key (alert_endpoint_id, agency_id) references public.alert_endpoints(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'alert_deliveries_run_agency_fkey') then
    alter table public.alert_deliveries add constraint alert_deliveries_run_agency_fkey
      foreign key (eval_run_id, agency_id) references public.eval_runs(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'alert_deliveries_issue_agency_fkey') then
    alter table public.alert_deliveries add constraint alert_deliveries_issue_agency_fkey
      foreign key (issue_id, agency_id) references public.issues(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_alert_outbox_run_agency_fkey') then
    alter table public.eval_alert_outbox add constraint eval_alert_outbox_run_agency_fkey
      foreign key (eval_run_id, agency_id) references public.eval_runs(id, agency_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eval_alert_outbox_issue_agency_fkey') then
    alter table public.eval_alert_outbox add constraint eval_alert_outbox_issue_agency_fkey
      foreign key (issue_id, agency_id) references public.issues(id, agency_id) on delete set null (issue_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'report_share_links_report_agency_fkey') then
    alter table public.report_share_links add constraint report_share_links_report_agency_fkey
      foreign key (report_id, agency_id) references public.reports(id, agency_id) on delete cascade;
  end if;
end $$;

alter table public.issues drop constraint if exists issues_verified_resolution_truth_check;
alter table public.issues add constraint issues_verified_resolution_truth_check check (
  (
    status = 'resolved'::public.issue_status
    and repair_recorded_at is not null
    and resolved_at is not null
    and (verification_run_id is not null or verification_eval_run_id is not null)
    and (not reportable or btrim(report_safe_summary) <> '')
  )
  or (
    status <> 'resolved'::public.issue_status
    and resolved_at is null
    and verification_run_id is null
    and verification_eval_run_id is null
  )
);

create or replace function public.enforce_issue_source_client_mutation_boundary()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon')
    and new.check_run_id is distinct from old.check_run_id then
    raise exception 'Incident source evidence may only be changed by the trusted service boundary.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_issue_source_client_mutation_boundary() from public;

drop trigger if exists issues_source_client_mutation_boundary on public.issues;
create trigger issues_source_client_mutation_boundary
before update of check_run_id on public.issues
for each row execute function public.enforce_issue_source_client_mutation_boundary();

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
  source_eval_verdict text;
  verification_eval_verdict text;
  verification_eval_status text;
begin
  if new.status::text <> 'resolved' then return new; end if;
  if new.repair_recorded_at is null or new.resolved_at is null
    or btrim(new.resolution_note) = ''
    or (new.reportable and btrim(new.report_safe_summary) = '') then
    raise exception 'A resolved issue requires a recorded repair, a client-safe note, and a verification run.' using errcode = '23514';
  end if;

  if new.verification_eval_run_id is not null then
    select r.verdict into source_eval_verdict from public.eval_runs r
    where r.id = new.eval_run_id and r.agency_id = new.agency_id
      and r.client_id = new.client_id and r.workflow_id = new.workflow_id
      and r.status = 'finalized' and r.verdict in ('failed', 'degraded');
    select r.status, r.verdict, r.started_at, r.completed_at
    into verification_eval_status, verification_eval_verdict, verification_started_at, verification_completed_at
    from public.eval_runs r
    where r.id = new.verification_eval_run_id and r.agency_id = new.agency_id
      and r.client_id = new.client_id and r.workflow_id = new.workflow_id
      and r.trigger_source = 'verification' and r.verification_issue_id = new.id;
    if source_eval_verdict is null or verification_eval_status <> 'finalized'
      or verification_eval_verdict <> 'passed'
      or verification_started_at <= new.repair_recorded_at
      or verification_completed_at < verification_started_at
      or new.resolved_at is distinct from verification_completed_at then
      raise exception 'A resolved eval incident must bind to a newer passing verification eval.' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.verification_run_id is null then
    raise exception 'A resolved issue requires a verification run.' using errcode = '23514';
  end if;
  select source_run.evidence_origin::text into source_origin
  from public.check_runs source_run
  where source_run.id = new.check_run_id and source_run.agency_id = new.agency_id
    and source_run.client_id = new.client_id and source_run.workflow_id = new.workflow_id
    and source_run.check_id = new.check_id;
  select cr.status::text, cr.evidence_origin::text, cr.started_at, cr.completed_at
  into verification_status, verification_origin, verification_started_at, verification_completed_at
  from public.check_runs cr
  where cr.id = new.verification_run_id and cr.agency_id = new.agency_id
    and cr.client_id = new.client_id and cr.workflow_id = new.workflow_id and cr.check_id = new.check_id;
  if not found or source_origin is distinct from 'service' or verification_origin is distinct from 'service'
    or verification_status <> 'healthy' or verification_started_at <= new.repair_recorded_at
    or verification_completed_at < verification_started_at
    or new.resolved_at is distinct from verification_completed_at then
    raise exception 'A resolved issue must bind to a newer healthy run for the same check and journey.' using errcode = '23514';
  end if;
  select cr.status::text into latest_run_status from public.check_runs cr
  where cr.agency_id = new.agency_id and cr.client_id = new.client_id
    and cr.workflow_id = new.workflow_id and cr.check_id = new.check_id
    and cr.evidence_origin = 'service'::public.check_run_evidence_origin
    and cr.status::text <> 'skipped' and cr.started_at > new.repair_recorded_at
  order by cr.started_at desc, cr.completed_at desc, cr.id desc limit 1;
  if latest_run_status is distinct from 'healthy' then
    raise exception 'The latest non-skipped run recorded after the repair must still be healthy.' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_issue_verification_truth() from public;

drop trigger if exists issues_enforce_verification_truth on public.issues;
create trigger issues_enforce_verification_truth
before insert or update of
  check_run_id,
  status,
  repair_recorded_at,
  resolved_at,
  verification_run_id,
  verification_eval_run_id,
  resolution_note,
  report_safe_summary,
  reportable,
  agency_id,
  client_id,
  workflow_id,
  check_id,
  eval_run_id
on public.issues
for each row execute function public.enforce_issue_verification_truth();

create or replace function public.enforce_eval_incident_client_mutation_boundary()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), current_user);
begin
  if request_role not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if old.eval_run_id is not null or old.eval_stage_run_id is not null or old.verification_eval_run_id is not null then
      raise exception 'Eval incidents may only be deleted by the trusted service boundary.' using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.eval_run_id is not null or new.eval_stage_run_id is not null or new.verification_eval_run_id is not null then
      raise exception 'Eval incident evidence links are service-issued.' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.eval_run_id is not null or old.eval_stage_run_id is not null or old.verification_eval_run_id is not null
    or new.eval_run_id is not null or new.eval_stage_run_id is not null or new.verification_eval_run_id is not null then
    raise exception 'Eval incidents must use the tenant-scoped service API.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists issues_eval_incident_client_boundary on public.issues;
create trigger issues_eval_incident_client_boundary
before insert or update or delete on public.issues
for each row execute function public.enforce_eval_incident_client_mutation_boundary();

create or replace function public.enforce_eval_incident_note_client_mutation_boundary()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), current_user);
begin
  if request_role in ('authenticated', 'anon') and (
    (tg_op <> 'INSERT' and exists (
      select 1 from public.issues issue where issue.id = old.issue_id
        and (issue.eval_run_id is not null or issue.eval_stage_run_id is not null or issue.verification_eval_run_id is not null)
    ))
    or (tg_op <> 'DELETE' and exists (
      select 1 from public.issues issue where issue.id = new.issue_id
        and (issue.eval_run_id is not null or issue.eval_stage_run_id is not null or issue.verification_eval_run_id is not null)
    ))
  ) then
    raise exception 'Eval incident notes must use the tenant-scoped service API.' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists issue_notes_eval_incident_client_boundary on public.issue_notes;
create trigger issue_notes_eval_incident_client_boundary
before insert or update or delete on public.issue_notes
for each row execute function public.enforce_eval_incident_note_client_mutation_boundary();


create or replace function public.record_business_eval_incident_repair(
  p_agency_id uuid,
  p_issue_id uuid,
  p_user_id uuid,
  p_expected_updated_at timestamptz,
  p_note text
)
returns setof public.issues
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.issues%rowtype;
  normalized_note text := btrim(coalesce(p_note, ''));
  recorded_at timestamptz := clock_timestamp();
begin
  if length(normalized_note) not between 1 and 4000 then
    raise exception 'INCIDENT_REPAIR_NOTE_INVALID' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships
    where agency_id = p_agency_id and user_id = p_user_id
  ) then
    raise exception 'INCIDENT_REPAIR_ACTOR_FORBIDDEN' using errcode = '42501';
  end if;

  select * into saved from public.issues
  where id = p_issue_id and agency_id = p_agency_id
  for update;
  if not found then
    raise exception 'INCIDENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if saved.updated_at is distinct from p_expected_updated_at then
    raise exception 'INCIDENT_UPDATE_CONFLICT' using errcode = '40001';
  end if;

  insert into public.issue_notes (agency_id, issue_id, user_id, body, report_safe)
  values (p_agency_id, p_issue_id, p_user_id, normalized_note, true);

  update public.issues incident set
    status = 'in_review',
    repair_recorded_at = recorded_at,
    resolved_at = null,
    verification_eval_run_id = null,
    verification_run_id = null,
    resolution_note = normalized_note,
    report_safe_summary = normalized_note,
    snoozed_until = null,
    updated_at = recorded_at
  where incident.id = saved.id;

  return query select * from public.issues where id = saved.id;
end;
$$;

create or replace function public.enforce_business_eval_report_client_mutation_boundary()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  request_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), current_user);
  old_is_eval boolean := false;
  new_is_eval boolean := false;
begin
  if request_role not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op <> 'INSERT' then
    old_is_eval := old.eval_snapshot_idempotency_key is not null
      or old.eval_evidence_fingerprint <> ''
      or old.eval_coverage_snapshot_json <> '{}'::jsonb;
  end if;
  if tg_op <> 'DELETE' then
    new_is_eval := new.eval_snapshot_idempotency_key is not null
      or new.eval_evidence_fingerprint <> ''
      or new.eval_coverage_snapshot_json <> '{}'::jsonb;
  end if;

  if old_is_eval or new_is_eval then
    raise exception 'Business-eval reports must use the tenant-scoped service API.' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists reports_business_eval_client_boundary on public.reports;
create trigger reports_business_eval_client_boundary
before insert or update or delete on public.reports
for each row execute function public.enforce_business_eval_report_client_mutation_boundary();

-- Legacy workflows become immutable one-stage endpoint journey versions. They
-- remain inactive until explicitly published/selected by the application.
insert into public.journey_versions (
  id, agency_id, workflow_id, version_number, template, start_url,
  definition_json, definition_hash, source, created_at
)
select
  gen_random_uuid(), w.agency_id, w.id, 1, 'legacy_endpoint', w.endpoint_url,
  jsonb_build_object('legacyWorkflowId', w.id, 'method', w.method, 'expectedStatus', w.expected_status),
  encode(digest(w.id::text || ':legacy_endpoint:v1', 'sha256'), 'hex'),
  'legacy_backfill', w.created_at
from public.workflows w
where w.journey_template = 'legacy_endpoint'
  and not exists (select 1 from public.journey_versions v where v.workflow_id = w.id);

insert into public.journey_stage_definitions (
  agency_id, journey_version_id, position, stage_key, name,
  action_manifest_json, expected_text, business_impact, timing_threshold_ms, is_cleanup, created_at
)
select
  v.agency_id, v.id, 0, 'endpoint_response', 'Endpoint response',
  jsonb_build_object(
    'required', true,
    'actions', jsonb_build_array(jsonb_build_object(
      'id', 'legacy_endpoint_navigate',
      'label', 'Open the approved endpoint',
      'timeoutMs', greatest(250, least(60000, w.timeout_seconds * 1000)),
      'type', 'navigate',
      'url', w.endpoint_url
    ))
  ),
  'The approved endpoint returns its expected response.',
  'The monitored business journey remains available.',
  w.max_latency_ms, false, v.created_at
from public.journey_versions v
join public.workflows w on w.id = v.workflow_id and w.agency_id = v.agency_id
where v.source = 'legacy_backfill'
  and w.journey_template = 'legacy_endpoint'
  and not exists (select 1 from public.journey_stage_definitions s where s.journey_version_id = v.id);

-- Quarantine any legacy backfill created by an earlier migration revision for
-- a lead/trial draft. Keep the immutable row for audit, but never leave it active.
update public.workflows w
set active_journey_version_id = null, updated_at = now()
from public.journey_versions v
where w.active_journey_version_id = v.id
  and v.workflow_id = w.id and v.agency_id = w.agency_id
  and v.template <> w.journey_template;

update public.workflows w
set active_journey_version_id = v.id
from public.journey_versions v
where v.workflow_id = w.id
  and v.agency_id = w.agency_id
  and v.source = 'legacy_backfill'
  and w.journey_template = 'legacy_endpoint'
  and v.template = w.journey_template
  and w.active_journey_version_id is null;

with ranked_eval_state as (
  select
    run.agency_id,
    run.workflow_id,
    run.verdict,
    row_number() over (
      partition by run.agency_id, run.workflow_id
      order by coalesce(run.completed_at, run.created_at) desc, run.id desc
    ) as position
  from public.eval_runs run
  where run.status = 'finalized'
)
update public.workflows journey
set
  status = case ranked_eval_state.verdict
    when 'passed' then 'healthy'::public.workflow_status
    when 'degraded' then 'degraded'::public.workflow_status
    when 'failed' then 'failed'::public.workflow_status
    else 'pending'::public.workflow_status
  end,
  updated_at = now()
from ranked_eval_state
where ranked_eval_state.position = 1
  and journey.id = ranked_eval_state.workflow_id
  and journey.agency_id = ranked_eval_state.agency_id
  and journey.journey_template in ('lead_form', 'trial_signup')
  and journey.status is distinct from case ranked_eval_state.verdict
    when 'passed' then 'healthy'::public.workflow_status
    when 'degraded' then 'degraded'::public.workflow_status
    when 'failed' then 'failed'::public.workflow_status
    else 'pending'::public.workflow_status
  end;

create or replace function public.reject_legacy_test_table_writes()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- The legacy structures are read-only product data, but an owning workspace
  -- must still be deletable for account erasure. PostgreSQL invokes FK cascade
  -- triggers at a nested trigger depth; only that cascade is allowed through.
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  raise exception 'Legacy test-pack tables are frozen; use business eval journey versions.' using errcode = '55000';
end;
$$;

drop trigger if exists test_packs_frozen on public.test_packs;
create trigger test_packs_frozen before insert or update or delete on public.test_packs
for each statement execute function public.reject_legacy_test_table_writes();
drop trigger if exists test_cases_frozen on public.test_cases;
create trigger test_cases_frozen before insert or update or delete on public.test_cases
for each statement execute function public.reject_legacy_test_table_writes();
drop trigger if exists test_runs_frozen on public.test_runs;
create trigger test_runs_frozen before insert or update or delete on public.test_runs
for each statement execute function public.reject_legacy_test_table_writes();

create index if not exists project_authorizations_agency_active_idx on public.project_authorizations(agency_id, client_id, revoked_at);
create index if not exists journey_versions_agency_workflow_idx on public.journey_versions(agency_id, workflow_id, version_number desc);
create index if not exists journey_stage_definitions_version_idx on public.journey_stage_definitions(journey_version_id, position);
create index if not exists journey_schedules_due_idx on public.journey_schedules(next_run_at, lease_expires_at) where enabled and paused_at is null;
create index if not exists eval_runs_agency_created_idx on public.eval_runs(agency_id, created_at desc);
create index if not exists eval_runs_workflow_created_idx on public.eval_runs(workflow_id, created_at desc);
create index if not exists eval_runs_project_created_idx on public.eval_runs(agency_id, client_id, created_at desc, id desc);
create index if not exists reports_project_created_idx on public.reports(agency_id, client_id, created_at desc, id desc);
create index if not exists eval_runs_claim_idx on public.eval_runs(status, created_at) where status = 'queued';
create index if not exists eval_runs_dispatch_claim_idx
  on public.eval_runs(dispatch_state, dispatch_lease_expires_at, created_at)
  where orchestration_run_id = '' and status in ('queued', 'claimed', 'running');
create index if not exists eval_runs_quota_idx on public.eval_runs(agency_id, quota_period_start) where quota_counted;
create index if not exists eval_stage_runs_run_idx on public.eval_stage_runs(eval_run_id, position);
create index if not exists evidence_artifacts_run_idx on public.evidence_artifacts(eval_run_id, created_at);
create index if not exists evidence_artifacts_expiry_idx on public.evidence_artifacts(expires_at);
create index if not exists inbound_email_events_run_idx on public.inbound_email_events(eval_run_id, received_at);
create index if not exists eval_email_receiving_health_lookup_idx
  on public.eval_email_receiving_health_events(provider, inbound_domain, observed_at desc);
create index if not exists provider_webhook_receipts_recovery_idx
  on public.provider_webhook_receipts(status, updated_at)
  where status in ('processing', 'failed');
create index if not exists alert_deliveries_pending_idx on public.alert_deliveries(status, next_attempt_at) where status in ('pending', 'failed');
create index if not exists report_share_links_report_idx on public.report_share_links(report_id, expires_at);
create index if not exists report_share_links_expiry_idx on public.report_share_links(expires_at) where revoked_at is null;
create index if not exists issues_eval_run_idx on public.issues(eval_run_id) where eval_run_id is not null;
create unique index if not exists reports_eval_snapshot_idempotency_uidx
  on public.reports(agency_id, eval_snapshot_idempotency_key)
  where eval_snapshot_idempotency_key is not null;

create or replace function public.revoke_project_authorizations_and_pause(
  p_agency_id uuid,
  p_client_id uuid
)
returns table(revoked_count integer, paused_schedule_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  revoked integer := 0;
  paused integer := 0;
begin
  perform 1 from public.clients
  where id = p_client_id and agency_id = p_agency_id
  for update;
  if not found then
    raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.project_authorizations
  set revoked_at = now(), updated_at = now()
  where agency_id = p_agency_id and client_id = p_client_id and revoked_at is null;
  get diagnostics revoked = row_count;

  update public.journey_schedules schedule set
    enabled = false,
    paused_at = now(),
    pause_reason = 'project_authorization_revoked',
    lease_expires_at = null,
    leased_by = null,
    updated_at = now()
  from public.workflows journey
  where journey.id = schedule.workflow_id
    and journey.agency_id = schedule.agency_id
    and journey.agency_id = p_agency_id
    and journey.client_id = p_client_id
    and journey.journey_template in ('lead_form', 'trial_signup');
  get diagnostics paused = row_count;

  return query select revoked, paused;
end;
$$;


create or replace function public.create_business_eval_project(
  p_agency_id uuid,
  p_project_limit integer,
  p_project_id uuid,
  p_name text,
  p_slug text,
  p_website text,
  p_project_kind text,
  p_owner_user_id uuid,
  p_report_recipient_email text,
  p_notes text
)
returns setof public.clients
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  active_count integer;
begin
  if p_project_limit is not null and p_project_limit < 0 then
    raise exception 'PROJECT_LIMIT_INVALID' using errcode = '22023';
  end if;

  perform 1 from public.agencies where id = p_agency_id for update;
  if not found then
    raise exception 'WORKSPACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.memberships
    where agency_id = p_agency_id and user_id = p_owner_user_id
  ) then
    raise exception 'OWNER_NOT_IN_WORKSPACE' using errcode = '23503';
  end if;

  if p_project_limit is not null then
    select count(*)::integer into active_count
    from public.clients where agency_id = p_agency_id and archived_at is null;
    if active_count >= p_project_limit then
      raise exception 'PROJECT_LIMIT_REACHED' using errcode = 'P0001';
    end if;
  end if;

  insert into public.clients (
    id, agency_id, name, slug, website, project_kind, owner_user_id,
    report_recipient_email, report_cadence, notes
  ) values (
    p_project_id, p_agency_id, p_name, p_slug, p_website, p_project_kind,
    p_owner_user_id, nullif(p_report_recipient_email, ''), 'monthly', coalesce(p_notes, '')
  );

  return query
  select project.* from public.clients project
  where project.id = p_project_id and project.agency_id = p_agency_id;
end;
$$;

create or replace function public.create_legacy_endpoint_workflow(
  p_agency_id uuid,
  p_journey_limit integer,
  p_workflow_id uuid,
  p_client_id uuid,
  p_name text,
  p_type public.workflow_type,
  p_environment public.workflow_environment,
  p_endpoint_url text,
  p_expected_status integer,
  p_timeout_seconds integer,
  p_max_latency_ms integer,
  p_frequency_minutes integer,
  p_retries integer,
  p_report_included boolean,
  p_archived_at timestamptz
)
returns setof public.workflows
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  active_count integer;
begin
  if p_journey_limit is not null and p_journey_limit < 0 then
    raise exception 'JOURNEY_LIMIT_INVALID' using errcode = '22023';
  end if;
  perform 1 from public.agencies where id = p_agency_id for update;
  if not found then
    raise exception 'WORKSPACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.clients
    where id = p_client_id
      and agency_id = p_agency_id
      and (p_archived_at is not null or archived_at is null)
  ) then
    raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_archived_at is null and p_journey_limit is not null then
    select count(*)::integer into active_count
    from public.workflows journey
    join public.clients project
      on project.id = journey.client_id and project.agency_id = journey.agency_id
    where journey.agency_id = p_agency_id
      and journey.archived_at is null
      and project.archived_at is null;
    if active_count >= p_journey_limit then
      raise exception 'JOURNEY_LIMIT_REACHED' using errcode = 'P0001';
    end if;
  end if;

  insert into public.workflows (
    id, agency_id, client_id, name, type, environment, endpoint_url, method,
    auth_type, encrypted_auth_config, request_body, expected_status,
    timeout_seconds, max_latency_ms, frequency_minutes, retries,
    report_included, store_raw_response, status, health_score,
    last_check_run_at, archived_at, journey_template, draft_definition_json,
    draft_revision, paused_at, pause_reason
  ) values (
    p_workflow_id, p_agency_id, p_client_id, p_name, p_type, p_environment,
    p_endpoint_url, 'GET', 'none', '{"headers":[]}'::jsonb, '', p_expected_status,
    p_timeout_seconds, p_max_latency_ms, p_frequency_minutes, p_retries,
    p_report_included, false, 'pending', 0, null, p_archived_at,
    'legacy_endpoint', '{}'::jsonb, 0, null, ''
  );

  return query
  select workflow.* from public.workflows workflow
  where workflow.id = p_workflow_id and workflow.agency_id = p_agency_id;
end;
$$;

drop function if exists public.restore_business_eval_project(uuid,uuid,integer);
create or replace function public.restore_business_eval_project(
  p_agency_id uuid,
  p_client_id uuid,
  p_project_limit integer,
  p_journey_limit integer
)
returns setof public.clients
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_project public.clients%rowtype;
  active_count integer;
  active_journey_count integer;
  restoring_journey_count integer;
begin
  if p_project_limit is not null and p_project_limit < 0 then
    raise exception 'PROJECT_LIMIT_INVALID' using errcode = '22023';
  end if;
  if p_journey_limit is not null and p_journey_limit < 0 then
    raise exception 'JOURNEY_LIMIT_INVALID' using errcode = '22023';
  end if;
  perform 1 from public.agencies where id = p_agency_id for update;
  if not found then
    raise exception 'WORKSPACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into saved_project from public.clients
  where id = p_client_id and agency_id = p_agency_id
  for update;
  if not found then
    raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if saved_project.archived_at is null then
    return query select project.* from public.clients project
    where project.id = p_client_id and project.agency_id = p_agency_id;
    return;
  end if;
  if p_project_limit is not null then
    select count(*)::integer into active_count from public.clients
    where agency_id = p_agency_id and archived_at is null;
    if active_count >= p_project_limit then
      raise exception 'PROJECT_LIMIT_REACHED' using errcode = 'P0001';
    end if;
  end if;
  if p_journey_limit is not null then
    select count(*)::integer into active_journey_count
    from public.workflows journey
    join public.clients project
      on project.id = journey.client_id and project.agency_id = journey.agency_id
    where journey.agency_id = p_agency_id
      and journey.archived_at is null
      and project.archived_at is null;
    select count(*)::integer into restoring_journey_count
    from public.workflows journey
    where journey.agency_id = p_agency_id
      and journey.client_id = p_client_id
      and journey.archived_at is null;
    if active_journey_count + restoring_journey_count > p_journey_limit then
      raise exception 'JOURNEY_LIMIT_REACHED' using errcode = 'P0001';
    end if;
  end if;
  return query
  update public.clients project set archived_at = null, updated_at = now()
  where project.id = p_client_id and project.agency_id = p_agency_id
  returning project.*;
end;
$$;


create or replace function public.create_business_eval_journey(
  p_agency_id uuid,
  p_journey_limit integer,
  p_journey_id uuid,
  p_client_id uuid,
  p_name text,
  p_template text,
  p_start_url text,
  p_draft_definition jsonb
)
returns setof public.workflows
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  active_count integer;
begin
  if p_journey_limit is not null and p_journey_limit < 0 then
    raise exception 'JOURNEY_LIMIT_INVALID' using errcode = '22023';
  end if;
  if p_template not in ('lead_form', 'trial_signup') then
    raise exception 'JOURNEY_TEMPLATE_UNSUPPORTED' using errcode = '22023';
  end if;

  perform 1 from public.agencies where id = p_agency_id for update;
  if not found then
    raise exception 'WORKSPACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.clients
    where id = p_client_id and agency_id = p_agency_id and archived_at is null
  ) then
    raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_journey_limit is not null then
    select count(*)::integer into active_count
    from public.workflows journey
    join public.clients project
      on project.id = journey.client_id and project.agency_id = journey.agency_id
    where journey.agency_id = p_agency_id
      and journey.archived_at is null
      and project.archived_at is null;
    if active_count >= p_journey_limit then
      raise exception 'JOURNEY_LIMIT_REACHED' using errcode = 'P0001';
    end if;
  end if;

  insert into public.workflows (
    id, agency_id, client_id, name, type, environment, endpoint_url, method,
    auth_type, encrypted_auth_config, request_body, expected_status,
    timeout_seconds, max_latency_ms, frequency_minutes, retries,
    report_included, store_raw_response, status, journey_template,
    draft_definition_json, draft_revision
  ) values (
    p_journey_id, p_agency_id, p_client_id, p_name, 'http_endpoint', 'production',
    p_start_url, 'GET', 'none', '{}'::jsonb, '', 200, 30, 10000, 1440, 0,
    true, false, 'pending', p_template, p_draft_definition, 0
  );

  return query
  select journey.* from public.workflows journey
  where journey.id = p_journey_id and journey.agency_id = p_agency_id;
end;
$$;


create or replace function public.set_business_eval_journey_archived(
  p_agency_id uuid,
  p_workflow_id uuid,
  p_actor_user_id uuid,
  p_archived boolean,
  p_journey_limit integer default null
)
returns setof public.workflows
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_journey public.workflows%rowtype;
  active_count integer;
  changed_at timestamptz := now();
  disabled_legacy_checks integer := 0;
  cancellation_requested_runs integer := 0;
begin
  if p_archived is null then
    raise exception 'ARCHIVE_STATE_REQUIRED' using errcode = '22023';
  end if;
  if p_journey_limit is not null and p_journey_limit < 0 then
    raise exception 'JOURNEY_LIMIT_INVALID' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships membership
    where membership.agency_id = p_agency_id
      and membership.user_id = p_actor_user_id
      and membership.role in ('owner'::public.agency_role, 'admin'::public.agency_role)
  ) then
    raise exception 'WORKSPACE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  perform 1 from public.agencies where id = p_agency_id for update;
  if not found then
    raise exception 'WORKSPACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into saved_journey from public.workflows journey
  where journey.id = p_workflow_id and journey.agency_id = p_agency_id
  for update;
  if not found then
    raise exception 'JOURNEY_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_archived and saved_journey.archived_at is not null then
    return query select journey.* from public.workflows journey
    where journey.id = saved_journey.id and journey.agency_id = saved_journey.agency_id;
    return;
  end if;
  if not p_archived and saved_journey.archived_at is null then
    return query select journey.* from public.workflows journey
    where journey.id = saved_journey.id and journey.agency_id = saved_journey.agency_id;
    return;
  end if;

  if p_archived then
    update public.workflows journey set
      archived_at = changed_at,
      paused_at = coalesce(journey.paused_at, changed_at),
      pause_reason = case
        when journey.paused_at is null or btrim(journey.pause_reason) = '' then 'journey_archived'
        else journey.pause_reason
      end,
      updated_at = changed_at
    where journey.id = saved_journey.id and journey.agency_id = saved_journey.agency_id;

    update public.journey_schedules schedule set
      enabled = false,
      paused_at = coalesce(schedule.paused_at, changed_at),
      pause_reason = case
        when schedule.paused_at is null or btrim(schedule.pause_reason) = '' then 'journey_archived'
        else schedule.pause_reason
      end,
      lease_expires_at = null,
      leased_by = null,
      updated_at = changed_at
    where schedule.workflow_id = saved_journey.id
      and schedule.agency_id = saved_journey.agency_id;

    update public.checks check_state set
      enabled = false,
      lease_expires_at = null,
      leased_by = null,
      updated_at = changed_at
    where check_state.workflow_id = saved_journey.id
      and check_state.agency_id = saved_journey.agency_id
      and check_state.enabled;
    get diagnostics disabled_legacy_checks = row_count;

    update public.eval_runs run set
      cancel_requested_at = coalesce(run.cancel_requested_at, changed_at),
      cancel_requested_by_user_id = coalesce(run.cancel_requested_by_user_id, p_actor_user_id),
      updated_at = changed_at
    where run.workflow_id = saved_journey.id
      and run.agency_id = saved_journey.agency_id
      and run.status in ('queued', 'claimed', 'running');
    get diagnostics cancellation_requested_runs = row_count;
  else
    if not exists (
      select 1 from public.clients project
      where project.id = saved_journey.client_id
        and project.agency_id = saved_journey.agency_id
        and project.archived_at is null
    ) then
      raise exception 'PROJECT_ARCHIVED' using errcode = '55000';
    end if;
    if p_journey_limit is not null then
      select count(*)::integer into active_count
      from public.workflows journey
      join public.clients project
        on project.id = journey.client_id and project.agency_id = journey.agency_id
      where journey.agency_id = p_agency_id
        and journey.archived_at is null
        and project.archived_at is null;
      if active_count >= p_journey_limit then
        raise exception 'JOURNEY_LIMIT_REACHED' using errcode = 'P0001';
      end if;
    end if;

    update public.workflows journey set
      archived_at = null,
      paused_at = coalesce(journey.paused_at, changed_at),
      pause_reason = case
        when journey.pause_reason in ('', 'journey_archived') then 'journey_restored'
        else journey.pause_reason
      end,
      updated_at = changed_at
    where journey.id = saved_journey.id and journey.agency_id = saved_journey.agency_id;

    update public.journey_schedules schedule set
      enabled = false,
      paused_at = coalesce(schedule.paused_at, changed_at),
      pause_reason = case
        when schedule.pause_reason in ('', 'journey_archived') then 'journey_restored'
        else schedule.pause_reason
      end,
      lease_expires_at = null,
      leased_by = null,
      updated_at = changed_at
    where schedule.workflow_id = saved_journey.id
      and schedule.agency_id = saved_journey.agency_id;
  end if;

  insert into public.audit_events(
    agency_id, actor_user_id, entity_type, entity_id, action, metadata_json
  ) values (
    saved_journey.agency_id,
    p_actor_user_id,
    'journey',
    saved_journey.id,
    case when p_archived then 'business_eval_journey_archived' else 'business_eval_journey_restored' end,
    jsonb_build_object(
      'projectId', saved_journey.client_id,
      'archived', p_archived,
      'legacyChecksDisabled', disabled_legacy_checks,
      'activeRunsCancellationRequested', cancellation_requested_runs,
      'schedulesRemainDisabled', true
    )
  );

  return query select journey.* from public.workflows journey
  where journey.id = saved_journey.id and journey.agency_id = saved_journey.agency_id;
end;
$$;


create or replace function public.prevent_immutable_journey_definition_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Published journey versions and stage definitions are immutable.' using errcode = '55000';
end;
$$;

drop trigger if exists journey_versions_immutable on public.journey_versions;
create trigger journey_versions_immutable before update or delete on public.journey_versions
for each row execute function public.prevent_immutable_journey_definition_change();
drop trigger if exists journey_stage_definitions_immutable on public.journey_stage_definitions;
create trigger journey_stage_definitions_immutable before update or delete on public.journey_stage_definitions
for each row execute function public.prevent_immutable_journey_definition_change();

create or replace function public.publish_journey_version(
  p_agency_id uuid,
  p_workflow_id uuid,
  p_expected_draft_revision integer,
  p_authorization_id uuid,
  p_created_by_user_id uuid
)
returns table(journey_version_id uuid, version_number integer, next_draft_revision integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_agency public.agencies%rowtype;
  saved_workflow public.workflows%rowtype;
  saved_authorization public.project_authorizations%rowtype;
  clean_start_url text;
  start_hostname text;
  action_hostname text;
  next_version integer;
  created_version_id uuid;
  stage_item jsonb;
  action_item jsonb;
  allowed_host_item jsonb;
  action_type text;
  stage_is_cleanup boolean;
  has_cleanup_stage boolean := false;
  selected_radio_groups text[] := array[]::text[];
  requires_paid_features boolean := false;
  paid_features_available boolean := false;
begin
  select * into saved_workflow from public.workflows
  where id = p_workflow_id and agency_id = p_agency_id and archived_at is null
  for update;
  if not found then raise exception 'Journey was not found.' using errcode = 'P0002'; end if;
  select * into saved_agency from public.agencies
  where id = p_agency_id
  for share;
  if not found then raise exception 'Workspace was not found.' using errcode = 'P0002'; end if;
  if saved_workflow.draft_revision <> p_expected_draft_revision then
    raise exception 'Journey draft changed in another session.' using errcode = '40001';
  end if;
  if jsonb_typeof(saved_workflow.draft_definition_json) <> 'object'
    or saved_workflow.draft_definition_json - array[
      'projectId','name','draftRevision','template','startUrl',
      'emailProofConfigured','cleanupMode','stages'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(saved_workflow.draft_definition_json->'projectId') is distinct from 'string'
    or saved_workflow.draft_definition_json->>'projectId' <> saved_workflow.client_id::text
    or jsonb_typeof(saved_workflow.draft_definition_json->'name') is distinct from 'string'
    or saved_workflow.draft_definition_json->>'name' <> saved_workflow.name
    or saved_workflow.draft_definition_json->>'name' <> btrim(saved_workflow.draft_definition_json->>'name')
    or jsonb_typeof(saved_workflow.draft_definition_json->'draftRevision') is distinct from 'number'
    or coalesce(saved_workflow.draft_definition_json->>'draftRevision', '') !~ '^[0-9]+$'
    or (saved_workflow.draft_definition_json->>'draftRevision')::integer <> saved_workflow.draft_revision
    or jsonb_typeof(saved_workflow.draft_definition_json->'template') is distinct from 'string'
    or saved_workflow.draft_definition_json->>'template' <> saved_workflow.journey_template
    or jsonb_typeof(saved_workflow.draft_definition_json->'startUrl') is distinct from 'string'
    or saved_workflow.draft_definition_json->>'startUrl' <> btrim(saved_workflow.draft_definition_json->>'startUrl')
    or jsonb_typeof(saved_workflow.draft_definition_json->'emailProofConfigured') is distinct from 'boolean'
    or jsonb_typeof(saved_workflow.draft_definition_json->'cleanupMode') is distinct from 'string'
    or jsonb_typeof(saved_workflow.draft_definition_json->'stages') <> 'array'
    or jsonb_array_length(saved_workflow.draft_definition_json->'stages') not between 1 and 30 then
    raise exception 'Journey draft metadata must match the current canonical workflow revision.' using errcode = '22023';
  end if;
  clean_start_url := btrim(coalesce(saved_workflow.draft_definition_json->>'startUrl', ''));
  start_hostname := lower(substring(clean_start_url from '^https://([^/:?#]+)'));
  if length(clean_start_url) not between 1 and 2048
    or clean_start_url <> saved_workflow.endpoint_url
    or clean_start_url !~ '^https://[a-z0-9.-]+(?::[0-9]{1,5})?(?:[/?#]|$)[^[:space:]]*$'
    or clean_start_url ~ '^https://[^/?#]*@'
    or (
      substring(clean_start_url from '^https://[^/:?#]+:([0-9]+)(?:[/?#]|$)') is not null
      and (substring(clean_start_url from '^https://[^/:?#]+:([0-9]+)(?:[/?#]|$)'))::integer not between 1 and 65535
    )
    or start_hostname is null
    or start_hostname !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$' then
    raise exception 'Journey start URL must use public HTTPS.' using errcode = '22023';
  end if;
  if saved_workflow.draft_definition_json::text ~* '"(css|selector|xpath|javascript|script|code|evaluate)"[[:space:]]*:' then
    raise exception 'Journey manifests cannot contain arbitrary JavaScript, CSS selectors, or XPath.' using errcode = '22023';
  end if;
  requires_paid_features := saved_workflow.journey_template = 'trial_signup'
    or coalesce((saved_workflow.draft_definition_json->>'emailProofConfigured')::boolean, false);
  paid_features_available := (
    saved_agency.complimentary_entitlement
    and saved_agency.plan::text <> 'free'
    and length(trim(coalesce(saved_agency.complimentary_entitlement_reason, ''))) > 0
  ) or (
    coalesce(saved_agency.stripe_subscription_status, '') in ('trialing', 'active')
    and nullif(trim(coalesce(saved_agency.stripe_customer_id, '')), '') is not null
    and nullif(trim(coalesce(saved_agency.stripe_subscription_id, '')), '') is not null
    and saved_agency.plan::text in ('starter', 'growth', 'scale')
  ) or (
    saved_agency.stripe_subscription_status is null
    and nullif(trim(coalesce(saved_agency.stripe_customer_id, '')), '') is null
    and nullif(trim(coalesce(saved_agency.stripe_subscription_id, '')), '') is null
    and saved_agency.plan::text in ('free', 'growth')
    and coalesce(coalesce(saved_agency.team_trial_ends_at, saved_agency.trial_ends_at) > now(), false)
  );
  if requires_paid_features and not paid_features_available then
    raise exception 'Email assertions and Trial signup journeys require a current paid entitlement.' using errcode = '42501';
  end if;
  if p_created_by_user_id is not null and not exists (
    select 1 from public.memberships m where m.agency_id = p_agency_id and m.user_id = p_created_by_user_id
  ) then
    raise exception 'Publisher is not a workspace member.' using errcode = '42501';
  end if;

  if saved_workflow.journey_template in ('lead_form', 'trial_signup') then
    if p_authorization_id is null then
      raise exception 'An active owner attestation is required for this project domain.' using errcode = '42501';
    end if;
    select * into saved_authorization
    from public.project_authorizations a
    where a.id = p_authorization_id and a.agency_id = p_agency_id
      and a.client_id = saved_workflow.client_id and a.revoked_at is null
      and public.hostname_is_covered_by_project_authorization(
        start_hostname, a.hostname::text, a.approved_action_domains
      )
    for share;
    if not found then
      raise exception 'An active owner attestation is required for this project domain.' using errcode = '42501';
    end if;
  elsif p_authorization_id is not null then
    select * into saved_authorization
    from public.project_authorizations a
    where a.id = p_authorization_id and a.agency_id = p_agency_id
      and a.client_id = saved_workflow.client_id and a.revoked_at is null
    for share;
    if not found then
      raise exception 'Project authorization does not match this journey.' using errcode = '42501';
    end if;
  end if;

  for stage_item in select value from jsonb_array_elements(saved_workflow.draft_definition_json->'stages')
  loop
    if jsonb_typeof(stage_item) <> 'object'
      or stage_item - array[
        'key','name','position','required','cleanup','actions',
        'expected','businessImpact','timingThresholdMs'
      ]::text[] <> '{}'::jsonb
      or jsonb_typeof(stage_item->'actions') <> 'array'
      or jsonb_array_length(stage_item->'actions') not between 1 and 30
      or jsonb_typeof(stage_item->'key') is distinct from 'string'
      or coalesce(stage_item->>'key', '') !~ '^[a-z][a-z0-9_]{0,63}$'
      or jsonb_typeof(stage_item->'name') is distinct from 'string'
      or length(trim(coalesce(stage_item->>'name', ''))) not between 1 and 120
      or stage_item->>'name' <> btrim(stage_item->>'name')
      or jsonb_typeof(stage_item->'position') is distinct from 'number'
      or coalesce(stage_item->>'position', '') !~ '^[0-9]+$'
      or (stage_item->>'position')::integer not between 0 and 30
      or (stage_item ? 'required' and jsonb_typeof(stage_item->'required') is distinct from 'boolean')
      or (stage_item ? 'cleanup' and jsonb_typeof(stage_item->'cleanup') is distinct from 'boolean')
      or jsonb_typeof(stage_item->'expected') is distinct from 'string'
      or length(trim(coalesce(stage_item->>'expected', ''))) not between 1 and 1000
      or stage_item->>'expected' <> btrim(stage_item->>'expected')
      or (stage_item ? 'businessImpact' and (
        jsonb_typeof(stage_item->'businessImpact') is distinct from 'string'
        or stage_item->>'businessImpact' <> btrim(stage_item->>'businessImpact')
        or length(stage_item->>'businessImpact') > 1000
      ))
      or (stage_item ? 'timingThresholdMs' and stage_item->'timingThresholdMs' <> 'null'::jsonb and (
        jsonb_typeof(stage_item->'timingThresholdMs') is distinct from 'number'
        or coalesce(stage_item->>'timingThresholdMs', '') !~ '^[0-9]+$'
        or (stage_item->>'timingThresholdMs')::integer not between 1 and 120000
      )) then
      raise exception 'Journey draft contains an invalid stage.' using errcode = '22023';
    end if;

    stage_is_cleanup := coalesce((stage_item->>'cleanup')::boolean, false);
    for action_item in select value from jsonb_array_elements(stage_item->'actions')
    loop
      action_type := action_item->>'type';
      if jsonb_typeof(action_item) <> 'object'
        or action_type is null
        or action_type not in (
          'navigate', 'fill', 'click', 'wait_for_url', 'wait_for_text',
          'wait_for_email', 'open_email_link', 'assert_visible', 'cleanup'
        )
        or jsonb_typeof(action_item->'id') is distinct from 'string'
        or length(trim(coalesce(action_item->>'id', ''))) not between 1 and 80
        or jsonb_typeof(action_item->'label') is distinct from 'string'
        or length(trim(coalesce(action_item->>'label', ''))) not between 1 and 120
        or action_item->>'id' <> btrim(action_item->>'id')
        or action_item->>'label' <> btrim(action_item->>'label')
        or jsonb_typeof(action_item->'timeoutMs') is distinct from 'number'
        or coalesce(action_item->>'timeoutMs', '') !~ '^[0-9]+$'
        or (action_item->>'timeoutMs')::integer not between 250 and 60000 then
        raise exception 'Journey draft contains an unsupported restricted action.' using errcode = '22023';
      end if;

      if action_type = 'navigate' then
        if action_item - array['id','label','timeoutMs','type','url']::text[] <> '{}'::jsonb
          or jsonb_typeof(action_item->'url') is distinct from 'string' then
          raise exception 'Navigate actions contain invalid fields.' using errcode = '22023';
        end if;
        action_hostname := lower(substring(action_item->>'url' from '^https://([^/:?#]+)'));
        if length(coalesce(action_item->>'url', '')) not between 1 and 2048
          or action_item->>'url' !~ '^https://[a-z0-9.-]+(?::[0-9]{1,5})?(?:[/?#]|$)[^[:space:]]*$'
          or action_item->>'url' ~ '^https://[^/?#]*@'
          or (
            substring(action_item->>'url' from '^https://[^/:?#]+:([0-9]+)(?:[/?#]|$)') is not null
            and (substring(action_item->>'url' from '^https://[^/:?#]+:([0-9]+)(?:[/?#]|$)'))::integer not between 1 and 65535
          )
          or action_hostname is null
          or (
            saved_authorization.id is not null
            and not public.hostname_is_covered_by_project_authorization(
              action_hostname, saved_authorization.hostname::text, saved_authorization.approved_action_domains
            )
          )
          or (saved_authorization.id is null and action_hostname <> start_hostname) then
          raise exception 'Navigate action targets a domain outside the owner attestation.' using errcode = '42501';
        end if;
      elsif action_type = 'fill' then
        if jsonb_typeof(action_item->'operation') is distinct from 'string' then
          raise exception 'Fill actions require an explicit supported operation.' using errcode = '22023';
        elsif action_item->>'operation' = 'text' then
          if action_item - array['id','label','timeoutMs','type','operation','locator','valueKey']::text[] <> '{}'::jsonb
            or not public.restricted_journey_locator_is_valid(action_item->'locator')
            or jsonb_typeof(action_item->'valueKey') is distinct from 'string'
            or action_item->>'valueKey' not in (
              'marker','first_name','last_name','full_name','name','email',
              'company','workspace','message','password','number','url'
            ) then
            raise exception 'Text fill actions require an approved non-contactable synthetic value key.' using errcode = '22023';
          end if;
        elsif action_item->>'operation' = 'select' then
          if action_item - array['id','label','timeoutMs','type','operation','locator','optionValue']::text[] <> '{}'::jsonb
            or not public.restricted_journey_locator_is_valid(action_item->'locator')
            or jsonb_typeof(action_item->'optionValue') is distinct from 'string'
            or length(action_item->>'optionValue') > 500 then
            raise exception 'Select actions require one approved published option.' using errcode = '22023';
          end if;
        elsif action_item->>'operation' = 'check' then
          if action_item - array['id','label','timeoutMs','type','operation','locator','expectedChecked','operatorApproved','controlKind','radioGroup']::text[] <> '{}'::jsonb
            or not public.restricted_journey_locator_is_valid(action_item->'locator')
            or action_item->'expectedChecked' is distinct from 'true'::jsonb
            or action_item->'operatorApproved' is distinct from 'true'::jsonb
            or action_item->>'controlKind' not in ('checkbox', 'radio')
            or (action_item->>'controlKind' = 'checkbox' and action_item ? 'radioGroup')
            or (action_item->>'controlKind' = 'radio' and (
              jsonb_typeof(action_item->'radioGroup') is distinct from 'string'
              or length(trim(coalesce(action_item->>'radioGroup', ''))) not between 1 and 200
            )) then
            raise exception 'Checked controls require explicit operator approval and one semantic control kind.' using errcode = '22023';
          end if;
          if action_item->>'controlKind' = 'radio' then
            if action_item->>'radioGroup' = any(selected_radio_groups) then
              raise exception 'Only one option may be published for each semantic radio group.' using errcode = '22023';
            end if;
            selected_radio_groups := array_append(selected_radio_groups, action_item->>'radioGroup');
          end if;
        else
          raise exception 'Fill actions support only text, select, or explicitly approved check operations.' using errcode = '22023';
        end if;
      elsif action_type in ('click', 'assert_visible') then
        if action_item - array['id','label','timeoutMs','type','locator']::text[] <> '{}'::jsonb
          or not public.restricted_journey_locator_is_valid(action_item->'locator') then
          raise exception 'Browser actions require an approved semantic locator.' using errcode = '22023';
        end if;
      elsif action_type = 'wait_for_url' then
        if action_item - array['id','label','timeoutMs','type','urlPattern']::text[] <> '{}'::jsonb
          or jsonb_typeof(action_item->'urlPattern') is distinct from 'string'
          or length(trim(coalesce(action_item->>'urlPattern', ''))) not between 1 and 500 then
          raise exception 'URL waits require a bounded URL pattern.' using errcode = '22023';
        end if;
      elsif action_type = 'wait_for_text' then
        if action_item - array['id','label','timeoutMs','type','text']::text[] <> '{}'::jsonb
          or jsonb_typeof(action_item->'text') is distinct from 'string'
          or length(trim(coalesce(action_item->>'text', ''))) not between 1 and 500 then
          raise exception 'Text waits require bounded expected text.' using errcode = '22023';
        end if;
      elsif action_type = 'wait_for_email' then
        if action_item - array['id','label','timeoutMs','type','recipientKey','proofMode','thresholdSeconds','maximumWaitSeconds']::text[] <> '{}'::jsonb
          or jsonb_typeof(action_item->'recipientKey') is distinct from 'string'
          or length(trim(coalesce(action_item->>'recipientKey', ''))) not between 1 and 80
          or (action_item ? 'proofMode' and jsonb_typeof(action_item->'proofMode') is distinct from 'string')
          or coalesce(action_item->>'proofMode', 'autoresponse') not in ('autoresponse', 'forwarded_marker')
          or (
            coalesce(action_item->>'proofMode', 'autoresponse') = 'autoresponse'
            and action_item->>'recipientKey' <> 'email'
          )
          or (
            action_item->>'proofMode' = 'forwarded_marker'
            and action_item->>'recipientKey' <> 'forwarding'
          )
          or jsonb_typeof(action_item->'thresholdSeconds') is distinct from 'number'
          or coalesce(action_item->>'thresholdSeconds', '') !~ '^[0-9]+$'
          or (action_item->>'thresholdSeconds')::integer not between 5 and 3600
          or (
            action_item ? 'maximumWaitSeconds'
            and (
              jsonb_typeof(action_item->'maximumWaitSeconds') is distinct from 'number'
              or coalesce(action_item->>'maximumWaitSeconds', '') !~ '^[0-9]+$'
              or (action_item->>'maximumWaitSeconds')::integer not between 5 and 3600
            )
          )
          or coalesce((action_item->>'maximumWaitSeconds')::integer, 600) < (action_item->>'thresholdSeconds')::integer then
          raise exception 'Email waits require a synthetic recipient key and safe threshold.' using errcode = '22023';
        end if;
      elsif action_type = 'open_email_link' then
        if action_item - array['id','label','timeoutMs','type','allowedHosts','linkRule']::text[] <> '{}'::jsonb
          or jsonb_typeof(action_item->'allowedHosts') <> 'array'
          or jsonb_array_length(action_item->'allowedHosts') not between 1 and 20
          or jsonb_typeof(action_item->'linkRule') is distinct from 'object'
          or (action_item->'linkRule') - array['host','pathPrefix','requiredText','requiredQueryParameter']::text[] <> '{}'::jsonb
          or jsonb_typeof(action_item#>'{linkRule,host}') is distinct from 'string'
          or action_item#>>'{linkRule,host}' <> lower(action_item#>>'{linkRule,host}')
          or jsonb_typeof(action_item#>'{linkRule,pathPrefix}') is distinct from 'string'
          or length(action_item#>>'{linkRule,pathPrefix}') not between 1 and 500
          or action_item#>>'{linkRule,pathPrefix}' !~ '^/[^?#]*$'
          or (
            (action_item->'linkRule') ? 'requiredText'
            and (
              jsonb_typeof(action_item#>'{linkRule,requiredText}') is distinct from 'string'
              or length(trim(action_item#>>'{linkRule,requiredText}')) not between 1 and 200
            )
          )
          or (
            (action_item->'linkRule') ? 'requiredQueryParameter'
            and (
              jsonb_typeof(action_item#>'{linkRule,requiredQueryParameter}') is distinct from 'string'
              or coalesce(action_item#>>'{linkRule,requiredQueryParameter}', '') !~ '^[A-Za-z0-9_.~-]{1,100}$'
            )
          )
          or not exists (
            select 1 from jsonb_array_elements_text(action_item->'allowedHosts') allowed_host(hostname)
            where action_item#>>'{linkRule,host}' = allowed_host.hostname
              or action_item#>>'{linkRule,host}' like '%.' || allowed_host.hostname
          )
          or not public.hostname_is_covered_by_project_authorization(
            action_item#>>'{linkRule,host}',
            saved_authorization.hostname::text,
            saved_authorization.approved_action_domains
          )
          or saved_authorization.id is null then
          raise exception 'Email-link actions require owner-approved hostnames.' using errcode = '42501';
        end if;
        for allowed_host_item in select value from jsonb_array_elements(action_item->'allowedHosts')
        loop
          if jsonb_typeof(allowed_host_item) <> 'string'
            or allowed_host_item #>> '{}' <> lower(allowed_host_item #>> '{}')
            or not public.hostname_is_covered_by_project_authorization(
              allowed_host_item #>> '{}',
              saved_authorization.hostname::text,
              saved_authorization.approved_action_domains
            ) then
            raise exception 'Email-link actions contain a hostname outside the owner attestation.' using errcode = '42501';
          end if;
        end loop;
      elsif action_type = 'cleanup' then
        if not stage_is_cleanup then
          raise exception 'Cleanup actions must be isolated in a cleanup stage.' using errcode = '22023';
        end if;
        if action_item->>'mode' = 'in_product' then
          if action_item - array['id','label','timeoutMs','type','mode','locator']::text[] <> '{}'::jsonb
            or not public.restricted_journey_locator_is_valid(action_item->'locator') then
            raise exception 'In-product cleanup requires an approved semantic locator.' using errcode = '22023';
          end if;
        elsif action_item->>'mode' = 'webhook' then
          if action_item - array['id','label','timeoutMs','type','mode','webhookUrl']::text[] <> '{}'::jsonb
            or jsonb_typeof(action_item->'webhookUrl') is distinct from 'string'
            or saved_authorization.id is null then
            raise exception 'Webhook cleanup requires an owner-approved HTTPS URL.' using errcode = '42501';
          end if;
          action_hostname := lower(substring(action_item->>'webhookUrl' from '^https://([^/:?#]+)'));
          if length(coalesce(action_item->>'webhookUrl', '')) not between 1 and 2048
            or action_item->>'webhookUrl' !~ '^https://[a-z0-9.-]+(?::[0-9]{1,5})?(?:[/?#]|$)[^[:space:]]*$'
            or action_item->>'webhookUrl' ~ '^https://[^/?#]*@'
            or (
              substring(action_item->>'webhookUrl' from '^https://[^/:?#]+:([0-9]+)(?:[/?#]|$)') is not null
              and (substring(action_item->>'webhookUrl' from '^https://[^/:?#]+:([0-9]+)(?:[/?#]|$)'))::integer not between 1 and 65535
            )
            or action_hostname is null
            or not public.hostname_is_covered_by_project_authorization(
              action_hostname, saved_authorization.hostname::text, saved_authorization.approved_action_domains
            ) then
            raise exception 'Cleanup webhook targets a domain outside the owner attestation.' using errcode = '42501';
          end if;
        else
          raise exception 'Cleanup actions must use in_product or webhook mode.' using errcode = '22023';
        end if;
        has_cleanup_stage := true;
      end if;

      if stage_is_cleanup and action_type not in ('cleanup', 'wait_for_url', 'wait_for_text', 'assert_visible') then
        raise exception 'Cleanup stages may contain only cleanup and deterministic confirmation actions.' using errcode = '22023';
      end if;
    end loop;
  end loop;

  if saved_workflow.journey_template in ('lead_form', 'trial_signup')
    and not public.restricted_journey_template_is_valid(
      saved_workflow.journey_template,
      saved_workflow.draft_definition_json
    ) then
    raise exception 'Journey draft does not satisfy the deterministic template contract.' using errcode = '22023';
  end if;

  if saved_workflow.journey_template = 'trial_signup' and not has_cleanup_stage then
    raise exception 'Trial-signup journeys require a cleanup stage using in_product or webhook mode.' using errcode = '22023';
  end if;

  select coalesce(max(v.version_number), 0) + 1 into next_version
  from public.journey_versions v where v.workflow_id = saved_workflow.id;

  insert into public.journey_versions (
    agency_id, workflow_id, authorization_id, version_number, template, start_url,
    definition_json, definition_hash, source, created_by_user_id
  ) values (
    saved_workflow.agency_id, saved_workflow.id, p_authorization_id, next_version,
    saved_workflow.journey_template, clean_start_url, saved_workflow.draft_definition_json,
    encode(digest(saved_workflow.draft_definition_json::text, 'sha256'), 'hex'),
    'published', p_created_by_user_id
  ) returning id into created_version_id;

  for stage_item in select value from jsonb_array_elements(saved_workflow.draft_definition_json->'stages')
  loop
    insert into public.journey_stage_definitions (
      agency_id, journey_version_id, position, stage_key, name, action_manifest_json,
      expected_text, business_impact, timing_threshold_ms, is_cleanup
    ) values (
      saved_workflow.agency_id, created_version_id,
      (stage_item->>'position')::integer,
      stage_item->>'key', stage_item->>'name',
      jsonb_build_object(
        'actions', stage_item->'actions',
        'required', coalesce((stage_item->>'required')::boolean, true)
      ),
      stage_item->>'expected',
      coalesce(stage_item->>'businessImpact', ''),
      case when nullif(stage_item->>'timingThresholdMs', '') is null then null else (stage_item->>'timingThresholdMs')::integer end,
      coalesce((stage_item->>'cleanup')::boolean, false)
    );
  end loop;

  update public.workflows set active_journey_version_id = created_version_id,
    draft_revision = draft_revision + 1,
    paused_at = case when pause_reason = 'cleanup_failed' then null else paused_at end,
    pause_reason = case when pause_reason = 'cleanup_failed' then '' else pause_reason end,
    updated_at = now()
  where id = saved_workflow.id and agency_id = saved_workflow.agency_id
    and draft_revision = p_expected_draft_revision;
  if not found then raise exception 'Journey draft changed while publishing.' using errcode = '40001'; end if;

  -- A schedule is proof-bound to the exact immutable version that passed its
  -- supervised run. Publishing invalidates that proof, so the same transaction
  -- moves any existing schedule to the new version and pauses it until a fresh
  -- supervised pass (and required cleanup) is recorded.
  update public.journey_schedules schedule set
    journey_version_id = created_version_id,
    enabled = false,
    supervised_run_id = null,
    cleanup_verified = false,
    paused_at = now(),
    pause_reason = 'new_version_requires_supervised_run',
    lease_expires_at = null,
    leased_by = null,
    updated_at = now()
  where schedule.workflow_id = saved_workflow.id
    and schedule.agency_id = saved_workflow.agency_id
    and schedule.journey_version_id is distinct from created_version_id;

  return query select created_version_id, next_version, p_expected_draft_revision + 1;
end;
$$;
create or replace function public.configure_journey_schedule(
  p_agency_id uuid,
  p_workflow_id uuid,
  p_expected_draft_revision integer,
  p_interval_minutes integer,
  p_enabled boolean,
  p_next_run_at timestamptz default null
)
returns setof public.journey_schedules
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_workflow public.workflows%rowtype;
  supervised public.eval_runs%rowtype;
  minimum_interval integer;
begin
  select * into saved_workflow from public.workflows
  where id = p_workflow_id and agency_id = p_agency_id and archived_at is null
  for update;
  if not found then raise exception 'Journey was not found.' using errcode = 'P0002'; end if;
  if saved_workflow.draft_revision <> p_expected_draft_revision then
    raise exception 'Journey draft changed in another session.' using errcode = '40001';
  end if;
  if saved_workflow.active_journey_version_id is null then
    raise exception 'Publish an immutable journey version before scheduling.' using errcode = '55000';
  end if;
  minimum_interval := case when saved_workflow.journey_template = 'trial_signup' then 360 else 60 end;
  if p_interval_minutes < minimum_interval then
    raise exception 'This journey template cannot run at the requested frequency.' using errcode = '22023';
  end if;

  select * into supervised from public.eval_runs r
  where r.agency_id = saved_workflow.agency_id and r.workflow_id = saved_workflow.id
    and r.journey_version_id = saved_workflow.active_journey_version_id
    and r.trigger_source = 'supervised' and r.status = 'finalized' and r.verdict = 'passed'
    and (saved_workflow.journey_template <> 'trial_signup' or r.cleanup_status = 'passed')
  order by r.completed_at desc nulls last, r.created_at desc limit 1;
  if p_enabled and not found then
    raise exception 'Scheduling is locked until a supervised run passes with required cleanup.' using errcode = '55000';
  end if;

  insert into public.journey_schedules (
    agency_id, workflow_id, journey_version_id, interval_minutes, enabled,
    next_run_at, supervised_run_id, cleanup_verified, paused_at, pause_reason
  ) values (
    saved_workflow.agency_id, saved_workflow.id, saved_workflow.active_journey_version_id,
    p_interval_minutes, p_enabled,
    coalesce(p_next_run_at, now() + make_interval(mins => p_interval_minutes)),
    supervised.id,
    supervised.id is not null and (saved_workflow.journey_template <> 'trial_signup' or supervised.cleanup_status = 'passed'),
    null, ''
  ) on conflict (workflow_id) do update set
    journey_version_id = excluded.journey_version_id,
    interval_minutes = excluded.interval_minutes,
    enabled = excluded.enabled,
    next_run_at = excluded.next_run_at,
    supervised_run_id = excluded.supervised_run_id,
    cleanup_verified = excluded.cleanup_verified,
    paused_at = null,
    pause_reason = '',
    updated_at = now();

  return query select * from public.journey_schedules s where s.workflow_id = saved_workflow.id;
end;
$$;

create or replace function public.pause_business_eval_journey_for_entitlement_loss(
  p_agency_id uuid,
  p_workflow_id uuid
)
returns table(journey_paused boolean, schedules_disabled integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_workflow public.workflows%rowtype;
  disabled_count integer := 0;
  paused_at_value timestamptz := now();
begin
  select * into saved_workflow from public.workflows
  where id = p_workflow_id and agency_id = p_agency_id and archived_at is null
  for update;
  if not found then raise exception 'Journey was not found.' using errcode = 'P0002'; end if;
  if saved_workflow.journey_template = 'legacy_endpoint' then
    raise exception 'Legacy endpoint journeys do not use Business Evals feature entitlements.' using errcode = '22023';
  end if;

  update public.workflows set
    paused_at = coalesce(paused_at, paused_at_value),
    pause_reason = case
      when pause_reason in ('cleanup_failed', 'project_authorization_changed', 'project_authorization_revoked') then pause_reason
      else 'entitlement_lost'
    end,
    updated_at = paused_at_value
  where id = saved_workflow.id and agency_id = saved_workflow.agency_id;

  update public.journey_schedules set
    enabled = false,
    paused_at = coalesce(paused_at, paused_at_value),
    pause_reason = case
      when pause_reason in ('cleanup_failed', 'project_authorization_changed', 'project_authorization_revoked') then pause_reason
      else 'entitlement_lost'
    end,
    lease_expires_at = null,
    leased_by = null,
    updated_at = paused_at_value
  where workflow_id = saved_workflow.id and agency_id = saved_workflow.agency_id;
  get diagnostics disabled_count = row_count;

  return query select true, disabled_count;
end;
$$;

create or replace function public.claim_due_journey_schedules(
  p_worker_id text,
  p_max_batch integer default 5,
  p_lease_seconds integer default 300
)
returns table(
  schedule_id uuid,
  agency_id uuid,
  workflow_id uuid,
  journey_version_id uuid,
  scheduled_for timestamptz,
  lease_expires_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select s.id
    from public.journey_schedules s
    join public.workflows w on w.id = s.workflow_id and w.agency_id = s.agency_id
    join public.clients c on c.id = w.client_id and c.agency_id = w.agency_id
    where s.enabled and s.paused_at is null and s.next_run_at <= now()
      and (s.lease_expires_at is null or s.lease_expires_at <= now())
      and c.archived_at is null
      and w.archived_at is null and w.paused_at is null
      and w.active_journey_version_id = s.journey_version_id
      and not exists (
        select 1 from public.eval_runs r
        where r.schedule_id = s.id and r.scheduled_for = s.next_run_at
      )
    order by s.next_run_at, s.created_at, s.id
    limit greatest(1, least(coalesce(p_max_batch, 5), 25))
    for update of s skip locked
  ), claimed as (
    update public.journey_schedules s set
      lease_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 300), 1800))),
      leased_by = p_worker_id,
      last_claimed_at = now(),
      updated_at = now()
    from due where s.id = due.id returning s.*
  )
  select c.id, c.agency_id, c.workflow_id, c.journey_version_id,
    c.next_run_at, c.lease_expires_at
  from claimed c order by c.next_run_at, c.id;
$$;

-- The enqueue RPC is service-only. It provides atomic idempotency and quota
-- accounting without coupling the database to mutable Stripe product metadata.
create or replace function public.get_business_eval_run_replay(
  p_agency_id uuid,
  p_idempotency_key text,
  p_workflow_id uuid,
  p_journey_version_id uuid,
  p_schedule_id uuid,
  p_trigger_source text,
  p_scheduled_for timestamptz,
  p_requested_by_user_id uuid,
  p_verification_issue_id uuid
)
returns table(eval_run_id uuid, quota_used integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_run public.eval_runs%rowtype;
  used_count integer;
begin
  if nullif(trim(p_idempotency_key), '') is null then
    raise exception 'An idempotency key is required.' using errcode = '22023';
  end if;

  select * into existing_run from public.eval_runs
  where agency_id = p_agency_id and idempotency_key = p_idempotency_key;
  if not found then return; end if;

  if existing_run.workflow_id is distinct from p_workflow_id
    or (p_journey_version_id is not null and existing_run.journey_version_id is distinct from p_journey_version_id)
    or existing_run.schedule_id is distinct from p_schedule_id
    or existing_run.trigger_source is distinct from p_trigger_source
    or existing_run.scheduled_for is distinct from p_scheduled_for
    or existing_run.requested_by_user_id is distinct from p_requested_by_user_id
    or existing_run.verification_issue_id is distinct from p_verification_issue_id then
    raise exception 'Idempotency key was reused with a different eval-run request.' using errcode = '22023';
  end if;

  select count(*)::integer into used_count from public.eval_runs
  where agency_id = p_agency_id and quota_counted
    and quota_period_start = date_trunc('month', now())::date;
  return query select existing_run.id, used_count;
end;
$$;

create or replace function public.enqueue_business_eval_run(
  p_agency_id uuid,
  p_workflow_id uuid,
  p_journey_version_id uuid,
  p_schedule_id uuid,
  p_trigger_source text,
  p_idempotency_key text,
  p_scheduled_for timestamptz,
  p_synthetic_marker text,
  p_monthly_limit integer,
  p_requested_by_user_id uuid default null,
  p_verification_issue_id uuid default null
)
returns table(eval_run_id uuid, enqueued boolean, quota_used integer, quota_limit integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_workflow public.workflows%rowtype;
  saved_version public.journey_versions%rowtype;
  existing_run public.eval_runs%rowtype;
  rate_result record;
  used_count integer;
  created_id uuid;
  effective_limit integer;
  destination_domain text;
begin
  if p_trigger_source not in ('manual', 'supervised', 'verification', 'debug', 'scheduled', 'api', 'legacy_backfill') then
    raise exception 'Unsupported eval trigger source.' using errcode = '22023';
  end if;
  if nullif(trim(p_idempotency_key), '') is null then
    raise exception 'An idempotency key is required.' using errcode = '22023';
  end if;
  if (p_trigger_source = 'verification') is distinct from (p_verification_issue_id is not null) then
    raise exception 'Verification runs require exactly one incident reference.' using errcode = '22023';
  end if;

  -- Serialize every workspace enqueue before idempotency and quota checks so
  -- simultaneous runs for different journeys cannot exceed the hard allowance.
  select p_monthly_limit
  into effective_limit from public.agencies a
  where a.id = p_agency_id
  for update;
  if not found then raise exception 'Workspace was not found.' using errcode = 'P0002'; end if;

  select * into existing_run from public.eval_runs
  where agency_id = p_agency_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_run.workflow_id is distinct from p_workflow_id
      or existing_run.journey_version_id is distinct from p_journey_version_id
      or existing_run.schedule_id is distinct from p_schedule_id
      or existing_run.trigger_source is distinct from p_trigger_source
      or existing_run.scheduled_for is distinct from p_scheduled_for
      or existing_run.requested_by_user_id is distinct from p_requested_by_user_id
      or existing_run.verification_issue_id is distinct from p_verification_issue_id then
      raise exception 'Idempotency key was reused with a different eval-run request.' using errcode = '22023';
    end if;
    select count(*)::integer into used_count from public.eval_runs
    where agency_id = p_agency_id and quota_counted and quota_period_start = date_trunc('month', now())::date;
    return query select existing_run.id, false, used_count, effective_limit;
    return;
  end if;

  select * into saved_workflow from public.workflows
  where id = p_workflow_id and agency_id = p_agency_id and archived_at is null
  for update;
  if not found or saved_workflow.paused_at is not null then
    raise exception 'Journey is missing, archived, or paused.' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.clients c
    where c.id = saved_workflow.client_id and c.agency_id = saved_workflow.agency_id
      and c.archived_at is null
  ) then
    raise exception 'Project is archived.' using errcode = '55000';
  end if;
  if saved_workflow.journey_template = 'legacy_endpoint' then
    raise exception 'Legacy endpoint journeys must run through the deterministic endpoint monitor.' using errcode = '55000';
  end if;
  if saved_workflow.active_journey_version_id is distinct from p_journey_version_id then
    raise exception 'Only the active immutable journey version can be enqueued.' using errcode = '22023';
  end if;
  select * into saved_version from public.journey_versions v
  where v.id = p_journey_version_id and v.agency_id = saved_workflow.agency_id
    and v.workflow_id = saved_workflow.id and v.template = saved_workflow.journey_template;
  if not found then
    raise exception 'Journey version template does not match the journey contract.' using errcode = '22023';
  end if;
  if p_verification_issue_id is not null and not exists (
    select 1 from public.issues i
    where i.id = p_verification_issue_id and i.agency_id = p_agency_id
      and i.client_id = saved_workflow.client_id and i.workflow_id = saved_workflow.id
      and i.status = 'in_review'::public.issue_status
      and i.repair_recorded_at is not null and btrim(i.resolution_note) <> ''
      and (not i.reportable or btrim(i.report_safe_summary) <> '')
  ) then
    raise exception 'Verification incident is not ready for a recovery eval.' using errcode = '55000';
  end if;

  select * into rate_result from public.consume_business_eval_rate_limit(
    'user',
    encode(digest('business-evals:user:' || lower(coalesce(p_requested_by_user_id::text, 'scheduler:' || p_agency_id::text)), 'sha256'), 'hex'),
    30,
    60
  );
  if not rate_result.allowed then
    raise exception 'Business-eval user rate limit reached until %.', rate_result.reset_at using errcode = 'P0001';
  end if;
  select * into rate_result from public.consume_business_eval_rate_limit(
    'workspace',
    encode(digest('business-evals:workspace:' || lower(p_agency_id::text), 'sha256'), 'hex'),
    120,
    60
  );
  if not rate_result.allowed then
    raise exception 'Business-eval workspace rate limit reached until %.', rate_result.reset_at using errcode = 'P0001';
  end if;
  select * into rate_result from public.consume_business_eval_rate_limit(
    'project',
    encode(digest('business-evals:project:' || lower(saved_workflow.client_id::text), 'sha256'), 'hex'),
    40,
    60
  );
  if not rate_result.allowed then
    raise exception 'Business-eval project rate limit reached until %.', rate_result.reset_at using errcode = 'P0001';
  end if;
  -- Charge every immutable, explicitly configured destination. Dynamic form
  -- actions and signed email redirects are charged again at the network guard
  -- when their actual host is known.
  for destination_domain in
    select distinct lower(destination.host)
    from (
      select substring(saved_version.start_url from '^https://([^/:?#]+)') as host
      union all
      select case
        when action->>'type' = 'navigate'
          then substring(action->>'url' from '^https://([^/:?#]+)')
        when action->>'type' = 'cleanup' and action->>'mode' = 'webhook'
          then substring(action->>'webhookUrl' from '^https://([^/:?#]+)')
        when action->>'type' = 'open_email_link'
          then action#>>'{linkRule,host}'
        else null
      end
      from public.journey_stage_definitions stage
      cross join lateral jsonb_array_elements(coalesce(stage.action_manifest_json->'actions', '[]'::jsonb)) action
      where stage.agency_id = saved_workflow.agency_id
        and stage.journey_version_id = saved_version.id
    ) destination
    where nullif(trim(destination.host), '') is not null
  loop
    select * into rate_result from public.consume_business_eval_rate_limit(
      'destination_domain',
      encode(digest('business-evals:destination_domain:' || destination_domain, 'sha256'), 'hex'),
      20,
      60
    );
    if not rate_result.allowed then
      raise exception 'Business-eval destination domain rate limit reached until %.', rate_result.reset_at using errcode = 'P0001';
    end if;
  end loop;

  select count(*)::integer into used_count from public.eval_runs
  where agency_id = p_agency_id and quota_counted and quota_period_start = date_trunc('month', now())::date;
  if effective_limit is not null and effective_limit >= 0 and used_count >= effective_limit then
    raise exception 'Monthly business-eval run quota reached.' using errcode = 'P0001';
  end if;

  insert into public.eval_runs (
    agency_id, client_id, workflow_id, journey_version_id, schedule_id, verification_issue_id,
    trigger_source, idempotency_key, scheduled_for, requested_by_user_id,
    synthetic_marker, quota_period_start
  ) values (
    p_agency_id, saved_workflow.client_id, saved_workflow.id, p_journey_version_id, p_schedule_id, p_verification_issue_id,
    p_trigger_source, p_idempotency_key, p_scheduled_for, p_requested_by_user_id,
    p_synthetic_marker, date_trunc('month', now())::date
  ) returning id into created_id;

  return query select created_id, true, used_count + 1, effective_limit;
end;
$$;

create or replace function public.claim_eval_run_for_dispatch(
  p_agency_id uuid,
  p_eval_run_id uuid,
  p_worker_id text,
  p_lease_seconds integer
)
returns table(eval_run_id uuid, agency_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_run public.eval_runs%rowtype;
  is_new_attempt boolean;
begin
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'A dispatch worker identifier is required.' using errcode = '22023';
  end if;
  select * into saved_run from public.eval_runs r
  where r.id = p_eval_run_id and r.agency_id = p_agency_id
  for update;
  if not found then raise exception 'Eval run was not found.' using errcode = 'P0002'; end if;
  if saved_run.status not in ('queued', 'claimed', 'running')
    or saved_run.orchestration_run_id <> ''
    or (saved_run.scheduled_for is not null and saved_run.scheduled_for > now()) then
    raise exception 'Eval run is not eligible for workflow dispatch.' using errcode = '55000';
  end if;
  if saved_run.dispatch_state = 'dispatched' then
    raise exception 'Eval run is already marked as dispatched.' using errcode = '55000';
  end if;
  if saved_run.dispatch_state = 'dispatching'
    and saved_run.dispatch_lease_expires_at > now()
    and saved_run.dispatch_worker_id <> trim(p_worker_id) then
    raise exception 'Eval run is leased by another dispatch worker.' using errcode = '55P03';
  end if;

  is_new_attempt := saved_run.dispatch_state = 'pending'
    or saved_run.dispatch_lease_expires_at is null
    or saved_run.dispatch_lease_expires_at <= now();
  update public.eval_runs r
  set dispatch_state = 'dispatching',
      dispatch_worker_id = trim(p_worker_id),
      dispatch_lease_expires_at = now() + make_interval(
        secs => greatest(30, least(coalesce(p_lease_seconds, 300), 1800))
      ),
      dispatch_attempts = r.dispatch_attempts + case when is_new_attempt then 1 else 0 end,
      updated_at = now()
  where r.id = saved_run.id;
  return query select saved_run.id, saved_run.agency_id;
end;
$$;

create or replace function public.claim_eval_runs_for_dispatch(
  p_worker_id text,
  p_max_batch integer default 5,
  p_lease_seconds integer default 300
)
returns table(eval_run_id uuid, agency_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'A dispatch worker identifier is required.' using errcode = '22023';
  end if;
  return query
  with due as (
    select r.id
    from public.eval_runs r
    where r.status in ('queued', 'claimed', 'running')
      and r.orchestration_run_id = ''
      and (r.scheduled_for is null or r.scheduled_for <= now())
      and (
        r.dispatch_state = 'pending'
        or (
          r.dispatch_state = 'dispatching'
          and (r.dispatch_lease_expires_at is null or r.dispatch_lease_expires_at <= now())
        )
      )
    order by coalesce(r.scheduled_for, r.created_at), r.created_at, r.id
    limit greatest(1, least(coalesce(p_max_batch, 5), 25))
    for update skip locked
  ), claimed as (
    update public.eval_runs r
    set dispatch_state = 'dispatching',
        dispatch_worker_id = trim(p_worker_id),
        dispatch_lease_expires_at = now() + make_interval(
          secs => greatest(30, least(coalesce(p_lease_seconds, 300), 1800))
        ),
        dispatch_attempts = r.dispatch_attempts + 1,
        updated_at = now()
    from due
    where r.id = due.id
    returning r.id, r.agency_id
  )
  select claimed.id, claimed.agency_id from claimed;
end;
$$;

create or replace function public.attach_eval_workflow_run(
  p_agency_id uuid,
  p_eval_run_id uuid,
  p_dispatch_worker_id text,
  p_orchestration_run_id text
)
returns table(eval_run_id uuid, orchestration_run_id text, attached boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_run public.eval_runs%rowtype;
begin
  if nullif(trim(p_dispatch_worker_id), '') is null
    or nullif(trim(p_orchestration_run_id), '') is null then
    raise exception 'Dispatch worker and orchestration run identifiers are required.' using errcode = '22023';
  end if;
  select * into saved_run from public.eval_runs r
  where r.id = p_eval_run_id and r.agency_id = p_agency_id
  for update;
  if not found then raise exception 'Eval run was not found.' using errcode = 'P0002'; end if;

  if saved_run.orchestration_run_id = trim(p_orchestration_run_id) then
    update public.eval_runs r
    set dispatch_state = 'dispatched', dispatch_worker_id = '',
        dispatch_lease_expires_at = null, updated_at = now()
    where r.id = saved_run.id;
    return query select saved_run.id, trim(p_orchestration_run_id), false;
    return;
  end if;
  if saved_run.orchestration_run_id <> '' then
    raise exception 'Eval run is already attached to another orchestration run.' using errcode = '23505';
  end if;
  if saved_run.status in ('finalized', 'cancelled')
    or saved_run.dispatch_state <> 'dispatching'
    or saved_run.dispatch_worker_id <> trim(p_dispatch_worker_id) then
    raise exception 'Eval run is not leased by this dispatch worker.' using errcode = '55000';
  end if;

  update public.eval_runs r
  set orchestration_run_id = trim(p_orchestration_run_id),
      dispatch_state = 'dispatched',
      dispatch_worker_id = '',
      dispatch_lease_expires_at = null,
      updated_at = now()
  where r.id = saved_run.id;
  return query select saved_run.id, trim(p_orchestration_run_id), true;
end;
$$;

create or replace function public.release_eval_run_dispatch_lease(
  p_agency_id uuid,
  p_eval_run_id uuid,
  p_dispatch_worker_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  released boolean;
begin
  update public.eval_runs r
  set dispatch_state = 'pending', dispatch_worker_id = '',
      dispatch_lease_expires_at = null, updated_at = now()
  where r.id = p_eval_run_id and r.agency_id = p_agency_id
    and r.orchestration_run_id = ''
    and r.status in ('queued', 'claimed', 'running')
    and r.dispatch_state = 'dispatching'
    and r.dispatch_worker_id = trim(coalesce(p_dispatch_worker_id, ''));
  released := found;
  return released;
end;
$$;

create or replace function public.cancel_business_eval_run_before_execution(
  p_agency_id uuid,
  p_eval_run_id uuid,
  p_dispatch_worker_id text,
  p_reason text default 'The business-evals runner was paused before execution.'
)
returns table(eval_run_id uuid, final_verdict text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_run public.eval_runs%rowtype;
  stopped_at timestamptz := now();
begin
  select * into saved_run
  from public.eval_runs r
  where r.id = p_eval_run_id and r.agency_id = p_agency_id
  for update;
  if not found then raise exception 'Eval run was not found.' using errcode = 'P0002'; end if;
  if saved_run.status not in ('queued', 'claimed', 'running')
    or saved_run.orchestration_run_id <> ''
    or saved_run.dispatch_state <> 'dispatching'
    or saved_run.dispatch_worker_id <> trim(coalesce(p_dispatch_worker_id, '')) then
    raise exception 'Eval run is not held by this pre-execution dispatch worker.' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.eval_run_side_effect_attempts attempt
    where attempt.eval_run_id = saved_run.id
  ) then
    raise exception 'A side-effect attempt already exists; pre-execution cancellation is unsafe.' using errcode = '55000';
  end if;

  insert into public.eval_stage_runs (
    agency_id, eval_run_id, stage_definition_id, position, status, verdict,
    expected_text, observed_text, error_code, diagnostics_json,
    assertion_results_json, evidence_artifact_ids, started_at, completed_at, duration_ms
  )
  with ordered as (
    select stage.*, row_number() over (order by stage.is_cleanup, stage.position, stage.id) as ordinal
    from public.journey_stage_definitions stage
    where stage.agency_id = saved_run.agency_id
      and stage.journey_version_id = saved_run.journey_version_id
  ), results as (
    select ordered.*,
      case when ordered.ordinal = 1 then 'cancelled' else 'not_run' end as stage_verdict,
      case when ordered.ordinal = 1
        then 'The global runner safety control stopped this queued run before any browser side effect.'
        else 'The stage was not reached because execution was stopped before dispatch.'
      end as observation
    from ordered
  )
  select
    saved_run.agency_id, saved_run.id, results.id, results.position,
    case when results.stage_verdict = 'cancelled' then 'cancelled' else 'not_run' end,
    results.stage_verdict, results.expected_text, results.observation,
    case when results.stage_verdict = 'cancelled' then 'RUNNER_PAUSED' else '' end,
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'assertionId', 'stage:' || results.id::text,
      'required', true,
      'expectedRule', results.expected_text,
      'safeObservation', results.observation,
      'observationDigest', encode(digest(results.observation, 'sha256'), 'hex'),
      'result', results.stage_verdict,
      'evaluatedAt', stopped_at,
      'evaluatorVersion', 'maintain-flow-business-evals-v1'
    )),
    '{}'::uuid[], stopped_at, stopped_at, 0
  from results
  order by results.position;
  if not found then
    raise exception 'Eval run has no immutable stages to terminalize.' using errcode = '55000';
  end if;

  update public.eval_runs r set
    status = 'cancelled',
    verdict = 'cancelled',
    summary = left(coalesce(nullif(trim(p_reason), ''), 'The business-evals runner was paused before execution.'), 2000),
    cleanup_status = 'skipped',
    cleanup_error_summary = '',
    quota_counted = false,
    completed_at = stopped_at,
    duration_ms = 0,
    dispatch_state = 'pending',
    dispatch_worker_id = '',
    dispatch_lease_expires_at = null,
    worker_id = '',
    lease_expires_at = null,
    updated_at = stopped_at
  where r.id = saved_run.id;

  if saved_run.schedule_id is not null then
    update public.journey_schedules schedule set
      last_run_at = stopped_at,
      next_run_at = stopped_at + make_interval(mins => schedule.interval_minutes),
      lease_expires_at = null,
      leased_by = null,
      updated_at = stopped_at
    where schedule.id = saved_run.schedule_id
      and schedule.agency_id = saved_run.agency_id
      and schedule.journey_version_id = saved_run.journey_version_id;
  end if;

  return query select saved_run.id, 'cancelled'::text;
end;
$$;

create or replace function public.claim_due_business_eval_runs(
  p_worker_id text,
  p_max_batch integer default 5,
  p_lease_seconds integer default 300
)
returns table(
  eval_run_id uuid,
  agency_id uuid,
  client_id uuid,
  workflow_id uuid,
  journey_version_id uuid,
  schedule_id uuid,
  journey_template text,
  start_url text,
  definition_json jsonb,
  synthetic_marker text,
  cancel_requested_at timestamptz,
  cancel_requested_by_user_id uuid
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select r.id
    from public.eval_runs r
    where r.status = 'queued'
      and (r.scheduled_for is null or r.scheduled_for <= now())
      and (r.lease_expires_at is null or r.lease_expires_at <= now())
    order by coalesce(r.scheduled_for, r.created_at), r.created_at, r.id
    limit greatest(1, least(coalesce(p_max_batch, 5), 25))
    for update skip locked
  ), claimed as (
    update public.eval_runs r
    set status = 'claimed', worker_id = p_worker_id,
        claimed_at = now(), started_at = coalesce(r.started_at, now()),
        lease_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 300), 1800))),
        updated_at = now()
    from due where r.id = due.id returning r.*
  )
  select c.id, c.agency_id, c.client_id, c.workflow_id, c.journey_version_id,
         c.schedule_id, v.template, v.start_url, v.definition_json, c.synthetic_marker,
         c.cancel_requested_at, c.cancel_requested_by_user_id
  from claimed c join public.journey_versions v on v.id = c.journey_version_id and v.agency_id = c.agency_id;
$$;

create or replace function public.claim_business_eval_run(
  p_eval_run_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 1800
)
returns table(
  eval_run_id uuid,
  agency_id uuid,
  client_id uuid,
  workflow_id uuid,
  journey_version_id uuid,
  schedule_id uuid,
  journey_template text,
  start_url text,
  definition_json jsonb,
  synthetic_marker text,
  cancel_requested_at timestamptz,
  cancel_requested_by_user_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_run public.eval_runs%rowtype;
begin
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'A worker id is required.' using errcode = '22023';
  end if;
  select * into saved_run from public.eval_runs where id = p_eval_run_id for update;
  if not found then raise exception 'Eval run was not found.' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.journey_versions v
    join public.workflows w on w.id = v.workflow_id and w.agency_id = v.agency_id
    where v.id = saved_run.journey_version_id and v.agency_id = saved_run.agency_id
      and w.id = saved_run.workflow_id and v.template = w.journey_template
      and w.active_journey_version_id = v.id
  ) then
    raise exception 'Eval run references a mismatched or inactive journey version.' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.journey_stage_definitions s
    where s.journey_version_id = saved_run.journey_version_id
      and s.agency_id = saved_run.agency_id
  ) then
    raise exception 'Eval run references a journey version without immutable stages.' using errcode = '55000';
  end if;
  if saved_run.status in ('finalized', 'cancelled') then
    raise exception 'Eval run is already terminal.' using errcode = '55000';
  end if;
  if saved_run.worker_id <> '' and saved_run.worker_id <> p_worker_id
    and saved_run.lease_expires_at is not null and saved_run.lease_expires_at > now() then
    raise exception 'Eval run has a live lease held by another worker.' using errcode = '55P03';
  end if;

  update public.eval_runs set
    status = case when status = 'queued' then 'claimed' else status end,
    worker_id = p_worker_id,
    claimed_at = coalesce(claimed_at, now()),
    started_at = coalesce(started_at, now()),
    lease_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 1800), 7200))),
    updated_at = now()
  where id = saved_run.id;

  return query
  select r.id, r.agency_id, r.client_id, r.workflow_id, r.journey_version_id,
         r.schedule_id, v.template, v.start_url, v.definition_json, r.synthetic_marker,
         r.cancel_requested_at, r.cancel_requested_by_user_id
  from public.eval_runs r
  join public.journey_versions v on v.id = r.journey_version_id and v.agency_id = r.agency_id
  where r.id = saved_run.id;
end;
$$;

create or replace function public.heartbeat_business_eval_run(
  p_eval_run_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 1800
)
returns table(eval_run_id uuid, lease_expires_at timestamptz, cancel_requested_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.eval_runs r set
    lease_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 1800), 7200))),
    updated_at = now()
  where r.id = p_eval_run_id and r.worker_id = p_worker_id
    and r.status in ('claimed', 'running')
  returning r.id, r.lease_expires_at, r.cancel_requested_at;
  if not found then raise exception 'Eval run heartbeat was rejected.' using errcode = '55000'; end if;
end;
$$;

create or replace function public.begin_eval_run_side_effect_phase(
  p_eval_run_id uuid,
  p_phase_key text,
  p_worker_id text
)
returns table(may_execute boolean, prior_state text, prior_started_at timestamptz, prior_completed_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_run public.eval_runs%rowtype;
  saved_attempt public.eval_run_side_effect_attempts%rowtype;
begin
  if length(trim(coalesce(p_phase_key, ''))) not between 12 and 128 then
    raise exception 'A stable side-effect phase key is required.' using errcode = '22023';
  end if;
  if nullif(trim(p_worker_id), '') is null then
    raise exception 'A side-effect worker id is required.' using errcode = '22023';
  end if;

  select * into saved_run from public.eval_runs r
  where r.id = p_eval_run_id
  for update;
  if not found then raise exception 'Eval run was not found.' using errcode = 'P0002'; end if;
  if saved_run.status not in ('claimed', 'running')
    or saved_run.worker_id <> trim(p_worker_id)
    or saved_run.lease_expires_at is null
    or saved_run.lease_expires_at <= now() then
    raise exception 'Eval run does not hold the required live worker lease.' using errcode = '55000';
  end if;

  insert into public.eval_run_side_effect_attempts (
    agency_id, eval_run_id, phase_key, state, worker_id
  ) values (
    saved_run.agency_id, saved_run.id, trim(p_phase_key), 'started', trim(p_worker_id)
  )
  on conflict (eval_run_id, phase_key) do nothing
  returning * into saved_attempt;

  if found then
    return query select true, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select * into saved_attempt from public.eval_run_side_effect_attempts a
  where a.eval_run_id = saved_run.id and a.phase_key = trim(p_phase_key);
  return query select false, saved_attempt.state, saved_attempt.started_at, saved_attempt.completed_at;
end;
$$;

create or replace function public.complete_eval_run_side_effect_phase(
  p_eval_run_id uuid,
  p_phase_key text,
  p_worker_id text
)
returns table(side_effect_attempt_id uuid, completed_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.eval_run_side_effect_attempts a
  set state = 'completed', completed_at = now(), updated_at = now()
  from public.eval_runs r
  where a.eval_run_id = p_eval_run_id
    and a.phase_key = trim(p_phase_key)
    and a.state = 'started'
    and r.id = a.eval_run_id
    and r.worker_id = trim(p_worker_id)
    and r.status in ('claimed', 'running')
  returning a.id, a.completed_at;
  if not found then
    raise exception 'The side-effect phase could not be completed.' using errcode = '55000';
  end if;
end;
$$;

create or replace function public.complete_eval_run_side_effect_phase_at(
  p_eval_run_id uuid,
  p_phase_key text,
  p_worker_id text,
  p_completed_at timestamptz
)
returns table(side_effect_attempt_id uuid, completed_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_completed_at is null or p_completed_at > clock_timestamp() + interval '30 seconds' then
    raise exception 'The side-effect completion time is invalid.' using errcode = '22023';
  end if;
  return query
  update public.eval_run_side_effect_attempts a
  set state = 'completed', completed_at = greatest(p_completed_at, a.started_at), updated_at = now()
  from public.eval_runs r
  where a.eval_run_id = p_eval_run_id
    and a.phase_key = trim(p_phase_key)
    and a.state = 'started'
    and r.id = a.eval_run_id
    and r.worker_id = trim(p_worker_id)
    and r.status in ('claimed', 'running')
  returning a.id, a.completed_at;
  if not found then
    raise exception 'The side-effect phase completion time could not be persisted.' using errcode = '55000';
  end if;
end;
$$;

create or replace function public.claim_business_eval_ai_request(
  p_request_id uuid,
  p_agency_id uuid,
  p_project_id uuid,
  p_workflow_id uuid,
  p_eval_run_id uuid,
  p_legacy_check_run_id uuid,
  p_actor_user_id uuid,
  p_kind text,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_model text,
  p_reasoning_effort text
)
returns table(
  request_id uuid,
  request_status text,
  claimed boolean,
  output_json jsonb,
  error_code text,
  provider_response_id text,
  usage_json jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_request public.ai_assistance_requests%rowtype;
  saved_request public.ai_assistance_requests%rowtype;
begin
  if p_kind not in ('journey_draft', 'run_diagnosis') then
    raise exception 'Unsupported AI-assistance request kind.' using errcode = '22023';
  end if;
  if p_reasoning_effort not in ('low', 'medium') or nullif(trim(p_model), '') is null then
    raise exception 'Invalid AI-assistance model configuration.' using errcode = '22023';
  end if;
  if p_idempotency_key_hash !~ '^[a-f0-9]{64}$' or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Hashed AI-assistance request keys are required.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships membership
    where membership.agency_id = p_agency_id and membership.user_id = p_actor_user_id
  ) then
    raise exception 'AI-assistance actor is not a workspace member.' using errcode = '42501';
  end if;

  perform 1 from public.agencies agency where agency.id = p_agency_id for update;
  if not found then
    raise exception 'Workspace not found.' using errcode = 'P0002';
  end if;

  select request.* into existing_request
  from public.ai_assistance_requests request
  where request.agency_id = p_agency_id
    and request.idempotency_key_hash = p_idempotency_key_hash
  for update;

  if found then
    if existing_request.request_hash <> p_request_hash
      or existing_request.project_id <> p_project_id
      or existing_request.workflow_id is distinct from p_workflow_id
      or existing_request.eval_run_id is distinct from p_eval_run_id
      or existing_request.legacy_check_run_id is distinct from p_legacy_check_run_id
      or existing_request.actor_user_id <> p_actor_user_id
      or existing_request.request_kind <> p_kind
      or existing_request.model <> trim(p_model)
      or existing_request.reasoning_effort <> p_reasoning_effort then
      raise exception 'AI_IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
    end if;

    if existing_request.status in ('completed', 'refused') then
      return query select existing_request.id, existing_request.status, false,
        existing_request.output_json, existing_request.error_code,
        existing_request.provider_response_id, existing_request.usage_json;
      return;
    end if;
    if existing_request.status = 'processing'
      and existing_request.updated_at > now() - interval '2 minutes' then
      return query select existing_request.id, existing_request.status, false,
        existing_request.output_json, existing_request.error_code,
        existing_request.provider_response_id, existing_request.usage_json;
      return;
    end if;

    update public.ai_assistance_requests request
    set status = 'processing', output_json = '{}'::jsonb, usage_json = '{}'::jsonb,
        provider_response_id = '', error_code = '', completed_at = null,
        attempt_count = request.attempt_count + 1, updated_at = now()
    where request.id = existing_request.id and request.agency_id = p_agency_id
    returning request.* into saved_request;
    return query select saved_request.id, saved_request.status, true,
      saved_request.output_json, saved_request.error_code,
      saved_request.provider_response_id, saved_request.usage_json;
    return;
  end if;

  insert into public.ai_assistance_requests (
    id, agency_id, project_id, workflow_id, eval_run_id, legacy_check_run_id,
    actor_user_id, request_kind, status, idempotency_key_hash, request_hash,
    model, reasoning_effort
  ) values (
    p_request_id, p_agency_id, p_project_id, p_workflow_id, p_eval_run_id,
    p_legacy_check_run_id, p_actor_user_id, p_kind, 'processing',
    p_idempotency_key_hash, p_request_hash, trim(p_model), p_reasoning_effort
  ) returning * into saved_request;

  return query select saved_request.id, saved_request.status, true,
    saved_request.output_json, saved_request.error_code,
    saved_request.provider_response_id, saved_request.usage_json;
end;
$$;

create or replace function public.finish_business_eval_ai_request(
  p_agency_id uuid,
  p_request_id uuid,
  p_actor_user_id uuid,
  p_status text,
  p_output_json jsonb,
  p_provider_response_id text,
  p_usage_json jsonb,
  p_error_code text
)
returns table(request_id uuid, request_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_request public.ai_assistance_requests%rowtype;
begin
  if p_status not in ('completed', 'refused', 'failed') then
    raise exception 'Invalid terminal AI-assistance status.' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_output_json, '{}'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_usage_json, '{}'::jsonb)) <> 'object' then
    raise exception 'AI-assistance output and usage must be JSON objects.' using errcode = '22023';
  end if;

  select request.* into saved_request
  from public.ai_assistance_requests request
  where request.id = p_request_id and request.agency_id = p_agency_id
    and request.actor_user_id = p_actor_user_id
  for update;
  if not found then
    raise exception 'AI-assistance request not found.' using errcode = 'P0002';
  end if;

  if saved_request.status <> 'processing' then
    if saved_request.status = p_status
      and saved_request.output_json = coalesce(p_output_json, '{}'::jsonb)
      and saved_request.provider_response_id = left(coalesce(p_provider_response_id, ''), 200)
      and saved_request.error_code = left(coalesce(p_error_code, ''), 120) then
      return query select saved_request.id, saved_request.status;
      return;
    end if;
    raise exception 'AI-assistance request was already finalized differently.' using errcode = '55000';
  end if;

  update public.ai_assistance_requests request
  set status = p_status,
      output_json = coalesce(p_output_json, '{}'::jsonb),
      usage_json = coalesce(p_usage_json, '{}'::jsonb),
      provider_response_id = left(coalesce(p_provider_response_id, ''), 200),
      error_code = left(coalesce(p_error_code, ''), 120),
      completed_at = now(),
      updated_at = now()
  where request.id = p_request_id and request.agency_id = p_agency_id
  returning request.* into saved_request;

  insert into public.audit_events(
    agency_id, actor_user_id, entity_type, entity_id, action, metadata_json
  ) values (
    saved_request.agency_id, saved_request.actor_user_id,
    'ai_assistance_request', saved_request.id, 'ai_assistance_request_finalized',
    jsonb_build_object(
      'requestKind', saved_request.request_kind,
      'status', saved_request.status,
      'model', saved_request.model,
      'reasoningEffort', saved_request.reasoning_effort,
      'attemptCount', saved_request.attempt_count,
      'providerResponseId', saved_request.provider_response_id,
      'usage', saved_request.usage_json,
      'errorCode', saved_request.error_code
    )
  );
  return query select saved_request.id, saved_request.status;
end;
$$;

create or replace function public.consume_business_eval_rate_limit(
  p_scope_type text,
  p_scope_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table(allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  bucket_start timestamptz;
  bucket_reset timestamptz;
  consumed_count integer;
begin
  if p_scope_type not in ('user', 'workspace', 'project', 'destination_domain', 'ai_user', 'ai_workspace', 'ai_project') then
    raise exception 'Unsupported business-eval rate-limit scope.' using errcode = '22023';
  end if;
  if p_scope_key_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'A hashed business-eval rate-limit key is required.' using errcode = '22023';
  end if;
  if p_limit not between 1 and 100000 or p_window_seconds not between 1 and 86400 then
    raise exception 'Business-eval rate-limit configuration is invalid.' using errcode = '22023';
  end if;

  bucket_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
  bucket_reset := bucket_start + make_interval(secs => p_window_seconds);

  insert into public.eval_rate_limit_buckets (
    scope_type, scope_key_hash, window_started_at, request_count
  ) values (
    p_scope_type, p_scope_key_hash, bucket_start, 1
  )
  on conflict (scope_type, scope_key_hash, window_started_at) do update
  set request_count = public.eval_rate_limit_buckets.request_count + 1,
      updated_at = now()
  returning request_count into consumed_count;

  return query select
    consumed_count <= p_limit,
    greatest(p_limit - consumed_count, 0),
    bucket_reset;
end;
$$;

create or replace function public.get_business_eval_project_summaries(
  p_agency_id uuid,
  p_project_ids uuid[]
)
returns table(
  project_id uuid,
  active_journeys integer,
  legacy_endpoint_journeys integer,
  business_eval_journeys integer,
  open_incidents integer,
  has_critical_incident boolean,
  has_failed_journey boolean,
  has_degraded_journey boolean,
  has_healthy_journey boolean,
  latest_eval_verdict text,
  latest_eval_started_at timestamptz,
  latest_legacy_started_at timestamptz,
  latest_report_status text,
  latest_report_created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with requested as (
    select distinct project.id
    from unnest(coalesce(p_project_ids, '{}'::uuid[])) requested_id(id)
    join public.clients project
      on project.id = requested_id.id
      and project.agency_id = p_agency_id
    where cardinality(p_project_ids) between 1 and 100
  ), journey_aggregate as (
    select
      journey.client_id as project_id,
      count(*)::integer as active_journeys,
      count(*) filter (where journey.journey_template = 'legacy_endpoint')::integer as legacy_endpoint_journeys,
      count(*) filter (where journey.journey_template <> 'legacy_endpoint')::integer as business_eval_journeys,
      bool_or(journey.status = 'failed'::public.workflow_status) as has_failed_journey,
      bool_or(journey.status = 'degraded'::public.workflow_status) as has_degraded_journey,
      bool_or(journey.status = 'healthy'::public.workflow_status) as has_healthy_journey,
      max(journey.last_check_run_at) filter (where journey.journey_template = 'legacy_endpoint') as latest_legacy_started_at
    from public.workflows journey
    join requested on requested.id = journey.client_id
    where journey.agency_id = p_agency_id and journey.archived_at is null
    group by journey.client_id
  ), incident_aggregate as (
    select
      incident.client_id as project_id,
      count(*)::integer as open_incidents,
      bool_or(incident.severity in ('high'::public.issue_severity, 'critical'::public.issue_severity)) as has_critical_incident
    from public.issues incident
    join requested on requested.id = incident.client_id
    where incident.agency_id = p_agency_id
      and incident.status in ('open'::public.issue_status, 'in_review'::public.issue_status, 'snoozed'::public.issue_status)
    group by incident.client_id
  ), ranked_runs as (
    select
      run.client_id as project_id,
      run.verdict,
      coalesce(run.started_at, run.created_at) as effective_started_at,
      row_number() over (
        partition by run.client_id
        order by coalesce(run.started_at, run.created_at) desc, run.id desc
      ) as position
    from public.eval_runs run
    join requested on requested.id = run.client_id
    where run.agency_id = p_agency_id
  ), ranked_reports as (
    select
      report.client_id as project_id,
      report.status,
      report.created_at,
      row_number() over (
        partition by report.client_id
        order by report.created_at desc, report.id desc
      ) as position
    from public.reports report
    join requested on requested.id = report.client_id
    where report.agency_id = p_agency_id
  )
  select
    requested.id,
    coalesce(journey_aggregate.active_journeys, 0),
    coalesce(journey_aggregate.legacy_endpoint_journeys, 0),
    coalesce(journey_aggregate.business_eval_journeys, 0),
    coalesce(incident_aggregate.open_incidents, 0),
    coalesce(incident_aggregate.has_critical_incident, false),
    coalesce(journey_aggregate.has_failed_journey, false),
    coalesce(journey_aggregate.has_degraded_journey, false),
    coalesce(journey_aggregate.has_healthy_journey, false),
    ranked_runs.verdict,
    ranked_runs.effective_started_at,
    journey_aggregate.latest_legacy_started_at,
    ranked_reports.status::text,
    ranked_reports.created_at
  from requested
  left join journey_aggregate on journey_aggregate.project_id = requested.id
  left join incident_aggregate on incident_aggregate.project_id = requested.id
  left join ranked_runs on ranked_runs.project_id = requested.id and ranked_runs.position = 1
  left join ranked_reports on ranked_reports.project_id = requested.id and ranked_reports.position = 1;
$$;

create or replace function public.get_business_eval_journey_summaries(
  p_agency_id uuid,
  p_workflow_ids uuid[]
)
returns table(
  workflow_id uuid,
  project_name text,
  schedule_enabled boolean,
  schedule_interval_minutes integer,
  schedule_next_run_at timestamptz,
  supervised_run_id uuid,
  cleanup_verified boolean,
  schedule_paused_at timestamptz,
  schedule_pause_reason text,
  latest_eval_run_id uuid,
  latest_eval_verdict text,
  latest_eval_started_at timestamptz,
  legacy_check_count integer,
  active_legacy_check_count integer,
  legacy_interval_minutes integer,
  legacy_next_run_at timestamptz,
  legacy_last_run_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with requested as (
    select distinct journey.id, journey.client_id, project.name as project_name
    from unnest(coalesce(p_workflow_ids, '{}'::uuid[])) requested_id(id)
    join public.workflows journey
      on journey.id = requested_id.id
      and journey.agency_id = p_agency_id
    join public.clients project
      on project.id = journey.client_id
      and project.agency_id = journey.agency_id
    where cardinality(p_workflow_ids) between 1 and 100
  ), ranked_runs as (
    select
      run.workflow_id,
      run.id,
      run.verdict,
      coalesce(run.started_at, run.created_at) as effective_started_at,
      row_number() over (
        partition by run.workflow_id
        order by coalesce(run.started_at, run.created_at) desc, run.id desc
      ) as position
    from public.eval_runs run
    join requested on requested.id = run.workflow_id
    where run.agency_id = p_agency_id
  ), check_aggregate as (
    select
      check_state.workflow_id,
      count(*)::integer as legacy_check_count,
      count(*) filter (where check_state.enabled and not check_state.pending_setup)::integer as active_legacy_check_count,
      min(check_state.schedule_minutes) filter (where check_state.enabled and not check_state.pending_setup)::integer as legacy_interval_minutes,
      min(check_state.next_run_at) filter (where check_state.enabled and not check_state.pending_setup) as legacy_next_run_at,
      max(check_state.last_run_at) filter (where check_state.enabled and not check_state.pending_setup) as legacy_last_run_at
    from public.checks check_state
    join requested on requested.id = check_state.workflow_id
    where check_state.agency_id = p_agency_id
    group by check_state.workflow_id
  )
  select
    requested.id,
    requested.project_name,
    schedule.enabled,
    schedule.interval_minutes,
    schedule.next_run_at,
    schedule.supervised_run_id,
    coalesce(schedule.cleanup_verified, false),
    schedule.paused_at,
    coalesce(schedule.pause_reason, ''),
    ranked_runs.id,
    ranked_runs.verdict,
    ranked_runs.effective_started_at,
    coalesce(check_aggregate.legacy_check_count, 0),
    coalesce(check_aggregate.active_legacy_check_count, 0),
    check_aggregate.legacy_interval_minutes,
    check_aggregate.legacy_next_run_at,
    check_aggregate.legacy_last_run_at
  from requested
  left join public.journey_schedules schedule
    on schedule.workflow_id = requested.id and schedule.agency_id = p_agency_id
  left join ranked_runs on ranked_runs.workflow_id = requested.id and ranked_runs.position = 1
  left join check_aggregate on check_aggregate.workflow_id = requested.id;
$$;

create or replace function public.get_business_eval_report_active_share_flags(
  p_agency_id uuid,
  p_report_ids uuid[]
)
returns table(report_id uuid, has_active_share boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with requested as (
    select distinct report.id, report.snapshot_version, report.evidence_fingerprint,
      report.status, report.stale_at
    from unnest(coalesce(p_report_ids, '{}'::uuid[])) requested_id(id)
    join public.reports report
      on report.id = requested_id.id
      and report.agency_id = p_agency_id
    where cardinality(p_report_ids) between 1 and 100
  )
  select
    requested.id,
    requested.status = 'ready'::public.report_status
      and requested.stale_at is null
      and exists (
        select 1
        from public.report_share_links link
        where link.agency_id = p_agency_id
          and link.report_id = requested.id
          and link.snapshot_version = requested.snapshot_version
          and link.evidence_fingerprint = requested.evidence_fingerprint
          and link.revoked_at is null
          and link.expires_at > now()
      )
  from requested;
$$;

drop function if exists public.request_business_eval_cancellation(uuid,uuid,uuid);
create or replace function public.request_business_eval_cancellation(
  p_agency_id uuid,
  p_eval_run_id uuid,
  p_requested_by_user_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text
)
returns table(eval_run_id uuid, cancel_requested_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_run public.eval_runs%rowtype;
  saved_run public.eval_runs%rowtype;
begin
  if p_idempotency_key_hash !~ '^[a-f0-9]{64}$' or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Hashed cancellation idempotency keys are required.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.agency_id = p_agency_id and m.user_id = p_requested_by_user_id
  ) then
    raise exception 'Cancellation requester is not a workspace member.' using errcode = '42501';
  end if;

  perform 1 from public.agencies agency where agency.id = p_agency_id for update;
  select run.* into existing_run
  from public.eval_runs run
  where run.agency_id = p_agency_id
    and run.cancel_idempotency_key_hash = p_idempotency_key_hash
  for update;
  if found then
    if existing_run.id <> p_eval_run_id
      or existing_run.cancel_request_hash <> p_request_hash
      or existing_run.cancel_requested_by_user_id <> p_requested_by_user_id then
      raise exception 'EVAL_RUN_CANCELLATION_IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
    end if;
    return query select existing_run.id, existing_run.cancel_requested_at;
    return;
  end if;

  select run.* into saved_run
  from public.eval_runs run
  where run.id = p_eval_run_id and run.agency_id = p_agency_id
  for update;
  if not found then
    raise exception 'Eval run was not found.' using errcode = 'P0002';
  end if;
  if saved_run.status not in ('queued', 'claimed', 'running')
    or saved_run.cancel_requested_at is not null then
    raise exception 'Eval run cannot be cancelled.' using errcode = '55000';
  end if;

  update public.eval_runs run set
    cancel_requested_at = now(),
    cancel_requested_by_user_id = p_requested_by_user_id,
    cancel_idempotency_key_hash = p_idempotency_key_hash,
    cancel_request_hash = p_request_hash,
    updated_at = now()
  where run.id = p_eval_run_id and run.agency_id = p_agency_id
  returning run.* into saved_run;

  insert into public.audit_events(agency_id, actor_user_id, entity_type, entity_id, action, metadata_json)
  values (
    p_agency_id, p_requested_by_user_id, 'eval_run', p_eval_run_id,
    'business_eval_cancellation_requested', jsonb_build_object('requestedAt', saved_run.cancel_requested_at)
  );
  return query select saved_run.id, saved_run.cancel_requested_at;
end;
$$;

create or replace function public.finalize_business_eval_run(
  p_eval_run_id uuid,
  p_worker_id text,
  p_stage_results jsonb,
  p_summary text default '',
  p_business_impact text default '',
  p_failure_fingerprint text default '',
  p_cleanup_status text default 'not_required',
  p_cleanup_error_summary text default '',
  p_completed_at timestamptz default now()
)
returns table(eval_run_id uuid, incident_id uuid, final_verdict text, schedule_paused boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_run public.eval_runs%rowtype;
  stage_count integer;
  result_count integer;
  computed_verdict text;
  created_incident_id uuid;
  did_pause boolean := false;
  normalized_fingerprint text;
  cleanup_stage_count integer;
  derived_cleanup_status text;
  derived_cleanup_error_summary text := '';
  first_problem_stage_run_id uuid;
  first_problem_stage_key text;
  captcha_detected boolean := false;
begin
  select * into saved_run from public.eval_runs where id = p_eval_run_id for update;
  if not found then raise exception 'Eval run was not found.' using errcode = 'P0002'; end if;

  if saved_run.status = 'finalized' then
    select i.id into created_incident_id from public.issues i
    where i.agency_id = saved_run.agency_id and i.eval_run_id = saved_run.id
    order by i.created_at desc limit 1;
    insert into public.eval_alert_outbox (agency_id, eval_run_id, issue_id)
    values (saved_run.agency_id, saved_run.id, created_incident_id)
    on conflict on constraint eval_alert_outbox_run_unique do nothing;
    return query select saved_run.id, created_incident_id, saved_run.verdict, false;
    return;
  end if;
  if saved_run.status not in ('claimed', 'running') or saved_run.worker_id <> p_worker_id then
    raise exception 'Eval run is not held by this worker.' using errcode = '55000';
  end if;
  if jsonb_typeof(p_stage_results) <> 'array' then
    raise exception 'Stage results must be an array.' using errcode = '22023';
  end if;

  select count(*) into stage_count from public.journey_stage_definitions
  where journey_version_id = saved_run.journey_version_id and agency_id = saved_run.agency_id;
  select jsonb_array_length(p_stage_results) into result_count;
  if stage_count = 0 or stage_count <> result_count then
    raise exception 'Finalization requires exactly one result for every immutable stage.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_stage_results) item
    left join public.journey_stage_definitions s
      on s.id = (item->>'stageId')::uuid
      and s.journey_version_id = saved_run.journey_version_id
      and s.agency_id = saved_run.agency_id
    where s.id is null
      or item->>'verdict' not in ('passed', 'degraded', 'failed', 'inconclusive', 'cancelled', 'not_run')
  ) then
    raise exception 'Stage results do not match the immutable journey version.' using errcode = '22023';
  end if;

  select coalesce(bool_or(item->>'errorCode' = 'CAPTCHA_DETECTED'), false)
  into captcha_detected
  from jsonb_array_elements(p_stage_results) item;

  if captcha_detected then
    -- CAPTCHA is an access ambiguity, never a deterministic business failure.
    -- Cleanup is still reduced independently below and may add its own pause.
    computed_verdict := 'inconclusive';
  else
    select case
      when bool_or(item->>'verdict' = 'failed') then 'failed'
      when bool_or(item->>'verdict' = 'inconclusive') then 'inconclusive'
      when bool_or(item->>'verdict' = 'degraded') then 'degraded'
      when bool_or(item->>'verdict' = 'cancelled') then 'cancelled'
      when bool_and(item->>'verdict' = 'passed') then 'passed'
      else 'not_run'
    end into computed_verdict
    from jsonb_array_elements(p_stage_results) item;
  end if;

  select count(*) into cleanup_stage_count
  from public.journey_stage_definitions s
  where s.journey_version_id = saved_run.journey_version_id
    and s.agency_id = saved_run.agency_id and s.is_cleanup;
  if cleanup_stage_count = 0 then
    derived_cleanup_status := 'not_required';
  elsif not exists (
    select 1
    from jsonb_array_elements(p_stage_results) item
    join public.journey_stage_definitions s on s.id = (item->>'stageId')::uuid
    where s.journey_version_id = saved_run.journey_version_id
      and s.agency_id = saved_run.agency_id and s.is_cleanup
      and item->>'verdict' not in ('passed', 'degraded')
  ) then
    derived_cleanup_status := 'passed';
  else
    derived_cleanup_status := 'failed';
    select left(coalesce(nullif(item->>'observedText', ''), 'Cleanup did not complete.'), 1000)
    into derived_cleanup_error_summary
    from jsonb_array_elements(p_stage_results) item
    join public.journey_stage_definitions s on s.id = (item->>'stageId')::uuid
    where s.journey_version_id = saved_run.journey_version_id
      and s.agency_id = saved_run.agency_id and s.is_cleanup
      and item->>'verdict' not in ('passed', 'degraded')
    order by s.position limit 1;
  end if;
  if p_cleanup_status is distinct from derived_cleanup_status then
    raise exception 'Cleanup status does not match the immutable cleanup-stage results.' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_stage_results) item,
      jsonb_array_elements_text(coalesce(item->'evidenceArtifactIds', '[]'::jsonb)) artifact_id
    where not exists (
      select 1 from public.evidence_artifacts a
      where a.id = artifact_id::uuid and a.eval_run_id = saved_run.id
        and a.agency_id = saved_run.agency_id and a.synthetic_marker = saved_run.synthetic_marker
    )
  ) then
    raise exception 'A stage result references evidence outside this eval run.' using errcode = '22023';
  end if;

  insert into public.eval_stage_runs (
    agency_id, eval_run_id, stage_definition_id, position, status, verdict,
    expected_text, observed_text, error_code, diagnostics_json, assertion_results_json,
    evidence_artifact_ids, started_at, completed_at, duration_ms
  )
  select
    saved_run.agency_id, saved_run.id, s.id, s.position,
    coalesce(nullif(item->>'status', ''), case when item->>'verdict' = 'not_run' then 'not_run' when item->>'verdict' = 'cancelled' then 'cancelled' else 'completed' end),
    item->>'verdict', s.expected_text, left(coalesce(item->>'observedText', ''), 2000),
    left(coalesce(item->>'errorCode', ''), 120),
    case when jsonb_typeof(item->'diagnostics') = 'object' then item->'diagnostics' else '{}'::jsonb end,
    case when jsonb_typeof(item->'assertionResults') = 'array' then item->'assertionResults' else '[]'::jsonb end,
    coalesce(array(select value::uuid from jsonb_array_elements_text(coalesce(item->'evidenceArtifactIds', '[]'::jsonb)) value), '{}'::uuid[]),
    nullif(item->>'startedAt', '')::timestamptz,
    nullif(item->>'completedAt', '')::timestamptz,
    case when nullif(item->>'durationMs', '') is null then null else (item->>'durationMs')::integer end
  from jsonb_array_elements(p_stage_results) item
  join public.journey_stage_definitions s on s.id = (item->>'stageId')::uuid
  order by s.position;

  select sr.id, s.stage_key into first_problem_stage_run_id, first_problem_stage_key
  from public.eval_stage_runs sr
  join public.journey_stage_definitions s on s.id = sr.stage_definition_id and s.agency_id = sr.agency_id
  where sr.eval_run_id = saved_run.id and sr.agency_id = saved_run.agency_id
    and sr.verdict in ('failed', 'degraded')
  order by sr.position limit 1;

  update public.evidence_artifacts artifact set eval_stage_run_id = stage_run.id
  from public.eval_stage_runs stage_run
  where stage_run.eval_run_id = saved_run.id
    and stage_run.agency_id = saved_run.agency_id
    and artifact.id = any(stage_run.evidence_artifact_ids)
    and artifact.eval_run_id = saved_run.id
    and artifact.agency_id = saved_run.agency_id;

  update public.eval_runs set
    status = 'finalized', verdict = computed_verdict,
    summary = left(coalesce(p_summary, ''), 2000),
    business_impact = left(coalesce(p_business_impact, ''), 2000),
    failure_fingerprint = left(coalesce(p_failure_fingerprint, ''), 512),
    cleanup_status = derived_cleanup_status,
    cleanup_error_summary = derived_cleanup_error_summary,
    completed_at = p_completed_at,
    duration_ms = greatest(0, floor(extract(epoch from (p_completed_at - coalesce(started_at, claimed_at, created_at))) * 1000)::integer),
    lease_expires_at = null, updated_at = now()
  where id = saved_run.id;

  update public.workflows set
    status = case computed_verdict
      when 'passed' then 'healthy'::public.workflow_status
      when 'degraded' then 'degraded'::public.workflow_status
      when 'failed' then 'failed'::public.workflow_status
      else 'pending'::public.workflow_status
    end,
    updated_at = now()
  where id = saved_run.workflow_id and agency_id = saved_run.agency_id;

  if captcha_detected or derived_cleanup_status = 'failed' then
    -- Cleanup failure is a journey-level safety pause even for manual and
    -- supervised runs that do not yet have a persisted schedule. Publishing a
    -- repaired immutable version clears only this specific pause so another
    -- supervised run can prove the repair before scheduling is re-enabled.
    update public.workflows set
      paused_at = p_completed_at,
      pause_reason = case when captcha_detected then 'captcha_detected' else 'cleanup_failed' end,
      updated_at = now()
    where id = saved_run.workflow_id and agency_id = saved_run.agency_id;

    update public.journey_schedules set
      enabled = false,
      paused_at = p_completed_at,
      pause_reason = case when captcha_detected then 'captcha_detected' else 'cleanup_failed' end,
      lease_expires_at = null,
      leased_by = null,
      updated_at = now()
    where workflow_id = saved_run.workflow_id
      and agency_id = saved_run.agency_id
      and journey_version_id = saved_run.journey_version_id;
    did_pause := true;
  end if;

  if saved_run.schedule_id is not null then
    update public.journey_schedules set
      last_run_at = p_completed_at,
      next_run_at = p_completed_at + make_interval(mins => interval_minutes),
      lease_expires_at = null, leased_by = null,
      enabled = case when captcha_detected or derived_cleanup_status = 'failed' then false else enabled end,
      paused_at = case when captcha_detected or derived_cleanup_status = 'failed' then p_completed_at else paused_at end,
      pause_reason = case
        when captcha_detected then 'captcha_detected'
        when derived_cleanup_status = 'failed' then 'cleanup_failed'
        else pause_reason
      end,
      cleanup_verified = derived_cleanup_status in ('passed', 'not_required'),
      updated_at = now()
    where id = saved_run.schedule_id and agency_id = saved_run.agency_id
      and journey_version_id = saved_run.journey_version_id;
  end if;

  if saved_run.trigger_source = 'verification' and saved_run.verification_issue_id is not null then
    if computed_verdict = 'passed' then
      update public.issues set
        status = 'resolved'::public.issue_status,
        verification_eval_run_id = saved_run.id,
        resolved_at = p_completed_at,
        updated_at = now()
      where id = saved_run.verification_issue_id and agency_id = saved_run.agency_id
        and status = 'in_review'::public.issue_status
        and repair_recorded_at is not null and repair_recorded_at < coalesce(saved_run.started_at, p_completed_at)
      returning id into created_incident_id;
      if created_incident_id is null then
        raise exception 'Verification incident changed while the eval was running.' using errcode = '40001';
      end if;
    else
      update public.issues set
        status = 'open'::public.issue_status,
        repair_recorded_at = null,
        resolved_at = null,
        verification_eval_run_id = null,
        resolution_note = '',
        report_safe_summary = '',
        updated_at = now()
      where id = saved_run.verification_issue_id and agency_id = saved_run.agency_id
      returning id into created_incident_id;
    end if;
  elsif computed_verdict in ('failed', 'degraded') then
    normalized_fingerprint := coalesce(
      nullif(trim(p_failure_fingerprint), ''),
      'journey:' || saved_run.workflow_id::text || ':' || coalesce(first_problem_stage_key, 'unknown_stage') || ':' || computed_verdict
    );
    insert into public.issues (
      agency_id, client_id, workflow_id, dedupe_key, severity, status, title,
      description, suggested_action, reportable, occurrence_count,
      report_safe_summary, eval_run_id, eval_stage_run_id, created_at, updated_at
    ) values (
      saved_run.agency_id, saved_run.client_id, saved_run.workflow_id,
      'eval:' || saved_run.workflow_id::text || ':' || left(normalized_fingerprint, 400),
      case when computed_verdict = 'failed' then 'high'::public.issue_severity else 'medium'::public.issue_severity end,
      'open'::public.issue_status,
      left('Business eval ' || computed_verdict, 180),
      left(coalesce(nullif(p_summary, ''), 'A production business eval did not meet its expected outcome.'), 2000),
      'Review the failed journey stage and rerun after repair.', true, 1, '',
      saved_run.id, first_problem_stage_run_id, p_completed_at, p_completed_at
    ) on conflict on constraint issues_agency_dedupe_unique do update set
      eval_run_id = excluded.eval_run_id, eval_stage_run_id = excluded.eval_stage_run_id,
      status = 'open'::public.issue_status,
      occurrence_count = greatest(1, issues.occurrence_count) + 1,
      repair_recorded_at = null, resolved_at = null, verification_eval_run_id = null,
      resolution_note = '', report_safe_summary = '',
      description = excluded.description, updated_at = now()
    returning id into created_incident_id;
  end if;

  -- This durable outbox intent commits in the same transaction as evidence,
  -- verdict, incident, and schedule state. Provider fanout is reconciled later.
  insert into public.eval_alert_outbox (agency_id, eval_run_id, issue_id)
  values (saved_run.agency_id, saved_run.id, created_incident_id)
  on conflict on constraint eval_alert_outbox_run_unique do nothing;

  return query select saved_run.id, created_incident_id, computed_verdict, did_pause;
end;
$$;

create or replace function public.create_business_eval_report_snapshot(
  p_agency_id uuid,
  p_client_id uuid,
  p_period_start date,
  p_period_end date,
  p_created_by_user_id uuid,
  p_idempotency_key text
)
returns setof public.reports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_report public.reports%rowtype;
  journey_coverage jsonb;
  run_evidence jsonb;
  incident_evidence jsonb;
  evidence_snapshot jsonb;
  final_snapshot jsonb;
  metrics jsonb;
  fingerprint text;
  eligible_run_count integer;
  passed_run_count integer;
  next_snapshot_version integer;
begin
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'A valid report period is required.' using errcode = '22023';
  end if;
  if p_period_end > current_date then
    raise exception 'Business eval reports cannot include future dates.' using errcode = '22023';
  end if;
  if nullif(trim(p_idempotency_key), '') is null then
    raise exception 'A report idempotency key is required.' using errcode = '22023';
  end if;

  perform 1 from public.agencies where id = p_agency_id for update;
  if not found then raise exception 'Workspace was not found.' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.clients c where c.id = p_client_id and c.agency_id = p_agency_id
  ) then raise exception 'Project was not found.' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.memberships m
    where m.agency_id = p_agency_id and m.user_id = p_created_by_user_id
  ) then raise exception 'Report creator is not a workspace member.' using errcode = '42501'; end if;

  select * into target_report from public.reports r
  where r.agency_id = p_agency_id and r.eval_snapshot_idempotency_key = p_idempotency_key
  limit 1;
  if found then
    if target_report.client_id <> p_client_id
      or target_report.period_start <> p_period_start
      or target_report.period_end <> p_period_end then
      raise exception 'Report idempotency key was already used for different inputs.' using errcode = '22023';
    end if;
    return query select r.* from public.reports r where r.id = target_report.id;
    return;
  end if;

  select count(*)::integer,
         count(*) filter (where r.verdict = 'passed')::integer
  into eligible_run_count, passed_run_count
  from public.eval_runs r
  where r.agency_id = p_agency_id and r.client_id = p_client_id
    and r.status = 'finalized'
    and r.completed_at >= p_period_start::timestamptz
    and r.completed_at < (p_period_end + 1)::timestamptz
    and exists (select 1 from public.eval_stage_runs sr where sr.eval_run_id = r.id and sr.agency_id = r.agency_id)
    and (select count(*) from public.eval_stage_runs sr where sr.eval_run_id = r.id and sr.agency_id = r.agency_id)
      = (select count(*) from public.journey_stage_definitions sd where sd.journey_version_id = r.journey_version_id and sd.agency_id = r.agency_id);
  if eligible_run_count = 0 then
    raise exception 'No complete finalized business eval runs exist in this period.' using errcode = '55000';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'journeyId', coverage.workflow_id,
    'name', coverage.name,
    'template', coverage.journey_template,
    'runCount', coverage.run_count,
    'latestVerdict', coverage.latest_verdict,
    'latestCompletedAt', coverage.latest_completed_at
  ) order by coverage.name, coverage.workflow_id), '[]'::jsonb)
  into journey_coverage
  from (
    select w.id as workflow_id, w.name, w.journey_template,
      count(r.id)::integer as run_count,
      (array_agg(r.verdict order by r.completed_at desc, r.id desc))[1] as latest_verdict,
      max(r.completed_at) as latest_completed_at
    from public.workflows w
    join public.eval_runs r on r.workflow_id = w.id and r.agency_id = w.agency_id
    where w.agency_id = p_agency_id and w.client_id = p_client_id
      and r.status = 'finalized'
      and r.completed_at >= p_period_start::timestamptz
      and r.completed_at < (p_period_end + 1)::timestamptz
      and exists (select 1 from public.eval_stage_runs sr where sr.eval_run_id = r.id and sr.agency_id = r.agency_id)
      and (select count(*) from public.eval_stage_runs sr where sr.eval_run_id = r.id and sr.agency_id = r.agency_id)
        = (select count(*) from public.journey_stage_definitions sd where sd.journey_version_id = r.journey_version_id and sd.agency_id = r.agency_id)
    group by w.id, w.name, w.journey_template
  ) coverage;

  select coalesce(jsonb_agg(jsonb_build_object(
    'runId', evidence.id,
    'journeyId', evidence.workflow_id,
    'journeyVersionId', evidence.journey_version_id,
    'triggerSource', evidence.trigger_source,
    'verdict', evidence.verdict,
    'summary', evidence.summary,
    'businessImpact', evidence.business_impact,
    'cleanupStatus', evidence.cleanup_status,
    'startedAt', evidence.started_at,
    'completedAt', evidence.completed_at,
    'durationMs', evidence.duration_ms,
    'stages', evidence.stages
  ) order by evidence.completed_at, evidence.id), '[]'::jsonb)
  into run_evidence
  from (
    select r.*,
      (select coalesce(jsonb_agg(jsonb_build_object(
        'stageDefinitionId', sr.stage_definition_id,
        'position', sr.position,
        'verdict', sr.verdict,
        'expected', sr.expected_text,
        'errorCode', sr.error_code,
        'durationMs', sr.duration_ms,
        'artifacts', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'artifactId', artifact.id,
            'kind', artifact.artifact_kind,
            'mimeType', artifact.mime_type
          ) order by artifact.created_at, artifact.id), '[]'::jsonb)
          from public.evidence_artifacts artifact
          where artifact.eval_stage_run_id = sr.id
            and artifact.agency_id = sr.agency_id
            and artifact.artifact_kind = 'screenshot'
            and artifact.redacted
            and artifact.report_safe
            and artifact.expires_at > now()
        )
      ) order by sr.position), '[]'::jsonb)
      from public.eval_stage_runs sr
      where sr.eval_run_id = r.id and sr.agency_id = r.agency_id) as stages
    from public.eval_runs r
    where r.agency_id = p_agency_id and r.client_id = p_client_id
      and r.status = 'finalized'
      and r.completed_at >= p_period_start::timestamptz
      and r.completed_at < (p_period_end + 1)::timestamptz
      and exists (select 1 from public.eval_stage_runs sr where sr.eval_run_id = r.id and sr.agency_id = r.agency_id)
      and (select count(*) from public.eval_stage_runs sr where sr.eval_run_id = r.id and sr.agency_id = r.agency_id)
        = (select count(*) from public.journey_stage_definitions sd where sd.journey_version_id = r.journey_version_id and sd.agency_id = r.agency_id)
  ) evidence;

  select coalesce(jsonb_agg(jsonb_build_object(
    'incidentId', i.id,
    'journeyId', i.workflow_id,
    'sourceEvalRunId', i.eval_run_id,
    'verificationEvalRunId', i.verification_eval_run_id,
    'severity', i.severity,
    'status', i.status,
    'title', i.title,
    'reportSafeSummary', i.report_safe_summary,
    'createdAt', i.created_at,
    'resolvedAt', i.resolved_at
  ) order by i.created_at, i.id), '[]'::jsonb)
  into incident_evidence
  from public.issues i
  where i.agency_id = p_agency_id and i.client_id = p_client_id
    and (i.eval_run_id is not null or i.verification_eval_run_id is not null)
    and (
      (i.created_at >= p_period_start::timestamptz and i.created_at < (p_period_end + 1)::timestamptz)
      or (i.resolved_at >= p_period_start::timestamptz and i.resolved_at < (p_period_end + 1)::timestamptz)
      or i.status <> 'resolved'::public.issue_status
    );

  metrics := jsonb_build_object(
    'journeysCovered', jsonb_array_length(journey_coverage),
    'evalRuns', eligible_run_count,
    'passedRuns', passed_run_count,
    'passRate', round((passed_run_count::numeric * 100) / eligible_run_count, 2),
    'incidents', jsonb_array_length(incident_evidence),
    'recoveries', (select count(*) from jsonb_array_elements(incident_evidence) item where item->>'status' = 'resolved')
  );
  evidence_snapshot := jsonb_build_object(
    'schemaVersion', 1,
    'periodStart', p_period_start,
    'periodEnd', p_period_end,
    'projectId', p_client_id,
    'journeys', journey_coverage,
    'runs', run_evidence,
    'incidents', incident_evidence,
    'metrics', metrics
  );
  fingerprint := encode(digest(evidence_snapshot::text, 'sha256'), 'hex');

  select coalesce(max(r.snapshot_version), 0) + 1
  into next_snapshot_version
  from public.reports r
  where r.agency_id = p_agency_id and r.client_id = p_client_id
    and r.period_start = p_period_start and r.period_end = p_period_end
    and r.eval_snapshot_idempotency_key is not null;
  final_snapshot := evidence_snapshot || jsonb_build_object(
    'snapshotVersion', next_snapshot_version,
    'generatedAt', now(),
    'evidenceFingerprint', fingerprint
  );

  insert into public.reports (
    agency_id, client_id, period_start, period_end, status, narrative,
    readiness_json, metrics_json, snapshot_version, snapshot_json,
    evidence_fingerprint, eval_coverage_snapshot_json, eval_evidence_fingerprint,
    eval_snapshot_idempotency_key, created_at, updated_at
  ) values (
    p_agency_id, p_client_id, p_period_start, p_period_end, 'ready'::public.report_status,
    eligible_run_count::text || ' finalized business eval runs provided immutable journey coverage.',
    jsonb_build_object('businessEvalCoverage', true, 'immutableStageCoverage', true),
    metrics, next_snapshot_version, final_snapshot, fingerprint,
    final_snapshot, fingerprint, p_idempotency_key, now(), now()
  ) returning * into target_report;

  insert into public.audit_events(agency_id, actor_user_id, entity_type, entity_id, action, metadata_json)
  values (
    p_agency_id, p_created_by_user_id, 'report', target_report.id, 'business_eval_snapshot_created',
    jsonb_build_object('snapshotVersion', target_report.snapshot_version, 'evalRuns', eligible_run_count)
  );
  return query select r.* from public.reports r where r.id = target_report.id;
end;
$$;

create or replace function public.revoke_report_share_link_idempotent(
  p_agency_id uuid,
  p_report_id uuid,
  p_share_link_id uuid,
  p_requested_by_user_id uuid,
  p_idempotency_key_hash text,
  p_request_hash text
)
returns table(share_link_id uuid, revoked_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_link public.report_share_links%rowtype;
  saved_link public.report_share_links%rowtype;
begin
  if p_idempotency_key_hash !~ '^[a-f0-9]{64}$' or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Hashed report-share revocation idempotency keys are required.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships membership
    where membership.agency_id = p_agency_id and membership.user_id = p_requested_by_user_id
  ) then
    raise exception 'Report-share revocation requester is not a workspace member.' using errcode = '42501';
  end if;

  perform 1 from public.agencies agency where agency.id = p_agency_id for update;
  select link.* into existing_link
  from public.report_share_links link
  where link.agency_id = p_agency_id
    and link.revocation_idempotency_key_hash = p_idempotency_key_hash
  for update;
  if found then
    if existing_link.id <> p_share_link_id
      or existing_link.report_id <> p_report_id
      or existing_link.revocation_request_hash <> p_request_hash
      or existing_link.revoked_by_user_id <> p_requested_by_user_id then
      raise exception 'REPORT_SHARE_REVOCATION_IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
    end if;
    return query select existing_link.id, existing_link.revoked_at;
    return;
  end if;

  select link.* into saved_link
  from public.report_share_links link
  where link.id = p_share_link_id
    and link.agency_id = p_agency_id
    and link.report_id = p_report_id
  for update;
  if not found then
    raise exception 'Report share link was not found.' using errcode = 'P0002';
  end if;
  if saved_link.revoked_at is not null then
    raise exception 'Report share link is already revoked.' using errcode = '55000';
  end if;

  update public.report_share_links link set
    revoked_at = now(),
    revoked_by_user_id = p_requested_by_user_id,
    revocation_idempotency_key_hash = p_idempotency_key_hash,
    revocation_request_hash = p_request_hash
  where link.id = p_share_link_id
    and link.agency_id = p_agency_id
    and link.report_id = p_report_id
  returning link.* into saved_link;

  insert into public.audit_events(agency_id, actor_user_id, entity_type, entity_id, action, metadata_json)
  values (
    p_agency_id, p_requested_by_user_id, 'report_share_link', p_share_link_id,
    'report_share_link_revoked', jsonb_build_object('reportId', p_report_id, 'revokedAt', saved_link.revoked_at)
  );
  return query select saved_link.id, saved_link.revoked_at;
end;
$$;

drop function if exists public.consume_report_share_link(text);
create or replace function public.consume_report_share_link(
  p_token_hash text
)
returns table(
  share_link_id uuid,
  agency_id uuid,
  report_id uuid,
  snapshot_version integer,
  evidence_fingerprint text,
  snapshot_hash text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  return query
  update public.report_share_links l
  set access_count = l.access_count + 1,
      last_accessed_at = now()
  where l.token_hash = p_token_hash
    and l.revoked_at is null
    and l.expires_at > now()
  returning l.id, l.agency_id, l.report_id, l.snapshot_version, l.evidence_fingerprint, l.snapshot_hash, l.expires_at;
end;
$$;

create or replace function public.claim_provider_webhook_receipt(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_payload_hash text,
  p_stale_after_seconds integer default 300
)
returns table(
  receipt_id uuid,
  receipt_status text,
  claimed boolean,
  claim_token uuid,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.provider_webhook_receipts%rowtype;
  new_claim_token uuid;
begin
  if p_provider <> 'stripe'
    or nullif(trim(p_event_id), '') is null
    or length(p_event_id) > 255
    or nullif(trim(p_event_type), '') is null
    or length(p_event_type) > 255
    or p_payload_hash !~ '^[a-f0-9]{64}$'
    or p_stale_after_seconds not between 30 and 3600 then
    raise exception 'PROVIDER_WEBHOOK_RECEIPT_INVALID' using errcode = '22023';
  end if;

  new_claim_token := gen_random_uuid();
  insert into public.provider_webhook_receipts (
    provider, event_id, event_type, payload_hash, status, claim_token,
    attempt_count, last_error_safe, received_at, processed_at, updated_at
  ) values (
    p_provider, p_event_id, p_event_type, p_payload_hash, 'processing',
    new_claim_token, 1, '', now(), null, now()
  ) on conflict (provider, event_id) do nothing
  returning * into saved;
  if found then
    return query select saved.id, saved.status, true, saved.claim_token, saved.attempt_count;
    return;
  end if;

  select * into saved from public.provider_webhook_receipts
  where provider = p_provider and event_id = p_event_id
  for update;
  if not found then
    raise exception 'PROVIDER_WEBHOOK_RECEIPT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if saved.payload_hash <> p_payload_hash or saved.event_type <> p_event_type then
    raise exception 'PROVIDER_WEBHOOK_EVENT_MISMATCH' using errcode = '23514';
  end if;
  if saved.status = 'processed' then
    return query select saved.id, saved.status, false, saved.claim_token, saved.attempt_count;
    return;
  end if;
  if saved.status = 'processing'
    and saved.updated_at > now() - make_interval(secs => p_stale_after_seconds) then
    return query select saved.id, saved.status, false, saved.claim_token, saved.attempt_count;
    return;
  end if;

  new_claim_token := gen_random_uuid();
  update public.provider_webhook_receipts set
    status = 'processing',
    claim_token = new_claim_token,
    attempt_count = saved.attempt_count + 1,
    last_error_safe = '',
    processed_at = null,
    updated_at = now()
  where id = saved.id
  returning * into saved;
  return query select saved.id, saved.status, true, saved.claim_token, saved.attempt_count;
end;
$$;

create or replace function public.finish_provider_webhook_receipt(
  p_receipt_id uuid,
  p_claim_token uuid,
  p_payload_hash text,
  p_succeeded boolean,
  p_last_error_safe text default ''
)
returns setof public.provider_webhook_receipts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_payload_hash !~ '^[a-f0-9]{64}$' or length(coalesce(p_last_error_safe, '')) > 300 then
    raise exception 'PROVIDER_WEBHOOK_FINISH_INVALID' using errcode = '22023';
  end if;
  return query
  update public.provider_webhook_receipts receipt set
    status = case when p_succeeded then 'processed' else 'failed' end,
    processed_at = case when p_succeeded then now() else null end,
    last_error_safe = case when p_succeeded then '' else coalesce(p_last_error_safe, '') end,
    updated_at = now()
  where receipt.id = p_receipt_id
    and receipt.claim_token = p_claim_token
    and receipt.payload_hash = p_payload_hash
    and receipt.status = 'processing'
  returning receipt.*;
  if not found then
    raise exception 'PROVIDER_WEBHOOK_CLAIM_LOST' using errcode = '40001';
  end if;
end;
$$;

drop function if exists public.register_browser_context_lease(uuid,text,timestamptz);
create or replace function public.register_browser_context_lease(
  p_eval_run_id uuid,
  p_context_id text,
  p_delete_after timestamptz
)
returns setof public.browser_context_leases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_run public.eval_runs%rowtype;
  existing_lease public.browser_context_leases%rowtype;
begin
  if p_context_id is null
    or length(trim(p_context_id)) not between 8 and 255
    or p_context_id ~ '[[:space:][:cntrl:]]'
    or p_delete_after is null
    or p_delete_after <= now()
    or p_delete_after > now() + interval '24 hours' then
    raise exception 'BROWSER_CONTEXT_LEASE_INVALID' using errcode = '22023';
  end if;

  select run.* into target_run
  from public.eval_runs run
  where run.id = p_eval_run_id
  for update;
  if not found then
    raise exception 'EVAL_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if target_run.status in ('finalized', 'cancelled') then
    raise exception 'BROWSER_CONTEXT_RUN_TERMINAL' using errcode = '55000';
  end if;

  select lease.* into existing_lease
  from public.browser_context_leases lease
  where lease.eval_run_id = p_eval_run_id
  for update;
  if found then
    if existing_lease.context_id <> p_context_id then
      raise exception 'BROWSER_CONTEXT_LEASE_CONFLICT' using errcode = '23505';
    end if;
    return query select lease.* from public.browser_context_leases lease where lease.id = existing_lease.id;
    return;
  end if;

  return query
  insert into public.browser_context_leases (
    agency_id,
    eval_run_id,
    context_id,
    context_id_hash,
    delete_after,
    next_cleanup_at
  ) values (
    target_run.agency_id,
    target_run.id,
    p_context_id,
    encode(digest(p_context_id, 'sha256'), 'hex'),
    p_delete_after,
    p_delete_after
  )
  returning *;
end;
$$;

drop function if exists public.claim_browser_context_session(uuid,text,uuid,integer);
create or replace function public.claim_browser_context_session(
  p_eval_run_id uuid,
  p_context_id text,
  p_owner_token uuid,
  p_lease_seconds integer
)
returns table(
  may_execute boolean,
  retry_after_at timestamptz,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.browser_context_leases%rowtype;
begin
  if p_owner_token is null or p_lease_seconds not between 30 and 3600 then
    raise exception 'BROWSER_CONTEXT_SESSION_CLAIM_INVALID' using errcode = '22023';
  end if;

  select lease.* into saved
  from public.browser_context_leases lease
  where lease.eval_run_id = p_eval_run_id
  for update;
  if not found then
    raise exception 'BROWSER_CONTEXT_LEASE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if saved.context_id <> p_context_id then
    raise exception 'BROWSER_CONTEXT_LEASE_MISMATCH' using errcode = '42501';
  end if;

  if saved.cleanup_status = 'active' and saved.delete_after <= now() then
    update public.browser_context_leases lease set
      cleanup_status = 'pending',
      cleanup_requested_at = now(),
      cleanup_reason_code = 'LEASE_EXPIRED',
      next_cleanup_at = greatest(now(), coalesce(lease.sync_ready_at, now())),
      updated_at = now()
    where lease.id = saved.id
    returning lease.* into saved;
    return query select false, saved.next_cleanup_at, null::timestamptz;
    return;
  end if;

  if saved.cleanup_status <> 'active' then
    return query select false, saved.next_cleanup_at, null::timestamptz;
    return;
  end if;
  if saved.sync_ready_at is not null and saved.sync_ready_at > now() then
    return query select false, saved.sync_ready_at, null::timestamptz;
    return;
  end if;

  if saved.session_owner_token is null
    or saved.session_lease_expires_at <= now()
    or saved.session_owner_token = p_owner_token then
    update public.browser_context_leases lease set
      session_owner_token = p_owner_token,
      session_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
    where lease.id = saved.id
    returning lease.* into saved;
    return query select true, null::timestamptz, saved.session_lease_expires_at;
    return;
  end if;

  return query select false, least(saved.session_lease_expires_at, saved.delete_after), null::timestamptz;
end;
$$;

drop function if exists public.record_browser_context_session_started(uuid,text,uuid,text);
create or replace function public.record_browser_context_session_started(
  p_eval_run_id uuid,
  p_context_id text,
  p_owner_token uuid,
  p_last_session_id text
)
returns setof public.browser_context_leases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_last_session_id is null
    or length(p_last_session_id) not between 8 and 255
    or p_last_session_id ~ '[[:space:][:cntrl:]]' then
    raise exception 'BROWSER_CONTEXT_SESSION_ID_INVALID' using errcode = '22023';
  end if;

  return query
  update public.browser_context_leases lease set
    last_session_id = p_last_session_id,
    updated_at = now()
  where lease.eval_run_id = p_eval_run_id
    and lease.context_id = p_context_id
    and lease.session_owner_token = p_owner_token
    and lease.session_lease_expires_at > now()
    and lease.cleanup_status in ('active', 'pending')
  returning lease.*;
  if not found then
    raise exception 'BROWSER_CONTEXT_SESSION_CLAIM_LOST' using errcode = '40001';
  end if;
end;
$$;

drop function if exists public.complete_browser_context_session(uuid,text,uuid,text,text,timestamptz);
create or replace function public.complete_browser_context_session(
  p_eval_run_id uuid,
  p_context_id text,
  p_owner_token uuid,
  p_last_session_id text,
  p_resume_url text,
  p_sync_ready_at timestamptz
)
returns setof public.browser_context_leases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_last_session_id is null
    or (
      p_last_session_id <> '' and (
        length(p_last_session_id) not between 8 and 255
        or p_last_session_id ~ '[[:space:][:cntrl:]]'
      )
    )
    or p_resume_url is null
    or length(p_resume_url) > 2048
    or p_resume_url <> trim(p_resume_url)
    or (
      p_resume_url <> '' and (
        p_resume_url !~ '^https://'
        or p_resume_url ~ '[?#[:space:][:cntrl:]]'
        or p_resume_url ~ '^https://[^/]*@'
      )
    )
    or p_sync_ready_at is null
    or p_sync_ready_at < now() - interval '5 minutes'
    or p_sync_ready_at > now() + interval '10 minutes' then
    raise exception 'BROWSER_CONTEXT_SESSION_COMPLETION_INVALID' using errcode = '22023';
  end if;

  return query
  update public.browser_context_leases lease set
    last_session_id = coalesce(nullif(p_last_session_id, ''), lease.last_session_id),
    resume_url = p_resume_url,
    sync_ready_at = p_sync_ready_at,
    session_owner_token = null,
    session_lease_expires_at = null,
    next_cleanup_at = case
      when lease.cleanup_status = 'pending'
        then greatest(coalesce(lease.next_cleanup_at, p_sync_ready_at), p_sync_ready_at)
      else lease.next_cleanup_at
    end,
    updated_at = now()
  where lease.eval_run_id = p_eval_run_id
    and lease.context_id = p_context_id
    and lease.session_owner_token = p_owner_token
    and lease.cleanup_status in ('active', 'pending')
  returning lease.*;
  if not found then
    raise exception 'BROWSER_CONTEXT_SESSION_CLAIM_LOST' using errcode = '40001';
  end if;
end;
$$;

drop function if exists public.mark_browser_context_released(uuid,text,text);
create or replace function public.mark_browser_context_released(
  p_eval_run_id uuid,
  p_context_id text,
  p_reason_code text default 'RUN_TERMINAL'
)
returns setof public.browser_context_leases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.browser_context_leases%rowtype;
begin
  if p_reason_code is null or p_reason_code !~ '^[A-Z0-9_]{3,64}$' then
    raise exception 'BROWSER_CONTEXT_RELEASE_REASON_INVALID' using errcode = '22023';
  end if;

  select lease.* into saved
  from public.browser_context_leases lease
  where lease.eval_run_id = p_eval_run_id
  for update;
  if not found then
    raise exception 'BROWSER_CONTEXT_LEASE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if saved.context_id <> p_context_id then
    raise exception 'BROWSER_CONTEXT_LEASE_MISMATCH' using errcode = '42501';
  end if;

  if saved.cleanup_status = 'deleted' then
    return query select lease.* from public.browser_context_leases lease where lease.id = saved.id;
    return;
  end if;
  if saved.cleanup_status not in ('active', 'pending')
    or (saved.session_lease_expires_at is not null and saved.session_lease_expires_at > now()) then
    raise exception 'BROWSER_CONTEXT_RELEASE_NOT_SAFE' using errcode = '55000';
  end if;

  update public.browser_context_leases lease set
    cleanup_status = 'deleted',
    cleanup_requested_at = coalesce(lease.cleanup_requested_at, now()),
    cleanup_reason_code = case when lease.cleanup_reason_code = '' then p_reason_code else lease.cleanup_reason_code end,
    cleanup_worker_id = '',
    cleanup_lease_expires_at = null,
    next_cleanup_at = null,
    last_cleanup_error_code = '',
    resume_url = '',
    session_owner_token = null,
    session_lease_expires_at = null,
    released_at = now(),
    updated_at = now()
  where lease.id = saved.id
  returning lease.* into saved;
  return query select lease.* from public.browser_context_leases lease where lease.id = saved.id;
end;
$$;

drop function if exists public.claim_browser_context_cleanup_batch(integer,text,integer);
create or replace function public.claim_browser_context_cleanup_batch(
  p_limit integer,
  p_worker_id text,
  p_lease_seconds integer
)
returns table(
  lease_id uuid,
  agency_id uuid,
  eval_run_id uuid,
  context_id text,
  last_session_id text,
  cleanup_attempt integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_limit not between 1 and 20
    or p_worker_id is null
    or p_worker_id !~ '^[A-Za-z0-9:_-]{8,128}$'
    or p_lease_seconds not between 30 and 900 then
    raise exception 'BROWSER_CONTEXT_CLEANUP_CLAIM_INVALID' using errcode = '22023';
  end if;

  return query
  with due as (
    select lease.id
    from public.browser_context_leases lease
    where lease.cleanup_status in ('active', 'pending', 'claimed', 'failed')
      and lease.next_cleanup_at <= now()
      and (lease.session_lease_expires_at is null or lease.session_lease_expires_at <= now())
      and (lease.sync_ready_at is null or lease.sync_ready_at <= now())
    order by lease.next_cleanup_at, lease.id
    limit p_limit
    for update skip locked
  ), claimed as (
    update public.browser_context_leases lease set
      cleanup_status = 'claimed',
      cleanup_requested_at = coalesce(lease.cleanup_requested_at, now()),
      cleanup_reason_code = case
        when lease.cleanup_reason_code = '' then 'LEASE_EXPIRED'
        else lease.cleanup_reason_code
      end,
      cleanup_attempts = lease.cleanup_attempts + 1,
      cleanup_worker_id = p_worker_id,
      cleanup_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      next_cleanup_at = now() + make_interval(secs => p_lease_seconds),
      last_cleanup_error_code = '',
      session_owner_token = null,
      session_lease_expires_at = null,
      updated_at = now()
    from due
    where lease.id = due.id
    returning lease.*
  )
  select claimed.id, claimed.agency_id, claimed.eval_run_id, claimed.context_id,
    claimed.last_session_id, claimed.cleanup_attempts
  from claimed
  order by claimed.next_cleanup_at, claimed.id;
end;
$$;

drop function if exists public.complete_browser_context_cleanup(uuid,text);
create or replace function public.complete_browser_context_cleanup(
  p_lease_id uuid,
  p_worker_id text
)
returns setof public.browser_context_leases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.browser_context_leases lease set
    cleanup_status = 'deleted',
    cleanup_worker_id = '',
    cleanup_lease_expires_at = null,
    next_cleanup_at = null,
    last_cleanup_error_code = '',
    resume_url = '',
    session_owner_token = null,
    session_lease_expires_at = null,
    released_at = now(),
    updated_at = now()
  where lease.id = p_lease_id
    and lease.cleanup_status = 'claimed'
    and lease.cleanup_worker_id = p_worker_id
  returning lease.*;
  if not found then
    raise exception 'BROWSER_CONTEXT_CLEANUP_CLAIM_LOST' using errcode = '40001';
  end if;
end;
$$;

drop function if exists public.retry_browser_context_cleanup(uuid,text,text,integer);
create or replace function public.retry_browser_context_cleanup(
  p_lease_id uuid,
  p_worker_id text,
  p_error_code text,
  p_retry_after_seconds integer
)
returns setof public.browser_context_leases
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_error_code is null
    or p_error_code !~ '^[A-Z0-9_]{3,64}$'
    or p_retry_after_seconds not between 30 and 21600 then
    raise exception 'BROWSER_CONTEXT_CLEANUP_RETRY_INVALID' using errcode = '22023';
  end if;

  return query
  update public.browser_context_leases lease set
    cleanup_status = 'failed',
    cleanup_worker_id = '',
    cleanup_lease_expires_at = null,
    next_cleanup_at = now() + make_interval(secs => p_retry_after_seconds),
    last_cleanup_error_code = p_error_code,
    session_owner_token = null,
    session_lease_expires_at = null,
    updated_at = now()
  where lease.id = p_lease_id
    and lease.cleanup_status = 'claimed'
    and lease.cleanup_worker_id = p_worker_id
  returning lease.*;
  if not found then
    raise exception 'BROWSER_CONTEXT_CLEANUP_CLAIM_LOST' using errcode = '40001';
  end if;
end;
$$;

alter table public.project_authorizations enable row level security;
alter table public.journey_versions enable row level security;
alter table public.journey_stage_definitions enable row level security;
alter table public.journey_schedules enable row level security;
alter table public.eval_runs enable row level security;
alter table public.browser_context_leases enable row level security;
alter table public.eval_run_side_effect_attempts enable row level security;
alter table public.eval_rate_limit_buckets enable row level security;
alter table public.ai_assistance_requests enable row level security;
alter table public.eval_stage_runs enable row level security;
alter table public.evidence_artifacts enable row level security;
alter table public.inbound_email_events enable row level security;
alter table public.eval_email_receiving_health_events enable row level security;
alter table public.provider_webhook_receipts enable row level security;
alter table public.alert_endpoints enable row level security;
alter table public.alert_deliveries enable row level security;
alter table public.eval_alert_outbox enable row level security;
alter table public.report_share_links enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'project_authorizations','journey_versions','journey_stage_definitions','journey_schedules',
    'eval_runs','eval_run_side_effect_attempts','eval_stage_runs'
  ] loop
    execute format('drop policy if exists %I on public.%I', table_name || '_members_select', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select public.is_agency_member(agency_id)))',
      table_name || '_members_select', table_name
    );
  end loop;
end $$;

-- All business-eval configuration, run, evidence, delivery, and share-link
-- mutations pass through authorized server routes. Browser JWTs are read-only.
drop policy if exists clients_members_all on public.clients;
drop policy if exists clients_members_select on public.clients;
create policy clients_members_select on public.clients
for select to authenticated
using ((select public.is_agency_member(agency_id)));

drop policy if exists workflows_members_all on public.workflows;
drop policy if exists workflows_members_select on public.workflows;
create policy workflows_members_select on public.workflows
for select to authenticated
using ((select public.is_agency_member(agency_id)));

drop policy if exists project_authorizations_members_write on public.project_authorizations;
drop policy if exists journey_versions_members_insert on public.journey_versions;
drop policy if exists journey_stage_definitions_members_insert on public.journey_stage_definitions;
drop policy if exists journey_schedules_members_write on public.journey_schedules;
drop policy if exists alert_endpoints_members_write on public.alert_endpoints;
drop policy if exists report_share_links_members_write on public.report_share_links;

revoke insert, update, delete on public.clients, public.workflows from authenticated;
grant select on public.clients, public.workflows to authenticated;
revoke insert, update, delete on public.project_authorizations, public.journey_versions,
  public.journey_stage_definitions, public.journey_schedules, public.eval_runs,
  public.eval_run_side_effect_attempts, public.eval_stage_runs from authenticated;
grant select on public.project_authorizations, public.journey_versions,
  public.journey_stage_definitions, public.journey_schedules, public.eval_runs,
  public.eval_run_side_effect_attempts, public.eval_stage_runs to authenticated;
grant select, insert, update, delete on public.project_authorizations, public.journey_versions,
  public.journey_stage_definitions, public.journey_schedules, public.eval_runs,
  public.eval_run_side_effect_attempts, public.eval_stage_runs, public.evidence_artifacts, public.inbound_email_events,
  public.alert_endpoints, public.alert_deliveries, public.report_share_links to service_role;
revoke all on table public.eval_alert_outbox from public, anon, authenticated;
grant select, insert, update, delete on public.eval_alert_outbox to service_role;
revoke all on table public.eval_rate_limit_buckets from public, anon, authenticated;
grant select, insert, update, delete on public.eval_rate_limit_buckets to service_role;
revoke all on table public.ai_assistance_requests from public, anon, authenticated;
grant select, insert, update, delete on public.ai_assistance_requests to service_role;
revoke all on table public.provider_webhook_receipts from public, anon, authenticated;
grant select, insert, update, delete on public.provider_webhook_receipts to service_role;
revoke all on table public.browser_context_leases from public, anon, authenticated;
revoke insert, update, delete on table public.browser_context_leases from service_role;
grant select on table public.browser_context_leases to service_role;
drop policy if exists inbound_email_events_members_select on public.inbound_email_events;
revoke all on table public.inbound_email_events from public, anon, authenticated;
grant select, insert, update, delete on public.inbound_email_events to service_role;
revoke all on table public.eval_email_receiving_health_events from public, anon, authenticated;
grant select, insert, update, delete on public.eval_email_receiving_health_events to service_role;
drop policy if exists evidence_artifacts_members_select on public.evidence_artifacts;
revoke all on table public.evidence_artifacts from public, anon, authenticated;
grant select, insert, update, delete on public.evidence_artifacts to service_role;
drop policy if exists alert_endpoints_members_select on public.alert_endpoints;
drop policy if exists alert_deliveries_members_select on public.alert_deliveries;
revoke all on table public.alert_endpoints, public.alert_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.alert_endpoints, public.alert_deliveries to service_role;
drop policy if exists report_share_links_members_select on public.report_share_links;
revoke all on table public.report_share_links from public, anon, authenticated;
grant select, insert, update, delete on public.report_share_links to service_role;

create or replace function public.add_business_eval_workspace_member(
  p_agency_id uuid,
  p_actor_user_id uuid,
  p_invited_user_id uuid,
  p_role text,
  p_seat_limit integer
)
returns setof public.memberships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role public.agency_role;
  existing_membership public.memberships%rowtype;
  occupied integer;
begin
  if p_role not in ('admin', 'member') then
    raise exception 'MEMBERSHIP_ROLE_INVALID' using errcode = '22023';
  end if;
  if p_seat_limit is not null and p_seat_limit < 1 then
    raise exception 'SEAT_LIMIT_INVALID' using errcode = '22023';
  end if;

  perform 1 from public.agencies where id = p_agency_id for update;
  if not found then raise exception 'WORKSPACE_NOT_FOUND' using errcode = 'P0002'; end if;
  select role into actor_role from public.memberships
  where agency_id = p_agency_id and user_id = p_actor_user_id;
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'MEMBERSHIP_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_role = 'admin' and actor_role <> 'owner' then
    raise exception 'OWNER_REQUIRED_FOR_ADMIN_INVITE' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_invited_user_id) then
    raise exception 'INVITED_PROFILE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into existing_membership from public.memberships where user_id = p_invited_user_id;
  if found then
    if existing_membership.agency_id <> p_agency_id then
      raise exception 'USER_ALREADY_HAS_WORKSPACE' using errcode = '23505';
    end if;
    return query select * from public.memberships where id = existing_membership.id;
    return;
  end if;

  select count(*)::integer into occupied from public.memberships where agency_id = p_agency_id;
  if p_seat_limit is not null and occupied >= p_seat_limit then
    raise exception 'SEAT_LIMIT_REACHED' using errcode = 'P0001';
  end if;
  insert into public.memberships (agency_id, user_id, role)
  values (p_agency_id, p_invited_user_id, p_role::public.agency_role)
  returning * into existing_membership;
  return query select * from public.memberships where id = existing_membership.id;
end;
$$;

create or replace function public.update_business_eval_workspace_member_role(
  p_agency_id uuid,
  p_actor_user_id uuid,
  p_member_user_id uuid,
  p_role text
)
returns setof public.memberships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.memberships%rowtype;
begin
  if p_role not in ('admin', 'member') then
    raise exception 'MEMBERSHIP_ROLE_INVALID' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships
    where agency_id = p_agency_id and user_id = p_actor_user_id and role = 'owner'
  ) then
    raise exception 'WORKSPACE_OWNER_REQUIRED' using errcode = '42501';
  end if;
  select * into target from public.memberships
  where agency_id = p_agency_id and user_id = p_member_user_id for update;
  if not found then raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002'; end if;
  if target.role = 'owner' then
    raise exception 'WORKSPACE_OWNER_ROLE_IMMUTABLE' using errcode = '42501';
  end if;
  update public.memberships set role = p_role::public.agency_role where id = target.id;
  return query select * from public.memberships where id = target.id;
end;
$$;

create or replace function public.remove_business_eval_workspace_member(
  p_agency_id uuid,
  p_actor_user_id uuid,
  p_member_user_id uuid
)
returns table(removed boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.memberships%rowtype;
begin
  if not exists (
    select 1 from public.memberships
    where agency_id = p_agency_id and user_id = p_actor_user_id and role = 'owner'
  ) then
    raise exception 'WORKSPACE_OWNER_REQUIRED' using errcode = '42501';
  end if;
  select * into target from public.memberships
  where agency_id = p_agency_id and user_id = p_member_user_id for update;
  if not found then return query select false; return; end if;
  if target.role = 'owner' then
    raise exception 'WORKSPACE_OWNER_CANNOT_BE_REMOVED' using errcode = '42501';
  end if;
  delete from public.memberships where id = target.id;
  return query select true;
end;
$$;

-- Team changes must pass through the service-only, seat-aware RPCs above.
-- The older authenticated grants could otherwise bypass the active contract.
revoke insert, update, delete on public.memberships from authenticated;

revoke all on function public.add_business_eval_workspace_member(uuid,uuid,uuid,text,integer) from public, anon, authenticated;
grant execute on function public.add_business_eval_workspace_member(uuid,uuid,uuid,text,integer) to service_role;
revoke all on function public.update_business_eval_workspace_member_role(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.update_business_eval_workspace_member_role(uuid,uuid,uuid,text) to service_role;
revoke all on function public.remove_business_eval_workspace_member(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.remove_business_eval_workspace_member(uuid,uuid,uuid) to service_role;
revoke all on function public.record_business_eval_incident_repair(uuid,uuid,uuid,timestamptz,text) from public, anon, authenticated;
grant execute on function public.record_business_eval_incident_repair(uuid,uuid,uuid,timestamptz,text) to service_role;

revoke all on function public.create_business_eval_project(uuid,integer,uuid,text,text,text,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.create_business_eval_project(uuid,integer,uuid,text,text,text,text,uuid,text,text) to service_role;
revoke all on function public.create_legacy_endpoint_workflow(uuid,integer,uuid,uuid,text,public.workflow_type,public.workflow_environment,text,integer,integer,integer,integer,integer,boolean,timestamptz) from public, anon, authenticated;
grant execute on function public.create_legacy_endpoint_workflow(uuid,integer,uuid,uuid,text,public.workflow_type,public.workflow_environment,text,integer,integer,integer,integer,integer,boolean,timestamptz) to service_role;
revoke all on function public.restore_business_eval_project(uuid,uuid,integer,integer) from public, anon, authenticated;
grant execute on function public.restore_business_eval_project(uuid,uuid,integer,integer) to service_role;
revoke all on function public.revoke_project_authorizations_and_pause(uuid,uuid) from public, anon, authenticated;
grant execute on function public.revoke_project_authorizations_and_pause(uuid,uuid) to service_role;
revoke all on function public.create_business_eval_journey(uuid,integer,uuid,uuid,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.create_business_eval_journey(uuid,integer,uuid,uuid,text,text,text,jsonb) to service_role;
revoke all on function public.set_business_eval_journey_archived(uuid,uuid,uuid,boolean,integer) from public, anon, authenticated;
grant execute on function public.set_business_eval_journey_archived(uuid,uuid,uuid,boolean,integer) to service_role;
revoke all on function public.publish_journey_version(uuid,uuid,integer,uuid,uuid) from public, anon, authenticated;
grant execute on function public.publish_journey_version(uuid,uuid,integer,uuid,uuid) to service_role;
revoke all on function public.record_project_authorization(uuid,uuid,uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.record_project_authorization(uuid,uuid,uuid,text,text,jsonb) to service_role;
revoke all on function public.configure_journey_schedule(uuid,uuid,integer,integer,boolean,timestamptz) from public, anon, authenticated;
grant execute on function public.configure_journey_schedule(uuid,uuid,integer,integer,boolean,timestamptz) to service_role;
revoke all on function public.pause_business_eval_journey_for_entitlement_loss(uuid,uuid) from public, anon, authenticated;
grant execute on function public.pause_business_eval_journey_for_entitlement_loss(uuid,uuid) to service_role;
revoke all on function public.claim_due_journey_schedules(text,integer,integer) from public, anon, authenticated;
grant execute on function public.claim_due_journey_schedules(text,integer,integer) to service_role;
revoke all on function public.get_business_eval_run_replay(uuid,text,uuid,uuid,uuid,text,timestamptz,uuid,uuid) from public, anon, authenticated;
grant execute on function public.get_business_eval_run_replay(uuid,text,uuid,uuid,uuid,text,timestamptz,uuid,uuid) to service_role;
revoke all on function public.enqueue_business_eval_run(uuid,uuid,uuid,uuid,text,text,timestamptz,text,integer,uuid,uuid) from public, anon, authenticated;
grant execute on function public.enqueue_business_eval_run(uuid,uuid,uuid,uuid,text,text,timestamptz,text,integer,uuid,uuid) to service_role;
revoke all on function public.claim_eval_run_for_dispatch(uuid,uuid,text,integer) from public, anon, authenticated;
grant execute on function public.claim_eval_run_for_dispatch(uuid,uuid,text,integer) to service_role;
revoke all on function public.claim_eval_runs_for_dispatch(text,integer,integer) from public, anon, authenticated;
grant execute on function public.claim_eval_runs_for_dispatch(text,integer,integer) to service_role;
revoke all on function public.attach_eval_workflow_run(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.attach_eval_workflow_run(uuid,uuid,text,text) to service_role;
revoke all on function public.release_eval_run_dispatch_lease(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.release_eval_run_dispatch_lease(uuid,uuid,text) to service_role;
revoke all on function public.cancel_business_eval_run_before_execution(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.cancel_business_eval_run_before_execution(uuid,uuid,text,text) to service_role;
revoke all on function public.claim_due_business_eval_runs(text,integer,integer) from public, anon, authenticated;
grant execute on function public.claim_due_business_eval_runs(text,integer,integer) to service_role;
revoke all on function public.claim_business_eval_run(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.claim_business_eval_run(uuid,text,integer) to service_role;
revoke all on function public.heartbeat_business_eval_run(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.heartbeat_business_eval_run(uuid,text,integer) to service_role;
revoke all on function public.begin_eval_run_side_effect_phase(uuid,text,text) from public, anon, authenticated;
grant execute on function public.begin_eval_run_side_effect_phase(uuid,text,text) to service_role;
revoke all on function public.complete_eval_run_side_effect_phase(uuid,text,text) from public, anon, authenticated;
grant execute on function public.complete_eval_run_side_effect_phase(uuid,text,text) to service_role;
revoke all on function public.complete_eval_run_side_effect_phase_at(uuid,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.complete_eval_run_side_effect_phase_at(uuid,text,text,timestamptz) to service_role;
revoke all on function public.consume_business_eval_rate_limit(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_business_eval_rate_limit(text,text,integer,integer) to service_role;
revoke all on function public.claim_business_eval_ai_request(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.claim_business_eval_ai_request(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) to service_role;
revoke all on function public.finish_business_eval_ai_request(uuid,uuid,uuid,text,jsonb,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.finish_business_eval_ai_request(uuid,uuid,uuid,text,jsonb,text,jsonb,text) to service_role;
revoke all on function public.get_business_eval_project_summaries(uuid,uuid[]) from public, anon, authenticated;
grant execute on function public.get_business_eval_project_summaries(uuid,uuid[]) to service_role;
revoke all on function public.get_business_eval_journey_summaries(uuid,uuid[]) from public, anon, authenticated;
grant execute on function public.get_business_eval_journey_summaries(uuid,uuid[]) to service_role;
revoke all on function public.get_business_eval_report_active_share_flags(uuid,uuid[]) from public, anon, authenticated;
grant execute on function public.get_business_eval_report_active_share_flags(uuid,uuid[]) to service_role;
revoke all on function public.request_business_eval_cancellation(uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.request_business_eval_cancellation(uuid,uuid,uuid,text,text) to service_role;
revoke all on function public.finalize_business_eval_run(uuid,text,jsonb,text,text,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.finalize_business_eval_run(uuid,text,jsonb,text,text,text,text,text,timestamptz) to service_role;
revoke all on function public.create_business_eval_report_snapshot(uuid,uuid,date,date,uuid,text) from public, anon, authenticated;
grant execute on function public.create_business_eval_report_snapshot(uuid,uuid,date,date,uuid,text) to service_role;
revoke all on function public.revoke_report_share_link_idempotent(uuid,uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.revoke_report_share_link_idempotent(uuid,uuid,uuid,uuid,text,text) to service_role;
revoke all on function public.consume_report_share_link(text) from public, anon, authenticated;
grant execute on function public.consume_report_share_link(text) to service_role;
revoke all on function public.claim_provider_webhook_receipt(text,text,text,text,integer) from public, anon, authenticated;
grant execute on function public.claim_provider_webhook_receipt(text,text,text,text,integer) to service_role;
revoke all on function public.finish_provider_webhook_receipt(uuid,uuid,text,boolean,text) from public, anon, authenticated;
grant execute on function public.finish_provider_webhook_receipt(uuid,uuid,text,boolean,text) to service_role;
revoke all on function public.register_browser_context_lease(uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.register_browser_context_lease(uuid,text,timestamptz) to service_role;
revoke all on function public.claim_browser_context_session(uuid,text,uuid,integer) from public, anon, authenticated;
grant execute on function public.claim_browser_context_session(uuid,text,uuid,integer) to service_role;
revoke all on function public.record_browser_context_session_started(uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.record_browser_context_session_started(uuid,text,uuid,text) to service_role;
revoke all on function public.complete_browser_context_session(uuid,text,uuid,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.complete_browser_context_session(uuid,text,uuid,text,text,timestamptz) to service_role;
revoke all on function public.mark_browser_context_released(uuid,text,text) from public, anon, authenticated;
grant execute on function public.mark_browser_context_released(uuid,text,text) to service_role;
revoke all on function public.claim_browser_context_cleanup_batch(integer,text,integer) from public, anon, authenticated;
grant execute on function public.claim_browser_context_cleanup_batch(integer,text,integer) to service_role;
revoke all on function public.complete_browser_context_cleanup(uuid,text) from public, anon, authenticated;
grant execute on function public.complete_browser_context_cleanup(uuid,text) to service_role;
revoke all on function public.retry_browser_context_cleanup(uuid,text,text,integer) from public, anon, authenticated;
grant execute on function public.retry_browser_context_cleanup(uuid,text,text,integer) to service_role;

-- A Checkout Session is a side-effecting subscription mutation. Keep one
-- durable reservation per workspace so browser retries, cross-tab requests,
-- and server restarts all converge on the same Stripe idempotency generation.
create table if not exists public.stripe_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  requested_by_user_id uuid references public.profiles(id) on delete set null,
  plan_id text not null,
  billing_interval text not null,
  billing_origin text not null,
  customer_id text not null default '',
  customer_email text not null default '',
  idempotency_key_hash text not null,
  provider_idempotency_key text not null,
  stripe_session_id text,
  checkout_url text,
  status text not null default 'creating',
  provider_expires_at timestamptz not null,
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint stripe_checkout_sessions_plan_valid check (plan_id in ('starter', 'growth', 'scale')),
  constraint stripe_checkout_sessions_interval_valid check (billing_interval in ('monthly', 'annual')),
  constraint stripe_checkout_sessions_origin_valid check (
    billing_origin ~ '^https://[^/?#[:space:]]+$'
    or billing_origin ~ '^http://(?:localhost|127[.]0[.]0[.]1)(?::[0-9]{1,5})?$'
  ),
  constraint stripe_checkout_sessions_customer_id_safe check (
    length(customer_id) <= 255 and customer_id !~ '[[:space:]]'
  ),
  constraint stripe_checkout_sessions_customer_email_safe check (
    length(customer_email) <= 320 and customer_email !~ '[\r\n]'
  ),
  constraint stripe_checkout_sessions_request_hash_valid check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  constraint stripe_checkout_sessions_provider_key_valid check (
    provider_idempotency_key ~ '^maintainflow-checkout-[a-f0-9]{64}$'
  ),
  constraint stripe_checkout_sessions_provider_id_safe check (
    stripe_session_id is null
    or (length(stripe_session_id) between 8 and 255 and stripe_session_id !~ '[[:space:]]')
  ),
  constraint stripe_checkout_sessions_url_safe check (
    checkout_url is null or checkout_url ~ '^https://checkout[.]stripe[.]com/'
  ),
  constraint stripe_checkout_sessions_status_valid check (
    status in ('creating', 'open', 'complete', 'expired', 'failed')
  ),
  constraint stripe_checkout_sessions_expiry_valid check (
    provider_expires_at > created_at and expires_at >= provider_expires_at + interval '60 seconds'
  ),
  constraint stripe_checkout_sessions_completion_valid check (
    (status = 'complete' and completed_at is not null)
    or (status <> 'complete' and completed_at is null)
  ),
  constraint stripe_checkout_sessions_agency_request_unique unique (agency_id, idempotency_key_hash),
  constraint stripe_checkout_sessions_provider_key_unique unique (provider_idempotency_key),
  constraint stripe_checkout_sessions_provider_id_unique unique (stripe_session_id)
);

comment on table public.stripe_checkout_sessions is
  'Private, workspace-wide Stripe Checkout reservation ledger. Browser idempotency keys are retained only as SHA-256 hashes.';
comment on column public.stripe_checkout_sessions.expires_at is
  'Reservation recovery deadline. It intentionally remains later than Stripe provider_expires_at.';

create index if not exists stripe_checkout_sessions_agency_created_idx
  on public.stripe_checkout_sessions (agency_id, created_at desc);
create unique index if not exists stripe_checkout_sessions_one_active_per_agency_uidx
  on public.stripe_checkout_sessions (agency_id)
  where status in ('creating', 'open');

create or replace function public.reserve_stripe_checkout_session(
  p_agency_id uuid,
  p_user_id uuid,
  p_plan_id text,
  p_billing_interval text,
  p_billing_origin text,
  p_customer_id text,
  p_customer_email text,
  p_idempotency_key_hash text,
  p_lifetime_seconds integer
)
returns setof public.stripe_checkout_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  workspace public.agencies%rowtype;
  saved public.stripe_checkout_sessions%rowtype;
  reservation_id uuid;
  reservation_time timestamptz := clock_timestamp();
  normalized_origin text := btrim(coalesce(p_billing_origin, ''));
  normalized_customer_id text := btrim(coalesce(p_customer_id, ''));
  normalized_customer_email text := lower(btrim(coalesce(p_customer_email, '')));
begin
  if p_plan_id not in ('starter', 'growth', 'scale')
    or p_billing_interval not in ('monthly', 'annual') then
    raise exception 'STRIPE_CHECKOUT_SELECTION_INVALID' using errcode = '22023';
  end if;
  if normalized_origin !~ '^https://[^/?#[:space:]]+$'
    and normalized_origin !~ '^http://(?:localhost|127[.]0[.]0[.]1)(?::[0-9]{1,5})?$' then
    raise exception 'STRIPE_CHECKOUT_ORIGIN_INVALID' using errcode = '22023';
  end if;
  if length(normalized_customer_id) > 255 or normalized_customer_id ~ '[[:space:]]'
    or length(normalized_customer_email) > 320 or normalized_customer_email ~ '[\r\n]' then
    raise exception 'STRIPE_CHECKOUT_CUSTOMER_INVALID' using errcode = '22023';
  end if;
  if p_idempotency_key_hash is null or p_idempotency_key_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'STRIPE_CHECKOUT_IDEMPOTENCY_INVALID' using errcode = '22023';
  end if;
  if p_lifetime_seconds not between 2100 and 86400 then
    raise exception 'STRIPE_CHECKOUT_LIFETIME_INVALID' using errcode = '22023';
  end if;

  select * into workspace from public.agencies where id = p_agency_id for update;
  if not found then
    raise exception 'WORKSPACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.memberships
    where agency_id = p_agency_id and user_id = p_user_id and role in ('owner', 'admin')
  ) then
    raise exception 'BILLING_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  update public.stripe_checkout_sessions reservation set
    status = 'expired',
    checkout_url = null,
    updated_at = reservation_time
  where reservation.agency_id = p_agency_id
    and reservation.status in ('creating', 'open')
    and reservation.expires_at <= reservation_time;

  select * into saved
  from public.stripe_checkout_sessions reservation
  where reservation.agency_id = p_agency_id
    and reservation.idempotency_key_hash = p_idempotency_key_hash;
  if found then
    if saved.plan_id <> p_plan_id or saved.billing_interval <> p_billing_interval then
      raise exception 'STRIPE_CHECKOUT_IDEMPOTENCY_REUSED' using errcode = '23505';
    end if;
    return query select * from public.stripe_checkout_sessions where id = saved.id;
    return;
  end if;

  if workspace.stripe_subscription_id is not null
    and coalesce(workspace.stripe_subscription_status, '') not in ('canceled', 'incomplete_expired') then
    raise exception 'STRIPE_SUBSCRIPTION_ALREADY_LINKED' using errcode = '23505';
  end if;

  select * into saved
  from public.stripe_checkout_sessions reservation
  where reservation.agency_id = p_agency_id
    and reservation.status in ('creating', 'open')
  for update;
  if found then
    return query select * from public.stripe_checkout_sessions where id = saved.id;
    return;
  end if;

  reservation_id := gen_random_uuid();
  insert into public.stripe_checkout_sessions (
    id, agency_id, requested_by_user_id, plan_id, billing_interval, billing_origin,
    customer_id, customer_email, idempotency_key_hash, provider_idempotency_key,
    provider_expires_at, expires_at, created_at, updated_at
  ) values (
    reservation_id, p_agency_id, p_user_id, p_plan_id, p_billing_interval, normalized_origin,
    normalized_customer_id, normalized_customer_email, p_idempotency_key_hash,
    'maintainflow-checkout-'
      || encode(digest('stripe-checkout:' || reservation_id::text, 'sha256'), 'hex'),
    reservation_time + make_interval(secs => p_lifetime_seconds),
    reservation_time + make_interval(secs => p_lifetime_seconds + 300),
    reservation_time, reservation_time
  ) returning * into saved;

  return query select * from public.stripe_checkout_sessions where id = saved.id;
end;
$$;

create or replace function public.record_stripe_checkout_session(
  p_agency_id uuid,
  p_reservation_id uuid,
  p_stripe_session_id text,
  p_checkout_url text,
  p_provider_expires_at timestamptz
)
returns setof public.stripe_checkout_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.stripe_checkout_sessions%rowtype;
begin
  if p_stripe_session_id is null
    or length(p_stripe_session_id) not between 8 and 255
    or p_stripe_session_id ~ '[[:space:]]'
    or p_checkout_url is null
    or p_checkout_url !~ '^https://checkout[.]stripe[.]com/' then
    raise exception 'STRIPE_CHECKOUT_PROVIDER_RESPONSE_INVALID' using errcode = '22023';
  end if;

  select * into saved from public.stripe_checkout_sessions
  where id = p_reservation_id and agency_id = p_agency_id for update;
  if not found then
    raise exception 'STRIPE_CHECKOUT_RESERVATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if saved.status not in ('creating', 'open') then
    raise exception 'STRIPE_CHECKOUT_RESERVATION_TERMINAL' using errcode = '23514';
  end if;
  if saved.stripe_session_id is not null and saved.stripe_session_id <> p_stripe_session_id then
    raise exception 'STRIPE_CHECKOUT_PROVIDER_ID_MISMATCH' using errcode = '23505';
  end if;
  if abs(extract(epoch from (saved.provider_expires_at - p_provider_expires_at))) > 5 then
    raise exception 'STRIPE_CHECKOUT_PROVIDER_EXPIRY_MISMATCH' using errcode = '23514';
  end if;

  update public.stripe_checkout_sessions reservation set
    stripe_session_id = p_stripe_session_id,
    checkout_url = p_checkout_url,
    status = 'open',
    updated_at = clock_timestamp()
  where reservation.id = saved.id;
  return query select * from public.stripe_checkout_sessions where id = saved.id;
end;
$$;

create or replace function public.get_stripe_checkout_session_for_return(
  p_agency_id uuid,
  p_user_id uuid,
  p_stripe_session_id text
)
returns setof public.stripe_checkout_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.memberships
    where agency_id = p_agency_id and user_id = p_user_id and role in ('owner', 'admin')
  ) then
    raise exception 'BILLING_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return query
    select * from public.stripe_checkout_sessions reservation
    where reservation.agency_id = p_agency_id
      and reservation.stripe_session_id = p_stripe_session_id;
end;
$$;

create or replace function public.finish_stripe_checkout_session(
  p_agency_id uuid,
  p_stripe_session_id text,
  p_status text
)
returns setof public.stripe_checkout_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.stripe_checkout_sessions%rowtype;
  finished_at timestamptz := clock_timestamp();
begin
  if p_status not in ('complete', 'expired', 'failed') then
    raise exception 'STRIPE_CHECKOUT_TERMINAL_STATUS_INVALID' using errcode = '22023';
  end if;
  select * into saved from public.stripe_checkout_sessions
  where agency_id = p_agency_id and stripe_session_id = p_stripe_session_id for update;
  if not found then return; end if;

  -- Never let an older expiry observation overwrite confirmed completion.
  if saved.status = 'complete' and p_status <> 'complete' then
    return query select * from public.stripe_checkout_sessions where id = saved.id;
    return;
  end if;

  update public.stripe_checkout_sessions reservation set
    status = p_status,
    checkout_url = null,
    completed_at = case when p_status = 'complete' then coalesce(reservation.completed_at, finished_at) else null end,
    updated_at = finished_at
  where reservation.id = saved.id;
  return query select * from public.stripe_checkout_sessions where id = saved.id;
end;
$$;

alter table public.stripe_checkout_sessions enable row level security;
revoke all on table public.stripe_checkout_sessions from public, anon, authenticated, service_role;
grant select on table public.stripe_checkout_sessions to service_role;
revoke all on function public.reserve_stripe_checkout_session(uuid,uuid,text,text,text,text,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.reserve_stripe_checkout_session(uuid,uuid,text,text,text,text,text,text,integer)
  to service_role;
revoke all on function public.record_stripe_checkout_session(uuid,uuid,text,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_stripe_checkout_session(uuid,uuid,text,text,timestamptz)
  to service_role;
revoke all on function public.get_stripe_checkout_session_for_return(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.get_stripe_checkout_session_for_return(uuid,uuid,text)
  to service_role;
revoke all on function public.finish_stripe_checkout_session(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.finish_stripe_checkout_session(uuid,text,text)
  to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'maintainflow-eval-evidence', 'maintainflow-eval-evidence', false, 52428800,
  array['image/png','image/jpeg','application/json','application/zip','text/plain','message/rfc822']
)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- No storage.objects policy is granted: all evidence object access goes through
-- an agency-authorized server route using the service role.

-- Browser-provider cost-control fresh-schema extension. Keep this block in
-- parity with maintainflow_browser_provider_cost_controls_migration.sql.

create table if not exists public.browser_provider_cost_controls (
  project_key text primary key,
  provider text not null default 'browserbase',
  browser_minutes bigint,
  proxy_bytes bigint,
  browser_minutes_limit bigint not null,
  proxy_bytes_limit bigint not null,
  warning_percent integer not null default 80,
  status text not null default 'pending',
  reason text not null default '',
  sampled_at timestamptz,
  last_daily_reconciled_at timestamptz,
  last_session_metered_at timestamptz,
  daily_claimed_by text,
  daily_claim_expires_at timestamptz,
  usage_sample_claimed_by text,
  usage_sample_claim_expires_at timestamptz,
  unresolved_metering_failures integer not null default 0,
  counter_reset_detected boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint browser_provider_cost_controls_project_key_valid check (project_key ~ '^[a-f0-9]{64}$'),
  constraint browser_provider_cost_controls_provider_valid check (provider = 'browserbase'),
  constraint browser_provider_cost_controls_usage_valid check (
    (browser_minutes is null or browser_minutes >= 0)
    and (proxy_bytes is null or proxy_bytes >= 0)
  ),
  constraint browser_provider_cost_controls_limits_valid check (
    browser_minutes_limit > 0 and proxy_bytes_limit > 0 and warning_percent between 50 and 95
  ),
  constraint browser_provider_cost_controls_status_valid check (
    status in ('pending', 'healthy', 'warning', 'blocked', 'provider_error', 'metering_error')
  ),
  constraint browser_provider_cost_controls_failures_valid check (unresolved_metering_failures >= 0)
);

alter table public.browser_provider_cost_controls
  add column if not exists usage_sample_claimed_by text;
alter table public.browser_provider_cost_controls
  add column if not exists usage_sample_claim_expires_at timestamptz;

create table if not exists public.browser_provider_session_usage (
  id uuid primary key default gen_random_uuid(),
  project_key text not null references public.browser_provider_cost_controls(project_key) on delete restrict,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  eval_run_id uuid,
  client_id uuid,
  provider text not null default 'browserbase',
  provider_session_id text not null,
  purpose text not null,
  provider_status text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  duration_ms bigint not null,
  proxy_bytes bigint not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint browser_provider_session_usage_eval_run_agency_fkey
    foreign key (eval_run_id, agency_id) references public.eval_runs(id, agency_id) on delete cascade,
  constraint browser_provider_session_usage_client_agency_fkey
    foreign key (client_id, agency_id) references public.clients(id, agency_id) on delete cascade,
  constraint browser_provider_session_usage_target_valid check (
    (purpose = 'eval_run' and eval_run_id is not null and client_id is null)
    or (purpose = 'page_scan' and eval_run_id is null and client_id is not null)
  ),
  constraint browser_provider_session_usage_provider_valid check (provider = 'browserbase'),
  constraint browser_provider_session_usage_session_id_valid check (
    length(trim(provider_session_id)) between 1 and 255
  ),
  constraint browser_provider_session_usage_status_valid check (
    provider_status in ('COMPLETED', 'ERROR', 'TIMED_OUT')
  ),
  constraint browser_provider_session_usage_metrics_valid check (
    ended_at >= started_at and duration_ms >= 0 and proxy_bytes >= 0
  ),
  constraint browser_provider_session_usage_provider_session_unique unique (provider, provider_session_id)
);

create table if not exists public.browser_provider_usage_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_key text not null references public.browser_provider_cost_controls(project_key) on delete cascade,
  provider text not null default 'browserbase',
  browser_minutes bigint not null,
  proxy_bytes bigint not null,
  control_status text not null,
  control_reason text not null default '',
  sampled_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint browser_provider_usage_snapshots_provider_valid check (provider = 'browserbase'),
  constraint browser_provider_usage_snapshots_metrics_valid check (browser_minutes >= 0 and proxy_bytes >= 0),
  constraint browser_provider_usage_snapshots_status_valid check (
    control_status in ('healthy', 'warning', 'blocked', 'provider_error', 'metering_error')
  )
);

create table if not exists public.browser_provider_session_metering_queue (
  provider_session_id text primary key,
  project_key text not null references public.browser_provider_cost_controls(project_key) on delete restrict,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  eval_run_id uuid,
  client_id uuid,
  provider text not null default 'browserbase',
  purpose text not null,
  state text not null default 'pending',
  attempt_count integer not null default 0,
  first_pending_at timestamptz not null default clock_timestamp(),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_attempt_at timestamptz,
  last_error_code text not null default '',
  claimed_by text,
  claim_expires_at timestamptz,
  resolved_usage_id uuid references public.browser_provider_session_usage(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint browser_provider_session_metering_queue_eval_run_agency_fkey
    foreign key (eval_run_id, agency_id) references public.eval_runs(id, agency_id) on delete cascade,
  constraint browser_provider_session_metering_queue_client_agency_fkey
    foreign key (client_id, agency_id) references public.clients(id, agency_id) on delete cascade,
  constraint browser_provider_session_metering_queue_target_valid check (
    (purpose = 'eval_run' and eval_run_id is not null and client_id is null)
    or (purpose = 'page_scan' and eval_run_id is null and client_id is not null)
  ),
  constraint browser_provider_session_metering_queue_provider_valid check (provider = 'browserbase'),
  constraint browser_provider_session_metering_queue_session_id_valid check (
    length(trim(provider_session_id)) between 1 and 255
  ),
  constraint browser_provider_session_metering_queue_state_valid check (
    state in ('active', 'pending', 'resolved', 'permanent_error')
  ),
  constraint browser_provider_session_metering_queue_attempt_valid check (attempt_count >= 0),
  constraint browser_provider_session_metering_queue_resolution_valid check (
    (state = 'resolved' and resolved_usage_id is not null and resolved_at is not null)
    or (state <> 'resolved' and resolved_usage_id is null and resolved_at is null)
  )
);

create table if not exists public.browser_provider_session_creation_intents (
  id uuid primary key default gen_random_uuid(),
  correlation_token text not null unique,
  project_key text not null references public.browser_provider_cost_controls(project_key) on delete restrict,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  eval_run_id uuid,
  client_id uuid,
  purpose text not null,
  state text not null default 'prepared',
  provider_session_id text,
  attempt_count integer not null default 0,
  first_uncertain_at timestamptz,
  next_reconcile_at timestamptz not null default clock_timestamp(),
  last_attempt_at timestamptz,
  last_error_code text not null default '',
  claimed_by text,
  claim_expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint browser_provider_session_creation_intents_eval_run_agency_fkey
    foreign key (eval_run_id, agency_id) references public.eval_runs(id, agency_id) on delete cascade,
  constraint browser_provider_session_creation_intents_client_agency_fkey
    foreign key (client_id, agency_id) references public.clients(id, agency_id) on delete cascade,
  constraint browser_provider_session_creation_intents_target_valid check (
    (purpose = 'eval_run' and eval_run_id is not null and client_id is null)
    or (purpose = 'page_scan' and eval_run_id is null and client_id is not null)
  ),
  constraint browser_provider_session_creation_intents_token_valid check (
    correlation_token ~ '^[A-Za-z0-9_-]{22,64}$'
  ),
  constraint browser_provider_session_creation_intents_state_valid check (
    state in ('prepared', 'uncertain', 'registered', 'not_created', 'permanent_error')
  ),
  constraint browser_provider_session_creation_intents_attempt_valid check (attempt_count >= 0),
  constraint browser_provider_session_creation_intents_resolution_valid check (
    (state = 'registered' and provider_session_id is not null and resolved_at is not null)
    or (state = 'not_created' and provider_session_id is null and resolved_at is not null)
    or (state not in ('registered', 'not_created') and provider_session_id is null and resolved_at is null)
  )
);

alter table public.browser_provider_session_metering_queue
  drop constraint if exists browser_provider_session_metering_queue_state_valid;
alter table public.browser_provider_session_metering_queue
  add constraint browser_provider_session_metering_queue_state_valid
  check (state in ('active', 'pending', 'resolved', 'permanent_error'));

create index if not exists browser_provider_session_usage_agency_month_idx
  on public.browser_provider_session_usage(agency_id, started_at desc);
create index if not exists browser_provider_session_usage_run_idx
  on public.browser_provider_session_usage(eval_run_id, started_at asc)
  where eval_run_id is not null;
create index if not exists browser_provider_usage_snapshots_project_idx
  on public.browser_provider_usage_snapshots(project_key, sampled_at desc);
drop index if exists public.browser_provider_session_metering_due_idx;
create index browser_provider_session_metering_due_idx
  on public.browser_provider_session_metering_queue(project_key, next_attempt_at, first_pending_at)
  where state in ('active', 'pending');
drop index if exists public.browser_provider_session_creation_intents_due_idx;
create index browser_provider_session_creation_intents_due_idx
  on public.browser_provider_session_creation_intents(project_key, next_reconcile_at, created_at)
  where state in ('prepared', 'uncertain');

create or replace function public.claim_browser_provider_project_usage_sample(
  p_project_key text,
  p_worker_id text,
  p_browser_minutes_limit bigint,
  p_proxy_bytes_limit bigint,
  p_warning_percent integer,
  p_lease_seconds integer default 45
)
returns table (
  claimed boolean,
  control_status text,
  control_reason text,
  may_create_session boolean,
  browser_minutes bigint,
  proxy_bytes bigint,
  sampled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.browser_provider_cost_controls%rowtype;
begin
  if p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_worker_id is null or length(trim(p_worker_id)) not between 1 and 200
    or p_browser_minutes_limit is null or p_browser_minutes_limit <= 0
    or p_proxy_bytes_limit is null or p_proxy_bytes_limit <= 0
    or p_warning_percent is null or p_warning_percent not between 50 and 95
    or p_lease_seconds is null or p_lease_seconds not between 15 and 120
  then
    raise exception 'BROWSER_PROVIDER_USAGE_SAMPLE_CLAIM_INVALID';
  end if;
  insert into public.browser_provider_cost_controls(
    project_key, browser_minutes_limit, proxy_bytes_limit, warning_percent
  ) values (
    p_project_key, p_browser_minutes_limit, p_proxy_bytes_limit, p_warning_percent
  ) on conflict (project_key) do nothing;
  select * into saved
  from public.browser_provider_cost_controls control
  where control.project_key = p_project_key
  for update;
  if saved.usage_sample_claim_expires_at is null
    or saved.usage_sample_claim_expires_at <= clock_timestamp()
  then
    update public.browser_provider_cost_controls control set
      usage_sample_claimed_by = p_worker_id,
      usage_sample_claim_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      browser_minutes_limit = p_browser_minutes_limit,
      proxy_bytes_limit = p_proxy_bytes_limit,
      warning_percent = p_warning_percent,
      updated_at = clock_timestamp()
    where control.project_key = p_project_key
    returning * into saved;
    return query select true, saved.status, saved.reason,
      saved.status in ('healthy', 'warning'), coalesce(saved.browser_minutes, 0),
      coalesce(saved.proxy_bytes, 0), saved.sampled_at;
  end if;
  return query select false, saved.status, saved.reason,
    false, coalesce(saved.browser_minutes, 0), coalesce(saved.proxy_bytes, 0), saved.sampled_at;
end;
$$;

create or replace function public.record_browser_provider_project_usage(
  p_project_key text,
  p_browser_minutes bigint,
  p_proxy_bytes bigint,
  p_browser_minutes_limit bigint,
  p_proxy_bytes_limit bigint,
  p_warning_percent integer,
  p_source text,
  p_worker_id text,
  p_sampled_at timestamptz
)
returns table (
  control_status text,
  control_reason text,
  may_create_session boolean,
  browser_minutes bigint,
  proxy_bytes bigint,
  sampled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.browser_provider_cost_controls%rowtype;
  next_status text;
  next_reason text := '';
  sampled timestamptz := coalesce(p_sampled_at, clock_timestamp());
begin
  if p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_browser_minutes is null or p_browser_minutes < 0
    or p_proxy_bytes is null or p_proxy_bytes < 0
    or p_browser_minutes_limit is null or p_browser_minutes_limit <= 0
    or p_proxy_bytes_limit is null or p_proxy_bytes_limit <= 0
    or p_warning_percent is null or p_warning_percent not between 50 and 95
    or p_source not in ('session_preflight', 'daily_reconciliation')
    or sampled > clock_timestamp() + interval '5 minutes'
  then
    raise exception 'BROWSER_PROVIDER_USAGE_SAMPLE_INVALID';
  end if;

  insert into public.browser_provider_cost_controls(
    project_key, browser_minutes_limit, proxy_bytes_limit, warning_percent
  ) values (
    p_project_key, p_browser_minutes_limit, p_proxy_bytes_limit, p_warning_percent
  ) on conflict (project_key) do nothing;

  select * into saved
  from public.browser_provider_cost_controls control
  where control.project_key = p_project_key
  for update;

  if saved.usage_sample_claimed_by is distinct from p_worker_id
    or saved.usage_sample_claim_expires_at is null
    or saved.usage_sample_claim_expires_at <= clock_timestamp()
  then
    raise exception 'BROWSER_PROVIDER_USAGE_SAMPLE_LEASE_INVALID';
  end if;

  if p_source = 'daily_reconciliation'
    and saved.daily_claimed_by is distinct from p_worker_id
  then
    raise exception 'BROWSER_PROVIDER_RECONCILIATION_LEASE_INVALID';
  end if;

  if (saved.browser_minutes is not null and p_browser_minutes < saved.browser_minutes)
    or (saved.proxy_bytes is not null and p_proxy_bytes < saved.proxy_bytes)
  then
    next_status := 'metering_error';
    next_reason := 'provider_counter_decreased';
  elsif saved.counter_reset_detected or saved.unresolved_metering_failures > 0 then
    next_status := 'metering_error';
    next_reason := case
      when saved.counter_reset_detected then 'provider_counter_decreased'
      else 'session_usage_unresolved'
    end;
  elsif exists (
    select 1 from public.browser_provider_session_creation_intents intent
    where intent.project_key = p_project_key and intent.state = 'permanent_error'
  ) then
    next_status := 'metering_error';
    next_reason := 'session_creation_unresolved';
  elsif exists (
    select 1 from public.browser_provider_session_creation_intents intent
    where intent.project_key = p_project_key and intent.state in ('prepared', 'uncertain')
  ) then
    next_status := 'provider_error';
    next_reason := case
      when exists (
        select 1 from public.browser_provider_session_creation_intents intent
        where intent.project_key = p_project_key and intent.state = 'uncertain'
      ) then 'session_creation_uncertain'
      else 'session_creation_in_progress'
    end;
  elsif exists (
    select 1 from public.browser_provider_session_metering_queue queue
    where queue.project_key = p_project_key and queue.state in ('active', 'pending')
  ) then
    next_status := 'provider_error';
    next_reason := 'session_usage_pending';
  elsif p_browser_minutes >= p_browser_minutes_limit then
    next_status := 'blocked';
    next_reason := 'browser_minutes_limit';
  elsif p_proxy_bytes >= p_proxy_bytes_limit then
    next_status := 'blocked';
    next_reason := 'proxy_bytes_limit';
  elsif p_browser_minutes::numeric * 100 >= p_browser_minutes_limit::numeric * p_warning_percent then
    next_status := 'warning';
    next_reason := 'browser_minutes_warning';
  elsif p_proxy_bytes::numeric * 100 >= p_proxy_bytes_limit::numeric * p_warning_percent then
    next_status := 'warning';
    next_reason := 'proxy_bytes_warning';
  else
    next_status := 'healthy';
  end if;

  update public.browser_provider_cost_controls control set
    browser_minutes = p_browser_minutes,
    proxy_bytes = p_proxy_bytes,
    browser_minutes_limit = p_browser_minutes_limit,
    proxy_bytes_limit = p_proxy_bytes_limit,
    warning_percent = p_warning_percent,
    status = next_status,
    reason = next_reason,
    sampled_at = sampled,
    last_daily_reconciled_at = case
      when p_source = 'daily_reconciliation' then sampled
      else control.last_daily_reconciled_at
    end,
    daily_claimed_by = case when p_source = 'daily_reconciliation' then null else control.daily_claimed_by end,
    daily_claim_expires_at = case when p_source = 'daily_reconciliation' then null else control.daily_claim_expires_at end,
    usage_sample_claimed_by = null,
    usage_sample_claim_expires_at = null,
    counter_reset_detected = control.counter_reset_detected
      or (control.browser_minutes is not null and p_browser_minutes < control.browser_minutes)
      or (control.proxy_bytes is not null and p_proxy_bytes < control.proxy_bytes),
    updated_at = clock_timestamp()
  where control.project_key = p_project_key
  returning * into saved;

  if p_source = 'daily_reconciliation' then
    insert into public.browser_provider_usage_snapshots(
      project_key, browser_minutes, proxy_bytes, control_status, control_reason, sampled_at
    ) values (
      p_project_key, p_browser_minutes, p_proxy_bytes, saved.status, saved.reason, sampled
    );
  end if;

  return query select
    saved.status,
    saved.reason,
    saved.status in ('healthy', 'warning'),
    coalesce(saved.browser_minutes, 0),
    coalesce(saved.proxy_bytes, 0),
    saved.sampled_at;
end;
$$;

create or replace function public.prepare_browser_provider_session_creation(
  p_project_key text,
  p_correlation_token text,
  p_agency_id uuid,
  p_eval_run_id uuid,
  p_client_id uuid,
  p_purpose text
)
returns table (creation_intent_id uuid, correlation_token text, replayed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_agency_id uuid;
  control_state public.browser_provider_cost_controls%rowtype;
  saved public.browser_provider_session_creation_intents%rowtype;
begin
  if p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_correlation_token is null or p_correlation_token !~ '^[A-Za-z0-9_-]{22,64}$'
  then
    raise exception 'BROWSER_PROVIDER_SESSION_CREATION_INTENT_INVALID';
  end if;
  if p_purpose = 'eval_run' and p_eval_run_id is not null and p_client_id is null then
    select run.agency_id into resolved_agency_id from public.eval_runs run where run.id = p_eval_run_id;
  elsif p_purpose = 'page_scan' and p_eval_run_id is null and p_client_id is not null then
    select project.agency_id into resolved_agency_id from public.clients project
    where project.id = p_client_id and project.archived_at is null;
  else
    raise exception 'BROWSER_PROVIDER_SESSION_TARGET_INVALID';
  end if;
  if resolved_agency_id is null or (p_agency_id is not null and p_agency_id <> resolved_agency_id) then
    raise exception 'BROWSER_PROVIDER_SESSION_TENANT_INVALID';
  end if;
  select * into control_state
  from public.browser_provider_cost_controls cost_control
  where cost_control.project_key = p_project_key
  for update;
  if not found or control_state.status not in ('healthy', 'warning') then
    raise exception 'BROWSER_PROVIDER_SESSION_CREATION_CONTROL_BLOCKED';
  end if;
  select * into saved from public.browser_provider_session_creation_intents intent
  where intent.correlation_token = p_correlation_token for update;
  if found then
    if saved.project_key <> p_project_key or saved.agency_id <> resolved_agency_id
      or saved.eval_run_id is distinct from p_eval_run_id
      or saved.client_id is distinct from p_client_id or saved.purpose <> p_purpose
    then
      raise exception 'BROWSER_PROVIDER_SESSION_CREATION_INTENT_CONFLICT';
    end if;
    return query select saved.id, saved.correlation_token, true;
    return;
  end if;
  insert into public.browser_provider_session_creation_intents(
    correlation_token, project_key, agency_id, eval_run_id, client_id, purpose
  ) values (
    p_correlation_token, p_project_key, resolved_agency_id, p_eval_run_id, p_client_id, p_purpose
  ) returning * into saved;
  update public.browser_provider_cost_controls control set
    status = 'provider_error', reason = 'session_creation_in_progress', updated_at = clock_timestamp()
  where control.project_key = p_project_key;
  return query select saved.id, saved.correlation_token, false;
end;
$$;

create or replace function public.mark_browser_provider_session_creation_uncertain(
  p_creation_intent_id uuid,
  p_project_key text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_creation_intent_id is null or p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_reason not in ('create_response_ambiguous', 'ledger_registration_failed')
  then
    raise exception 'BROWSER_PROVIDER_SESSION_CREATION_UNCERTAIN_INVALID';
  end if;
  update public.browser_provider_session_creation_intents intent set
    state = case when intent.state = 'registered' then intent.state else 'uncertain' end,
    first_uncertain_at = case
      when intent.state = 'registered' then intent.first_uncertain_at
      else coalesce(intent.first_uncertain_at, clock_timestamp())
    end,
    next_reconcile_at = case
      when intent.state = 'registered' then intent.next_reconcile_at
      else clock_timestamp() + interval '15 seconds'
    end,
    last_error_code = case when intent.state = 'registered' then intent.last_error_code else p_reason end,
    updated_at = clock_timestamp()
  where intent.id = p_creation_intent_id and intent.project_key = p_project_key;
  if not found then raise exception 'BROWSER_PROVIDER_SESSION_CREATION_INTENT_NOT_FOUND'; end if;
  update public.browser_provider_cost_controls control set
    status = case when control.counter_reset_detected or control.unresolved_metering_failures > 0
      then 'metering_error' else 'provider_error' end,
    reason = case when control.counter_reset_detected then 'provider_counter_decreased'
      when control.unresolved_metering_failures > 0 then 'session_usage_unresolved'
      else 'session_creation_uncertain' end,
    updated_at = clock_timestamp()
  where control.project_key = p_project_key;
end;
$$;

create or replace function public.claim_browser_provider_session_creation_reconciliation(
  p_project_key text,
  p_worker_id text,
  p_max_batch integer default 4,
  p_lease_seconds integer default 120
)
returns table (
  creation_intent_id uuid,
  correlation_token text,
  agency_id uuid,
  eval_run_id uuid,
  client_id uuid,
  purpose text,
  attempt_count integer,
  first_uncertain_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_worker_id is null or length(trim(p_worker_id)) not between 1 and 200
    or p_max_batch is null or p_max_batch not between 1 and 10
    or p_lease_seconds is null or p_lease_seconds not between 30 and 300
  then
    raise exception 'BROWSER_PROVIDER_SESSION_CREATION_CLAIM_INVALID';
  end if;
  return query
  with due as (
    select intent.id from public.browser_provider_session_creation_intents intent
    where intent.project_key = p_project_key
      and (
        (intent.state = 'uncertain' and intent.next_reconcile_at <= clock_timestamp())
        or (intent.state = 'prepared' and intent.created_at <= clock_timestamp() - interval '60 seconds')
      )
      and (intent.claim_expires_at is null or intent.claim_expires_at <= clock_timestamp())
    order by intent.next_reconcile_at, intent.created_at, intent.id
    for update skip locked limit p_max_batch
  ), claimed as (
    update public.browser_provider_session_creation_intents intent set
      state = 'uncertain',
      first_uncertain_at = coalesce(intent.first_uncertain_at, clock_timestamp()),
      last_error_code = case
        when intent.state = 'prepared' then 'prepared_worker_abandoned'
        else intent.last_error_code
      end,
      claimed_by = p_worker_id,
      claim_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = clock_timestamp()
    from due where intent.id = due.id returning intent.*
  )
  select claimed.id, claimed.correlation_token, claimed.agency_id, claimed.eval_run_id,
    claimed.client_id, claimed.purpose, claimed.attempt_count, claimed.first_uncertain_at
  from claimed order by claimed.created_at, claimed.id;
end;
$$;

create or replace function public.defer_browser_provider_session_creation_reconciliation(
  p_creation_intent_id uuid,
  p_project_key text,
  p_worker_id text,
  p_max_attempts integer,
  p_max_age_minutes integer,
  p_retry_delay_seconds integer,
  p_error_code text,
  p_attempted_at timestamptz
)
returns table (creation_state text, attempt_count integer, resolved_absent boolean, permanent boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.browser_provider_session_creation_intents%rowtype;
  attempted timestamptz := coalesce(p_attempted_at, clock_timestamp());
  next_attempts integer;
  threshold_reached boolean;
  next_state text;
begin
  if p_creation_intent_id is null or p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_worker_id is null or length(trim(p_worker_id)) not between 1 and 200
    or p_max_attempts is null or p_max_attempts not between 3 and 100
    or p_max_age_minutes is null or p_max_age_minutes not between 15 and 1440
    or p_retry_delay_seconds is null or p_retry_delay_seconds not between 5 and 900
    or p_error_code not in ('not_found', 'provider_unavailable', 'multiple_matches')
  then
    raise exception 'BROWSER_PROVIDER_SESSION_CREATION_DEFER_INVALID';
  end if;
  select * into saved from public.browser_provider_session_creation_intents intent
  where intent.id = p_creation_intent_id and intent.project_key = p_project_key for update;
  if not found then raise exception 'BROWSER_PROVIDER_SESSION_CREATION_INTENT_NOT_FOUND'; end if;
  if saved.state <> 'uncertain' then
    return query select saved.state, saved.attempt_count, saved.state = 'not_created', saved.state = 'permanent_error';
    return;
  end if;
  if saved.claimed_by is distinct from p_worker_id or saved.claim_expires_at is null
    or saved.claim_expires_at <= attempted
  then
    raise exception 'BROWSER_PROVIDER_SESSION_CREATION_LEASE_INVALID';
  end if;
  next_attempts := saved.attempt_count + 1;
  threshold_reached := next_attempts >= p_max_attempts
    or coalesce(saved.first_uncertain_at, saved.created_at) <= attempted - make_interval(mins => p_max_age_minutes);
  next_state := case
    when threshold_reached and p_error_code = 'not_found' then 'not_created'
    when threshold_reached then 'permanent_error'
    else 'uncertain'
  end;
  update public.browser_provider_session_creation_intents intent set
    state = next_state,
    attempt_count = next_attempts,
    last_attempt_at = attempted,
    last_error_code = p_error_code,
    next_reconcile_at = case when threshold_reached then attempted
      else attempted + make_interval(secs => p_retry_delay_seconds) end,
    claimed_by = null,
    claim_expires_at = null,
    resolved_at = case when next_state = 'not_created' then attempted else null end,
    updated_at = clock_timestamp()
  where intent.id = saved.id returning * into saved;
  update public.browser_provider_cost_controls control set
    unresolved_metering_failures = control.unresolved_metering_failures
      + case when next_state = 'permanent_error' then 1 else 0 end,
    status = case
      when next_state = 'permanent_error' or control.counter_reset_detected
        or control.unresolved_metering_failures > 0 then 'metering_error'
      when next_state = 'uncertain' then 'provider_error'
      when exists (select 1 from public.browser_provider_session_metering_queue queue
        where queue.project_key = p_project_key and queue.state in ('active', 'pending')) then 'provider_error'
      when control.browser_minutes is null or control.proxy_bytes is null then 'pending'
      when control.browser_minutes >= control.browser_minutes_limit or control.proxy_bytes >= control.proxy_bytes_limit then 'blocked'
      else 'healthy'
    end,
    reason = case
      when next_state = 'permanent_error' then 'session_creation_unresolved'
      when control.counter_reset_detected then 'provider_counter_decreased'
      when control.unresolved_metering_failures > 0 then 'session_usage_unresolved'
      when next_state = 'uncertain' then 'session_creation_uncertain'
      when exists (select 1 from public.browser_provider_session_metering_queue queue
        where queue.project_key = p_project_key and queue.state in ('active', 'pending')) then 'session_usage_pending'
      else ''
    end,
    updated_at = clock_timestamp()
  where control.project_key = p_project_key;
  return query select saved.state, saved.attempt_count, saved.state = 'not_created', saved.state = 'permanent_error';
end;
$$;

create or replace function public.record_browser_provider_session_usage(
  p_project_key text,
  p_provider_session_id text,
  p_agency_id uuid,
  p_eval_run_id uuid,
  p_client_id uuid,
  p_purpose text,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_proxy_bytes bigint,
  p_provider_status text
)
returns table (
  metering_ok boolean,
  replayed boolean,
  duration_ms bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_agency_id uuid;
  measured_duration_ms bigint;
  existing public.browser_provider_session_usage%rowtype;
  metering public.browser_provider_session_metering_queue%rowtype;
  recorded_usage_id uuid;
  was_replayed boolean := false;
begin
  if p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_provider_session_id is null or length(trim(p_provider_session_id)) not between 1 and 255
    or p_started_at is null or p_ended_at is null or p_ended_at < p_started_at
    or p_proxy_bytes is null or p_proxy_bytes < 0
    or p_provider_status not in ('COMPLETED', 'ERROR', 'TIMED_OUT')
  then
    raise exception 'BROWSER_PROVIDER_SESSION_USAGE_INVALID';
  end if;

  measured_duration_ms := round(extract(epoch from (p_ended_at - p_started_at)) * 1000)::bigint;
  if p_purpose = 'eval_run' and p_eval_run_id is not null and p_client_id is null then
    select run.agency_id into resolved_agency_id
    from public.eval_runs run
    where run.id = p_eval_run_id;
  elsif p_purpose = 'page_scan' and p_eval_run_id is null and p_client_id is not null then
    select project.agency_id into resolved_agency_id
    from public.clients project
    where project.id = p_client_id and project.archived_at is null;
  else
    raise exception 'BROWSER_PROVIDER_SESSION_TARGET_INVALID';
  end if;
  if resolved_agency_id is null or (p_agency_id is not null and p_agency_id <> resolved_agency_id) then
    raise exception 'BROWSER_PROVIDER_SESSION_TENANT_INVALID';
  end if;
  if not exists (
    select 1 from public.browser_provider_cost_controls control
    where control.project_key = p_project_key
  ) then
    raise exception 'BROWSER_PROVIDER_COST_CONTROL_MISSING';
  end if;

  select * into metering
  from public.browser_provider_session_metering_queue queue
  where queue.provider_session_id = p_provider_session_id
  for update;
  if not found then
    raise exception 'BROWSER_PROVIDER_SESSION_METERING_NOT_REGISTERED';
  end if;
  if metering.project_key <> p_project_key
    or metering.agency_id <> resolved_agency_id
    or metering.eval_run_id is distinct from p_eval_run_id
    or metering.client_id is distinct from p_client_id
    or metering.purpose <> p_purpose
  then
    update public.browser_provider_cost_controls control set
      unresolved_metering_failures = control.unresolved_metering_failures + 1,
      status = 'metering_error',
      reason = 'session_usage_conflict',
      updated_at = clock_timestamp()
    where control.project_key = p_project_key;
    return query select false, true, measured_duration_ms;
    return;
  end if;
  if metering.state = 'permanent_error' then
    raise exception 'BROWSER_PROVIDER_SESSION_METERING_REOPEN_REQUIRED';
  end if;

  select * into existing
  from public.browser_provider_session_usage usage
  where usage.provider = 'browserbase' and usage.provider_session_id = p_provider_session_id
  for update;

  if found then
    if existing.project_key = p_project_key
      and existing.agency_id = resolved_agency_id
      and existing.eval_run_id is not distinct from p_eval_run_id
      and existing.client_id is not distinct from p_client_id
      and existing.purpose = p_purpose
      and existing.provider_status = p_provider_status
      and existing.started_at = p_started_at
      and existing.ended_at = p_ended_at
      and existing.duration_ms = measured_duration_ms
      and existing.proxy_bytes = p_proxy_bytes
    then
      recorded_usage_id := existing.id;
      was_replayed := true;
    else
      update public.browser_provider_cost_controls control set
        unresolved_metering_failures = control.unresolved_metering_failures + 1,
        status = 'metering_error',
        reason = 'session_usage_conflict',
        updated_at = clock_timestamp()
      where control.project_key = p_project_key;
      return query select false, true, measured_duration_ms;
      return;
    end if;
  else
    insert into public.browser_provider_session_usage(
      project_key, agency_id, eval_run_id, client_id, provider_session_id,
      purpose, provider_status, started_at, ended_at, duration_ms, proxy_bytes
    ) values (
      p_project_key, resolved_agency_id, p_eval_run_id, p_client_id, p_provider_session_id,
      p_purpose, p_provider_status, p_started_at, p_ended_at, measured_duration_ms, p_proxy_bytes
    ) returning id into recorded_usage_id;
  end if;

  update public.browser_provider_session_metering_queue queue set
    state = 'resolved',
    resolved_usage_id = recorded_usage_id,
    resolved_at = clock_timestamp(),
    claimed_by = null,
    claim_expires_at = null,
    last_error_code = '',
    updated_at = clock_timestamp()
  where queue.provider_session_id = p_provider_session_id
    and queue.project_key = p_project_key
    and queue.agency_id = resolved_agency_id
    and queue.eval_run_id is not distinct from p_eval_run_id
    and queue.client_id is not distinct from p_client_id
    and queue.purpose = p_purpose;

  update public.browser_provider_cost_controls control set
    last_session_metered_at = clock_timestamp(),
    status = case
      when control.counter_reset_detected or control.unresolved_metering_failures > 0
        or exists (
          select 1 from public.browser_provider_session_metering_queue queue
          where queue.project_key = p_project_key and queue.state = 'permanent_error'
        ) then 'metering_error'
      when exists (
        select 1 from public.browser_provider_session_creation_intents intent
        where intent.project_key = p_project_key and intent.state = 'permanent_error'
      ) then 'metering_error'
      when exists (
        select 1 from public.browser_provider_session_metering_queue queue
        where queue.project_key = p_project_key and queue.state in ('active', 'pending')
      ) or exists (
        select 1 from public.browser_provider_session_creation_intents intent
        where intent.project_key = p_project_key and intent.state in ('prepared', 'uncertain')
      ) then 'provider_error'
      when control.browser_minutes is null or control.proxy_bytes is null then 'pending'
      when control.browser_minutes >= control.browser_minutes_limit then 'blocked'
      when control.proxy_bytes >= control.proxy_bytes_limit then 'blocked'
      when control.browser_minutes::numeric * 100 >= control.browser_minutes_limit::numeric * control.warning_percent then 'warning'
      when control.proxy_bytes::numeric * 100 >= control.proxy_bytes_limit::numeric * control.warning_percent then 'warning'
      else 'healthy'
    end,
    reason = case
      when control.counter_reset_detected then 'provider_counter_decreased'
      when control.unresolved_metering_failures > 0
        or exists (
          select 1 from public.browser_provider_session_metering_queue queue
          where queue.project_key = p_project_key and queue.state = 'permanent_error'
        ) then 'session_usage_unresolved'
      when exists (
        select 1 from public.browser_provider_session_creation_intents intent
        where intent.project_key = p_project_key and intent.state = 'permanent_error'
      ) then 'session_creation_unresolved'
      when exists (
        select 1 from public.browser_provider_session_creation_intents intent
        where intent.project_key = p_project_key and intent.state = 'uncertain'
      ) then 'session_creation_uncertain'
      when exists (
        select 1 from public.browser_provider_session_creation_intents intent
        where intent.project_key = p_project_key and intent.state = 'prepared'
      ) then 'session_creation_in_progress'
      when exists (
        select 1 from public.browser_provider_session_metering_queue queue
        where queue.project_key = p_project_key and queue.state in ('active', 'pending')
      ) then 'session_usage_pending'
      when control.browser_minutes is null or control.proxy_bytes is null then ''
      when control.browser_minutes >= control.browser_minutes_limit then 'browser_minutes_limit'
      when control.proxy_bytes >= control.proxy_bytes_limit then 'proxy_bytes_limit'
      when control.browser_minutes::numeric * 100 >= control.browser_minutes_limit::numeric * control.warning_percent then 'browser_minutes_warning'
      when control.proxy_bytes::numeric * 100 >= control.proxy_bytes_limit::numeric * control.warning_percent then 'proxy_bytes_warning'
      else ''
    end,
    updated_at = clock_timestamp()
  where control.project_key = p_project_key;
  return query select true, was_replayed, measured_duration_ms;
end;
$$;

create or replace function public.queue_browser_provider_session_metering(
  p_project_key text,
  p_provider_session_id text,
  p_agency_id uuid,
  p_eval_run_id uuid,
  p_client_id uuid,
  p_purpose text
)
returns table (
  metering_state text,
  replayed boolean,
  attempt_count integer,
  first_pending_at timestamptz,
  duration_ms bigint,
  proxy_bytes bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_agency_id uuid;
  existing public.browser_provider_session_metering_queue%rowtype;
  recorded public.browser_provider_session_usage%rowtype;
begin
  if p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_provider_session_id is null or length(trim(p_provider_session_id)) not between 1 and 255
  then
    raise exception 'BROWSER_PROVIDER_SESSION_METERING_QUEUE_INVALID';
  end if;
  if p_purpose = 'eval_run' and p_eval_run_id is not null and p_client_id is null then
    select run.agency_id into resolved_agency_id
    from public.eval_runs run where run.id = p_eval_run_id;
  elsif p_purpose = 'page_scan' and p_eval_run_id is null and p_client_id is not null then
    select project.agency_id into resolved_agency_id
    from public.clients project where project.id = p_client_id and project.archived_at is null;
  else
    raise exception 'BROWSER_PROVIDER_SESSION_TARGET_INVALID';
  end if;
  if resolved_agency_id is null or (p_agency_id is not null and p_agency_id <> resolved_agency_id) then
    raise exception 'BROWSER_PROVIDER_SESSION_TENANT_INVALID';
  end if;
  if not exists (
    select 1 from public.browser_provider_cost_controls control where control.project_key = p_project_key
  ) then
    raise exception 'BROWSER_PROVIDER_COST_CONTROL_MISSING';
  end if;

  select * into existing
  from public.browser_provider_session_metering_queue queue
  where queue.provider_session_id = p_provider_session_id
  for update;
  if found then
    if existing.project_key <> p_project_key
      or existing.agency_id <> resolved_agency_id
      or existing.eval_run_id is distinct from p_eval_run_id
      or existing.client_id is distinct from p_client_id
      or existing.purpose <> p_purpose
    then
      raise exception 'BROWSER_PROVIDER_SESSION_METERING_QUEUE_CONFLICT';
    end if;
    if existing.resolved_usage_id is not null then
      select * into recorded from public.browser_provider_session_usage usage
      where usage.id = existing.resolved_usage_id;
    end if;
    return query select existing.state, true, existing.attempt_count, existing.first_pending_at,
      recorded.duration_ms, recorded.proxy_bytes;
    return;
  end if;

  select * into recorded
  from public.browser_provider_session_usage usage
  where usage.provider = 'browserbase' and usage.provider_session_id = p_provider_session_id;
  if found then
    if recorded.project_key <> p_project_key
      or recorded.agency_id <> resolved_agency_id
      or recorded.eval_run_id is distinct from p_eval_run_id
      or recorded.client_id is distinct from p_client_id
      or recorded.purpose <> p_purpose
    then
      raise exception 'BROWSER_PROVIDER_SESSION_METERING_QUEUE_CONFLICT';
    end if;
    insert into public.browser_provider_session_metering_queue(
      provider_session_id, project_key, agency_id, eval_run_id, client_id, purpose,
      state, resolved_usage_id, resolved_at
    ) values (
      p_provider_session_id, p_project_key, resolved_agency_id, p_eval_run_id, p_client_id, p_purpose,
      'resolved', recorded.id, recorded.recorded_at
    ) returning * into existing;
    return query select existing.state, true, existing.attempt_count, existing.first_pending_at,
      recorded.duration_ms, recorded.proxy_bytes;
    return;
  end if;

  insert into public.browser_provider_session_metering_queue(
    provider_session_id, project_key, agency_id, eval_run_id, client_id, purpose
  ) values (
    p_provider_session_id, p_project_key, resolved_agency_id, p_eval_run_id, p_client_id, p_purpose
  ) returning * into existing;
  update public.browser_provider_cost_controls control set
    status = case
      when control.counter_reset_detected or control.unresolved_metering_failures > 0 then 'metering_error'
      else 'provider_error'
    end,
    reason = case
      when control.counter_reset_detected then 'provider_counter_decreased'
      when control.unresolved_metering_failures > 0 then 'session_usage_unresolved'
      else 'session_usage_pending'
    end,
    updated_at = clock_timestamp()
  where control.project_key = p_project_key;
  return query select existing.state, false, existing.attempt_count, existing.first_pending_at,
    null::bigint, null::bigint;
end;
$$;

drop function if exists public.register_browser_provider_session_metering(text,text,uuid,uuid,uuid,text,text,integer);
create or replace function public.register_browser_provider_session_metering(
  p_project_key text,
  p_provider_session_id text,
  p_agency_id uuid,
  p_eval_run_id uuid,
  p_client_id uuid,
  p_purpose text,
  p_creation_intent_id uuid,
  p_correlation_token text,
  p_worker_id text,
  p_active_timeout_seconds integer default 360
)
returns table (
  metering_state text,
  replayed boolean,
  attempt_count integer,
  first_pending_at timestamptz,
  duration_ms bigint,
  proxy_bytes bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  queued public.browser_provider_session_metering_queue%rowtype;
  intent public.browser_provider_session_creation_intents%rowtype;
  was_replayed boolean;
begin
  if p_creation_intent_id is null
    or p_correlation_token is null or p_correlation_token !~ '^[A-Za-z0-9_-]{22,64}$'
    or p_worker_id is null or length(trim(p_worker_id)) not between 1 and 200
    or p_active_timeout_seconds is null or p_active_timeout_seconds not between 330 and 600
  then
    raise exception 'BROWSER_PROVIDER_SESSION_METERING_REGISTRATION_INVALID';
  end if;
  select * into intent
  from public.browser_provider_session_creation_intents creation
  where creation.id = p_creation_intent_id
  for update;
  if not found then raise exception 'BROWSER_PROVIDER_SESSION_CREATION_INTENT_NOT_FOUND'; end if;
  if intent.project_key <> p_project_key
    or intent.correlation_token <> p_correlation_token
    or (p_agency_id is not null and intent.agency_id <> p_agency_id)
    or intent.eval_run_id is distinct from p_eval_run_id
    or intent.client_id is distinct from p_client_id
    or intent.purpose <> p_purpose
    or intent.state not in ('prepared', 'uncertain', 'registered')
    or (intent.state = 'registered' and intent.provider_session_id <> p_provider_session_id)
  then
    raise exception 'BROWSER_PROVIDER_SESSION_CREATION_INTENT_CONFLICT';
  end if;
  perform public.queue_browser_provider_session_metering(
    p_project_key, p_provider_session_id, p_agency_id, p_eval_run_id, p_client_id, p_purpose
  );
  select * into queued
  from public.browser_provider_session_metering_queue queue
  where queue.provider_session_id = p_provider_session_id and queue.project_key = p_project_key
  for update;
  if not found then raise exception 'BROWSER_PROVIDER_SESSION_METERING_NOT_FOUND'; end if;
  was_replayed := queued.state <> 'pending' or queued.attempt_count > 0
    or queued.claimed_by is not null;
  if queued.state = 'pending' and queued.attempt_count = 0
    and (queued.claimed_by is null or queued.claimed_by = p_worker_id)
  then
    update public.browser_provider_session_metering_queue queue set
      state = 'active',
      claimed_by = p_worker_id,
      claim_expires_at = clock_timestamp() + make_interval(secs => p_active_timeout_seconds),
      next_attempt_at = clock_timestamp() + make_interval(secs => p_active_timeout_seconds),
      updated_at = clock_timestamp()
    where queue.provider_session_id = p_provider_session_id
    returning * into queued;
  elsif queued.state = 'active' and queued.claimed_by = p_worker_id then
    was_replayed := true;
  elsif queued.state not in ('resolved', 'permanent_error') then
    raise exception 'BROWSER_PROVIDER_SESSION_METERING_REGISTRATION_CONFLICT';
  end if;
  update public.browser_provider_session_creation_intents creation set
    state = 'registered',
    provider_session_id = p_provider_session_id,
    claimed_by = null,
    claim_expires_at = null,
    resolved_at = coalesce(creation.resolved_at, clock_timestamp()),
    updated_at = clock_timestamp()
  where creation.id = intent.id;
  return query select queued.state, was_replayed, queued.attempt_count, queued.first_pending_at,
    usage.duration_ms, usage.proxy_bytes
  from (select 1) singleton
  left join public.browser_provider_session_usage usage on usage.id = queued.resolved_usage_id;
end;
$$;

create or replace function public.begin_browser_provider_session_terminal_metering(
  p_project_key text,
  p_provider_session_id text,
  p_worker_id text,
  p_lease_seconds integer default 30
)
returns table (metering_state text, attempt_count integer, claimed_until timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.browser_provider_session_metering_queue%rowtype;
begin
  if p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_provider_session_id is null or length(trim(p_provider_session_id)) not between 1 and 255
    or p_worker_id is null or length(trim(p_worker_id)) not between 1 and 200
    or p_lease_seconds is null or p_lease_seconds not between 15 and 120
  then
    raise exception 'BROWSER_PROVIDER_SESSION_TERMINAL_METERING_INVALID';
  end if;
  select * into saved
  from public.browser_provider_session_metering_queue queue
  where queue.provider_session_id = p_provider_session_id and queue.project_key = p_project_key
  for update;
  if not found then raise exception 'BROWSER_PROVIDER_SESSION_METERING_NOT_FOUND'; end if;
  if saved.state in ('resolved', 'permanent_error') then
    return query select saved.state, saved.attempt_count, saved.claim_expires_at;
    return;
  end if;
  if saved.claimed_by is distinct from p_worker_id then
    raise exception 'BROWSER_PROVIDER_SESSION_METERING_LEASE_INVALID';
  end if;
  update public.browser_provider_session_metering_queue queue set
    state = 'pending',
    next_attempt_at = clock_timestamp(),
    claimed_by = p_worker_id,
    claim_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
    updated_at = clock_timestamp()
  where queue.provider_session_id = p_provider_session_id
  returning * into saved;
  return query select saved.state, saved.attempt_count, saved.claim_expires_at;
end;
$$;

create or replace function public.claim_browser_provider_session_metering(
  p_project_key text,
  p_worker_id text,
  p_max_batch integer default 4,
  p_lease_seconds integer default 120
)
returns table (
  provider_session_id text,
  agency_id uuid,
  eval_run_id uuid,
  client_id uuid,
  purpose text,
  attempt_count integer,
  first_pending_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_worker_id is null or length(trim(p_worker_id)) not between 1 and 200
    or p_max_batch is null or p_max_batch not between 1 and 10
    or p_lease_seconds is null or p_lease_seconds not between 30 and 300
  then
    raise exception 'BROWSER_PROVIDER_SESSION_METERING_CLAIM_INVALID';
  end if;
  return query
  with due as (
    select queue.provider_session_id
    from public.browser_provider_session_metering_queue queue
    where queue.project_key = p_project_key
      and queue.state in ('active', 'pending')
      and queue.next_attempt_at <= clock_timestamp()
      and (queue.claim_expires_at is null or queue.claim_expires_at <= clock_timestamp())
    order by queue.next_attempt_at, queue.first_pending_at, queue.provider_session_id
    for update skip locked
    limit p_max_batch
  ), claimed as (
    update public.browser_provider_session_metering_queue queue set
      claimed_by = p_worker_id,
      claim_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = clock_timestamp()
    from due
    where queue.provider_session_id = due.provider_session_id
    returning queue.*
  )
  select claimed.provider_session_id, claimed.agency_id, claimed.eval_run_id,
    claimed.client_id, claimed.purpose, claimed.attempt_count, claimed.first_pending_at
  from claimed
  order by claimed.next_attempt_at, claimed.first_pending_at, claimed.provider_session_id;
end;
$$;

create or replace function public.defer_browser_provider_session_metering(
  p_project_key text,
  p_provider_session_id text,
  p_worker_id text,
  p_max_attempts integer,
  p_max_age_minutes integer,
  p_retry_delay_seconds integer,
  p_error_code text,
  p_attempted_at timestamptz
)
returns table (
  metering_state text,
  attempt_count integer,
  escalated boolean,
  next_attempt_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.browser_provider_session_metering_queue%rowtype;
  attempted timestamptz := coalesce(p_attempted_at, clock_timestamp());
  next_attempts integer;
  make_permanent boolean;
begin
  if p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_provider_session_id is null or length(trim(p_provider_session_id)) not between 1 and 255
    or (p_worker_id is not null and length(trim(p_worker_id)) not between 1 and 200)
    or p_max_attempts is null or p_max_attempts not between 3 and 100
    or p_max_age_minutes is null or p_max_age_minutes not between 15 and 1440
    or p_retry_delay_seconds is null or p_retry_delay_seconds not between 5 and 900
    or p_error_code not in ('not_terminal', 'provider_unavailable', 'invalid_terminal_record')
    or attempted > clock_timestamp() + interval '5 minutes'
  then
    raise exception 'BROWSER_PROVIDER_SESSION_METERING_DEFER_INVALID';
  end if;
  select * into saved
  from public.browser_provider_session_metering_queue queue
  where queue.provider_session_id = p_provider_session_id and queue.project_key = p_project_key
  for update;
  if not found then raise exception 'BROWSER_PROVIDER_SESSION_METERING_NOT_FOUND'; end if;
  if saved.state not in ('active', 'pending') then
    return query select saved.state, saved.attempt_count, saved.state = 'permanent_error', saved.next_attempt_at;
    return;
  end if;
  if p_worker_id is null then
    if saved.claim_expires_at is not null and saved.claim_expires_at > attempted then
      raise exception 'BROWSER_PROVIDER_SESSION_METERING_LEASE_INVALID';
    end if;
  elsif saved.claimed_by is distinct from p_worker_id
    or saved.claim_expires_at is null or saved.claim_expires_at <= attempted
  then
    raise exception 'BROWSER_PROVIDER_SESSION_METERING_LEASE_INVALID';
  end if;

  next_attempts := saved.attempt_count + 1;
  make_permanent := next_attempts >= p_max_attempts
    or saved.first_pending_at <= attempted - make_interval(mins => p_max_age_minutes);
  update public.browser_provider_session_metering_queue queue set
    state = case when make_permanent then 'permanent_error' else 'pending' end,
    attempt_count = next_attempts,
    last_attempt_at = attempted,
    last_error_code = p_error_code,
    next_attempt_at = case
      when make_permanent then attempted
      else attempted + make_interval(secs => p_retry_delay_seconds)
    end,
    claimed_by = null,
    claim_expires_at = null,
    updated_at = clock_timestamp()
  where queue.provider_session_id = saved.provider_session_id
  returning * into saved;

  update public.browser_provider_cost_controls control set
    unresolved_metering_failures = control.unresolved_metering_failures + case when make_permanent then 1 else 0 end,
    status = case when make_permanent or control.counter_reset_detected
      or control.unresolved_metering_failures > 0 then 'metering_error' else 'provider_error' end,
    reason = case
      when control.counter_reset_detected then 'provider_counter_decreased'
      when make_permanent or control.unresolved_metering_failures > 0 then 'session_usage_unresolved'
      else 'session_usage_pending'
    end,
    updated_at = clock_timestamp()
  where control.project_key = p_project_key;
  return query select saved.state, saved.attempt_count, make_permanent, saved.next_attempt_at;
end;
$$;

create or replace function public.reopen_browser_provider_session_metering(
  p_project_key text,
  p_provider_session_id text,
  p_expected_attempt_count integer,
  p_operator_reason text,
  p_actor_user_id uuid
)
returns table (reopened boolean, replayed boolean, metering_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.browser_provider_session_metering_queue%rowtype;
  remaining_failures integer;
begin
  if p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_provider_session_id is null or length(trim(p_provider_session_id)) not between 1 and 255
    or p_expected_attempt_count is null or p_expected_attempt_count < 1
    or p_operator_reason is null or length(trim(p_operator_reason)) not between 20 and 500
    or p_actor_user_id is null
  then
    raise exception 'BROWSER_PROVIDER_SESSION_METERING_REOPEN_INVALID';
  end if;
  select * into saved
  from public.browser_provider_session_metering_queue queue
  where queue.provider_session_id = p_provider_session_id and queue.project_key = p_project_key
  for update;
  if not found then raise exception 'BROWSER_PROVIDER_SESSION_METERING_NOT_FOUND'; end if;
  if saved.state = 'pending' and saved.attempt_count = 0 and saved.last_error_code = 'operator_reopened' then
    return query select false, true, saved.state;
    return;
  end if;
  if saved.state <> 'permanent_error' or saved.attempt_count <> p_expected_attempt_count then
    raise exception 'BROWSER_PROVIDER_SESSION_METERING_REOPEN_CONFLICT';
  end if;
  if not exists (
    select 1 from public.memberships membership
    where membership.agency_id = saved.agency_id
      and membership.user_id = p_actor_user_id
      and membership.role in ('owner'::public.agency_role, 'admin'::public.agency_role)
  ) then
    raise exception 'BROWSER_PROVIDER_SESSION_METERING_REOPEN_ACTOR_UNAUTHORIZED';
  end if;
  update public.browser_provider_session_metering_queue queue set
    state = 'pending',
    attempt_count = 0,
    next_attempt_at = clock_timestamp(),
    last_attempt_at = null,
    last_error_code = 'operator_reopened',
    claimed_by = null,
    claim_expires_at = null,
    updated_at = clock_timestamp()
  where queue.provider_session_id = saved.provider_session_id
  returning * into saved;
  update public.browser_provider_cost_controls control set
    unresolved_metering_failures = greatest(0, control.unresolved_metering_failures - 1),
    status = case
      when control.counter_reset_detected or control.unresolved_metering_failures > 1 then 'metering_error'
      else 'provider_error'
    end,
    reason = case
      when control.counter_reset_detected then 'provider_counter_decreased'
      when control.unresolved_metering_failures > 1 then 'session_usage_unresolved'
      else 'session_usage_pending'
    end,
    updated_at = clock_timestamp()
  where control.project_key = p_project_key
  returning unresolved_metering_failures into remaining_failures;
  insert into public.audit_events(
    agency_id, actor_user_id, entity_type, entity_id, action, metadata_json
  ) values (
    saved.agency_id, p_actor_user_id, 'browser_provider_session_metering',
    coalesce(saved.eval_run_id, saved.client_id), 'browser_provider_session_metering_reopened',
    jsonb_build_object(
      'operatorReason', trim(p_operator_reason),
      'expectedAttemptCount', p_expected_attempt_count,
      'remainingPermanentFailures', remaining_failures
    )
  );
  return query select true, false, saved.state;
end;
$$;

create or replace function public.reopen_browser_provider_session_creation_reconciliation(
  p_creation_intent_id uuid,
  p_project_key text,
  p_expected_attempt_count integer,
  p_operator_reason text,
  p_actor_user_id uuid
)
returns table (reopened boolean, replayed boolean, creation_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.browser_provider_session_creation_intents%rowtype;
  remaining_failures integer;
begin
  if p_creation_intent_id is null
    or p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_expected_attempt_count is null or p_expected_attempt_count < 1
    or p_operator_reason is null or length(trim(p_operator_reason)) not between 20 and 500
    or p_actor_user_id is null
  then
    raise exception 'BROWSER_PROVIDER_SESSION_CREATION_REOPEN_INVALID';
  end if;
  select * into saved
  from public.browser_provider_session_creation_intents intent
  where intent.id = p_creation_intent_id and intent.project_key = p_project_key
  for update;
  if not found then raise exception 'BROWSER_PROVIDER_SESSION_CREATION_INTENT_NOT_FOUND'; end if;
  if saved.state = 'uncertain' and saved.attempt_count = 0
    and saved.last_error_code = 'operator_reopened'
  then
    return query select false, true, saved.state;
    return;
  end if;
  if saved.state <> 'permanent_error' or saved.attempt_count <> p_expected_attempt_count then
    raise exception 'BROWSER_PROVIDER_SESSION_CREATION_REOPEN_CONFLICT';
  end if;
  if not exists (
    select 1 from public.memberships membership
    where membership.agency_id = saved.agency_id
      and membership.user_id = p_actor_user_id
      and membership.role in ('owner'::public.agency_role, 'admin'::public.agency_role)
  ) then
    raise exception 'BROWSER_PROVIDER_SESSION_CREATION_REOPEN_ACTOR_UNAUTHORIZED';
  end if;
  update public.browser_provider_session_creation_intents intent set
    state = 'uncertain',
    attempt_count = 0,
    first_uncertain_at = clock_timestamp(),
    next_reconcile_at = clock_timestamp(),
    last_attempt_at = null,
    last_error_code = 'operator_reopened',
    claimed_by = null,
    claim_expires_at = null,
    updated_at = clock_timestamp()
  where intent.id = saved.id
  returning * into saved;
  update public.browser_provider_cost_controls control set
    unresolved_metering_failures = greatest(0, control.unresolved_metering_failures - 1),
    status = case
      when control.counter_reset_detected or control.unresolved_metering_failures > 1
        or exists (
          select 1 from public.browser_provider_session_metering_queue queue
          where queue.project_key = p_project_key and queue.state = 'permanent_error'
        )
        or exists (
          select 1 from public.browser_provider_session_creation_intents intent
          where intent.project_key = p_project_key and intent.state = 'permanent_error'
        ) then 'metering_error'
      else 'provider_error'
    end,
    reason = case
      when control.counter_reset_detected then 'provider_counter_decreased'
      when control.unresolved_metering_failures > 1
        or exists (
          select 1 from public.browser_provider_session_metering_queue queue
          where queue.project_key = p_project_key and queue.state = 'permanent_error'
        ) then 'session_usage_unresolved'
      when exists (
        select 1 from public.browser_provider_session_creation_intents intent
        where intent.project_key = p_project_key and intent.state = 'permanent_error'
      ) then 'session_creation_unresolved'
      else 'session_creation_uncertain'
    end,
    updated_at = clock_timestamp()
  where control.project_key = p_project_key
  returning unresolved_metering_failures into remaining_failures;
  insert into public.audit_events(
    agency_id, actor_user_id, entity_type, entity_id, action, metadata_json
  ) values (
    saved.agency_id, p_actor_user_id, 'browser_provider_session_creation',
    coalesce(saved.eval_run_id, saved.client_id), 'browser_provider_session_creation_reopened',
    jsonb_build_object(
      'operatorReason', trim(p_operator_reason),
      'expectedAttemptCount', p_expected_attempt_count,
      'remainingPermanentFailures', remaining_failures
    )
  );
  return query select true, false, saved.state;
end;
$$;

create or replace function public.claim_browser_provider_daily_reconciliation(
  p_project_key text,
  p_worker_id text,
  p_browser_minutes_limit bigint,
  p_proxy_bytes_limit bigint,
  p_warning_percent integer,
  p_lease_seconds integer default 120
)
returns table (
  claimed boolean,
  control_status text,
  control_reason text,
  may_create_session boolean,
  browser_minutes bigint,
  proxy_bytes bigint,
  sampled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.browser_provider_cost_controls%rowtype;
  due boolean;
begin
  if p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_worker_id is null or length(trim(p_worker_id)) not between 1 and 200
    or p_browser_minutes_limit is null or p_browser_minutes_limit <= 0
    or p_proxy_bytes_limit is null or p_proxy_bytes_limit <= 0
    or p_warning_percent is null or p_warning_percent not between 50 and 95
  then
    raise exception 'BROWSER_PROVIDER_RECONCILIATION_CLAIM_INVALID';
  end if;

  insert into public.browser_provider_cost_controls(
    project_key, browser_minutes_limit, proxy_bytes_limit, warning_percent
  ) values (
    p_project_key, p_browser_minutes_limit, p_proxy_bytes_limit, p_warning_percent
  ) on conflict (project_key) do nothing;
  select * into saved
  from public.browser_provider_cost_controls control
  where control.project_key = p_project_key
  for update;

  due := saved.last_daily_reconciled_at is null
    or saved.last_daily_reconciled_at <= clock_timestamp() - interval '24 hours';
  if due
    and (saved.daily_claim_expires_at is null or saved.daily_claim_expires_at <= clock_timestamp())
    and (saved.usage_sample_claim_expires_at is null or saved.usage_sample_claim_expires_at <= clock_timestamp())
  then
    update public.browser_provider_cost_controls control set
      daily_claimed_by = p_worker_id,
      daily_claim_expires_at = clock_timestamp()
        + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 300))),
      usage_sample_claimed_by = p_worker_id,
      usage_sample_claim_expires_at = clock_timestamp()
        + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 300))),
      browser_minutes_limit = p_browser_minutes_limit,
      proxy_bytes_limit = p_proxy_bytes_limit,
      warning_percent = p_warning_percent,
      updated_at = clock_timestamp()
    where control.project_key = p_project_key
    returning * into saved;
    return query select true, saved.status, saved.reason,
      saved.status in ('healthy', 'warning'), coalesce(saved.browser_minutes, 0),
      coalesce(saved.proxy_bytes, 0), saved.sampled_at;
  else
    return query select false, saved.status, saved.reason,
      (not due) and saved.status in ('healthy', 'warning'), coalesce(saved.browser_minutes, 0),
      coalesce(saved.proxy_bytes, 0), saved.sampled_at;
  end if;
end;
$$;

create or replace function public.mark_browser_provider_usage_failure(
  p_project_key text,
  p_browser_minutes_limit bigint,
  p_proxy_bytes_limit bigint,
  p_warning_percent integer,
  p_reason text,
  p_permanent boolean,
  p_worker_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_project_key is null or p_project_key !~ '^[a-f0-9]{64}$'
    or p_browser_minutes_limit is null or p_browser_minutes_limit <= 0
    or p_proxy_bytes_limit is null or p_proxy_bytes_limit <= 0
    or p_warning_percent is null or p_warning_percent not between 50 and 95
    or p_reason not in (
      'project_usage_unavailable', 'daily_reconciliation_unavailable',
      'session_usage_unresolved', 'session_usage_conflict'
    )
  then
    raise exception 'BROWSER_PROVIDER_USAGE_FAILURE_INVALID';
  end if;
  insert into public.browser_provider_cost_controls(
    project_key, browser_minutes_limit, proxy_bytes_limit, warning_percent,
    status, reason, unresolved_metering_failures
  ) values (
    p_project_key, p_browser_minutes_limit, p_proxy_bytes_limit, p_warning_percent,
    case when p_permanent then 'metering_error' else 'provider_error' end,
    p_reason, case when p_permanent then 1 else 0 end
  ) on conflict (project_key) do update set
    browser_minutes_limit = excluded.browser_minutes_limit,
    proxy_bytes_limit = excluded.proxy_bytes_limit,
    warning_percent = excluded.warning_percent,
    status = case when p_permanent then 'metering_error' else 'provider_error' end,
    reason = p_reason,
    unresolved_metering_failures = public.browser_provider_cost_controls.unresolved_metering_failures
      + case when p_permanent then 1 else 0 end,
    daily_claimed_by = case
      when public.browser_provider_cost_controls.daily_claimed_by is not distinct from p_worker_id then null
      else public.browser_provider_cost_controls.daily_claimed_by
    end,
    daily_claim_expires_at = case
      when public.browser_provider_cost_controls.daily_claimed_by is not distinct from p_worker_id then null
      else public.browser_provider_cost_controls.daily_claim_expires_at
    end,
    usage_sample_claimed_by = case
      when public.browser_provider_cost_controls.usage_sample_claimed_by is not distinct from p_worker_id then null
      else public.browser_provider_cost_controls.usage_sample_claimed_by
    end,
    usage_sample_claim_expires_at = case
      when public.browser_provider_cost_controls.usage_sample_claimed_by is not distinct from p_worker_id then null
      else public.browser_provider_cost_controls.usage_sample_claim_expires_at
    end,
    updated_at = clock_timestamp();
end;
$$;

drop function if exists public.get_browser_provider_workspace_usage(uuid,text);
create or replace function public.get_browser_provider_workspace_usage(
  p_agency_id uuid,
  p_project_key text
)
returns table (
  session_active_minutes numeric,
  proxy_bytes bigint,
  proxy_megabytes numeric,
  session_count bigint,
  measured_through timestamptz,
  control_status text,
  control_reason text
)
language sql
security definer
set search_path = ''
as $$
  select
    round(coalesce(sum(usage.duration_ms), 0)::numeric / 60000, 2),
    coalesce(sum(usage.proxy_bytes), 0)::bigint,
    round(coalesce(sum(usage.proxy_bytes), 0)::numeric / 1048576, 2),
    count(usage.id)::bigint,
    max(usage.ended_at),
    coalesce(control.status, 'pending'),
    coalesce(control.reason, '')
  from (select 1) singleton
  left join public.browser_provider_cost_controls control
    on control.project_key = p_project_key
  left join public.browser_provider_session_usage usage
    on usage.project_key = p_project_key
    and usage.agency_id = p_agency_id
    and usage.started_at >= date_trunc('month', clock_timestamp())
    and usage.started_at < date_trunc('month', clock_timestamp()) + interval '1 month'
  group by control.status, control.reason;
$$;

alter table public.browser_provider_cost_controls enable row level security;
alter table public.browser_provider_session_usage enable row level security;
alter table public.browser_provider_usage_snapshots enable row level security;
alter table public.browser_provider_session_metering_queue enable row level security;
alter table public.browser_provider_session_creation_intents enable row level security;

revoke all on table public.browser_provider_cost_controls from public, anon, authenticated, service_role;
revoke all on table public.browser_provider_session_usage from public, anon, authenticated, service_role;
revoke all on table public.browser_provider_usage_snapshots from public, anon, authenticated, service_role;
revoke all on table public.browser_provider_session_metering_queue from public, anon, authenticated, service_role;
revoke all on table public.browser_provider_session_creation_intents from public, anon, authenticated, service_role;
grant select on table public.browser_provider_cost_controls to service_role;
grant select on table public.browser_provider_session_usage to service_role;
grant select on table public.browser_provider_usage_snapshots to service_role;
grant select on table public.browser_provider_session_metering_queue to service_role;
grant select on table public.browser_provider_session_creation_intents to service_role;

revoke all on function public.claim_browser_provider_project_usage_sample(text,text,bigint,bigint,integer,integer)
  from public, anon, authenticated;
grant execute on function public.claim_browser_provider_project_usage_sample(text,text,bigint,bigint,integer,integer)
  to service_role;
revoke all on function public.record_browser_provider_project_usage(text,bigint,bigint,bigint,bigint,integer,text,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_browser_provider_project_usage(text,bigint,bigint,bigint,bigint,integer,text,text,timestamptz)
  to service_role;
revoke all on function public.record_browser_provider_session_usage(text,text,uuid,uuid,uuid,text,timestamptz,timestamptz,bigint,text)
  from public, anon, authenticated;
grant execute on function public.record_browser_provider_session_usage(text,text,uuid,uuid,uuid,text,timestamptz,timestamptz,bigint,text)
  to service_role;
revoke all on function public.prepare_browser_provider_session_creation(text,text,uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.prepare_browser_provider_session_creation(text,text,uuid,uuid,uuid,text)
  to service_role;
revoke all on function public.mark_browser_provider_session_creation_uncertain(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.mark_browser_provider_session_creation_uncertain(uuid,text,text)
  to service_role;
revoke all on function public.claim_browser_provider_session_creation_reconciliation(text,text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.claim_browser_provider_session_creation_reconciliation(text,text,integer,integer)
  to service_role;
revoke all on function public.defer_browser_provider_session_creation_reconciliation(uuid,text,text,integer,integer,integer,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.defer_browser_provider_session_creation_reconciliation(uuid,text,text,integer,integer,integer,text,timestamptz)
  to service_role;
revoke all on function public.queue_browser_provider_session_metering(text,text,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.register_browser_provider_session_metering(text,text,uuid,uuid,uuid,text,uuid,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.register_browser_provider_session_metering(text,text,uuid,uuid,uuid,text,uuid,text,text,integer)
  to service_role;
revoke all on function public.begin_browser_provider_session_terminal_metering(text,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.begin_browser_provider_session_terminal_metering(text,text,text,integer)
  to service_role;
revoke all on function public.claim_browser_provider_session_metering(text,text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.claim_browser_provider_session_metering(text,text,integer,integer)
  to service_role;
revoke all on function public.defer_browser_provider_session_metering(text,text,text,integer,integer,integer,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.defer_browser_provider_session_metering(text,text,text,integer,integer,integer,text,timestamptz)
  to service_role;
revoke all on function public.reopen_browser_provider_session_metering(text,text,integer,text,uuid)
  from public, anon, authenticated;
grant execute on function public.reopen_browser_provider_session_metering(text,text,integer,text,uuid)
  to service_role;
revoke all on function public.reopen_browser_provider_session_creation_reconciliation(uuid,text,integer,text,uuid)
  from public, anon, authenticated;
grant execute on function public.reopen_browser_provider_session_creation_reconciliation(uuid,text,integer,text,uuid)
  to service_role;
revoke all on function public.claim_browser_provider_daily_reconciliation(text,text,bigint,bigint,integer,integer)
  from public, anon, authenticated;
grant execute on function public.claim_browser_provider_daily_reconciliation(text,text,bigint,bigint,integer,integer)
  to service_role;
revoke all on function public.mark_browser_provider_usage_failure(text,bigint,bigint,integer,text,boolean,text)
  from public, anon, authenticated;
grant execute on function public.mark_browser_provider_usage_failure(text,bigint,bigint,integer,text,boolean,text)
  to service_role;
revoke all on function public.get_browser_provider_workspace_usage(uuid,text)
  from public, anon, authenticated;
grant execute on function public.get_browser_provider_workspace_usage(uuid,text)
  to service_role;

-- Legal-acceptance fresh-schema extension. This is intentionally separate from
-- the exact Business Evals migration body above.
-- Current legal-acceptance evidence. Existing users are never backfilled.
create table if not exists public.auth_account_activations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  activation_kind text not null default 'email_signup',
  required_at timestamptz not null default clock_timestamp(),
  activated_at timestamptz,
  constraint auth_account_activations_kind_valid check (activation_kind = 'email_signup'),
  constraint auth_account_activations_time_order check (activated_at is null or activated_at >= required_at)
);

comment on table public.auth_account_activations is
  'Fail-closed activation requirement for Maintain Flow email signups. Existing, OAuth and invited users are not backfilled.';

alter table public.auth_account_activations enable row level security;
revoke all on table public.auth_account_activations from public, anon, authenticated, service_role;
grant select on table public.auth_account_activations to service_role;

create table if not exists public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  terms_version text not null,
  privacy_version text not null,
  source text not null,
  idempotency_key_hash text not null,
  accepted_at timestamptz not null default clock_timestamp(),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint legal_acceptances_terms_version_format check (terms_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  constraint legal_acceptances_privacy_version_format check (privacy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  constraint legal_acceptances_source_valid check (source in ('email_signup', 'oauth_callback', 'password_reset')),
  constraint legal_acceptances_idempotency_hash_valid check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  constraint legal_acceptances_user_versions_unique unique (user_id, terms_version, privacy_version),
  constraint legal_acceptances_user_idempotency_unique unique (user_id, idempotency_key_hash)
);

comment on table public.legal_acceptances is
  'Server-recorded evidence of explicit Terms and Privacy acceptance. No historical user is backfilled.';
comment on column public.legal_acceptances.accepted_at is
  'Authoritative server time when the acceptance was first durably recorded.';
comment on column public.legal_acceptances.idempotency_key_hash is
  'SHA-256 or deterministic 64-hex digest; raw browser idempotency keys are not retained.';

create index if not exists legal_acceptances_user_recorded_idx
  on public.legal_acceptances (user_id, recorded_at desc);

alter table public.legal_acceptances enable row level security;
revoke all on table public.legal_acceptances from public, anon, authenticated, service_role;
grant select on table public.legal_acceptances to service_role;

create or replace function public.capture_email_signup_legal_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  acceptance jsonb := coalesce(new.raw_user_meta_data->'maintainflow_legal_acceptance', '{}'::jsonb);
  auth_provider text := lower(coalesce(new.raw_app_meta_data->>'provider', ''));
  auth_invited_at timestamptz := new.invited_at;
  deterministic_key_hash text;
begin
  if jsonb_typeof(acceptance) = 'object'
    and acceptance->>'accepted' = 'true'
    and acceptance->>'terms_version' = '2026-07-19'
    and acceptance->>'privacy_version' = '2026-07-19'
    and acceptance->>'source' = 'email_signup'
  then
    deterministic_key_hash :=
      pg_catalog.md5('email_signup:' || new.id::text || ':2026-07-19:2026-07-19')
      || pg_catalog.md5('email_signup:v2:' || new.id::text || ':2026-07-19:2026-07-19');

    insert into public.legal_acceptances (
      user_id, terms_version, privacy_version, source, idempotency_key_hash
    ) values (
      new.id, '2026-07-19', '2026-07-19', 'email_signup', deterministic_key_hash
    )
    on conflict on constraint legal_acceptances_user_versions_unique do nothing;

    insert into public.auth_account_activations (user_id, activation_kind)
    values (new.id, 'email_signup')
    on conflict (user_id) do nothing;

    return new;
  end if;

  -- Google completes acceptance through the authenticated callback. A trusted
  -- Supabase invite completes acceptance in the password-activation screen.
  if auth_provider = 'google' or auth_invited_at is not null then
    return new;
  end if;

  raise exception 'LEGAL_ACCEPTANCE_REQUIRED';
end;
$$;

revoke all on function public.capture_email_signup_legal_acceptance() from public, anon, authenticated, service_role;
drop trigger if exists auth_users_capture_maintainflow_legal_acceptance on auth.users;
create trigger auth_users_capture_maintainflow_legal_acceptance
after insert on auth.users
for each row execute function public.capture_email_signup_legal_acceptance();

create or replace function public.enforce_email_signup_activation_for_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.auth_account_activations activation
    where activation.user_id = new.user_id
      and activation.activated_at is null
  ) then
    raise exception 'EMAIL_CONFIRMATION_REQUIRED';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_email_signup_activation_for_membership()
  from public, anon, authenticated, service_role;

drop trigger if exists memberships_require_email_signup_activation on public.memberships;
create trigger memberships_require_email_signup_activation
before insert or update of user_id on public.memberships
for each row execute function public.enforce_email_signup_activation_for_membership();

create or replace function public.current_auth_account_activation_status()
returns table (activation_required boolean, activation_complete boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from public.auth_account_activations activation
      where activation.user_id = (select auth.uid())
    ),
    not exists (
      select 1
      from public.auth_account_activations activation
      where activation.user_id = (select auth.uid())
        and activation.activated_at is null
    );
$$;

revoke all on function public.current_auth_account_activation_status()
  from public, anon, authenticated, service_role;
grant execute on function public.current_auth_account_activation_status()
  to authenticated;

create or replace function public.activate_email_signup_account(p_user_id uuid)
returns table (activation_required boolean, activated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'AUTH_USER_NOT_FOUND';
  end if;

  update public.auth_account_activations activation
  set activated_at = coalesce(activation.activated_at, clock_timestamp())
  where activation.user_id = p_user_id;

  return query
    select
      exists (
        select 1
        from public.auth_account_activations activation
        where activation.user_id = p_user_id
      ),
      (
        select activation.activated_at
        from public.auth_account_activations activation
        where activation.user_id = p_user_id
      );
end;
$$;

revoke all on function public.activate_email_signup_account(uuid)
  from public, anon, authenticated;
grant execute on function public.activate_email_signup_account(uuid)
  to service_role;

create or replace function public.enforce_current_legal_acceptance_for_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.legal_acceptances acceptance
    where acceptance.user_id = new.user_id
      and acceptance.terms_version = '2026-07-19'
      and acceptance.privacy_version = '2026-07-19'
  -- invited_at is a trusted GoTrue column, not caller-controlled user metadata.
  ) and not exists (
    select 1
    from auth.users invited_user
    where invited_user.id = new.user_id
      and invited_user.invited_at is not null
  ) then
    raise exception 'CURRENT_LEGAL_ACCEPTANCE_REQUIRED';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_current_legal_acceptance_for_membership()
  from public, anon, authenticated, service_role;
drop trigger if exists memberships_require_current_legal_acceptance on public.memberships;
create trigger memberships_require_current_legal_acceptance
before insert or update of user_id on public.memberships
for each row execute function public.enforce_current_legal_acceptance_for_membership();

create or replace function public.record_current_legal_acceptance(
  p_user_id uuid,
  p_terms_version text,
  p_privacy_version text,
  p_source text,
  p_idempotency_key_hash text
)
returns table (
  acceptance_id uuid,
  accepted_at timestamptz,
  terms_version text,
  privacy_version text,
  source text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'AUTH_USER_NOT_FOUND';
  end if;
  if p_terms_version is distinct from '2026-07-19'
    or p_privacy_version is distinct from '2026-07-19'
  then
    raise exception 'LEGAL_VERSION_MISMATCH';
  end if;
  if p_source not in ('oauth_callback', 'password_reset') then
    raise exception 'LEGAL_ACCEPTANCE_SOURCE_INVALID';
  end if;
  if p_idempotency_key_hash is null or p_idempotency_key_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'LEGAL_IDEMPOTENCY_KEY_INVALID';
  end if;

  insert into public.legal_acceptances (
    user_id, terms_version, privacy_version, source, idempotency_key_hash
  ) values (
    p_user_id, p_terms_version, p_privacy_version, p_source, p_idempotency_key_hash
  )
  on conflict on constraint legal_acceptances_user_versions_unique do nothing;

  return query
    select acceptance.id, acceptance.accepted_at, acceptance.terms_version,
      acceptance.privacy_version, acceptance.source
    from public.legal_acceptances acceptance
    where acceptance.user_id = p_user_id
      and acceptance.terms_version = p_terms_version
      and acceptance.privacy_version = p_privacy_version
    limit 1;
end;
$$;

revoke all on function public.record_current_legal_acceptance(uuid,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.record_current_legal_acceptance(uuid,text,text,text,text)
  to service_role;

commit;
