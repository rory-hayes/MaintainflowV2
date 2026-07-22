-- Maintain Flow Browser Context cleanup scheduler
--
-- Expansion-safe and idempotent. This derives the cleanup request from the
-- already-installed Business Evals command so both Vault-backed and direct
-- scheduler installations retain their existing URL and credential handling.
-- The legacy eval scheduler is inspected only and is never replaced.

begin;

do $schedule_browser_context_cleanup$
declare
  installed_eval_command text;
  cleanup_command text;
begin
  if to_regclass('cron.job') is null then
    return;
  end if;

  select command
  into installed_eval_command
  from cron.job
  where jobname = 'maintainflow-run-evals'
  order by jobid
  limit 1;

  if installed_eval_command is null then
    return;
  end if;

  if installed_eval_command not like '%/api/cron/run-evals%' then
    raise exception 'maintainflow-run-evals must target the reviewed eval route before cleanup scheduling';
  end if;

  if installed_eval_command !~* 'timeout_milliseconds\s*:=\s*[0-9]+' then
    raise exception 'maintainflow-run-evals must declare timeout_milliseconds before cleanup scheduling';
  end if;

  cleanup_command := replace(
    installed_eval_command,
    '/api/cron/run-evals',
    '/api/cron/cleanup-browser-contexts'
  );
  cleanup_command := regexp_replace(
    cleanup_command,
    'timeout_milliseconds\s*:=\s*[0-9]+',
    'timeout_milliseconds := 60000',
    'gi'
  );

  if cleanup_command ~* '''batchSize''\s*,\s*[0-9]+' then
    cleanup_command := regexp_replace(
      cleanup_command,
      '''batchSize''\s*,\s*[0-9]+',
      '''batchSize'', 4',
      'gi'
    );
  elsif position('''scheduled_at'', now()' in cleanup_command) > 0 then
    cleanup_command := replace(
      cleanup_command,
      '''scheduled_at'', now()',
      '''scheduled_at'', now(), ''batchSize'', 4'
    );
  else
    raise exception 'maintainflow-run-evals must declare scheduled_at before the cleanup batch can be injected safely';
  end if;

  begin
    perform cron.unschedule('maintainflow-cleanup-browser-contexts');
  exception
    when others then
      null;
  end;

  perform cron.schedule(
    'maintainflow-cleanup-browser-contexts',
    '* * * * *',
    cleanup_command
  );
end;
$schedule_browser_context_cleanup$;

commit;
