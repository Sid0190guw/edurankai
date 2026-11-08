# SAMARTH database schema

Source of truth: `SAMARTH_DDL` in `src/lib/samarth/schema.ts`; identical hand-run copy in `db/samarth-schema.sql` (a test enforces it). All `CREATE ... IF NOT EXISTS`; no `ALTER`, no `REFERENCES`, so a run on a populated database changes nothing and there is no creation order.

**Production:** bootstrap DDL is disabled, so run `/admin/setup` (module `samarth`) or `psql -v ON_ERROR_STOP=1 -f db/samarth-schema.sql`. `/api/health` lists `samarth_applications`, `samarth_fee_schedule` and `samarth_x_progress` while they are missing.

| Table | Purpose | Key columns |
|---|---|---|
| `samarth_fee_schedule` | Booking fee per category and currency | `category` (or `*`), `currency`, `amount_minor`, `tax_mode`, `tax_label`, `tax_rate_bp`, `processing_bp`, `charges_note`, `terms`, `status` draft/approved/retired, approval fields |
| `samarth_applications` | Consultation requests | `ref` SAM-A-..., `status`, `category`, `country`, contact and organisation fields, `official` JSONB (level, jurisdiction, department, office, representative, authority reference, procurement), `pathway`, `need`, `title`, `summary`, `requirements` JSONB (applicant's own answers), `documents` JSONB (links), fee snapshot fields, payment fields, `booking` JSONB, consultant and call fields, consents, `access_hash`, `archived` |
| `samarth_engagements` | Later quotations and engagements | `ref` SAM-E-..., `application_id`, `kind`, `package_code`, `status`, scope fields, `delivery_model`, `responsibility`, `partner_ids` JSONB, `currency`, `amount_minor`, tax fields, `total_minor`, `terms`, `valid_until`, approval, acceptance, payment and `award_reference` |
| `samarth_events` | Timeline of every record | `subject_type` application/engagement/partner/x, `subject_id`, `kind`, `from_status`, `to_status`, `body`, `visibility` internal/applicant, actor |
| `samarth_partners` | Partner registry | `ref` SAM-P-..., `status`, profile fields, `domains` JSONB, claimed credentials, `documents` JSONB, `dd_checklist` JSONB, `rating`, `performance_note`, `access_hash` |
| `samarth_x_candidates` | SAMARTH X, all channels | `ref` SAM-X-..., `channel` eoi/event/recruitment, `status`, applicant and team, venture fields, links, source fields, `cohort`, `agreement_reference`, `access_hash` |
| `samarth_x_reviews` | One review per reviewer per candidate | `scores` JSONB, `total`, `recommendation`; unique (candidate, reviewer) |
| `samarth_x_progress` | Milestones, resources, demos, showcase | `kind`, `title`, `due_date`, `state`, `url` |

Shared table used: `payments` (purposes `samarth_booking_fee`, `samarth_engagement`; reference types `samarth_application`, `samarth_engagement`). Invoices live in the platform invoice tables.

Money is stored in **minor units of the priced currency** (`*_minor`), except gateway charges, which are INR paise (`charged_inr_paise`, `payments.amount_paise`).

## Statuses
- Application: DRAFT, DETAILS_COMPLETE, REQUIREMENTS_COMPLETE, FEE_PENDING, FEE_PAID, BOOKING_REQUESTED, CONSULTANT_ASSIGNED, CALL_SCHEDULED, CALL_COMPLETED, CLOSED; terminal WITHDRAWN, DECLINED, CANCELLED.
- Engagement: DRAFT, PENDING_APPROVAL, APPROVED, SENT, ACCEPTED, IN_DELIVERY, COMPLETED; terminal DECLINED, EXPIRED, WITHDRAWN, CANCELLED.
- Partner: REGISTERED, UNDER_REVIEW, DUE_DILIGENCE, APPROVED, SUSPENDED, REJECTED.
- SAMARTH X: RECEIVED, SCREENING, TECHNICAL_ASSESSMENT, SHORTLISTED, SELECTED, INCUBATING, ALUMNI; terminal NOT_SELECTED, WITHDRAWN.

## Planned, not created
Engagement milestones and delivery stages (Module 06), partner quotations per engagement and consortium records (07), contract documents (10), assistant conversations with consent (05). They will be added as new `CREATE TABLE IF NOT EXISTS` statements, never as changes to existing tables' meaning.
