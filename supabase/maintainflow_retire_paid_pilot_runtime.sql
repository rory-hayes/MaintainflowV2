-- Retire the obsolete paid-pilot runtime without deleting historical lead data.
-- This migration is intentionally additive/destructive only to executable
-- capabilities: contact_sales_leads rows and their audit history are preserved.

begin;

do $retire_paid_pilot_job$
begin
  if to_regclass('cron.job') is not null then
    begin
      perform cron.unschedule('maintainflow-retry-pilot-lead-notifications');
    exception
      when others then
        null;
    end;
  end if;
end;
$retire_paid_pilot_job$;

drop function if exists public.claim_contact_sales_lead_notifications(uuid, integer);
drop function if exists public.record_contact_sales_lead_notification_result(uuid, text, text);
drop function if exists public.record_contact_sales_lead_notification_result(uuid, integer, text, text);
drop function if exists public.requeue_contact_sales_lead_notification(uuid);
drop function if exists public.provision_accepted_pilot_workspace(uuid, text, text, text, citext, text, text, timestamptz);

commit;
