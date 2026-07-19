# Data Model

This document defines the product data model. Names may be adapted to the ORM/schema, but relationships and tenancy must remain.

## agencies

- id
- name
- slug
- logo_url
- primary_color
- plan
- trial_ends_at
- stripe_customer_id
- stripe_subscription_id
- created_at
- updated_at

## users / profiles

- id
- email
- name
- avatar_url
- created_at

## memberships

- id
- agency_id
- user_id
- role: owner/admin/member
- created_at

## clients

- id
- agency_id
- name
- slug
- website
- logo_url
- owner_user_id
- report_recipient_email
- report_cadence
- notes
- archived_at
- created_at
- updated_at

## workflows

- id
- agency_id
- client_id
- name
- type
- environment
- endpoint_url
- method
- auth_type
- encrypted_auth_config
- report_included
- status
- health_score
- last_check_run_at
- archived_at
- created_at
- updated_at

Journey archive/restore is a service-only, tenant-scoped transition over the existing `workflows.archived_at` compatibility field. It never deletes Journey versions or evidence. The transition disables schedules and legacy checks, preserves protected pause reasons, records an actor-attributed audit event, and restores into a paused, unscheduled state subject to the current Journey quota and an active parent Project.

## checks

- id
- agency_id
- workflow_id
- name
- type: health/synthetic/manual_log
- enabled
- pending_setup
- config_json
- schedule_minutes
- last_run_at
- next_run_at
- created_at
- updated_at

## check_runs

- id
- agency_id
- client_id
- workflow_id
- check_id
- status: healthy/degraded/failed/skipped
- status_code
- latency_ms
- assertion_results_json
- safe_response_summary
- error_message
- cost_estimate
- model
- prompt_version
- started_at
- completed_at
- created_at

## issues

- id
- agency_id
- client_id
- workflow_id
- check_run_id
- verification_run_id
- check_id
- dedupe_key
- severity: low/medium/high/critical
- status: open/in_review/snoozed/resolved/ignored
- title
- description
- suggested_action
- owner_user_id
- reportable
- occurrence_count
- snoozed_until
- repair_recorded_at
- resolved_at
- resolution_note
- report_safe_summary
- created_at
- updated_at

## issue_notes

- id
- agency_id
- issue_id
- user_id
- body
- report_safe
- created_at

## test_packs

- id
- agency_id
- workflow_id
- name
- description
- enabled
- created_at

## test_cases

- id
- agency_id
- test_pack_id
- name
- input_json
- assertions_json
- expected_json
- created_at

## test_runs

- id
- agency_id
- workflow_id
- test_pack_id
- status
- pass_rate
- results_json
- started_at
- completed_at

## reports

- id
- agency_id
- client_id
- period_start
- period_end
- status: draft/ready/sent/blocked
- narrative
- readiness_json
- metrics_json
- snapshot_version
- snapshot_json
- evidence_fingerprint
- stale_at
- pdf_storage_path
- pdf_snapshot_version
- sent_at
- created_at
- updated_at

## audit_events

- id
- agency_id
- actor_user_id
- entity_type
- entity_id
- action
- metadata_json
- created_at

## run_log_keys

- id
- agency_id
- workflow_id
- key_hash
- label
- last_used_at
- revoked_at
- created_at

## Important constraints

- Every customer-owned row must include agency_id.
- Every query must be scoped by agency_id.
- Public run-log keys must bind to exactly one workflow.
- Reports must only include selected client data.
- A resolved issue must have repair evidence and a linked newer healthy run for the same agency, client, workflow, and check.
- Report snapshots are immutable versions; evidence changes block the report until an explicit refresh creates the next version.
- Storage objects must be private, agency-scoped, version-bound, and immutable to authenticated browser users. Only the server-side service role creates snapshot PDFs.
