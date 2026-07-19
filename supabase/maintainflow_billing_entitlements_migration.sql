-- Enforce paid entitlements and plan limits at the database boundary.

begin;

alter table public.agencies
  add column if not exists stripe_subscription_status text,
  add column if not exists complimentary_entitlement boolean not null default false,
  add column if not exists complimentary_entitlement_reason text;

alter table public.agencies
  alter column plan set default 'free'::public.agency_plan;

-- Public workspaces must not be able to create one-minute polling loops through
-- direct PostgREST writes. Existing shorter schedules are moved to the supported
-- one-hour minimum before the constraints are installed.
update public.workflows set frequency_minutes = 60 where frequency_minutes < 60;
update public.checks set schedule_minutes = 60 where schedule_minutes < 60;

alter table public.workflows
  drop constraint if exists workflows_frequency_positive,
  drop constraint if exists workflows_frequency_safe,
  add constraint workflows_frequency_safe check (frequency_minutes >= 60);

alter table public.checks
  drop constraint if exists checks_schedule_positive,
  drop constraint if exists checks_schedule_safe,
  add constraint checks_schedule_safe check (schedule_minutes >= 60);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agencies_stripe_subscription_status_valid'
      and conrelid = 'public.agencies'::regclass
  ) then
    alter table public.agencies
      add constraint agencies_stripe_subscription_status_valid check (
        stripe_subscription_status is null
        or stripe_subscription_status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'agencies_complimentary_entitlement_reason_required'
      and conrelid = 'public.agencies'::regclass
  ) then
    alter table public.agencies
      add constraint agencies_complimentary_entitlement_reason_required check (
        not complimentary_entitlement
        or (plan <> 'free'::public.agency_plan and length(trim(coalesce(complimentary_entitlement_reason, ''))) > 0)
      );
  end if;
end $$;

create or replace function public.effective_agency_plan(target_agency_id uuid)
returns public.agency_plan
language sql
stable
security definer
set search_path = public
as $$
  select case
    when a.complimentary_entitlement
      and a.plan <> 'free'::public.agency_plan
      and length(trim(coalesce(a.complimentary_entitlement_reason, ''))) > 0
      then a.plan
    when a.plan not in ('free'::public.agency_plan, 'agency_plus'::public.agency_plan)
      and a.stripe_customer_id is not null
      and a.stripe_subscription_id is not null
      and a.stripe_subscription_status in ('trialing', 'active')
      then a.plan
    else 'free'::public.agency_plan
  end
  from public.agencies a
  where a.id = target_agency_id;
$$;

create or replace function public.billing_plan_limit(target_plan public.agency_plan, resource_name text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case resource_name
    when 'clients' then case target_plan
      when 'free' then 1 when 'starter' then 5 when 'growth' then 10 when 'scale' then 30 else null end
    when 'workflows' then case target_plan
      when 'free' then 3 when 'starter' then 50 when 'growth' then 100 when 'scale' then 300 else null end
    when 'workflows_per_client' then case target_plan
      when 'free' then 3 when 'starter' then 10 when 'growth' then 10 when 'scale' then 10 else null end
    when 'reports_per_month' then case target_plan
      when 'free' then 1 when 'starter' then 5 when 'growth' then 15 when 'scale' then 50 else null end
    else null
  end;
$$;

create or replace function public.enforce_client_billing_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  effective_plan public.agency_plan;
  allowed_count integer;
  active_count bigint;
begin
  if new.archived_at is not null then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.agency_id = new.agency_id and old.archived_at is null then
    return new;
  end if;

  perform 1 from public.agencies where id = new.agency_id for update;
  effective_plan := public.effective_agency_plan(new.agency_id);
  allowed_count := public.billing_plan_limit(effective_plan, 'clients');
  if allowed_count is null then return new; end if;

  select count(*) into active_count
  from public.clients c
  where c.agency_id = new.agency_id
    and c.archived_at is null
    and c.id <> new.id;

  if active_count >= allowed_count then
    raise exception using
      errcode = 'P0001',
      message = format('%s allows up to %s active client%s. Upgrade before adding another client.', initcap(replace(effective_plan::text, '_', ' ')), allowed_count, case when allowed_count = 1 then '' else 's' end);
  end if;

  return new;
end;
$$;

create or replace function public.enforce_workflow_billing_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  effective_plan public.agency_plan;
  allowed_count integer;
  allowed_per_client integer;
  active_count bigint;
begin
  if new.archived_at is not null then return new; end if;

  if tg_op = 'UPDATE'
    and old.agency_id = new.agency_id
    and old.client_id = new.client_id
    and old.archived_at is null then
    return new;
  end if;

  perform 1 from public.agencies where id = new.agency_id for update;
  effective_plan := public.effective_agency_plan(new.agency_id);
  allowed_count := public.billing_plan_limit(effective_plan, 'workflows');
  allowed_per_client := public.billing_plan_limit(effective_plan, 'workflows_per_client');

  if allowed_count is not null then
    select count(*) into active_count
    from public.workflows w
    where w.agency_id = new.agency_id
      and w.archived_at is null
      and w.id <> new.id;

    if active_count >= allowed_count then
      raise exception using
        errcode = 'P0001',
        message = format('%s allows up to %s active workflows. Upgrade before adding another workflow.', initcap(replace(effective_plan::text, '_', ' ')), allowed_count);
    end if;
  end if;

  if allowed_per_client is not null then
    select count(*) into active_count
    from public.workflows w
    where w.agency_id = new.agency_id
      and w.client_id = new.client_id
      and w.archived_at is null
      and w.id <> new.id;

    if active_count >= allowed_per_client then
      raise exception using
        errcode = 'P0001',
        message = format('%s allows up to %s workflows per client.', initcap(replace(effective_plan::text, '_', ' ')), allowed_per_client);
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.enforce_report_billing_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  effective_plan public.agency_plan;
  allowed_count integer;
  report_count bigint;
  existing_report boolean;
begin
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    if old.agency_id = new.agency_id then return new; end if;
  else
    select exists (select 1 from public.reports r where r.id = new.id) into existing_report;
    if existing_report then return new; end if;
    new.created_at := now();
  end if;

  perform 1 from public.agencies where id = new.agency_id for update;
  effective_plan := public.effective_agency_plan(new.agency_id);
  allowed_count := public.billing_plan_limit(effective_plan, 'reports_per_month');
  if allowed_count is null then return new; end if;

  select count(*) into report_count
  from public.reports r
  where r.agency_id = new.agency_id
    and date_trunc('month', r.created_at at time zone 'UTC') = date_trunc('month', new.created_at at time zone 'UTC')
    and r.id <> new.id;

  if report_count >= allowed_count then
    raise exception using
      errcode = 'P0001',
      message = format('%s allows up to %s report%s per month. Upgrade before generating another report.', initcap(replace(effective_plan::text, '_', ' ')), allowed_count, case when allowed_count = 1 then '' else 's' end);
  end if;

  return new;
end;
$$;

drop trigger if exists clients_enforce_billing_limit on public.clients;
create trigger clients_enforce_billing_limit
before insert or update of agency_id, archived_at on public.clients
for each row execute function public.enforce_client_billing_limit();

drop trigger if exists workflows_enforce_billing_limit on public.workflows;
create trigger workflows_enforce_billing_limit
before insert or update of agency_id, client_id, archived_at on public.workflows
for each row execute function public.enforce_workflow_billing_limit();

drop trigger if exists reports_enforce_billing_limit on public.reports;
create trigger reports_enforce_billing_limit
before insert or update of agency_id, created_at on public.reports
for each row execute function public.enforce_report_billing_limit();

revoke insert, update, delete on public.agencies from authenticated;
grant update (name, slug, logo_url, primary_color, report_sender_name, report_sender_email, updated_at)
on public.agencies to authenticated;

revoke all on function public.effective_agency_plan(uuid) from public, anon, authenticated;
revoke all on function public.billing_plan_limit(public.agency_plan, text) from public, anon, authenticated;

commit;
