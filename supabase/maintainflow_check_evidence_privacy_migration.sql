-- Backward-compatible privacy guard for check evidence.
-- Assertion history stores only structural pass/fail outcomes. Normalized result
-- blobs are cleared because older builds could duplicate response excerpts,
-- assertion values, endpoint URLs, and other sensitive runtime material there.

begin;

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

-- Rewrite only unsafe legacy rows. The predicate makes later deployment runs a
-- no-op and avoids repeatedly invalidating current report snapshots.
update public.check_runs cr
set assertion_results_json = cr.assertion_results_json,
    result_json = cr.result_json
where coalesce(cr.result_json, '{}'::jsonb) <> '{}'::jsonb
  or jsonb_typeof(cr.assertion_results_json) is distinct from 'array'
  or exists (
    select 1
    from jsonb_array_elements(
      case
        when jsonb_typeof(cr.assertion_results_json) = 'array' then cr.assertion_results_json
        else '[]'::jsonb
      end
    ) with ordinality as assertion_item(value, ordinality)
    where jsonb_typeof(assertion_item.value) <> 'object'
      or jsonb_typeof(assertion_item.value->'passed') <> 'boolean'
      or assertion_item.value->>'id' is distinct from 'assertion-' || assertion_item.ordinality::text
      or assertion_item.value->>'label' not in ('Assertion passed', 'Assertion failed')
      or (assertion_item.value->>'passed' = 'true' and assertion_item.value ? 'reason')
      or (
        assertion_item.value->>'passed' = 'false'
        and assertion_item.value->>'reason' is distinct from 'Assertion did not meet the configured condition.'
      )
      or exists (
        select 1
        from jsonb_object_keys(assertion_item.value) as key_name
        where key_name not in ('id', 'label', 'passed', 'reason')
      )
  );

commit;
