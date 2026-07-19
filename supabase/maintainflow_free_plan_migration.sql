-- Maintain Flow free plan migration
-- Run this once in the Supabase SQL editor before deploying app code that
-- creates new agencies on the Free plan.

begin;

drop type if exists public.agency_plan_next;

create type public.agency_plan_next as enum ('free', 'starter', 'growth', 'scale', 'agency_plus');

alter table public.agencies
  alter column plan drop default,
  alter column plan type public.agency_plan_next
    using plan::text::public.agency_plan_next,
  alter column plan set default 'free'::public.agency_plan_next;

update public.agencies
set plan = 'free'::public.agency_plan_next,
    updated_at = now()
where plan = 'growth'::public.agency_plan_next
  and stripe_customer_id is null
  and stripe_subscription_id is null;

drop type public.agency_plan;
alter type public.agency_plan_next rename to agency_plan;

commit;
