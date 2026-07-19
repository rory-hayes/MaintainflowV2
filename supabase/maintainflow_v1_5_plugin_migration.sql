-- Maintain Flow V1.5 plugin seam migration.
-- Safe to run on existing Maintain Flow projects; create-table schema already includes these columns.

alter table public.checks
  add column if not exists plugin_id text not null default 'endpoint';

alter table public.checks
  add column if not exists config_json jsonb not null default '{}'::jsonb;

alter table public.check_runs
  add column if not exists result_json jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'checks_plugin_id_not_blank') then
    alter table public.checks
      add constraint checks_plugin_id_not_blank check (length(trim(plugin_id)) > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'checks_config_object') then
    alter table public.checks
      add constraint checks_config_object check (jsonb_typeof(config_json) = 'object');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'check_runs_result_object') then
    alter table public.check_runs
      add constraint check_runs_result_object check (jsonb_typeof(result_json) = 'object');
  end if;
end;
$$;

update public.checks
set plugin_id = 'endpoint'
where plugin_id is null or trim(plugin_id) = '';

update public.checks
set config_json = '{}'::jsonb
where config_json is null;

update public.check_runs
set result_json = '{}'::jsonb
where result_json is null;
