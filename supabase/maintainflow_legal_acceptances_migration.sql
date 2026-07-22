-- Additive, immutable legal-acceptance evidence for current self-serve signup flows.
-- Existing auth users are deliberately not backfilled: an acceptance exists only
-- after an explicit UI action supplies the exact current Terms and Privacy versions.

begin;

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
  constraint legal_acceptances_terms_version_format
    check (terms_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  constraint legal_acceptances_privacy_version_format
    check (privacy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  constraint legal_acceptances_source_valid
    check (source in ('email_signup', 'oauth_callback', 'password_reset')),
  constraint legal_acceptances_idempotency_hash_valid
    check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  constraint legal_acceptances_user_versions_unique
    unique (user_id, terms_version, privacy_version),
  constraint legal_acceptances_user_idempotency_unique
    unique (user_id, idempotency_key_hash)
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

-- No browser role receives a table policy or direct privilege. The service role
-- may inspect evidence but can write only through the narrow RPC below. Email
-- signup writes are made by the auth.users trigger's security-definer function.
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
      user_id,
      terms_version,
      privacy_version,
      source,
      idempotency_key_hash
    ) values (
      new.id,
      '2026-07-19',
      '2026-07-19',
      'email_signup',
      deterministic_key_hash
    )
    on conflict on constraint legal_acceptances_user_versions_unique do nothing;

    insert into public.auth_account_activations (user_id, activation_kind)
    values (new.id, 'email_signup')
    on conflict (user_id) do nothing;

    return new;
  end if;

  -- Google must finish account acceptance through the authenticated callback
  -- API. A real Supabase invitation is allowed to reserve membership before its
  -- recipient accepts in the password-activation screen. All other newly
  -- inserted auth users fail closed without durable legal evidence.
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
  -- A trusted Supabase invitation may reserve membership before activation.
  -- invited_at is controlled by GoTrue; public signup metadata is never trusted.
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

  if p_idempotency_key_hash is null
    or p_idempotency_key_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'LEGAL_IDEMPOTENCY_KEY_INVALID';
  end if;

  insert into public.legal_acceptances (
    user_id,
    terms_version,
    privacy_version,
    source,
    idempotency_key_hash
  ) values (
    p_user_id,
    p_terms_version,
    p_privacy_version,
    p_source,
    p_idempotency_key_hash
  )
  on conflict on constraint legal_acceptances_user_versions_unique do nothing;

  return query
    select
      acceptance.id,
      acceptance.accepted_at,
      acceptance.terms_version,
      acceptance.privacy_version,
      acceptance.source
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
