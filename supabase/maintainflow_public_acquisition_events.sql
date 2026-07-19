-- Privacy-bounded acquisition measurement for public marketing pages.
-- The browser sends only an exact page path, a fixed event enum, and an
-- optional fixed CTA placement. No visitor/session ID, query, referrer,
-- user-agent, IP address, form value, or free-text metadata is stored.

begin;

create extension if not exists pg_cron;

create table if not exists public.public_acquisition_events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null,
  route text not null,
  placement text,
  created_at timestamptz not null default now()
);

-- Recreate checks on every run so an existing production table receives the
-- current allowlists and nullability rules instead of keeping stale versions.
alter table public.public_acquisition_events
  drop constraint if exists public_acquisition_event_name_check,
  drop constraint if exists public_acquisition_route_check,
  drop constraint if exists public_acquisition_event_placement_check,
  drop constraint if exists public_acquisition_route_placement_check;

-- Normalize the retired CTA label before installing the current self-serve
-- contract. The historical `/contact-sales` route remains allowlisted only so
-- existing page-view rows can be retained until normal 90-day pruning.
update public.public_acquisition_events
set event_name = 'signup_cta_clicked'
where event_name = 'pilot_cta_clicked';

alter table public.public_acquisition_events
  add constraint public_acquisition_event_name_check check (
    event_name in ('public_page_view', 'signup_cta_clicked')
  ),
  add constraint public_acquisition_route_check check (
    route in (
      '/',
      '/agency-workflow-maintenance',
      '/use-cases/n8n-maintenance',
      '/use-cases/make-zapier-client-monitoring',
      '/templates/monthly-automation-report',
      '/sign-up',
      '/contact-sales',
      '/security',
      '/privacy',
      '/terms'
    )
  ),
  add constraint public_acquisition_event_placement_check check (
    (event_name = 'public_page_view' and placement is null)
    or (
      event_name = 'signup_cta_clicked'
      and placement is not null
      and placement in (
        'nav_desktop',
        'nav_mobile',
        'home_hero',
        'home_pricing',
        'home_closing',
        'seo_hero',
        'seo_closing',
        'footer_resources',
        'footer_company'
      )
    )
  ),
  add constraint public_acquisition_route_placement_check check (
    event_name = 'public_page_view'
    or (
      event_name = 'signup_cta_clicked'
      and placement is not null
      and (
        placement in ('nav_desktop', 'nav_mobile', 'footer_resources', 'footer_company')
        or (route = '/' and placement in ('home_hero', 'home_pricing', 'home_closing'))
        or (
          route in (
            '/agency-workflow-maintenance',
            '/use-cases/n8n-maintenance',
            '/use-cases/make-zapier-client-monitoring',
            '/templates/monthly-automation-report'
          )
          and placement in ('seo_hero', 'seo_closing')
        )
      )
    )
  );

create index if not exists public_acquisition_events_created_idx
  on public.public_acquisition_events (created_at desc);

create index if not exists public_acquisition_events_event_route_created_idx
  on public.public_acquisition_events (event_name, route, created_at desc);

alter table public.public_acquisition_events enable row level security;
revoke all on public.public_acquisition_events from public, anon, authenticated;

create or replace function public.record_public_acquisition_event(
  p_event_name text,
  p_route text,
  p_placement text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recent_count bigint;
  daily_count bigint;
begin
  -- One transaction at a time can evaluate the global quota and write. This
  -- bounds privileged inserts even across serverless instances and cold starts.
  if not pg_try_advisory_xact_lock(hashtext('maintainflow-public-acquisition')) then
    return false;
  end if;

  select
    count(*) filter (where created_at >= now() - interval '10 minutes'),
    count(*)
  into recent_count, daily_count
  from public.public_acquisition_events
  where created_at >= now() - interval '24 hours';

  if recent_count >= 500 or daily_count >= 5000 then
    return false;
  end if;

  insert into public.public_acquisition_events (event_name, route, placement)
  values (p_event_name, p_route, p_placement);

  return true;
end;
$$;

revoke all on function public.record_public_acquisition_event(text, text, text) from public, anon, authenticated;
grant execute on function public.record_public_acquisition_event(text, text, text) to service_role;

create or replace function public.get_public_acquisition_metrics(p_since timestamptz)
returns table (
  event_name text,
  route text,
  placement text,
  event_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    events.event_name,
    events.route,
    events.placement,
    count(*)::bigint as event_count
  from public.public_acquisition_events events
  where events.created_at >= greatest(
    coalesce(p_since, now() - interval '7 days'),
    now() - interval '90 days'
  )
  group by events.event_name, events.route, events.placement
  order by event_count desc, events.event_name, events.route, events.placement nulls first;
$$;

revoke all on function public.get_public_acquisition_metrics(timestamptz) from public, anon, authenticated;
grant execute on function public.get_public_acquisition_metrics(timestamptz) to service_role;

create or replace function public.prune_public_acquisition_events()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count bigint;
begin
  delete from public.public_acquisition_events
  where created_at < now() - interval '90 days';

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.prune_public_acquisition_events() from public, anon, authenticated;
grant execute on function public.prune_public_acquisition_events() to service_role;

-- Retention setup is part of this transaction. If pg_cron cannot be installed
-- or the job cannot be scheduled, the migration fails instead of silently
-- promising deletion that will never run.
do $$
begin
  begin
    perform cron.unschedule('maintainflow-prune-public-acquisition');
  exception
    when others then
      null;
  end;

  perform cron.schedule(
    'maintainflow-prune-public-acquisition',
    '17 3 * * *',
    'select public.prune_public_acquisition_events();'
  );
end;
$$;

commit;
