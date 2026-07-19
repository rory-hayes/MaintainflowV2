-- Maintain Flow internal ops observability
-- Run after supabase/maintainflow_schema.sql.
-- This adds durable product funnel events and rate-limit reporting without
-- storing raw endpoint URLs, headers, request bodies, tokens, or limiter keys.

begin;

create table if not exists public.product_events (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references public.agencies(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  event_name text not null,
  route text not null default '',
  session_id text not null default '',
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint product_events_event_name_format check (event_name ~ '^[a-z0-9_:-]{2,80}$'),
  constraint product_events_metadata_object check (jsonb_typeof(metadata_json) = 'object')
);

create table if not exists public.rate_limit_events (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references public.agencies(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  scope text not null,
  key_hash text not null,
  allowed boolean not null,
  remaining integer not null default 0,
  reset_at timestamptz,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint rate_limit_events_scope_format check (scope ~ '^[a-z0-9_:-]{2,80}$'),
  constraint rate_limit_events_remaining_nonnegative check (remaining >= 0),
  constraint rate_limit_events_metadata_object check (jsonb_typeof(metadata_json) = 'object')
);

create index if not exists product_events_agency_created_idx
  on public.product_events (agency_id, created_at desc)
  where agency_id is not null;

create index if not exists product_events_user_created_idx
  on public.product_events (user_id, created_at desc)
  where user_id is not null;

create index if not exists product_events_event_created_idx
  on public.product_events (event_name, created_at desc);

create index if not exists product_events_session_created_idx
  on public.product_events (session_id, created_at desc)
  where session_id <> '';

create index if not exists rate_limit_events_scope_created_idx
  on public.rate_limit_events (scope, created_at desc);

create index if not exists rate_limit_events_user_created_idx
  on public.rate_limit_events (user_id, created_at desc)
  where user_id is not null;

create index if not exists rate_limit_events_agency_created_idx
  on public.rate_limit_events (agency_id, created_at desc)
  where agency_id is not null;

create index if not exists rate_limit_events_blocked_created_idx
  on public.rate_limit_events (created_at desc)
  where not allowed;

alter table public.product_events enable row level security;
alter table public.rate_limit_events enable row level security;

drop policy if exists product_events_members_select on public.product_events;
create policy product_events_members_select on public.product_events
for select to authenticated
using (
  user_id = (select auth.uid())
  or (
    agency_id is not null
    and (select public.is_agency_member(agency_id))
  )
);

drop policy if exists product_events_members_insert on public.product_events;
create policy product_events_members_insert on public.product_events
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and (
    agency_id is null
    or (select public.is_agency_member(agency_id))
  )
);

-- rate_limit_events is intentionally service-role only. The app writes hashed
-- limiter keys from server routes and the founder ops console reads through the
-- admin-only server API.
revoke all on public.rate_limit_events from anon, authenticated;

commit;
