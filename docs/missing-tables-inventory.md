# Tables the code creates that production does not have

Generated 2026-08-24. **295 tables across 82 files.** Regenerate before trusting
it — this is a snapshot and the repository moves.

## How to regenerate

Collect every `CREATE TABLE IF NOT EXISTS` under `src/`, diff the names against the live database,
group by the file that owns the CREATE. The live half is one read-only query:

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
```

The code half is a text scan of the repository and needs no database connection.

## Why most of this list is not a bug

A table for a feature nobody has opened is not an outage. Of the 325 found on 2026-08-24, the ones
worth fixing were the ones a **page under `src/pages`** creates — somebody navigating the site
reaches those, and each rendered as an empty list or a silently failed save rather than an error.
Those are done: `db/reachable-surfaces-schema.sql`, `db/capability-spine-schema.sql`,
`db/performance-remainder-schema.sql`, `db/hiring-decision-schema.sql`, and a one-word fix that let
`db/aquintutor-campus-schema.sql` run to completion for the first time since it was written.

What remains below is owned by **library modules**, and the position on them is deliberate:

- **Do not pre-create them.** DDL for a subsystem no shipped surface reaches produces schema nobody
  can verify against a real writer. The right moment to write each file is when its surface ships,
  because that is the first moment the table's shape can be checked against something that uses it.
- **Three groups are not "unshipped", they are unresolved.** `tal_*` (29) and `tos_*` (28) are the two
  parallel recruitment stacks nobody has chosen between — creating either set would quietly make that
  decision. `mp_*` (63 across three files) is the mail platform, which several agents built in one tree.
- **The count is a map, not a to-do list.** Read a row before acting on it.

## Two things this method cannot see

**Columns.** `information_schema.tables` answers "does the table exist" and nothing else. A parent
table that exists while the columns its writers name do not passes every check this project has —
that is the `hr_clock_events` shape, and the 27 appraisal columns in
`db/performance-alters-schema.sql`. Any sweep like this one has the same blind spot.

**Invalid DDL.** A statement can be *syntactically wrong* rather than suppressed, in which case the
table exists in no database anywhere, including a fresh restore. `senior_placement_requests` named a
column `current_role`, reserved in Postgres, so its CREATE had never once succeeded — in the page or
in the schema file. Absent everywhere means read the statement; absent only in production means read
`src/lib/ensure-once.ts`.

## The inventory

| Owning file | Count | Tables |
| --- | --- | --- |
| `src/lib/mailplatform/schema.ts` | 47 | mp_aliases, mp_audit_logs, mp_bounce_events, mp_campaign_events, mp_campaign_recipients, mp_campaigns, mp_contact_events, mp_contact_list_members, mp_contact_lists, mp_contact_tag_members, mp_contact_tags, mp_contacts, mp_custom_fields, mp_delivery_attempts, mp_delivery_events, mp_delivery_status, mp_dkim_keys, mp_dns_records, mp_domain_settings, mp_domain_verifications, mp_domains, mp_email_addresses, mp_events, mp_folders, mp_labels, mp_mailbox_members, mp_mailboxes, mp_message_headers, mp_message_labels, mp_organization_members, mp_organizations, mp_role_permissions, mp_roles, mp_schema_migrations, mp_sending_domains, mp_sending_identities, mp_suppression_entries, mp_template_versions, mp_templates, mp_threads, mp_webhook_deliveries, mp_webhook_endpoints, mp_workflow_edges, mp_workflow_events, mp_workflow_nodes, mp_workflow_runs, mp_workflows |
| `src/lib/talent/schema.ts` | 29 | tal_access_group, tal_access_policy, tal_access_request, tal_application, tal_application_stage, tal_candidate_profile, tal_document_ref, tal_evaluation, tal_event, tal_external_application_ref, tal_id_series, tal_identity, tal_identity_access, tal_ingest_quarantine, tal_interview, tal_onboarding_application, tal_onboarding_code, tal_onboarding_code_attempt, tal_opportunity, tal_opportunity_evaluator, tal_person, tal_person_identifier, tal_person_merge, tal_pipeline, tal_pipeline_stage, tal_provisioning_run, tal_recruitment_source, tal_selection_decision, tal_source_key |
| `src/lib/talentos/schema.ts` | 28 | tos_access_profile, tos_access_request, tos_app_system, tos_application_link, tos_auth_code, tos_code_attempt, tos_code_challenge, tos_correction_request, tos_evaluation, tos_form_definition, tos_form_field, tos_idempotency, tos_identity, tos_internal_consent, tos_notification_log, tos_onboarding, tos_onboarding_grant, tos_opportunity, tos_override, tos_person, tos_person_email, tos_pipeline, tos_pipeline_stage, tos_provisioning_event, tos_rate_event, tos_selection, tos_stage_evaluator, tos_stage_run |
| `src/lib/mailplatform/saas/pg-store.ts` | 11 | mp_billing_events, mp_enterprise_terms, mp_invoices, mp_org_profiles, mp_plans, mp_quota_notices, mp_subscriptions, mp_team_members, mp_teams, mp_usage_counters, mp_usage_events |
| `src/lib/horizon/schema.ts` | 9 | hzn_access_log, hzn_computation, hzn_event, hzn_evidence, hzn_feedback_contribution, hzn_intelligence_result, hzn_profile, hzn_report, hzn_signal |
| `src/lib/aquin/schema.ts` | 7 | aq_audit, aq_course_authors, aq_role_capabilities, aq_roles, aq_sessions, aq_user_roles, aq_users |
| `src/lib/feed.ts` | 7 | ar_filters, feed_comments, feed_likes, feed_posts, feed_saves, feed_user_interests, feed_view_events |
| `src/lib/hr-intelligence/schema.ts` | 6 | hri_access_log, hri_development_plans, hri_feedback_requests, hri_interventions, hri_mobility_reviews, hri_plan_items |
| `src/lib/invoices.ts` | 6 | invoice_lines, invoice_payments, invoice_series, invoice_tax_components, invoice_tax_lines, invoices |
| `src/lib/foundational/schema.ts` | 5 | fpc_computation, fpc_consent, fpc_factor, fpc_period, fpc_subject_input |
| `src/lib/mail-shared.ts` | 5 | mail_shared_events, mail_shared_mailboxes, mail_shared_members, mail_shared_notes, mail_shared_threads |
| `src/lib/mailops/continuity-store.ts` | 5 | mailops_backup_runs, mailops_component_status, mailops_migration_runs, mailops_objectives, mailops_restore_tests |
| `src/lib/mailplatform/domains/store.ts` | 5 | mp_alias_targets, mp_auto_reply_log, mp_domain_health, mp_mailbox_settings, mp_secrets |
| `src/lib/announcements.ts` | 4 | announcement_acks, announcement_versions, announcements, feed_celebration_optin |
| `src/lib/eims-credit.ts` | 4 | eims_credit_configs, eims_final_records, eims_rubric_criteria, eims_rubric_scores |
| `src/lib/fusion/schema.ts` | 4 | hif_notes, hif_readings, hif_snapshots, hif_weight_profiles |
| `src/lib/horizon/governance/schema.ts` | 4 | hgov_decision_log, hgov_engine_version, hgov_erasure_request, hgov_retention_policy |
| `src/lib/benefits.ts` | 3 | hr_benefit_enrolments, hr_benefit_rules, hr_benefits |
| `src/lib/credential-store.ts` | 3 | cr_credentials, cr_institutions, cr_recognitions |
| `src/lib/crm.ts` | 3 | crm_activities, crm_contacts, crm_deals |
| `src/lib/edu-community.ts` | 3 | edu_posts, edu_reports, edu_threads |
| `src/lib/eims-outcomes.ts` | 3 | eims_outcome_assessments, eims_outcome_links, eims_outcomes |
| `src/lib/evidence-graph.ts` | 3 | capability_claims, capability_evidence, capability_verifications |
| `src/lib/horizon/intake/schema.ts` | 3 | hzn_consent_event, hzn_personal_foundation, hzn_recompute_request |
| `src/lib/horizon/interpretation/store.ts` | 3 | horizon_dimension_factors, horizon_dimension_results, horizon_interpretations |
| `src/lib/intelligence/schema.ts` | 3 | emp_intel_consent, emp_intel_correction, emp_intel_reflection |
| `src/lib/interview-intelligence.ts` | 3 | interview_intel_assessments, interview_intel_observations, interview_intel_snapshots |
| `src/lib/learning-admin.ts` | 3 | learning_certificate_actions, learning_completion_overrides, learning_completion_rules |
| `src/lib/mailplatform/events.ts` | 3 | mail_events, mp_event_stream, mp_event_stream_default |
| `src/lib/manager-intelligence/schema.ts` | 3 | mti_development_actions, mti_manager_actions, mti_record_outbox |
| `src/lib/scholarships.ts` | 3 | scholarship_awards, scholarship_courses, scholarships |
| `src/lib/aes/session.ts` | 2 | aes_session_commands, aes_sessions |
| `src/lib/ai-boundary.ts` | 2 | ai_human_decisions, ai_recommendations |
| `src/lib/aquin-competencies.ts` | 2 | aquin_competencies, aquin_competency_progress |
| `src/lib/aquintutor-calendar.ts` | 2 | aq_calendar_feed, aq_study_plan |
| `src/lib/calendar.ts` | 2 | edu_deadlines, edu_reminder_sent |
| `src/lib/enrolment.ts` | 2 | edu_course_meta, edu_enrolments |
| `src/lib/horizon/feedback/schema.ts` | 2 | hr_feedback_dimensions, hr_feedback_examples |
| `src/lib/horizon/signal-engine.ts` | 2 | hzn_signal_lifecycle, hzn_signal_state |
| `src/lib/mail-drafts.ts` | 2 | mail_draft_revisions, mail_drafts |
| `src/lib/mentors.ts` | 2 | mentor_sessions, mentors |
| `src/lib/moderation.ts` | 2 | edu_mod_queue, edu_room_moderation |
| `src/lib/offline-package.ts` | 2 | edu_offline_packages, edu_offline_policy |
| `src/lib/proctor.ts` | 2 | edu_proctor_events, edu_proctor_policy |
| `src/lib/safety.ts` | 2 | sos_events, user_locations |
| `src/lib/settlement.ts` | 2 | hr_settlement_lines, hr_settlements |
| `src/lib/skill-ontology.ts` | 2 | skill_aliases, skill_relations |
| `src/lib/admissions.ts` | 1 | edu_applications |
| `src/lib/aquintutor-atelier.ts` | 1 | aq_atelier_evidence |
| `src/lib/aquintutor-share.ts` | 1 | aq_progress_share |
| `src/lib/ask-aquin.ts` | 1 | edu_tutor_log |
| `src/lib/ask/log.ts` | 1 | ask_log |
| `src/lib/attendance-lapse.ts` | 1 | hr_profile_pauses |
| `src/lib/board-assess.ts` | 1 | edu_board_assessments |
| `src/lib/board-translate.ts` | 1 | edu_board_translations |
| `src/lib/course-access.ts` | 1 | training_enrolment_transitions |
| `src/lib/course-payments.ts` | 1 | edu_course_payments |
| `src/lib/credential.ts` | 1 | edu_credentials |
| `src/lib/crypto/schema.ts` | 1 | crypto_keys |
| `src/lib/edu-notify.ts` | 1 | edu_notifications |
| `src/lib/fee-engine.ts` | 1 | fee_schedule_items |
| `src/lib/gamification.ts` | 1 | learner_badges |
| `src/lib/hiring/invitations.ts` | 1 | application_invitations |
| `src/lib/horizon/integration/collect.ts` | 1 | written |
| `src/lib/horizon/report/runs.ts` | 1 | hzn_report_run |
| `src/lib/hr-events.ts` | 1 | hr_events |
| `src/lib/hr-lifecycle.ts` | 1 | hr_probation_decisions |
| `src/lib/hr-separation.ts` | 1 | hr_separation_clearance |
| `src/lib/hub.ts` | 1 | edu_facilities |
| `src/lib/job-twin.ts` | 1 | job_requirements |
| `src/lib/learning-object.ts` | 1 | training_learning_objects |
| `src/lib/learning-progress.ts` | 1 | statements |
| `src/lib/mailapi/send.ts` | 1 | mailapi_daily_sends |
| `src/lib/mailplatform/bench-store.ts` | 1 | mp_bench_reports |
| `src/lib/match.ts` | 1 | match_weight_profiles |
| `src/lib/plugins/schema.ts` | 1 | edu_plugin_registry |
| `src/lib/provenance.ts` | 1 | provenance_records |
| `src/lib/recognition.ts` | 1 | recognitions |
| `src/lib/render-policy.ts` | 1 | edu_render_overrides |
| `src/lib/render-profile.ts` | 1 | edu_device_profile |
| `src/lib/security/schema.ts` | 1 | security_signals |
| `src/lib/xscale/schema.ts` | 1 | divisions |
