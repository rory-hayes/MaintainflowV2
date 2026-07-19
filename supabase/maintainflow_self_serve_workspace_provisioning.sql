-- Restore one-click authenticated workspace creation for the self-serve product.

begin;

-- One user may belong to only one workspace. Authenticated admins can add a
-- member and change that member's role, but membership identity and deletion
-- remain service-role operations so a browser user cannot orphan a workspace.
create unique index if not exists memberships_user_id_unique_idx
  on public.memberships (user_id);

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

revoke update, delete on public.memberships from authenticated;
grant update (role) on public.memberships to authenticated;
grant select, insert, update, delete on public.memberships to service_role;

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

revoke all on function public.create_agency_workspace(text, text, text, citext) from public, anon;
grant execute on function public.create_agency_workspace(text, text, text, citext) to authenticated;

commit;
