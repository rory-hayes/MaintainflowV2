-- Phase-2 evidence write contraction.
--
-- Apply only after the application artifact that writes check evidence through
-- record_assurance_check_result has been promoted and verified. The expansion
-- phase intentionally preserves the legacy authenticated write path so a
-- failed pre-promotion build cannot break the previously live application.

begin;

-- Historical evidence remains visible to workspace members, but browser JWTs
-- cannot create, mutate, or delete it. Service writes bypass these RLS policies
-- and the atomic RPC owns check-run persistence after contraction.
alter table public.check_runs enable row level security;
alter table public.check_job_runs enable row level security;

drop policy if exists check_runs_members_all on public.check_runs;
drop policy if exists check_runs_members_select on public.check_runs;
drop policy if exists check_runs_members_insert_legacy on public.check_runs;
drop policy if exists check_runs_members_update_legacy on public.check_runs;
drop policy if exists check_runs_members_delete_legacy on public.check_runs;
create policy check_runs_members_select on public.check_runs
for select to authenticated
using ((select public.is_agency_member(agency_id)));

drop policy if exists check_job_runs_members_all on public.check_job_runs;
drop policy if exists check_job_runs_members_select on public.check_job_runs;
create policy check_job_runs_members_select on public.check_job_runs
for select to authenticated
using ((select public.is_agency_member(agency_id)));

revoke insert, update, delete on public.check_runs, public.check_job_runs from authenticated;
revoke insert (
  id,
  agency_id,
  client_id,
  workflow_id,
  check_id,
  status,
  status_code,
  latency_ms,
  assertion_results_json,
  result_json,
  safe_response_summary,
  error_message,
  cost_estimate,
  model,
  prompt_version,
  started_at,
  completed_at,
  created_at
) on public.check_runs from authenticated;
revoke update (
  id,
  agency_id,
  client_id,
  workflow_id,
  check_id,
  status,
  status_code,
  latency_ms,
  assertion_results_json,
  result_json,
  safe_response_summary,
  error_message,
  cost_estimate,
  model,
  prompt_version,
  started_at,
  completed_at,
  created_at
) on public.check_runs from authenticated;
grant select on public.check_runs, public.check_job_runs to authenticated;
grant select, insert on public.check_runs, public.check_job_runs to service_role;

commit;
