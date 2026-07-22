-- Additive, rerunnable Browserbase commercial usage accounting and fail-closed
-- provider cost controls. Provider session IDs remain private service data.

begin;

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

commit;
