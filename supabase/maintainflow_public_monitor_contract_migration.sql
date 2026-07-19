-- Phase-2 persisted monitor contraction.
--
-- Saved monitors are deliberately public GET checks until encrypted credential
-- storage exists. This migration removes legacy request secrets, disables rows
-- whose execution semantics changed, and enforces the same contract for direct
-- PostgREST writes. Historical workflow/check/run rows remain in place.

begin;

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

create or replace function public.legacy_saved_check_config_matches_workflow(
  check_config jsonb,
  endpoint_url text,
  workflow_method public.workflow_method
)
returns boolean
language sql
immutable
strict
as $$
  select case
    when jsonb_typeof(check_config) <> 'object' then false
    when exists (
      select 1 from jsonb_object_keys(check_config) as config_key
      where config_key not in (
        'expectedStatus', 'timeoutSeconds', 'maxLatencyMs',
        'url', 'method', 'body', 'assertionCount'
      )
    ) then false
    when not public.saved_monitor_check_config_is_safe(
      check_config - 'url' - 'method' - 'body' - 'assertionCount'
    ) then false
    when check_config ? 'url' and (
      jsonb_typeof(check_config->'url') <> 'string'
      or check_config->>'url' <> endpoint_url
    ) then false
    when check_config ? 'method' and (
      jsonb_typeof(check_config->'method') <> 'string'
      or upper(check_config->>'method') <> workflow_method::text
    ) then false
    when check_config ? 'body' and (
      jsonb_typeof(check_config->'body') <> 'string'
      or btrim(check_config->>'body') <> ''
    ) then false
    when check_config ? 'assertionCount'
      and jsonb_typeof(check_config->'assertionCount') <> 'number' then false
    else true
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

-- Disable checks before removing legacy execution material so nothing silently
-- changes from a credentialled request into a public GET request.
update public.checks check_state
set
  enabled = false,
  pending_setup = true,
  next_run_at = null,
  lease_expires_at = null,
  leased_by = null,
  updated_at = now()
from public.workflows workflow_state
where workflow_state.id = check_state.workflow_id
  and workflow_state.agency_id = check_state.agency_id
  and (
    workflow_state.endpoint_url = ''
    or not public.saved_monitor_endpoint_is_safe(workflow_state.endpoint_url)
    or workflow_state.method <> 'GET'::public.workflow_method
    or workflow_state.auth_type <> 'none'
    or workflow_state.request_body <> ''
    or workflow_state.store_raw_response
    or not public.saved_monitor_headers_are_safe(workflow_state.encrypted_auth_config)
    or not public.legacy_saved_check_config_matches_workflow(
      check_state.config_json,
      workflow_state.endpoint_url,
      workflow_state.method
    )
    or not public.saved_monitor_assertions_are_safe(check_state.assertions_json)
  );

update public.workflows workflow_state
set
  endpoint_url = '',
  method = 'GET'::public.workflow_method,
  auth_type = 'none',
  encrypted_auth_config = '{}'::jsonb,
  request_body = '',
  store_raw_response = false,
  report_included = false,
  status = 'pending'::public.workflow_status,
  updated_at = now()
where not public.saved_monitor_endpoint_is_safe(workflow_state.endpoint_url)
   or workflow_state.method <> 'GET'::public.workflow_method
   or workflow_state.auth_type <> 'none'
   or workflow_state.request_body <> ''
   or workflow_state.store_raw_response
   or not public.saved_monitor_headers_are_safe(workflow_state.encrypted_auth_config);

update public.checks check_state
set
  config_json = jsonb_strip_nulls(jsonb_build_object(
    'expectedStatus', case
      when jsonb_typeof(check_state.config_json->'expectedStatus') = 'number' then case
        when (check_state.config_json->>'expectedStatus')::numeric = trunc((check_state.config_json->>'expectedStatus')::numeric)
          and (check_state.config_json->>'expectedStatus')::numeric between 100 and 599
        then check_state.config_json->'expectedStatus'
      end
    end,
    'timeoutSeconds', case
      when jsonb_typeof(check_state.config_json->'timeoutSeconds') = 'number' then case
        when (check_state.config_json->>'timeoutSeconds')::numeric between 1 and 30
        then check_state.config_json->'timeoutSeconds'
      end
    end,
    'maxLatencyMs', case
      when jsonb_typeof(check_state.config_json->'maxLatencyMs') = 'number' then case
        when (check_state.config_json->>'maxLatencyMs')::numeric between 100 and 60000
        then check_state.config_json->'maxLatencyMs'
      end
    end
  )),
  updated_at = now()
where not public.saved_monitor_check_config_is_safe(check_state.config_json);

update public.checks check_state
set
  assertions_json = '[]'::jsonb,
  updated_at = now()
where not public.saved_monitor_assertions_are_safe(check_state.assertions_json);

alter table public.workflows
  drop constraint if exists workflows_saved_endpoint_safe,
  add constraint workflows_saved_endpoint_safe
    check (public.saved_monitor_endpoint_is_safe(endpoint_url)),
  drop constraint if exists workflows_saved_execution_safe,
  add constraint workflows_saved_execution_safe
    check (
      method = 'GET'::public.workflow_method
      and auth_type = 'none'
      and request_body = ''
      and not store_raw_response
      and public.saved_monitor_headers_are_safe(encrypted_auth_config)
    );

alter table public.checks
  drop constraint if exists checks_saved_config_safe,
  add constraint checks_saved_config_safe
    check (public.saved_monitor_check_config_is_safe(config_json)),
  drop constraint if exists checks_saved_assertions_safe,
  add constraint checks_saved_assertions_safe
    check (public.saved_monitor_assertions_are_safe(assertions_json));

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

commit;
