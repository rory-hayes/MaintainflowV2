-- Maintain Flow scheduler verification
-- Run this after supabase/maintainflow_scheduler.sql and scheduler configuration.
-- These checks are read-only and do not claim or execute due checks.

select extname
from pg_extension
where extname in ('pg_cron', 'pg_net', 'supabase_vault')
order by extname;

select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'checks'
  and column_name in ('lease_expires_at', 'leased_by', 'last_claimed_at')
order by column_name;

select to_regprocedure('public.claim_due_checks(integer, integer, text)') as claim_due_checks_rpc;

select to_regprocedure('public.claim_due_journey_schedules(text, integer, integer)') as claim_due_journey_schedules_rpc;
select to_regprocedure('public.claim_eval_runs_for_dispatch(text, integer, integer)') as eval_dispatch_recovery_rpc;

select pg_get_function_result(to_regprocedure('public.claim_due_checks(integer, integer, text)'))
  as claim_due_checks_return_contract;

select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name = 'claim_due_checks'
order by grantee, privilege_type;

select
  c.agency_id,
  count(*) as due_checks
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
group by c.agency_id
order by due_checks desc;

select jobid, jobname, schedule, active,
  command ~* 'timeout_milliseconds\s*:=\s*60000' as transport_timeout_ready,
  command ~* '''batchSize''\s*,\s*5' as five_check_wave_ready
from cron.job
where jobname in ('maintainflow-run-checks', 'maintainflow-run-checks-2')
order by jobname;

select jobid, jobname, schedule, active,
  command like '%/api/cron/run-evals%' as business_evals_route_ready,
  command ~* 'timeout_milliseconds\s*:=\s*60000' as transport_timeout_ready,
  command ~* '''batchSize''\s*,\s*5' as five_eval_wave_ready
from cron.job
where jobname = 'maintainflow-run-evals';

select jobid, jobname, schedule, active,
  command like '%/api/cron/deliver-eval-alerts%' as eval_alert_route_ready,
  command ~* 'timeout_milliseconds\s*:=\s*60000' as transport_timeout_ready,
  command ~* '''batchSize''\s*,\s*10' as ten_alert_wave_ready
from cron.job
where jobname = 'maintainflow-deliver-eval-alerts';

select count(*) = 2
  and count(distinct jobname) = 2
  and bool_and(active)
  and bool_and(schedule = '* * * * *')
  and bool_and(command like '%/api/cron/run-checks%')
  and bool_and(command ~* 'timeout_milliseconds\s*:=\s*60000')
  and bool_and(command ~* '''batchSize''\s*,\s*5')
  as scheduler_capacity_ready
from cron.job
where jobname in ('maintainflow-run-checks', 'maintainflow-run-checks-2');

select count(*) = 1
  and bool_and(active)
  and bool_and(schedule = '* * * * *')
  and bool_and(command like '%/api/cron/run-evals%')
  and bool_and(command ~* 'timeout_milliseconds\s*:=\s*60000')
  and bool_and(command ~* '''batchSize''\s*,\s*5')
  as business_evals_scheduler_ready
from cron.job
where jobname = 'maintainflow-run-evals';

select count(*) = 1
  and bool_and(active)
  and bool_and(schedule = '* * * * *')
  and bool_and(command like '%/api/cron/deliver-eval-alerts%')
  and bool_and(command ~* 'timeout_milliseconds\s*:=\s*60000')
  and bool_and(command ~* '''batchSize''\s*,\s*10')
  as business_eval_alert_scheduler_ready
from cron.job
where jobname = 'maintainflow-deliver-eval-alerts';

select not exists (
  select 1
  from cron.job
  where jobname = 'maintainflow-retry-pilot-lead-notifications'
) as retired_paid_pilot_retry_job_absent;

-- Optional: inspect recent pg_net responses after the cron job has run.
-- Some Supabase projects restrict direct access to this schema.
-- select id, status_code, timed_out, error_msg, created
-- from net._http_response
-- order by created desc
-- limit 10;
