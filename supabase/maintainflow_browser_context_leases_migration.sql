-- Additive, rerunnable Browserbase Context lease and cleanup queue.
-- Context IDs, session IDs, and resume locations are private service data.
-- The canonical fresh schema and Business Evals migration mirror this contract.

begin;

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

alter table public.browser_context_leases enable row level security;

revoke all on table public.browser_context_leases from public, anon, authenticated;
revoke insert, update, delete on table public.browser_context_leases from service_role;
grant select on table public.browser_context_leases to service_role;

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

commit;
