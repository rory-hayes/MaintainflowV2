-- Phase 1 of the assurance rollout: add only columns consumed by the new app.
-- This migration is safe to run while the previous application artifact is live
-- and safe to rerun before the phase-2 integrity contract is applied.

begin;

alter table public.issues
  add column if not exists repair_recorded_at timestamptz,
  add column if not exists verification_run_id uuid;

alter table public.reports
  add column if not exists snapshot_version integer not null default 0,
  add column if not exists snapshot_json jsonb not null default '{}'::jsonb,
  add column if not exists evidence_fingerprint text not null default '',
  add column if not exists stale_at timestamptz,
  add column if not exists pdf_snapshot_version integer;

alter table public.report_items
  add column if not exists snapshot_version integer not null default 0;

commit;
