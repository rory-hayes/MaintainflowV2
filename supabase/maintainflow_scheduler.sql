-- Maintain Flow Supabase scheduler setup
-- Run this after supabase/maintainflow_schema.sql.
--
-- This file adds due-check leasing plus optional pg_cron/pg_net scheduling.
-- It does not include real secrets. Configure the schedule at the bottom with
-- your deployed app URL and CRON_SECRET value.

begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault with schema vault;

-- A scheduler reconfiguration must never leave the retired paid-pilot retry
-- job active. Historical lead rows remain untouched.
do $retire_paid_pilot_job$
begin
  begin
    perform cron.unschedule('maintainflow-retry-pilot-lead-notifications');
  exception
    when others then
      null;
  end;
end;
$retire_paid_pilot_job$;

alter table public.checks
  add column if not exists lease_expires_at timestamptz,
  add column if not exists leased_by text,
  add column if not exists last_claimed_at timestamptz;

create index if not exists checks_due_claim_idx
  on public.checks (next_run_at, lease_expires_at)
  where enabled and not pending_setup;

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

revoke all on function public.claim_due_checks(integer, integer, text) from public;
revoke all on function public.claim_due_checks(integer, integer, text) from anon;
revoke all on function public.claim_due_checks(integer, integer, text) from authenticated;
grant execute on function public.claim_due_checks(integer, integer, text) to service_role;

create or replace function public.configure_maintainflow_scheduler(
  app_url text,
  cron_secret text,
  schedule text default '* * * * *'
)
returns void
language plpgsql
security definer
set search_path = public, cron, net, vault
as $$
declare
  normalized_app_url text;
  app_secret_id uuid;
  cron_secret_id uuid;
begin
  if app_url is null or trim(app_url) = '' then
    raise exception 'app_url is required';
  end if;

  if cron_secret is null or length(trim(cron_secret)) < 20 then
    raise exception 'cron_secret must be at least 20 characters';
  end if;

  normalized_app_url := trim(trailing '/' from trim(app_url));

  select id into app_secret_id
  from vault.decrypted_secrets
  where name = 'maintainflow_app_url';

  if app_secret_id is null then
    perform vault.create_secret(normalized_app_url, 'maintainflow_app_url', 'Maintain Flow app URL for scheduled checks');
  else
    perform vault.update_secret(app_secret_id, normalized_app_url, 'maintainflow_app_url', 'Maintain Flow app URL for scheduled checks');
  end if;

  select id into cron_secret_id
  from vault.decrypted_secrets
  where name = 'maintainflow_cron_secret';

  if cron_secret_id is null then
    perform vault.create_secret(cron_secret, 'maintainflow_cron_secret', 'Maintain Flow CRON_SECRET for scheduled checks');
  else
    perform vault.update_secret(cron_secret_id, cron_secret, 'maintainflow_cron_secret', 'Maintain Flow CRON_SECRET for scheduled checks');
  end if;

  begin
    perform cron.unschedule('maintainflow-run-checks');
  exception
    when others then
      null;
  end;

  begin
    perform cron.unschedule('maintainflow-run-checks-2');
  exception
    when others then
      null;
  end;

  begin
    perform cron.unschedule('maintainflow-run-evals');
  exception
    when others then
      null;
  end;

  begin
    perform cron.unschedule('maintainflow-deliver-eval-alerts');
  exception
    when others then
      null;
  end;

  perform cron.schedule(
    'maintainflow-run-checks',
    coalesce(nullif(trim(schedule), ''), '* * * * *'),
    $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'maintainflow_app_url') || '/api/cron/run-checks',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'maintainflow_cron_secret')
        ),
        body := jsonb_build_object(
          'source', 'supabase_pg_cron',
          'scheduled_at', now(),
          'batchSize', 5
        ),
        timeout_milliseconds := 60000
      );
    $cron$
  );

  perform cron.schedule(
    'maintainflow-run-checks-2',
    coalesce(nullif(trim(schedule), ''), '* * * * *'),
    $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'maintainflow_app_url') || '/api/cron/run-checks',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'maintainflow_cron_secret')
        ),
        body := jsonb_build_object(
          'source', 'supabase_pg_cron',
          'scheduled_at', now(),
          'batchSize', 5
        ),
        timeout_milliseconds := 60000
      );
    $cron$
  );

  perform cron.schedule(
    'maintainflow-run-evals',
    coalesce(nullif(trim(schedule), ''), '* * * * *'),
    $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'maintainflow_app_url') || '/api/cron/run-evals',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'maintainflow_cron_secret')
        ),
        body := jsonb_build_object(
          'source', 'supabase_pg_cron',
          'scheduled_at', now(),
          'batchSize', 5
        ),
        timeout_milliseconds := 60000
      );
    $cron$
  );

  perform cron.schedule(
    'maintainflow-deliver-eval-alerts',
    coalesce(nullif(trim(schedule), ''), '* * * * *'),
    $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'maintainflow_app_url') || '/api/cron/deliver-eval-alerts',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'maintainflow_cron_secret')
        ),
        body := jsonb_build_object(
          'source', 'supabase_pg_cron',
          'scheduled_at', now(),
          'batchSize', 10
        ),
        timeout_milliseconds := 60000
      );
    $cron$
  );

end;
$$;

revoke all on function public.configure_maintainflow_scheduler(text, text, text) from public;
revoke all on function public.configure_maintainflow_scheduler(text, text, text) from anon;
revoke all on function public.configure_maintainflow_scheduler(text, text, text) from authenticated;
grant execute on function public.configure_maintainflow_scheduler(text, text, text) to postgres;

create or replace function public.configure_maintainflow_scheduler_direct(
  app_url text,
  cron_secret text,
  schedule text default '* * * * *'
)
returns void
language plpgsql
security definer
set search_path = public, cron, net
as $$
declare
  normalized_app_url text;
  cron_sql text;
  eval_cron_sql text;
  alert_cron_sql text;
begin
  if app_url is null or trim(app_url) = '' then
    raise exception 'app_url is required';
  end if;

  if cron_secret is null or length(trim(cron_secret)) < 20 then
    raise exception 'cron_secret must be at least 20 characters';
  end if;

  normalized_app_url := trim(trailing '/' from trim(app_url));

  begin
    perform cron.unschedule('maintainflow-run-checks');
  exception
    when others then
      null;
  end;

  begin
    perform cron.unschedule('maintainflow-run-checks-2');
  exception
    when others then
      null;
  end;

  begin
    perform cron.unschedule('maintainflow-run-evals');
  exception
    when others then
      null;
  end;

  begin
    perform cron.unschedule('maintainflow-deliver-eval-alerts');
  exception
    when others then
      null;
  end;

  cron_sql := format(
    $command$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', %L
        ),
        body := jsonb_build_object(
          'source', 'supabase_pg_cron',
          'scheduled_at', now(),
          'batchSize', 5
        ),
        timeout_milliseconds := 60000
      );
    $command$,
    normalized_app_url || '/api/cron/run-checks',
    'Bearer ' || cron_secret
  );

  perform cron.schedule(
    'maintainflow-run-checks',
    coalesce(nullif(trim(schedule), ''), '* * * * *'),
    cron_sql
  );

  perform cron.schedule(
    'maintainflow-run-checks-2',
    coalesce(nullif(trim(schedule), ''), '* * * * *'),
    cron_sql
  );

  eval_cron_sql := format(
    $command$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', %L
        ),
        body := jsonb_build_object(
          'source', 'supabase_pg_cron',
          'scheduled_at', now(),
          'batchSize', 5
        ),
        timeout_milliseconds := 60000
      );
    $command$,
    normalized_app_url || '/api/cron/run-evals',
    'Bearer ' || cron_secret
  );

  perform cron.schedule(
    'maintainflow-run-evals',
    coalesce(nullif(trim(schedule), ''), '* * * * *'),
    eval_cron_sql
  );

  alert_cron_sql := format(
    $command$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', %L
        ),
        body := jsonb_build_object(
          'source', 'supabase_pg_cron',
          'scheduled_at', now(),
          'batchSize', 10
        ),
        timeout_milliseconds := 60000
      );
    $command$,
    normalized_app_url || '/api/cron/deliver-eval-alerts',
    'Bearer ' || cron_secret
  );

  perform cron.schedule(
    'maintainflow-deliver-eval-alerts',
    coalesce(nullif(trim(schedule), ''), '* * * * *'),
    alert_cron_sql
  );

end;
$$;

revoke all on function public.configure_maintainflow_scheduler_direct(text, text, text) from public;
revoke all on function public.configure_maintainflow_scheduler_direct(text, text, text) from anon;
revoke all on function public.configure_maintainflow_scheduler_direct(text, text, text) from authenticated;
grant execute on function public.configure_maintainflow_scheduler_direct(text, text, text) to postgres;

commit;

-- After this file succeeds, configure the live schedule with your real values:
--
-- select public.configure_maintainflow_scheduler(
--   'https://your-production-app.example',
--   'replace-with-the-same-secret-as-CRON_SECRET',
--   '* * * * *'
-- );
--
-- If Vault setup fails in your Supabase project, use the direct fallback:
--
-- select public.configure_maintainflow_scheduler_direct(
--   'https://your-production-app.example',
--   'replace-with-the-same-secret-as-CRON_SECRET',
--   '* * * * *'
-- );
--
-- Confirm the job exists:
-- select jobid, jobname, schedule, command
-- from cron.job
-- where jobname in ('maintainflow-run-checks', 'maintainflow-run-checks-2', 'maintainflow-run-evals', 'maintainflow-deliver-eval-alerts');
