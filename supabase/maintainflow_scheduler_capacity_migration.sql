-- Maintain Flow scheduler capacity hardening
--
-- Expansion-safe and idempotent. This preserves the already-installed cron
-- command (including its Vault-backed or direct secret handling), raises the
-- pg_net timeout to 60 seconds, and runs two compatibility workers every
-- minute. Each request explicitly asks the previously live sequential runner
-- for only one check. Contract phase raises the proven concurrent runner to
-- five checks per request.

begin;

do $harden_scheduler_capacity$
declare
  installed_command text;
  hardened_command text;
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

  if installed_command !~* 'timeout_milliseconds\s*:=\s*[0-9]+' then
    raise exception 'maintainflow-run-checks must declare timeout_milliseconds before it can be upgraded safely';
  end if;

  hardened_command := regexp_replace(
    installed_command,
    'timeout_milliseconds\s*:=\s*[0-9]+',
    'timeout_milliseconds := 60000',
    'gi'
  );

  if hardened_command ~* '''batchSize''\s*,\s*[0-9]+' then
    hardened_command := regexp_replace(
      hardened_command,
      '''batchSize''\s*,\s*[0-9]+',
      '''batchSize'', 1',
      'gi'
    );
  elsif position('''scheduled_at'', now()' in hardened_command) > 0 then
    hardened_command := replace(
      hardened_command,
      '''scheduled_at'', now()',
      '''scheduled_at'', now(), ''batchSize'', 1'
    );
  else
    raise exception 'maintainflow-run-checks must declare scheduled_at before a compatibility batch can be injected safely';
  end if;

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
    hardened_command
  );

  perform cron.schedule(
    'maintainflow-run-checks-2',
    '* * * * *',
    hardened_command
  );
end;
$harden_scheduler_capacity$;

commit;
