-- Maintain Flow scheduler capacity contract
--
-- Run only after the concurrent five-check application artifact has been
-- proven live. It preserves the installed Vault-backed or direct command and
-- raises both minute workers from the expansion-safe batch of one to five.

begin;

do $activate_scheduler_capacity$
declare
  installed_command text;
  capacity_command text;
begin
  if to_regclass('cron.job') is null then
    return;
  end if;

  select command
  into installed_command
  from cron.job
  where jobname = 'maintainflow-run-checks'
  order by jobid
  limit 1;

  if installed_command is null then
    return;
  end if;

  if installed_command !~* 'timeout_milliseconds\s*:=\s*60000' then
    raise exception 'maintainflow-run-checks must use the reviewed 60-second timeout before capacity activation';
  end if;

  if installed_command !~* '''batchSize''\s*,\s*[0-9]+' then
    raise exception 'maintainflow-run-checks must carry an explicit compatibility batch before capacity activation';
  end if;

  capacity_command := regexp_replace(
    installed_command,
    '''batchSize''\s*,\s*[0-9]+',
    '''batchSize'', 5',
    'gi'
  );

  begin
    perform cron.unschedule('maintainflow-run-checks');
  exception
    when others then
      null;
  end;

  begin
    perform cron.unschedule('maintainflow-run-checks-2');
  exception
    when others then
      null;
  end;

  perform cron.schedule(
    'maintainflow-run-checks',
    '* * * * *',
    capacity_command
  );

  perform cron.schedule(
    'maintainflow-run-checks-2',
    '* * * * *',
    capacity_command
  );
end;
$activate_scheduler_capacity$;

commit;
