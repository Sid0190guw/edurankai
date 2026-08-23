# EduRankAI Talent Operating System — Implementation Specification

**Version** 1.0 · **Date** 2026-08-18 · **Status** For implementation and parallel review
**Scope** Careers, recruitment, seven-stage evaluation, selection authorization, onboarding,
organizational identity, and access provisioning.

---

## 0. How to read this document

This specification is written to be implemented by an engineer or an agent who has **not** seen the
originating discussion. Everything needed is here.

Three kinds of statement appear, and they bind differently:

| Marker | Meaning |
|---|---|
| **MUST** | Conformance requirement. A build that omits it does not satisfy this spec. |
| **MUST NOT** | Prohibition. Usually the record of a failure that has already cost this project. |
| **SHOULD** | Strong default. Deviating requires a written note in the PR description. |

Section numbers from the originating brief are cross-referenced as `[brief §N]` so a parallel
reviewer can check coverage line by line. A full coverage matrix is at §26.

**This is a specification for one existing codebase**, not a greenfield design. §1 is therefore the
most important section in the document: it lists what is already built. A build that recreates
`applications`, `roles`, `departments`, `hr_employees`, the RBAC engine, or the org graph is a
**failed** build regardless of how well the new code works.

---

## 1. Reality baseline — what already exists and MUST NOT be rebuilt

The repository is `edurankai` (Astro 5, Drizzle ORM over postgres-js, Supabase Postgres). The
following already exist and are in production use. New work extends them.

### 1.1 Tables that already exist

| Table | Owner module | What it already holds |
|---|---|---|
| `users` | `src/lib/db/schema.ts` | Auth account: email, password hash, `role` enum, `is_active`, `assigned_department_id`, `internal_handle`. **Auth only. Not a person, not an employee.** |
| `sessions` | same | Server-side sessions. |
| `departments` | same | `id` is a **varchar(50) slug** (`hr`, `ai`, `product`), not a UUID. |
| `roles` | same | The opportunity catalogue behind `/careers`: `slug`, `department_id`, `title`, `level`, `engagement_type`, `about`, `responsibilities`, `skills`, `eligibility`, `is_open`, `application_deadline`. |
| `applications` | same | One recruitment application. ~60 columns of candidate answers, `status` enum, `stage` varchar (runtime column), fee fields, `raw_submission` jsonb. |
| `application_drafts` | same | Cross-device draft of an in-progress application, keyed by email. |
| `application_stage_events` | `src/lib/application-stages.ts` | Per-stage history for the candidate-visible funnel. |
| `application_sources` | `src/lib/application-sources.ts` | **Admin-managed** recruitment channel list, with usage counts and moderated "Other" suggestions. |
| `offer_letters` | `src/lib/db/schema.ts` | Offer document: `token`, `ref_number`, `integrity_hash`, signature capture, withdraw/decline. |
| `invite_tokens` | same | Single-use account-activation tokens bound to `user_id` + `application_id`. |
| `hr_employees` | `db/hr-schema.sql` | The employment record: `employee_code` (`ERA-EMP-0001`), `full_name`, `work_email`, `designation`, `department_id` (**UUID here — see 1.4**), `employment_type`, `employment_status`, `onboarding_status`, joining/probation/exit dates, statutory and bank fields. |
| `hr_onboarding_documents` | `src/lib/hr-onboarding.ts` | Joining documents as **verified Drive links**, not uploads. |
| `org_relationships` | `db/org-graph-schema.sql` | Layer 1 org graph: `reporting_manager`, `department_head`, `team_lead`, `approval_owner`, … with `effective_from`/`effective_to`/`status`. |
| `org_positions`, `org_teams`, `org_employee_assignments` | same | Positions, and dated assignment of an employee to a position/team/department. |
| `rbac_*` (roles, user roles, permission grants, tokens) | `src/lib/rbac/*` | The capability engine: 16 atomic capabilities, deny-over-allow, nine-state permission lifecycle, ABAC `RuleConditions`, capability tokens, object ACLs. |
| `role_permissions`, `role_permission_grants` | `src/lib/auth/registry.ts` | Admin-section page permissions (`<section>.view`). |
| `audit_log` | `src/lib/audit.ts` | `logAudit({ userId, action, entity, entityId, diff, ipAddress })`. |
| `campus_ambassadors` | `src/lib/campus-ambassadors.ts` | Campus ambassador applications and status. |
| `talent_pool`, `talent_pool_entries`, `talent_registry`, `talent_profiles` | various | **Already taken.** Do not reuse the `talent_` prefix. |

### 1.2 Modules that already implement part of this brief

| Module | Already does | Relationship to this spec |
|---|---|---|
| `src/lib/application-stages.ts` | The candidate-visible **six-step** funnel (`submitted, review, assessment, interview, decision, onboarded`), `CLOSED_STAGES`, and a status/stage projection. | **Kept as the candidate-facing narrative.** The seven-stage framework is the internal evaluation record; §8.6 defines the projection. Do not delete or renumber `STAGES`. |
| `src/lib/hire-completion.ts` | `completeHire()` — creates the `hr_employees` row, mints the employee code, seeds the onboarding journey, notifies, audits. | **Reused verbatim** as the identity-creation step (§13). Called, never reimplemented. |
| `src/lib/hr/employee-code.ts` | `nextEmployeeCode()` / `withEmployeeCode()` — MAX-derived, retry on unique violation. | **Reused.** The defect it fixes (COUNT-based numbering colliding after a delete or a race) MUST NOT be reintroduced for any new code series. |
| `src/lib/onboarding-journey.ts` | Configurable onboarding step templates, engagement-aware step selection, per-item states, owner resolution via the org graph. | **Reused** as the post-approval onboarding checklist (§13.4). |
| `src/lib/hr-onboarding.ts` | Document submission as links with an access-format check, review workflow, progress. | **Reused** as the document layer (§12.5). |
| `src/lib/rbac/*` | RBAC + ABAC evaluation. | **Reused.** Provisioning writes through it (§14) and never bypasses it with direct SQL. |
| `src/lib/org-graph.ts` | Per-row relationship resolution. | **Reused** to resolve reporting manager, department head, approvers. |
| `src/lib/hr-requisition.ts` | Hiring requisition create/decide/list. | An opportunity **MAY** be opened from an approved requisition (§6.5). |
| `src/lib/notify.ts`, `notify-audience.ts`, `notification-catalog.ts` | Notification delivery and audience resolution. | **Reused** for every notification in §19. |
| `src/lib/ensure-once.ts` | `ensureOnce(key, fn)` — per-process memoised idempotent DDL. | **The required bootstrap pattern** for every new table here. |

### 1.3 Surfaces that already exist

- **Public**: `/careers`, `/careers/[slug]`, `/careers/campus-ambassador`, `/careers/membership`,
  `/careers/hr-support`, `/careers/fee-waiver`.
- **Candidate**: `/apply` redirecting into `/apply/step-1` … `/apply/step-6`, `/apply/waiver`,
  `/apply/pay`, `/apply/confirmation`; `/portal/applications`, `/portal/jobs`, `/portal/interviews`,
  `/portal/employee`.
- **Admin**: `/admin/applications` (+ `[id]`, `dedup`, `intents`), `/admin/roles` (+ `[id]`, `new`,
  `diagnose`), `/admin/hr/*`, `/admin/team/roles`, `/admin/access-preview`, `/admin/audit`.

### 1.4 Four traps in the existing data that this build MUST respect

1. **`departments.id` has two types.** `varchar(50)` slug in `src/lib/db/schema.ts`; `UUID` in
   `db/hr-schema.sql`. Every new column storing a department reference **MUST** be `TEXT` and
   **MUST NOT** be cast to `uuid`. A `::uuid` cast throws the first time a slug arrives.
2. **`hr_employees.reporting_manager_id` holds a `users.id`**, while
   `org_relationships.subject_employee_id` holds an `hr_employees.id`. Translate through
   `hr_employees.user_id`. They are not the same id space.
3. **postgres-js returns plain arrays.** `const rows = Array.isArray(r) ? r : (r?.rows || [])`.
   `r.rows[0]` is `undefined` in production.
4. **The real Postgres error is on `e.cause`.** Log `e?.cause?.message || e?.message`.

---

## 2. Domain model — brief entity to implementation

The brief names 25 entities [brief §32]. Each maps to exactly one implementation decision; nothing
is left unmapped.

| Brief entity | Implementation | New? |
|---|---|---|
| Person | `tos_person` | **new** |
| OrganizationalIdentity | `tos_identity` | **new** |
| Candidate | A `tos_person` with at least one application. **Not a table** — see §2.1. | — |
| RecruitmentSource | `application_sources` | existing |
| Opportunity | `roles` + `tos_opportunity` (1:1 config side table) | extend |
| Application | `applications` + `tos_application_link` (person / opportunity / pathway join) | extend |
| SelectionProcess | `tos_pipeline` | **new** |
| SelectionStage | `tos_pipeline_stage` (exactly 7 slots) + `tos_stage_run` (per application) | **new** |
| Assessment | `tos_stage_run` with `kind='assessment'`, referencing the existing tests subsystem | **new** join |
| Assignment | `tos_stage_run` with `kind='assignment'` | **new** |
| Interview | `tos_stage_run` with `kind='interview'`, referencing existing interview scheduling | **new** join |
| Evaluation | `tos_evaluation` — one evaluator's scored verdict on one stage run | **new** |
| SelectionDecision | `tos_selection` | **new** |
| AuthorizationCode | `tos_auth_code` | **new** |
| OnboardingApplication | `tos_onboarding` | **new** |
| Document | `hr_onboarding_documents` | existing |
| Department | `departments` | existing |
| Position | `org_positions` | existing |
| Team | `org_teams` | existing |
| Role (access) | `rbac_roles` / `SEED_ROLES` | existing |
| Permission | `rbac_permission_grants` + `role_permissions` | existing |
| AccessGroup | `tos_access_profile` (a derivation rule, materialised into RBAC) | **new** |
| ApplicationSystem | `tos_app_system` — the provisionable-resource registry | **new** |
| AccessRequest | `tos_access_request` | **new** |
| Notification | existing notification subsystem | existing |
| AuditLog | `audit_log` | existing |

### 2.1 Why "Candidate" is not a table

A candidate is a **role a person plays in one opportunity**, not an entity with its own lifetime.
Giving it a table is precisely how systems end up with three unrelated records for one human
[brief §24, §33]. The candidate view is a query:

```sql
SELECT p.*, a.*, s.*
FROM tos_person p
JOIN tos_application_link al ON al.person_id = p.id
JOIN applications a          ON a.id = al.application_id
LEFT JOIN tos_selection s    ON s.application_id = a.id
WHERE p.id = $1 AND al.opportunity_role_id = $2;
```

`tos_person` is the only durable identity of a human in this system before onboarding.

### 2.2 The relationship that governs the whole design [brief §33]

```
                      tos_person   (ERAI-P-000001)
                           |
     +---------------------+---------------------+------------------------+
     |                     |                     |                        |
 applications        tos_selection          tos_onboarding            tos_identity
 (many: one per      (many: one per         (many: one per            (many rows;
  opportunity        successful             authorised                AT MOST ONE
  attempt)           evaluation)            selection)                active primary)
```

**MUST**: creating a second `tos_person` for a human who already has one is a defect, not a
duplicate row. §5.3 defines the resolution rule that prevents it.

---

## 3. Conventions

- **Table prefix**: `tos_` (Talent Operating System). Verified free in this repository; `talent_`
  is already taken by four unrelated tables.
- **Module root**: `src/lib/talentos/`. One file per bounded concern.
- **Schema bootstrap**: every table is created by `ensureOnce('tos_<name>_v1', …)` with
  `CREATE TABLE IF NOT EXISTS` **plus** an `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for every column
  past the primary key. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table that is missing
  columns — that exact gap once locked every administrator out of `/admin`.
- **Mirror DDL**: `db/talent-os-schema.sql` is the readable mirror, equivalent in effect, runnable
  by hand before any application code touches the database.
- **Enum-like columns**: `TEXT` with values enforced in TypeScript, **not** Postgres `CHECK`
  constraints. This project has no migration runner; a `CHECK` cannot be extended without a manual
  drop and recreate.
- **Ids**: `UUID PRIMARY KEY DEFAULT gen_random_uuid()`. Human-readable codes are separate unique
  indexed columns.
- **Department references**: `TEXT`, never cast to `uuid`.
- **Timestamps**: `TIMESTAMPTZ NOT NULL DEFAULT NOW()`.
- **No emojis** anywhere — code, copy, seeds, notifications, admin labels. Inline monochrome SVG.
- **No competitor or third-party company names in user-facing copy.** Recruitment channels are
  admin-managed rows in `application_sources`, rendered from data, never hardcoded into markup.

---

## 4. Schema (complete DDL)

All statements are idempotent. File: `db/talent-os-schema.sql`; TypeScript mirror:
`src/lib/talentos/schema.ts`.

### 4.1 Person and identity

```sql
-- ONE HUMAN. Durable across every application, selection and engagement they ever have.
CREATE TABLE IF NOT EXISTS tos_person (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_code       TEXT NOT NULL UNIQUE,          -- ERAI-P-000001
  display_name      TEXT NOT NULL,
  primary_email     TEXT NOT NULL,
  phone             TEXT,
  user_id           UUID,                          -- users.id when an account exists. NULLABLE.
  merged_into_id    UUID,                          -- set when this row was merged away (§5.5)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tos_person_user_idx
  ON tos_person (user_id) WHERE user_id IS NOT NULL AND merged_into_id IS NULL;
CREATE INDEX IF NOT EXISTS tos_person_email_idx ON tos_person (lower(primary_email));

-- Every address that has ever proven to belong to this person. The resolution key (§5.3).
CREATE TABLE IF NOT EXISTS tos_person_email (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id      UUID NOT NULL,
  email          TEXT NOT NULL,
  is_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  is_official    BOOLEAN NOT NULL DEFAULT FALSE,   -- an @edurankai.in address
  verified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tos_person_email_uq ON tos_person_email (lower(email));
CREATE INDEX IF NOT EXISTS tos_person_email_person_idx ON tos_person_email (person_id);

-- THE IDENTITY REGISTRY [brief §12]. An organizational identity is a GRANT with a lifetime,
-- not an attribute of the person and not an attribute of an email address.
CREATE TABLE IF NOT EXISTS tos_identity (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id          UUID NOT NULL,
  identity_code      TEXT NOT NULL UNIQUE,         -- ERAI-EMP-00128, ERAI-INT-00047, ...
  identity_type      TEXT NOT NULL,                -- §5.6 vocabulary
  status             TEXT NOT NULL DEFAULT 'pending',  -- pending|active|suspended|expired|terminated
  is_primary         BOOLEAN NOT NULL DEFAULT FALSE,
  employee_id        UUID,                         -- hr_employees.id when employment-backed
  user_id            UUID,                         -- users.id used to sign in as this identity
  official_email     TEXT,
  department_id      TEXT,                         -- TEXT. Never ::uuid.
  position_id        UUID,                         -- org_positions.id
  team_id            UUID,                         -- org_teams.id
  engagement_type    TEXT,                         -- Full-Time | Internship | Apprenticeship | ...
  started_on         DATE,
  ended_on           DATE,
  source_onboarding_id UUID,                       -- tos_onboarding.id that created it
  created_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tos_identity_person_idx ON tos_identity (person_id, status);
-- "ONE CURRENT ORGANIZATIONAL IDENTITY" [brief §33], enforced by the database, not by code.
CREATE UNIQUE INDEX IF NOT EXISTS tos_identity_one_primary
  ON tos_identity (person_id) WHERE is_primary AND status = 'active';
```

### 4.2 Opportunity configuration [brief §16]

`roles` stays the catalogue. Configuration lives in a 1:1 side table so no page that already reads
`roles` has to change, and so the config can grow without touching the Drizzle schema.

```sql
CREATE TABLE IF NOT EXISTS tos_opportunity (
  role_id                  UUID PRIMARY KEY,       -- roles.id
  opportunity_code         TEXT NOT NULL UNIQUE,   -- POM, DEI, AIRF — used inside the auth code
  pipeline_id              UUID,                   -- tos_pipeline.id; NULL = the default pipeline
  requisition_id           UUID,                   -- hr_requisitions.id when opened from one

  -- Visibility and availability
  is_public                BOOLEAN NOT NULL DEFAULT TRUE,
  applications_open        BOOLEAN NOT NULL DEFAULT TRUE,
  opens_at                 TIMESTAMPTZ,
  closes_at                TIMESTAMPTZ,

  -- Eligibility [brief §11, §16]
  external_eligible        BOOLEAN NOT NULL DEFAULT TRUE,
  internal_eligible        BOOLEAN NOT NULL DEFAULT TRUE,
  internal_identity_types  TEXT[] NOT NULL DEFAULT '{}',   -- empty = all internal types
  min_tenure_days          INT,                            -- internal applicants only
  requires_manager_consent BOOLEAN NOT NULL DEFAULT FALSE,
  eligibility_rules        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- §7.2 rule objects

  -- Selection [brief §7]
  requires_seven_stage     BOOLEAN NOT NULL DEFAULT TRUE,
  waiver_policy            TEXT NOT NULL DEFAULT 'none',   -- none|admin_only|internal_transfer

  -- Authorization code policy [brief §8]
  code_validity_days       INT NOT NULL DEFAULT 21,
  code_multi_use           BOOLEAN NOT NULL DEFAULT FALSE,

  -- Onboarding [brief §16, §20]
  onboarding_pack_key      TEXT,                    -- onboarding-journey template pack
  required_document_types  TEXT[] NOT NULL DEFAULT '{}',
  access_profile_id        UUID,                    -- tos_access_profile.id

  -- Ownership
  hiring_manager_user_id   UUID,
  reporting_manager_user_id UUID,
  evaluator_user_ids       UUID[] NOT NULL DEFAULT '{}',

  created_by               UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.3 Application linkage

`applications` is not restructured. One join table carries the facts the existing table cannot.

```sql
CREATE TABLE IF NOT EXISTS tos_application_link (
  application_id       UUID PRIMARY KEY,          -- applications.id
  person_id            UUID NOT NULL,
  opportunity_role_id  UUID NOT NULL,             -- roles.id
  pathway              TEXT NOT NULL,             -- 'recruitment' | 'direct_onboarding'  [brief §5]
  applicant_type       TEXT NOT NULL,             -- 'external' | 'internal'
  applicant_identity_id UUID,                     -- tos_identity.id when internal
  -- PINNING. An application is evaluated against the pipeline in force WHEN IT WAS CREATED, and the
  -- SNAPSHOT -- not pipeline_id -- is the authority: a pipeline row can be edited in place, a copy
  -- cannot. Section 6.7 carries the snapshot shape and the reading rule.
  pipeline_id          UUID,                      -- tos_pipeline.id, for reporting joins only
  pipeline_revision    INT,                       -- tos_pipeline.revision at pin time
  pipeline_snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb,
  pinned_at            TIMESTAMPTZ,
  source_slug          TEXT,                      -- application_sources.slug
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tos_app_link_person_idx ON tos_application_link (person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tos_app_link_opp_idx    ON tos_application_link (opportunity_role_id);
```

### 4.4 The seven-stage framework [brief §7]

```sql
CREATE TABLE IF NOT EXISTS tos_pipeline (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key          TEXT NOT NULL UNIQUE,               -- 'default', 'research-fellow', ...
  name         TEXT NOT NULL,
  description  TEXT,
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- EXACTLY SEVEN ROWS PER PIPELINE. slot_no is 1..7 and is the framework; everything else on the
-- row is what an administrator configures [brief §7].
CREATE TABLE IF NOT EXISTS tos_pipeline_stage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id       UUID NOT NULL,
  slot_no           INT NOT NULL,                  -- 1..7
  label             TEXT NOT NULL,                 -- candidate-visible name of this slot
  kind              TEXT NOT NULL,                 -- §8.2 vocabulary
  is_required       BOOLEAN NOT NULL DEFAULT TRUE,
  weight            INT NOT NULL DEFAULT 0,        -- 0..100, informational unless pass_rule uses it
  pass_rule         JSONB NOT NULL DEFAULT '{}'::jsonb,   -- §8.4
  evaluator_rule    JSONB NOT NULL DEFAULT '{}'::jsonb,   -- §8.5
  sla_days          INT,
  instrument_ref    TEXT,                          -- test id, interview template key, form slug
  candidate_blurb   TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tos_pipeline_stage_slot_uq
  ON tos_pipeline_stage (pipeline_id, slot_no);

-- One application's passage through one slot.
CREATE TABLE IF NOT EXISTS tos_stage_run (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    UUID NOT NULL,
  pipeline_stage_id UUID NOT NULL,
  slot_no           INT NOT NULL,
  kind              TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'not_started',
      -- not_started|invited|in_progress|submitted|under_review|passed|failed|waived|skipped
  opened_at         TIMESTAMPTZ,
  due_at            TIMESTAMPTZ,
  submitted_at      TIMESTAMPTZ,
  decided_at        TIMESTAMPTZ,
  decided_by        UUID,
  outcome_note      TEXT,
  score             NUMERIC(6,2),
  external_ref      TEXT,                          -- test attempt id, interview id, ...
  advisory_flags    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- §8.7 proctoring is ADVISORY ONLY
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tos_stage_run_uq ON tos_stage_run (application_id, slot_no);
CREATE INDEX IF NOT EXISTS tos_stage_run_state_idx ON tos_stage_run (state, due_at);

-- One evaluator's scored verdict on one stage run [brief §25].
CREATE TABLE IF NOT EXISTS tos_evaluation (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_run_id    UUID NOT NULL,
  evaluator_user_id UUID NOT NULL,
  verdict         TEXT NOT NULL,                   -- pass|fail|hold
  score           NUMERIC(6,2),
  dimensions      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {clarity: 4, rigour: 5, ...}
  comments        TEXT,
  is_final        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Rewriting your own verdict is an UPDATE of your row, not a second row, so this column is what
  -- records that it happened.
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tos_evaluation_run_idx ON tos_evaluation (stage_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS tos_evaluation_one_per_evaluator
  ON tos_evaluation (stage_run_id, evaluator_user_id);
```

### 4.5 Selection decision and authorization code [brief §8, §25]

```sql
CREATE TABLE IF NOT EXISTS tos_selection (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_ref       TEXT NOT NULL UNIQUE,        -- ERAI-SEL-26-000412
  person_id           UUID NOT NULL,
  application_id      UUID NOT NULL,
  opportunity_role_id UUID NOT NULL,
  decision            TEXT NOT NULL,               -- selected|rejected|waitlisted|withdrawn
  decision_reason     TEXT NOT NULL,               -- written explanation. Required both ways.
  decided_by_user_id  UUID NOT NULL,
  decided_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by_user_id UUID,                        -- second signature where policy requires it
  approved_at         TIMESTAMPTZ,
  is_authorised       BOOLEAN NOT NULL DEFAULT FALSE,  -- the ONE flag §10.4 reads
  suspended_at        TIMESTAMPTZ,
  suspended_reason    TEXT,

  -- Organisation-controlled facts pre-filled into onboarding [brief §19]
  offered_position_id UUID,
  offered_department_id TEXT,                      -- TEXT
  offered_title       TEXT,
  employment_type     TEXT,
  reporting_manager_user_id UUID,
  proposed_start_date DATE,
  stipend_amount      NUMERIC(12,2),               -- NULL means UNPAID. See §12.6.
  stipend_currency    TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tos_selection_person_idx ON tos_selection (person_id, decided_at DESC);
-- A person may be selected for one opportunity once. Re-selection supersedes, it does not duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS tos_selection_live_uq
  ON tos_selection (person_id, opportunity_role_id)
  WHERE decision = 'selected' AND suspended_at IS NULL;

CREATE TABLE IF NOT EXISTS tos_auth_code (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash           TEXT NOT NULL UNIQUE,        -- sha256 of the normalised code. NEVER plaintext.
  code_display_prefix TEXT NOT NULL,               -- 'ERAI-SEL-ONB-26-POM' for admin display only
  code_last4          TEXT NOT NULL,               -- last 4 chars, so admins can identify a code
  selection_id        UUID NOT NULL,
  person_id           UUID NOT NULL,
  opportunity_role_id UUID NOT NULL,
  issued_by_user_id   UUID NOT NULL,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  max_uses            INT NOT NULL DEFAULT 1,
  use_count           INT NOT NULL DEFAULT 0,
  consumed_at         TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_by_user_id  UUID,
  revoked_reason      TEXT,
  delivered_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tos_auth_code_selection_idx ON tos_auth_code (selection_id);
CREATE INDEX IF NOT EXISTS tos_auth_code_person_idx    ON tos_auth_code (person_id);

-- Every redemption attempt, successful or not. The rate limiter and the abuse board read this.
CREATE TABLE IF NOT EXISTS tos_code_attempt (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash     TEXT,                              -- NULL when the input was malformed
  matched_code_id UUID,
  person_id     UUID,                              -- session person, when signed in
  outcome       TEXT NOT NULL,                     -- §10.3 result codes
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tos_code_attempt_ip_idx ON tos_code_attempt (ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS tos_code_attempt_hash_idx ON tos_code_attempt (code_hash, created_at DESC);
```

### 4.6 Onboarding grant and onboarding application

```sql
-- SERVER-SIDE ROUTE AUTHORITY [brief §29]. The browser never carries "isSelected".
CREATE TABLE IF NOT EXISTS tos_onboarding_grant (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_token_hash    TEXT NOT NULL UNIQUE,
  selection_id        UUID NOT NULL,
  person_id           UUID NOT NULL,
  opportunity_role_id UUID NOT NULL,
  auth_code_id        UUID NOT NULL,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,        -- issued_at + 2 hours
  consumed_at         TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  ip_address          TEXT
);

CREATE TABLE IF NOT EXISTS tos_onboarding (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_ref      TEXT NOT NULL UNIQUE,        -- ERAI-ONB-26-000412
  selection_id        UUID NOT NULL UNIQUE,
  person_id           UUID NOT NULL,
  opportunity_role_id UUID NOT NULL,
  state               TEXT NOT NULL DEFAULT 'invited',   -- §17.2 state machine
  form_version        INT NOT NULL DEFAULT 1,
  answers             JSONB NOT NULL DEFAULT '{}'::jsonb,   -- candidate-owned fields only
  locked_fields       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- org-controlled snapshot [brief §10]
  submitted_at        TIMESTAMPTZ,
  verified_at         TIMESTAMPTZ,
  verified_by_user_id UUID,
  approved_at         TIMESTAMPTZ,
  approved_by_user_id UUID,
  rejected_at         TIMESTAMPTZ,
  rejection_reason    TEXT,
  identity_id         UUID,                        -- tos_identity.id once created
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tos_onboarding_state_idx ON tos_onboarding (state, updated_at DESC);

-- A candidate disputing a locked field [brief §34, identity mismatch].
CREATE TABLE IF NOT EXISTS tos_correction_request (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id  UUID NOT NULL,
  field_key      TEXT NOT NULL,
  current_value  TEXT,
  proposed_value TEXT NOT NULL,
  candidate_note TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'open',     -- open|accepted|rejected
  decided_by_user_id UUID,
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.7 Access provisioning

```sql
-- A DERIVATION RULE, not a bag of permissions [brief §21, §22].
CREATE TABLE IF NOT EXISTS tos_access_profile (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_key       TEXT NOT NULL UNIQUE,          -- 'PO-MANAGER', 'ENG-INTERN'
  name              TEXT NOT NULL,
  department_id     TEXT,                          -- TEXT
  position_grade    TEXT,
  employment_types  TEXT[] NOT NULL DEFAULT '{}',
  identity_types    TEXT[] NOT NULL DEFAULT '{}',
  rbac_role_keys    TEXT[] NOT NULL DEFAULT '{}',  -- rbac_roles.key
  admin_section_keys TEXT[] NOT NULL DEFAULT '{}', -- admin-sections.ts keys
  app_system_keys   TEXT[] NOT NULL DEFAULT '{}',  -- tos_app_system.key
  abac_conditions   JSONB NOT NULL DEFAULT '{}'::jsonb,  -- RuleConditions, §14.4
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tos_app_system (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT NOT NULL UNIQUE,              -- 'mail', 'portal', 'admin', 'chat'
  name          TEXT NOT NULL,
  description   TEXT,
  provisioner   TEXT NOT NULL DEFAULT 'manual',    -- manual|mail|rbac|chat
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every provisioning action, so revocation is possible and auditable.
CREATE TABLE IF NOT EXISTS tos_provisioning_event (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id   UUID NOT NULL,
  profile_id    UUID,
  action        TEXT NOT NULL,                     -- grant|revoke
  target_kind   TEXT NOT NULL,                     -- rbac_role|admin_section|app_system
  target_key    TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending',   -- pending|applied|failed|reverted
  error_reason  TEXT,
  actor_user_id UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tos_prov_identity_idx ON tos_provisioning_event (identity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tos_access_request (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id   UUID NOT NULL,
  target_kind   TEXT NOT NULL,
  target_key    TEXT NOT NULL,
  reason        TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open',      -- open|approved|denied|revoked
  approver_user_id UUID,
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.8 Override ledger [brief §27]

```sql
CREATE TABLE IF NOT EXISTS tos_override (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity          TEXT NOT NULL,                   -- 'tos_stage_run', 'tos_selection', ...
  entity_id       UUID NOT NULL,
  from_state      TEXT,
  to_state        TEXT NOT NULL,
  reason          TEXT NOT NULL,                   -- free text, REQUIRED, min 20 chars
  actor_user_id   UUID NOT NULL,
  approval_level  TEXT,                            -- 'self'|'second_signature'|'founder'
  approver_user_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tos_override_entity_idx ON tos_override (entity, entity_id, created_at DESC);
```

**MUST**: no code path writes `tos_stage_run.state`, `tos_selection.decision`,
`tos_selection.is_authorised`, `tos_auth_code.revoked_at` or `tos_onboarding.state` out of its
normal transition **without** inserting a `tos_override` row in the same operation. A silent
override is a defect [brief §27].


### 4.9 Sections that add to this schema

Section 4 is the CORE schema — the twenty tables the whole system turns on. Later sections add eight
more tables and eleven more columns, each with its own idempotent DDL. They are listed here so that
"the complete DDL" is not a claim this document quietly breaks.

| Added in | What it adds |
|---|---|
| §6.7 | `tos_opportunity.first_application_at`, `.cancelled_at`, `.cancelled_reason`, `.cancelled_by_user_id`; `tos_pipeline.revision`; `tos_application_link.pipeline_id`, `.pipeline_revision`, `.pipeline_snapshot`, `.pinned_at` |
| §7 | `tos_internal_consent`; `tos_application_link.eligibility_decision`, `.eligibility_outcome`, `.eligibility_rule_hash` |
| §8.5 | `tos_stage_evaluator` |
| §10.7 | `tos_code_challenge`; `tos_auth_code.delivered_to_email`, `.superseded_by_id` |
| §12.2 | `tos_form_definition`, `tos_form_field` |
| §13 | `tos_onboarding.activation_steps`, `.activation_gaps`, `.activation_error`, `.activation_attempts`, `.last_activation_at`, `.hire_handoff_id`, `.reminders_sent` |
| §17 | `tos_idempotency` |
| §19 | `tos_notification_log` |
| §21 | `tos_rate_event` |

**Twenty-eight tables in total.** Every one of them is folded into `db/talent-os-schema.sql` and
`src/lib/talentos/schema.ts`, so a fresh environment gets the whole schema from one file and one
function — `ensureTalentOsSchema()`.

**MUST**: any further addition is folded into both of those in the same commit that specifies it.
A column that exists in this document and in no runnable file is the defect this table exists to
prevent, and it is checked mechanically — the three sources are diffed table by table and column by
column, and they currently agree exactly.

---

## 5. Person and organizational identity

### 5.1 Person code

`ERAI-P-` + zero-padded six digits, e.g. `ERAI-P-000001`.

**MUST** be minted by the same MAX-plus-retry pattern as `src/lib/hr/employee-code.ts`, not by
`SELECT COUNT(*)`. Reuse `withEmployeeCode`'s shape:

```ts
// src/lib/talentos/codes.ts
export async function nextPersonCode(): Promise<string> {
  const r = await db.execute(sql`
    SELECT COALESCE(MAX(regexp_replace(person_code,'^ERAI-P-','')::bigint), 0)::bigint AS mx
    FROM tos_person WHERE person_code ~ '^ERAI-P-[0-9]+$'`);
  const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
  return 'ERAI-P-' + String(Number(rows[0]?.mx || 0) + 1).padStart(6, '0');
}
```

`COUNT(*)` is wrong after any delete and under any concurrency; that exact defect silently lost
hires on this project for eleven days.

### 5.2 What a person is not

- A person is **not** a `users` row. `users` is an authentication account. A person may have none
  (an external candidate who applied before creating an account) or exactly one.
- A person is **not** an `hr_employees` row. That is one *engagement*.
- A person is **not** an email address. Addresses change; people do not.

### 5.3 Resolution rule (MUST)

Given an inbound application or sign-in, resolve the person in this exact order. Stop at the first
match.

1. **Session** — the signed-in `users.id` has a `tos_person` row via `tos_person.user_id`.
2. **Verified email** — `tos_person_email` where `lower(email) = lower(input)` and `is_verified`.
3. **Unverified email on a person with no account** — match, then require email verification before
   any selection, code redemption or onboarding step proceeds.
4. **No match** — create a new `tos_person` and an unverified `tos_person_email` row.

**MUST NOT** match on name, phone or date of birth. Those collide and merging is far more expensive
than splitting.

### 5.4 Backfill

A one-time backfill creates a `tos_person` per distinct `lower(applications.email)` and links every
existing application through `tos_application_link`. Where `applications.applicant_user_id` is set,
`tos_person.user_id` is set from it. Where an `hr_employees` row exists for that address, a
`tos_identity` of type `EMPLOYEE` is created with `employee_id` set and `is_primary = TRUE`.

The backfill lives in `db/talent-os-backfill.sql` and `src/lib/talentos/backfill.ts`. It is
**idempotent** and reports counts. It is **run by the founder**, not by an agent.

### 5.5 Merge, never delete

When two person rows turn out to be one human, the loser gets `merged_into_id` set; its emails,
application links, selections and identities are repointed to the winner. Nothing is deleted —
the loser row remains so historical references resolve. All reads filter `merged_into_id IS NULL`
or follow the pointer.

### 5.6 Identity type vocabulary [brief §12]

`EMPLOYEE`, `INTERN`, `FELLOW`, `MEMBER`, `CAMPUS_AMBASSADOR`, `CONTRACTOR`, `CONSULTANT`,
`OTHER_AUTHORIZED_IDENTITY`.

Identity code prefixes: `ERAI-EMP-`, `ERAI-INT-`, `ERAI-FEL-`, `ERAI-MEM-`, `ERAI-CAM-`,
`ERAI-CON-`, `ERAI-CNS-`, `ERAI-OTH-`, each with an independent five-digit sequence minted by the
MAX-plus-retry helper.

`EMPLOYEE` and `INTERN` identities are **employment-backed**: `employee_id` MUST reference an
`hr_employees` row. The remaining types are **not** and MUST NOT create one.

### 5.7 The `@edurankai.in` rule [brief §13]

**MUST NOT** derive any authorization from an email domain. The following is a defect wherever it
appears:

```ts
if (email.endsWith('@edurankai.in')) { /* anything authorising */ }   // FORBIDDEN
```

Authorization is:

```
users row exists AND users.is_active
  AND tos_person resolves
  AND tos_identity for that person is status='active'
  AND that identity type is permitted by the opportunity
  AND the opportunity's eligibility rules pass
  AND (for direct onboarding) a valid selection authorization exists
```

An official address is a **convenience for authentication and a display fact**. A former employee
whose identity is `terminated` but whose mailbox still resolves has no internal route. A conformance
test MUST assert this (§25, T-07).

---

## 6. Opportunity configuration [brief §16]

### 6.1 An Opportunity is two rows, not one

| Row | Table | What it is |
|---|---|---|
| Catalogue | `roles` | What a candidate reads. `slug`, `department_id` (varchar(50) slug), `title`, `level`, `function`, `engagement_type`, `location`, `duration`, `salary`, `about`, `responsibilities`, `skills`, `eligibility`, `is_open`, `is_featured`, `application_deadline`, `sort_order`, `openings`. Already rendered by `/careers`, `/careers/[slug]`, `/admin/roles`. |
| Configuration | `tos_opportunity` (§4.2) | What the selection machinery reads. Keyed `role_id` = `roles.id`, 1:1. |

**MUST NOT** add columns to `roles` for anything in §4.2. `roles` is Drizzle-managed in
`src/lib/db/schema.ts` and this project has no migration runner, so every column added there is a
`schema.ts` edit **plus** a hand-run `ALTER` against production. `tos_opportunity` is
`ensureOnce`-bootstrapped and grows without either.

**MUST**: `roles.openings INT` already exists — added by `ensureRoleProductColumn()` in
`src/lib/role-products.ts` (`ensureOnce('roles_product_cols_v2', …)`) and edited today through
`getRoleOpenings()` / `setRoleOpenings()` on `/admin/roles/[id]`. Headcount for an opportunity is
that column. Do **not** introduce a `headcount` column on `tos_opportunity`; a second headcount
number that the existing admin screen does not write is a number that will be wrong within a week.

**MUST**: a `roles` row with **no** `tos_opportunity` row is legal and MUST render. `/careers`
predates this table and every role in production starts without one. Reads go through a resolver
that returns the §4.2 column defaults in memory:

```ts
// src/lib/talentos/opportunity.ts
export async function readOpportunity(roleId: string): Promise<OpportunityConfig> {
  await ensureOpportunitySchema();
  const r = await db.execute(sql`SELECT * FROM tos_opportunity WHERE role_id = ${roleId} LIMIT 1`);
  const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);   // postgres-js returns plain arrays
  return rows.length ? mapOpportunity(rows[0]) : defaultOpportunity(roleId);
}
```

**MUST NOT** insert the row on read. A public GET on `/careers/[slug]` that writes a row is write
amplification on the busiest page in the product, and it mints an `opportunity_code` (6.2) for a
role nobody has configured. The row is written the first time an administrator saves configuration,
or when the opportunity is opened from a requisition (6.5).

### 6.2 `opportunity_code`

`tos_opportunity.opportunity_code` is a short mnemonic — `POM`, `DEI`, `AIRF` — that appears inside
the authorization code display prefix, `ERAI-SEL-ONB-26-POM` (`tos_auth_code.code_display_prefix`,
§4.5). It is **not** a sequence and **not** derived from the slug at read time.

Rules:

- 3 to 5 characters, `A-Z0-9` only, first character `A-Z`. Uppercase at rest.
- Globally unique (the `UNIQUE` constraint on `tos_opportunity.opportunity_code`, §4.2).
- Minted **once**, when the configuration row is first written. **Immutable** thereafter (6.6,
  SEALED). REASON: it is embedded in every issued authorization code's display prefix, and changing
  it makes already-issued codes unidentifiable in the admin list at exactly the moment somebody is
  trying to work out which code a candidate is holding.
- **MUST NOT** equal any identity-code segment from §5.6 — `EMP`, `INT`, `FEL`, `MEM`, `CAM`, `CON`,
  `CNS`, `OTH` — nor `SEL`, `ONB` or `ERAI`. REASON: `ERAI-SEL-ONB-26-INT` reads as an intern
  identity code in a list of `ERAI-INT-00047`s.
- **MUST NOT** contain a real outside company name or an abbreviation of one. It cannot contain an
  emoji by construction (`A-Z0-9` only).

```ts
// src/lib/talentos/opportunity-code.ts
const RESERVED = new Set(['EMP', 'INT', 'FEL', 'MEM', 'CAM', 'CON', 'CNS', 'OTH', 'SEL', 'ONB', 'ERAI']);
const STOPWORDS = new Set(['and', 'of', 'the', 'for', 'to', 'a', 'an', 'in', 'at', 'on', 'with']);

/** Candidate stems, best first: word initials, then the consonant squeeze of the slug. */
export function codeCandidates(title: string, slug: string): string[] {
  const words = String(title || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !STOPWORDS.has(w));
  const initials = words.map(w => w[0]).join('').toUpperCase();
  const flat = String(slug || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const squeeze = flat.replace(/[AEIOU]/g, '');
  const out: string[] = [];
  for (const stem of [initials, squeeze, flat]) {
    const s = stem.slice(0, 5);
    if (s.length >= 3 && /^[A-Z]/.test(s) && !RESERVED.has(s)) out.push(s);
    if (s.length === 2 && /^[A-Z]/.test(s)) out.push(s + 'X');
  }
  return [...new Set(out)];
}

/**
 * Mint and claim in one statement. The uniqueness test is the unique index, NOT a prior SELECT:
 * two administrators saving two roles in the same second both pass a SELECT and one INSERT then
 * fails. ON CONFLICT DO NOTHING plus a loop is the only version that is correct under concurrency.
 */
export async function claimOpportunityCode(roleId: string, title: string, slug: string): Promise<string> {
  const tries: string[] = [];
  for (const stem of codeCandidates(title, slug)) {
    tries.push(stem);
    const base = stem.length >= 5 ? stem.slice(0, 4) : stem;
    for (let n = 2; n <= 9; n++) tries.push(base + String(n));
  }
  for (const code of tries) {
    try {
      const r = await db.execute(sql`
        INSERT INTO tos_opportunity (role_id, opportunity_code)
        VALUES (${roleId}, ${code})
        ON CONFLICT DO NOTHING
        RETURNING opportunity_code`);
      const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
      if (rows.length) return String(rows[0].opportunity_code);
    } catch (e: any) {
      // The real Postgres reason is on e.cause; e.message is only the SQL that failed.
      console.error('[talentos] claimOpportunityCode', e?.cause?.message || e?.message);
      throw e;
    }
  }
  throw new Error('No opportunity code could be minted for ' + slug + '. Choose one by hand.');
}
```

`ON CONFLICT DO NOTHING` returns zero rows for **either** a `role_id` clash or an
`opportunity_code` clash. The caller therefore checks `readOpportunity(roleId)` first and mints only
when the row is absent; if the row appears between the check and the insert, every candidate returns
zero rows and the caller re-reads. That re-read is the correct outcome — the row now exists and
already carries a code.

### 6.3 Every configurable field

Editable-by values: **`roles.edit`** is the existing permission key in `src/lib/auth/registry.ts`,
tested with `can(user, 'roles.edit')` from `src/lib/auth/permissions`. **`opportunity.policy`** is a
new key registered by `src/lib/talentos/permissions.ts` through the existing `registerPermission()`
in that same registry.

**MUST NOT** grant `opportunity.policy` implicitly to `roles.edit` holders. Code validity, multi-use
and the waiver policy decide how long a live credential to the onboarding route stays valid; the
person who writes a job description is not automatically the person who sets that. An administrator
grants it on `/admin/team/roles`, and until it is granted these four fields render read-only at
their defaults, which are the safe values.

| Brief field [§16] | Column | Editable by | Default | Lock (6.6) |
|---|---|---|---|---|
| Opportunity title | `roles.title` | `roles.edit` | — (required) | FREE |
| Department | `roles.department_id` (**TEXT slug**) | `roles.edit` | — (required) | FREE |
| Level | `roles.level` | `roles.edit` | — (required) | FORWARD |
| Engagement type | `roles.engagement_type` | `roles.edit` | — (required) | FORWARD |
| Description, responsibilities, skills, stated eligibility | `roles.about`, `.responsibilities`, `.skills`, `.eligibility` | `roles.edit` | `[]` | FREE |
| Number of openings | `roles.openings` | `roles.edit` | `NULL` (unspecified) | FREE |
| Short code | `tos_opportunity.opportunity_code` | minted (6.2) | minted | **SEALED** |
| Selection process | `tos_opportunity.pipeline_id` | `roles.edit` | `NULL` = the `is_default` pipeline | FORWARD |
| Seven-stage framework required | `tos_opportunity.requires_seven_stage` | `opportunity.policy` | `TRUE` | **SEALED** |
| Stage waiver policy | `tos_opportunity.waiver_policy` | `opportunity.policy` | `'none'` | FORWARD |
| Publicly listed | `tos_opportunity.is_public` | `roles.edit` | `TRUE` | FREE |
| Accepting applications | `tos_opportunity.applications_open` | `roles.edit` | `TRUE` | FREE |
| Opens at | `tos_opportunity.opens_at` | `roles.edit` | `NULL` = already open | FREE |
| Closes at | `tos_opportunity.closes_at` | `roles.edit` | `NULL` | FREE |
| Existing deadline | `roles.application_deadline` | `roles.edit` | `NULL` | FREE |
| Open to external applicants | `tos_opportunity.external_eligible` | `roles.edit` | `TRUE` | FORWARD |
| Open to internal applicants | `tos_opportunity.internal_eligible` | `roles.edit` | `TRUE` | FORWARD |
| Which internal identity types | `tos_opportunity.internal_identity_types` | `roles.edit` | `'{}'` = every §5.6 type | FORWARD |
| Minimum tenure | `tos_opportunity.min_tenure_days` | `roles.edit` | `NULL` = none | FORWARD |
| Manager consent required | `tos_opportunity.requires_manager_consent` | `roles.edit` | `FALSE` | FORWARD |
| Additional eligibility rules | `tos_opportunity.eligibility_rules` | `roles.edit` | `'[]'::jsonb` | FORWARD |
| Authorization code validity | `tos_opportunity.code_validity_days` | `opportunity.policy` | `21` | FORWARD |
| Authorization code multi-use | `tos_opportunity.code_multi_use` | `opportunity.policy` | `FALSE` | FORWARD |
| Onboarding pack | `tos_opportunity.onboarding_pack_key` | `roles.edit` | `NULL` = engagement-derived pack | FORWARD |
| Required documents | `tos_opportunity.required_document_types` | `roles.edit` | `'{}'` | FORWARD |
| Access profile on joining | `tos_opportunity.access_profile_id` | `opportunity.policy` | `NULL` | FORWARD |
| Hiring manager | `tos_opportunity.hiring_manager_user_id` | `roles.edit` | `NULL` | FREE |
| Reporting manager offered | `tos_opportunity.reporting_manager_user_id` | `roles.edit` | `NULL` | FREE |
| Evaluators | `tos_opportunity.evaluator_user_ids` | `roles.edit` | `'{}'` | FREE |
| Opened from requisition | `tos_opportunity.requisition_id` | set by 6.5 | `NULL` | **SEALED** |
| Cancelled | `tos_opportunity.cancelled_at`, `.cancelled_reason` | `roles.edit` | `NULL` | FREE |

`required_document_types` values are keys understood by `src/lib/hr-onboarding.ts`. Every one of
them is a **verified Drive link with "Anyone with the link" access**, never an upload; the only
stored binary anywhere in this system is the 320px JPEG photo. A value here that implies a file
upload is a defect.

### 6.4 Publication rules

Five inputs decide what a candidate sees. Two of them — `roles.is_open` and
`roles.application_deadline` — already exist and are already edited on `/admin/roles/[id]`.

**MUST**: the effective close instant is the **earliest** of `roles.application_deadline` and
`tos_opportunity.closes_at`. REASON: taking the later of the two silently extends a deadline an
administrator set on the screen they have been using for a year, which is the worst possible way to
introduce a new table.

**MUST**: `roles.is_open = FALSE` or `cancelled_at IS NOT NULL` overrides everything else.

```ts
// src/lib/talentos/availability.ts — pure, no IO, no db handle.
export interface OpportunityAvailability {
  listed: boolean;                                    // does /careers show it
  state: 'open' | 'scheduled' | 'closed' | 'cancelled';
  acceptsApplications: boolean;
  effectiveCloseAt: string | null;
  candidateNote: string;                              // one sentence, safe to render as-is
}

export function opportunityAvailability(
  role: { isOpen: boolean; applicationDeadline: string | null },
  opp: { isPublic: boolean; applicationsOpen: boolean; opensAt: string | null; closesAt: string | null; cancelledAt: string | null },
  now: Date = new Date(),
): OpportunityAvailability {
  const nowMs = now.getTime();
  const closeStamps = [role.applicationDeadline, opp.closesAt]
    .filter((d): d is string => !!d)
    .map(d => new Date(d).getTime())
    .filter(n => Number.isFinite(n));
  const closeMs = closeStamps.length ? Math.min(...closeStamps) : null;
  const openMs = opp.opensAt ? new Date(opp.opensAt).getTime() : null;
  const effectiveCloseAt = closeMs === null ? null : new Date(closeMs).toISOString();
  const notYetOpen = openMs !== null && nowMs < openMs;
  const pastClose = closeMs !== null && nowMs >= closeMs;

  if (opp.cancelledAt) {
    return { listed: false, state: 'cancelled', acceptsApplications: false, effectiveCloseAt,
      candidateNote: 'This opening is no longer being filled.' };
  }
  if (!role.isOpen || !opp.applicationsOpen || pastClose) {
    return { listed: role.isOpen && opp.isPublic, state: 'closed', acceptsApplications: false, effectiveCloseAt,
      candidateNote: 'Applications for this opening are closed.' };
  }
  if (notYetOpen) {
    return { listed: opp.isPublic, state: 'scheduled', acceptsApplications: false, effectiveCloseAt,
      candidateNote: 'Applications for this opening have not opened yet.' };
  }
  return { listed: opp.isPublic, state: 'open', acceptsApplications: true, effectiveCloseAt,
    candidateNote: 'Applications are open.' };
}
```

Every `<` and `>` comparison above is in the frontmatter module, never inside a JSX expression. A
page rendering these values hoists the booleans it needs (6.6).

What each combination produces:

| `roles.is_open` | `is_public` | `applications_open` | Window | `/careers` list | `/careers/[slug]` | `/apply` |
|---|---|---|---|---|---|---|
| true | true | true | inside | Listed, apply action | Full page, apply action | Accepts |
| true | true | true | before `opens_at` | Listed, opening date shown | Full page, no apply action | Refuses, `unavailable` |
| true | true | true | after effective close | Listed, closed note | Full page, closed note | Refuses, `unavailable` |
| true | true | false | any | Listed, closed note | Full page, closed note | Refuses, `unavailable` |
| true | false | true | inside | **Not listed** | Full page plus "This opening is not listed publicly." | Accepts |
| true | false | false | any | Not listed | Full page, closed note | Refuses |
| false | any | any | any | Not listed | 404 | Refuses |
| any | any | any | any, `cancelled_at` set | Not listed | 404 | Refuses |

REASON for rendering an unlisted-but-open opportunity at its slug rather than 404: internal-only and
referral-only openings need a URL that can be sent to a named person. Forcing them public for a day
so a link works is how a role intended for three people ends up with four hundred applications.

REASON for 404 rather than a closed-role page when `roles.is_open = FALSE`: that is the behaviour
`/careers/[slug]` has today, and changing it would alter the public surface of every retired role at
once.

**MUST NOT**: none of these strings may contain an emoji, and none may name a competitor or any
outside company. Recruitment channels are rows in `application_sources` and are rendered from data.

### 6.5 Opening an opportunity from an approved requisition

The requisition table is **`hiring_requisitions`** (`src/lib/hr-requisition.ts`). §4.2 annotates
`tos_opportunity.requisition_id` as "hr_requisitions.id"; the column and its type are correct, the
comment's table name is not. **Every query MUST name `hiring_requisitions`.**

**Precondition**: `hiring_requisitions.status = 'approved'`. **MUST NOT** open from
`pending_finance`, `pending_leadership`, `rejected` or `withdrawn`. `decideRequisition()` already
constrains each UPDATE to the status it may advance from, precisely because one POST carrying a
hidden field once took a requisition straight past the finance stage; opening a role from an
unapproved requisition routes around that same control from the other side.

**Idempotency**: if `hiring_requisitions.opened_role_id IS NOT NULL`, return that role. Do not create
a second one. A double-clicked button has already produced duplicate rows on this project.

Field copy:

| `hiring_requisitions` | Target | Rule |
|---|---|---|
| `role_title` | `roles.title` | Verbatim. Slug derived; uniqueness enforced by the unique index on `roles.slug`. |
| `department` (varchar(120) free text) | `roles.department_id` (**TEXT slug**) | Resolve: exact `departments.id` match, then case-insensitive `departments.name` match, else the administrator picks from a select. **Never** `::uuid`. |
| `level` | `roles.level` | Must be one of the `role_level` enum values; anything else is presented for the administrator to pick. |
| `engagement_type` | `roles.engagement_type` | Mapped below. |
| `headcount` | `roles.openings` via `setRoleOpenings()` | Copied. |
| `target_join_by` | Default for `tos_selection.proposed_start_date` on the decision form | Not stored on the opportunity. |
| `kras`, `skills_required` | `roles.responsibilities`, `roles.skills` | Split on newlines with the existing `parseLines()` from `src/lib/validators`. |
| `budget_band_min` / `_max` / `_currency` | **Not copied to any public column** | `roles.salary` is public text; a budget band is internal. A human writes the public sentence. |
| `id` | `tos_opportunity.requisition_id` | SEALED once written. |
| — | `hiring_requisitions.opened_role_id` | Written **last**, only after the `roles` row and the `tos_opportunity` row both exist. |

Engagement mapping — `ENGAGEMENT_TYPES` in `hr-requisition.ts` has nine keys; the `engagement_type`
pgEnum on `roles` has **three** values:

| Requisition key | `roles.engagement_type` |
|---|---|
| `permanent`, `part_time`, `fixed_term`, `eor` | `Full-Time` |
| `intern`, `intern_unpaid` | `Internship` |
| `apprentice` | `Apprenticeship` |
| `contractor`, `consultant` | **No value exists.** |

**MUST**: a `contractor` or `consultant` requisition **MUST NOT** auto-create a `roles` row. There is
no enum value for it, and adding one alters a production enum that `/careers` filters on. Those
requisitions are fulfilled through the direct-onboarding pathway (`tos_application_link.pathway =
'direct_onboarding'`, §4.3), and the admin action offers that instead, in a plain sentence that says
why.

**MUST**: an `intern_unpaid` requisition produces an opportunity whose copy states plainly that the
internship is unpaid, and `tos_selection.stipend_amount` stays `NULL`. `NULL` means unpaid. It does
not mean "to be decided", and no surface may render it as a blank. Internships are unpaid unless a
stipend is explicitly recorded.

**MUST NOT**: no copy generated here may state or imply that EduRankAI awards a degree, diploma or
credential. EduRankAI is the technology platform; accredited partners award credentials.

### 6.6 The editing surface, and what locks

Three lock classes. Every field in 6.3 carries exactly one.

| Class | Meaning | Enforcement |
|---|---|---|
| **FREE** | Takes effect immediately for everyone, including applications already in flight. | None. |
| **FORWARD** | Editable at any time. Applies to applications created **after** the edit. In-flight applications keep the value pinned at their creation (6.7). | Pinning, not refusal. |
| **SEALED** | Editable until `tos_opportunity.first_application_at` is set. Refused afterwards, with a message naming the reason. | `saveOpportunity()` refuses; only a `tos_override` row (§4.8) can change it. |

`first_application_at` is set **once**, by the same operation that writes the first
`tos_application_link` for the role.

REASON for a stored timestamp rather than `SELECT COUNT(*) FROM tos_application_link WHERE
opportunity_role_id = $1`: the seal must survive an application being deleted or a person being
merged (§5.5), and the edit screen would otherwise run a count on every render of every role.

REASON `requires_seven_stage` is SEALED: turning the framework off while runs exist orphans every
`tos_stage_run` row on the opportunity, and turning it on mid-flight retroactively adds required
stages to applications that were told there were none.

REASON eligibility fields are FORWARD rather than SEALED: a rule set that cannot be tightened after
the first application arrives is a rule set nobody can fix. Pinning plus the recorded decision
(7.10) already guarantees that the person who applied on Tuesday was judged by Tuesday's rules.

Surface: the existing `/admin/roles/[id].astro` gains a **Selection configuration** fieldset. The
seven stage slots are a separate screen, owned by §8.

```astro
---
// src/pages/admin/roles/[id].astro (excerpt).
// EVERY const the POST handler reads is declared ABOVE it. `const` is not hoisted; a POST handler
// that referenced a const declared further down threw on its first line while the page printed
// "All checks passed".
import { can } from '@/lib/auth/permissions';
import { logAudit } from '@/lib/audit';
import { readOpportunity, saveOpportunity, inFlightCount } from '@/lib/talentos/opportunity';

const user = Astro.locals.user!;
const canEdit = can(user, 'roles.edit');
const canPolicy = can(user, 'opportunity.policy');
const { id } = Astro.params;

const opp = await readOpportunity(id!);
const inFlight = await inFlightCount(id!);
const sealed = opp.firstApplicationAt !== null;
const hasInFlight = inFlight > 0;              // hoisted: no < or > inside a JSX expression
const sealNote = sealed
  ? 'The short code and the framework setting are sealed because an application has arrived.'
  : 'The short code and the framework setting can be changed until the first application arrives.';
const inFlightNote = inFlight + ' applications are in flight on their pinned selection process.';

let okMsg = '';
let errorMsg = '';

if (Astro.request.method === 'POST' && canEdit) {
  const fd = await Astro.request.formData();
  if (fd.get('_intent') === 'opportunity') {
    const res = await saveOpportunity(id!, fd, { actorUserId: user.id, canPolicy });
    okMsg = res.ok ? 'Selection configuration saved.' : '';
    errorMsg = res.ok ? '' : res.error;
    if (res.ok) await logAudit({ userId: user.id, action: 'opportunity.config.update',
      entity: 'tos_opportunity', entityId: id!, diff: res.diff });
  }
}
---
<fieldset>
  <legend>Selection configuration</legend>
  <p>{sealNote}</p>
  {hasInFlight && <p>{inFlightNote}</p>}
  <label>Short code
    <input name="opportunityCode" value={opp.opportunityCode} disabled={sealed || !canEdit} />
  </label>
  <label>Minimum tenure for internal applicants, in days
    <input type="number" name="minTenureDays" value={opp.minTenureDays ?? ''} disabled={!canEdit} />
  </label>
  <label>Authorization code validity, in days
    <input type="number" name="codeValidityDays" value={opp.codeValidityDays} disabled={!canPolicy} />
  </label>
</fieldset>
```

`{hasInFlight && <p>…</p>}` renders a `<p>`, not a `<script>`; a `<script>` inside a JSX conditional
breaks Astro parsing. No `Record<string,string>` map is built inside JSX. No arrow character appears
in any JSX string. `define:vars` is not used here, and could not be combined with `is:inline` if it
were.

**MUST**: `saveOpportunity()` refuses a SEALED field and returns `{ ok: false, error }`. It **MUST
NOT** silently drop the field and report success. A save that reports success while discarding a
value is the failure mode this project has already shipped twice.

### 6.7 In-flight applications: closing, cancelling, changing the process

**Binding rule.** A change to an opportunity's selection process **MUST NOT** retroactively alter an
application already in flight. This is not a preference. It is the difference between a selection
record that can be defended and one that cannot.

The mechanism is **pinning at creation**: the pipeline and the full text of its seven slots are
copied onto the application's link row when the application is created, and every decision
thereafter reads the copy.

```sql
-- §6.7 additions. Idempotent. ensureOnce('tos_pipeline_pin_v1', ...).
ALTER TABLE tos_opportunity      ADD COLUMN IF NOT EXISTS first_application_at TIMESTAMPTZ;
ALTER TABLE tos_opportunity      ADD COLUMN IF NOT EXISTS cancelled_at         TIMESTAMPTZ;
ALTER TABLE tos_opportunity      ADD COLUMN IF NOT EXISTS cancelled_reason     TEXT;
ALTER TABLE tos_opportunity      ADD COLUMN IF NOT EXISTS cancelled_by_user_id UUID;

-- Any edit to any tos_pipeline_stage row bumps this. It is the cheap "is this application on the
-- current process" test for the admin list; the snapshot below is the authority.
ALTER TABLE tos_pipeline         ADD COLUMN IF NOT EXISTS revision INT NOT NULL DEFAULT 1;

ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS pipeline_id       UUID;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS pipeline_revision INT;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS pipeline_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_application_link ADD COLUMN IF NOT EXISTS pinned_at         TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS tos_app_link_unpinned_idx
  ON tos_application_link (opportunity_role_id) WHERE pinned_at IS NULL;
```

Snapshot shape stored in `pipeline_snapshot`:

```ts
export interface PinnedPipeline {
  pipelineId: string;
  pipelineKey: string;                 // tos_pipeline.key at pin time
  revision: number;                    // tos_pipeline.revision at pin time
  pinnedAt: string;                    // ISO
  stages: Array<{
    stageId: string;                   // tos_pipeline_stage.id
    slotNo: number;                    // 1..7
    label: string;
    kind: string;
    isRequired: boolean;
    weight: number;
    passRule: unknown;                 // §8.4 shape
    evaluatorRule: unknown;            // §8.5 shape
    slaDays: number | null;
    instrumentRef: string | null;
    candidateBlurb: string;
  }>;
}
```

Reading rule, and it is absolute:

- Every decision, every candidate-facing stage label, every pass rule and every evaluator rule for an
  application is read from `tos_application_link.pipeline_snapshot`.
- `tos_stage_run.pipeline_stage_id` remains a pointer into `tos_pipeline_stage` **for reporting and
  joins only**. It **MUST NOT** be dereferenced to obtain a rule or a label. `tos_stage_run` already
  carries its own `slot_no` and `kind` (§4.4) for the same reason.
- If a run references a `slot_no` absent from the snapshot, the run is left `not_started` and the
  application is reported on the diagnostics screen. It **MUST NOT** fall back to the live table.

Pinning happens in the same operation that inserts the link row. If no pipeline resolves — no
`tos_opportunity.pipeline_id` and no `tos_pipeline` with `is_default = TRUE` — the link row is still
written, with `pinned_at IS NULL`, and:

**MUST**: an application with `pinned_at IS NULL` **MUST NOT** advance past slot 1. It is not
rejected, not deleted and not hidden; it appears on the diagnostics list with a repair action.
REASON: losing a real application because an administrator had not configured a pipeline yet is a
worse failure than holding it.

**MUST**: any insert, update or delete against `tos_pipeline_stage` runs
`UPDATE tos_pipeline SET revision = revision + 1, updated_at = NOW() WHERE id = $1` in the same
operation.

What each administrative action does to applications already in flight:

| Action | New applications | Applications in flight |
|---|---|---|
| `applications_open = FALSE` | Refused, `unavailable` | **Untouched.** They continue on their pinned process. |
| Effective close instant passes | Refused | **Untouched.** |
| `roles.is_open = FALSE` | Refused, delisted, slug 404s | **Untouched.** The candidate's own `/portal/applications` view keeps working. |
| `pipeline_id` changed | Pinned to the new pipeline | **Untouched.** |
| A `tos_pipeline_stage` row edited | Pinned to the new revision | **Untouched.** Their snapshot still holds the old text. |
| Eligibility rules changed | Evaluated against the new rules | **Untouched.** §7.10 recorded the decision that admitted them. |
| `cancelled_at` set | Refused, delisted, slug 404s | Flagged for a human decision. **No state is written automatically.** |

**MUST NOT**: cancelling an opportunity writes no `tos_selection` row, sets no
`tos_stage_run.state`, and sends no rejection. Each of those is a decision about a named person, and
§4.5 requires a written `decision_reason` either way. The cancel action produces a work queue: the
in-flight applications listed with a pre-filled reason string that a human edits and confirms, one
decision per person, through the normal §10 path.

Deliberate re-pinning exists, and it is an override:

```ts
/**
 * Move an in-flight application onto the opportunity's current process. This is the ONLY way a
 * pinned process changes, and it is never automatic.
 */
export async function repinApplication(
  applicationId: string,
  opts: { actorUserId: string; reason: string },
): Promise<{ ok: boolean; error?: string }> {
  if (String(opts.reason || '').trim().length < 20) {
    return { ok: false, error: 'A written reason of at least 20 characters is required to re-pin an application.' };
  }
  // 1. INSERT tos_override (entity='tos_application_link', entity_id=applicationId,
  //    from_state='<key>#<revision>', to_state='<key>#<revision>', reason, actor_user_id).
  // 2. Re-snapshot, then UPDATE the link row's pipeline_id / pipeline_revision / pipeline_snapshot.
  // 3. Reset to 'not_started' every tos_stage_run whose slot kind differs from the new snapshot,
  //    leaving decided runs whose kind is unchanged alone.
  // 4. Notify the candidate through src/lib/notify.ts. They were told what the steps were.
  return { ok: true };
}
```

A re-pin that skips step 1 is a silent override, and a silent override is a defect (§4.8).

---

## 7. Eligibility engine [brief §11, §13, §16, §34]

### 7.1 What it is, and what it is forbidden to be

One pure function, three call sites, no database handle:

| Call site | Depth | Purpose |
|---|---|---|
| `/careers` listing | Availability only (6.4) | No person is loaded. Nothing is evaluated per candidate. |
| `/careers/[slug]` and `/apply` entry | Full | Tell the person, before they spend an hour, whether they may apply. |
| Application submission | Full, **authoritative** | The result is recorded on the link row (7.10). |

**MUST NOT** appear in this engine or in anything that calls it:

```ts
if (email.endsWith('@edurankai.in')) { /* anything authorising */ }   // FORBIDDEN, §5.7
if (user.role === 'admin') { /* eligibility */ }                      // FORBIDDEN, users.role is auth
if (identity.status === 'active') return { outcome: 'eligible' };     // FORBIDDEN, 7.8
```

`users.role` is an authentication attribute. Organizational standing is `tos_identity`, resolved
through `tos_person` (§5.3). An email domain is a display fact.

### 7.2 Evaluation order

Evaluated in this exact order. Steps 0 to 4 are structural gates and short-circuit; step 5 does not.

| # | Step | Applies to | On failure |
|---|---|---|---|
| 0 | Availability (6.4) | all | `outcome: 'unavailable'`. **Not** an eligibility failure and never recorded as one. Stops. |
| 1 | Person resolution (§5.3), following `merged_into_id` | all | `outcome: 'needs_review'`, reason `person_unresolved`. Stops. |
| 2 | Applicant classification (7.3) | all | `outcome: 'ineligible'`, reason `identity_suspended`, for a suspended identity only. Stops. |
| 3 | Channel gate: `external_eligible` / `internal_eligible` | all | `outcome: 'ineligible'`, reason `channel_closed`. Stops. |
| 4 | `internal_identity_types` allowlist (empty array = every §5.6 type) | internal only | `outcome: 'ineligible'`, reason `identity_type_not_permitted`. Stops. |
| 5 | `min_tenure_days`, then every rule in `eligibility_rules` in stored order | per rule's `appliesTo` | Collected, **not** short-circuited. |
| 6 | `requires_manager_consent` and any `manager_consent` rule | internal only | `outcome: 'needs_consent'` unless an earlier block exists. |
| 7 | Compose the outcome | all | — |

REASON step 5 does not short-circuit: a candidate told one failure at a time re-applies once per
failure, and an administrator debugging a rule set needs the whole picture on one screen. Steps 2 to
4 do short-circuit, because there is nothing useful to add once the channel itself is shut.

Outcome precedence at step 7: `unavailable` > `ineligible` > `needs_review` > `needs_consent` >
`eligible`. A `needs_review` never quietly resolves to `eligible`.

### 7.3 Identity status, including inactive identities

| `tos_identity.status` | Classified as | Internal-only opportunity | Opportunity open to external |
|---|---|---|---|
| `active` | **internal** | Evaluated against the internal rules | Applies as internal |
| `pending` | external | `ineligible`, reason `identity_pending` | Applies as external |
| `suspended` | **neither** | `ineligible`, reason `identity_suspended` | `ineligible`, reason `identity_suspended` |
| `expired` | external | `ineligible`, reason `no_internal_identity` | Applies as external |
| `terminated` | external | `ineligible`, reason `no_internal_identity` | Applies as external |
| no identity row | external | `ineligible`, reason `no_internal_identity` | Applies as external |

**MUST**: a suspended identity blocks both routes. Every other inactive state falls back to the
external route and is judged exactly as any member of the public would be. REASON: `expired` and
`terminated` describe an engagement that ended, and a former intern re-applying is a member of the
public — which is what the §25 T-07 conformance test asserts. Suspension describes a live
restriction; routing a suspended person through the public door would make suspension mean nothing.

**MUST**: the relevant identity is the one satisfying the `tos_identity_one_primary` partial unique
index (`is_primary AND status = 'active'`). If a person has active identities but none is primary,
use the one with the latest `started_on` and emit reason `identity_primary_ambiguous` at severity
`info`. It **MUST NOT** block. REASON: a gap in the identity registry is an administrator's problem,
not a candidate's.

**MUST**: `merged_into_id` is followed **before** anything is evaluated. Evaluating on a merged-away
row reads that person's history minus everything repointed to the winner, which is exactly how a
cooldown rule lets somebody straight through.

### 7.4 The rule grammar

`tos_opportunity.eligibility_rules` is a JSONB **array** of rule objects.

```ts
// src/lib/talentos/eligibility-rules.ts
export type IdentityType =
  | 'EMPLOYEE' | 'INTERN' | 'FELLOW' | 'MEMBER'
  | 'CAMPUS_AMBASSADOR' | 'CONTRACTOR' | 'CONSULTANT' | 'OTHER_AUTHORIZED_IDENTITY';

/** What a failed rule does. Never "reject the application" — that is a human decision (§10). */
export type RuleEffect = 'block' | 'require_review' | 'require_consent';

export interface RuleBase {
  /** Stable, administrator-visible, quoted in reasons and stored in the recorded decision (7.10). */
  id: string;
  appliesTo?: 'internal' | 'external' | 'all';   // default 'all'
  effect?: RuleEffect;                           // default 'block'
  /** Overrides the built-in candidate-safe sentence. No emoji. No outside company name. */
  message?: string;
}

export type EligibilityRule =
  | (RuleBase & { kind: 'min_tenure_days'; days: number;
      countFrom?: 'identity_start' | 'joining_date' })            // default 'identity_start'
  | (RuleBase & { kind: 'identity_type'; mode: 'allow' | 'deny'; types: IdentityType[] })
  | (RuleBase & { kind: 'department'; mode: 'allow' | 'deny'; departmentIds: string[] })  // TEXT slugs
  | (RuleBase & { kind: 'engagement_type'; mode: 'allow' | 'deny'; types: string[] })
  | (RuleBase & { kind: 'application_cooldown'; days: number;
      scope: 'same_opportunity' | 'same_department' | 'any_opportunity';
      countFrom?: 'submitted' | 'closed' })                       // default 'closed'
  | (RuleBase & { kind: 'level_progression'; maxStepsUp: number; allowLateral?: boolean })
  | (RuleBase & { kind: 'manager_consent';
      requestAt?: 'submission' | 'slot'; atSlot?: number })       // default 'submission'
  | (RuleBase & { kind: 'open_selection_block'; scope: 'any_opportunity' | 'same_department' })
  | (RuleBase & { kind: 'unrecognised'; raw: unknown });          // parser output only, never authored
```

`departmentIds` are **TEXT slugs**, compared as text. They **MUST NOT** be cast to `uuid` anywhere:
`departments.id` is a `varchar(50)` slug in `src/lib/db/schema.ts` and a UUID in `db/hr-schema.sql`,
and a `::uuid` cast throws the first time a slug arrives.

Parsing:

```ts
export function parseEligibilityRules(raw: unknown): EligibilityRule[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((r: any, i: number) => {
    const id = String(r?.id || 'rule-' + (i + 1));
    if (!r || typeof r !== 'object' || !KNOWN_KINDS.has(r.kind)) {
      return { kind: 'unrecognised', id, raw: r, effect: 'require_review' } as EligibilityRule;
    }
    return { ...r, id } as EligibilityRule;
  });
}
```

**MUST**: an unparseable or unknown rule becomes `kind: 'unrecognised'` with effect
`require_review`. It **MUST NOT** be skipped. REASON: skipping an unreadable rule turns a gate off
silently, and the first person to notice is the person who should not have got through.

### 7.5 Six worked rule sets

Each is one element of the array written by:

```sql
UPDATE tos_opportunity
   SET eligibility_rules = $1::jsonb, updated_at = NOW()
 WHERE role_id = $2;
```

**1. Minimum tenure.** Nobody may apply for an internal move inside their first six months.

```json
{ "kind": "min_tenure_days", "id": "tenure-180", "appliesTo": "internal",
  "days": 180, "countFrom": "identity_start", "effect": "block",
  "message": "Internal applications open after six months in your current engagement." }
```

`countFrom: 'identity_start'` reads `tos_identity.started_on`. `'joining_date'` reads
`hr_employees.joining_date` through `tos_identity.employee_id`, for identities created by the §5.4
backfill whose `started_on` was never set. If neither date resolves, the rule yields
`require_review` with reason `tenure_unknown` — never a pass, never a block.

**2. Identity type.** Open to people currently engaged as employees or interns.

```json
{ "kind": "identity_type", "id": "staff-only", "appliesTo": "internal", "mode": "allow",
  "types": ["EMPLOYEE", "INTERN"], "effect": "block",
  "message": "This opening is open to people currently engaged as employees or interns." }
```

Deliberately redundant with `internal_identity_types` (6.3). The column is the coarse gate an
administrator sets with checkboxes; the rule exists so a type restriction can carry its own message
and its own effect — `require_review` instead of `block`, for instance.

**3. Department.** Not open, without review, to the department that runs the hiring decision.

```json
{ "kind": "department", "id": "not-hr", "appliesTo": "internal", "mode": "deny",
  "departmentIds": ["hr"], "effect": "require_review",
  "message": "Your application will be reviewed by someone outside your own department." }
```

Matched against `tos_identity.department_id`, which is `TEXT`. `require_review` rather than `block`
because the conflict is one a human resolves by assigning a different evaluator; blocking would mean
nobody in the department that runs recruitment could ever move.

**4. Prior-application cooldown.**

```json
{ "kind": "application_cooldown", "id": "cooldown-90", "appliesTo": "all",
  "days": 90, "scope": "same_opportunity", "countFrom": "closed", "effect": "block",
  "message": "You can apply for this opening again 90 days after your last application closed." }
```

`countFrom: 'closed'` measures from the close of the previous application: a `tos_selection`
`decided_at`, or the point at which `applications.stage` reached a `CLOSED_STAGES` key
(`decision_no`, `withdrawn`) in `src/lib/application-stages.ts`. An application still **in flight**
is not a cooldown failure; it is a duplicate, reported as reason `application_in_flight` at severity
`block` with its own message.

**5. Level progression.** No more than one level up in a single move.

```json
{ "kind": "level_progression", "id": "one-step", "appliesTo": "internal",
  "maxStepsUp": 1, "allowLateral": true, "effect": "require_review",
  "message": "This opening is more than one level above your current engagement, so a reviewer will look at your application before the process starts." }
```

The ladder is the existing `role_level` pgEnum, ascending:
`Apprentice`(0), `Intern`(1), `Junior`(2), `Mid`(3), `Senior`(4), `Lead`(5), `C-Level`(6).
Current level is resolved by 7.6. `require_review` rather than `block` because a two-step move is a
judgement, not an error, and the point of an internal route is that somebody can be better than
their current title.

**6. Manager consent.**

```json
{ "kind": "manager_consent", "id": "consent-transfer", "appliesTo": "internal",
  "requestAt": "submission", "effect": "require_consent",
  "message": "Your reporting manager will be asked to confirm they are aware of this application." }
```

### 7.6 Resolving an internal applicant's current level

No column stores it. This ladder uses only columns that already exist, and stops at the first answer:

1. `tos_identity.position_id` -> `org_positions.grade` (TEXT), when it parses to a `role_level` value.
2. The most recent `tos_selection` for this person with `decision = 'selected'` and
   `suspended_at IS NULL` -> `roles.level` of `opportunity_role_id`.
3. `tos_identity.employee_id` -> `hr_employees.application_id` -> `applications.role_id` ->
   `roles.level`. This is the path that answers for everyone created by the §5.4 backfill.
4. Unresolved.

**MUST**: an unresolved level makes a `level_progression` rule evaluate to `require_review` with
reason `level_unknown`. It **MUST NOT** pass and **MUST NOT** block. Guessing a level from
`hr_employees.designation`, which is free text, is not permitted.

### 7.7 The function

```ts
// src/lib/talentos/eligibility.ts
// PURE. No db import, no fetch, no clock other than the injected `now`. The caller loads history.
// This is what makes it testable, and it is what keeps a detector out of it: a function with no IO
// cannot consult a proctoring signal, so no stage outcome can originate here.

export type EligibilityOutcome =
  | 'eligible' | 'needs_consent' | 'needs_review' | 'ineligible' | 'unavailable';

export type ReasonSeverity = 'block' | 'review' | 'consent' | 'info';

export interface EligibilityReason {
  /** Machine-readable, stable, safe to switch on. Never shown to a candidate. */
  code: string;
  ruleId?: string;
  severity: ReasonSeverity;
  /** For administrators and the recorded decision. May name rules, columns and dates. */
  detail: string;
  /** Rendered to the candidate as-is. No emoji. No other person's name. No rule id. No score. */
  message: string;
}

export interface EligibilityDecision {
  outcome: EligibilityOutcome;
  applicantType: 'internal' | 'external';
  reasons: EligibilityReason[];
  /** Present when outcome is 'needs_consent'. */
  consent?: { required: true; requestAt: 'submission' | 'slot'; atSlot: number | null };
  /** sha256 of the normalised rule array plus the §4.2 gate columns. Stored with the decision. */
  ruleSetHash: string;
  evaluatedAt: string;
}

export interface EligibilityPerson {
  id: string; personCode: string; primaryEmail: string;
  userId: string | null; mergedIntoId: string | null;
}

export interface EligibilityIdentity {
  id: string; identityType: IdentityType;
  status: 'pending' | 'active' | 'suspended' | 'expired' | 'terminated';
  isPrimary: boolean; departmentId: string | null; positionId: string | null;
  engagementType: string | null; startedOn: string | null; endedOn: string | null;
  joiningDate: string | null;          // hr_employees.joining_date, when employment-backed
  currentLevel: string | null;         // resolved by 7.6 before the call
}

export interface EligibilityOpportunity {
  roleId: string; opportunityCode: string;
  level: string; departmentId: string;                 // roles.level, roles.department_id (TEXT)
  availability: OpportunityAvailability;               // 6.4, computed by the caller
  externalEligible: boolean; internalEligible: boolean;
  internalIdentityTypes: string[]; minTenureDays: number | null;
  requiresManagerConsent: boolean; rules: EligibilityRule[];
}

export interface EligibilityHistory {
  applications: Array<{
    applicationId: string; opportunityRoleId: string; departmentId: string | null;
    submittedAt: string; closedAt: string | null; inFlight: boolean;
  }>;
  selections: Array<{
    opportunityRoleId: string; decision: string; decidedAt: string; suspendedAt: string | null;
  }>;
  /** The live tos_internal_consent row for this person and opportunity, if any (7.9). */
  consent: { state: 'pending' | 'granted' | 'declined' | 'expired' | 'waived'; decidedAt: string | null } | null;
}

export function evaluateEligibility(
  person: EligibilityPerson,
  identity: EligibilityIdentity | null,     // null = no organizational identity at all
  opportunity: EligibilityOpportunity,
  history: EligibilityHistory,
  now: Date = new Date(),
): EligibilityDecision;
```

Reason codes are a closed set: `person_unresolved`, `identity_suspended`, `identity_pending`,
`identity_primary_ambiguous`, `no_internal_identity`, `channel_closed`,
`identity_type_not_permitted`, `tenure_short`, `tenure_unknown`, `department_denied`,
`engagement_denied`, `cooldown_active`, `application_in_flight`, `level_gap`, `level_unknown`,
`open_selection_exists`, `consent_required`, `consent_declined`, `consent_expired`,
`rule_unrecognised`.

Every candidate-facing `message` **MUST**:

- state only the applicant's own facts and the requirement ("applications open after six months");
- never name another person, including a reporting manager;
- never contain a score, a rule id, an evaluator, or an internal reason code;
- never contain an emoji;
- never name a competitor or any real outside company.

A `detail` may contain all of that except another person's private data. It is written to the
recorded decision (7.10) and to `audit_log`, never to a page a candidate can open.

### 7.8 Nobody is ever automatically eligible, and nobody is ever automatically selected

**MUST**: holding an active `tos_identity` of any type — `EMPLOYEE`, `INTERN`, `FELLOW`, `MEMBER` or
any other — confers **no** eligibility by itself. `internal_eligible = TRUE` means the internal
channel is open, not that any particular internal person passes it. Every rule in step 5 still runs.

**MUST NOT**: `evaluateEligibility` decides only whether a person may **submit an application**. No
caller may read `outcome: 'eligible'` as a selection, an offer, an advancement, or a reason to write
`tos_selection`, `tos_stage_run.state` or `tos_onboarding`. The only path to
`tos_selection.decision = 'selected'` is a named human writing a `decision_reason` (§4.5, §10).

**MUST NOT**: any detector — proctoring flags in `tos_stage_run.advisory_flags`, duplicate-device
signals, similarity scores — may feed this function. It has no IO precisely so that it cannot.
Detection output is advisory; a human decides.

**MUST**: an internal applicant with an existing engagement who is selected for a new one receives a
**new** `tos_identity` row, and where the type is employment-backed, whatever §13 specifies. The
existing identity is never silently mutated into the new one.

### 7.9 The internal-transfer consent path

```sql
-- §7.9. Idempotent. ensureOnce('tos_internal_consent_v1', ...).
CREATE TABLE IF NOT EXISTS tos_internal_consent (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id           UUID NOT NULL,
  identity_id         UUID NOT NULL,                  -- tos_identity.id the person is applying FROM
  opportunity_role_id UUID NOT NULL,                  -- roles.id
  application_id      UUID,                           -- applications.id, once it exists
  manager_employee_id UUID,                           -- hr_employees.id  (org graph id space)
  manager_user_id     UUID,                           -- users.id         (notification id space)
  resolved_via        TEXT NOT NULL DEFAULT 'org_graph',  -- org_graph|legacy_column|department_head|manual
  state               TEXT NOT NULL DEFAULT 'pending',    -- pending|granted|declined|expired|waived
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ,
  decided_at          TIMESTAMPTZ,
  decided_by_user_id  UUID,
  decision_note       TEXT,
  waiver_override_id  UUID,                           -- tos_override.id when an admin waived it
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS application_id      UUID;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS manager_employee_id UUID;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS manager_user_id     UUID;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS resolved_via        TEXT NOT NULL DEFAULT 'org_graph';
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS expires_at          TIMESTAMPTZ;
ALTER TABLE tos_internal_consent ADD COLUMN IF NOT EXISTS waiver_override_id  UUID;
CREATE UNIQUE INDEX IF NOT EXISTS tos_internal_consent_open_uq
  ON tos_internal_consent (person_id, opportunity_role_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS tos_internal_consent_mgr_idx
  ON tos_internal_consent (manager_user_id, state, requested_at DESC);
```

**Resolving the manager, in order:**

```ts
import { readEmployeeIdForUser, getManager, getDepartmentHead } from '@/lib/org-graph';

// 1. users.id -> hr_employees.id. These are DIFFERENT id spaces (§1.4.2); this is the translation.
const { ok, employeeId } = await readEmployeeIdForUser(applicantUserId);
// 2. The org graph edge, as of now. subject = the manager, object = the report.
const mgr = employeeId ? await getManager(employeeId) : null;
// 3. Fall back to the recorded head of the applicant's department.
const head = (!mgr && employeeId) ? await getDepartmentHead(employeeId) : null;
```

`getManager()` returns an `OrgPerson` carrying both `employeeId` and `userId`; store both.
`resolved_via` records which step answered, and the admin surface says which.

**MUST NOT** resolve the manager from `users.role`, from a direct read of
`hr_employees.reporting_manager_id`, or from an email domain. `hr_employees.reporting_manager_id`
holds a **`users.id`** while `org_relationships.subject_employee_id` holds an **`hr_employees.id`**;
reading one as the other produces a confident answer about the wrong person. `org-graph.ts` already
contains the compatibility path that reads the legacy column correctly, and
`resolved_via = 'legacy_column'` records when it was used.

**When nobody resolves**: `state = 'pending'`, `manager_user_id = NULL`, decision `needs_review` with
reason `consent_required`, routed to holders of `roles.edit`. **MUST NOT** auto-grant.
`readEmployeeIdForUser` returns `{ ok: false }` when the *lookup itself failed*, which is not the
same as "this account is not an employee": a failed lookup is `needs_review`, never a pass.

**Timing**: `requestAt` defaults to `'submission'`. The application is accepted and held; the consent
request is raised at that moment.

REASON the consent gate is not on the apply form: requiring a person to get their manager's
permission before they may even express interest is the mechanism by which internal mobility stops
happening. The application is recorded, the manager is asked, and the person is told plainly that
they were asked. `requestAt: 'slot'` with `atSlot` defers the ask to a later stage where an
opportunity prefers that.

**Expiry**: `expires_at = requested_at + 14 days`. On expiry the state becomes `expired`, the
decision is `needs_review` with reason `consent_expired`, routed to `roles.edit` holders. An expired
consent **MUST NOT** be read as granted and **MUST NOT** be read as declined.

**Effect**: while consent is neither `granted` nor `waived`, the application **MUST NOT** be given
`tos_selection.decision = 'selected'`, and where `requestAt: 'slot'` is set it **MUST NOT** advance
past `atSlot`. A `declined` consent does **not** close the application: it produces reason
`consent_declined` at severity `block`, and a decision that a human records with a written reason.

**Waiver**: only through a `tos_override` row (§4.8) whose `reason` is at least 20 characters and
whose id is written to `waiver_override_id` in the same operation. A consent set to `waived` without
an override row is a silent override, and a silent override is a defect.

**MUST NOT**: no consent screen, notification or admin list may show the manager the applicant's
health data, date of birth or blood group. `hr_employees.blood_group` and
`hr_employees.date_of_birth` are HR record fields; they are not columns on an oversight screen.

### 7.10 Caching: recorded, not cached

**The gating decision is NOT cached across requests.**

Allowed: a per-request memo — a `Map` keyed `personId + ':' + roleId`, created at the top of a
request and discarded with it — so a page that renders the same opportunity twice does not load the
history twice.

**MUST NOT**: any cross-request cache, in memory or in a table, consulted instead of re-evaluating.
REASON: rules change, an identity is suspended, a consent is granted, a prior application closes and
starts a cooldown — each of those invalidates a stored answer, and a cached `eligible` is a security
hole with a long tail. The function is pure and costs microseconds; the only real cost is the
history load, which is one query:

```ts
const r = await db.execute(sql`
  SELECT al.application_id, al.opportunity_role_id, a.created_at AS submitted_at, a.stage,
         s.decision, s.decided_at, s.suspended_at
    FROM tos_application_link al
    JOIN applications a ON a.id = al.application_id
    LEFT JOIN tos_selection s ON s.application_id = al.application_id
   WHERE al.person_id = ${personId}
   ORDER BY a.created_at DESC
   LIMIT 200`);
const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);   // never r.rows[0]
```

`a.stage` is compared against `TERMINAL_STAGES` from `src/lib/application-stages.ts` to derive
`inFlight`. Do not reimplement that list.

**The submission-time decision IS recorded.** Recording is not caching: nothing ever reads it to
decide whether somebody may apply.

```sql
-- §7.10. Idempotent. ensureOnce('tos_eligibility_record_v1', ...).
ALTER TABLE tos_application_link
  ADD COLUMN IF NOT EXISTS eligibility_outcome   TEXT;
ALTER TABLE tos_application_link
  ADD COLUMN IF NOT EXISTS eligibility_decision  JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_application_link
  ADD COLUMN IF NOT EXISTS eligibility_rule_hash TEXT;
CREATE INDEX IF NOT EXISTS tos_app_link_elig_idx
  ON tos_application_link (opportunity_role_id, eligibility_outcome);
```

`eligibility_decision` holds the whole `EligibilityDecision`, `reasons` included, with both `detail`
and `message`. REASON it is stored in full rather than recomputed on demand: the eligibility fields
are FORWARD (6.6) and will have changed by the time anyone asks why a person was admitted;
recomputing against today's rules answers a different question, and answers it confidently.

**MUST**: `eligibility_decision` is an admin-visible record on the application detail screen. It
contains rule ids, dates, and the applicant's own tenure and level. It contains no health data, no
date of birth and no blood group.

---

## 8. The seven-stage evaluation framework [brief §7, §17, §25]

Module root: `src/lib/talentos/stages/`. Four files, and the split is load-bearing because §8.7's
invariant is proved by what a file is *unable to import*:

| File | Owns | May write |
|---|---|---|
| `pipeline.ts` | Pipeline and slot definitions, the default seed, cloning, validation | `tos_pipeline`, `tos_pipeline_stage` |
| `state.ts` | The `tos_stage_run` state machine, waivers, skips, the SLA clock | `tos_stage_run.state`, `opened_at`, `due_at`, `decided_*`, `tos_override` |
| `rules.ts` | The `PassRule` and `EvaluatorRule` grammars and their **pure** evaluators | nothing — it has no database import at all |
| `advisory.ts` | Advisory flags and their copy | `tos_stage_run.advisory_flags` **only** |

`src/lib/talentos/projection.ts` is separate again, and is the only writer of the candidate-visible
funnel (§8.6).

---

### 8.1 The framework is the seven slots. The components are configuration.

The brief says both that the selection process is "configurable by Admin" [brief §16] and that every
opportunity "conforms to the EduRankAI seven-stage evaluation framework" [brief §7]. Those are not in
tension once the framework is understood as **arity, order and record shape** rather than as content.

**The framework** — fixed, and not configurable by anybody:

- Every pipeline has **exactly seven** `tos_pipeline_stage` rows, `slot_no` 1 through 7.
- Every application against that pipeline has **exactly seven** `tos_stage_run` rows, one per slot,
  materialised when the application is linked and never deleted.
- Slot order is evaluation order. Slot *n* is not opened until slots 1..*n*-1 are all *satisfied*
  (`passed`, `waived` or `skipped`).
- `slot_no` fixes the candidate-visible band (§8.6). It does not move.

**The configuration** — everything else on the row: `label`, `kind`, `is_required`, `weight`,
`pass_rule`, `evaluator_rule`, `sla_days`, `instrument_ref`, `candidate_blurb`. An administrator may
put a written assignment in slot 3 and a panel conversation in slot 4, make slot 6 a language
screening, or mark slots 3 and 4 not-required for a volunteer opportunity.

**REASON for fixed arity.** Two other designs were available and both were rejected:

1. *Variable-length pipelines.* Comparability dies immediately — "how many candidates reached stage
   four" stops meaning anything across roles — and the projection in §8.6 stops being a total
   function, which is exactly how a candidate's tracker ends up stale. That failure is already
   documented in `src/lib/application-stages.ts` and MUST NOT be reintroduced.
2. *Seven hardcoded components.* The brief requires per-opportunity configuration [brief §16], and a
   research fellowship, a campus ambassadorship and a full-time engineering hire genuinely do not
   share an instrument set.

Fixed arity with configurable occupancy is the only shape that satisfies both sentences of the brief.

**MUST**: a pipeline whose `tos_pipeline_stage` row count is not seven, or whose `slot_no` values are
not exactly 1 through 7, is invalid. It MUST NOT be assignable to an opportunity, and it MUST be
reported by the validator. The unique index `tos_pipeline_stage_slot_uq (pipeline_id, slot_no)`
prevents duplicates; it cannot prevent a gap, so the gap check is code.

```ts
// src/lib/talentos/stages/pipeline.ts
export interface PipelineValidation { ok: boolean; problems: string[] }

export async function validatePipeline(pipelineId: string): Promise<PipelineValidation> {
  const problems: string[] = [];
  try {
    const r = await db.execute(sql`
      SELECT slot_no, kind, label FROM tos_pipeline_stage
       WHERE pipeline_id = ${pipelineId} ORDER BY slot_no ASC`);
    const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
    const slots = rows.map((x: any) => Number(x.slot_no));
    for (let n = 1; n <= 7; n++) {
      if (slots.indexOf(n) === -1) problems.push('slot ' + n + ' is missing');
    }
    for (const n of slots) {
      if (n < 1 || n > 7) problems.push('slot ' + n + ' is outside 1..7');
    }
    for (const row of rows) {
      if (STAGE_KINDS.indexOf(String(row.kind) as StageKind) === -1) {
        problems.push('slot ' + row.slot_no + ' has kind "' + String(row.kind) + '", which is not one of the seven kinds');
      }
      if (!String(row.label || '').trim()) problems.push('slot ' + row.slot_no + ' has no label');
    }
    const seven = rows.find((x: any) => Number(x.slot_no) === 7);
    if (seven && String(seven.kind) !== 'decision') {
      problems.push('slot 7 must have kind "decision"; a pipeline that never decides is not a pipeline');
    }
  } catch (e: any) {
    console.error('[talentos/pipeline] validate:', e?.cause?.message || e?.message);
    problems.push('the pipeline could not be read, so it is not known to be valid');
  }
  return { ok: problems.length === 0, problems };
}
```

Note the failure branch: an unreadable pipeline reports **not valid**, never valid-by-default. This
project has already shipped a bootstrap that answered `ok: true` while ten tables were missing.

**Per-opportunity variation is a pipeline, not a per-slot override.** A role that needs different
components gets its own `tos_pipeline` row — clone the default, edit the slots — and points at it
through `tos_opportunity.pipeline_id`. There is deliberately **no** per-opportunity per-slot override
table. REASON: it would be a second source of truth for "is this slot required", and the two would
disagree within the first week. `clonePipeline(sourceKey, newKey, name)` in `pipeline.ts` copies all
seven rows in one statement and is the supported path.

`tos_opportunity.requires_seven_stage = FALSE` does **not** mean fewer runs. It marks a
**direct-onboarding** opportunity [brief §5]: slots 1 to 6 are created in state `skipped` and only
slot 7 (`decision`) is live. Seven runs still exist, so the audit still shows a seven-slot record for
every person.

---

### 8.2 The canonical default pipeline

`tos_pipeline_stage.kind` is a **closed vocabulary of exactly seven values**. It is `TEXT` with the
values enforced in TypeScript, not a Postgres `CHECK` (§3).

```ts
// src/lib/talentos/stages/rules.ts
export const STAGE_KINDS = [
  'screening', 'assessment', 'assignment', 'interview', 'review', 'reference', 'decision',
] as const;
export type StageKind = typeof STAGE_KINDS[number];

/** The kinds the candidate personally does something for. The rest are staff work. */
export const CANDIDATE_FACING_KINDS: readonly StageKind[] =
  ['assessment', 'assignment', 'interview', 'reference'];
```

| Kind | Means |
|---|---|
| `screening` | A rule-checked gate over data already submitted. No new candidate effort. |
| `assessment` | A timed or otherwise bounded instrument with a score, run through the existing tests subsystem. |
| `assignment` | Unbounded practical work, submitted as verified links (§12.5). |
| `interview` | A scheduled conversation with a panel, scored through the existing interview scorecards. |
| `review` | A human reads material and forms a verdict. No instrument, no score required. |
| `reference` | A third party is asked to confirm something. The candidate supplies the referee. |
| `decision` | The slot where a named human selects or does not select. Exactly one per pipeline: slot 7. |

The default pipeline is `tos_pipeline.key = 'default'`, `is_default = TRUE`:

| Slot | Label | Kind | Purpose | Typical instrument (`instrument_ref`) | `sla_days` | `weight` |
|---|---|---|---|---|---|---|
| 1 | Application screening | `screening` | Eligibility and completeness against `tos_opportunity.eligibility_rules`; deduplication against the person's existing applications. | none — reads the `applications` row | 3 | 0 |
| 2 | Profile and portfolio review | `review` | A human reads the profile, the linked work and the written answers. | reviewer checklist key | 5 | 15 |
| 3 | Structured assessment | `assessment` | A scored instrument sat under the existing tests subsystem. | test id | 7 | 25 |
| 4 | Practical assignment | `assignment` | Real work of the kind the opportunity involves, submitted as links. | assignment brief slug | 7 | 25 |
| 5 | Conversation round | `interview` | Panel conversation; scorecards land in the existing `interview_scorecards`. | interview template key | 10 | 25 |
| 6 | Reference and verification | `reference` | Referee confirmation and document verification. | referee form slug | 7 | 10 |
| 7 | Selection decision | `decision` | A named human records selected, rejected or waitlisted, with a written reason. | none | 5 | 0 |

Notes that bind:

- **Slot 7 MUST NOT be waived, skipped or decided by a rule.** A `tos_selection` row is written only
  by a human transitioning slot 7, with `decision_reason` filled. A decision nobody made is not a
  decision; `tos_selection.decision_reason NOT NULL` and §8.3's rule that `decided_by` is NOT NULL
  for `kind='decision'` are the two enforcement points.
- **`weight` is informational** unless a `pass_rule` names it. It exists so an admin board can show a
  composite picture; nothing in §8.4 reads it implicitly.
- **The decision form and unpaid engagements.** Where the decision slot offers an internship or an
  apprenticeship and `tos_selection.stipend_amount` is left empty, the form and every downstream
  document MUST say plainly that the engagement is **unpaid**. Empty is not "to be decided" (§12.6).
- **`candidate_blurb` is candidate-visible copy.** No emojis, no outside company names, and nothing
  that claims EduRankAI awards a credential or is a university. The defaults are written in the same
  present-tense, plain register as `STAGES` in `src/lib/application-stages.ts`.

Seeding is idempotent and runs through `ensureOnce`, per §3:

```ts
// src/lib/talentos/stages/pipeline.ts
const DEFAULT_SLOTS: ReadonlyArray<readonly [number, string, StageKind, number, number]> = [
  [1, 'Application screening',        'screening',   3,  0],
  [2, 'Profile and portfolio review', 'review',      5, 15],
  [3, 'Structured assessment',        'assessment',  7, 25],
  [4, 'Practical assignment',         'assignment',  7, 25],
  [5, 'Conversation round',           'interview',  10, 25],
  [6, 'Reference and verification',   'reference',   7, 10],
  [7, 'Selection decision',           'decision',    5,  0],
];

export async function ensureDefaultPipeline(): Promise<string | null> {
  try {
    await db.execute(sql`
      INSERT INTO tos_pipeline (key, name, description, is_default, is_active)
      VALUES ('default', 'Seven-stage evaluation',
              'The default seven slots. Slot occupancy is configurable; the seven slots are not.',
              TRUE, TRUE)
      ON CONFLICT (key) DO NOTHING`);
    const r = await db.execute(sql`SELECT id FROM tos_pipeline WHERE key = 'default' LIMIT 1`);
    const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
    const pipelineId = rows[0]?.id ? String(rows[0].id) : null;
    if (!pipelineId) return null;
    for (const [slot, label, kind, sla, weight] of DEFAULT_SLOTS) {
      await db.execute(sql`
        INSERT INTO tos_pipeline_stage (pipeline_id, slot_no, label, kind, sla_days, weight, is_required)
        VALUES (${pipelineId}, ${slot}, ${label}, ${kind}, ${sla}, ${weight}, TRUE)
        ON CONFLICT (pipeline_id, slot_no) DO NOTHING`);
    }
    return pipelineId;
  } catch (e: any) {
    console.error('[talentos/pipeline] ensureDefaultPipeline:', e?.cause?.message || e?.message);
    return null;
  }
}
```

`ON CONFLICT DO NOTHING`, never `DO UPDATE`: re-running the seed MUST NOT silently revert an
administrator's configuration of a slot.

---

### 8.3 The `tos_stage_run` state machine

Nine states, already declared in §4.4:

| State | Meaning | Terminal | Satisfied |
|---|---|---|---|
| `not_started` | The run exists; the slot is not open. | no | no |
| `invited` | The candidate has been invited to a candidate-facing slot. `opened_at` and `due_at` are set here. | no | no |
| `in_progress` | The candidate has begun the instrument. | no | no |
| `submitted` | The candidate's part is complete. Evaluators are not yet assigned. | no | no |
| `under_review` | Evaluators are assigned and the pass rule is live. Staff-only slots open directly into this state, and `opened_at` / `due_at` are set here for them. | no | no |
| `passed` | The slot is satisfied on merit. | yes | yes |
| `failed` | The slot is not satisfied. Closes the application. | yes | no |
| `waived` | The slot was required and a named human excused this candidate from it. | yes | yes |
| `skipped` | The slot was not required for this opportunity. Nobody was excused from anything. | yes | yes |

*Satisfied* is what gates the next slot. `waived` and `skipped` are both satisfied, and they are never
collapsed into one another anywhere they are displayed (§8.8).

#### Transition table

"Override" means a `tos_override` row (`entity = 'tos_stage_run'`) MUST be inserted in the same
operation, with a reason of at least twenty characters, per §4.8.

| From | To | Trigger | Actor | Override row |
|---|---|---|---|---|
| `not_started` | `invited` | Prior slots satisfied; the slot is candidate-facing | system or admin | no |
| `not_started` | `under_review` | Prior slots satisfied; the slot is staff-only (`screening`, `review`, `decision`) | system or admin | no |
| `not_started` | `skipped` | Run creation, where the slot is not required for this opportunity | system | no |
| `invited` | `in_progress` | Candidate opens the instrument | candidate | no |
| `invited` | `submitted` | The instrument returns a completed attempt without an in-progress signal | system | no |
| `invited` | `failed` | The candidate did not engage; a human closes it, `outcome_note` required | **human only** | no |
| `in_progress` | `submitted` | Candidate submits | candidate | no |
| `submitted` | `under_review` | Evaluators resolved and assigned (§8.5) | system | no |
| `under_review` | `passed` | The pass rule returns `pass`, or a human decides | human, or a named rule | no |
| `under_review` | `failed` | The pass rule returns `fail`, or a human decides | human, or a named rule | no |
| *any non-terminal* | `waived` | Waiver granted (§8.8) | human holding the waive capability | **yes** |
| *any other pair* | *any other pair* | Correction, reopening, reversal, re-invitation | human | **yes** |

Formally: the ten free edges are listed above; a same-state write is a no-op; **every other ordered
pair of valid states is reachable only through an override**. That is one uniform rule rather than a
forbidden list, and it matches the blanket MUST in §4.8 exactly.

REASON for making reversal possible at all rather than forbidding it: a forbidden reversal is worked
around by editing the database by hand, which produces no record whatever. An override that is
expensive but recorded beats an edit that is free and invisible.

```ts
// src/lib/talentos/stages/state.ts
export type StageState =
  | 'not_started' | 'invited' | 'in_progress' | 'submitted'
  | 'under_review' | 'passed' | 'failed' | 'waived' | 'skipped';

export const STAGE_STATES: readonly StageState[] = [
  'not_started', 'invited', 'in_progress', 'submitted',
  'under_review', 'passed', 'failed', 'waived', 'skipped',
];
export const TERMINAL_STAGE_STATES: readonly StageState[] = ['passed', 'failed', 'waived', 'skipped'];
export const SATISFIED_STAGE_STATES: readonly StageState[] = ['passed', 'waived', 'skipped'];

/** Pairs, not a Record. This module is imported by .astro pages, where a typed
 *  Record<string,string> inside JSX breaks the compiler. */
const FREE_EDGES: ReadonlyArray<readonly [StageState, StageState]> = [
  ['not_started', 'invited'],
  ['not_started', 'under_review'],
  ['not_started', 'skipped'],
  ['invited', 'in_progress'],
  ['invited', 'submitted'],
  ['invited', 'failed'],
  ['in_progress', 'submitted'],
  ['submitted', 'under_review'],
  ['under_review', 'passed'],
  ['under_review', 'failed'],
];

export type TransitionMode = 'noop' | 'allowed' | 'override' | 'invalid';

export function transitionMode(from: string, to: string, kind: StageKind): TransitionMode {
  const f = from as StageState;
  const t = to as StageState;
  if (STAGE_STATES.indexOf(f) === -1 || STAGE_STATES.indexOf(t) === -1) return 'invalid';
  if (f === t) return 'noop';
  const free = FREE_EDGES.some((e) => e[0] === f && e[1] === t);
  if (!free) return 'override';
  // A staff-only slot has no candidate to invite, and a candidate-facing slot is not opened
  // straight into review behind the candidate's back.
  const candidateFacing = CANDIDATE_FACING_KINDS.indexOf(kind) >= 0;
  if (t === 'invited' && !candidateFacing) return 'override';
  if (f === 'not_started' && t === 'under_review' && candidateFacing) return 'override';
  return 'allowed';
}
```

Rules the single writer `setStageRunState()` enforces on top of the table:

- **MUST** refuse a state not in `STAGE_STATES`, log the refusal, and **return** an error rather than
  throwing — the same shape `advanceStage()` already uses, and for the same reason: a stage-machine
  fault must not roll back the thing that prompted it.
- **MUST** set `opened_at` and `due_at` (§8.9) on the first transition out of `not_started`, and never
  again except through `extendSla()`.
- **MUST** set `submitted_at` on entry to `submitted`, and `decided_at` plus `decided_by` on entry to
  any terminal state.
- **MUST** require a non-null `decided_by` (a `users.id`) for `kind = 'decision'` and for every
  transition to `waived`. No rule and no scheduled job may decide those.
- **MUST** call `syncCandidateStage(applicationId)` from §8.6 in the same operation, after the state
  write commits.
- **MUST NOT** let a scheduled job move a run to `failed` because `due_at` passed. An overdue run is
  reported (§8.9); it is not judged. A clock is not an evaluator.
- Application withdrawal does not add a tenth state. Open runs are closed to `skipped` with
  `outcome_note = 'application withdrawn by the candidate'`, and the ending itself is carried by
  `applications.status = 'withdrawn'`, which §8.6 reads first. REASON: a ninth and tenth state would
  double every row of the transition table for no reporting gain.

---

### 8.4 `pass_rule` grammar

`pass_rule` is JSONB on `tos_pipeline_stage`. Its evaluator is **pure** and lives in `rules.ts`, which
imports no database module at all. That is not tidiness; it is the structural half of §8.7's proof,
because a function that cannot see `advisory_flags` cannot decide on them.

```ts
// src/lib/talentos/stages/rules.ts
export type PassRule =
  | { type: 'none' }
  | { type: 'threshold'; source: 'run_score' | 'evaluation_mean'; min: number }
  | { type: 'unanimous'; among: 'required_evaluators'; holdCountsAs: 'fail' | 'block' }
  | { type: 'majority'; among: 'required_evaluators'; quorum?: number;
      holdCountsAs: 'abstain' | 'fail'; tie: 'escalate' | 'fail' }
  | { type: 'rubric_minimum'; across: 'every_evaluator' | 'mean';
      dimensions: ReadonlyArray<readonly [string, number]> }
  | { type: 'all_of'; rules: readonly PassRule[] }
  | { type: 'any_of'; rules: readonly PassRule[] };

export interface EvaluationInput {
  evaluatorUserId: string;
  verdict: 'pass' | 'fail' | 'hold';
  score: number | null;
  /** Pairs, not a Record — see §8.3. The loader converts the JSONB object into pairs. */
  dimensions: ReadonlyArray<readonly [string, number]>;
}

/** NOTE WHAT IS ABSENT. There is no advisory field on this type, and there never may be. */
export interface PassRuleInput {
  runScore: number | null;
  /** tos_stage_evaluator rows with state='assigned' AND is_required — the DENOMINATOR. */
  requiredEvaluatorIds: readonly string[];
  /** tos_evaluation rows, already filtered to assigned, non-excluded evaluators. */
  evaluations: readonly EvaluationInput[];
}

export type PassOutcome = 'pass' | 'fail' | 'indeterminate';
export interface PassRuleResult { outcome: PassOutcome; reason: string }

export function evaluatePassRule(rule: PassRule | null, input: PassRuleInput): PassRuleResult;
```

An empty `{}` in the column normalises to `{ type: 'none' }`, which always returns `indeterminate`
with the reason *"this slot is decided by a person, not by a rule"*. REASON: the default
configuration must not be a rule that quietly passes people.

#### Worked examples

**Threshold on the run score** — a timed assessment marked out of 100, pass mark 60:

```json
{ "type": "threshold", "source": "run_score", "min": 60 }
```

A null `runScore` returns `indeterminate`, never `fail`. A missing score is a missing measurement.

**Unanimous evaluator pass** — every assigned required evaluator must say pass:

```json
{ "type": "unanimous", "among": "required_evaluators", "holdCountsAs": "block" }
```

`holdCountsAs: "block"` maps a `hold` verdict to `indeterminate` — the panel is still talking.
`"fail"` maps it to `fail` — a hold is a no in this process. The choice is explicit because both are
defensible and a default here would be a silent policy.

**Majority pass with a quorum of three**:

```json
{ "type": "majority", "among": "required_evaluators", "quorum": 3,
  "holdCountsAs": "abstain", "tie": "escalate" }
```

**Rubric-dimension minimum** — every evaluator must score at least 3 on both named dimensions:

```json
{ "type": "rubric_minimum", "across": "every_evaluator",
  "dimensions": [["clarity", 3], ["rigour", 3]] }
```

`"across": "mean"` instead averages each dimension across the submitted evaluations and compares the
mean. A dimension key absent from an evaluator's `dimensions` object is **missing data, not a zero**.

**Composite** — the assessment score *and* a rubric floor:

```json
{ "type": "all_of", "rules": [
  { "type": "threshold", "source": "run_score", "min": 60 },
  { "type": "rubric_minimum", "across": "mean", "dimensions": [["rigour", 3]] }
] }
```

`all_of` returns `fail` if any child fails, `indeterminate` if any child is indeterminate and none
fail, and `pass` only if all pass. `any_of` returns `pass` if any child passes, `indeterminate` if
any child is indeterminate and none pass, and `fail` only if all fail.

#### Ties and missing evaluations — the two cases that MUST be got right

| Situation | Result | What the run does |
|---|---|---|
| A required evaluator has not submitted | `indeterminate`; the reason names how many of how many are in | Stays `under_review`; appears in the `awaiting_evaluators` bucket (§8.9) |
| `majority` with equal passes and fails, `tie: "escalate"` | `indeterminate` | Stays `under_review`; appears in `blocked_indeterminate`; an admin decides with `decided_by` set |
| `majority` with equal passes and fails, `tie: "fail"` | `fail` | Terminal, but only because an administrator chose that policy in writing on that slot |
| `threshold` with a null score | `indeterminate` | Stays `under_review` |
| `rubric_minimum` where a named dimension is absent | `indeterminate` | Stays `under_review` |
| Quorum not reached | `indeterminate` | Stays `under_review` |

**MUST**: `evaluatePassRule` never returns `fail` for absent data, and the default tie behaviour is
`escalate`. REASON: automatically failing on a tie converts *an absence of agreement* into *a
rejection*, in the direction that harms the candidate, silently, at the exact moment the process was
least sure of itself.

**MUST**: a rule result of `pass` or `fail` is applied by `state.ts`, which writes
`outcome_note = 'rule:' + rule.type` alongside `decided_by`. For `kind='decision'`, and for any slot
whose `evaluator_rule` resolved to zero required evaluators, `decided_by` MUST be a real `users.id`.

---

### 8.5 `evaluator_rule` grammar and conflict of interest

`evaluator_rule` is JSONB on `tos_pipeline_stage`. Resolution happens once, on the transition into
`under_review`, and the result is **persisted**. It is not recomputed at read time.

**REASON for persisting.** `unanimous` and `majority` need a stable denominator. If the panel were
recomputed from the org graph each time the rule ran, a reorganisation mid-review would retroactively
change what "unanimous" means, and a single submitted evaluation would trivially satisfy "unanimous
over the evaluations that exist". The denominator is fixed at assignment time; any later change is an
explicit reassignment with its own record.

#### New table, introduced by this section, additive to §4

```sql
-- Who is on the panel for one stage run, how they got there, and who was excluded and why.
CREATE TABLE IF NOT EXISTS tos_stage_evaluator (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_run_id      UUID NOT NULL,
  evaluator_user_id UUID NOT NULL,
  resolved_via      TEXT NOT NULL,                     -- explicit|hiring_manager|reporting_manager|
                                                       -- department_head|org_relationship|panel_pool
  state             TEXT NOT NULL DEFAULT 'assigned',  -- assigned|excluded|declined|submitted
  is_required       BOOLEAN NOT NULL DEFAULT TRUE,
  exclusion_reason  TEXT,                              -- required when state='excluded'
  assigned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tos_stage_evaluator_uq
  ON tos_stage_evaluator (stage_run_id, evaluator_user_id);
CREATE INDEX IF NOT EXISTS tos_stage_evaluator_user_idx
  ON tos_stage_evaluator (evaluator_user_id, state);

-- Idempotent column adds, because CREATE TABLE IF NOT EXISTS is a no-op on an existing table
-- that is missing columns (§3).
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS stage_run_id      UUID;
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS evaluator_user_id UUID;
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS resolved_via      TEXT;
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS state             TEXT NOT NULL DEFAULT 'assigned';
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS is_required       BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS exclusion_reason  TEXT;
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS assigned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS notified_at       TIMESTAMPTZ;
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_stage_evaluator ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();
```

Bootstrapped by `ensureOnce('tos_stage_evaluator_v1', ...)` and mirrored into
`db/talent-os-schema.sql`. An excluded evaluator is **kept as a row**, never dropped: the audit answer
to "why was the candidate's own manager not on this panel" has to be a record, not an absence.

#### Grammar

```ts
export type EvaluatorRule =
  | { type: 'none' }
  | { type: 'explicit'; userIds: readonly string[]; minRequired?: number }
  | { type: 'hiring_manager' }
  | { type: 'reporting_manager' }
  | { type: 'department_head'; departmentId?: string }
  | { type: 'org_relationship'; relationship: 'reviewer' | 'mentor' | 'approval_owner';
      anchor: 'hiring_manager' | 'reporting_manager' }
  | { type: 'panel'; size: number; pool: readonly EvaluatorRule[] }
  | { type: 'all_of'; rules: readonly EvaluatorRule[] };
```

| Rule | Resolves through |
|---|---|
| `explicit` | The listed `users.id` values; where the list is empty, `tos_opportunity.evaluator_user_ids` |
| `hiring_manager` | `tos_opportunity.hiring_manager_user_id` |
| `reporting_manager` | `tos_opportunity.reporting_manager_user_id` — the manager of the **post**, not of the candidate |
| `department_head` | `getDepartmentHead(departmentId)` from `src/lib/org-graph.ts`, defaulting to `roles.department_id`. **TEXT, never cast to `uuid`** (§1.4) |
| `org_relationship` | `getReviewers` / `getMentorsFor` / `getApprovalOwner` in `src/lib/org-graph.ts`, anchored on the employee record of the hiring or reporting manager |
| `panel` | The union of the pool rules, truncated to `size` in resolution order **after** exclusions |
| `all_of` | The union of every child rule |

**MUST**: evaluator resolution goes through the exported `src/lib/org-graph.ts` API, never through raw
SQL on `org_relationships`, and never through `users.role`. A reviewer is a relationship, not a role
name — that is the rule `src/lib/interview-feedback.ts` already exists to hold.

**MUST**: honour the id-space trap in §1.4. `org_relationships.subject_employee_id` and
`object_employee_id` hold `hr_employees.id`; `tos_opportunity.*_user_id` and
`tos_evaluation.evaluator_user_id` hold `users.id`. Translate with `employeeIdForUser()` or through
`hr_employees.user_id`. Comparing the two id spaces directly matches nobody, silently — the worst
possible outcome for a conflict-of-interest filter.

#### Conflict of interest — the exclusion rule

An evaluator **MUST** be excluded from a stage run when any of the following holds:

| # | Condition | `exclusion_reason` |
|---|---|---|
| 1 | The evaluator's `users.id` equals the candidate's `tos_person.user_id` | `self` |
| 2 | The evaluator's account resolves, through §5.3, to the same `tos_person` as the candidate | `self_alternate_account` |
| 3 | The candidate is an internal applicant and the evaluator is the candidate's own reporting manager as of now, in the org graph | `reporting_manager_of_candidate` |
| 4 | The candidate is an internal applicant and the evaluator reports to the candidate | `reports_to_candidate` |
| 5 | An administrator has declared a conflict for this run | `declared_by_admin` |

Conditions 3 and 4 apply only where `tos_application_link.applicant_type = 'internal'` and the
candidate's `tos_identity.employee_id` is set. An external candidate has no reporting line to
conflict with.

REASON for excluding the candidate's own reporting manager outright rather than merely flagging it: an
internal transfer evaluated by the manager it takes a person away from is not an evaluation. The brief
already provides the honest place for that manager to have a say —
`tos_opportunity.requires_manager_consent` [brief §11]. Consent and evaluation are different acts and
they do not share a row.

#### How the exclusion is enforced — three layers, because one is not enough

1. **At assignment.** `assignEvaluators(stageRunId)` in `stages/evaluators.ts` is the **only** writer
   of `tos_stage_evaluator`. It resolves, dedupes on `users.id`, applies the table above, and inserts
   excluded evaluators with `state = 'excluded'` and a reason. No other module may INSERT into that
   table; a second writer is how a filter comes to be bypassed.
2. **At evaluation write.** `recordEvaluation()` re-runs conditions 1 to 4 before inserting into
   `tos_evaluation`, and refuses with a named reason if any holds. REASON: the org graph can change
   between assignment and submission — a promotion three weeks into a hiring process is ordinary.
3. **At rule evaluation.** `PassRuleInput.evaluations` is built by a loader that joins
   `tos_evaluation` to `tos_stage_evaluator` and takes only `state = 'assigned'` rows. An evaluation
   that predates an exclusion is therefore ignored by the rule while remaining visible in the audit
   trail.

```sql
-- The loader join. Excluded and declined evaluators contribute no verdict.
SELECT e.evaluator_user_id, e.verdict, e.score, e.dimensions
  FROM tos_evaluation e
  JOIN tos_stage_evaluator a
    ON a.stage_run_id = e.stage_run_id
   AND a.evaluator_user_id = e.evaluator_user_id
 WHERE e.stage_run_id = $1
   AND a.state = 'assigned';
```

**MUST**: where the surviving required-evaluator count is below what the `pass_rule` needs
(`minRequired`, `quorum`, or one for `unanimous`), the run **does not enter `under_review`**. It stays
`submitted`, an admin task is raised, and it appears in the `awaiting_evaluators` bucket (§8.9).
Proceeding with a smaller panel than the rule was written for changes the rule without anybody having
decided to.

Every exclusion is written to `audit_log` through `logAudit()` with
`action = 'talentos.evaluator.excluded'`, `entity = 'tos_stage_run'`.

---

### 8.6 The projection onto the candidate-visible funnel

`src/lib/application-stages.ts` already ships the six-step funnel a candidate sees
(`submitted, review, assessment, interview, decision, onboarded`), two closed stages
(`decision_no, withdrawn`), a `stageForStatus()` status map, and a documented defect: before
`CLOSED_STAGES` existed, a closed application kept rendering whichever open step it had last reached,
**with that step's present-tense blurb**. That defect MUST NOT be reintroduced by this build.

The seven-slot record is the internal evaluation truth. The six-step funnel is the candidate
narrative. The projection between them is a **total, deterministic function**.

#### Step A — choose the governing run

Evaluated in order. The first match wins.

| # | Condition | Result |
|---|---|---|
| A1 | `applications.status = 'withdrawn'`, or a `tos_selection` row with `decision = 'withdrawn'` | stage `withdrawn`, stop |
| A2 | Any `tos_stage_run.state = 'failed'`, or a `tos_selection` row with `decision = 'rejected'` | stage `decision_no`, stop |
| A3 | An `hr_employees` row exists for this person from this selection, i.e. `completeHire()` has run | stage `onboarded`, stop |
| A4 | The application has no `tos_stage_run` rows at all (legacy, or pre-backfill) | `stageForStatus(applications.status)`, falling back to `submitted` when that returns null; stop |
| A5 | All seven runs are satisfied and A3 did not fire | stage `decision`, stop |
| A6 | Otherwise | the governing run is the **lowest `slot_no` whose state is not in `SATISFIED_STAGE_STATES`**; go to Step B |

#### Step B — the (slot_no, state) table

The band is fixed by `slot_no`, not by `kind`.

**REASON.** The candidate funnel must be computable from the run rows alone. If the band were read
from `tos_pipeline_stage.kind`, an administrator editing a slot's kind next month would retroactively
change what a candidate was told they were doing last month, and the tracker would move with no event
having occurred. The six-step tracker is a coarse narrative band; the *precise* name of what the
candidate is doing right now is rendered separately from `tos_pipeline_stage.label` and
`candidate_blurb` on the application detail view, which is where configuration belongs.

| `slot_no` | `not_started` | `invited` | `in_progress` | `submitted` | `under_review` | `passed` | `failed` | `waived` | `skipped` |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `submitted` | `submitted` | `submitted` | `submitted` | `submitted` | *satisfied, advance* | `decision_no` | *satisfied, advance* | *satisfied, advance* |
| 2 | `review` | `review` | `review` | `review` | `review` | *advance* | `decision_no` | *advance* | *advance* |
| 3 | `assessment` | `assessment` | `assessment` | `assessment` | `assessment` | *advance* | `decision_no` | *advance* | *advance* |
| 4 | `assessment` | `assessment` | `assessment` | `assessment` | `assessment` | *advance* | `decision_no` | *advance* | *advance* |
| 5 | `interview` | `interview` | `interview` | `interview` | `interview` | *advance* | `decision_no` | *advance* | *advance* |
| 6 | `interview` | `interview` | `interview` | `interview` | `interview` | *advance* | `decision_no` | *advance* | *advance* |
| 7 | `decision` | `decision` | `decision` | `decision` | `decision` | `decision` | `decision_no` | not permitted (§8.8) | not permitted (§8.8) |

The *advance* cells are unreachable in Step B by construction, because a satisfied run is never the
governing run. They are written out anyway so the table is total over all sixty-three pairs and no
implementer has to guess. The `failed` cells are unreachable too, because A2 fires first; they are
filled with `decision_no` so that a partial implementation which skips A2 still cannot show a
present-tense blurb on a closed application.

The codomain is exactly the union of `STAGES` keys and `CLOSED_STAGES` keys. A conformance test
asserts codomain containment through `isKnownStage()` for all sixty-three pairs plus the Step-A
outcomes. REASON: `advanceStage()` refuses an unknown key and `stageIndex()` falls back to 0, so a key
outside the codomain either freezes the tracker or silently resets the candidate to "01 Submitted" on
an application that had moved on. Both failures are already on this project's record.

#### Who writes it

```ts
// src/lib/talentos/projection.ts — THE ONLY WRITER OF applications.stage IN THE TALENT OS.
import { advanceStage, isKnownStage } from '@/lib/application-stages';

/** Steps A and B. Pure, so the sixty-three pairs are testable without a database. */
export function projectCandidateStage(input: ProjectionInput): string { /* ... */ }

export async function syncCandidateStage(applicationId: string): Promise<void> {
  try {
    const input = await loadProjectionInput(applicationId);
    const key = projectCandidateStage(input);
    if (!isKnownStage(key)) {
      console.error('[talentos/projection] refused a key outside the funnel:', key);
      return;
    }
    // advanceStage(), never a direct UPDATE. It writes the history row, notifies the candidate and
    // publishes the product event; a direct UPDATE reintroduces exactly the silent-tracker defect
    // documented in src/lib/application-stages.ts. It returns changed:false when the stage is
    // already correct, so calling this after every state write sends no duplicate notification.
    await advanceStage({
      applicationId,
      toStage: key,
      actorUserId: null,
      actorName: 'Selection process',
      note: input.note || undefined,
    });
  } catch (e: any) {
    console.error('[talentos/projection] sync failed:', e?.cause?.message || e?.message);
  }
}
```

**MUST**:

- `src/lib/talentos/projection.ts` is the **only** module in the talent OS that writes
  `applications.stage`, and it does so **only** through `advanceStage()`. No
  `UPDATE applications SET stage` appears anywhere under `src/lib/talentos/`. `completeHire()` keeps
  its own existing write of `onboarded`; that is prior art, it goes through the same helper, and A3
  agrees with it.
- Every `tos_stage_run` state write, every `tos_selection` decision write and every withdrawal calls
  `syncCandidateStage()` in the same operation.
- The projection is total. There is no input for which it returns null, undefined or an empty string.
- A closed application MUST resolve to a `CLOSED_STAGES` key. A tracker left showing a present-tense
  blurb about a closed application is a conformance failure, not a cosmetic one.
- A projection failure MUST be logged with `e?.cause?.message || e?.message` and MUST NOT roll back
  the state change that prompted it.

---

### 8.7 Advisory-only detection

Proctoring signals, text-similarity signals and authorship-similarity signals land in
`tos_stage_run.advisory_flags` and are shown to a human. **A human decides.** No code path may set a
stage outcome from a detector.

#### Flag object shape

`advisory_flags` is a JSONB **array** of:

```ts
// src/lib/talentos/stages/advisory.ts
export interface AdvisoryFlag {
  /** Stable uuid, so a reviewer's acknowledgement survives the next batch of signals. */
  id: string;
  source: 'proctoring' | 'similarity' | 'authorship' | 'manual';
  /** For source='proctoring' this MUST be a key of EVENT_SEVERITY in
   *  src/lib/proctoring-integrity.ts. One vocabulary, not two. */
  signal: string;
  observedAt: string;                 // ISO 8601
  /** Review-ordering only. Never rendered as a verdict word. */
  severity: 'low' | 'medium' | 'high';
  /** A neutral description of what was measured. Never an interpretation. */
  detail: string;
  measure?: { name: string; value: number; unit?: string };
  externalRef?: string;               // attempt id, comparison run id
  reviewedByUserId?: string;
  reviewedAt?: string;
  reviewOutcome?: 'no_concern' | 'discussed_with_candidate' | 'material_to_decision';
  reviewNote?: string;
}
```

`applyAdvisoryFlags(stageRunId, flags)` appends by `id` — idempotent on webhook redelivery — and
writes **`advisory_flags` and `updated_at`, nothing else**. The module imports no state writer and
exports no state writer.

The proctoring vocabulary is reused, not reinvented: `src/lib/proctoring-integrity.ts` already carries
`EVENT_SEVERITY` with a weight, a category and a neutral label per event key, and
`src/lib/proctoring.ts` is the provider-agnostic layer. A signal key absent from `EVENT_SEVERITY` is
stored and rendered with the generic neutral phrasing below. **MUST NOT**: no provider or vendor name
appears in any candidate-visible or evaluator-visible copy.

#### The UI wording rule

**MUST**: a flag is rendered as *what was observed*, never as *what it means about the person*. Every
rendering follows one pattern:

> `<neutral observation>`. Advisory signal. A reviewer decides what, if anything, this means.

**MUST NOT** appear in any label, tooltip, notification, export header or admin column: *cheat*,
*cheated*, *cheating*, *misconduct*, *fraud*, *fraudulent*, *dishonest*, *plagiarism*, *plagiarised*,
*AI-generated*, *guilty*, *violation*, *offence*, *caught*. The list is exported as
`FORBIDDEN_ADVISORY_WORDS` so the test below can assert against the same array the reviewer relies on.

| Forbidden | Required |
|---|---|
| "Cheating detected: multiple faces" | "A second face was in frame for 41 seconds. Advisory signal. A reviewer decides what, if anything, this means." |
| "Plagiarism: 82% match" | "82 percent text overlap with one source in the comparison set. Advisory signal. A reviewer decides what, if anything, this means." |
| "AI-generated submission" | "Authorship-similarity score 0.91 on the configured detector. Detectors of this kind produce false positives. A reviewer decides what, if anything, this means." |
| "Integrity score 41 — FAIL" | "Integrity signal score 41 of 100. This summarises the signals above; it is not an outcome." |

Further rendering rules: severity is shown as a text label plus an inline monochrome SVG, never as
colour alone, and never as an emoji. A flag carrying `reviewOutcome` is shown with the reviewer's name
and note beside it, because the reviewer's judgement is the finding and the signal is not.

#### The invariant, and why it is structural

**MUST**: no automated signal may cause `tos_stage_run.state = 'failed'`.

It is enforced by construction, not by a runtime check somebody can delete:

1. `advisory.ts` has no import of `state.ts` and exports nothing that writes `state`.
2. `PassRuleInput` (§8.4) has **no advisory field**. `evaluatePassRule` is pure and receives
   `runScore`, `requiredEvaluatorIds` and `evaluations`. It cannot read a flag it is never given.
3. `setStageRunState()` accepts an actor that is either a `users.id` or `{ rule: PassRule['type'] }`,
   and there is no third form. A detector has no way to name itself as the actor.

#### The test that proves it

```ts
// src/lib/talentos/stages/stage-run.test.ts — the shim runner, not vitest: everything asserted here
// is synchronous and pure, which is the whole point of the module split.
import { describe, it, expect, report } from '../../test-shim';
import { evaluatePassRule, type PassRule, type PassRuleInput } from './rules';
import { EVENT_SEVERITY } from '../../proctoring-integrity';
import { renderAdvisoryLabel, FORBIDDEN_ADVISORY_WORDS } from './advisory';

const passing: PassRuleInput = {
  runScore: 88,
  requiredEvaluatorIds: ['u1', 'u2'],
  evaluations: [
    { evaluatorUserId: 'u1', verdict: 'pass', score: 88, dimensions: [['rigour', 5]] },
    { evaluatorUserId: 'u2', verdict: 'pass', score: 90, dimensions: [['rigour', 4]] },
  ],
};

describe('advisory signals are advisory', () => {
  it('the pass-rule input has nowhere to put a detector signal', () => {
    const keys = Object.keys(passing);
    expect(keys.indexOf('advisoryFlags')).toBe(-1);
    expect(keys.indexOf('flags')).toBe(-1);
    expect(keys.indexOf('integrityScore')).toBe(-1);
  });

  it('a run carrying every known proctoring signal still passes on merit', () => {
    // Asserted over the REAL vocabulary, so a signal key added to EVENT_SEVERITY is covered the
    // day it lands rather than the day somebody remembers to update a fixture.
    expect(Object.keys(EVENT_SEVERITY).length > 0).toBe(true);
    const rules: PassRule[] = [
      { type: 'threshold', source: 'run_score', min: 60 },
      { type: 'unanimous', among: 'required_evaluators', holdCountsAs: 'block' },
      { type: 'majority', among: 'required_evaluators', holdCountsAs: 'abstain', tie: 'escalate' },
    ];
    for (const rule of rules) {
      expect(evaluatePassRule(rule, passing).outcome).toBe('pass');
    }
  });

  it('a missing evaluation is indeterminate, never fail', () => {
    const partial: PassRuleInput = { ...passing, evaluations: [passing.evaluations[0]] };
    expect(evaluatePassRule(
      { type: 'unanimous', among: 'required_evaluators', holdCountsAs: 'block' }, partial,
    ).outcome).toBe('indeterminate');
  });

  it('a tie escalates by default, and never fails', () => {
    const tied: PassRuleInput = {
      runScore: null,
      requiredEvaluatorIds: ['u1', 'u2'],
      evaluations: [
        { evaluatorUserId: 'u1', verdict: 'pass', score: null, dimensions: [] },
        { evaluatorUserId: 'u2', verdict: 'fail', score: null, dimensions: [] },
      ],
    };
    expect(evaluatePassRule(
      { type: 'majority', among: 'required_evaluators', holdCountsAs: 'abstain', tie: 'escalate' },
      tied,
    ).outcome).toBe('indeterminate');
  });

  it('no rendered advisory label accuses anybody', () => {
    for (const key of Object.keys(EVENT_SEVERITY)) {
      const label = renderAdvisoryLabel({
        id: 'x', source: 'proctoring', signal: key,
        observedAt: '2026-08-18T00:00:00.000Z', severity: 'high',
        detail: EVENT_SEVERITY[key].label,
      }).toLowerCase();
      for (const word of FORBIDDEN_ADVISORY_WORDS) {
        expect(label.indexOf(word)).toBe(-1);
      }
      expect(label.indexOf('a reviewer decides') >= 0).toBe(true);
    }
  });
});

report();
```

The first four cases hold the invariant; the last holds the copy. §25 MUST carry both as conformance
tests and the file MUST run in the standard suite — a test nobody runs is a comment.

---

### 8.8 Waivers and skips

Two different facts that a lazy implementation would merge. Merging them destroys the audit.

| | `skipped` | `waived` |
|---|---|---|
| Means | This slot is not part of this opportunity's process | This slot **is** part of the process and a named human excused this candidate from it |
| Set by | The system, at run creation, from `tos_pipeline_stage.is_required = FALSE` or `tos_opportunity.requires_seven_stage = FALSE` | A human holding the waive capability, at any time before the run is terminal |
| `tos_override` row | Not required | **Always required** |
| `decided_by` | NULL | A `users.id`, NOT NULL |
| Satisfied for progression | Yes | Yes |
| Contributes a score | No — a `threshold` rule over it is not evaluated; the slot is simply satisfied | No |
| Shown to admins as | "Not part of this process" | "Waived by <name> on <date>", with the reason |

**MUST**: a slot that is not required is `skipped`, **not deleted**. Every candidate's audit shows
seven slots. Brief §7 permits a role to have different evaluation components while still conforming to
the framework; a seven-row record with three of them marked not-applicable **is** that conformance,
and a four-row record is not.

#### Who may waive, and under what policy

The capability check goes through `src/lib/rbac/*`. **MUST NOT** read `users.role` directly.

`tos_opportunity.waiver_policy` governs:

| Policy | Effect |
|---|---|
| `none` | Waivers are refused by the API with a named reason. The slot is completed, or the candidate does not proceed. |
| `admin_only` | Allowed. `tos_override.approval_level = 'second_signature'`; `approver_user_id` MUST be present and MUST differ from `actor_user_id`. |
| `internal_transfer` | Allowed with `approval_level = 'self'` **only** when `tos_application_link.applicant_type = 'internal'` **and** the slot `kind` is `screening` or `reference`. Every other combination falls back to `second_signature`. |

REASON for `internal_transfer` being narrow: re-screening and re-referencing a person the organisation
already employs is duplicated work that yields no new information. Waiving their assessment or their
conversation round is a different act entirely, and it is precisely the act an internal transfer
process gets accused of, so it keeps the second signature.

**MUST NOT** be waivable or skippable under any policy: slot 7, `kind = 'decision'`. `waiverAllowed()`
returns false for it unconditionally, before the policy is consulted.

Reversing a waiver — `waived` back to a live state — is itself a non-free transition and needs its own
`tos_override` row. The two rows together tell the whole story, in order.

```ts
// src/lib/talentos/stages/state.ts
export function waiverAllowed(opts: {
  slotNo: number; kind: StageKind; policy: string; applicantType: string;
}): { allowed: boolean; approvalLevel: 'self' | 'second_signature' | null; reason: string } {
  if (opts.slotNo === 7 || opts.kind === 'decision') {
    return { allowed: false, approvalLevel: null,
      reason: 'The selection decision cannot be waived. A decision nobody made is not a decision.' };
  }
  if (opts.policy === 'none') {
    return { allowed: false, approvalLevel: null,
      reason: 'This opportunity does not permit waivers.' };
  }
  const narrow = opts.policy === 'internal_transfer'
    && opts.applicantType === 'internal'
    && (opts.kind === 'screening' || opts.kind === 'reference');
  return { allowed: true, approvalLevel: narrow ? 'self' : 'second_signature', reason: '' };
}
```

Every waiver notifies the candidate through `src/lib/notify.ts`, with plain copy naming the slot and
saying it is not required of them. A candidate quietly excused and never told turns up on the wrong
day expecting an assessment.

---

### 8.9 SLA and stalled-stage reporting [brief §17]

#### How `due_at` is computed

`opened_at` is set on the **first** transition out of `not_started` — into `invited` for
candidate-facing kinds, into `under_review` for staff-only kinds. At that same moment:

```
due_at = opened_at + (tos_pipeline_stage.sla_days || ' days')::interval
```

- `sla_days IS NULL` gives `due_at IS NULL`. Such a run is reported as **"no SLA configured"** and
  **MUST NOT** be counted as on time. REASON: a missing SLA rendered green is how a stage sits for six
  weeks behind a clean board.
- **Calendar days, not business days.** This repository has no holiday calendar table, and inventing
  one would create a second calendar that drifts from the HR leave calendar. Stated as a limitation; a
  later revision MAY read the existing leave source.
- `due_at` is written **once**. A re-invitation, a resend, or a bounced notification does not move it.
  The only mutation is `extendSla(stageRunId, newDueAt, reason, actorUserId)`, which writes a
  `tos_override` row (`entity = 'tos_stage_run'`, `from_state` and `to_state` both the current state,
  reason required). REASON: an SLA you can reset by clicking "resend" is not an SLA.
- **MUST NOT** render an internal SLA date on any candidate-facing surface as a commitment. The
  candidate tracker shows the stage label and blurb from §8.6. The clock is an internal management
  measure, and promising it to a candidate creates an obligation nobody agreed to.

#### The admin board

Surface: `/admin/talent/stages`, registered in the admin section registry
(`src/lib/auth/registry.ts`) with its own `<section>.view` permission and linked from
`src/lib/admin-nav.ts`. Six buckets, each with its definition printed on the page itself:

| Bucket | Definition |
|---|---|
| `overdue` | `due_at` is in the past and the state is not terminal |
| `due_soon` | `due_at` falls within the next 48 hours and the state is not terminal |
| `stalled` | State is `invited` or `in_progress` and `updated_at` is older than 14 days, regardless of SLA |
| `awaiting_evaluators` | State is `under_review`, or held at `submitted` by §8.5, with fewer assigned required evaluators than the pass rule needs, or with required evaluations outstanding |
| `blocked_indeterminate` | The pass rule returns `indeterminate` — a tie, or a quorum not reached |
| `no_sla` | `due_at IS NULL` and the state is not terminal |

Closed applications are excluded from every bucket.

```sql
-- The board query. Buckets are computed in SQL so the page cannot disagree with the counts.
SELECT r.id, r.application_id, r.slot_no, r.kind, r.state, r.opened_at, r.due_at, r.updated_at,
       ps.label,
       COALESCE(ev.assigned, 0)  AS assigned_evaluators,
       COALESCE(ev.submitted, 0) AS submitted_evaluations,
       CASE
         WHEN r.due_at IS NULL                                THEN 'no_sla'
         WHEN r.due_at < NOW()                                THEN 'overdue'
         WHEN r.due_at < NOW() + INTERVAL '48 hours'          THEN 'due_soon'
         WHEN r.state IN ('invited','in_progress')
              AND r.updated_at < NOW() - INTERVAL '14 days'   THEN 'stalled'
         ELSE 'on_track'
       END AS bucket
  FROM tos_stage_run r
  JOIN tos_pipeline_stage ps ON ps.id = r.pipeline_stage_id
  JOIN applications a        ON a.id = r.application_id
  LEFT JOIN LATERAL (
     SELECT COUNT(*) FILTER (WHERE se.state = 'assigned' AND se.is_required) AS assigned,
            COUNT(*) FILTER (WHERE se.state = 'submitted')                   AS submitted
       FROM tos_stage_evaluator se WHERE se.stage_run_id = r.id
  ) ev ON TRUE
 WHERE r.state NOT IN ('passed','failed','waived','skipped')
   AND a.status NOT IN ('rejected','withdrawn','hired')
 ORDER BY r.due_at ASC NULLS LAST
 LIMIT 500;
```

```astro
---
// src/pages/admin/talent/stages.astro
// EVERY const IS DECLARED BEFORE THE POST HANDLER THAT USES IT. const is not hoisted, and a POST
// handler referencing a const declared below it throws on its first line while the page still
// reports success. That exact fault has shipped twice on this project.
import AdminLayout from '@/layouts/AdminLayout.astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { extendSla } from '@/lib/talentos/stages/state';

const BUCKET_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['overdue', 'Overdue'],
  ['due_soon', 'Due within 48 hours'],
  ['stalled', 'No movement in 14 days'],
  ['awaiting_evaluators', 'Waiting on evaluators'],
  ['blocked_indeterminate', 'The rule cannot decide'],
  ['no_sla', 'No SLA configured'],
  ['on_track', 'On track'],
];

let flash = '';

if (Astro.request.method === 'POST') {
  const form = await Astro.request.formData();
  const runId = String(form.get('run_id') || '');
  const until = String(form.get('until') || '');
  const reason = String(form.get('reason') || '');
  const res = await extendSla(runId, until, reason, Astro.locals.user?.id || null);
  flash = res.ok
    ? 'The due date was extended and the override was recorded.'
    : res.error || 'Nothing was changed.';
}

let rows: any[] = [];
try {
  const r = await db.execute(sql`/* the board query above */`);
  rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
} catch (e: any) {
  console.error('[admin/talent/stages]', e?.cause?.message || e?.message);
}

// Comparisons are hoisted OUT of the markup. A `<` or `<=` inside a JSX expression breaks the
// .astro compiler, so the booleans are computed here and the template only reads them.
const overdueCount = rows.filter((x) => x.bucket === 'overdue').length;
const hasOverdue = overdueCount > 0;
const labelFor = (key: string) => (BUCKET_LABELS.find((p) => p[0] === key) || [key, key])[1];
---
<AdminLayout title="Selection stages">
  {flash ? <p class="flash">{flash}</p> : null}
  {hasOverdue ? (
    <p class="alert">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none"
           stroke="currentColor" stroke-width="1.5">
        <circle cx="8" cy="8" r="6.5" /><path d="M8 4.5v4" /><path d="M8 11h.01" />
      </svg>
      <span>{overdueCount} stage runs are past their internal due date.</span>
    </p>
  ) : null}
  <table>
    <tbody>
      {rows.map((row) => (
        <tr>
          <td>{row.label}</td>
          <td>{row.state}</td>
          <td>{labelFor(String(row.bucket))}</td>
        </tr>
      ))}
    </tbody>
  </table>
</AdminLayout>
```

No emoji, no arrow characters in any JSX string, no `Record<string,string>` map inside the markup, no
`<script>` inside a conditional, and no comparison operator inside a JSX expression.

#### Metrics and nudges

- **Time in stage** = `decided_at - opened_at`, per slot, reported as a median and a 90th percentile.
  Runs with a NULL `opened_at` are excluded, and the excluded count is printed beside the figure.
- **MUST NOT** compute an SLA-compliance percentage over a population that includes runs with
  `due_at IS NULL`. Report those separately as **unmeasured**. A denominator that silently drops the
  unmeasured cases reports the health of the measurement, not of the process.
- Overdue nudges are **batched daily** through the existing job queue (`src/lib/job-handlers.ts`) and
  delivered through `src/lib/notify.ts` and `notify-audience.ts`, addressed to the assigned evaluators
  (`tos_stage_evaluator.state = 'assigned'`) and the hiring manager. Per-run notification on every
  tick is forbidden; it trains people to ignore the channel.
- A nudge **MUST NOT** change any state. It is a message about a clock, and §8.3 already forbids the
  clock from judging anybody.

---

## 9. Selection decision [brief §17, §25, §27]

### 9.1 What a `tos_selection` row is

One row records **one decision, taken once, about one person for one opportunity**. It is a record,
not a work item.

`tos_selection.decision` is `NOT NULL` and its vocabulary is exactly `selected | rejected |
waitlisted | withdrawn`. There is **no** `pending` or `draft` value and code **MUST NOT** invent one.
Work in progress lives in `tos_stage_run` (§8); the moment a `tos_selection` row exists, a named
human has committed to an answer and owes the candidate a written explanation.

**REASON.** A nullable decision column turns the selection table into a second, weaker copy of the
stage tracker, and the two drift. The candidate-visible funnel already has a decision step
(`src/lib/application-stages.ts`); nothing else needs to model *undecided*.

### 9.2 Lifecycle

| # | Transition | Writer | Preconditions | Also written in the same operation |
|---|---|---|---|---|
| 1 | *(none)* to row created with `decision` | `recordSelection()` | every `is_required` stage run for the application is terminal (`passed`, `failed`, `waived`, `skipped`), or a `tos_override` row exists for each one that is not | `application_stage_events` decision step; `audit_log` |
| 2 | `is_authorised = FALSE` to `TRUE` | `authoriseSelection()` | `decision = 'selected'`, `decision_reason` present, second signature satisfied where §9.5 requires it, offered terms complete per §9.6, `suspended_at IS NULL` | `audit_log`. Code issuance (§10.2) is a **separate** call. |
| 3 | second signature applied | `approveSelection()` | `approved_by_user_id <> decided_by_user_id` | `audit_log` |
| 4 | live to suspended | `suspendSelection()` | written reason of at least 20 characters | `is_authorised = FALSE`; every live `tos_auth_code` revoked; every live `tos_onboarding_grant` revoked; one `tos_override` row; one notification |
| 5 | superseded | `recordSelection()` again | the previous live selection is suspended, or its `decision <> 'selected'` | `tos_override` row naming the superseded `selection_ref` |

Transition 5 is enforced by the database, not by code: `tos_selection_live_uq` is unique on
`(person_id, opportunity_role_id) WHERE decision = 'selected' AND suspended_at IS NULL`. A second
live selection for the same pair raises a unique violation, which the caller surfaces as *"This
person already holds a live selection for this opportunity. Suspend it before recording a new one."*

**MUST**: any write to `decision` or `is_authorised` outside transitions 1 to 5 inserts a
`tos_override` row in the same operation (§4.8). A silent override is a defect.

### 9.3 Who may decide

Two permission keys are added to the `Permission` union in `src/lib/auth/permissions.ts`, to
`PERMS_BY_ROLE`, and to `PERMISSION_CATALOGUE` in `src/lib/auth/registry.ts`:

| Key | Group | Sensitive | Grants |
|---|---|---|---|
| `selection.decide` | Hiring | yes | Record a selection, rejection, waitlist or withdrawal, and write the offered terms. |
| `selection.authorise` | Hiring | yes | Set `is_authorised`, sign as second signature, suspend a live selection. |

Both are checked with `can(Astro.locals.user, 'selection.decide')` from
`src/lib/auth/permissions.ts`, **not** with `hasPermission()`. **REASON**, and it is the reason
already written above the People block in `registry.ts`: `can()` reads `PERMS_BY_ROLE` alone and
therefore admits exactly the roles named there, while a registry read additionally admits every
custom role holding a matching section checkbox. Widening who may authorise a person into the
organisation must not be able to arrive by somebody ticking a box on a custom role.

Two authorities are **per-row** and cannot be expressed as a role grant. They are resolved from data
at decision time and OR-ed with the capability:

```ts
const opp = await getOpportunity(roleId);            // tos_opportunity
const isHiringManager = !!user && opp?.hiring_manager_user_id === user.id;
const mayDecide = can(user, 'selection.decide') || isHiringManager;
```

**MUST NOT**, each enforced before the insert:

- `decided_by_user_id` **MUST NOT** resolve, through `tos_person.user_id`, to
  `tos_selection.person_id`. Nobody selects themselves. This is reachable in practice: internal
  transfers (§7) let a person apply inside their own department, and a department head is frequently
  the hiring manager on that opportunity.
- `approved_by_user_id` **MUST NOT** equal `decided_by_user_id`.
- The decider **MUST NOT** be the only evaluator of record. If the decider appears in
  `tos_evaluation.evaluator_user_id` for the final required stage run and no other evaluator does,
  the decision requires a second signature (§9.5).

### 9.4 `decision_reason` — required in both directions

`decision_reason` is `NOT NULL` in the DDL. In addition:

- **MUST** be at least 40 characters after `trim()`. **MUST NOT** be accepted when it equals, after
  case-folding and whitespace collapse, any string in the template list the admin composer offers. A
  template picked from a dropdown is not a written explanation.
- **MUST** be written for `rejected` and `waitlisted` exactly as carefully as for `selected`. The
  published policy at `/policy/recruitment` commits the organisation to a written explanation within
  five business days for every candidate who does not proceed, and to sharing the score regardless of
  outcome. `decision_reason` is the field that keeps that promise; there is no second place it is
  kept.
- **MUST NOT** contain individual health data, and **MUST NOT** be the place a reviewer records a
  suspicion produced by a detector. Automated proctoring flags live in
  `tos_stage_run.advisory_flags` and are advisory only (§8.7). If a flag influenced the decision, the
  human writes, in their own words, what they concluded and why. **No code path may compose a
  `decision_reason` from a detector's output, and no detector may set a decision.**
- The composer **SHOULD** show a non-blocking reminder listing terms that do not belong in a written
  decision. It is a reminder, never a block: a human decides what the reason says.

**Candidate visibility.** For `rejected` and `waitlisted`, `decision_reason` is rendered verbatim to
the candidate on `/portal/applications` and included in the decision notification. For `selected` it
is internal, and the candidate receives the offered terms of §9.6 instead. **REASON**: a selection
reason is frequently comparative ("stronger systems answer than the other two finalists"), and
comparative text about other candidates must not leave the organisation.

**Appeals.** Decisions are appealable, and the surface already exists: `/portal/appeals` and
`/admin/appeals`, backed by `application_appeals` (`appeal_kind = 'decision'`, `grounds`, `status`,
`decision_note`) with the message thread in `application_appeal_messages`. This spec adds no appeals
table.

- The appeal window is **7 days** from the decision notification, matching the published policy.
- **MUST**: the reviewer assigned to an appeal is neither `tos_selection.decided_by_user_id` nor
  `approved_by_user_id`, and does not appear in `tos_evaluation.evaluator_user_id` for any stage run
  on that application. The policy promises "a senior leader not involved in the original decision";
  those three columns are how that is checked rather than assumed.
- **Honest gap, to be named in the decision notification rather than papered over in code**:
  `application_appeals.user_id` is `NOT NULL`, so the portal route requires an account. An external
  candidate who never created one cannot file from `/portal/appeals`. The rejection notification
  **MUST** therefore name both routes — the portal, and the written route already published in the
  policy — and an administrator records an appeal that arrives in writing on the candidate's behalf.
  **MUST NOT** relax `user_id` to make the form work: that column is what stops one candidate posting
  into another's appeal.

### 9.5 The second signature

A single signature is the default. A second signature is **required** when any of the following holds
at the moment `authoriseSelection()` is called:

| Trigger | Column read | Why |
|---|---|---|
| The applicant is internal | `tos_application_link.applicant_type = 'internal'` | An internal move changes two teams and a reporting line, not one person's status. |
| Money is committed | `tos_selection.stipend_amount IS NOT NULL` | Any recurring payment leaving the organisation is signed twice. |
| The engagement is not an internship | `tos_selection.employment_type` | Longest commitment, highest cost of a wrong call. |
| The decider evaluated the final stage alone | `tos_evaluation` on the final required `tos_stage_run` | Nobody is the only scorer and the only signature. |
| A required stage was overridden | a `tos_override` row with `entity = 'tos_stage_run'` for a run of this application | The framework was set aside; two people own that. |
| A rejection contradicts a passing final stage | final required `tos_stage_run.state = 'passed'` with `decision = 'rejected'` | Here the second signature protects the candidate, not the organisation. |

**MUST**: `is_authorised` **MUST NOT** be `TRUE` while a required second signature is missing. The
predicate is evaluated server-side inside `authoriseSelection()`; a disabled button on the admin form
is a courtesy, never the control.

`tos_override.approval_level` records which level was used — `'self'`, `'second_signature'` or
`'founder'` — for any transition that bypassed its normal path.

### 9.6 Organisation-controlled fields, captured at decision time

Eight columns on `tos_selection` are written by the organisation and never by the candidate:

| Column | Type | Source |
|---|---|---|
| `offered_position_id` | UUID | `org_positions.id` |
| `offered_department_id` | **TEXT** | `departments.id`. Never cast to `::uuid` — the slug and UUID forms both exist (§1.4). |
| `offered_title` | TEXT | free text, defaulted from `roles.title` |
| `employment_type` | TEXT | the `hr_employees.employment_type` vocabulary |
| `reporting_manager_user_id` | UUID | `users.id`, defaulted from `tos_opportunity.reporting_manager_user_id`, resolvable through `src/lib/org-graph.ts` |
| `proposed_start_date` | DATE | |
| `stipend_amount` | NUMERIC(12,2) | **NULL means unpaid** |
| `stipend_currency` | TEXT | required whenever `stipend_amount` is not null |

**Why they are captured here and not at onboarding** — four reasons, heaviest first:

1. **The approver signs the terms, not just the verdict.** Captured during onboarding, title,
   department, manager, start date and stipend would be set *after* the second signature, and nobody
   would ever have signed them. That is the entire point of §9.5.
2. **`tos_onboarding.locked_fields` is a snapshot of exactly these values**, taken when onboarding is
   invited (§17). The candidate sees them as read-only facts and never types their own department,
   title, manager or stipend [brief §10, §19]. Data that must appear locked has to exist before the
   form does.
3. **Drift.** Two records of "what was offered" — one on the decision, one in the onboarding answers
   — diverge, and the divergence is discovered at payroll.
4. **Correction has a route.** A candidate who believes a locked field is wrong files a
   `tos_correction_request` (§4.6) against the field key. That is a request against a signed decision,
   which is the correct shape. An editable form field would be a silent amendment to one.

**Unpaid is stated plainly.** `stipend_amount IS NULL` means the engagement is unpaid, and every
surface that renders the terms **MUST** say so in words rather than by omitting a row:

> This internship is unpaid. No stipend is recorded for this selection.

**MUST NOT** substitute "unfunded", "for experience", "as per policy", or a blank cell. **MUST NOT**
imply that a stipend may be arranged later; if one is, it is recorded on the selection and the terms
are signed again.

None of these eight fields provisions anything. Access is derived at §14 from `tos_access_profile`,
never from `offered_title` or a department string.

### 9.7 `is_authorised` is the single source of truth

**MUST**: exactly one column decides whether a person may pass from recruitment into onboarding, and
it is `tos_selection.is_authorised`. Rung 8 of the §10.3 ladder and the §11.6 guard both read it, and
read nothing else for this purpose.

**MUST NOT** treat any of the following as authorisation, in any code path:

- `applications.status` or `applications.stage` having reached a decision value;
- an `application_stage_events` row for the decision step;
- the existence of an `offer_letters` row, or a signed one;
- the existence of a `tos_auth_code` row, or the candidate holding a code;
- an `@edurankai.in` address resolving (§5.7);
- a `tos_onboarding` row existing;
- an `invite_tokens` row.

The read, in full:

```sql
SELECT s.id, s.selection_ref, s.person_id, s.opportunity_role_id
FROM tos_selection s
WHERE s.id = $1
  AND s.decision = 'selected'
  AND s.is_authorised = TRUE
  AND s.suspended_at IS NULL;
```

```ts
// src/lib/talentos/selection.ts
export async function recordSelection(input: RecordSelectionInput): Promise<SelectionResult> {
  try {
    const r = await db.execute(sql`
      INSERT INTO tos_selection (
        selection_ref, person_id, application_id, opportunity_role_id,
        decision, decision_reason, decided_by_user_id,
        offered_position_id, offered_department_id, offered_title, employment_type,
        reporting_manager_user_id, proposed_start_date, stipend_amount, stipend_currency
      ) VALUES (
        ${ref}, ${input.personId}, ${input.applicationId}, ${input.roleId},
        ${input.decision}, ${input.reason}, ${input.decidedBy},
        ${input.positionId}, ${input.departmentId}, ${input.title}, ${input.employmentType},
        ${input.managerUserId}, ${input.startDate}, ${input.stipendAmount}, ${input.stipendCurrency}
      )
      RETURNING id, selection_ref`);
    // postgres-js returns a plain array. r.rows[0] is undefined in production.
    const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
    const row = rows[0];
    if (!row) return { ok: false, reason: 'The decision was not written. Nothing has changed.' };
    return { ok: true, id: String(row.id), selectionRef: String(row.selection_ref) };
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[talentos/selection] recordSelection failed -', e?.cause?.message || e?.message);
    return { ok: false, reason: 'The decision could not be recorded. It has not been saved.' };
  }
}
```

`input.departmentId` is bound as **text**. There is no `::uuid` anywhere in this module.

### 9.8 Suspension, and its effect on an issued code

Suspension is the only way to withdraw an authorisation. It is one operation:

| Effect | Statement |
|---|---|
| The selection stops authorising | `suspended_at = NOW()`, `suspended_reason = $reason`, `is_authorised = FALSE` |
| Every issued code dies | `UPDATE tos_auth_code SET revoked_at = NOW(), revoked_by_user_id = $actor, revoked_reason = 'selection suspended' WHERE selection_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL` |
| Every live passage dies | `UPDATE tos_onboarding_grant SET revoked_at = NOW() WHERE selection_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL` |
| The bypass is on the record | one `tos_override` row, `entity = 'tos_selection'`, written reason of at least 20 characters |
| The person is told | one notification through `src/lib/notify.ts`, naming the appeal route and window |

An in-flight onboarding is halted by the §11.6 guard on the candidate's very next request, because
that guard re-reads `is_authorised` and `suspended_at` on every request. No state value has to be
back-written to `tos_onboarding` for the halt to take effect; whether one is recorded is governed by
the state machine at §17.2.

**MUST NOT un-suspend.** There is no reverse transition and no un-revoke. Restoring a person to
onboarding is a **new** selection superseding the suspended one, and a **new** code. **REASON**:
un-revoking resurrects a credential that has been outside the organisation's control for an unknown
period, quite possibly in the inbox that is the reason it was suspended.

### 9.9 What SELECTED means, and what it does not [brief §38]

> **A Selected Candidate is not an Employee.**

| After `decision = 'selected'` and `is_authorised = TRUE`, this exists | This does **not** exist |
|---|---|
| a `tos_selection` row carrying signed terms | an `hr_employees` row |
| a `tos_auth_code` (§10) | a `tos_identity` row of any type |
| a right to open onboarding, once, for one opportunity | an `employee_code` (`ERA-EMP-0001`) |
| notifications about the onboarding step | an `@edurankai.in` mailbox |
| an appeal route | any `rbac_*` grant, admin section key, or capability token |
| | payroll, attendance, leave balance, or an `org_relationships` edge |

Identity is created at §13, from an **approved** onboarding, by calling the existing
`completeHire()` in `src/lib/hire-completion.ts`. Nothing before that point creates an employment
record.

**Copy rules** for every surface and notification that mentions a selection:

- The status word is **Selected**, followed by what happens next. Not "Hired", not "Onboarded", not
  "Joined", not "Welcome to the team".
- **MUST NOT** state or imply a start of employment, a payroll date, or a title already in use.
- **MUST NOT** describe the outcome as a credential, qualification, degree or award. EduRankAI is
  the technology platform; accredited partners award credentials.
- No emojis anywhere. Any glyph is inline monochrome SVG.
- No outside company is named. Where the recruitment channel appears, it is rendered from an
  `application_sources` row, never hardcoded into markup.

---

## 10. The selection authorization code [brief §8, §9, §26]

This is the most security-sensitive part of this specification. Every rule below is a conformance
requirement.

### 10.1 Format, and an honest entropy calculation

The brief's example is `ERAI-SEL-ONB-26-POM-7X4K9` — a readable prefix and one five-character secret
group.

**That group is the entire secret.** `ERAI-SEL-ONB` is fixed, `26` is the current year, and `POM` is
`tos_opportunity.opportunity_code`, which is visible to anyone who reads a careers page or a
selection notification. An attacker does not guess the prefix; they compose it.

Crockford base32 has 32 symbols, so each character carries exactly `log2(32) = 5` bits.

```
5 characters x 5 bits = 25 bits = 32^5 = 33,554,432 possible codes
```

What 25 bits actually buys, with `L` codes live at once and `G` guesses per hour:

| Live codes `L` | Guess rate `G` | Expected guesses to first hit (`32^5 / L`) | Expected time |
|---|---|---|---|
| 200 | 10,000 / hr (a small botnet) | 167,772 | **16.8 hours** |
| 200 | 1,000 / hr | 167,772 | 7 days |
| 50 | 100 / hr (one throttled address) | 671,089 | 279 days |

**Verdict: 25 bits is not sufficient for a bearer credential.** A hit is not a nuisance — it is one
real person's onboarding passage, carrying their signed terms and their identity data. Published
guidance for typed look-up secrets (NIST SP 800-63B) treats 64 bits as the point below which a
verifier must rate-limit; 25 bits is far below the level at which rate limiting is a *defence* rather
than a delay. Rate limiting is still required (§10.4), but it cannot be asked to carry this.

**Final format.** Keep the brief's readable structure; extend the secret from one group of five to
three groups of four.

```
ERAI-SEL-ONB-<YY>-<OPP>-<G1>-<G2>-<G3>

ERAI-SEL-ONB-26-POM-7X4K-9M2T-B3VD
```

| Part | Content |
|---|---|
| `ERAI-SEL-ONB` | fixed literal. `SEL` = selection, `ONB` = onboarding passage. |
| `<YY>` | two-digit year of issue |
| `<OPP>` | `tos_opportunity.opportunity_code`, 2 to 5 characters |
| `<G1><G2><G3>` | **12 Crockford base32 characters, 60 bits**, from a CSPRNG |

Recomputed with `L = 200` and `G = 10,000/hr`: expected guesses to first hit is
`2^60 / 200 = 5.8 x 10^15`, roughly **66 million years**. The margin absorbs a far larger live-code
population and a far larger botnet without reopening the question.

**REASON for twelve characters and not five**: the typed string grows from 25 characters to 34, in
four-character groups a person can read aloud over a phone. This credential is typed once, from an
email, on the most consequential day of that person's relationship with the organisation. Nine
characters is the correct price.

**REASON for no check character**: a Crockford check symbol would let the form say "you mistyped"
instead of "that is not the right format", but an attacker computes the check symbol as easily as we
do, so it adds no security while consuming five bits of the typeable budget. The malformed rung
(§10.3, rung 1) already carries the mistyping message.

**Column mapping** — the format lands exactly on the §4.5 columns:

| Column | Value for the example |
|---|---|
| `code_display_prefix` | `ERAI-SEL-ONB-26-POM` |
| `code_last4` | `B3VD` (the final group) |
| `code_hash` | the keyed hash of the normalised full string (§10.2) |

**Opportunity code constraint.** `tos_opportunity.opportunity_code` **MUST** be 2 to 5 characters
from the Crockford alphabet after normalisation. Two opportunity codes that normalise to the same
string (`POM` and `P0M`) would make two prefixes indistinguishable. Additive DDL, idempotent, under
`ensureOnce('tos_opportunity_code_norm_v1', ...)`:

```sql
-- upper() and translate() are IMMUTABLE, so this is indexable; the same property is what lets
-- §4.1 index lower(primary_email).
CREATE UNIQUE INDEX IF NOT EXISTS tos_opportunity_code_norm_uq
  ON tos_opportunity (upper(translate(opportunity_code, 'oilucOILU', '011V011V')));
```

**Normalisation.** One function, used at generation and at every validation, with no second
implementation anywhere in the tree:

```ts
// src/lib/talentos/codes.ts  (the format half; the sequence codes live in the same module)
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // no I, L, O, U

/**
 * Uppercase, drop every separator, then fold the four look-alike characters onto the symbols they
 * are mistaken for: I and L become 1, O becomes 0, U becomes V. None of the four is in the encoding
 * alphabet, so no fold can collide with a character a real code actually contains.
 */
export function normaliseAuthCode(input: string): string {
  let s = String(input || '').normalize('NFKC').toUpperCase();
  s = s.replace(/[^A-Z0-9]/g, '');    // hyphens, spaces, en and em dashes, zero-width joiners
  s = s.replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
  return s;
}

// THE NORMALISED PREFIX IS DERIVED, NEVER TYPED. Writing it by hand is a trap that has already
// been sprung twice while this document was being written, both times producing "ERA1SEL0NB".
// That is wrong: the fold maps I and L to 1, so SEL becomes SE1 and the real normalised prefix is
// ERA1SE10NB. A hardcoded literal would have rejected every genuine code, and the only symptom
// would have been candidates being told, on the most consequential day of their relationship with
// the organisation, that their real code was not recognised. A unit test caught it here; nothing
// else would have until a real candidate hit it.
//
// MUST: derive it. The fold and the prefix must never be able to drift apart.
const NORMALISED_PREFIX = normaliseAuthCode(AUTH_CODE_PREFIX);   // 'ERA1SE10NB'
const C = '[0-9A-HJKMNP-TV-Z]';
export const NORMALISED_RE = new RegExp('^' + NORMALISED_PREFIX + '[0-9]{2}' + C + '{2,5}' + C + '{12}$');

export function isWellFormed(normalised: string): boolean {
  const n = normalised.length;
  return n >= 26 && n <= 29 && NORMALISED_RE.test(normalised);
}
```

**MUST**: the validator **never parses the code into parts** before lookup. It normalises the whole
string and hashes the whole string. **REASON**: splitting off `<OPP>` to look the opportunity up
first would tell an attacker which opportunity codes exist — the refusal would arrive at a different
rung, at a different speed, for a real prefix than for an invented one — and it would make the
malformed check depend on database state. The opportunity-mismatch rung (§10.3, rung 7) still works,
because it compares the **stored** `opportunity_role_id` on the matched row against the opportunity
the redemption endpoint was scoped to.

### 10.2 Generation, storage, display, re-issue

**Random source.** `randomBytes` from `node:crypto`. Never `Math.random`, never a timestamp, never a
counter, never anything derived from `selection_ref` or `person_code`.

```ts
import { randomBytes, createHmac } from 'node:crypto';
import { CROCKFORD_ALPHABET } from '@/lib/talentos/codes';

/** 12 characters, 60 bits, uniform. */
function mintSecret(): string {
  const out: string[] = [];
  while (out.length < 12) {
    for (const b of randomBytes(24)) {
      if (out.length >= 12) break;
      // 256 is an exact multiple of 32, so masking the low five bits is bias-free. A modulo against
      // a non-power-of-two alphabet would not be, and the bias would be silent.
      out.push(CROCKFORD[b & 31]);
    }
  }
  return out.join('');
}
```

**The stored hash.** `code_hash` is a **keyed** hash — `HMAC-SHA256(TOS_CODE_PEPPER, normalised)`,
hex — not a bare digest. It is still a 64-character hex string, so the `NOT NULL UNIQUE` column in
§4.5 is unchanged.

```ts
export function hashAuthCode(normalised: string): string {
  const pepper = process.env.TOS_CODE_PEPPER || '';
  // FAILS CLOSED. A silent fallback to an unkeyed digest would leave half the table unverifiable
  // against the other half, and nothing on any screen would say which half a row was in.
  if (pepper.length < 32) throw new Error('TOS_CODE_PEPPER is not configured');
  return createHmac('sha256', pepper).update(normalised).digest('hex');
}
```

**REASON for a pepper rather than a plain digest.** Sixty bits of uniform entropy makes an *online*
attack hopeless, but a leaked `code_hash` column is an *offline* problem: 2^60 SHA-256 evaluations is
within reach of well-resourced hardware in days, and these codes live for 21 days by default. A
server-side key that never enters the database removes that path entirely. **REASON for HMAC rather
than a password KDF**: the secret is uniformly random, so a work factor buys nothing that entropy has
not already bought, and the redemption path has to stay cheap enough to run under a rate limiter.
**Consequence, stated plainly**: rotating `TOS_CODE_PEPPER` invalidates every live code. Rotation is
therefore a deliberate operation paired with revoke-and-reissue, never a routine secret roll. The
value is set by the founder in the deployment environment; this specification does not read or write
any `.env` file.

**MUST NOT**: store the plaintext code in any column, cache, log line, `audit_log.diff`, error
message, notification record, or analytics event. The plaintext exists in exactly two places — the
response that renders it once, and the outbound email — and is persisted in neither.

**Displayed once.** Immediately after issue the admin surface renders the full plaintext in a
copy-once panel carrying the warning *"This code will not be shown again. If it is lost, revoke it
and issue a new one."* A refresh does not bring it back, because there is nothing to bring back.

**Emailed.** The plaintext goes to `tos_auth_code.delivered_to_email` (§10.7) through
`src/lib/notify.ts`. The message names the opportunity, the expiry date, and states that the code
authorises onboarding and nothing else (§10.5). Where `tos_selection.stipend_amount IS NULL` it
states that the engagement is unpaid, in the words of §9.6. No emojis; any glyph is inline
monochrome SVG; no outside company is named.

**What an admin sees afterwards.**

| Visible | Not visible, to anyone, ever |
|---|---|
| `code_display_prefix` + a separator + `code_last4` | the plaintext code |
| `issued_at`, `expires_at`, `use_count` of `max_uses` | the full `code_hash` |
| `delivered_at`, `delivered_to_email` | |
| `revoked_at`, `revoked_reason`, `consumed_at` | |
| the first 12 hex characters of `code_hash`, for correlating with the abuse board | |

**Expiry.** `expires_at = issued_at + tos_opportunity.code_validity_days` days, default 21.

**Multi-use.** `max_uses` defaults to 1. Where `tos_opportunity.code_multi_use` is true, `max_uses`
**MAY** be raised to at most **3**, and no higher. **REASON**: the legitimate need is a person who
starts onboarding on a phone and finishes on a laptop after the two-hour grant (§11.3) has lapsed.
Three covers that plus one mistake; an unbounded value is a shared password.

**Re-issue is revoke plus issue. Never mutate.** In one transaction:

```sql
UPDATE tos_auth_code
   SET revoked_at = NOW(), revoked_by_user_id = $actor, revoked_reason = $reason
 WHERE selection_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL;

INSERT INTO tos_auth_code (code_hash, code_display_prefix, code_last4, selection_id, person_id,
                           opportunity_role_id, issued_by_user_id, expires_at, max_uses,
                           delivered_to_email)
VALUES (...) RETURNING id;

UPDATE tos_auth_code SET superseded_by_id = $newId WHERE id = $oldId;
```

Every live `tos_onboarding_grant` for that selection is revoked in the same transaction (§11.2).
**REASON for never mutating in place**: changing `code_hash` on an existing row destroys the record
that the previous code ever existed, which is the only way to answer "what was in that person's inbox
last week" after an incident.

### 10.3 The validation ladder [brief §26]

`redeemAuthCode()` in `src/lib/talentos/redeem.ts` runs these rungs **in this order** and stops at
the first failure. The machine result code is written to `tos_code_attempt.outcome`. The audit action
is written with `logAudit({ userId, action, entity: 'tos_auth_code', entityId, ipAddress })`.

Two messages are defined once and reused:

```ts
export const MSG_MALFORMED =
  'That code is not in the right format. Check for a missing group and enter it exactly as it appears in your message.';

export const MSG_GENERIC =
  'If that code is valid, a confirmation message has been sent to the address it was issued to. Open that message to continue.';
```

| # | Check | Result code | Shown to an unauthenticated requester | Shown to the signed-in **bound person** | Audit action |
|---|---|---|---|---|---|
| 1 | `isWellFormed(normalised)` is false | `malformed` | `MSG_MALFORMED` | `MSG_MALFORMED` | `tos.code.redeem.malformed` |
| 2 | no `tos_auth_code` row for `hashAuthCode(normalised)` | `not_found` | `MSG_GENERIC` | `MSG_GENERIC` | `tos.code.redeem.not_found` |
| 3 | `revoked_at IS NOT NULL` | `revoked` | `MSG_GENERIC` | "This code was withdrawn on {date}. Reason on file: {revoked_reason}. Contact the selection team for a replacement." | `tos.code.redeem.revoked` |
| 4 | `expires_at < NOW()` | `expired` | `MSG_GENERIC` | "This code expired on {date}. Request a replacement and one will be issued to this address." | `tos.code.redeem.expired` |
| 5 | `use_count >= max_uses`, or `consumed_at IS NOT NULL` | `exhausted` | `MSG_GENERIC` | "This code has already been used. If you did not finish onboarding, request a replacement." | `tos.code.redeem.exhausted` |
| 6 | the proven person (§10.6) is not `tos_auth_code.person_id` | `person_mismatch` | `MSG_GENERIC` | not reachable — a mismatch means the requester is not the bound person | `tos.code.redeem.person_mismatch` |
| 7 | `tos_auth_code.opportunity_role_id` is not the endpoint's opportunity | `opportunity_mismatch` | `MSG_GENERIC` | "This code is for a different opportunity. Open the link in your message rather than this page." | `tos.code.redeem.opportunity_mismatch` |
| 8 | `tos_selection.is_authorised` is not `TRUE` (§9.7) | `not_authorised` | `MSG_GENERIC` | "Your selection is not authorised for onboarding yet. You will be notified when it is." | `tos.code.redeem.not_authorised` |
| 9 | `tos_selection.suspended_at IS NOT NULL` | `suspended` | `MSG_GENERIC` | "Your selection is on hold. Reason on file: {suspended_reason}. You may appeal within 7 days." | `tos.code.redeem.suspended` |
| 10 | `roles.is_open` is false, or `tos_opportunity.closes_at < NOW()`, or `applications_open` is false **and** the selection postdates closure | `opportunity_closed` | `MSG_GENERIC` | "This opportunity has closed. Contact the selection team before continuing." | `tos.code.redeem.opportunity_closed` |
| 11 | the applicant is internal (`tos_application_link.applicant_type = 'internal'`) and the bound `tos_identity.status <> 'active'`, or the signed-in `users.is_active` is false | `identity_inactive` | `MSG_GENERIC` | "Your organizational identity is not active, so this passage cannot open. Contact the People team." | `tos.code.redeem.identity_inactive` |
| — | every rung passed | `ok` | `MSG_GENERIC`, then §10.6 path B | proceeds directly to §11 | `tos.code.redeem.ok` |

**MUST**: `use_count` is **not** incremented and `consumed_at` is **not** set unless every rung
passes *and* the §10.6 identity proof passes. Consuming on failure would let anyone who guesses or
intercepts a code burn it, converting a read-only attack into a denial of service against the one
person who needs it.

**MUST**: rung 10 is deliberately narrow. A closed posting **MUST NOT** invalidate a selection that
was authorised while it was open; withdrawing an authorised selection is suspension (§9.8).

#### The enumeration oracle

An attacker guessing codes **MUST NOT** learn that a code exists.

**The rule**: for any requester who has not been proven to be the bound person, rungs **2 through 11,
and success**, are indistinguishable. Concretely, all of them:

- return `MSG_GENERIC`, byte for byte;
- return the **same HTTP status** — `200` with a rendered refusal. A `404` for `not_found` and a
  `403` for `revoked` is an oracle written in status codes;
- render the same page, with no differing field, header, cookie, redirect or `Set-Cookie`;
- are padded to a fixed floor of **400 ms** of wall-clock time measured from request entry, so the
  extra queries rungs 8 to 11 perform are not observable.

Rung 1 **MAY** differ, and does. **REASON**: well-formedness is computable offline from the published
format, so telling somebody their input is malformed reveals nothing an attacker could not work out
without asking. It is also the message a real person mistyping a code most needs.

Rung 6's position is why the ladder is ordered as it is: a signed-in attacker who guesses a
stranger's valid code lands on `person_mismatch`, which sits inside the generic band, so a valid code
and an invented one remain indistinguishable to them.

**MUST NOT** vary the response on the number of remaining attempts, on whether the address on file is
known, or on whether an account exists for it.

### 10.4 Rate limiting and abuse

Buckets are counted from `tos_code_attempt`, which is written for **every** attempt including
malformed and rate-limited ones, before the response is composed. The two indexes the counters need
are already declared in §4.5.

| Bucket | Limit | Window | On exceeding |
|---|---|---|---|
| per IP | 10 failed attempts | 60 minutes | refuse for the rest of the window, outcome `rate_limited` |
| per IP | 40 failed attempts | 24 hours | refuse for the rest of the window |
| per `code_hash` | 5 failed attempts | 60 minutes | that hash is locked for 60 minutes |
| per authenticated person | 15 failed attempts | 24 hours | refuse. **MUST NOT** affect that person's sign-in. |
| global | 200 failed attempts | 60 minutes | raise a sweep alert on the abuse board |

```sql
SELECT
  COUNT(*) FILTER (WHERE ip_address = $1 AND created_at > NOW() - INTERVAL '60 minutes') AS ip_hour,
  COUNT(*) FILTER (WHERE ip_address = $1 AND created_at > NOW() - INTERVAL '24 hours')   AS ip_day,
  COUNT(*) FILTER (WHERE code_hash  = $2 AND created_at > NOW() - INTERVAL '60 minutes') AS code_hour
FROM tos_code_attempt
WHERE created_at > NOW() - INTERVAL '24 hours'
  AND outcome <> 'ok'
  AND (ip_address = $1 OR code_hash = $2);
```

```ts
const r = await db.execute(q);
const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
const b = rows[0] || { ip_hour: 0, ip_day: 0, code_hour: 0 };
```

**Fails closed.** If the counts cannot be read, the redemption is refused. **REASON**, and it is the
one already written into `src/lib/auth/recovery.ts`: redemption is a once-in-a-relationship path, so
refusing for the minutes a database hiccup lasts costs a support message, while the other direction
costs an unlimited guessing window against a bearer credential.

**Success clears the IP and code buckets**, so somebody who fumbles their code four times and then
gets it right is not still throttled an hour later.

**The per-code lock cannot be weaponised.** The bucket key is the hash of the *submitted* code, so
only a requester who already possesses that exact code can fill its bucket. An attacker cannot lock
out a code they do not have, and a lucky guesser who does have it is precisely who the lock is aimed
at.

**Locking never touches `tos_auth_code`.** A locked code is not revoked, not expired and not
consumed. **REASON**: an attacker must not be able to destroy a legitimate person's credential by
guessing at it. The holder waits out the 60-minute window, or a named admin clears the lock from the
abuse board, audited as `tos.code.lock.cleared`.

**A rate limit is scoped to redemption and to nothing else.** It **MUST NOT** block sign-in, the
portal, an application, or an appeal.

**Retention.** `tos_code_attempt` rows older than 180 days are deleted by a job registered with the
existing queue in `src/lib/job-queue.ts`. **MUST NOT** store the plaintext code, the raw typed input,
or any truncation of either in this table; only `code_hash` and the outcome.

**The abuse board** lives at `/admin/talent/codes`, registered as admin section `talent_codes` and
gated on `talent_codes.view`. Over a window defaulting to 30 days it shows:

- an outcome histogram across the eleven result codes plus `rate_limited` and `ok`;
- a sweep banner when the global threshold has tripped, naming the window and the count;
- top source addresses **displayed truncated** — IPv4 to /24, IPv6 to /64 — while the full value
  stays in the column for an incident;
- currently locked codes, identified as `code_display_prefix` plus `code_last4`, with a one-click,
  audited "clear lock";
- per-code attempt counts for the codes belonging to a named selection, reached by searching
  `selection_ref` or `person_code`.

**MUST NOT** on this board: render any code plaintext; render a full `code_hash`; offer a
hash-prefix search, which would let an administrator walk the live-code space; or join to
`hr_employees` for any field, and specifically not `blood_group` or `date_of_birth`. Nothing on this
screen is a person's record — it is a traffic screen, and it stays one.

### 10.5 A code is not permission [brief §9]

Redeeming a valid code grants **exactly one thing**:

> Passage from recruitment into onboarding, for **one** opportunity, as **one** person, for the
> lifetime of the grant issued at §11.

It grants nothing else. Redemption does not create, imply, or authorise:

1. a `users` account, or a sign-in of any kind;
2. an `@edurankai.in` mailbox, or any `tos_person_email` marked `is_official`;
3. a `tos_identity` row of any type, active or pending;
4. an `hr_employees` row, or an `employee_code`;
5. any `rbac_roles` membership, `rbac_permission_grants` row, or capability token;
6. any `role_permissions` section key, or any reach into `/admin`;
7. a position, a team, a department assignment, or any `org_relationships` edge;
8. employment, a stipend, payroll, attendance, or leave;
9. access to a second opportunity's onboarding — the code is bound to `opportunity_role_id`;
10. the right to reopen onboarding once it has been submitted;
11. the right to see anyone else's application, evaluation, selection, or onboarding;
12. the right to change any field in `tos_onboarding.locked_fields`; a disagreement is a
    `tos_correction_request` (§9.6).

**MUST**: no code path anywhere calls into `src/lib/rbac/*` or `src/lib/auth/registry.ts` to *write*
a grant as a consequence of redemption. Provisioning happens once, at §14, from an approved
onboarding and a `tos_access_profile`.

### 10.6 Defence in depth: prove the redeemer is the bound person

**MUST**: holding the code is never sufficient. Every redemption additionally proves the requester is
the person the code was issued to, by one of exactly two paths.

**Path A — authenticated session.**

```
Astro.locals.user  (set by middleware from the session cookie)
  -> users.id, users.is_active = TRUE
  -> tos_person WHERE user_id = users.id AND merged_into_id IS NULL
       (where merged, follow merged_into_id to the surviving row - §5.5)
  -> that tos_person.id MUST equal tos_auth_code.person_id
```

A match proves the bound person and the redemption proceeds immediately; no email is sent. A mismatch
is rung 6. No session at all falls through to path B.

**Path B — one-time challenge to the bound address.**

1. The challenge is sent **only** to `tos_auth_code.delivered_to_email`, the address recorded when
   the code was issued. **MUST**: the redemption form has **no email field**. An address the
   requester types is an address the requester chose, which would make the second factor a formality.
   **REASON for binding at issue rather than reading `tos_person.primary_email` at redemption**: a
   later change of primary address would otherwise redirect a live code.
2. The challenge is a 32-byte `randomBytes` value, base64url, delivered as a link. Only its SHA-256
   is stored, in `tos_code_challenge.challenge_hash` (§10.7). TTL **15 minutes**, single use, at most
   five verification attempts.
3. **The challenge is sent only when rungs 1 to 11 pass — but the response is identical either way.**
   An unauthenticated requester always sees `MSG_GENERIC`, whether the code was valid, invalid,
   expired or revoked. This is what keeps §10.3's oracle rule intact through this path.
4. At most **three challenge sends per code per 24 hours**, so a person whose code has been guessed
   is not mail-bombed.
5. The challenge email is a **tripwire as well as a factor**. It states that somebody entered this
   authorization code, gives the date, time and truncated source address, and offers a "this was not
   me" link that files an abuse report visible on the §10.4 board and notifies the selection team.
   **MUST NOT** let that link suspend the selection automatically: suspension is a human decision
   under §9.8, with a written reason.
6. Following the link re-runs the **entire** ladder from rung 1 against current state, then consumes
   the code and issues the §11 grant. Fifteen minutes is long enough for a selection to be suspended.

**MUST NOT** accept as proof: possession of the code alone; a matching name; a matching phone number;
an `@edurankai.in` sender domain (§5.7); a referrer header; or a value echoed back from a hidden form
field.

### 10.7 Additive DDL for §10

Idempotent, under `ensureOnce('tos_auth_code_v2', ...)` and `ensureOnce('tos_code_challenge_v1', ...)`,
mirrored into `db/talent-os-schema.sql` beside §4.5.

```sql
-- The address the plaintext code was actually delivered to, frozen at issue. §10.6 path B sends the
-- challenge here and nowhere else, so a later change of primary_email cannot redirect a live code.
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS delivered_to_email TEXT;

-- Re-issue is revoke plus issue (§10.2). This makes the chain queryable without parsing
-- revoked_reason, so an admin screen shows "replaced by" instead of a dead end.
ALTER TABLE tos_auth_code ADD COLUMN IF NOT EXISTS superseded_by_id UUID;

CREATE TABLE IF NOT EXISTS tos_code_challenge (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_code_id    UUID NOT NULL,
  person_id       UUID NOT NULL,
  sent_to_email   TEXT NOT NULL,          -- copied from tos_auth_code.delivered_to_email
  challenge_hash  TEXT NOT NULL UNIQUE,   -- sha256 of a 32-byte base64url token. Never plaintext.
  expires_at      TIMESTAMPTZ NOT NULL,   -- created_at + 15 minutes
  consumed_at     TIMESTAMPTZ,
  attempt_count   INT NOT NULL DEFAULT 0,
  ip_address      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tos_code_challenge_code_idx
  ON tos_code_challenge (auth_code_id, created_at DESC);
```

---

## 11. The onboarding grant [brief §29]

### 11.1 Why a server-side row, and not a flag

**MUST**: the browser never carries "this person is selected". `tos_onboarding_grant` is the only
statement that a request may reach an onboarding surface.

| Alternative | Why it is rejected |
|---|---|
| A cookie or `localStorage` flag such as `isSelected=1` | It is a claim made by the least trustworthy participant, editable by anyone with a developer console. |
| A signed JWT carrying the selection id | It cannot be revoked inside its own lifetime, which defeats §9.8 outright: a suspended person would keep onboarding until the token expired. |
| A query parameter carrying the selection id | Shareable, guessable if ids leak, and it travels in referrer headers and browser history. |
| Re-checking `is_authorised` with no grant at all | Correct but insufficient: it would let anybody who *is* authorised open onboarding without ever redeeming a code, which erases §10 entirely. |

The grant row states one narrow fact: **this browser session proved, once, at a recorded time and
from a recorded address, that it held a valid authorization code for this selection.** Everything the
grant permits is re-derived from live tables on every request (§11.5).

### 11.2 Issue, present, consume

**ISSUE** — one transaction, at the moment the §10.3 ladder and the §10.6 identity proof have both
passed:

```sql
UPDATE tos_onboarding_grant
   SET revoked_at = NOW()
 WHERE selection_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL;

UPDATE tos_auth_code
   SET use_count = use_count + 1,
       consumed_at = CASE WHEN use_count + 1 >= max_uses THEN NOW() ELSE consumed_at END
 WHERE id = $codeId;

INSERT INTO tos_onboarding_grant
  (grant_token_hash, selection_id, person_id, opportunity_role_id, auth_code_id, expires_at, ip_address)
VALUES ($hash, $1, $personId, $roleId, $codeId, NOW() + INTERVAL '2 hours', $ip)
RETURNING id;
```

The raw token is 32 `randomBytes`, base64url. It is returned to the browser as a cookie and **never**
in a URL:

| Cookie attribute | Value | Reason |
|---|---|---|
| name | `tos_onb` | |
| `HttpOnly` | yes | script on the page has no business reading it |
| `Secure` | yes | |
| `SameSite` | `Lax` | the email link is a top-level navigation, and `Strict` would drop the cookie on arrival |
| `Path` | `/onboarding` | it never travels to `/admin`, to `/api/v1/*`, or to any other route |
| `Max-Age` | 7200 | matched to `expires_at`. The server clock still decides. |

**REASON for a cookie rather than a URL token**: a URL leaks through referrer headers, browser
history, screenshots, and the "send me that link" instinct of somebody stuck on a form.

**PRESENT** — every onboarding page load and every onboarding API call sends the cookie. The guard
(§11.6) hashes it and looks the row up on the `grant_token_hash` unique index.

**CONSUME** — `consumed_at` is set when the onboarding record reaches its submitted state (the
transition itself is governed by §17.2), or when a new grant supersedes it, or at suspension (§9.8).

**Single-use semantics, stated precisely.** One redemption yields **exactly one** grant; **at most
one live grant exists per selection** at any instant; a grant that is consumed or revoked is
**never** re-animated; and a token is never re-issued, only replaced. Additive DDL, under
`ensureOnce('tos_onboarding_grant_v2', ...)`:

```sql
-- At most one live passage per selection. Expiry is deliberately NOT in the predicate: NOW() is not
-- immutable and cannot appear in an index. Expiry is checked in the guard's WHERE clause instead.
CREATE UNIQUE INDEX IF NOT EXISTS tos_onboarding_grant_live_uq
  ON tos_onboarding_grant (selection_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS tos_onboarding_grant_person_idx
  ON tos_onboarding_grant (person_id, issued_at DESC);
```

**Per-request rotation was considered and rejected.** Minting a fresh token on every successful guard
check would make each token literally single-use and would catch a stolen cookie on its second use.
It also races: one onboarding page issues several parallel requests, so a double-click or a slow save
would make a legitimate candidate look like a replay attacker and lock them out of their own form
half way through. Over a two-hour window already bound to one selection and revocable in one
statement, that false positive costs more than the detection is worth. **Replay of a consumed or
revoked token is still treated as hostile**: the guard revokes every live grant for that
`selection_id`, records `logAudit({ action: 'tos.grant.replay', entity: 'tos_onboarding_grant',
entityId })`, and refuses.

### 11.3 The two-hour expiry, and its reason

`expires_at = issued_at + 2 hours`, absolute.

- **Long enough** for a real sitting. The form carries the locked organisational fields, roughly
  twenty candidate-owned fields, and a set of document links that have to be created and
  access-checked before they can be pasted. Documents of any kind are submitted as **verified Drive
  links with "Anyone with the link" access**, through the existing `src/lib/hr-onboarding.ts` model,
  and are never uploaded; the only stored binary anywhere in this flow is the small photo, a 320px
  JPEG captured live or uploaded. Gathering those links on a phone is not a five-minute job.
- **Short enough** that a shared laptop, a family device, or a campus machine left unattended does
  not carry an open onboarding passage into the next person's session.
- **MUST NOT slide.** Activity does not extend the window. **REASON**: an absolute deadline is
  auditable — "this passage was open from 14:02 to 16:02" is a fact a reviewer can check — while a
  sliding one has no deadline to state at all. The cost that usually justifies sliding is removed by
  the next rule.
- **Expiry never loses work.** `tos_onboarding.answers` is server-side and saved as the candidate
  progresses; document links live in `hr_onboarding_documents`. When a grant lapses, only the
  *passage* has to be earned again — by redeeming once more where `max_uses` allows, or by asking for
  a re-issue. The refusal screen **MUST** say so in words: *"Your answers are saved. Only this
  session has timed out."* **REASON this is a conformance requirement, not a nicety**: a flow that
  appears to discard an hour of typing is exactly what makes an engineer write a flag into
  `localStorage`, and §11.1 is the rule that flag would break.

### 11.4 Why the token is hashed

`grant_token_hash` stores `sha256(raw)`, hex. The raw token exists only in the cookie.

- **The database is not the trust boundary it looks like.** Backups, a read replica, a support query,
  a CSV export and an over-broad admin screen all see this column. A plaintext grant token sitting in
  a table is a live session key in the open.
- **SHA-256 without a KDF is correct here**, unlike §10.2: the token is 32 uniformly random bytes, so
  there is no search space to slow down and nothing a work factor would buy.
- **No comparison happens in application code.** Lookup is an equality match on the `UNIQUE` index,
  so there is no timing side channel to defend. If any future code path compares two token values in
  memory it **MUST** use `timingSafeEqual` from `node:crypto`.
- **MUST NOT** log the raw token, or place it in a URL, a redirect target, an error message, a
  notification, or an `audit_log.diff`. Audit rows reference the grant by `id`.

### 11.5 What every request re-verifies

**The grant is a convenience, never the authority.** It removes the need to re-prove possession of
the code on every click. It proves nothing about the current state of the selection, so the guard
re-reads live tables on **every** request, page and API alike:

| Re-checked on every request | Source |
|---|---|
| a grant row exists for the presented hash | `tos_onboarding_grant.grant_token_hash` |
| `consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()` | the same row |
| the selection is still a selection | `tos_selection.decision = 'selected'` |
| the selection still authorises | `tos_selection.is_authorised = TRUE` (§9.7) |
| the selection is not on hold | `tos_selection.suspended_at IS NULL` |
| the person is the surviving record | `tos_person.merged_into_id IS NULL`, or follow the pointer (§5.5) |
| an internal applicant's identity is still active | `tos_identity.status = 'active'` |
| the onboarding record still admits writes | `tos_onboarding.state`, per the §17.2 vocabulary |
| the acting session, where one exists, is the same person | session to `tos_person.id` equals `grant.person_id`; a different person on the same browser **revokes** the grant |

**Deliberately NOT re-checked:**

- **`tos_opportunity.applications_open`, `closes_at`, and `roles.is_open`.** Closing a posting is a
  recruitment action and **MUST NOT** strand an already-authorised person half way through
  onboarding. Withdrawing an authorised selection is suspension (§9.8), which the guard *does* check
  on every request. Rung 10 of §10.3 applies these at redemption, which is the right moment for them.
- **A changed IP address.** `ip_address` is recorded at issue and any change is shown on the admin
  timeline, but it **MUST NOT** be grounds for refusal: mobile networks rotate addresses constantly,
  and refusing would break onboarding on exactly the devices most candidates use.
- **RBAC.** No capability is consulted to permit onboarding, because redemption created none (§10.5).
  A guard that fell back to an RBAC check would silently let staff walk into other people's
  onboarding.

### 11.6 The guard

Every onboarding route and every onboarding API endpoint calls this one function. There is no second
implementation and no inline variant.

```ts
// src/lib/talentos/onboarding-guard.ts
import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { onboardingAcceptsWrites } from '@/lib/talentos/onboarding-state';  // §17.2 owns the vocabulary

export type GrantGate =
  | { ok: true; grantId: string; selectionId: string; personId: string;
      roleId: string; onboardingId: string; writable: boolean }
  | { ok: false; code: 'no_cookie' | 'not_found' | 'replay' | 'expired' | 'not_authorised'
              | 'suspended' | 'identity_inactive' | 'wrong_person' | 'error';
      message: string };

const GRANT_COOKIE = 'tos_onb';
const REFUSED =
  'This onboarding session is no longer open. Your answers are saved. Only this session has timed out.';

export async function requireOnboardingGrant(ctx: {
  cookies: { get(name: string): { value: string } | undefined };
  locals: any;
  request: Request;
}): Promise<GrantGate> {
  const raw = ctx.cookies.get(GRANT_COOKIE)?.value || '';
  if (!raw) return { ok: false, code: 'no_cookie', message: REFUSED };
  const hash = createHash('sha256').update(raw).digest('hex');

  try {
    // ONE statement. Every live fact the guard needs, read now. Nothing here trusts the cookie for
    // anything beyond finding the row.
    const r = await db.execute(sql`
      SELECT g.id            AS grant_id,
             g.selection_id, g.person_id, g.opportunity_role_id,
             g.consumed_at, g.revoked_at,
             (g.expires_at > NOW())      AS live,
             s.decision, s.is_authorised, s.suspended_at,
             p.merged_into_id,
             p.user_id                   AS person_user_id,
             o.id                        AS onboarding_id,
             o.state                     AS onboarding_state,
             al.applicant_type,
             i.status                    AS identity_status
        FROM tos_onboarding_grant g
        JOIN tos_selection        s  ON s.id = g.selection_id
        JOIN tos_person           p  ON p.id = g.person_id
        LEFT JOIN tos_onboarding  o  ON o.selection_id = g.selection_id
        LEFT JOIN tos_application_link al ON al.application_id = s.application_id
        LEFT JOIN tos_identity    i  ON i.id = al.applicant_identity_id
       WHERE g.grant_token_hash = ${hash}
       LIMIT 1`);

    // postgres-js returns a plain array. r.rows[0] is undefined in production.
    const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
    const g = rows[0];
    if (!g) return { ok: false, code: 'not_found', message: REFUSED };

    // A consumed or revoked token presented again is a replay, not a mistake: kill the whole chain.
    if (g.consumed_at || g.revoked_at) {
      await db.execute(sql`
        UPDATE tos_onboarding_grant SET revoked_at = NOW()
         WHERE selection_id = ${g.selection_id} AND revoked_at IS NULL AND consumed_at IS NULL`);
      await logAudit({ userId: ctx.locals?.user?.id ?? null, action: 'tos.grant.replay',
                       entity: 'tos_onboarding_grant', entityId: String(g.grant_id) });
      return { ok: false, code: 'replay', message: REFUSED };
    }

    if (!g.live)                    return { ok: false, code: 'expired',        message: REFUSED };
    if (g.merged_into_id)           return { ok: false, code: 'not_found',      message: REFUSED };
    if (g.decision !== 'selected')  return { ok: false, code: 'not_authorised', message: REFUSED };
    if (g.is_authorised !== true)   return { ok: false, code: 'not_authorised', message: REFUSED };
    if (g.suspended_at)             return { ok: false, code: 'suspended',      message: REFUSED };
    if (g.applicant_type === 'internal' && g.identity_status !== 'active') {
      return { ok: false, code: 'identity_inactive', message: REFUSED };
    }

    // A different human signed in on this browser: the grant is not theirs.
    const sessionUserId = ctx.locals?.user?.id || null;
    if (sessionUserId && g.person_user_id && sessionUserId !== g.person_user_id) {
      await db.execute(sql`UPDATE tos_onboarding_grant SET revoked_at = NOW() WHERE id = ${g.grant_id}`);
      return { ok: false, code: 'wrong_person', message: REFUSED };
    }

    return { ok: true,
             grantId: String(g.grant_id),
             selectionId: String(g.selection_id),
             personId: String(g.person_id),
             roleId: String(g.opportunity_role_id),
             onboardingId: String(g.onboarding_id || ''),
             writable: onboardingAcceptsWrites(g.onboarding_state) };
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[talentos/onboarding-guard] gate failed -', e?.cause?.message || e?.message);
    // FAILS CLOSED. An unreadable gate refuses; it does not wave a request through.
    return { ok: false, code: 'error', message: REFUSED };
  }
}
```

**MUST**: API endpoints call the same function and return its refusal as a `403` JSON body. **MUST
NOT** let a page render the form and rely on the POST handler to refuse — a rendered form containing
`locked_fields` has already disclosed the signed terms.

Page usage. Note that **every `const` the POST branch reads is declared above it**: `const` is not
hoisted, and a declaration placed below the handler throws on the handler's first line while the page
still reports that everything passed.

```astro
---
// src/pages/onboarding/index.astro
import BaseLayout from '@/layouts/BaseLayout.astro';
import { requireOnboardingGrant } from '@/lib/talentos/onboarding-guard';
import { saveOnboardingAnswers } from '@/lib/talentos/onboarding';

const gate = await requireOnboardingGrant(Astro);
const canWrite = gate.ok && gate.writable;
const refusal = gate.ok ? '' : gate.message;
const onboardingId = gate.ok ? gate.onboardingId : '';
let saveError = '';
let saved = false;

if (Astro.request.method === 'POST') {
  if (!canWrite) {
    saveError = refusal || 'This onboarding session is no longer open.';
  } else {
    const form = await Astro.request.formData();
    const result = await saveOnboardingAnswers(onboardingId, form);
    saved = result.ok;
    saveError = result.ok ? '' : result.reason;
  }
}

// Hoisted out of JSX deliberately: a comparison operator inside a .astro expression breaks parsing,
// and so does a typed string map.
const showForm = canWrite;
const showRefusal = !gate.ok;
---
<BaseLayout title="Onboarding">
  {showRefusal && (
    <section class="notice">
      <h1>This session has closed</h1>
      <p>{refusal}</p>
    </section>
  )}
  {showForm && (
    <form method="POST">
      {saved && <p class="ok">Saved.</p>}
      {saveError !== '' && <p class="err">{saveError}</p>}
      <!-- Fields render here. Locked organisational fields are read-only text, never inputs. -->
      <button type="submit">Save and continue</button>
    </form>
  )}
</BaseLayout>
```

No emoji appears in any string above, no arrow character appears in any JSX string, no `<script>`
sits inside a JSX conditional, and no `define:vars` is combined with `is:inline`.

---

## 12. The onboarding application and the same-form principle [brief §10, §18, §19]

### 12.1 The same-form principle

**The principle.** Recruitment and direct onboarding ask a human being the same questions. The
difference between them is **workflow state**, not a second form. There is therefore ONE form engine,
ONE field-key vocabulary and ONE answer shape. A question that means "your date of birth" carries the
key `date_of_birth` wherever it is asked, and an answer captured under that key during recruitment is
never re-asked during onboarding.

**What already exists.** The recruitment application is six bespoke `.astro` pages plus a level gate:

| Route | `STEP_LABELS` index | Carries |
|---|---|---|
| `/apply/level` | — | the level declaration gate; `draft.level` |
| `/apply/step-1` | 0 · Personal Info | profile pre-fill (`getProfileCommon`), `saveCommonFromStep1`, role security |
| `/apply/step-2` | 1 · Role Preference | role and level selection |
| `/apply/step-3` | 2 · Education | education history |
| `/apply/step-4` | 3 · Skills and Proof | the three skill tiers and custom skills |
| `/apply/step-5` | 4 · Motivation and Logistics | engagement type, logistics |
| `/apply/step-6` | 5 · Review and Submit | consent, fee resolution, the `applications` INSERT |

`TOTAL_STEPS = 6` and `STEP_LABELS` live in `src/lib/apply/data.ts`; the in-progress answers live in
`application_drafts` under `draft.step1` … `draft.step5`.

**The decision.** Three options were available and only one of them is safe:

| Option | Verdict |
|---|---|
| Onboarding **adds steps 7-N** to `/apply/step-*` | **Rejected.** Those routes are gated on `user.role === 'applicant'`, on the level declaration and on the fee flow. An onboarding joiner is past all three. Extending the array pushes a person who has already been selected back through a fee-bearing applicant funnel. |
| Onboarding **reuses steps 1-6** behind a mode flag | **Rejected.** `/apply/step-6` ends in an INSERT into `applications`. Onboarding must not create a second application. Threading a mode flag through six live pages that carry the highest-traffic candidate path is a rewrite with no requirement behind it. |
| Onboarding runs a **parallel section set** on its own route, over the same engine and the same field-key registry | **Chosen.** |

**MUST**: onboarding runs its own ordered section set, rendered by `src/lib/talentos/forms.ts` from a
`tos_form_definition` row with `purpose = 'onboarding'`, on the onboarding route (the route prefix is
§11's; the section keys and the rendering contract are this section's). `TOTAL_STEPS`, `STEP_LABELS`
and the `/apply/step-*` pages are **not** modified.

**MUST**: the recruitment form is nevertheless **registered** as a `tos_form_definition` row with
`form_key = 'apply-core'` and `is_engine_rendered = FALSE` — a mirrored declaration of what the six
bespoke pages actually ask. REASON: the same-form principle is only real if there is one registry of
field keys. Without the mirror, `education_highest` in recruitment and `highest_qualification` in
onboarding become two questions about one fact, which is the failure the principle exists to prevent.
A conformance test (§25) asserts that every key present in more than one definition carries the same
`field_type` and the same `label`.

**MUST NOT**: re-ask, on the onboarding form, any field key already answered on the linked
`applications` row. Such a field renders read-only, pre-filled from the application, and is changed
only through §12.4.

### 12.2 The form engine [brief §18]

#### 12.2.1 Types

```ts
// src/lib/talentos/forms.ts
export type FieldType =
  | 'text' | 'long_text' | 'email' | 'phone' | 'number' | 'date'
  | 'select' | 'multi_select' | 'boolean'
  | 'declaration'    // an assertion the person ticks; declaration_text is the wording signed
  | 'drive_link'     // a document, as a verified Drive link. See 12.2.5.
  | 'photo'          // the ONLY stored binary: one 320px JPEG
  | 'statement';     // rendered copy, no input, no answer

export type FormScope = 'recruitment' | 'internal' | 'selection' | 'onboarding';

export interface FormFieldDef {
  id: string;
  definitionId: string;
  sectionKey: string;
  fieldKey: string;              // the shared vocabulary key
  label: string;
  helpText: string;
  fieldType: FieldType;
  scope: FormScope;
  isRequired: boolean;
  isLocked: boolean;             // organisation-controlled, §12.3
  lockedSource: string | null;   // 'tos_selection.offered_title'
  options: { value: string; label: string }[];
  visibleWhen: VisibilityExpr;   // {} means always
  requiredWhen: VisibilityExpr;  // {} means "isRequired decides"
  validation: {
    minLength?: number; maxLength?: number; pattern?: string;
    min?: number; max?: number; notBefore?: string; notAfter?: string;
  };
  docTypeKey: string | null;     // a DOC_TYPES key from src/lib/hr-onboarding.ts
  declarationText: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface FormSectionDef {
  key: string;
  title: string;
  blurb: string;
  sortOrder: number;
  visibleWhen: VisibilityExpr;
}

export interface FormDefinition {
  id: string;
  formKey: string;               // 'apply-core' | 'onboarding-core' | 'onboarding-<opportunity_code>'
  version: number;
  name: string;
  purpose: 'recruitment' | 'onboarding' | 'selection';
  opportunityRoleId: string | null;   // roles.id; NULL applies to every opportunity
  sections: FormSectionDef[];
  isEngineRendered: boolean;
  surfaceRoute: string | null;
  isPublished: boolean;
  isActive: boolean;
  fields: FormFieldDef[];
}
```

#### 12.2.2 The four visibility scopes

`scope` says **which surface a field appears on and who authors the answer**. It is one value, not a
set: a field that belongs on two surfaces is two rows over the same `field_key`.

| `scope` | Appears on | Answered by | Candidate may read |
|---|---|---|---|
| `recruitment` | the recruitment application | the applicant | yes |
| `internal` | the recruitment application, **only** when `tos_application_link.applicant_type = 'internal'` | the internal applicant | yes |
| `selection` | the panel surface behind a selection decision | an evaluator or the decision-maker | **no** |
| `onboarding` | the onboarding application | the selected person | yes |

**MUST**: a `scope = 'selection'` field is never serialised into any response the candidate's browser
receives — not hidden with CSS, not disabled, not present. REASON: a panel note rendered
`display:none` is still in view-source, and the panel's private assessment of a person is the most
damaging thing on this surface to leak.

#### 12.2.3 Conditional visibility grammar

```ts
export type JsonScalar = string | number | boolean | null;

export type FieldOp =
  | 'eq' | 'ne' | 'in' | 'not_in' | 'contains'
  | 'filled' | 'empty'
  | 'gt' | 'gte' | 'lt' | 'lte';

export type ContextKey =
  | 'pathway'          // tos_application_link.pathway
  | 'applicant_type'   // tos_application_link.applicant_type
  | 'identity_type'    // §5.6, derived per §12.3
  | 'employment_type'  // tos_selection.employment_type
  | 'engagement_type'  // roles.engagement_type
  | 'department_id'    // TEXT. Never ::uuid.
  | 'opportunity_code' // tos_opportunity.opportunity_code
  | 'state';           // tos_onboarding.state

export type VisibilityExpr =
  | Record<string, never>                                                  // {} = always visible
  | { all: VisibilityExpr[] }
  | { any: VisibilityExpr[] }
  | { not: VisibilityExpr }
  | { field: string; op: FieldOp; value?: JsonScalar | JsonScalar[] }
  | { ctx: ContextKey; op: FieldOp; value?: JsonScalar | JsonScalar[] };
```

The operators are **named** (`gt`, `lte`), never symbolic. REASON: these expressions are evaluated in
`.astro` frontmatter and their results are read in JSX, and a `<` or `<=` character inside a JSX
expression breaks Astro parsing. A grammar that cannot express `<` cannot leak one into a template.

Evaluation rules, all **MUST**:

- Maximum nesting depth is 6. Deeper is refused at publish time.
- `validateExpr(expr)` runs in the form-editor POST. An unparseable expression **cannot be published**.
- At render time an unknown operator evaluates to `false` and logs. That path is reachable only for a
  hand-edited row, because publish already refused it.
- A field whose `visibleWhen` is false is **not required**, whatever `is_required` says. The server
  must not demand an answer to a question it did not ask.
- The **server is the authority**. The same module is imported by the page frontmatter and by the POST
  handler; the handler recomputes visibility from the submitted answers and discards any posted answer
  whose field is not visible.

#### 12.2.4 DDL (Section 3 conventions: `ensureOnce`, `IF NOT EXISTS`, every column re-asserted)

```sql
-- src/lib/talentos/forms-schema.ts -> ensureOnce('tos_form_definition_v1', ...)
-- Mirror: db/talent-os-schema.sql
CREATE TABLE IF NOT EXISTS tos_form_definition (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_key            TEXT NOT NULL,
  version             INT NOT NULL DEFAULT 1,
  name                TEXT NOT NULL,
  purpose             TEXT NOT NULL DEFAULT 'onboarding',   -- recruitment|onboarding|selection
  opportunity_role_id UUID,                                 -- roles.id; NULL = every opportunity
  sections            JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_engine_rendered  BOOLEAN NOT NULL DEFAULT TRUE,
  surface_route       TEXT,
  is_published        BOOLEAN NOT NULL DEFAULT FALSE,
  published_at        TIMESTAMPTZ,
  published_by        UUID,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS form_key            TEXT;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS version             INT NOT NULL DEFAULT 1;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS name                TEXT;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS purpose             TEXT NOT NULL DEFAULT 'onboarding';
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS opportunity_role_id UUID;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS sections            JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS is_engine_rendered  BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS surface_route       TEXT;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS is_published        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS published_at        TIMESTAMPTZ;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS published_by        UUID;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS is_active           BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS created_by          UUID;
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_form_definition ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS tos_form_definition_version_uq
  ON tos_form_definition (form_key, version);
-- One live published version per key. A second is a silent fork of the questions being asked.
CREATE UNIQUE INDEX IF NOT EXISTS tos_form_definition_live_uq
  ON tos_form_definition (form_key) WHERE is_published AND is_active;

-- src/lib/talentos/forms-schema.ts -> ensureOnce('tos_form_field_v1', ...)
CREATE TABLE IF NOT EXISTS tos_form_field (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id    UUID NOT NULL,
  section_key      TEXT NOT NULL,
  field_key        TEXT NOT NULL,
  label            TEXT NOT NULL,
  help_text        TEXT NOT NULL DEFAULT '',
  field_type       TEXT NOT NULL DEFAULT 'text',
  scope            TEXT NOT NULL DEFAULT 'onboarding',
  is_required      BOOLEAN NOT NULL DEFAULT FALSE,
  is_locked        BOOLEAN NOT NULL DEFAULT FALSE,
  locked_source    TEXT,
  options          JSONB NOT NULL DEFAULT '[]'::jsonb,
  visible_when     JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_when    JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation       JSONB NOT NULL DEFAULT '{}'::jsonb,
  doc_type_key     TEXT,
  declaration_text TEXT,
  sort_order       INT NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS definition_id    UUID;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS section_key      TEXT;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS field_key        TEXT;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS label            TEXT;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS help_text        TEXT NOT NULL DEFAULT '';
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS field_type       TEXT NOT NULL DEFAULT 'text';
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS scope            TEXT NOT NULL DEFAULT 'onboarding';
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS is_required      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS is_locked        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS locked_source    TEXT;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS options          JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS visible_when     JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS required_when    JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS validation       JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS doc_type_key     TEXT;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS declaration_text TEXT;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS sort_order       INT NOT NULL DEFAULT 0;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS is_active        BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_form_field ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS tos_form_field_uq ON tos_form_field (definition_id, field_key);
CREATE INDEX IF NOT EXISTS tos_form_field_section_idx
  ON tos_form_field (definition_id, section_key, sort_order);
```

**Which definition renders an onboarding.** `tos_onboarding` stores `form_version` (INT) and no form
key, so the key is resolved deterministically from the opportunity:

```ts
export async function definitionForOnboarding(o: { opportunityRoleId: string; formVersion: number }) {
  const r = await db.execute(sql`
    SELECT * FROM tos_form_definition
     WHERE purpose = 'onboarding' AND is_active
       AND version = ${o.formVersion}
       AND (opportunity_role_id = ${o.opportunityRoleId}::uuid OR opportunity_role_id IS NULL)
     ORDER BY (opportunity_role_id IS NOT NULL) DESC
     LIMIT 1`);
  const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
  return rows[0] || null;                 // NEVER r.rows[0]
}
```

**MUST**: when no row matches at that version, the surface refuses to render and names the missing
definition. **MUST NOT** fall back to the newest version. REASON: rendering version 3 over answers
captured under version 2 silently drops questions that were asked and re-asks ones that were not.

#### 12.2.5 Deviation from brief §18: "Document uploads"

Brief §18 lists document uploads as a field type. **This build does not implement one.** The
`drive_link` field type is the implementation: a Google Drive link in the access format `ACCESS_FORMAT`
from `src/lib/hr-onboarding.ts`, validated server-side by `isDriveLink()`, explained by
`linkProblem()`, stored in `hr_onboarding_documents` (§12.5).

REASON, stated because this is a deliberate divergence: documents of any kind are shared as links in
this product and are never uploaded — file bytes are a permanent storage cost and a permanent custody
liability for records the organisation does not need to hold. The **only** binary this system stores is
one small photo per person: a 320px JPEG, captured live or uploaded, on the `photo` field type, landing
on `hr_employees.photo_url` (or `users.photo_url`) exactly as `promoteEnrolmentPhoto()` already does. A
`tos_form_field` row with `field_type = 'photo'` and any other size or format is a defect.

### 12.3 Pre-filling and locked fields [brief §19]

A **locked field** is a fact the organisation controls. The candidate sees it, cannot change it, and
may dispute it (§12.4). It is snapshotted into `tos_onboarding.locked_fields` at grant time — that is,
in the same operation that creates the `tos_onboarding` row from a redeemed `tos_auth_code`.

#### 12.3.1 The exact snapshot list

| Locked key | Source column | Correctable |
|---|---|---|
| `person_code` | `tos_person.person_code` | no |
| `full_name` | `tos_person.display_name` | **yes** |
| `primary_email` | `tos_person.primary_email` | **yes** |
| `selection_ref` | `tos_selection.selection_ref` | no |
| `onboarding_ref` | `tos_onboarding.onboarding_ref` | no |
| `opportunity_title` | `roles.title` via `tos_selection.opportunity_role_id` | no |
| `opportunity_code` | `tos_opportunity.opportunity_code` | no |
| `offered_title` | `tos_selection.offered_title` | **yes** |
| `department_id` | `tos_selection.offered_department_id` (**TEXT**) | **yes** |
| `department_name` | `departments.name` where `departments.id::text = department_id` | **yes** |
| `position_id` | `tos_selection.offered_position_id` | **yes** |
| `employment_type` | `tos_selection.employment_type` | **yes** |
| `engagement_type` | `roles.engagement_type` | **yes** |
| `reporting_manager_user_id` | `tos_selection.reporting_manager_user_id` (a **users.id**) | **yes** |
| `reporting_manager_name` | `users.name` for that id | **yes** |
| `proposed_start_date` | `tos_selection.proposed_start_date` | **yes** |
| `stipend_amount` | `tos_selection.stipend_amount` (**NULL means unpaid**, §12.6) | **yes** |
| `stipend_currency` | `tos_selection.stipend_currency` | **yes** |
| `identity_type` | derived per §5.6, see below | no |
| `required_document_types` | `tos_opportunity.required_document_types` | no |

The department lookup casts the **column** to text (`departments.id::text = ${deptId}`) and never the
value to uuid, because `departments.id` is a `varchar(50)` slug in `src/lib/db/schema.ts` and a UUID in
`db/hr-schema.sql` (§1.4).

`identity_type` is derived, never guessed:

```ts
// src/lib/talentos/identity.ts
export const IDENTITY_TYPE_BY_ENGAGEMENT: Record<string, string> = {
  'Full-Time': 'EMPLOYEE', 'Full-time': 'EMPLOYEE', 'Part-Time': 'EMPLOYEE',
  'Internship': 'INTERN', 'Apprenticeship': 'INTERN',
  'Fellowship': 'FELLOW', 'Membership': 'MEMBER',
  'Campus Ambassador': 'CAMPUS_AMBASSADOR',
  'Contract': 'CONTRACTOR', 'Consulting': 'CONSULTANT',
};
```

Resolution order: `tos_selection.employment_type`, then `roles.engagement_type`. **MUST NOT** default an
unrecognised value to `EMPLOYEE`. The grant refuses and asks People Operations to choose. REASON:
defaulting mints an `hr_employees` row for someone who is not an employee — the exact misclassification
`decideEngagement()` in `src/lib/onboarding-journey.ts` already refuses to make.

#### 12.3.2 Snapshot shape

```json
{
  "version": 1,
  "snapshot_at": "2026-08-18T09:12:44.108Z",
  "selection_id": "…",
  "fields": {
    "offered_title": {
      "value": "Product Operations Associate",
      "label": "Title on this engagement",
      "source": "tos_selection.offered_title",
      "correctable": true
    }
  }
}
```

#### 12.3.3 Why a snapshot and not a live join

1. **The terms must not move under the person.** A live join means an administrator editing
   `tos_selection` on Tuesday silently changes what the candidate agreed to on Monday, and nothing
   anywhere records the wording they actually saw.
2. **Evidence.** The snapshot is the record of what was presented at the moment of the declaration. A
   live join keeps no such record.
3. **Cost and failure surface.** A live render joins `tos_selection`, `roles`, `tos_opportunity`,
   `departments` and `users` on every section load; the snapshot is one JSONB read.

When a locked value legitimately changes after the snapshot (an accepted correction, §12.4), the
snapshot is **re-taken** and `version` is incremented. Both versions survive in the audit trail through
`logAudit()`; `locked_fields` holds the current one.

#### 12.3.4 A POST that changes a locked field is REJECTED, not ignored

**MUST**: the server compares every submitted key against `locked_fields.fields`. If a locked key
arrives with a different value, the whole section POST is refused with HTTP 409 and a message naming
the field and pointing at the correction route. **MUST NOT** silently drop the value and save the rest
— a person who retyped their start date and was shown "Saved" has been told something false.

```astro
---
// src/pages/onboarding/step/[section].astro  (route prefix owned by §11)
// EVERY const IS DECLARED BEFORE THE POST HANDLER THAT READS IT. const is not hoisted; declaring
// these below the handler throws on the handler's first line while the page reports success.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';

const grant = Astro.locals.onboardingGrant;              // server-side authority, §4.6
if (!grant) return Astro.redirect('/onboarding');

const sectionKey = String(Astro.params.section || '');
const onbRes = await db.execute(sql`
  SELECT id, state, answers, locked_fields FROM tos_onboarding
   WHERE id = ${grant.onboardingId}::uuid LIMIT 1`);
const onbRows = Array.isArray(onbRes) ? onbRes : ((onbRes as any)?.rows || []);
const onboarding = onbRows[0] || null;
if (!onboarding) return Astro.redirect('/onboarding');

const lockedFields = (onboarding.locked_fields || {}).fields || {};
const lockedKeys = Object.keys(lockedFields);
const answers = onboarding.answers || {};
const openStates = ['invited', 'in_progress', 'changes_requested'];
const isOpen = openStates.includes(String(onboarding.state || ''));

let errorMsg = '';
let savedMsg = '';

if (Astro.request.method === 'POST') {
  const fd = await Astro.request.formData();
  const posted: Record<string, string> = {};
  for (const [k, v] of fd.entries()) posted[k] = String(v);

  const conflicts = lockedKeys.filter((k) => {
    if (!(k in posted)) return false;
    const current = lockedFields[k]?.value;
    return String(posted[k] ?? '') !== String(current ?? '');
  });

  if (!isOpen) {
    errorMsg = 'This onboarding form is no longer open for edits. Nothing was changed.';
  } else if (conflicts.length > 0) {
    Astro.response.status = 409;
    errorMsg = 'These details are set by the organisation and were not changed: '
      + conflicts.map((k) => lockedFields[k]?.label || k).join(', ')
      + '. If one of them is wrong, ask for a correction and say what it should be.';
    try {
      await logAudit({
        userId: grant.userId, action: 'tos.onboarding.locked_field_rejected',
        entity: 'tos_onboarding', entityId: String(onboarding.id),
        diff: { section: sectionKey, fields: conflicts },
      });
    } catch (e: any) {
      // Never swallowed. The real Postgres reason is on e.cause; e.message is only the failed SQL.
      console.error('[tos/onboarding] locked-field rejection audit NOT written -',
        e?.cause?.message || e?.message);
    }
  } else {
    // …persist only visible, unlocked, in-section keys; see §12.2.3.
    savedMsg = 'Saved.';
  }
}
---
```

### 12.4 The correction workflow [brief §34]

A candidate who believes a locked value is wrong opens a `tos_correction_request` naming `field_key`,
the `proposed_value` and a `candidate_note`. `current_value` is copied from the snapshot, not re-read
live, so the dispute is against what they were actually shown.

| Question | Answer |
|---|---|
| Which fields | Only those marked **correctable** in §12.3.1. A request against any other key is refused at the API with an explanation. |
| Who decides | The person in `tos_selection.decided_by_user_id`, **or** any holder of the People Operations capability that governs the selection console (§14). |
| Who may **not** decide | The candidate. And where the field is `employment_type`, `stipend_amount` or `proposed_start_date`, anyone who is neither the decision-maker nor their approver — those are terms of the engagement, not typing errors. |
| Decision record | `state` moves `open` to `accepted` or `rejected`; `decided_by_user_id`, `decided_at` and `decision_note` are all **required**. A rejection with an empty `decision_note` is refused. |
| On accept | The underlying source column is updated (`tos_selection.*` for engagement terms, `tos_person.*` for name and address), the snapshot is re-taken with `version` incremented (§12.3.3), an `audit_log` entry is written, and the candidate is notified. |
| On reject | Nothing changes. The candidate is notified with `decision_note` verbatim. |

**What happens to the onboarding record meanwhile.** It stays in its current state and remains editable
and submittable. It **MUST NOT** advance past `verified` — that is, it MUST NOT be approved — while any
`tos_correction_request` for it is `open`. REASON: approval mints an organizational identity from the
locked snapshot, and approving over an unresolved dispute creates that identity on terms the person has
said in writing are wrong. The approval control on the reviewer surface is disabled with that sentence
as its stated reason, not hidden.

An accepted correction that changes `employment_type` or `engagement_type` **MUST** re-derive
`identity_type` (§12.3.1) and re-evaluate the form's conditional sections. If the derived identity type
changes, the onboarding returns to `in_progress` and the candidate is told which sections reopened.

### 12.5 Documents

Documents reuse `hr_onboarding_documents` and `src/lib/hr-onboarding.ts` unchanged. Nothing new is built
for storage, review or notification.

| Concern | Reused from `src/lib/hr-onboarding.ts` |
|---|---|
| Which types may be asked for | `DOC_TYPES` (8 keys) |
| Link validation | `isDriveLink()`, `linkProblem()` |
| Required sharing format | `ACCESS_FORMAT` = `Anyone with the link - Viewer` |
| Add and withdraw | `addDoc()`, `removeDoc()` |
| Review | `reviewDoc()` — returns `{ ok, error }`, and its answer **MUST** be read |
| Cap | `MAX_DOCS` = 5 |

**The required list.** `tos_opportunity.required_document_types` is a `TEXT[]` of `DOC_TYPES` keys. Every
entry **MUST** be a valid key; the opportunity editor refuses an unknown one.

**MUST**: the opportunity editor also refuses to save more than `MAX_DOCS` required types. REASON:
`addDoc()` refuses the sixth document for a person. An opportunity requiring six makes its own onboarding
impossible to finish, and the joiner meets that wall rather than the administrator who configured it.

**Two id traps on this table**, both of which write a plausible-looking wrong value:

1. `hr_onboarding_documents.user_id` is TEXT and holds a **`users.id`** — never a `tos_person.id`. Before
   the documents section renders, the surface resolves `tos_person.user_id`; if it is NULL the section
   refuses with a named message and offers account activation. **MUST NOT** write a person id into that
   column.
2. `hr_onboarding_documents.employee_id` is NULL at onboarding time, because the `hr_employees` row does
   not exist until §13.3. It is backfilled after identity creation by an UPDATE keyed on `user_id`. A
   document with a NULL `employee_id` is normal, not a fault.

**The progress rule.** `progress()` in `hr-onboarding.ts` answers over *all* submitted documents. The
onboarding needs the answer *per required type*:

```ts
// src/lib/talentos/onboarding-docs.ts
export function requiredDocumentProgress(
  required: string[], docs: { docType: string; status: string }[],
) {
  const per = required.map((type) => {
    const mine = docs.filter((d) => d.docType === type);
    return {
      type,
      verified: mine.some((d) => d.status === 'verified'),
      rejected: mine.some((d) => d.status === 'rejected'),
      submitted: mine.length > 0,
    };
  });
  return {
    per,
    outstanding: per.filter((p) => !p.verified).map((p) => p.type),
    complete: per.length > 0 && per.every((p) => p.verified && !p.rejected),
  };
}
```

**MUST**: the document step is complete only when **every** entry in `required_document_types` has at
least one `verified` document and none `rejected`. A rejected document reopens the step and the candidate
is notified with the reviewer's note — `reviewDoc()` already sends that notification.

**Honest limitation.** No server can verify a Drive sharing setting from the link alone. The check is
format-only. The reviewer confirms the document opens without signing in, and the surface says so in
those words rather than implying an access check happened.

### 12.6 Compensation honesty

`tos_selection.stipend_amount` is `NUMERIC(12,2)` and **NULL means unpaid**. There is no third state.

**MUST**, on the onboarding form, on the review screen, and in the declaration the person ticks:

- `stipend_amount IS NULL` renders, in plain words: *"This engagement is unpaid. No stipend is recorded
  for it."* For an internship: *"This internship is unpaid. No stipend is recorded for it."*
- `stipend_amount IS NOT NULL` renders the amount and `stipend_currency` exactly as recorded, locked.

**MUST NOT**:

- render an empty amount field, a dash, `0.00`, "to be confirmed", "as per policy", or any wording that
  leaves a reader expecting money that is not recorded;
- promise a review, a conversion or a future stipend anywhere on this surface;
- describe the engagement as employment when the derived identity type is not employment-backed.

The declaration text a person signs **MUST** contain the same sentence that was rendered, so the signed
record and the screen agree.

Copy on this surface describes EduRankAI as the technology platform. It **MUST NOT** claim to be a
university, to confer a degree, or to award a credential; accredited partners award credentials. Status
marks on this surface are inline monochrome SVG. No emojis.

### 12.7 Draft, resume and abandonment

**There is no onboarding draft table.** The `tos_onboarding` row already exists from grant time, so
`answers` **is** the draft. REASON: `application_drafts` exists because a recruitment application has no
row until submission; onboarding does not have that problem, and a second draft store would be a second
source of truth for the same answers.

- **Save.** Each section POST merges its visible, unlocked keys into `answers` and stamps `updated_at`.
  The first successful save moves `invited` to `in_progress` (§13.1).
- **Resume.** Entry is by the server-side grant (§4.6), never by a link carrying state. The surface
  resumes at the first incomplete section, computed from the definition and `answers`.
- **Cross-device.** `answers` is server-side, so resume works on any device the person signs in on.
  Nothing depends on `localStorage`.
- **Reminders and lapse.** A daily job reads onboardings in `invited` or `in_progress` whose `updated_at`
  is older than 3, 7 and 14 days, notifies the person once per threshold, and records which reminders
  were sent in `reminders_sent` so a daily job cannot re-send. At 30 days the state moves to `lapsed`.
- **Lapse is not revocation.** A lapsed onboarding does **not** revoke `tos_selection` and does not revoke
  the `tos_auth_code`. People Operations may reopen it (`lapsed` to `in_progress`), which is a normal
  transition and needs no override row.

The `reminders_sent` column and the activation columns of §13.3 are one additive DDL block (§13.3.4).
Notification types used here **MUST** be registered in `NOTIF_META` in
`src/lib/notification-catalog.ts`; an unregistered type is silently filed as `system/medium` and loses its
category and its priority.

---

## 13. Verification, approval and identity creation [brief §20]

### 13.1 The submission-to-active state machine

`tos_onboarding.state` takes exactly these twelve values. This subsection is the transition authority for
that column; where §17 presents a status model for display, it projects these values and MUST NOT
introduce a thirteenth.

| State | Meaning |
|---|---|
| `invited` | The row exists from grant redemption. Nothing has been answered. |
| `in_progress` | At least one section saved. |
| `submitted` | The candidate has declared and submitted. `submitted_at` set. |
| `under_verification` | A reviewer has picked it up. |
| `changes_requested` | Sent back to the candidate with a written reason. Editable again. |
| `verified` | Documents and answers checked. `verified_at`, `verified_by_user_id` set. |
| `approved` | Approval recorded. `approved_at`, `approved_by_user_id` set. Identity not yet created. |
| `activation_failed` | Approval stands; identity creation did not complete. §13.3.4. |
| `active` | `tos_identity` exists with `status = 'active'`; `identity_id` set. |
| `rejected` | Terminal. `rejected_at`, `rejection_reason` set. |
| `withdrawn` | Terminal. The person withdrew. |
| `lapsed` | Abandoned per §12.7. Reopenable. |

| From | To | Who | Validated before the transition |
|---|---|---|---|
| `invited` | `in_progress` | candidate | grant valid and unconsumed |
| `in_progress` | `submitted` | candidate | every visible required field answered; every required document type submitted; every declaration ticked; no locked-field conflict; no `open` correction on a term field |
| `submitted` | `under_verification` | reviewer | reviewer holds the People Operations capability |
| `under_verification` | `changes_requested` | reviewer | written reason, minimum 30 characters |
| `changes_requested` | `in_progress` | candidate | automatic on the first save |
| `under_verification` | `verified` | reviewer | every required document `verified`; no `rejected` document; no `open` correction request |
| `verified` | `approved` | approver | two-person rule (§13.2) where it applies; `tos_selection.is_authorised` still TRUE; `tos_selection.suspended_at` still NULL |
| `approved` | `active` | system | §13.3 completed; `identity_id` set |
| `approved` | `activation_failed` | system | §13.3 did not complete |
| `activation_failed` | `active` | reviewer (retry) | §13.6 guard passes |
| any non-terminal | `rejected` | approver | written `rejection_reason`, minimum 30 characters |
| any non-terminal | `withdrawn` | candidate or People Operations | reason recorded in `audit_log` |
| `invited` / `in_progress` | `lapsed` | system | 30 days without an update |
| `lapsed` | `in_progress` | People Operations | selection still authorised |

**MUST**: any write to `tos_onboarding.state` that is not one of the rows above inserts a `tos_override`
row in the same operation, with a reason of at least 20 characters (§4.8). A silent override is a defect.

### 13.2 Document verification and People Operations review

**What a reviewer sees**, on `/admin/talent/onboarding/[id]`:

- the person block: `person_code`, `display_name`, `primary_email`, and the linked application;
- the answers, by section, in definition order, under the label as authored;
- the locked snapshot **beside the current source values**, with any value that has moved since the
  snapshot marked as changed — that difference is the reviewer's cue that a re-snapshot or a correction
  is owed;
- the documents: type, title, link, review state, and `ACCESS_FORMAT` restated as the thing to check;
- the correction requests, `open` ones first;
- the derived `identity_type`, and when it is employment-backed the fact that approval will create an
  `hr_employees` row.

**What a reviewer MUST NOT see on this surface**: `hr_employees.blood_group` and
`hr_employees.date_of_birth`. Those are HR record fields on an individual's own record, not columns on a
review or oversight screen. **MUST NOT** build any list screen that renders a row per person of individual
health data.

**Automated checks are advisory only.** Duplicate-link detection, name-mismatch heuristics, and any
proctoring or detection signal carried on `tos_stage_run.advisory_flags` are displayed as advisory and
nothing more. **MUST NOT**: any code path that sets `verified_at`, `approved_at`, `rejected_at` or a
document status from a detector. A human decides, and the record names them.

**The two-person rule.** `verified_by_user_id` and `approved_by_user_id` **MUST** be different users when
either condition holds:

1. the derived identity type is employment-backed (`EMPLOYEE`, `INTERN` — §5.6); or
2. the opportunity's `tos_opportunity.access_profile_id` resolves to a `tos_access_profile` with
   `requires_approval = TRUE`.

Enforced in `src/lib/talentos/onboarding.ts` and asserted by a conformance test (§25), not by a `CHECK`
constraint. REASON: the rule is conditional on the derived identity type and on a row in another table,
which a row-level `CHECK` cannot see, and this project has no migration runner to change one with.

**Rejection.** `rejection_reason` is required, minimum 30 characters, and reaches the candidate
**verbatim**. Rejecting an onboarding does **not** revoke `tos_selection` and does not revoke the
authorization code; ending a selection is a separate, separately recorded decision. A rejected onboarding
is terminal — a candidate who should try again is given a fresh grant against the same selection.

### 13.3 Identity creation

Two paths. Which one runs is decided **only** by the derived `identity_type` (§12.3.1).

#### 13.3.1 Employment-backed path (`EMPLOYEE`, `INTERN`)

**MUST** call the existing `completeHire()` in `src/lib/hire-completion.ts`. **MUST NOT** write
`hr_employees` directly, and **MUST NOT** re-implement any of its five steps.

```ts
import { completeHire } from '@/lib/hire-completion';

const hire = await completeHire({
  applicationId: selection.application_id,     // tos_selection.application_id
  actorUserId: approverUserId,
  source: 'admin_status',
});
```

`completeHire()` **never throws** and returns
`{ ok, employeeId, employeeCode, steps, gaps, error, handoffId }`. It creates the `hr_employees` row
through `src/lib/hr/sync.ts` (which mints `employee_code` with the MAX-plus-retry helper), carries the
agreed terms onto the record without overwriting anything HR typed, advances the candidate-visible stage
to `onboarded`, starts the onboarding journey, tells the joiner, and writes the `hr_hire_handoffs` ledger
row that `/admin/hr/reconciliation` lists. `tos_identity` is then created with
`employee_id = hire.employeeId` and `source_onboarding_id` set.

#### 13.3.2 Non-employment path (`FELLOW`, `MEMBER`, `CAMPUS_AMBASSADOR`, `CONTRACTOR`, `CONSULTANT`, `OTHER_AUTHORIZED_IDENTITY`)

**MUST** create a `tos_identity` row only, with `employee_id` left NULL. **MUST NOT** call
`completeHire()`, and **MUST NOT** create an `hr_employees` row for any of these types. REASON: an
`hr_employees` row is an employment record. Creating one for a member or a campus ambassador puts a
non-employee into the payroll, attendance, leave, probation and offboarding surfaces that all read that
table, and it is evidence of an employment relationship that does not exist.

The onboarding journey, notification and account steps still run for these identities: `startJourney()`
requires an `hr_employees.id` and therefore **cannot** be used, so the non-employment path uses the
notification and access-provisioning steps only, and the reviewer surface states plainly that no joining
checklist exists for this identity type until an engagement-appropriate pack is written.

#### 13.3.3 Identity code minting

```ts
// src/lib/talentos/codes.ts
export const IDENTITY_CODE_PREFIX: Record<string, string> = {
  EMPLOYEE: 'ERAI-EMP-', INTERN: 'ERAI-INT-', FELLOW: 'ERAI-FEL-', MEMBER: 'ERAI-MEM-',
  CAMPUS_AMBASSADOR: 'ERAI-CAM-', CONTRACTOR: 'ERAI-CON-', CONSULTANT: 'ERAI-CNS-',
  OTHER_AUTHORIZED_IDENTITY: 'ERAI-OTH-',
};

export async function nextIdentityCode(identityType: string): Promise<string> {
  const prefix = IDENTITY_CODE_PREFIX[identityType];
  if (!prefix) throw new Error('Unknown identity type: ' + identityType);
  const r = await db.execute(sql`
    SELECT COALESCE(MAX(regexp_replace(identity_code, ${'^' + prefix}, '')::bigint), 0)::bigint AS mx
      FROM tos_identity
     WHERE identity_code ~ ${'^' + prefix + '[0-9]+$'}`);
  const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
  return prefix + String(Number(rows[0]?.mx || 0) + 1).padStart(5, '0');
}
```

Each prefix carries an independent five-digit sequence. **MUST** wrap the INSERT in the same retry shape
as `withEmployeeCode()`, retrying **only** on SQLSTATE `23505` read from `e.cause.code` (not `e.code`).
**MUST NOT** number by `SELECT COUNT(*)` — that is wrong after any delete and under any concurrency, and
on this project it silently lost hires for eleven days.

#### 13.3.4 Failure handling — surfaced, not logged

`completeHire()` returns rather than throws precisely because a swallowed exception once left an applicant
marked hired with no employee record for eleven days. This build **MUST NOT** repeat the shape that hid it:
`await completeHire(...)` without reading the answer is the defect.

**MUST**:

- `hire.ok === false` — the onboarding moves to `activation_failed`, **not** `active`, and **no**
  `tos_identity` row is created. An identity with a NULL `employee_id` on an employment-backed type is
  worse than no identity: it reads as complete on every screen.
- `hire.ok === true` with unresolved steps or a non-empty `hire.gaps` — the onboarding moves to `active`,
  and `hire.steps`, `hire.gaps` and `hire.handoffId` are stored on the onboarding row and rendered on the
  reviewer surface. A hire whose checklist did not start is active but incomplete, and says so.
- The reason is stored where a person will find it. `rejection_reason` **MUST NOT** be reused for it — an
  activation failure is not a rejection, and conflating them tells the candidate they were turned down.

Additive DDL, under this section's own `ensureOnce` key, mirrored into `db/talent-os-schema.sql`:

```sql
-- src/lib/talentos/onboarding.ts -> ensureOnce('tos_onboarding_ops_v1', ...)
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS activation_error    TEXT;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS activation_steps    JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS activation_gaps     JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS activation_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS last_activation_at  TIMESTAMPTZ;
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS hire_handoff_id     UUID;   -- hr_hire_handoffs.id
ALTER TABLE tos_onboarding ADD COLUMN IF NOT EXISTS reminders_sent      JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS tos_onboarding_activation_idx
  ON tos_onboarding (state, last_activation_at DESC) WHERE state = 'activation_failed';
```

On `activation_failed` the system **MUST** also notify the People Operations audience through
`notifyAllAdmins()` with an action URL onto the failing record, and **MUST** offer a retry control that
re-runs §13.3 under the §13.6 guard. `completeHire()` is documented safe to call again; the retry
increments `activation_attempts`, rewrites `activation_error`, and stamps `last_activation_at`.

### 13.4 Department, position and team assignment

All three are written through the existing org graph. Nothing new is created for them.

| Fact | Written to | Source |
|---|---|---|
| Department | `org_employee_assignments.department_id` (**TEXT**) and `tos_identity.department_id` (**TEXT**) | `tos_selection.offered_department_id` |
| Position | `org_employee_assignments.position_id` and `tos_identity.position_id` | `tos_selection.offered_position_id` |
| Team | `org_employee_assignments.team_id` and `tos_identity.team_id` | **not set here** |
| Reporting manager | `org_relationships` (type `reporting_manager`) and `hr_employees.reporting_manager_id` | `tos_selection.reporting_manager_user_id` |

**Team**: `tos_selection` carries no team column. **MUST NOT** derive a team from the department. The
assignment row is written with `team_id` NULL and the team is set afterwards on the existing org screen.
Inventing one produces a membership nobody decided.

**The reporting line** is written by `setReportingLine()` in `src/lib/org-assignment.ts`, which accepts
`managerUserId` — exactly the id space `tos_selection.reporting_manager_user_id` is in — and writes both
the graph edge and the compatibility column, superseding rather than overwriting. It never throws and
returns `{ ok, error, edgeId, ... }`; its answer **MUST** be read. A NULL `edgeId` with `ok: true` is an
idempotent no-op, not a failure.

**The id-space trap.** Three id spaces meet here and two of them look identical:

| Column | Holds |
|---|---|
| `tos_identity.user_id`, `tos_selection.reporting_manager_user_id`, `hr_employees.reporting_manager_id` | a **`users.id`** |
| `tos_identity.employee_id`, `org_employee_assignments.employee_id`, `org_relationships.subject_employee_id` / `object_employee_id` | an **`hr_employees.id`** |
| `tos_person.id` | neither |

Translate through `hr_employees.user_id`, or call `employeeIdForUser()` in `src/lib/org-graph.ts`.
**MUST NOT** pass a `users.id` into `org_employee_assignments.employee_id`: it is a UUID, so it inserts
cleanly and produces an assignment that belongs to nobody.

**Writing the assignment**, respecting the partial unique index `org_assignments_one_open_primary_uq`
(one open primary assignment per employee):

```sql
-- 1. Close any open primary. department_id is TEXT on both sides. Never ::uuid.
UPDATE org_employee_assignments
   SET effective_to = NOW()
 WHERE employee_id = $1::uuid AND is_primary = TRUE AND status = 'active' AND effective_to IS NULL;

-- 2. Open the new one.
INSERT INTO org_employee_assignments
  (employee_id, position_id, team_id, department_id, is_primary, effective_from, created_by)
VALUES ($1::uuid, $2::uuid, NULL, $3, TRUE, NOW(), $4::uuid);
```

Both statements run in one `db.transaction`. **MUST**: if the INSERT fails, the close is rolled back —
otherwise the person has no open primary assignment and every department-scoped screen loses them.

**Known limitation, stated rather than assumed away.** `org_employee_assignments.employee_id` and
`org_relationships.subject_employee_id` hold `hr_employees.id`, so **non-employment identities cannot be
placed in the org graph at all**. For `FELLOW`, `MEMBER`, `CAMPUS_AMBASSADOR`, `CONTRACTOR`, `CONSULTANT`
and `OTHER_AUTHORIZED_IDENTITY` the department, position and team live **only** on `tos_identity`, and
org-graph queries (`getManager()`, `getDepartmentHead()`) will not see them. Provisioning (§14) therefore
reads `tos_identity.department_id` and not the graph. **MUST NOT** close this gap by creating a
placeholder `hr_employees` row.

### 13.5 The `is_primary` rule and internal transfer

A person holds **at most one active primary identity**, enforced by the partial unique index in §4.1:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS tos_identity_one_primary
  ON tos_identity (person_id) WHERE is_primary AND status = 'active';
```

Rules:

- The identity created by an onboarding is `is_primary = TRUE` **unless** the person already holds an
  active primary that is not being closed — a concurrent second engagement (an employee who also holds a
  campus ambassador identity) is created with `is_primary = FALSE`.
- **Internal transfer** — the person holds an active primary and is onboarding into a new one:
  1. the old identity is **closed**: `status = 'expired'`, `ended_on` set to the day before the new
     `started_on`, `updated_at` stamped;
  2. `is_primary` on the closed row **stays TRUE**. It records that this identity *was* the primary. The
     index covers only rows that are both `is_primary` and `status = 'active'`, so closing by status is
     sufficient. **MUST NOT** set `is_primary = FALSE` to release the index — that erases the fact and
     makes "what were they before the transfer" unanswerable;
  3. the new identity is inserted with `is_primary = TRUE`, `status = 'active'`, `started_on` set, and
     `source_onboarding_id` set.
- **MUST NOT** delete the old identity row or update it in place. Closed identities are the evidence
  behind past approvals, past access grants and past decisions.
- **Ordering.** The close **MUST** precede the insert, and both **MUST** be in one transaction. Insert
  first and the index raises `23505`; close first outside a transaction and a failed insert leaves the
  person with no active identity at all.
- A `23505` on `tos_identity_one_primary` **MUST** be surfaced as *"this person already holds an active
  primary identity; close it before opening another"*, naming the existing `identity_code` — never as a
  raw constraint message.
- The employment record follows the same shape: an internal transfer does **not** create a second
  `hr_employees` row. `completeHire()` returns the existing employee when it finds one, and the change of
  department, position and reporting line is written by §13.4.
- Access from the closed identity is revoked through §14 in the same operation. An expired identity whose
  provisioning is still live is the failure the identity registry exists to prevent (§5.7).

### 13.6 Idempotency

Approving twice, a double-submitted form, or a retry after a gateway timeout **MUST NOT** create two
identities, two employee records or two provisioning runs.

**Guard 1 — claim the transition, do not test it.** Never `SELECT` the state and then `UPDATE`. Claim it
in one statement and read whether the claim succeeded:

```ts
const claimed = await db.execute(sql`
  UPDATE tos_onboarding
     SET state = 'approved', approved_at = NOW(), approved_by_user_id = ${approverId}::uuid,
         updated_at = NOW()
   WHERE id = ${onboardingId}::uuid
     AND state = 'verified'
     AND identity_id IS NULL
  RETURNING id`);
const claimedRows = Array.isArray(claimed) ? claimed : ((claimed as any)?.rows || []);
if (claimedRows.length === 0) {
  return { ok: false, error: 'This onboarding has already been approved, or it is not ready for '
    + 'approval. Nothing was changed. Reload the record.' };
}
```

Zero rows means another request already claimed it. The second caller **MUST** stop, and **MUST NOT**
report success for work it did not do.

**Guard 2 — the database refuses a second identity.** One identity per onboarding, additively indexed
here and mirrored into `db/talent-os-schema.sql`:

```sql
-- src/lib/talentos/identity.ts -> ensureOnce('tos_identity_source_uq_v1', ...)
CREATE UNIQUE INDEX IF NOT EXISTS tos_identity_source_onboarding_uq
  ON tos_identity (source_onboarding_id) WHERE source_onboarding_id IS NOT NULL;
```

**Guard 3 — the write-back is conditional.** `identity_id` is only ever set from NULL:

```sql
UPDATE tos_onboarding
   SET identity_id = COALESCE(identity_id, $2::uuid),
       state = 'active', updated_at = NOW()
 WHERE id = $1::uuid AND state IN ('approved', 'activation_failed');
```

**Guard 4 — the downstream steps are already idempotent and MUST be reached, not re-implemented.**
`completeHire()` returns the existing employee rather than creating a second, `startJourney()` inserts its
items `ON CONFLICT DO NOTHING`, and `nextIdentityCode()` retries only on `23505`. A retry from
`activation_failed` runs the same code path with `activation_attempts` incremented.

**MUST NOT** use a session-level advisory lock as the guard. The database is reached through a transaction
pooler; a session lock can be taken on a connection that is then handed to an unrelated request, and it
does not survive the retry it was meant to protect. The conditional claim and the unique index do.

**Conformance (§25).** A test approves the same onboarding twice concurrently and asserts: exactly one
`tos_identity` row, exactly one `hr_employees` row in the employment-backed case, exactly one
`hr_hire_handoffs` row, and a second call that returns `ok: false` with a sentence a person can read.

---

## 14. Access provisioning: RBAC + ABAC [brief §21, §22, §38]

Provisioning is the bridge between two layers that stay separate. **Organization** — departments,
positions, teams, `org_relationships` — answers *where a person sits and who answers for them*, per
row, from the graph. **Authorization** — `rbac_*` and the `role_permissions` registry — answers
*what a person may do*, per user. **Workflow** is the third layer and does not appear here at all.

**MUST NOT** merge them. A department is not a permission set, an org edge is not a capability, and
no evaluation path may read `org_relationships` to decide a capability. Provisioning READS
organizational facts once, at a named moment, and WRITES authorization facts through the modules
that own them. Everything after that is the authorization layer answering on its own.

### 14.0 Who owns each write

| To change | Call | Owning module | Never |
|---|---|---|---|
| Which rbac roles a user holds | `assignRbacRole` / `revokeRbacRole` (§14.3, added to the rbac store) | `src/lib/rbac/store.ts` | direct `INSERT INTO rbac_user_roles` from `talentos` |
| A scoped allow/deny grant | `createGrant()`, `transitionGrant()` | `src/lib/rbac/store.ts` | direct SQL into `rbac_permission_grants` |
| Which admin sections a role opens | `applyRolePermissions()` | `src/lib/auth/registry.ts` | direct SQL into `role_permissions` or `role_permission_grants` |
| Whether a person holds a console role | `assignRoleToUser()` / `unassignRoleFromUser()` | `src/lib/auth/registry.ts` | direct SQL into `user_role_assignments` |
| Delegated bearer authority | `issueToken()`, `revokeToken()` | `src/lib/rbac/tokens.ts` | anything else |
| The record that any of it happened | `tos_provisioning_event` + `logAudit()` | `src/lib/talentos/provisioning.ts` | nothing — this one is mandatory |

**REASON.** Every one of those modules already carries behaviour a second writer would lose:
`applyRolePermissions()` writes the section matrix *and* the grants table from one list so the two
cannot drift; `assignRoleToUser()` rolls the assignment back when a sensitive grant cannot be
audited; `revokeToken()` cascades to delegated children. A direct `INSERT` reproduces the row and
none of the discipline.

### 14.1 The derivation

#### Inputs

Five values, all of them organizational facts already stored, none of them supplied by the person
being provisioned.

| Input | Source | Type note |
|---|---|---|
| `identityType` | `tos_identity.identity_type` | §5.6 vocabulary |
| `departmentId` | `tos_identity.department_id` | **TEXT**. Compared as text. Never `::uuid` (§1.4) |
| `positionId` | `tos_identity.position_id` | `org_positions.id` |
| `positionGrade` | `org_positions.grade` for that `positionId` | free TEXT, folded case-insensitively |
| `employmentType` | `tos_identity.engagement_type`, falling back to `hr_employees.employment_type` | **two vocabularies — see below** |

**Trap.** `roles.engagement_type` is a Postgres enum of `Full-Time | Internship | Apprenticeship`;
`hr_employees.employment_type` is free TEXT whose own schema comment reads `Full-time | Intern |
Contract | ...`. `'Full-Time'` and `'Full-time'` are different strings, and `= ANY(employment_types)`
is case-sensitive. Every comparison **MUST** go through `normEmployment()`.

```ts
// src/lib/talentos/access-derive.ts
// Every const is declared before anything that uses it: `const` is not hoisted, and a handler
// reaching a later declaration has taken pages down on this project.
const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

const EMPLOYMENT_ALIASES: Record<string, string> = {
  'full-time': 'full-time', 'fulltime': 'full-time', 'full time': 'full-time', 'permanent': 'full-time',
  'internship': 'internship', 'intern': 'internship',
  'apprenticeship': 'apprenticeship', 'apprentice': 'apprenticeship',
  'contract': 'contract', 'contractor': 'contract',
  'consultant': 'consultant', 'consultancy': 'consultant',
};
/** Canonical employment vocabulary. Unknown input returns '' and matches only a wildcard profile. */
export function normEmployment(v: unknown): string {
  return EMPLOYMENT_ALIASES[norm(v)] || '';
}
```

#### The key

The profile key is derived, not looked up. It is `<DEPARTMENT TOKEN>-<GRADE TOKEN>`, uppercase,
`A-Z0-9` and single hyphens.

```ts
/** departments.id -> key token. A department absent here uses its own uppercased slug, so a new
 *  department needs a profile ROW, not a code change. Present entries exist because the stored slug
 *  reads badly in an audit line: the People Operations department is `hr` in this repository. */
const DEPARTMENT_KEY_TOKENS: Record<string, string> = {
  hr: 'PO', infra: 'ENG', ai: 'AIR', research: 'RES', product: 'PRD',
  growth: 'GTM', legal: 'LFS', safety: 'SAF', data: 'DAT', founders: 'FO',
};

/** Identity types that are NOT plain employment. An identity of one of these types NEVER derives a
 *  grade token from a position, which is the structural guarantee behind §14.7. */
const IDENTITY_KEY_TOKENS: Record<string, string> = {
  INTERN: 'INTERN', FELLOW: 'FELLOW', MEMBER: 'MEMBER', CAMPUS_AMBASSADOR: 'AMBASSADOR',
  CONTRACTOR: 'CONTRACT', CONSULTANT: 'CONSULT', OTHER_AUTHORIZED_IDENTITY: 'OTHER',
};

const token = (v: unknown, fallback: string): string => {
  const t = String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return t || fallback;
};

export interface AccessInputs {
  identityType: string;
  departmentId: string | null;
  positionId: string | null;
  positionGrade: string | null;
  employmentType: string | null;
}

/** DETERMINISTIC. Same five inputs, same key, on every machine, forever. No database read. */
export function deriveProfileKey(i: AccessInputs): string {
  const dept = DEPARTMENT_KEY_TOKENS[norm(i.departmentId)] || token(i.departmentId, 'ORG');
  const grade = i.identityType === 'EMPLOYEE'
    ? token(i.positionGrade, 'GENERAL')
    : (IDENTITY_KEY_TOKENS[i.identityType] || token(i.identityType, 'OTHER'));
  return dept + '-' + grade;
}
```

The brief's worked example resolves exactly: identity type `EMPLOYEE`, department `hr`, position
grade `Manager` gives **`PO-MANAGER`** [brief §21].

**The grade token is read from the position only for `EMPLOYEE`.** An intern sitting in a position
graded `Senior` derives `ENG-INTERN`, never `ENG-SENIOR`. That is the mechanism, not a policy check
somebody can forget: an intern cannot *spell* an employee's profile key.

#### The match

One key, one row, one admission test.

```ts
export type ProfileResolution =
  | { ok: true; profileKey: string; profileId: string }
  | { ok: false; profileKey: string; code: 'no-profile' | 'not-admitted' | 'lookup-failed'; reason: string };

export async function resolveAccessProfile(i: AccessInputs): Promise<ProfileResolution> {
  const profileKey = deriveProfileKey(i);
  try {
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    const r = await db.execute(sql`
      SELECT id::text AS id, department_id, position_grade, employment_types, identity_types
        FROM tos_access_profile
       WHERE profile_key = ${profileKey} AND is_active = TRUE
       LIMIT 1`);
    // postgres-js returns a PLAIN ARRAY. r.rows[0] is undefined in production.
    const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
    if (!rows.length) {
      return { ok: false, profileKey, code: 'no-profile',
               reason: 'No active access profile is named ' + profileKey + '.' };
    }
    const p = rows[0];

    // identity_types: EMPTY MATCHES NOTHING. The other three columns: empty/NULL matches anything.
    const identities: string[] = p.identity_types || [];
    if (!identities.includes(i.identityType)) {
      return { ok: false, profileKey, code: 'not-admitted',
               reason: profileKey + ' does not admit identity type ' + i.identityType + '.' };
    }
    const dept = String(p.department_id ?? '').trim();
    if (dept && dept !== String(i.departmentId ?? '').trim()) {
      return { ok: false, profileKey, code: 'not-admitted',
               reason: profileKey + ' is bound to another department.' };
    }
    const grade = norm(p.position_grade);
    if (grade && grade !== norm(i.positionGrade)) {
      return { ok: false, profileKey, code: 'not-admitted',
               reason: profileKey + ' is bound to grade ' + String(p.position_grade) + '.' };
    }
    const employments: string[] = (p.employment_types || []).map(normEmployment).filter(Boolean);
    if (employments.length && !employments.includes(normEmployment(i.employmentType))) {
      return { ok: false, profileKey, code: 'not-admitted',
               reason: profileKey + ' does not admit employment type ' + String(i.employmentType) + '.' };
    }
    return { ok: true, profileKey, profileId: String(p.id) };
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[talentos] resolveAccessProfile', e?.cause?.message || e?.message);
    return { ok: false, profileKey, code: 'lookup-failed', reason: 'The access profile could not be read.' };
  }
}
```

**`identity_types` is asymmetric on purpose.** `department_id`, `position_grade` and
`employment_types` treat empty as "any", because those narrow a profile that already names a
population. An empty `identity_types` matches **nothing**, because an identity-type wildcard is the
precise shape of the incident this project already had: one broad profile an intern falls into and
walks out of holding an employee's console.

**Rejected alternative, stated because it is the obvious one.** Scoring every profile by attribute
specificity and taking the best match. It requires a tie-break, and every tie-break rule is a silent
grant of one of two profiles nobody chose. A single derived key means the answer is either a row an
administrator wrote or nothing at all.

#### When nothing matches: fail closed to a named queue

`no-profile`, `not-admitted` and `lookup-failed` all produce **no access whatsoever** and a visible
row. There is no default profile, no "minimum viable" grant, and no inheritance from the department.

The queue is not a new table. It is `tos_provisioning_event` (§4.7) filtered to
`state = 'failed' AND target_kind = 'access_profile'`, rendered at **`/admin/access/provisioning`**
under the heading *Identities waiting for an access profile*, and counted as a badge on the admin
nav entry so it cannot sit unread.

```ts
await db.execute(sql`
  INSERT INTO tos_provisioning_event
    (identity_id, profile_id, action, target_kind, target_key, state, error_reason, actor_user_id)
  VALUES (${identityId}::uuid, NULL, 'grant', 'access_profile', ${res.profileKey}, 'failed',
          ${res.reason}, ${actorUserId}::uuid)`);
```

An administrator resolves it by creating or widening the profile and pressing **Retry**, which
re-runs §14.3 from the current organizational facts. **MUST NOT** put a "grant anyway" control on
that screen.

### 14.2 The employee does not choose their own permissions [brief §21]

**MUST**: nothing a candidate or an employee types is an input to §14.1. The five inputs come from
`tos_identity`, `org_positions` and `hr_employees` — all written by the organization.

| Enforcement point | Rule |
|---|---|
| `src/lib/talentos/provisioning.ts` | `provisionIdentity(identityId, actor)` takes an **identity id and an actor**, never an inputs object and never a profile key. The inputs are re-read inside. A caller cannot pass a profile it preferred. |
| The onboarding form (§17) | Writes `tos_onboarding.answers` only — a candidate-owned JSONB bag. The server rejects any key that also appears in the org-controlled `locked_fields` snapshot, and **no key of `answers` is ever read by provisioning**. |
| `tos_selection` | `offered_position_id`, `offered_department_id`, `offered_title`, `employment_type` are written by the decision-maker in `/admin` (§10), never by the person they describe. A correction is a `tos_correction_request` (§4.6) an administrator accepts — not an edit. |
| `tos_access_request` (§14.6) | A person may *ask*. `approver_user_id` resolves from the org graph, and a request whose approver resolves to the requester is refused, not auto-approved. |
| `src/lib/auth/registry.ts` | `assignPermission()` already refuses to grant a sensitive permission when the audit row cannot be written, and rolls back an assignment it could not record. Provisioning inherits that; it does not re-implement it. |

### 14.3 Materialisation

A matched profile is applied by writing through the existing engines. The `tos_provisioning_event`
ledger row is written **before** each attempt, so a run that dies halfway leaves `pending` rows
naming exactly what was not finished, rather than an invisible half-grant.

#### `target_kind` vocabulary (complete)

§4.7's inline comment lists three examples. The complete vocabulary is fixed here; the column is
`TEXT` precisely so it can be extended without a migration (§3).

| `target_kind` | `target_key` holds | Applied by | Revoked by |
|---|---|---|---|
| `rbac_role` | `rbac_roles.key` | `assignRbacRole()` | `revokeRbacRole()` |
| `admin_section` | an `admin-sections.ts` key | `applyRolePermissions()` on the profile's console role | the same call with the key removed |
| `app_system` | `tos_app_system.key` | the provisioner named on that row | the same |
| `rbac_grant` | the returned `permission_id` | `createGrant()` then `transitionGrant()` to `activated` | `transitionGrant(id, 'revoked')` |
| `capability_token` | `rbac_capability_tokens.token_id` | `issueToken()` | `revokeToken(id, { cascade: true })` |
| `access_profile` | the derived profile key | — never applied; the §14.1 queue row only | — |

`assignRbacRole()` and `revokeRbacRole()` are **added to `src/lib/rbac/store.ts`**, next to
`createGrant()`, and export the single-row write against the existing `rbac_user_roles` table
(`UNIQUE (user_id, role_key)`, so the insert is `ON CONFLICT DO NOTHING`). No new table. **REASON**:
the rbac module owns those rows, and a second module writing them is how the two ends of a
permission model drift apart.

#### Lifecycle

```
                (row written first, then the call is made)
  pending ──applied──▶ applied ──revoke run──▶ reverted
     │
     └──error──▶ failed     (error_reason = e?.cause?.message || e?.message)
```

`pending` that never moved is the interesting state. `/admin/access/provisioning` lists it as
*Started and not finished*, with the identity, the target and the age. **Retry** is safe because
every underlying call is idempotent: `ON CONFLICT DO NOTHING` on `rbac_user_roles`, and
`applyRolePermissions()` rewrites the role to an exact set.

#### The console role

Admin sections are never granted to a person. They are granted to a `team_roles` row that mirrors
the profile, and the person is put in it.

1. Ensure a `team_roles` row exists with `role_key = lower(profile_key)` — `createRole()`.
2. `applyRolePermissions(roleId, sections.map((s) => s + '.view'), actor)`. This writes
   `role_permission_grants` **and** `role_permissions` from one list, which is what makes the grant
   real at the door as well as in the console.
3. `assignRoleToUser(identity.user_id, roleId, actor)`.

**Named failure, not a surprise.** `assignRoleToUser()` refuses any account whose `users.role` is
`'applicant'`, with *"Applicant accounts cannot hold a staff role."* A person arriving from
recruitment still carries `applicant` until the account role is changed. Step 3 therefore records
`state = 'failed'` with that exact message, and the queue tells the administrator to change the
account role first. **MUST NOT** make provisioning promote `users.role` on its own — an automatic
promotion on this project is what put an intern in the super-admin console.

**Second named seam**, already documented in `src/lib/admin-nav.ts`: a permission living only in
`role_permission_grants` produces a sidebar link that `middleware.ts` then refuses. Step 2 uses
`applyRolePermissions()` and never `assignPermission()` alone, so the section matrix is always
written and the link always opens.

```ts
// src/lib/talentos/provisioning.ts  (shape, not the whole file)
export async function provisionIdentity(identityId: string, actor: { id: string; email?: string | null }) {
  const identity = await readIdentity(identityId);        // tos_identity joined to org_positions.grade
  if (!identity || identity.status !== 'active') {
    return { ok: false as const, reason: 'Identity is not active.' };
  }

  const res = await resolveAccessProfile(identity.inputs);
  if (!res.ok) { await queueUnresolved(identityId, res, actor.id); return { ok: false as const, reason: res.reason }; }

  const profile = await readProfile(res.profileId);
  const applied: string[] = [];
  const failed: string[] = [];

  for (const roleKey of profile.rbacRoleKeys) {
    const eventId = await openEvent(identityId, res.profileId, 'grant', 'rbac_role', roleKey, actor.id);
    try {
      await assignRbacRole(identity.userId, roleKey, actor.id);
      await closeEvent(eventId, 'applied');
      applied.push('rbac:' + roleKey);
    } catch (e: any) {
      await closeEvent(eventId, 'failed', e?.cause?.message || e?.message);
      failed.push('rbac:' + roleKey);
    }
  }
  // ... admin_section (one applyRolePermissions call, one event row per section key),
  // ... app_system, then rbac_grant (createGrant -> transitionGrant granted/validated/activated).

  await logAudit({ userId: actor.id, action: 'talentos.provision', entity: 'tos_identity',
                   entityId: identityId, diff: { profileKey: res.profileKey, applied, failed } });
  return { ok: failed.length === 0, applied, failed };
}
```

`createGrant()` returns a grant in state `defined`. The lifecycle in `src/lib/rbac/types.ts` is
`defined → granted → validated → activated`, and **only** `activated`, `inherited` and `modified`
participate in evaluation (`LIVE_PERMISSION_STATES`). Provisioning **MUST** walk all four
transitions and record the `permission_id` as an `rbac_grant` event. A grant left at `defined` is a
row that grants nothing and looks in the admin UI like it grants something.

### 14.4 ABAC: attributes as conditions

`RuleConditions` (`src/lib/rbac/types.ts`) has exactly five fields: `requireOwner`, `resourceState`,
`timeWindow`, `institutionId`, `location`. That is the whole vocabulary the engine evaluates. The
brief's attribute list maps onto it as follows, and **MUST NOT** be forced anywhere it does not fit.

| Attribute [brief §22] | Where it is actually expressed |
|---|---|
| Identity status | **Not a condition.** An identity that is not `active` has no live grants, because §14.5 revokes them. Status is enforced at provisioning and de-provisioning time, not per request. |
| Department | **Not a condition.** A WHERE-clause scope: `departmentFilter()` in `src/lib/auth/workspace-access.ts`, which compares as text and returns `false` (no rows) when nothing resolved. |
| Employment type | **Not a condition.** It selects the profile (§14.1) and then stops existing. |
| Project | `resourceRef` = the project id on a per-project `createGrant()`. One grant per project, revocable one at a time. |
| Security level | `resource.securityLabels` plus the engine's `labelAdmits()`. Only `public`, `enrolled-only` and `exam-secure` are understood; every other label admits `administer` alone. Profiles **MUST NOT** invent labels. |
| Location | `conditions.location: string[]` against `EvalContext.location`. |
| Time window | `conditions.timeWindow: { startHour, endHour }`. |

**MUST NOT put a department id in `conditions.institutionId`.** The engine's test is

```ts
if (c.institutionId && resource.institutionId && c.institutionId !== resource.institutionId) return false;
```

The condition is skipped entirely when the resource carries no `institutionId`, so a department
fence written that way silently applies to nothing while reading, in the admin UI, as a fence.
Department scoping is a WHERE clause or it does not exist.

**`timeWindow` is server-local hours.** The engine reads `(ctx.now ?? new Date()).getHours()`. A
window is a working-hours nicety, never a security boundary.

#### The effective-permission formula, as real evaluation order

```
effective = ( role capabilities ∪ explicit allow grants ∪ capability tokens ∪ inherited grants )
            ∩ attribute conditions
            ∩ resource constraints
            − explicit deny grants
```

`src/lib/rbac/engine.ts` evaluates that in a fixed order, and the order is the specification:

| Tier | Test | Result |
|---|---|---|
| 0 | no identity · invalid session · **`contextDegraded`** · unknown capability · kernel-locked resource | **deny** |
| 1 | any live **deny** grant matching identity, resource, capability and conditions | **deny** — overrides everything below, `administer` included |
| 2 | principal holds `administer` | **allow** |
| 3 | an explicit allow grant | allow, after constraints |
| 4 | a capability token covering operation, resource and scope | allow, after constraints |
| 5 | an inherited grant | allow, after constraints |
| 6 | a role capability | allow, after constraints |
| — | none of the above | **deny** (`default-deny`) |

Constraints — security labels, the not-owner-and-lacks-`manage` rule, and the
minor-without-guardian rule — apply to every non-`administer` allow path.

Two behaviours already exist in `src/lib/rbac/store.ts` and `engine.ts` and **MUST NOT be
re-specified differently anywhere in this build**:

1. **Deny overrides allow**, at Tier 1, before the administrative override. `priority` orders grants
   within one effect; it never lets an allow beat a deny.
2. **A degraded permission context is itself a denial.** When the role graph, the role assignments
   or the grants cannot be read, `resolvePrincipal()` sets `contextDegraded` and the engine denies at
   Tier 0. The cost is stated in that file and accepted: while the read is failing, every gated
   surface refuses everyone, the founder included. Talent OS code **MUST NOT** add a fallback around
   it, and **MUST NOT** re-read a degraded principal as "no grants, therefore role defaults" — the
   grants table is where deny lives, and dropping it is fail-open in the only direction that matters.

One consequence of Tier 2 that no ABAC design here may be built on: `administer` short-circuits
before conditions are considered, so no `timeWindow` and no `location` narrows a superadmin. A
restriction that must bind everyone is a **deny** grant, not a condition.

### 14.5 De-provisioning

**The rule: an access grant outlives nothing.** Every grant this build creates is traceable to one
`tos_identity` through `tos_provisioning_event.identity_id`. When that identity stops being
`active`, every event with `state = 'applied'` for it is reversed, in the same operation, through
the same owning module, and each reversal is written back as `state = 'reverted'`. No grant in this
system may have "it was already there" as its justification.

| Trigger | `tos_identity.status` | rbac roles | Console role | Grants | Tokens | Sessions |
|---|---|---|---|---|---|---|
| Suspension (investigation, leave of absence) | `suspended` | revoked | `unassignRoleFromUser()` | `transitionGrant(id, 'suspended')` | `revokeToken(id, { cascade: true })` | deleted |
| Expiry (`ended_on` reached, fixed-term identity) | `expired` | revoked | `unassignRoleFromUser()` | `transitionGrant(id, 'revoked')` | revoked, cascading | deleted |
| Termination or exit (§13) | `terminated` | revoked | `unassignRoleFromUser()` | `transitionGrant(id, 'revoked')` | revoked, cascading | deleted |

Suspension uses `suspended` rather than `revoked` because the lifecycle table permits
`suspended → activated`: reinstatement restores the same grant rows with their history instead of
minting new ones that read as a fresh decision. Expiry and termination are one-way.

**In-flight capability tokens.** A token is a bearer credential: whoever holds the string can present
it until it stops validating. There is no grace period and no TTL to wait out — `tokenCovers()`
refuses any token whose status is not in `LIVE_TOKEN_STATES`, so a revoked token is dead on its next
presentation. `revokeToken()` **MUST** be called with `cascade: true` (its default) for every token
returned by `listTokens(identity.userId)`; a delegated child outliving its parent is exactly the hole
the cascade exists to close. Tokens the departing person issued to somebody else die in the same
cascade, and that is intended: authority they delegated was authority they held.

**Sweeps.** Two job kinds, registered in `HANDLERS` in `src/lib/job-handlers.ts`. Registration is not
optional — the queue accepts any string as a kind, so a kind with no handler is accepted, retried to
exhaustion and parked in `failed`.

| Kind | Cadence | Does |
|---|---|---|
| `tos.identity_expiry_sweep` | daily | `tos_identity` where `status = 'active'` and `ended_on < CURRENT_DATE` → `expired`, then de-provision |
| `tos.access_request_expiry_sweep` | daily | `tos_access_request` where `state = 'approved'` and `expires_at < NOW()` → `revoked`, then reverse the events it created |

De-provisioning **MUST** attempt every applied event even after one fails, recording each failure on
its own row. A revocation loop that aborts on the first error leaves the rest of the access in place
and reports an error, which is the worst of both outcomes.

### 14.6 Access requests [brief §15]

A `tos_access_request` is how somebody asks for something their profile does not carry. It is
deliberately not a way to change a profile: an exception is time-boxed, a profile is not.

1. **Raise.** The requester's `identity_id` comes from the session (§15.2), never from the form.
   `target_kind` and `target_key` use §14.3's vocabulary. `reason` is required, minimum 20
   characters — the same bar `tos_override.reason` sets.
2. **Route.** The approver resolves from the **org graph**, first hit wins:
   `getApprovalOwner('access', { employeeId })` → `getDepartmentHead(identity.department_id)` →
   `getManager(employeeId)`. **MUST NOT** resolve an approver from `users.role`: "is an admin" is a
   capability, and "answers for this person" is a relationship, and the three-layer rule is that
   those never stand in for one another. If none of the three resolves, the request stays `open` and
   shows on `/admin/access/requests` as *No approver could be resolved*. It does not fall back to
   whichever administrator is nearest.
3. **Refuse self-approval.** If the resolved approver's `users.id` equals the requester's, the
   request is refused with *"You cannot approve your own access request."*
4. **Decide.** Approval **MUST** set `expires_at`. A `NULL` `expires_at` on an approved request is
   rejected by the handler; a permanent need is a profile change, made in `/admin/access/profiles`
   where everyone who reads the profile can see it.
5. **Apply.** Approval writes `tos_provisioning_event` rows per §14.3 and then makes the same calls
   the profile would have made. An approved request never writes a permission table directly.
6. **Expire.** `tos.access_request_expiry_sweep` reverses it, and both the requester and the approver
   are notified (§19). Access that vanishes without a sentence gets re-requested as a bug report.

```astro
---
// src/pages/portal/access-requests/index.astro  (frontmatter only)
// Every const is declared BEFORE the POST handler that uses it.
import BaseLayout from '@/layouts/BaseLayout.astro';
import { requireIdentity } from '@/lib/talentos/portal-gate';
import { raiseAccessRequest, listMyAccessRequests } from '@/lib/talentos/access-requests';

const user = Astro.locals.user;
const gate = await requireIdentity(user, '/portal/access-requests');
if (!gate.ok && gate.redirect) return Astro.redirect(gate.redirect);

let notice = '';
let problem = '';

if (gate.ok && Astro.request.method === 'POST') {
  const form = await Astro.request.formData();
  const res = await raiseAccessRequest({
    identityId: gate.identity.id,                     // from the session, never from the form
    targetKind: String(form.get('target_kind') || ''),
    targetKey: String(form.get('target_key') || ''),
    reason: String(form.get('reason') || ''),
  }, { id: String(user.id), email: user.email });
  if (res.ok) notice = 'Your request went to ' + res.approverName + '.';
  else problem = res.reason;
}

const mine = gate.ok ? await listMyAccessRequests(gate.identity.id) : [];
const openCount = mine.filter((r) => r.state === 'open').length;
const hasOpen = openCount > 0;   // hoisted: no comparison operators inside a JSX expression
---
```

### 14.7 Seed access profiles

Seeded by `ensureOnce('tos_access_profile_seed_v1', …)`. The seeder **MUST** verify every
`department_id` against `departments.id` as text and refuse the row with a named error rather than
insert a profile bound to a department that does not exist.

| `profile_key` | Department | `identity_types` | `employment_types` | `rbac_role_keys` | `admin_section_keys` | `app_system_keys` |
|---|---|---|---|---|---|---|
| `PO-MANAGER` | `hr` | `{EMPLOYEE}` | `{Full-Time}` | `{employee, support}` | `dashboard, hr, employees, leave, attendance, applications, offers, roles, interviews` | `portal, mail, chat, admin` |
| `PO-GENERAL` | `hr` | `{EMPLOYEE}` | `{Full-Time}` | `{employee}` | `dashboard, employees, leave, attendance` | `portal, mail, chat, admin` |
| `ENG-SENIOR` | `infra` | `{EMPLOYEE}` | `{Full-Time}` | `{employee}` | `dashboard, projects, helpdesk, assets` | `portal, mail, chat, admin` |
| `ENG-GENERAL` | `infra` | `{EMPLOYEE}` | `{Full-Time}` | `{employee}` | `dashboard, projects` | `portal, mail, chat, admin` |
| `RES-FELLOW` | `research` | `{FELLOW}` | `{}` | `{researcher}` | *(none)* | `portal, mail` |
| `ENG-INTERN` | `infra` | `{INTERN}` | `{Internship}` | `{employee}` | *(none)* | `portal, mail` |
| `ORG-AMBASSADOR` | *(any)* | `{CAMPUS_AMBASSADOR}` | `{}` | *(none)* | *(none)* | `portal` |
| `ORG-CONTRACT` | *(any)* | `{CONTRACTOR}` | `{Contract}` | *(none)* | *(none)* | `portal, mail` |

**Interns and contractors get strictly less than employees. Here is the difference, written out.**

```
ENG-SENIOR  \ ENG-INTERN   = admin sections { projects, helpdesk, assets }, app systems { chat, admin }
ENG-GENERAL \ ENG-INTERN   = admin sections { projects },                   app systems { chat, admin }
ENG-GENERAL \ ORG-CONTRACT = rbac role { employee }, admin sections { dashboard, projects },
                             app systems { chat, admin }
```

Four rules make that structural rather than habitual, and each is a conformance test (§25):

- **No profile for a non-employment-backed type lists the `employee` rbac role.** Only `EMPLOYEE` and
  `INTERN` identities are employment-backed (§5.6), and every `/portal/employee/*` surface resolves
  through `requireEmployee()`, which needs an `hr_employees` row. Handing that role to a contractor
  produces a workspace whose only sentence is *"No employee record is linked to this account."*
- **`admin_section_keys` MUST be empty** for `INTERN`, `CONTRACTOR`, `CONSULTANT`,
  `CAMPUS_AMBASSADOR` and `OTHER_AUTHORIZED_IDENTITY`.
- **`'admin'` MUST NOT appear in `app_system_keys`** for those five types, and MUST appear on any
  profile whose `admin_section_keys` is non-empty — otherwise sections are granted and unreachable.
- **No profile may list `superadmin` in `rbac_role_keys`.** `administer` is the god capability; a
  human grants it to a named person, a derivation never does.

An empty `rbac_role_keys` is a deliberate answer, not an omission: `resolvePrincipal()` gives a
signed-in account with no assignment the minimal `applicant` role. A campus ambassador's portal comes
from §15's identity matrix, not from a capability role.

### 14.8 Three distinctions this section exists to preserve

| Distinction | What goes wrong without it | Enforcement point |
|---|---|---|
| **Department is not Permission** | "She is in Engineering, so she can see Engineering's data" becomes a capability test that no permission table records and no audit row explains. | Department appears only as `departmentFilter()` in a WHERE clause (`src/lib/auth/workspace-access.ts`) — a helper that returns `false`, never `true`, so a mistake yields an empty list rather than a whole table. Backed by §14.4's prohibition on `conditions.institutionId`. |
| **Role is not unlimited access** | One `administer` holder per team, then two, and the console becomes the permission model. | `src/lib/rbac/engine.ts` Tier 1: a deny grant overrides `administer`. `src/lib/rbac/roles.ts`: only `superadmin` carries it. §14.7: no profile may seed it. `applyRolePermissions()` writes an exact set, so a role's sections shrink the moment the list does. |
| **Selection Code is not administrative permission** | The most damaging version: an authorization code is read as proof of standing, and redeeming it grants access. | `tos_auth_code` redemption produces exactly one thing — a `tos_onboarding_grant` (§4.6) whose only power is to open the onboarding form for two hours. **MUST**: no code path may read `tos_auth_code` or `tos_onboarding_grant` and write `rbac_user_roles`, `rbac_permission_grants`, `role_permissions`, `role_permission_grants` or `user_role_assignments`. Access begins at `provisionIdentity()` and nowhere else, after an identity exists and is `active`. §25 asserts the pairing never occurs. |

---

## 15. Internal portal activation [brief §23]

The portal is one URL space, not one product. What lights up in it is decided per request from the
**identity**, never from `users.role` alone and never from anything the browser sent.

### 15.1 The activation matrix

Identity types are §5.6's vocabulary, abbreviated in the column heads: **EMP** `EMPLOYEE`,
**INT** `INTERN`, **FEL** `FELLOW`, **MEM** `MEMBER`, **CAM** `CAMPUS_AMBASSADOR`,
**CON** `CONTRACTOR`, **CNS** `CONSULTANT`, **OTH** `OTHER_AUTHORIZED_IDENTITY`.

Cell values: `own` — their own rows only. `lead` — additionally the one department the org graph says
they lead. `read` — read-only. `—` — **absent**, not disabled (§15.3).

| Module | Surface | New? | EMP | INT | FEL | MEM | CAM | CON | CNS | OTH |
|---|---|---|---|---|---|---|---|---|---|---|
| Personal profile | `/portal/profile`, `/portal/employee/profile`; `/portal/identity` for the rest | partly new | own | own | own | own | own | own | own | own |
| Department | `/portal/organization` | existing | own | own | read | — | — | read | read | — |
| Team | `/portal/team`, `/portal/team-groups` | existing | lead | — | — | — | — | — | — | — |
| Projects | `/portal/employee/projects` | existing | own | own | — | — | — | — | — | — |
| Tasks | `/portal/tasks` | existing | own | own | — | — | — | — | — | — |
| Documents | `/portal/employee/documents`; otherwise the read-only panel on `/portal/identity` | partly new | own | own | read | read | read | read | read | read |
| Policies | `/portal/policies` | **new** | read | read | read | read | read | read | read | read |
| Communication | `/portal/mail`, `/portal/messages`, `/portal/discussion`, `/portal/feed` | existing | own | own | own | messages only | messages only | own | own | messages only |
| Internal opportunities | `/portal/jobs` | existing (extend) | own | own | own | own | own | own | own | own |
| Learning | `/portal/employee/learning`, `/portal/employee/knowledge`, `/portal/library` | existing | own | own | read | read | read | read | read | read |
| Performance | `/portal/employee/performance` | existing | own | own | — | — | — | — | — | — |
| Attendance and work records | `/portal/employee/attendance`, `/portal/employee/timesheet`, `/portal/worklog` | existing | own | own | — | — | — | — | — | — |
| Leave and availability | `/portal/employee/leave`, `/portal/employee/schedule`, `/portal/employee/calendar` | existing | own | own | — | — | — | — | — | — |
| Access requests | `/portal/access-requests` | **new** | own | own | own | own | own | own | own | own |
| Support | `/portal/employee/support` (EMP, INT), `/portal/hr-support` (everyone) | existing | own | own | own | own | own | own | own | own |

**The right-hand columns collapse for a mechanical reason, not a policy preference.** Every
`/portal/employee/*` surface, and `/portal/tasks`, resolve through `requireEmployee()` /
`requireIntern()` in `src/lib/auth/workspace-access.ts`, which needs an `hr_employees` row, and every
`hr_*` table is keyed by `employee_id`. Only `EMPLOYEE` and `INTERN` identities are employment-backed
(§5.6). A fellow has no attendance row to show because a fellow has no employment record — and
**MUST NOT** be given one to make a page render. Minting `hr_employees` rows for contractors and
ambassadors so that a menu looks complete would put non-employees into payroll, headcount, statutory
and offboarding reports that all read that table.

**Internal opportunities is the one module that needs extending rather than reusing.** `/portal/jobs`
today lists what is open. It **MUST** filter on §7's eligibility: `tos_opportunity.internal_eligible`,
`internal_identity_types` (empty means every internal type), `min_tenure_days` against
`tos_identity.started_on`, and `requires_manager_consent`. An opportunity a person cannot apply for
is not listed with a disabled button — see §15.3.

**Copy rule for the internship rows.** Where a surface states terms, `tos_selection.stipend_amount`
being `NULL` means **unpaid**, and the copy says so plainly — *"This internship is unpaid."* Never
"stipend to be confirmed", never a blank field [brief §19, §10].

### 15.2 Personalisation resolves server-side, on every request

**MUST**: identity and modules are resolved on the server, from the session, on every request. No
module list is cached at module scope, put in a cookie, embedded in a `define:vars` payload, or sent
to the client for filtering. A cache in a long-lived server process is how one person's portal gets
rendered for another; a client-side filter is a list of everything plus a request not to look.

```ts
// src/lib/talentos/portal-gate.ts
export interface PortalIdentity {
  id: string;                    // tos_identity.id
  personId: string;
  identityCode: string;
  identityType: string;
  departmentId: string | null;   // TEXT. Never ::uuid.
  isEmploymentBacked: boolean;   // identity_type is EMPLOYEE or INTERN
  employeeId: string | null;     // hr_employees.id, only when employment-backed
}

export type IdentityGate =
  | { ok: true;  identity: PortalIdentity; modules: Set<string>; redirect: null; title: null; reason: null }
  | { ok: false; identity: null; modules: Set<string>; redirect: string | null; title: string; reason: string };
```

`requireIdentity(user, next)` resolves in this order and **fails closed at every step**, returning an
**empty** `modules` set on any denial so a page that forgets to check `ok` renders nothing:

1. No session → redirect to `/portal/login?next=…`.
2. `users.is_active === false` → denial. A deactivated account keeps its role; the role is not the
   answer.
3. Person resolves (§5.3) → otherwise denial.
4. Exactly one `tos_identity` for that person with `status = 'active'` → otherwise denial. Two active
   primaries cannot exist: `tos_identity_one_primary` enforces it in the database (§4.1).
5. Modules are computed from `identity_type` (§15.1) intersected with the identity's access profile
   `app_system_keys`, then narrowed to what actually exists: `employeeId` is null → every
   employment-backed module is dropped, whatever the profile says.
6. Any thrown error → denial with `title` and `reason` a person can act on, logged with
   `e?.cause?.message || e?.message`.

Steps 5 and 6 are the reason the gate returns a set rather than a boolean: the same call answers "may
this person be here" and "what may they see", so the page and its menu cannot disagree.

### 15.3 A module a person may not use is ABSENT

**MUST NOT** render a link, a tab, a card or a heading for a module a person may not use — not
greyed out, not with a padlock, not with "request access". A visible link is a disclosure: it names
an internal system, its URL and the fact that somebody here has it, to a person the system has just
decided should not.

`src/lib/admin-nav.ts` already implements exactly this and is the model to follow, point for point:

- an entry whose gating key is missing is **hidden**, so forgetting to describe a new entry
  under-exposes it instead of showing it to everyone;
- **a group with no visible children is dropped**, because an expandable heading that opens onto
  nothing tells somebody a section exists while refusing to let them into it;
- any resolution that is not a clean `ok` returns a **failsafe** list, not the full tree;
- the menu **mirrors the door**. A link the gate will refuse is worse than no link.

`src/lib/talentos/portal-nav.ts` is that module for the portal:

```ts
export interface PortalNavItem {
  id: string;
  label: string;
  href: string;
  icon: string;      // resolved by CSS from a name; an inline monochrome SVG in the layout. No emoji.
  module: string;    // REQUIRED. The §15.1 module key this entry is gated on.
}

/** One entry, for one resolved module set. An entry with no module key is hidden. */
export function canSeePortalItem(item: PortalNavItem, modules: Set<string>): boolean {
  if (!item || !item.id) return false;
  if (!item.module) return false;
  return modules.has(item.module);
}

/** THE ONE IMPLEMENTATION. Groups with no visible children are dropped, not rendered empty. */
export function navForModules(entries: PortalNavEntry[], modules: Set<string>): PortalNavEntry[] {
  const out: PortalNavEntry[] = [];
  for (const entry of entries || []) {
    if (!entry) continue;
    if (isPortalGroup(entry)) {
      const children = (entry.children || []).filter((c) => canSeePortalItem(c, modules));
      if (children.length === 0) continue;
      out.push({ ...entry, children });
    } else if (canSeePortalItem(entry, modules)) {
      out.push(entry);
    }
  }
  return out;
}

/** What is left when the answer cannot be computed: the person's own identity page and nothing else. */
export const FAILSAFE_PORTAL_IDS: readonly string[] = ['identity'];
```

The same rule applies **inside** a page, not only in the sidebar: a `/portal/jobs` entry the person
is not eligible for is not listed; a document panel for an identity type that has no documents is not
rendered with "none yet". An empty state is a claim about the person's own data, and printing it over
a module they were refused is a different sentence than the one it appears to be.

### 15.4 The genuinely new surfaces

Everything else in §15.1 exists. These four do not:

| Surface | What it is | Notes |
|---|---|---|
| `/portal/identity` | The identity home for anyone who is not employment-backed: identity code, type, department, dates, the read-only document panel, and the link to access requests. | The one page `FAILSAFE_PORTAL_IDS` keeps, so a person is never looking at a blank portal with no explanation. |
| `/portal/policies` | Policies as an ordered, versioned list with a recorded acknowledgement per identity. | Documents are **links**, not uploads (§12.5). |
| `/portal/access-requests` | §14.6, from the requester's side. | |
| `src/lib/talentos/portal-nav.ts` + `portal-gate.ts` | The gate and the menu, as one answer. | Not a page, but the thing without which the other three leak. |

### 15.5 What no portal or oversight surface may render

- **Never a row per person of individual health data.** `hr_employees.blood_group` and
  `date_of_birth` are HR record fields, readable by the person they describe on their own profile.
  They are **not** columns on a team list, a department roster, an ambassador board or any export.
  `EMPLOYEE_COLUMNS` in `src/lib/auth/workspace-access.ts` is the allowlist, and it deliberately
  omits gender, government identifiers, bank fields and salary. Extending it re-creates the
  2026-08-02 exposure.
- **Never a `wellness_*` table** from behind any of these gates, in any join, count or existence
  check. Oversight is aggregate-only and suppresses groups below `MIN_GROUP`; a screen that needs one
  row per user is the screen that must not exist.
- **Never `hr_clock_events`** for anyone but the signed-in person — it stores GPS, IP, device and a
  selfie per punch. A lead who needs attendance reads `hr_attendance` (status and hours).
- **Never a competitor or outside company name** in portal copy. Recruitment channels on
  `/portal/jobs` render from `application_sources` rows, from data, never from markup.

---

## 16. Route map [brief §3, §4, §35]

### 16.1 The entry experience — `/careers/[slug]/apply`

One screen stands between an opportunity page and everything downstream of it. It exists because
the word **apply** means two unrelated things in this product [brief §5], and a person who guesses
wrong produces the failure this whole specification exists to prevent: an application *and* a
selection for one human, which then disagree.

| Meaning | `tos_application_link.pathway` | What actually happens |
|---|---|---|
| I want to be considered | `recruitment` | A new `applications` row, the seven-stage evaluation, a decision |
| I have already been chosen | `direct_onboarding` | No application. A code is redeemed and the joining form opens |

**Two questions, in this order, and no third.**

1. Do you already work with EduRankAI, or hold an EduRankAI account?
2. Were you told you had been chosen, and sent a code?

**REASON for the order.** Question 1 changes what question 2 *means* — an internal person redeeming
a code is moving between engagements, an external person redeeming one is joining — and it is the
question a person can answer without thinking. Asking for the code first makes the screen read as a
gate, and a gate is what people abandon.

#### 16.1.1 Branching

Four combinations. The branch is computed by `POST /api/talent/entry/resolve` (§16.3) and **never**
by the page.

| Q1 (existing person) | Q2 (has a code) | Server returns `next` | Meaning shown |
|---|---|---|---|
| No | No | `/apply/step-1?opportunity=<role_id>` | `recruitment_application` |
| No | Yes | `/onboarding/code?opportunity=<role_id>` | `onboarding_after_selection` |
| Yes | No | `/apply/step-1?opportunity=<role_id>` (sign-in first if no live session) | `recruitment_application` |
| Yes | Yes | `/onboarding/code?opportunity=<role_id>` | `onboarding_after_selection` |

**MUST**: a failed code never falls through to the application path. It stays on this screen with a
reason. A person whose code was merely mistyped, silently dropped into the ordinary funnel, ends the
day with an application *and* a selection.

**MUST**: answering "yes" to question 1 does not grant anything. It only decides which sign-in the
person is offered. Internal eligibility is re-derived server-side from
`tos_identity.status = 'active'` and `tos_opportunity.internal_eligible` /
`internal_identity_types` — never from the answer, and never from an email domain (§5.7).

#### 16.1.2 Candidate-facing copy, in full

Every string below lives in `src/lib/talentos/entry-copy.ts` as data, is selected server-side by
§16.3, and is printed verbatim by the page. **MUST NOT** contain: emojis, the words *RBAC*, *ABAC*,
*provisioning*, *pipeline*, *stage run*, *grant*, *token*, *state machine*, or any internal state
name [brief §35]. **MUST NOT** name any outside company. **MUST NOT** claim EduRankAI awards a
credential.

**Page heading and standfirst (always shown)**

> **Applying for {role.title}**
> Two questions before you start, so we send you to the right place. It takes about ten seconds.

**Question 1 (legend and options)**

> **Do you already work with EduRankAI?**
> Count yourself in if you are an employee, an intern, a fellow, a member, a campus ambassador, or
> anyone else who holds an EduRankAI account.
> - No, this is my first time
> - Yes, I already have an EduRankAI account

**Question 2 (legend and options)**

> **Were you told you had been chosen, and sent a code?**
> We send a code only after someone has completed our evaluation and a person here has decided to
> take them on. If nobody has told you that, the answer is no — and no is the ordinary answer.
> - No, I am applying to be considered
> - Yes, I have a code

**State A — external, no code (submit result)**

> **You are applying to be considered.**
> This opens the application form for {role.title}. A person reads every application. You will be
> told what happens next, and you will get a written answer either way.
> Button: *Start my application*

**State B — internal, no code (signed in)**

> **You are applying to be considered for a different role.**
> Your current work with us continues unchanged while this is considered. Your name, your
> department and your current role come from your record, so you do not retype them.
> Button: *Start my application*

**State C — internal, no code, not signed in**

> **Sign in first, so we can use the record you already have.**
> That way you do not retype what we already hold, and your application is attached to you rather
> than to a new name that happens to match.
> Button: *Sign in and continue*

**State D — has a code (either answer to question 1)**

> **You are joining, not applying.**
> There is no application form. Enter the code we sent you and we will open the joining form for
> {role.title}. It asks for your own details and for links to your documents.
> Button: *Enter my code*

**State E — code accepted (shown on `/onboarding/code`, included here because it completes the
journey)**

> **Code accepted. Welcome.**
> The joining form for {role.title} is open. You can save and come back — nothing is lost if you
> close this page. Some details are already filled in and cannot be changed here, because they were
> decided when you were chosen. If any of them is wrong, there is a link beside it to tell us.

**Error and refusal copy.** One message per situation, all in the second person, none naming an
internal state.

| Situation | Copy |
|---|---|
| Code not recognised | **That code did not work.** Check it for a typed character, and check you are using the address the message came to. If it still does not work, write to the people desk and quote your name and the role — we will look it up. |
| Code expired | **That code did not work.** *(identical text — see the disclosure rule below)* |
| Code already used, same person | **You have already started.** Picking up where you left off. |
| Code already used, different address | **That code did not work.** *(identical text)* |
| Too many attempts | **Too many tries.** For safety we have paused code entry from here for {minutes} minutes. Nothing is lost — try again after that, or write to the people desk. |
| Applications closed for this opportunity | **This one has closed.** We are no longer taking applications for {role.title}. Other open roles are listed on the careers page. |
| Opportunity is internal only, visitor is external | **This one is open to people already working with us.** Our open roles are listed on the careers page. |
| Already applied to this opportunity | **You have already applied for this.** You can follow it in your account rather than starting again. |
| Person exists but email is unverified | **Confirm your email first.** We have sent a link to {masked email}. Open it and this page will continue. |
| Service unavailable | **We cannot open this right now.** Nothing you typed has been lost. Please try again in a few minutes. No application or code is affected. |

**REASON the first four rows share one sentence.** Different wording per cause tells an attacker
whether a code exists, which of them is live, and which address it is bound to. The administrator
sees the true cause on `/admin/talent/codes` (§18.3); the person at the keyboard is given a route to
a human instead.

**Stipend and positioning copy that MUST appear where relevant** [brief §5, §10]:

> This is an unpaid internship. No stipend is recorded for it.

rendered when, and only when, `tos_selection.stipend_amount IS NULL` for an internship engagement.
Where an amount is recorded, print the amount and the currency and nothing else — no range, no word
like *competitive*. And on every candidate-facing surface in this flow: EduRankAI is the technology
platform; where a credential is involved it is awarded by an accredited partner. No copy here says
*degree*, *university*, or *we certify*.

#### 16.1.3 Markup structure and accessibility

```
main
  h1                      "Applying for {role.title}"
  p                       standfirst
  div[role=alert]         error region, aria-live="assertive", empty on first render, NOT hidden
                          from the accessibility tree when empty
  form (novalidate, posts to /api/talent/entry/resolve via fetch)
    fieldset
      legend              Question 1
      input[type=radio] + label   x2   (name="existing", required, first is NOT preselected)
    fieldset
      legend              Question 2
      input[type=radio] + label   x2   (name="has_code", required, neither preselected)
    div[data-outcome]     server-supplied headline + body, populated after resolve
    button[type=submit]   server-supplied label
  aside                   "What happens after you apply" - static, links to the careers page
```

- **Focus order** is document order: h1 (programmatically focusable, `tabindex="-1"`, focused on
  load), error region, Q1 radios, Q2 radios, outcome, button. On a refusal, focus moves to the error
  region; on an accepted resolve, focus moves to the outcome block before the button label changes.
- **Neither radio group is preselected.** A preselected "No, this is my first time" is an answer the
  system supplied on the person's behalf, and it is the wrong answer for every internal applicant.
- Radio groups are real `fieldset`/`legend`, not `div` + `aria-label`, so a screen reader announces
  the question with each option.
- Every icon is inline monochrome SVG with `aria-hidden="true"`. No emoji anywhere.
- The submit button is never the only signal: the outcome block states in words which of the two
  meanings of *apply* the person is about to enter.
- Colour is never the only carrier of the error state; the error region carries a heading.

#### 16.1.4 `.astro` constraints for this page

- File path: `src/pages/careers/[slug]/apply.astro`. It coexists with the existing
  `src/pages/careers/[slug].astro` — Astro routes `/careers/x` to the latter and `/careers/x/apply`
  to the former, so `[slug].astro` is **not** restructured.
- Every `const` is declared in frontmatter **before** anything that reads it. This page has no `POST`
  handler (it posts to §16.3), but the rule stands for the frontmatter itself: a `const` referenced
  above its declaration throws on the first line of the page and has taken `/admin` down here before.
- **No `<` or `<=` inside JSX expressions.** Deadline proximity, character counts and "fewer than N
  days left" are computed in frontmatter into a boolean:

```astro
---
// Declared before any use. Order matters: `const` is not hoisted.
import BaseLayout from '@/layouts/BaseLayout.astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const slug = String(Astro.params.slug || '');
const user = Astro.locals.user || null;

const r = await db.execute(sql`
  SELECT r.id, r.title, r.slug, r.application_deadline, r.is_open,
         o.applications_open, o.external_eligible, o.internal_eligible
  FROM roles r LEFT JOIN tos_opportunity o ON o.role_id = r.id
  WHERE r.slug = ${slug} LIMIT 1`);
const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
const role = rows[0] || null;

const deadlineMs = role?.application_deadline ? new Date(role.application_deadline).getTime() : 0;
const daysLeft = deadlineMs ? Math.ceil((deadlineMs - Date.now()) / 86400000) : null;
// Hoisted comparison: `daysLeft <= 7` MUST NOT appear inside JSX.
const closingSoon = daysLeft !== null && daysLeft > 0 && daysLeft < 8;
const isOpen = !!role?.is_open && role?.applications_open !== false;
const signedIn = !!user;
---
```

- No `Record<string,string>`-typed map is declared inside JSX; the copy table is imported from
  `entry-copy.ts` and indexed in frontmatter.
- No arrow characters (`→`) in JSX strings; use the word.
- `define:vars` is not combined with `is:inline`. The single `<script>` on this page sits at the
  bottom of the template at top level — **never** inside a JSX conditional, which breaks parsing.
- A failed lookup renders "We cannot open this right now" (the copy above) and sets the
  `x-era-degraded` header. It **MUST NOT** render an empty or "no such role" page: those are
  different facts and the middleware pins a degraded response at the edge otherwise.

---

### 16.2 The full route table

`NEW` and `EXISTING` are judged against §1.3. "Unauthorised visitor" describes the observable
behaviour, which is a specification, not an implementation detail.

**Public**

| Route | | Purpose | Guard | Unauthorised visitor |
|---|---|---|---|---|
| `/careers` | EXISTING | Opportunity index | none | — |
| `/careers/[slug]` | EXISTING | Opportunity detail | none | — |
| `/careers/[slug]/apply` | **NEW** | §16.1 entry screen | none; opportunity must be public and open | Closed or internal-only renders the refusal copy at 200, not a 404 |
| `/careers/campus-ambassador`, `/careers/membership`, `/careers/hr-support`, `/careers/fee-waiver` | EXISTING | Other intake surfaces | none | — |

**Recruitment application (the "considered" meaning)**

| Route | | Purpose | Guard | Unauthorised visitor |
|---|---|---|---|---|
| `/apply` | EXISTING | Legacy entry; redirects | none | — |
| `/apply/gateway` | EXISTING (not listed in §1.3; it is live) | The un-scoped front door | none | — |
| `/apply/step-1` … `/apply/step-6` | EXISTING | The application funnel | none; draft keyed by email | — |
| `/apply/waiver`, `/apply/pay`, `/apply/confirmation` | EXISTING | Fee handling and completion | none | — |

**MUST**: `/careers/[slug]/apply` supersedes `/apply/gateway` **as the opportunity-scoped entry**.
`/apply/gateway` is kept, and its "I have a code" door **MUST** be re-pointed at §16.3 so there is
one decision, not two. Two front doors that each decide is how the same person gets two answers.

**Code-authorised onboarding (the "chosen" meaning) — no account required**

| Route | | Purpose | Guard | Unauthorised visitor |
|---|---|---|---|---|
| `/onboarding/code` | **NEW** | Code entry | none; rate limited per §17 | — |
| `/onboarding` | **NEW** | The joining form, one section at a time | Valid `tos_onboarding_grant` cookie | 302 to `/onboarding/code?reason=expired`; never a 403, which confirms a form exists |
| `/onboarding/status` | **NEW** | Read-only progress after submission | Same grant, or a session whose person matches `tos_onboarding.person_id` | 302 to `/onboarding/code` |
| `/onboarding/correction` | **NEW** | Raise a correction on a locked field | Same grant | 302 to `/onboarding/code` |

**REASON these are not under `/portal`.** The person has no account yet. A grant scoped to
`/onboarding/*` and nothing else is the smallest thing that works; the moment onboarding routes live
under a session-protected prefix, somebody creates an account to make it work and the account
becomes the identity — which §5.2 forbids.

**Signed-in candidate**

| Route | | Purpose | Guard | Unauthorised visitor |
|---|---|---|---|---|
| `/portal/login` | EXISTING | Sign-in | none | — |
| `/portal/applications` | EXISTING | Status across applications | Session; ownership in the query | 302 `/portal/login?next=…` |
| `/portal/applications/[id]` | EXISTING | One application, six-step tracker | Session + ownership | Unowned and non-parsing ids return the identical 404 |
| `/portal/history` | **NEW** | The person's consolidated history [brief §24] | Session; resolved to `tos_person` | 302 `/portal/login?next=/portal/history` |
| `/portal/employee`, `/portal/organization` | EXISTING | Identity-holder surfaces | Session + active `tos_identity` | 302 `/portal/login` |

`/portal/history` is the answer to "what has this human ever done with us": every
`tos_application_link` row for the person with its opportunity and outcome, every `tos_selection`,
every `tos_onboarding`, and every `tos_identity` past and present — **one page, one person, no
duplicates**. It is the candidate-facing counterpart of §18.2 and it is what makes the
"three unrelated records for one human" failure visible to the human themselves.

**Internal sign-in**

| Route | | Purpose | Guard | Unauthorised visitor |
|---|---|---|---|---|
| `/portal/login?next=/careers/[slug]/apply` | EXISTING | The internal path out of §16.1 State C | none | — |
| `/admin/login` | EXISTING | Administrative sign-in | none; the single middleware exemption | — |

**MUST NOT** add a separate "internal applicant" sign-in. One account system, one sign-in; the
`next` parameter carries the person back. A second sign-in page is a second session rule.

**Admin** — all under the existing middleware gate; section keys per §18.1.

| Route | | Purpose | Guard (section) | Unauthorised visitor |
|---|---|---|---|---|
| `/admin/talent` | **NEW** | Console dashboard | `talent` | 302 `/admin?denied=talent` |
| `/admin/talent/opportunities` (+`/[roleId]`) | **NEW** | Opportunity config, pipeline binding | `talent` | 302 `/admin?denied=talent` |
| `/admin/talent/candidates` (+`/[personId]`) | **NEW** | Person-centred view; §18.2 panel | `talent` | 302 `/admin?denied=talent` |
| `/admin/talent/evaluation` | **NEW** | Stage boards and evaluator queues | `talent` | 302 `/admin?denied=talent` |
| `/admin/talent/selection` | **NEW** | Record selection decisions | `talent` | 302 `/admin?denied=talent` |
| `/admin/talent/sources` | **NEW** | Channel registry over `application_sources` | `talent` | 302 `/admin?denied=talent` |
| `/admin/talent/selected` | **NEW** | Authorised-for-onboarding console | `talent_onboarding` | 302 `/admin?denied=talent_onboarding` |
| `/admin/talent/codes` | **NEW** | §18.3 codes screen | `talent_onboarding` | 302 `/admin?denied=talent_onboarding` |
| `/admin/talent/onboarding` (+`/[id]`) | **NEW** | Verify and approve | `talent_onboarding` | 302 `/admin?denied=talent_onboarding` |
| `/admin/talent/identity` (+`/[id]`) | **NEW** | Identity registry | `talent_identity` | 302 `/admin?denied=talent_identity` |
| `/admin/talent/access` | **NEW** | Access profiles, provisioning queue | `talent_access` | 302 `/admin?denied=talent_access` |
| `/admin/applications` (+`/[id]`) | EXISTING | Application-centred pipeline | `applications` | 302 `/admin?denied=applications` |
| `/admin/roles` (+`/[id]`, `/new`) | EXISTING | Opportunity catalogue | `roles` | 302 `/admin?denied=roles` |
| `/admin/application-sources` | EXISTING | Channel rows and moderated suggestions | `hr` | 302 `/admin?denied=hr` |
| `/admin/departments`, `/admin/org/structure` | EXISTING | Departments, teams, positions | `departments` | 302 `/admin?denied=departments` |
| `/admin/org/graph` | EXISTING | Relationship graph | `employees` | 302 `/admin?denied=employees` |
| `/admin/hr/employees`, `/admin/hr/onboarding` | EXISTING | Employment record, joining documents | `employees` | 302 `/admin?denied=employees` |
| `/admin/team/roles`, `/admin/rbac` | EXISTING | Capability administration | `team_roles` | 302 `/admin?denied=team_roles` |
| `/admin/access-preview` | EXISTING | What a role would see | `team_roles` | 302 `/admin?denied=team_roles` |
| `/admin/audit` | EXISTING | Audit log | `audit` | 302 `/admin?denied=audit` |

Three guard layers already exist and **MUST NOT** be re-implemented per page: signed-out on any
`/admin/*` except `/admin/login` is 302 to `/admin/login`; an applicant is 302 to `/portal`;
`canOpenAdmin()` refuses by default; then the section gate redirects to `/admin?denied=<key>`.
`/api/*` is **not** covered by any of it — see §17.

---

### 16.3 The decision endpoint

**Exactly one server endpoint decides which path a person is on** [brief §29]. It returns a route.
The client navigates to it and computes nothing.

**MUST NOT**, anywhere in the browser: read a cookie to decide a destination; branch on
`user.role`; branch on an email domain; hold a boolean called `isSelected`, `hasCode`, `isInternal`
or `eligible` that drives a redirect; or reconstruct the copy for a state the server did not return.

**MUST**: the response carries the destination **and the words**. A page that picks its own sentence
for a server-decided state will eventually print the wrong one, and the wrong one here reads as
"you have been selected" to somebody who has not been.

```ts
// src/lib/talentos/entry.ts — the only implementation of this decision.
export type EntryMeaning = 'recruitment_application' | 'onboarding_after_selection';

export interface EntryDecision {
  ok: true;
  /** Absolute same-origin path. The browser does exactly this and nothing else. */
  next: string;
  meaning: EntryMeaning;
  /** Copy chosen server-side from entry-copy.ts. Printed verbatim. */
  headline: string;
  body: string;
  cta: string;
  /** Present when the answer is "you cannot go anywhere from here". `next` is then ''. */
  blocked?: { code: EntryBlockCode; headline: string; body: string; contact: string };
}
```

Resolution order, server-side, stopping at the first that applies:

1. Opportunity exists, `roles.is_open`, `tos_opportunity.applications_open`, and now is inside
   `opens_at`/`closes_at` — otherwise `blocked: OPPORTUNITY_CLOSED`.
2. Resolve the person by §5.3 (session first, then verified email, then unverified email, then new).
   Never by name or phone.
3. If the visitor declared "existing person" and has no live session -> `next = /portal/login?next=…`,
   meaning `recruitment_application`, State C copy.
4. Re-derive internal standing from `tos_identity` (`status='active'`), **not** from the answer. An
   external visitor against an `internal_eligible`-only opportunity -> `blocked: INTERNAL_ONLY`.
5. If the visitor declared a code -> `next = /onboarding/code?opportunity=<role_id>`, meaning
   `onboarding_after_selection`. **No code is validated here.** Validation is §17's
   `/api/talent/code/verify`, so this endpoint stays unauthenticated, cheap and un-enumerable.
6. If a live `tos_application_link` already exists for this person and opportunity ->
   `blocked: ALREADY_APPLIED`.
7. Otherwise `next = /apply/step-1?opportunity=<role_id>`, meaning `recruitment_application`.

```ts
// Sketch of the read the decision hangs on. postgres-js returns a plain array.
const r = await db.execute(sql`
  SELECT r.id AS role_id, r.is_open,
         COALESCE(o.applications_open, TRUE)  AS applications_open,
         COALESCE(o.external_eligible, TRUE)  AS external_eligible,
         COALESCE(o.internal_eligible, TRUE)  AS internal_eligible,
         o.opens_at, o.closes_at
  FROM roles r
  LEFT JOIN tos_opportunity o ON o.role_id = r.id
  WHERE r.slug = ${slug}
  LIMIT 1`);
const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
const opp = rows[0] || null;                       // never r.rows[0]
if (!opp) return blocked('OPPORTUNITY_CLOSED');
```

Failures are logged as `e?.cause?.message || e?.message` and answered with
`blocked: SERVICE_UNAVAILABLE` at HTTP 503. **A decision endpoint that cannot read the database
MUST NOT default to the application path.** Failing open here creates the duplicate record the
whole design is built to avoid.

---

## 17. API contracts

### 17.0 Shared conventions

**Envelope.** Every endpoint answers JSON, `Cache-Control: no-store`, and exactly one of:

```ts
type Ok<T>  = { ok: true }  & T;
type Err    = { ok: false; error: { code: string; message: string; field?: string } };
```

`error.message` is candidate-safe prose (§16.1.2 rules apply to every public endpoint). It is never
a SQL string, never a stack, and never the value of `e.message` — which on this stack is the failed
statement. Log `e?.cause?.message || e?.message`; return the written sentence.

**Authorisation is re-derived, always.** `/api/*` is not covered by the `/admin` middleware gate in
this codebase. Every endpoint's first statements are: read the session, resolve the actor, check the
capability with `can(user, '<key>')`, then apply the row scope **in SQL**. A request body **MUST
NOT** be trusted for any field naming a person, an opportunity, an identity, a capability or a
state. Concretely:

- `personId` in a body is a *lookup argument*, never proof of ownership. Ownership is
  `tos_application_link.person_id = <person resolved from the session or the grant>`.
- `role`, `identityType`, `isInternal`, `isSelected`, `stage`, `outcome` sent by a client are
  ignored where the server can derive them, and rejected with `E_DERIVED_FIELD` where a client sent
  one it must not set at all.
- `capability`, `sectionKey`, `rbacRoleKey` are read from `tos_access_profile`, never from the body.

**CSRF and origin.** Every POST requires a same-origin `Origin`/`Sec-Fetch-Site` check; admin POSTs
additionally require the session cookie to be `SameSite=Lax` or stricter. A cross-site POST is
`E_BAD_ORIGIN` / 403.

**Idempotency.** Every state-changing **admin** endpoint accepts and requires an `Idempotency-Key`
header (a client-generated UUID). A replay with the same key and the same body returns the stored
response; the same key with a different body is `E_IDEMPOTENCY_MISMATCH` / 409.

```sql
-- ensureOnce('tos_idempotency_v1', ...). Mirror in db/talent-os-schema.sql.
CREATE TABLE IF NOT EXISTS tos_idempotency (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint       TEXT NOT NULL,
  idem_key       TEXT NOT NULL,
  actor_user_id  UUID,
  request_hash   TEXT NOT NULL,          -- sha256 of the canonicalised body
  state          TEXT NOT NULL DEFAULT 'in_flight',   -- in_flight|done|failed
  status_code    INT,
  response_body  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS actor_user_id UUID;
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS request_hash  TEXT NOT NULL DEFAULT '';
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS state         TEXT NOT NULL DEFAULT 'in_flight';
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS status_code   INT;
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS response_body JSONB;
ALTER TABLE tos_idempotency ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS tos_idempotency_uq  ON tos_idempotency (endpoint, idem_key);
CREATE INDEX        IF NOT EXISTS tos_idempotency_age ON tos_idempotency (created_at);
```

**REASON idempotency is a table and not an in-memory map.** This deploys serverless; two concurrent
invocations do not share a process. A double-clicked "Issue code" that mints two codes for one
selection is the exact class of defect this project has already shipped.

**Rate limiting.** Code redemption counts through `tos_code_attempt` (§4.5) and nothing else — the
abuse board reads that table. Every other limited endpoint counts through:

```sql
-- ensureOnce('tos_rate_event_v1', ...)
CREATE TABLE IF NOT EXISTS tos_rate_event (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket     TEXT NOT NULL,       -- the endpoint name
  subject    TEXT NOT NULL,       -- 'ip:203.0.113.4' | 'person:<uuid>' | 'grant:<uuid>'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_rate_event ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS tos_rate_event_idx ON tos_rate_event (bucket, subject, created_at DESC);
```

A limited response is HTTP 429 with `Retry-After` in seconds. **The limiter runs before any lookup**
on unauthenticated endpoints, so a brute-force run is refused without touching the code table.

**Audit.** Every endpoint below names the action it writes through
`logAudit({ userId, action, entity, entityId, diff, ipAddress })`. A write whose audit insert fails
is still a write — but every **sensitive** action in this section uses `logAuditOrThrow` and fails
the request rather than proceeding unlogged.

---

### 17.1 Endpoints

#### POST `/api/talent/entry/resolve` — the §16.3 decision

| | |
|---|---|
| **Auth** | None. Uses the session when one exists; never requires one. |
| **Rate limit** | 30 / minute / IP (`tos_rate_event`, bucket `entry.resolve`). |
| **Side effects** | May create a `tos_person` + unverified `tos_person_email` (§5.3 step 4). Nothing else. |
| **Audit** | `talent.entry.resolved`, entity `tos_person`, diff `{ slug, meaning, blocked }`. |

```ts
interface EntryResolveRequest {
  slug: string;                 // roles.slug from the URL. Not roles.id: the id is not public.
  existingPerson: boolean;      // answer to question 1
  hasCode: boolean;             // answer to question 2
  email?: string;               // required when there is no session
}
type EntryResolveResponse = EntryDecision | Err;   // EntryDecision defined in §16.3
```

| Code | HTTP | When |
|---|---|---|
| `E_BAD_REQUEST` | 400 | Missing or non-boolean answers; malformed email |
| `E_OPPORTUNITY_CLOSED` | 200 with `blocked` | Not open, outside the window, or not public |
| `E_INTERNAL_ONLY` | 200 with `blocked` | External visitor, `external_eligible = FALSE` |
| `E_ALREADY_APPLIED` | 200 with `blocked` | A live `tos_application_link` exists for this pair |
| `E_EMAIL_UNVERIFIED` | 200 with `blocked` | §5.3 step 3 reached and verification is required |
| `E_RATE_LIMITED` | 429 | Limiter |
| `E_SERVICE_UNAVAILABLE` | 503 | Any read failure. Never falls through to a path. |

**REASON refusals are 200 with `blocked` rather than 4xx.** They are answers, not errors: the page
renders copy for each. A 4xx invites a client-side retry loop and, on a shared decision endpoint,
teaches a scraper which opportunities exist.

#### POST `/api/talent/code/verify` — the §10.3 ladder; returns a grant

| | |
|---|---|
| **Auth** | None. A session, if present, is recorded on the attempt but confers nothing. |
| **Rate limit** | 5 failures / 15 min / IP and 20 attempts / 24 h / bound email, both counted from `tos_code_attempt`. Limiter runs **first**. |
| **Side effects** | Always inserts `tos_code_attempt`. On success: increments `tos_auth_code.use_count`, sets `consumed_at` when `use_count` reaches `max_uses`, inserts `tos_onboarding_grant` (expiry = now + 2 hours), sets an HttpOnly `SameSite=Strict` cookie carrying the grant token, and creates `tos_onboarding` in state `invited` if none exists. |
| **Audit** | `talent.code.verified` (success) / `talent.code.rejected` (failure, with the true reason in `diff`), entity `tos_auth_code`. |

```ts
interface CodeVerifyRequest { code: string; email: string; opportunitySlug?: string; }
interface CodeVerifyOk {
  ok: true;
  next: '/onboarding';
  headline: string; body: string;         // State E copy, server-chosen
  onboardingRef: string;                  // tos_onboarding.onboarding_ref
  resumed: boolean;                       // true when a consumed code was re-presented by the same subject
}
```

The ladder, in order. **Every failure returns the identical body** — one sentence, one code:

| Rung | Outcome recorded on `tos_code_attempt.outcome` | Response |
|---|---|---|
| Malformed input | `malformed` | `E_CODE_INVALID` / 400 |
| Hash not found | `not_found` | `E_CODE_INVALID` / 400 |
| `revoked_at IS NOT NULL` | `revoked` | `E_CODE_INVALID` / 400 |
| `expires_at < now()` | `expired` | `E_CODE_INVALID` / 400 |
| `use_count >= max_uses` and email matches the bound person | `reuse_same_subject` | **200**, `resumed: true`, grant reissued |
| `use_count >= max_uses` and email does not match | `reuse_other_subject` | `E_CODE_INVALID` / 400, **and** a notification to People Operations |
| Selection suspended or not `is_authorised` | `not_authorised` | `E_CODE_INVALID` / 400 |
| Opportunity mismatch when `opportunitySlug` was sent | `wrong_opportunity` | `E_CODE_INVALID` / 400 |
| All pass | `accepted` | 200 |

`E_RATE_LIMITED` / 429 pre-empts every rung. `E_SERVICE_UNAVAILABLE` / 503 when the lookup itself
fails — **never** treat an unreadable code table as "no such code".

**MUST**: the code is compared by `sha256(normalise(code))` against `tos_auth_code.code_hash`.
Plaintext is never stored, never logged, never returned, and never rendered in any admin surface
(§18.3).

**MUST**: re-presenting a consumed code by the same bound subject re-establishes the session. A
browser crash mid-form otherwise destroys a person's onboarding, which is a support incident, not a
security control.

#### POST `/api/talent/apply/start` — begin a recruitment application

| | |
|---|---|
| **Auth** | None for an external applicant; a session is **required** when the resolved person holds an active `tos_identity` (internal applicants apply as themselves). |
| **Rate limit** | 5 / hour / person and 20 / hour / IP (`apply.start`). |
| **Side effects** | Creates the `applications` row through the existing application module, then exactly one `tos_application_link` with `pathway='recruitment'`, `applicant_type`, `applicant_identity_id` (when internal) and `source_slug`. Increments `application_sources.usage_count`. Seeds `tos_stage_run` rows for slots 1..7 of the bound pipeline in state `not_started`. |
| **Audit** | `talent.application.started`, entity `applications`. |

```ts
interface ApplyStartRequest {
  slug: string;
  email: string;
  displayName: string;
  phone?: string;
  sourceSlug?: string;          // application_sources.slug. Validated against is_active rows.
  sourceDetail?: string;        // required when application_sources.detail_required
}
interface ApplyStartOk { ok: true; applicationId: string; next: string; }
```

| Code | HTTP | When |
|---|---|---|
| `E_OPPORTUNITY_CLOSED` | 409 | Re-checked here; §16.3's answer is not trusted |
| `E_INTERNAL_ONLY` | 403 | `external_eligible = FALSE` and no active identity |
| `E_SIGN_IN_REQUIRED` | 401 | Resolved person is internal and there is no session |
| `E_ELIGIBILITY_FAILED` | 403 | `tos_opportunity.eligibility_rules` / `min_tenure_days` / `internal_identity_types` |
| `E_DUPLICATE` | 409 | A live `tos_application_link` already exists for the pair |
| `E_UNKNOWN_SOURCE` | 400 | `sourceSlug` is not an active `application_sources` row |
| `E_RATE_LIMITED` | 429 | Limiter |

**MUST NOT** hardcode any channel name. The source list is rendered from `application_sources`;
free text goes to `application_source_suggestions` for moderation, exactly as today.

#### POST `/api/talent/onboarding/save` — draft save

| | |
|---|---|
| **Auth** | Valid `tos_onboarding_grant` cookie. **Not** a session — the person may have no account. |
| **Rate limit** | 60 / minute / grant (`onboarding.save`). |
| **Side effects** | Merges the section into `tos_onboarding.answers`; moves state `invited -> in_progress` on the first successful save; touches `updated_at`. Document links are written to `hr_onboarding_documents` by the §12.5 module, not here. |
| **Audit** | `talent.onboarding.saved`, entity `tos_onboarding`, diff = the changed keys only, never the values of identity documents. |

```ts
interface OnboardingSaveRequest {
  section: string;                       // a section key from the form definition
  answers: Record<string, unknown>;      // candidate-owned fields ONLY
}
interface OnboardingSaveOk { ok: true; state: string; savedAt: string; percentComplete: number; }
```

| Code | HTTP | When |
|---|---|---|
| `E_GRANT_INVALID` | 401 | Missing, expired, revoked or consumed grant |
| `E_LOCKED_FIELD` | 422 | The body contains a key present in `tos_onboarding.locked_fields`. `field` names the first offender. |
| `E_STATE` | 409 | State is not `invited`, `in_progress` or `changes_requested` |
| `E_VALIDATION` | 422 | Server-side field validation; `field` set; a Drive link failure returns the specific human reason, never a bare "invalid" |
| `E_SELECTION_SUSPENDED` | 409 | `tos_selection.suspended_at IS NOT NULL` |

**MUST**: a locked-field change is **rejected**, not merged and not silently discarded. The
candidate is pointed at `/api/talent/onboarding/correction`. **REASON**: silently dropping the edit
means the candidate believes they corrected their department and nobody ever sees the dispute.

#### POST `/api/talent/onboarding/submit`

| | |
|---|---|
| **Auth** | Valid grant. |
| **Rate limit** | 5 / hour / grant. |
| **Side effects** | Sets `submitted_at`, state -> `submitted`. Notifies People Operations. Terminal for the candidate: `/onboarding/status` becomes read-only. |
| **Audit** | `talent.onboarding.submitted` (via `logAuditOrThrow`). |

```ts
interface OnboardingSubmitRequest { confirm: true; }
interface OnboardingSubmitOk {
  ok: true; onboardingRef: string; next: '/onboarding/status';
  whatHappensNext: string;               // server copy: who reviews it, and by when
}
```

| Code | HTTP | When |
|---|---|---|
| `E_GRANT_INVALID` | 401 | as above |
| `E_INCOMPLETE` | 422 | A required section or a required document type from `tos_opportunity.required_document_types` is missing; `field` names it |
| `E_STATE` | 409 | Not in `in_progress` or `changes_requested` |
| `E_STORAGE` | 503 | The write failed. The draft is retained and the candidate is told — **never** a green result over a red one. |

#### POST `/api/talent/onboarding/correction` — raise a correction request

| | |
|---|---|
| **Auth** | Valid grant. |
| **Rate limit** | 10 / day / grant. |
| **Side effects** | Inserts `tos_correction_request` in state `open`. Notifies People Operations. Does **not** change `locked_fields`. |
| **Audit** | `talent.onboarding.correction_raised`, entity `tos_correction_request`. |

```ts
interface CorrectionRequest { fieldKey: string; proposedValue: string; candidateNote: string; }
interface CorrectionOk { ok: true; correctionId: string; }
```

| Code | HTTP | When |
|---|---|---|
| `E_GRANT_INVALID` | 401 | |
| `E_UNKNOWN_FIELD` | 400 | `fieldKey` is not a key of `locked_fields` |
| `E_DUPLICATE` | 409 | An `open` request already exists for that field |
| `E_VALIDATION` | 422 | `candidateNote` shorter than 10 characters — a dispute with no statement cannot be decided |

#### POST `/api/admin/talent/stage/decide` — record a stage outcome

| | |
|---|---|
| **Auth** | Session + `can(user, 'talent.manage')`. Row scope in SQL: an evaluator sees their own assignments (`tos_pipeline_stage.evaluator_rule` / `tos_opportunity.evaluator_user_ids`), a department head their own departments, a hiring manager their own opportunities. |
| **Idempotency** | Required. |
| **Rate limit** | 120 / minute / actor. |
| **Side effects** | Updates `tos_stage_run.state`, `decided_at`, `decided_by`, `outcome_note`, `score`. Inserts `tos_evaluation` when `evaluation` is supplied. Advances the next slot to `invited` when the pass rule is met. Projects onto the existing six-step funnel and writes `application_stage_events`. |
| **Audit** | `talent.stage.decided`, entity `tos_stage_run`. |

```ts
interface StageDecideRequest {
  stageRunId: string;
  outcome: 'passed' | 'failed' | 'waived' | 'skipped' | 'under_review';
  note: string;                                  // required; min 10 chars
  evaluation?: { verdict: 'pass' | 'fail' | 'hold'; score?: number;
                 dimensions?: Record<string, number>; comments?: string; isFinal?: boolean };
}
interface StageDecideOk { ok: true; stageRunId: string; state: string; nextSlotNo: number | null; }
```

| Code | HTTP | When |
|---|---|---|
| `E_FORBIDDEN` | 403 | Capability or row scope |
| `E_STATE` | 409 | Illegal transition for the current `state` |
| `E_OUT_OF_ORDER` | 409 | An earlier required slot is not `passed`, `waived` or `skipped` |
| `E_AUTOMATED_DECISION` | 422 | The body carries a detector-sourced verdict — see below |
| `E_VALIDATION` | 422 | Missing note, score outside the instrument's range |

**MUST**: **automated proctoring and detection are advisory only.** `tos_stage_run.advisory_flags`
is written by detectors and read by humans. **No code path may derive `outcome` from
`advisory_flags`**, and this endpoint rejects any body carrying a machine verdict
(`E_AUTOMATED_DECISION`). `decided_by` is `NOT NULL` in effect: a request without a resolved human
actor is 401, never a system id. A conformance test asserts that a run with every flag raised and no
human decision stays `under_review`.

#### POST `/api/admin/talent/selection/decide`

Two acts, two capabilities, one endpoint discriminated by `action` [brief §25].

| | |
|---|---|
| **Auth** | `action='decide'` -> `can(user, 'selection.decide')`. `action='authorise'` -> `can(user, 'selection.approve_onboarding')`. |
| **Idempotency** | Required. |
| **Rate limit** | 60 / minute / actor. |
| **Side effects** | `decide`: inserts `tos_selection` (or supersedes the live one — never duplicates, per the `tos_selection_live_uq` index) with `decision`, `decision_reason`, `decided_by_user_id`, and the organisation-controlled offer facts. `authorise`: sets `is_authorised = TRUE`, `approved_by_user_id`, `approved_at`. Both notify per §19. |
| **Audit** | `talent.selection.decided` / `talent.selection.authorised` (both `logAuditOrThrow`), entity `tos_selection`. |

```ts
type SelectionDecideRequest =
  | { action: 'decide'; applicationId: string;
      decision: 'selected' | 'rejected' | 'waitlisted' | 'withdrawn';
      reason: string;                                   // min 20 chars
      offer?: { positionId?: string; departmentId?: string;   // departmentId is TEXT. Never ::uuid.
                title?: string; employmentType?: string;
                reportingManagerUserId?: string; proposedStartDate?: string;
                stipendAmount?: number | null; stipendCurrency?: string | null } }
  | { action: 'authorise'; selectionId: string; note: string };

interface SelectionDecideOk { ok: true; selectionId: string; selectionRef: string; isAuthorised: boolean; }
```

| Code | HTTP | When |
|---|---|---|
| `E_FORBIDDEN` | 403 | Capability or row scope |
| `E_REASON_REQUIRED` | 422 | Reason shorter than 20 characters, or whitespace only. Required for **every** decision, including a rejection. |
| `E_STAGES_INCOMPLETE` | 409 | `tos_opportunity.requires_seven_stage` and a required slot is unresolved. Overridable only through `/api/admin/talent/override`. |
| `E_ALREADY_DECIDED` | 409 | A live `selected` row exists and `supersede` was not sent |
| `E_NOT_SELECTED` | 409 | `action='authorise'` against a row whose `decision` is not `selected` |
| `E_SUSPENDED` | 409 | `suspended_at IS NOT NULL` |

**MUST**: `stipendAmount: null` means **unpaid**, and the notification and every candidate-facing
surface say so in words. An absent field is not a licence to print nothing.

#### POST `/api/admin/talent/code/issue`

| | |
|---|---|
| **Auth** | `can(user, 'onboarding.code.issue')`. |
| **Idempotency** | Required — this is the double-click that mints two codes. |
| **Rate limit** | 30 / hour / actor. |
| **Side effects** | Generates the code, stores only `code_hash`, `code_display_prefix`, `code_last4`; sets `expires_at = now() + tos_opportunity.code_validity_days`; `max_uses = 1` unless `code_multi_use`. Creates `tos_onboarding` in state `invited`. Delivers per §19 and sets `delivered_at`. |
| **Audit** | `talent.code.issued` (`logAuditOrThrow`), entity `tos_auth_code`. `diff` carries prefix and last four — **never** the code. |

```ts
interface CodeIssueRequest { selectionId: string; channel: 'email' | 'manual'; note?: string; }
interface CodeIssueOk {
  ok: true; codeId: string; displayPrefix: string; last4: string; expiresAt: string;
  /** The ONLY time the full code exists in a response. Not persisted, not re-fetchable. */
  codeOnce: string;
}
```

| Code | HTTP | When |
|---|---|---|
| `E_FORBIDDEN` | 403 | Capability |
| `E_NOT_AUTHORISED` | 409 | `tos_selection.is_authorised = FALSE` |
| `E_SEPARATION_OF_DUTIES` | 403 | The actor is `tos_selection.decided_by_user_id`. One account **MUST NOT** both decide a selection and issue its code. |
| `E_ACTIVE_CODE_EXISTS` | 409 | A live, unrevoked, unexpired code exists for the selection; revoke it first |
| `E_DELIVERY_FAILED` | 502 | The code row exists and `delivered_at` is NULL. The screen says so and offers resend — it does not claim success. |

#### POST `/api/admin/talent/code/revoke`

| | |
|---|---|
| **Auth** | `can(user, 'onboarding.code.issue')` (issue and revoke are one desk). |
| **Idempotency** | Required. |
| **Rate limit** | 60 / hour / actor. |
| **Side effects** | Sets `revoked_at`, `revoked_by_user_id`, `revoked_reason`. Revokes every live `tos_onboarding_grant` for the code. Does **not** delete the row, does **not** renumber, does **not** touch `tos_onboarding`. |
| **Audit** | `talent.code.revoked` (`logAuditOrThrow`). |

```ts
interface CodeRevokeRequest { codeId: string; reason: string; }   // reason min 20 chars
interface CodeRevokeOk { ok: true; codeId: string; revokedAt: string; grantsRevoked: number; }
```

`E_FORBIDDEN` 403 · `E_REASON_REQUIRED` 422 · `E_ALREADY_REVOKED` 200 (idempotent, `revokedAt`
unchanged) · `E_NOT_FOUND` 404.

#### POST `/api/admin/talent/onboarding/verify`

| | |
|---|---|
| **Auth** | `can(user, 'onboarding.approve')`. Opening a government-identity or tax document link additionally requires `can(user, 'document.view_sensitive')`, and that open is audited **before** the link is revealed. |
| **Idempotency** | Required. |
| **Rate limit** | 120 / minute / actor. |
| **Side effects** | `verify`: sets `verified_at`, `verified_by_user_id`, state -> `verified`. `request_changes`: state -> `changes_requested`, reissues a grant window, notifies the candidate with the note. Document verdicts are written through the existing `hr_onboarding_documents` review path. |
| **Audit** | `talent.onboarding.verified` / `talent.onboarding.changes_requested`. |

```ts
interface OnboardingVerifyRequest {
  onboardingId: string;
  action: 'verify' | 'request_changes';
  note: string;                                   // required for request_changes, min 20 chars
  documents?: { documentId: number; status: 'verified' | 'rejected'; note?: string }[];
}
interface OnboardingVerifyOk { ok: true; state: string; documentsVerified: number; documentsTotal: number; }
```

`E_FORBIDDEN` 403 · `E_STATE` 409 (not `submitted`) · `E_DOCS_INCOMPLETE` 422 (a required type is
not `verified`) · `E_REASON_REQUIRED` 422.

#### POST `/api/admin/talent/onboarding/approve` — creates identity and provisions

| | |
|---|---|
| **Auth** | `can(user, 'onboarding.approve')`. |
| **Idempotency** | **Required and load-bearing.** This is the endpoint that creates a human's employment record. |
| **Rate limit** | 30 / hour / actor. |
| **Side effects** | In order: (1) set `approved_at`, `approved_by_user_id`, state -> `approved`; (2) mint the identity code and insert `tos_identity` (§5.6); (3) for `EMPLOYEE`/`INTERN`, call the existing `completeHire()` (§13) — **called, never reimplemented** — which creates `hr_employees`, mints the employee code, seeds the onboarding journey and notifies; (4) write `tos_onboarding.identity_id`; (5) enqueue `tos_provisioning_event` rows from `tos_opportunity.access_profile_id` in state `pending`. |
| **Audit** | `talent.onboarding.approved` (`logAuditOrThrow`), then `talent.identity.created`. |

```ts
interface OnboardingApproveRequest {
  onboardingId: string;
  action: 'approve' | 'reject';
  identityType?: 'EMPLOYEE' | 'INTERN' | 'FELLOW' | 'MEMBER' | 'CAMPUS_AMBASSADOR'
               | 'CONTRACTOR' | 'CONSULTANT' | 'OTHER_AUTHORIZED_IDENTITY';
  startedOn?: string;                   // ISO date; defaults to tos_selection.proposed_start_date
  reason?: string;                      // required for reject, min 20 chars
}
interface OnboardingApproveOk {
  ok: true; identityId: string; identityCode: string;
  employeeCode: string | null;          // null for non-employment-backed types
  provisioningQueued: number;
}
```

| Code | HTTP | When |
|---|---|---|
| `E_FORBIDDEN` | 403 | Capability |
| `E_STATE` | 409 | Not `verified` |
| `E_OPEN_CORRECTIONS` | 409 | An `open` `tos_correction_request` exists |
| `E_PRIMARY_IDENTITY_EXISTS` | 409 | The `tos_identity_one_primary` partial unique index would be violated. Convert or end the existing identity first. |
| `E_IDENTITY_TYPE_REQUIRED` | 422 | `action='approve'` with no `identityType` |
| `E_HIRE_FAILED` | 500 | `completeHire()` threw. State is rolled back to `verified`, the real reason is logged from `e.cause`, and the screen shows it. Half a hire is not reported as a hire. |

#### POST `/api/admin/talent/access/provision`

| | |
|---|---|
| **Auth** | `can(user, 'access.manage')` — and this is the **only** desk that holds it. The hiring desk and the onboarding desk do not. |
| **Idempotency** | Required. |
| **Rate limit** | 60 / minute / actor. |
| **Side effects** | Applies the pending `tos_provisioning_event` rows for one identity **through the existing RBAC module** (§14), never by direct SQL against `rbac_*`. Each row moves `pending -> applied` or `pending -> failed` with `error_reason`. A revoke writes `action='revoke'` rows; nothing is deleted. |
| **Audit** | `talent.access.provisioned` (`logAuditOrThrow`), entity `tos_identity`, diff = the target keys and their outcomes. |

```ts
interface AccessProvisionRequest {
  identityId: string;
  mode: 'apply_derived' | 'revoke_all' | 'apply_manual';
  /** apply_manual only. Time-bounded, and stays marked manual in every reconciliation. */
  manual?: { targetKind: 'rbac_role' | 'admin_section' | 'app_system'; targetKey: string;
             reason: string; expiresAt: string };
}
interface AccessProvisionOk {
  ok: true; applied: number; failed: number;
  results: { targetKind: string; targetKey: string; state: 'applied' | 'failed'; errorReason?: string }[];
}
```

| Code | HTTP | When |
|---|---|---|
| `E_FORBIDDEN` | 403 | Capability |
| `E_IDENTITY_NOT_ACTIVE` | 409 | `tos_identity.status <> 'active'`. A suspended identity resolves to no access, and a manual grant that contradicts status is **refused, not merged**. |
| `E_NO_PROFILE` | 409 | `mode='apply_derived'` with no `tos_access_profile` resolvable |
| `E_MANUAL_UNBOUNDED` | 422 | `apply_manual` without `expiresAt` |
| `E_PARTIAL` | 207 | Some rows failed. The response lists every row and its reason; a partial run **never** reports success for the batch. |

#### POST `/api/admin/talent/override`

| | |
|---|---|
| **Auth** | The capability that governs the target entity (`talent.manage` for `tos_stage_run`; `selection.decide` for `tos_selection`; `onboarding.code.issue` for `tos_auth_code`; `onboarding.approve` for `tos_onboarding`), **plus** the approval level the server computes. |
| **Idempotency** | Required. |
| **Rate limit** | 20 / hour / actor. |
| **Side effects** | Writes the `tos_override` row **and** the state change in the same operation. Neither happens without the other. |
| **Audit** | `talent.override.recorded` (`logAuditOrThrow`), entity = the target table, entityId = the target row. |

```ts
interface OverrideRequest {
  entity: 'tos_stage_run' | 'tos_selection' | 'tos_auth_code' | 'tos_onboarding';
  entityId: string;
  toState: string;
  reason: string;                       // min 20 chars, enforced server-side
  approverUserId?: string;              // required when the computed level is 'second_signature'
}
interface OverrideOk { ok: true; overrideId: string; fromState: string | null; toState: string; approvalLevel: string; }
```

| Code | HTTP | When |
|---|---|---|
| `E_FORBIDDEN` | 403 | Missing the governing capability |
| `E_REASON_REQUIRED` | 422 | Reason under 20 characters |
| `E_APPROVAL_REQUIRED` | 403 | Computed level is `second_signature` or `founder` and no distinct approver was supplied |
| `E_SELF_APPROVAL` | 403 | `approverUserId` equals the actor |
| `E_ILLEGAL_TARGET` | 400 | `toState` is not a state of that entity |

**MUST**: this is the **only** endpoint permitted to move `tos_stage_run.state`,
`tos_selection.decision`, `tos_selection.is_authorised`, `tos_auth_code.revoked_at` or
`tos_onboarding.state` outside their normal transitions. A silent override elsewhere is a defect
[brief §27].

---

### 17.2 The `tos_onboarding` state machine

Referenced from §4.6. `state` is `TEXT`; the vocabulary is enforced in TypeScript, not by a `CHECK`.

| From | To | Who may trigger | Guard | Notification fired |
|---|---|---|---|---|
| — | `invited` | `POST /api/admin/talent/code/issue` (`onboarding.code.issue`) | `tos_selection.is_authorised` and no live `tos_onboarding` for the selection | `onboarding.invited` to the candidate, on the recorded channel |
| `invited` | `in_progress` | Grant holder, first successful `onboarding/save` | Grant valid; selection not suspended | none — a save is not an event |
| `in_progress` | `in_progress` | Grant holder | Grant valid | none |
| `in_progress` | `submitted` | Grant holder, `onboarding/submit` | Every required section and required document type present | `onboarding.submitted` to People Operations |
| `submitted` | `verified` | `onboarding.approve` holder, `onboarding/verify` action `verify` | Every required document `verified` | none to the candidate — verification is not a decision |
| `submitted` | `changes_requested` | `onboarding.approve` holder, action `request_changes` | Note of at least 20 characters | `onboarding.changes_requested` to the candidate, carrying the note |
| `changes_requested` | `in_progress` | Grant holder, next successful save | Grant valid or re-established by re-presenting the code | none |
| `verified` | `approved` | `onboarding.approve` holder, `onboarding/approve` | No `open` `tos_correction_request`; identity type supplied; no conflicting primary identity | `onboarding.approved` to the candidate, the reporting manager and People Operations |
| `submitted`, `verified`, `changes_requested`, `in_progress` | `rejected` | `onboarding.approve` holder, `onboarding/approve` action `reject` | Written reason of at least 20 characters | `onboarding.rejected` to the candidate, carrying the reason |
| any pre-`approved` | `suspended` | Selection suspension (`tos_selection.suspended_at`) | Set by `selection/decide` or by override | `onboarding.suspended` to the candidate: honest sentence, named contact |
| `suspended` | `in_progress` | `selection.approve_onboarding` holder | Suspension cleared; **requires** a `tos_override` row | `onboarding.resumed` to the candidate |
| `invited`, `in_progress` | `expired` | Scheduled job | `tos_auth_code.expires_at` passed **and** no activity for 30 days | `onboarding.expired` to People Operations only |
| any pre-`approved` | `withdrawn` | Grant holder | Explicit confirmation | `onboarding.withdrawn` to People Operations |
| `approved` | — | nobody | Terminal. A change after approval is an identity action (§13), not an onboarding action. | — |

**MUST**: every backwards transition in this table (`suspended -> in_progress`, and anything an
administrator forces) inserts a `tos_override` row in the same operation. **MUST NOT**: any
transition triggered by a detector, a score threshold, or a model output. Every row in the "who may
trigger" column is a human or a clock.

---

## 18. Admin console information architecture [brief §15, §36]

### 18.1 The navigation tree

Read `src/lib/admin-nav.ts` and `src/lib/admin-sections.ts` before touching this. Both already carry
this build's entries: the four section keys are registered in `ADMIN_SECTION_GROUPS` under
**People & HR**, the nine nav items are in `ADMIN_NAV` under the group `talent-group`, and
`src/middleware.ts` already maps `/admin/talent/access`, `/admin/talent/identity`,
`/admin/talent/onboarding`, `/admin/talent/codes` and `/admin/talent/selected` to their specific
keys with `/admin/talent` as the fallback.

**NEW `ADMIN_SECTION_GROUPS` keys required by this build: none.**

| Section key | Status | Holders below `super_admin` (`ROLE_SECTIONS`) |
|---|---|---|
| `talent` | EXISTING | `hr`, `recruiter`, `reviewer`, `department_head` |
| `talent_onboarding` | EXISTING | `hr` |
| `talent_identity` | EXISTING | `hr` |
| `talent_access` | EXISTING | none — `super_admin` alone |

**REASON no new key is added.** A section key nobody has been granted hides its pages from every
restricted administrator on the day they ship, and produces a checkbox in `/admin/team/roles` that
nothing enforces. That reasoning is already written into `admin-nav.ts` for the `recruitment` key
that was deliberately not created. If a future desk genuinely needs a tenth key, it is added to
`ADMIN_SECTION_GROUPS` **and** to `ROLE_SECTIONS` for its holders **and** to `PATH_SECTION` in the
same commit — three edits, or the console ships unreachable.

**The nine nodes of brief §15, mapped.**

| Brief node | Console entry | Route | | Section key | Note |
|---|---|---|---|---|---|
| Dashboard | Talent console | `/admin/talent` | NEW page, EXISTING nav entry `talent` | `talent` | Counts and queues only; every tile names its source |
| Recruitment | Opportunities | `/admin/talent/opportunities` | NEW page, EXISTING entry | `talent` | Edits `tos_opportunity`; the advertisement stays on `/admin/roles` |
| | Job roles | `/admin/roles` | **EXISTING page** | `roles` | Point here. Do not rebuild the catalogue. |
| | Applications | `/admin/applications` | **EXISTING page** | `applications` | Point here. The application-centred pipeline already exists. |
| | Candidates | `/admin/talent/candidates` | NEW page, EXISTING entry | `talent` | Person-centred. Links into `/admin/applications/[id]`; never re-implements it. |
| | Recruitment sources | `/admin/talent/sources` | NEW page, EXISTING entry | `talent` | Read view over `application_sources`; the editor stays at `/admin/application-sources` |
| | Application sources (edit) | `/admin/application-sources` | **EXISTING page** | `hr` | |
| Evaluation | Evaluation boards | `/admin/talent/evaluation` | NEW page, **NEW nav entry** | `talent` | Stage boards, evaluator queues, `tos_evaluation` |
| | Interviews / Tests | `/admin/interviews`, `/admin/tests` | **EXISTING pages** | `interviews`, `tests` | A stage run of kind `interview`/`assessment` links out to these. One scheduler, one test engine. |
| Selection | Selection decisions | `/admin/talent/selection` | NEW page, **NEW nav entry** | `talent` | Holds `selection.decide`, which `recruiter` has — so this path **MUST** resolve to `talent`, not `talent_onboarding` |
| | Selected candidates | `/admin/talent/selected` | NEW page, EXISTING entry | `talent_onboarding` | The authorise-for-onboarding desk. Different key on purpose. |
| Onboarding | Onboarding codes | `/admin/talent/codes` | NEW page, EXISTING entry | `talent_onboarding` | §18.3 |
| | Onboarding review | `/admin/talent/onboarding` | NEW page, EXISTING entry | `talent_onboarding` | Verify and approve |
| | Joining documents | `/admin/hr/onboarding` | **EXISTING page** | `employees` | Point here. `hr_onboarding_documents` already has a review workflow. |
| | Onboarding journey | `/admin/hr/onboarding/journey` | **EXISTING page** | `employees` | The post-approval checklist |
| Identity | Identity registry | `/admin/talent/identity` | NEW page, EXISTING entry | `talent_identity` | `tos_identity` |
| | Employees | `/admin/hr/employees` | **EXISTING page** | `employees` | The employment record. An identity links to it; it is not a second copy. |
| Organization | Departments | `/admin/departments` | **EXISTING page** | `departments` | |
| | Teams and positions | `/admin/org/structure` | **EXISTING page** | `departments` | |
| | Organization graph | `/admin/org/graph` | **EXISTING page** | `employees` | Reporting manager, department head, approvers |
| Access | Access management | `/admin/talent/access` | NEW page, EXISTING entry | `talent_access` | `tos_access_profile`, provisioning queue, `tos_access_request` |
| | Custom roles / RBAC | `/admin/team/roles`, `/admin/rbac` | **EXISTING pages** | `team_roles` | The capability engine. Provisioning writes **through** it. |
| | Access preview | `/admin/access-preview` | **EXISTING page** | `team_roles` | "What would this role see" |
| Audit | Audit log | `/admin/audit` | **EXISTING page** | `audit` | |
| | Override ledger | `/admin/talent/access` (tab) or `/admin/audit` filter | derived | `audit` | `tos_override` is rendered as a filter of the audit surface, not a tenth console |

**Two `ADMIN_NAV` additions, and only two:**

```ts
// inside the existing `talent-group` children, after 'talent-candidates'
{ id: 'talent-evaluation', label: 'Evaluation', href: '/admin/talent/evaluation', icon: 'chart', section: 'talent' },
{ id: 'talent-selection',  label: 'Selection',  href: '/admin/talent/selection',  icon: 'check', section: 'talent' },
```

No `PATH_SECTION` entry is needed for either: `['/admin/talent', 'talent']` already covers them by
prefix, and the longest-prefix sort keeps the five specific subtrees on their own keys.

**MUST NOT fork the hiring system.** `/admin/talent/candidates` is a *person* view;
`/admin/applications` is an *application* view; they read the same `applications` rows through
`tos_application_link`. Any new list that duplicates the application table's columns is the second
hiring system this specification exists to prevent. Where the table above says **EXISTING page**,
the console links out. It does not re-render.

---

### 18.2 The candidate state-at-a-glance panel [brief §36]

One panel, one person, one opportunity. It answers "where is this human, right now, and what
happens next" without an administrator opening five screens and reconciling them by hand.

**Every value is server-derived.** The panel accepts `personId` and `opportunityRoleId` and nothing
else. No field is read from the query string, no field is computed in the browser, and no field is
carried over from a previous render. **REASON**: a panel that accepts a state from its caller will
eventually be handed one, and "Selected" printed beside somebody who was not is the most damaging
sentence this console can produce.

#### 18.2.1 The field list the panel renders

| Group | Field | Source |
|---|---|---|
| Person | Person code | `tos_person.person_code` |
| | Name | `tos_person.display_name` |
| | Primary email, verified yes/no | `tos_person.primary_email`, `tos_person_email.is_verified` |
| | Account | `tos_person.user_id IS NOT NULL` |
| Application | Opportunity | `roles.title`, `roles.slug` |
| | Department | `departments.name` via `roles.department_id` (TEXT join, no cast) |
| | Which meaning of apply | `tos_application_link.pathway` |
| | Applicant type | `tos_application_link.applicant_type` |
| | Where they came from | `application_sources.label` via `tos_application_link.source_slug` |
| | Applied on | `applications.created_at` |
| Evaluation | Slots resolved of seven | count of `tos_stage_run` in `passed/failed/waived/skipped` |
| | Current slot | `tos_pipeline_stage.label`, `tos_stage_run.slot_no`, `.state` |
| | Due | `tos_stage_run.due_at` |
| | Days in current state | `now() - tos_stage_run.updated_at` |
| | Candidate-visible step | the existing six-step projection of the above |
| Selection | Decision | `tos_selection.decision` |
| | Reference | `tos_selection.selection_ref` |
| | Decided by, decided at | `tos_selection.decided_by_user_id` resolved to a name, `.decided_at` |
| | Written reason | `tos_selection.decision_reason` |
| | Authorised for onboarding | `tos_selection.is_authorised` |
| | Suspended | `tos_selection.suspended_at`, `.suspended_reason` |
| | Offer facts | `offered_title`, `offered_department_id`, `employment_type`, `proposed_start_date` |
| | Stipend | `stipend_amount` + `stipend_currency`, or the words **Unpaid — no stipend recorded** when NULL |
| Code | Identifier | `tos_auth_code.code_display_prefix` + `…` + `code_last4` |
| | Issued / expires | `issued_at`, `expires_at` |
| | Uses | `use_count` of `max_uses` |
| | Delivered / revoked | `delivered_at`, `revoked_at`, `revoked_reason` |
| Onboarding | Reference and state | `tos_onboarding.onboarding_ref`, `.state` |
| | Submitted / verified / approved | the three timestamps and the two actor names |
| | Documents | `n` verified of `m` from `hr_onboarding_documents` |
| | Open corrections | count of `tos_correction_request` in state `open` |
| Identity | Identity code and type | `tos_identity.identity_code`, `.identity_type` |
| | Status, primary | `.status`, `.is_primary` |
| | Official email | `.official_email` |
| | Department / position / team | `.department_id` (TEXT), `.position_id`, `.team_id` |
| | Started, ended | `.started_on`, `.ended_on` |
| | Employment record | `hr_employees.employee_code` via `tos_identity.employee_id` |
| Access | Profile | `tos_access_profile.profile_key` |
| | Applied / pending / failed | counts from `tos_provisioning_event` |
| Trail | Last five actions | `audit_log` filtered to this person's entity ids |

**Every group is always rendered.** A group with no data prints an explicit phrase — *Not started*,
*No code issued*, *No identity*, *Not applicable to this pathway* — never a blank, a dash, or a zero
that reads as a fact. A group whose query failed prints *We cannot reach this record right now*, and
the response sets `x-era-degraded`.

#### 18.2.2 Worked example A — an external selected candidate

```
Person            ERAI-P-004812 · Meera N · meera.n@example.com (verified) · no account yet
Opportunity       Product Operations Manager (product-operations-manager) · Product
Meaning of apply  Considered  (pathway: recruitment)
Applicant type    External
Came from         Campus outreach
Applied on        2026-06-14

Evaluation        7 of 7 resolved · slot 7 "Final review" · passed · decided 2026-07-29
Candidate sees    05 · Decision

Selection         Selected · ERAI-SEL-26-000412 · decided by Anjali R on 2026-07-30
                  Reason: "Strongest operating plan of the eleven finalists; ran the live
                  exercise end to end with no prompting."
                  Authorised for onboarding: yes (Anjali R is not the authoriser — S Prasad, 2026-07-30)
                  Not suspended
Offer             Product Operations Manager · Product · Full-Time · start 2026-09-01
Stipend           Not applicable (Full-Time)

Code              ERAI-SEL-ONB-26-POM … 7QF4 · issued 2026-07-30 · expires 2026-08-20
                  Uses 1 of 1 · delivered 2026-07-30 · not revoked

Onboarding        ERAI-ONB-26-000412 · verified · submitted 2026-08-02 · verified 2026-08-05 by Ravi K
                  Documents 6 of 6 verified · open corrections: 0

Identity          No identity  (created on approval)
Access            Profile PO-MANAGER · 0 applied · 9 pending · 0 failed

Trail             talent.onboarding.verified · talent.onboarding.submitted · talent.code.issued
                  · talent.selection.authorised · talent.selection.decided
```

#### 18.2.3 Worked example B — an internal employee who has not completed the seven stages

```
Person            ERAI-P-000317 · Devika S · devika.s@edurankai.in (verified) · account yes
Opportunity       AI Research Fellow (ai-research-fellow) · AI
Meaning of apply  Considered  (pathway: recruitment)
Applicant type    Internal  (identity ERAI-EMP-00128)
Came from         Internal opportunity board
Applied on        2026-08-09

Evaluation        2 of 7 resolved · slot 3 "Written exercise" · in_progress · due 2026-08-26
                  In this state for 6 days
Candidate sees    03 · Assessment

Selection         No decision recorded
Offer             Not applicable
Stipend           Not applicable

Code              No code issued
Onboarding        Not started

Identity          ERAI-EMP-00128 · EMPLOYEE · active · primary
                  devika.s@edurankai.in · department ai · started 2025-02-17
                  Employment record ERA-EMP-0128
Access            Profile ENG-STAFF · 11 applied · 0 pending · 0 failed
                  (this identity's access is unchanged by an in-flight application)

Trail             talent.stage.decided · talent.stage.decided · talent.application.started
```

**REASON example B is in this specification.** The internal case is the one that gets built wrong:
the panel sees an active identity and prints *Onboarded*, or it sees no selection and prints
nothing at all. Both are false. An existing identity and an unfinished evaluation are independent
facts and the panel states both, plainly, side by side. The final line is also a rule: **an
in-flight application changes nothing about the identity the person already holds.**

#### 18.2.4 The query

One statement, all `LEFT JOIN`, so a missing downstream row yields NULL rather than dropping the
person. `departments.id` is TEXT on both sides — **no `::uuid` anywhere**.

```ts
const r = await db.execute(sql`
  SELECT
    p.person_code, p.display_name, p.primary_email, p.user_id,
    pe.is_verified                                   AS email_verified,
    ro.title  AS opportunity_title, ro.slug AS opportunity_slug,
    d.name    AS department_name,
    al.pathway, al.applicant_type, al.source_slug,
    src.label AS source_label,
    a.id AS application_id, a.created_at AS applied_on,
    sr.slot_no, sr.state AS stage_state, sr.due_at, sr.updated_at AS stage_updated_at,
    ps.label  AS stage_label,
    (SELECT COUNT(*) FROM tos_stage_run x
      WHERE x.application_id = a.id
        AND x.state IN ('passed','failed','waived','skipped'))     AS slots_resolved,
    s.selection_ref, s.decision, s.decision_reason, s.decided_at, s.decided_by_user_id,
    s.is_authorised, s.suspended_at, s.suspended_reason,
    s.offered_title, s.offered_department_id, s.employment_type, s.proposed_start_date,
    s.stipend_amount, s.stipend_currency,
    c.code_display_prefix, c.code_last4, c.issued_at, c.expires_at,
    c.use_count, c.max_uses, c.delivered_at, c.revoked_at, c.revoked_reason,
    o.onboarding_ref, o.state AS onboarding_state,
    o.submitted_at, o.verified_at, o.approved_at,
    (SELECT COUNT(*) FROM tos_correction_request cr
      WHERE cr.onboarding_id = o.id AND cr.state = 'open')          AS open_corrections,
    i.identity_code, i.identity_type, i.status AS identity_status, i.is_primary,
    i.official_email, i.department_id AS identity_department_id,
    i.position_id, i.team_id, i.started_on, i.ended_on,
    e.employee_code
  FROM tos_person p
  LEFT JOIN tos_person_email  pe ON lower(pe.email) = lower(p.primary_email)
  LEFT JOIN tos_application_link al
         ON al.person_id = p.id AND al.opportunity_role_id = ${roleId}
  LEFT JOIN applications      a  ON a.id  = al.application_id
  LEFT JOIN roles             ro ON ro.id = al.opportunity_role_id
  LEFT JOIN departments       d  ON d.id  = ro.department_id
  LEFT JOIN application_sources src ON src.slug = al.source_slug
  LEFT JOIN LATERAL (
      SELECT * FROM tos_stage_run x
       WHERE x.application_id = a.id AND x.state NOT IN ('passed','waived','skipped')
       ORDER BY x.slot_no LIMIT 1) sr ON TRUE
  LEFT JOIN tos_pipeline_stage ps ON ps.id = sr.pipeline_stage_id
  LEFT JOIN tos_selection      s  ON s.application_id = a.id AND s.suspended_at IS NULL
  LEFT JOIN LATERAL (
      SELECT * FROM tos_auth_code x
       WHERE x.selection_id = s.id ORDER BY x.issued_at DESC LIMIT 1) c ON TRUE
  LEFT JOIN tos_onboarding     o  ON o.selection_id = s.id
  LEFT JOIN LATERAL (
      SELECT * FROM tos_identity x
       WHERE x.person_id = p.id AND x.status = 'active' AND x.is_primary
       LIMIT 1) i ON TRUE
  LEFT JOIN hr_employees       e  ON e.id = i.employee_id
  WHERE p.id = ${personId} AND p.merged_into_id IS NULL
  LIMIT 1`);

// postgres-js returns a plain array. r.rows[0] is undefined in production.
const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
const panel = rows[0] || null;
```

Document counts and provisioning counts are two further small aggregates (kept out of the statement
above so one failure does not blank the panel):

```sql
SELECT COUNT(*) FILTER (WHERE status = 'verified') AS verified, COUNT(*) AS total
  FROM hr_onboarding_documents WHERE user_id = $1;

SELECT state, COUNT(*) FROM tos_provisioning_event WHERE identity_id = $1 GROUP BY state;
```

**Trap.** `hr_onboarding_documents.user_id` is `TEXT NOT NULL` and a candidate in onboarding has no
`users.id` yet. §12.5 owns the key; whatever it defines, this panel **MUST** use the same value and
**MUST NOT** pass NULL or an empty string. The column is TEXT precisely so a pre-account subject key
fits, and a query written against `users.id` alone silently reports "0 documents" for every
candidate who has not been hired yet — which is every candidate this panel is for.

`e?.cause?.message || e?.message` on every catch. A caught error renders the degraded phrase.

#### 18.2.5 What the panel MUST NEVER show

- **The authorization code.** Prefix and last four only. There is no code in the database to show,
  and no screen may create the impression that there is.
- **A raw evaluation score or an evaluator's comments** on the at-a-glance panel. The verdict of a
  stage is a state; the numbers live behind `talent.manage` on the evaluation board and are never
  shown to the candidate on any surface.
- **Advisory detector flags presented as an outcome.** Where they appear at all they are labelled as
  advisory, adjacent to the human decision, never in place of it.
- **`hr_employees.blood_group` or `hr_employees.date_of_birth`.** These are HR record fields on the
  employment record, not oversight-screen columns. No admin surface renders a row per person of
  individual health data.
- **Bank, statutory or tax identifiers**, and no government-identity document link without
  `document.view_sensitive` and an audit write that succeeds **before** the link is revealed.
- **Any other person's row.** The panel is one person. A list that renders this panel per row is a
  different screen with a different scope check, and the scope is applied in SQL, not in the render.
- **Anything from the wellness subsystem.** It is gated elsewhere and has no join into this panel.

---

### 18.3 The selection codes screen — `/admin/talent/codes`

Gated on `talent_onboarding`; every action additionally checks `can(user, 'onboarding.code.issue')`
server-side, because `/api/*` is not covered by the middleware gate.

**List columns** — `tos_auth_code` joined to `tos_selection`, `tos_person` and `roles`:

| Column | Value |
|---|---|
| Identifier | `code_display_prefix` + ` … ` + `code_last4` |
| Person | `tos_person.display_name`, `person_code` |
| Opportunity | `roles.title` |
| Selection | `tos_selection.selection_ref` |
| Issued | `issued_at`, and the issuing person's name |
| Expires | `expires_at`, with a *closing soon* marker when fewer than four days remain |
| Uses | `use_count` of `max_uses` |
| Delivered | `delivered_at` or **Not delivered** |
| State | derived: `revoked` · `expired` · `consumed` · `live` |
| Last attempt | most recent `tos_code_attempt.outcome` for the hash, with its true reason |

**MUST**: the code itself is never a column, never a tooltip, never an export field, never in the
audit `diff`, and never recoverable. It exists once, in the `codeOnce` field of the
`/api/admin/talent/code/issue` response, and is shown once on the issuing screen with the sentence:

> This is the only time this code is shown. It is not stored anywhere we can read it back. Copy it
> now, or revoke it and issue a new one.

**Actions**

| Action | Endpoint | Requires | Result |
|---|---|---|---|
| Issue | `POST /api/admin/talent/code/issue` | `onboarding.code.issue`; selection authorised; actor is not the deciding actor | New row; `codeOnce` shown once |
| Revoke | `POST /api/admin/talent/code/revoke` | Same key; written reason of at least 20 characters | `revoked_at` set; live grants revoked; row retained |
| Resend | `POST /api/admin/talent/code/issue` with `channel` and the **same** `Idempotency-Key` semantics as a reissue | Same key | Revokes the old code and issues a new one. **REASON**: the old code cannot be re-sent because it cannot be read; "resend" that silently issues a second live code is how two codes end up bound to one selection. |
| Extend | `POST /api/admin/talent/override` (`entity: 'tos_auth_code'`) | The governing key **and** a `tos_override` row | Extension is an override by construction, so it is on the record |

The screen shows the **true** reason for every failed attempt (expired, revoked, wrong subject,
rate limited) — that is the asymmetry §16.1.2 pays for. A `reuse_other_subject` attempt is rendered
as a flagged row and has already notified People Operations.

---

### 18.4 Saved views and queues

Five queues, each a named saved view on the console dashboard with a live count. Each names its
source; a tile with no source is not rendered.

**1. Stalled stages** — a stage run past its service window, or sitting in one state too long.

```sql
SELECT sr.id, sr.application_id, sr.slot_no, ps.label, sr.state, sr.due_at,
       EXTRACT(DAY FROM now() - sr.updated_at)::int AS days_in_state
  FROM tos_stage_run sr
  JOIN tos_pipeline_stage ps ON ps.id = sr.pipeline_stage_id
 WHERE sr.state IN ('invited','in_progress','submitted','under_review')
   AND ( (sr.due_at IS NOT NULL AND sr.due_at < now())
      OR (ps.sla_days IS NOT NULL AND sr.updated_at < now() - (ps.sla_days || ' days')::interval) )
 ORDER BY sr.due_at NULLS LAST, sr.updated_at;
```

**2. Documents pending review** — submitted, not yet verified or rejected.

```sql
SELECT id, user_id, doc_type, title, created_at
  FROM hr_onboarding_documents
 WHERE status = 'submitted'
 ORDER BY created_at;
```

**3. Verification required** — onboarding submitted and waiting on a human.

```sql
SELECT o.id, o.onboarding_ref, o.person_id, o.submitted_at,
       EXTRACT(DAY FROM now() - o.submitted_at)::int AS days_waiting
  FROM tos_onboarding o
 WHERE o.state = 'submitted'
 ORDER BY o.submitted_at;
```

**4. Provisioning pending or failed** — the queue that decides whether a person can work on day one.

```sql
SELECT pe.identity_id, i.identity_code, i.status,
       COUNT(*) FILTER (WHERE pe.state = 'pending') AS pending,
       COUNT(*) FILTER (WHERE pe.state = 'failed')  AS failed,
       MIN(pe.created_at)                           AS oldest
  FROM tos_provisioning_event pe
  JOIN tos_identity i ON i.id = pe.identity_id
 WHERE pe.state IN ('pending','failed')
 GROUP BY pe.identity_id, i.identity_code, i.status
 ORDER BY oldest;
```

**5. Expiring codes** — live, unrevoked, unconsumed, expiring inside seven days.

```sql
SELECT c.id, c.code_display_prefix, c.code_last4, c.expires_at,
       c.use_count, c.max_uses, c.delivered_at,
       p.display_name, p.person_code, r.title
  FROM tos_auth_code c
  JOIN tos_person p ON p.id = c.person_id
  JOIN roles      r ON r.id = c.opportunity_role_id
 WHERE c.revoked_at IS NULL
   AND c.consumed_at IS NULL
   AND c.expires_at > now()
   AND c.expires_at < now() + interval '7 days'
 ORDER BY c.expires_at;
```

**A sixth, and it is the one People Operations will ask for first: open correction requests.**

```sql
SELECT cr.id, cr.onboarding_id, cr.field_key, cr.proposed_value, cr.created_at
  FROM tos_correction_request cr
 WHERE cr.state = 'open'
 ORDER BY cr.created_at;
```

**Rules for every queue.**

- The count on the tile and the rows on the screen come from **one** query. A tile that counts
  differently from the list it opens is two sources of truth and will be trusted until it is wrong.
- Scope is applied in SQL. A department head's queue is filtered by the departments the organization
  graph names them head of — never by filtering a wider result in the render.
- A queue whose query fails renders *We cannot reach this queue right now* and logs
  `e?.cause?.message || e?.message`. **MUST NOT** render an empty queue, which reads as "nothing to
  do" and is the difference between a slow afternoon and a missed joining date.
- Every queue row links to the §18.2 panel for that person and opportunity. The queue is a way in,
  not a second place where the facts are stated.

---

## 19. Notifications [brief §30]

### 19.1 What already exists, and the one entry point this section adds

| Concern | Existing module | What it already does |
|---|---|---|
| In-app record | `src/lib/notify.ts` — `notifyUser(userId, opts)`, `notifyAllAdmins(opts)` | Inserts into `notifications` (`user_id, title, body, type, action_url, entity_type, entity_id`). The whole recipient list is unrolled **inside Postgres** in one statement. Skips an identical row from the last two minutes. Catches and logs `e.cause?.message \|\| e.message`; never throws. |
| Who receives what | `src/lib/notify-audience.ts` — `NOTIFICATION_AUDIENCE`, `audienceFor(type)`, `roleCanReceive(role, type)` | Maps a notification type to admin roles. `super_admin` always receives. `applicant` and `partner` never do. **An unmapped type reaches `super_admin` and nobody else**, and logs a one-per-process warning naming the type. |
| Category and priority | `src/lib/notification-catalog.ts` — `NOTIF_META`, `metaFor(type)`, `isHighPriority`, `vibrationFor` | Drives the Notification Center filters, the sort order and `requireInteraction`. An unregistered key silently degrades to `system` / `medium`. |
| Push | `src/lib/push.ts` — `sendPushToUser`, `sendPushToAdmins`, `NOTIFICATION_TYPES` | Web push. Per-user opt-out lives in `notification_preferences.prefs` (jsonb): `{ "<type>": false }` is muted, an absent key is on. |
| Preferences | `notification_preferences` (`src/lib/db/schema.ts`) | `user_id` unique, six legacy boolean columns, and the open `prefs` jsonb map. New types ship without a migration. |
| Email | `src/lib/email.ts` — `sendEmail(params)`, `brandedEmail(opts)` | Own SMTP. `sendEmail` returns `{ ok, id?, error? }` and **does not throw**. |
| Queue | `src/lib/job-queue.ts` — `enqueue`, `claimBatch`, `backoffMs`, `jobOutcome`, `logDelivery` | `edu_jobs`, with `dedupKey`, `maxAttempts` and `runAfterMs`. |

**MUST**: every notification in this specification is emitted through **one** new function,
`emitTalentEvent(key, ctx)` in `src/lib/talentos/notify.ts`. It renders the copy from the catalogue
in §19.5 / §19.7 and fans out to the modules above. No page, endpoint, handler or job may call
`sendEmail`, `notifyUser`, `notifyAllAdmins`, `sendPushToUser` or `sendPushToAdmins` directly for a
talent event.

**REASON**: this project has already shipped notification copy that differed between the email and
the in-app row for the same event, and eleven live types that reached every role in the building
because nobody remembered the audience map. One renderer makes the copy, the audience, the category
and the suppression rule a property of the **event**, not of the call site.

**MUST**: adding an event key to §19.5 or §19.7 also adds it, **in the same change**, to
`NOTIFICATION_AUDIENCE` in `notify-audience.ts` and to `NOTIF_META` in `notification-catalog.ts`. A
conformance test asserts that every key in the talent catalogue is present in both (§25). An audit on
2026-07-30 found 22 of 44 emitted types missing from `NOTIF_META`; this is the guard against a 23rd.

**MUST NOT** add a `PREFIX_META` entry for `tos.`. A prefix fallback would give every unregistered
talent key a plausible-looking category and priority, which is precisely the silent degradation the
explicit-registration rule exists to catch. `PREFIX_META` is for a genuine dynamic family
(`partner_payout_*`), and the talent keys are a closed, enumerable set.

**MUST NOT** use an arrow character, an em dash, or any other non-ASCII glyph in a notification
title or body. `notify.statusChange` in `src/lib/notify.ts` currently builds its title by joining the
name and the new status with a rightwards-arrow glyph, and these strings are rendered inside `.astro`
JSX in the notification centre, where an arrow character in a JSX string is a known parse hazard on
this project. Write "moved to" in words.

**The two-minute de-duplication window has a consequence that MUST be designed around.**
`insertOnceMany` suppresses a row whose `(user_id, title, body, entity_id)` matches one from the last
two minutes. Two genuinely different talent events for the same person within that window — a stage
closing and the next stage opening, two documents returned together — would collapse into one.
Therefore: **every talent notification title or body MUST contain a value that differs between
events** (the stage label, the reference, the field key), and `entityId` MUST be the specific row's
id, never the person's. A collapsed notification is indistinguishable from one never sent.

### 19.2 Channels

| Channel | Function used | When |
|---|---|---|
| `email` | `sendEmail({ to, subject, html, text })`, body composed with `brandedEmail(...)` | Anything the recipient must be able to act on outside a session: selection, rejection, the authorization code, an onboarding deadline, a closing engagement. |
| `in_app` | `notifyUser` / `notifyAllAdmins` | **Every** event, always. The in-app row is the durable copy and the one the portal reads back. |
| `push` | `sendPushToUser` / `sendPushToAdmins` | Time-critical events only. Push is a convenience over the in-app row, never a substitute for it. |

There is no SMS channel and none is proposed. **MUST NOT** introduce a third-party notification or
mail service; outbound mail stays on the platform's own SMTP.

`notify.ts` takes a coarse `type` and an optional `audience` key. `emitTalentEvent` **MUST** pass the
talent event key as `audience` (so `roleCanReceive` consults the map) and set the coarse `type` from
this table, which only controls the Notification Center's icon and filter:

| Talent event family | Coarse `type` |
|---|---|
| `tos.application.*`, `tos.stage.*`, `tos.selection.*`, `tos.admin.stage_*`, `tos.admin.selection_*`, `tos.evaluator.*` | `application` |
| `tos.interview.*` | `application` |
| `tos.code.*`, `tos.admin.code_*`, `tos.onboarding.*`, `tos.admin.onboarding_*` | `offer` |
| `tos.identity.*`, `tos.access.*`, `tos.admin.provisioning_*`, `tos.admin.access_*`, `tos.manager.*` | `hire` |
| `tos.admin.digest`, `tos.admin.override_recorded`, `tos.admin.notification_failed` | `system` |

### 19.3 Delivery class

| Class | Meaning |
|---|---|
| **transactional** | Emitted inside the operation that caused it, or inside the queued job that completes it. One message per event, to the specific people it concerns. |
| **batched** | Accumulated and delivered once per day as a digest to an **admin** audience. |

**MUST NOT** batch any candidate-facing notification. A candidate waiting on a decision is not an
operational feed, and a digest is how a rejection arrives four hours late in a list.

### 19.4 Rules the copy MUST obey

1. **No emojis.** Anywhere — subject, body, in-app title, push body, admin label, seed data.
   Iconography is inline monochrome SVG and lives in the surface, never in the message text.
2. **No backend state names.** The candidate never reads `under_review`, `is_authorised`,
   `not_started`, `stage_run`, `grant`, `slot_no` or a table name. Write what happened in words:
   "Your assignment is with the review panel."
3. **Never imply a stipend that is not recorded.** `tos_selection.stipend_amount` NULL means the
   engagement is **unpaid**, and the copy says so plainly (§19.6). "Compensation to be discussed",
   "details to follow" and silence are all prohibited where the field is NULL.
4. **Never claim EduRankAI awards a credential or a degree.** EduRankAI is the technology platform;
   accredited partners award credentials. No message may say "your EduRankAI certificate", "we will
   certify you", "our degree", or anything that reads as conferral.
5. **A rejection carries the written reason and the appeal route.** `tos_selection.decision_reason`
   is `NOT NULL` for exactly this purpose. The appeal route is the existing appeals product
   (`src/lib/application-appeals.ts`, `/portal/appeals`, `/portal/appeals/new`).
6. **Never name an outside company.** Recruitment channels are rows in `application_sources`,
   rendered from data. A document link is described as "the sharing link for the document, set so
   that anyone holding the link can view it" — never by naming a storage provider. The host format
   check itself lives in `src/lib/hr-onboarding.ts` and is an implementation detail, not copy.
7. **Never carry a secret except where the message is the delivery mechanism.** Only
   `tos.selection.selected` and `tos.code.reissued` carry an authorization code; only over email;
   never in a URL; and never in the in-app or push copy of the same event (§21.1 R-07).
8. **Address the person, state the fact, name the next action.** Three things, in that order. A
   notification that says something happened without saying what the reader may now do is a support
   ticket with extra steps.

### 19.5 Candidate catalogue

Variables are resolved **server-side, from the tables named**, never from a request body (§21.2):

| Variable | Source |
|---|---|
| `{{name}}` | `tos_person.display_name` |
| `{{role_title}}` | `roles.title` for `tos_application_link.opportunity_role_id` |
| `{{stage_label}}` | `tos_pipeline_stage.label` |
| `{{stage_blurb}}` | `tos_pipeline_stage.candidate_blurb` |
| `{{due}}` | `tos_stage_run.due_at`, formatted as a date and time with an explicit zone |
| `{{sel_ref}}` | `tos_selection.selection_ref` |
| `{{onb_ref}}` | `tos_onboarding.onboarding_ref` |
| `{{reason}}` | `tos_selection.decision_reason`, `tos_selection.suspended_reason`, `tos_onboarding.rejection_reason`, `tos_auth_code.revoked_reason`, or `tos_correction_request.decision_note` |
| `{{code}}` | the plaintext authorization code, held in memory for the length of the issue operation only (§10.2) |
| `{{code_expiry}}` | `tos_auth_code.expires_at` |
| `{{engagement}}` | `tos_selection.employment_type` |
| `{{department}}` | `departments.name` resolved from `tos_selection.offered_department_id` (**TEXT**, never `::uuid`) |
| `{{start_date}}` | `tos_selection.proposed_start_date` |
| `{{end_date}}` | `tos_identity.ended_on` |
| `{{manager}}` | display name for `tos_selection.reporting_manager_user_id`, resolved through `src/lib/org-graph.ts` |
| `{{identity_code}}` | `tos_identity.identity_code` |
| `{{official_email}}` | `tos_identity.official_email` |
| `{{field_key}}` | `tos_correction_request.field_key`, rendered through a label map, never as the raw column name |
| `{{stipend_line}}` | computed, §19.6 |

Audience `candidate` means the person on `tos_person`. Email is delivered to the `tos_person_email`
row where `is_verified` is true, falling back to `tos_person.primary_email` where no verified address
exists yet. In-app and push require a `users` row; where `tos_person.user_id` is NULL the event is
recorded in `tos_notification_log` with `state = 'suppressed'` on those channels and delivered by
email alone.

| Event key | Trigger | Audience | Channel | Class | Subject | Body | Variables |
|---|---|---|---|---|---|---|---|
| `tos.application.received` | `tos_application_link` row created | candidate | email, in_app | transactional | `Your application for {{role_title}} has been received` | `{{name}}, we have your application for {{role_title}}. You can follow every step of it in your portal. We will write to you when there is something for you to do, or a decision to read.` | name, role_title |
| `tos.stage.invited` | `tos_stage_run.state` becomes `invited` | candidate | email, in_app, push | transactional | `Next step for {{role_title}}: {{stage_label}}` | `{{name}}, the next step in your application for {{role_title}} is {{stage_label}}. {{stage_blurb}} It is open now and closes on {{due}}. Open it from your portal.` | name, role_title, stage_label, stage_blurb, due |
| `tos.stage.reminder` | 48 hours before `tos_stage_run.due_at`, run still open | candidate | email, in_app, push | transactional | `{{stage_label}} for {{role_title}} closes on {{due}}` | `{{name}}, your {{stage_label}} is still open and closes on {{due}}. If something is preventing you from finishing it, write to the people desk before the closing time and a person will read it.` | name, role_title, stage_label, due |
| `tos.stage.missed` | `due_at` passed with nothing submitted | candidate | email, in_app | transactional | `{{stage_label}} for {{role_title}} has closed` | `{{name}}, the closing time for {{stage_label}} has passed and we did not receive your submission. Your application is paused rather than closed. If you were prevented from finishing, write to the people desk with what happened and a person will decide.` | name, role_title, stage_label |
| `tos.stage.received` | `tos_stage_run.state` becomes `submitted` | candidate | email, in_app | transactional | `We have your {{stage_label}} for {{role_title}}` | `{{name}}, your {{stage_label}} is with the review panel. You do not need to do anything while it is being read.` | name, role_title, stage_label |
| `tos.stage.advanced` | `tos_stage_run.state` becomes `passed` and a later required slot exists | candidate | email, in_app, push | transactional | `You are through to the next step for {{role_title}}` | `{{name}}, your {{stage_label}} was successful and your application for {{role_title}} continues. The next step will open in your portal, and we will write to you when it does.` | name, role_title, stage_label |
| `tos.interview.scheduled` | interview stage run scheduled | candidate | email, in_app, push | transactional | `Interview for {{role_title}} on {{due}}` | `{{name}}, your interview for {{role_title}} is scheduled for {{due}}. Joining details are in your portal. If the time does not work, say so from the portal at least 24 hours beforehand and we will offer another.` | name, role_title, due |
| `tos.interview.rescheduled` | interview stage run time changed | candidate | email, in_app, push | transactional | `Your interview for {{role_title}} has moved to {{due}}` | `{{name}}, your interview for {{role_title}} has been moved to {{due}}. The joining details in your portal are unchanged.` | name, role_title, due |
| `tos.selection.selected` | `tos_selection.is_authorised` set true and a code issued (§9.7, §10.2) | candidate | **email carries the code**; in_app and push carry none | transactional | `You have been selected for {{role_title}}` | `{{name}}, you have been selected for {{role_title}}. Reference {{sel_ref}}.` / `Engagement: {{engagement}}. Team: {{department}}. Reporting to: {{manager}}. Expected start: {{start_date}}.` / `{{stipend_line}}` / `Your authorization code is {{code}}. It opens your onboarding and nothing else, it is valid until {{code_expiry}}, and it is for you alone. Enter it on your onboarding page; we will never ask you for it by reply, by telephone or in a chat.` / `{{credential_line}}` | name, role_title, sel_ref, engagement, department, manager, start_date, stipend_line, code, code_expiry |
| `tos.selection.rejected` | `tos_selection.decision` recorded as `rejected` | candidate | email, in_app | transactional | `Decision on your application for {{role_title}}` | `{{name}}, we have decided not to take your application for {{role_title}} further.` / `{{rejection_tail}}` (§19.6: the recorded reason, then the appeal route and its 14-day window) / `You are welcome to apply again for a different opportunity.` | name, role_title, reason |
| `tos.selection.waitlisted` | `tos_selection.decision` recorded as `waitlisted` | candidate | email, in_app | transactional | `Your application for {{role_title}} is on the waiting list` | `{{name}}, your application for {{role_title}} was strong and we have placed it on the waiting list. The reason recorded is: {{reason}}` / `That means we will come back to you if a place opens before this opportunity closes. It is not an offer, and you should not hold anything open for it.` | name, role_title, reason |
| `tos.selection.suspended` | `tos_selection.suspended_at` set (§9.8) | candidate | email, in_app | transactional | `Your selection for {{role_title}} is on hold` | `{{name}}, selection {{sel_ref}} has been placed on hold and any authorization code issued for it no longer works. The reason recorded is: {{reason}} If you believe that rests on something factually wrong, open an appeal from your portal within 14 days.` | name, role_title, sel_ref, reason |
| `tos.code.reissued` | a replacement code issued for a live selection (§10.2) | candidate | **email carries the code**; in_app carries none | transactional | `A new authorization code for {{role_title}}` | `{{name}}, a new authorization code has been issued for your selection {{sel_ref}}. The previous code no longer works. Your new code is {{code}} and it is valid until {{code_expiry}}. If you did not ask for it, tell the people desk now.` | name, role_title, sel_ref, code, code_expiry |
| `tos.code.expiring` | 72 hours before `tos_auth_code.expires_at`, still unconsumed | candidate | email, in_app, push | transactional | `Your authorization code expires on {{code_expiry}}` | `{{name}}, the authorization code for {{sel_ref}} expires on {{code_expiry}} and your onboarding has not been opened yet. If you have lost the code or need more time, write to the people desk and a new one can be issued. We cannot tell you what the old code was; only replace it.` | name, sel_ref, code_expiry |
| `tos.code.revoked` | `tos_auth_code.revoked_at` set | candidate | email, in_app | transactional | `Your authorization code for {{role_title}} has been withdrawn` | `{{name}}, the authorization code issued for {{sel_ref}} has been withdrawn and no longer works. The reason recorded is: {{reason}} If this is unexpected, write to the people desk.` | name, role_title, sel_ref, reason |
| `tos.code.attempted` | a challenge is sent on the §10.6 path B redemption route | candidate | email | transactional | `Someone entered your authorization code` | `{{name}}, an authorization code issued to you was entered on {{when}} from {{source}}. If that was you, open the link below to continue; it works once and expires in 15 minutes.` / `If it was not you, use the "this was not me" link instead. It reports the attempt to the selection team. Your code and your selection are not changed by either link.` | name, when, source |
| `tos.onboarding.opened` | `tos_onboarding` row created | candidate | email, in_app | transactional | `Your onboarding for {{role_title}} is open` | `{{name}}, your onboarding is open under reference {{onb_ref}}. It asks for the details we need and for sharing links to a few documents. Some fields are filled in by us and cannot be edited. If one of them is wrong, use the correction link beside it and tell us what it should say.` / `{{stipend_line}}` | name, role_title, onb_ref, stipend_line |
| `tos.onboarding.deadline` | 72 hours, then 24 hours, before the onboarding closing date | candidate | email, in_app, push | transactional | `Your onboarding {{onb_ref}} closes on {{due}}` | `{{name}}, your onboarding is not complete and closes on {{due}}. Anything still outstanding is listed at the top of the form. If you cannot finish in time, say so on the form and a person will read it.` | name, onb_ref, due |
| `tos.onboarding.document_returned` | a document is marked as needing resubmission (`hr_onboarding_documents.status` becomes `rejected`) | candidate | email, in_app | transactional | `One of your onboarding documents needs another look` | `{{name}}, one document on your onboarding {{onb_ref}} could not be accepted. The note from the reviewer is: {{reason}} Replace the sharing link on your onboarding form, and check that its sharing setting lets anyone holding the link view it.` | name, onb_ref, reason |
| `tos.onboarding.correction_decided` | `tos_correction_request.state` becomes `accepted` or `rejected` | candidate | email, in_app | transactional | `Your correction request on {{field_key}} has been answered` | `{{name}}, your correction request on onboarding {{onb_ref}} has been answered. The decision is: {{reason}} You can see the current value on your onboarding form.` | name, onb_ref, field_key, reason |
| `tos.onboarding.approved` | `tos_onboarding.approved_at` set and `tos_identity` created (§13.3) | candidate | email, in_app, push | transactional | `Your onboarding is complete` | `{{name}}, your onboarding is complete and your organizational identity has been created. Your identity number is {{identity_code}} and your work address is {{official_email}}.` / `You start on {{start_date}} with {{department}}, reporting to {{manager}}.` / `{{stipend_line}}` / `{{credential_line}}` | name, identity_code, official_email, start_date, department, manager, stipend_line |
| `tos.onboarding.rejected` | `tos_onboarding.rejected_at` set | candidate | email, in_app | transactional | `Your onboarding for {{role_title}} could not be completed` | `{{name}}, onboarding {{onb_ref}} has been closed without an identity being created.` / `{{rejection_tail}}` | name, role_title, onb_ref, reason |
| `tos.access.granted` | every `tos_provisioning_event` for an identity reaches `applied` | candidate | in_app, push | transactional | `Your workspace is ready` | `{{name}}, everything on your access list has been set up. Sign in with {{official_email}} to see it.` | name, official_email |
| `tos.identity.suspended` | `tos_identity.status` becomes `suspended` | candidate | email, in_app | transactional | `Access for {{identity_code}} has been suspended` | `{{name}}, access for identity {{identity_code}} has been suspended and your sessions have been signed out. The reason recorded is: {{reason}} Your record is intact. Speak to your reporting manager or the people desk.` | name, identity_code, reason |
| `tos.identity.expiring` | 14 days before `tos_identity.ended_on` | candidate | email, in_app | transactional | `Your engagement is recorded as ending on {{end_date}}` | `{{name}}, identity {{identity_code}} is recorded as ending on {{end_date}}, after which your access will close. If that date is wrong, tell your reporting manager now rather than on the day.` | name, identity_code, end_date |
| `tos.identity.ended` | `tos_identity.status` becomes `expired` or `terminated` | candidate, **personal address only** | email | transactional | `Access for {{identity_code}} has closed` | `{{name}}, access for identity {{identity_code}} has closed and your work address no longer receives mail. Anything you need from your work account should be requested from the people desk.` | name, identity_code |

`tos.identity.ended` is delivered to the `tos_person_email` row where `is_official` is **false**.
**REASON**: sending the mailbox-closed notice to the mailbox being closed is a message nobody reads.
Where no non-official address is on file the event is recorded `state = 'suppressed'` and
`tos.admin.notification_failed` is raised, because the person genuinely cannot be told.

`{{when}}` and `{{source}}` on `tos.code.attempted` are the server clock and the **truncated** source
address (IPv4 to /24, IPv6 to /64), matching the abuse board's display rule in §10.4.

### 19.6 The three computed lines

```ts
// src/lib/talentos/notify-copy.ts
// Declared at module top so no handler reaches a later `const` — `const` is not hoisted, and a
// handler reaching a later declaration has taken pages down on this project.

/**
 * The ONLY place a stipend becomes words. NULL is not "unknown" and not "to be discussed"; it is the
 * recorded fact that this engagement is unpaid, and the person is told so before they accept
 * anything. NUMERIC(12,2) arrives from postgres-js as a string, so it is coerced here rather than
 * compared as a number somewhere downstream.
 */
export function stipendLine(sel: {
  stipend_amount: string | number | null;
  stipend_currency: string | null;
}): string {
  const raw = sel.stipend_amount;
  const amt = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  if (amt === null || !Number.isFinite(amt) || amt <= 0) {
    return 'This engagement is unpaid. No stipend or salary is recorded for it.';
  }
  const cur = String(sel.stipend_currency || 'INR');
  return 'A stipend of ' + cur + ' ' + amt.toLocaleString('en-IN') + ' per month is recorded for this engagement.';
}

/** No message may describe EduRankAI as conferring a qualification. */
export const CREDENTIAL_LINE =
  'EduRankAI is the technology platform. Where a credential forms part of an engagement, it is'
  + ' awarded by an accredited partner institution, not by EduRankAI.';

/** Every rejection carries the written reason and the route to contest it. */
export function rejectionTail(reason: string): string {
  const r = String(reason || '').trim();
  if (!r) throw new Error('a rejection notification cannot be rendered without a recorded reason');
  return 'The reason recorded is: ' + r
    + '\n\nIf you believe the decision rested on something factually wrong, or on evidence the panel'
    + ' did not have, open an appeal from your portal at /portal/appeals/new within 14 days.';
}
```

**MUST**: `rejectionTail` throws rather than rendering an empty reason, and the caller lets the throw
surface. A rejection without a reason is a defect in the **decision**, not a formatting problem.
`tos_selection.decision_reason` is `NOT NULL` precisely so this cannot happen quietly, and §9.4
requires the reason in both directions.

**MUST NOT** paraphrase, truncate or "soften" `decision_reason` in transit. The candidate reads what
the panel wrote. If a reason is not fit to be read by the person it is about, the fix is at §9.4, not
in the renderer.

### 19.7 Admin, evaluator and manager catalogue

Audience values map to `NOTIFICATION_AUDIENCE` entries in `notify-audience.ts`, reusing the arrays
already declared there: `HR_RECRUITING` (`super_admin, hr, recruiter, reviewer, department_head`),
`RECRUITING` (`super_admin, hr, recruiter`), `HR_CORE` (`super_admin, hr`).

`evaluator`, `manager` and `approver` are **per-user** sends resolved from data
(`tos_opportunity.evaluator_user_ids`, `tos_selection.reporting_manager_user_id`,
`tos_selection.approved_by_user_id`, the org graph via `src/lib/org-graph.ts`) and go through
`notifyUser`, **never** `notifyAllAdmins`.

| Event key | Trigger | Audience | Channel | Class | Subject / title | Body | Variables |
|---|---|---|---|---|---|---|---|
| `tos.admin.stage_submitted` | `tos_stage_run.state` becomes `submitted` | evaluator (per-user), `HR_RECRUITING` | in_app, push | transactional | `{{stage_label}} submitted for review` | `{{name}} has submitted {{stage_label}} for {{role_title}}.` | name, stage_label, role_title |
| `tos.admin.stage_sla_breached` | run in `submitted` or `under_review` past `tos_pipeline_stage.sla_days` (§8.9) | `HR_RECRUITING` | in_app | **batched** | `Reviews past their service level` | `{{count}} submissions have been waiting longer than the review window set for their step. Open the review queue to see them.` | count |
| `tos.admin.evaluation_split` | two `tos_evaluation` rows on one run disagree on `verdict` | `HR_RECRUITING` | in_app | transactional | `Evaluators disagree on {{stage_label}}` | `The panel for {{name}} on {{role_title}} has recorded different verdicts. A decision is needed.` | name, role_title, stage_label |
| `tos.admin.selection_awaiting_approval` | `tos_selection` recorded, second signature required, `approved_at` NULL (§9.5) | approver (per-user), `RECRUITING` | in_app, push, email | transactional | `A selection is waiting for your approval` | `{{sel_ref}}: {{name}} for {{role_title}}, decided by {{actor}}. Open it to approve it or send it back.` | sel_ref, name, role_title, actor |
| `tos.admin.code_issued` | `tos_auth_code` row created | `RECRUITING` | in_app | transactional | `Authorization code issued for {{sel_ref}}` | `A code ending {{code_last4}} was issued for {{name}} on {{role_title}} and expires on {{code_expiry}}.` | sel_ref, name, role_title, code_last4, code_expiry |
| `tos.admin.code_delivery_failed` | `sendEmail` returned `ok: false` for a code | `RECRUITING` | in_app, push | transactional | `An authorization code could not be delivered` | `The code for {{sel_ref}} was not accepted by the mail server. The selected person has not received it. Re-issue it, or deliver it another way.` | sel_ref |
| `tos.admin.code_abuse` | a §10.4 bucket trips, or the global sweep threshold trips | `RECRUITING` | in_app, push | transactional | `Repeated failed authorization code attempts` | `{{count}} failed attempts in the last {{window}}. Open the codes board to see them.` | count, window |
| `tos.admin.code_person_mismatch` | ladder rung 6: a signed-in person redeemed a code bound to a different person (§10.3) | `RECRUITING` | in_app | transactional | `A code was entered by someone it was not issued to` | `The code for {{sel_ref}} was entered by a signed-in account that is not the person it is bound to. This is worth a look.` | sel_ref |
| `tos.admin.code_challenge_disowned` | a recipient followed the "this was not me" link (§10.6) | `RECRUITING`, `super_admin` | in_app, push | transactional | `A candidate says they did not enter their code` | `{{name}} reports that they did not enter the code for {{sel_ref}}. Nothing has been changed automatically. Decide whether to revoke and re-issue.` | name, sel_ref |
| `tos.admin.onboarding_submitted` | `tos_onboarding.submitted_at` set | `HR_CORE` | in_app, push | transactional | `Onboarding submitted: {{name}}` | `{{onb_ref}} for {{role_title}} is ready to verify.` | name, onb_ref, role_title |
| `tos.admin.correction_requested` | `tos_correction_request` row created | `HR_CORE` | in_app | transactional | `A candidate has disputed a locked field` | `{{name}} says {{field_key}} on {{onb_ref}} is wrong. Their note is on the request.` | name, field_key, onb_ref |
| `tos.admin.document_pending` | documents awaiting review for longer than 48 hours | `HR_CORE` | in_app | **batched** | `Onboarding documents waiting for review` | `{{count}} documents have been waiting more than two days.` | count |
| `tos.admin.provisioning_failed` | `tos_provisioning_event.state` becomes `failed` | `HR_CORE`, `super_admin` | in_app, push | transactional | `Access could not be set up for {{identity_code}}` | `{{target_kind}} {{target_key}} failed. The person has an identity but not the access it implies.` | identity_code, target_kind, target_key |
| `tos.admin.access_request_open` | `tos_access_request` row created | approver (per-user) | in_app, email | transactional | `An access request needs your decision` | `{{identity_code}} has asked for {{target_key}}. The stated reason is on the request.` | identity_code, target_key |
| `tos.admin.identity_expiring` | 14 days before `tos_identity.ended_on` | manager (per-user), `HR_CORE` | in_app | **batched** | `Engagements ending soon` | `{{count}} identities are recorded as ending in the next 14 days.` | count |
| `tos.admin.override_recorded` | `tos_override` row inserted | `super_admin` | in_app | transactional | `A state was set outside the normal route` | `{{actor}} set {{entity}} from {{from_state}} to {{to_state}}. The reason they gave is on the override record.` | actor, entity, from_state, to_state |
| `tos.admin.notification_failed` | a non-suppressible notification exhausted its retries (§19.9) | `super_admin` | in_app | transactional | `A required message could not be delivered` | `{{event_key}} for {{recipient}} failed after every retry. The person has not been told.` | event_key, recipient |
| `tos.evaluator.assigned` | an evaluator is attached to a stage run | evaluator (per-user) | in_app, email | transactional | `You have been asked to evaluate {{stage_label}}` | `{{name}} for {{role_title}}. The submission is in your evaluation queue.` | name, role_title, stage_label |
| `tos.evaluator.reminder` | evaluation outstanding, 24 hours before `sla_days` elapses | evaluator (per-user) | in_app, push | transactional | `An evaluation is due tomorrow` | `Your verdict on {{stage_label}} for {{name}} is due within 24 hours.` | name, stage_label |
| `tos.manager.consent_requested` | internal applicant, `tos_opportunity.requires_manager_consent` (§7.9) | manager (per-user) | in_app, email | transactional | `A person reporting to you has applied internally` | `{{name}} has applied for {{role_title}}. This opportunity asks for your acknowledgement before the application proceeds. Your acknowledgement is not a decision on the application, and withholding it is not a rejection.` | name, role_title |
| `tos.manager.report_starting` | `tos_identity` created with this user as reporting manager | manager (per-user) | in_app, email | transactional | `{{name}} joins your team on {{start_date}}` | `{{name}} starts on {{start_date}} as {{offered_title}}. Their onboarding checklist has items assigned to you.` | name, start_date, offered_title |
| `tos.admin.digest` | daily | `super_admin` | in_app | **batched** | `Talent activity for {{date}}` | Counts only: applications received, stages decided, selections made, codes issued, onboardings approved, provisioning failures. **No names.** | date, counts |

**MUST NOT** put a candidate's name, email address or circumstances in `tos.admin.digest` or in any
other batched broadcast. The audience audit recorded in the header of `notify-audience.ts` exists
because named-person detail in a broadcast is exactly how a stranger's payment failure, hardship
declaration and application reached every role in the building.

**MUST NOT** put a leave type, a health-adjacent field, `date_of_birth`, `blood_group` or any
statutory or bank identifier in any notification title or body, admin or candidate. The precedent is
already in the tree: `notify.leaveRequest` deliberately drops the leave type from the body because a
notification is duplicated per recipient, lands outside any authorization check, and survives in a
table nobody reviews. The same reasoning binds every event here (§21.3).

### 19.8 Preferences, and what cannot be suppressed

Preferences live where they already live: `notification_preferences.prefs` (jsonb), where
`{ "<event key>": false }` mutes and an absent key means on. The talent events add **no** new
preference table and no new preference column.

```ts
// src/lib/talentos/notify.ts
/**
 * Events a person may NOT mute on the email and in-app channels.
 *
 * REASON: each is the only notice a person gets of something that changes what they may do, or of
 * something that expires while they wait. A muted code issuance is a selection the candidate never
 * learns they have; a muted onboarding deadline is a place lost to a toggle set months earlier for
 * an unrelated product.
 */
export const NON_SUPPRESSIBLE = new Set<string>([
  'tos.selection.selected',
  'tos.selection.rejected',
  'tos.selection.suspended',
  'tos.code.reissued',
  'tos.code.expiring',
  'tos.code.revoked',
  'tos.code.attempted',
  'tos.onboarding.deadline',
  'tos.onboarding.approved',
  'tos.onboarding.rejected',
  'tos.identity.suspended',
  'tos.identity.expiring',
  'tos.identity.ended',
]);
```

| Rule | Statement |
|---|---|
| Scope | A non-suppressible event **MUST** be delivered on `email` and `in_app` regardless of `notification_preferences.prefs`. The **push** copy of the same event MAY still be muted — push is a device convenience, and muting it does not remove the notice. |
| Preference surface | `/portal/notifications` and `/admin/notifications-setup` render a toggle for every suppressible key and, for a non-suppressible key, the words "Always sent" with **no control**. **MUST NOT** render a toggle that does nothing. A dead toggle is a promise the system does not keep, and it will be discovered by the one person whose selection email it appeared to switch off. |
| Email footer | A suppressible event links to the preference page. A non-suppressible event's footer reads: `This message is part of your application record and is always sent.` |
| Admin roles | An administrator may mute any `tos.admin.*` key **except** `tos.admin.provisioning_failed`, `tos.admin.code_delivery_failed` and `tos.admin.notification_failed`, which are operational failures whose only other surface is `/admin/ops`. |
| Bulk suppression | There is no "pause all notifications" control, and none may be added for candidate-facing keys. |
| Audience narrowing is not suppression | `roleCanReceive` narrowing an admin event to the mapped roles is routing. Recording it as `suppressed` in `tos_notification_log` would make routine routing look like a lost message; those recipients are simply not in the audience. |

### 19.9 Delivery failure handling

New table. Full idempotent DDL per §3 — `CREATE TABLE IF NOT EXISTS` **plus** an
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` for every column past the primary key, because
`CREATE TABLE IF NOT EXISTS` is a no-op on an existing table that is missing columns, and that exact
gap once locked every administrator out of `/admin`.

```sql
-- db/talent-os-schema.sql  (mirror of ensureOnce('tos_notification_log_v1', …))
CREATE TABLE IF NOT EXISTS tos_notification_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key           TEXT NOT NULL,
  channel             TEXT NOT NULL,                  -- email|in_app|push
  recipient_person_id UUID,
  recipient_user_id   UUID,
  recipient_email     TEXT,
  entity              TEXT,                           -- 'tos_selection', 'tos_onboarding', ...
  entity_id           UUID,
  state               TEXT NOT NULL DEFAULT 'queued', -- queued|sent|failed|suppressed
  is_mandatory        BOOLEAN NOT NULL DEFAULT FALSE,
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS event_key           TEXT;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS channel             TEXT;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS recipient_person_id UUID;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS recipient_user_id   UUID;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS recipient_email     TEXT;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS entity              TEXT;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS entity_id           UUID;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS state               TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS is_mandatory        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS attempts            INT NOT NULL DEFAULT 0;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS last_error          TEXT;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS sent_at             TIMESTAMPTZ;
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tos_notification_log ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS tos_notif_state_idx  ON tos_notification_log (state, created_at DESC);
CREATE INDEX IF NOT EXISTS tos_notif_event_idx  ON tos_notification_log (event_key, created_at DESC);
CREATE INDEX IF NOT EXISTS tos_notif_person_idx ON tos_notification_log (recipient_person_id, created_at DESC);
```

**MUST NOT** store the rendered subject or body in `tos_notification_log`. The log records **that** a
message of a given kind was attempted to a given recipient, not its contents. The selection email
contains an authorization code, and a copy of it in a second table with a wider read audience defeats
the entire reason the code is stored only as a keyed hash (§10.2, §21.1 R-07).

| Rule | Statement |
|---|---|
| Nothing throws | `sendEmail` already returns `{ ok, error }` rather than throwing, and `notifyUser` / `notifyAllAdmins` catch and log `e.cause?.message \|\| e.message`. `emitTalentEvent` **MUST** hold the same contract: **a failed notification never fails the operation that caused it.** The selection is made whether or not the email left the building. |
| Retry | A non-suppressible event is retried through the existing queue: `enqueue('tos.notify', payload, { dedupKey: dedupKey('tos.notify', [eventKey, logId]), maxAttempts: 4, runAfterMs: backoffMs(attempt) })`. `attempts` and `last_error` are written back on the log row. A suppressible event is attempted once. |
| Exhaustion | When a non-suppressible event exhausts its attempts the row moves to `state = 'failed'` and `tos.admin.notification_failed` is raised. The underlying record — the selection, the code, the identity — is **not** rolled back. A person is selected whether or not we managed to tell them; the fix is to tell them, not to unmake the decision. |
| Delivery is not assumed | `tos_auth_code.delivered_at` is set **only** when `sendEmail` returned `ok: true`. A failure raises `tos.admin.code_delivery_failed` and leaves `delivered_at` NULL. **REASON**: an administrator reading "delivered" for a code that bounced waits instead of re-issuing, and the candidate loses the window. |
| Error text | `last_error` stores `e?.cause?.message \|\| e?.message`. Storing `e.message` alone from postgres-js stores the failed SQL and nothing about why it failed. |
| Suppressed is a state | A message not sent because the recipient muted it is written with `state = 'suppressed'`, never skipped silently, so "they were never told" and "they chose not to be told" stay distinguishable months later in a dispute. |
| A known queue gap, stated | `edu_jobs` has no crashed-worker reclaim: a job claimed by a worker that dies stays `processing`. This affects every queue user on this project, not only notifications. Until it is fixed, the `/admin/ops` queue health view and `retryFailed()` are the operational remedy, and **MUST NOT** be presented as automatic recovery. |
| Bounce is not failure | A `250` from the relay is acceptance, not delivery. `state = 'sent'` means the relay accepted it. A later bounce is visible only in mail-side reporting, and no talent state may depend on it. |

### 19.10 A notification is never the authority for a state change

**MUST**: no state in this system moves because a notification was sent, opened, clicked or
delivered. State moves only through the module that owns the table, after the server re-derives the
facts (§21.2).

Concretely:

- The selection email carries a **code**, not a link that authorises. No URL in any message advances
  anything by being opened. The one link that does anything — the §10.6 path B challenge — is a
  single-use token whose hash is a row in `tos_code_challenge`, and following it **re-runs the entire
  validation ladder from rung 1 against current state**. It carries no authority of its own.
- Opening `/onboarding` from an email lands on a form that asks for the code. The
  `tos_onboarding_grant` row is minted server-side after redemption; the email is evidence of nothing.
- **MUST NOT** implement an open-tracking pixel or a click-tracking redirect that writes to
  `tos_stage_run.state`, `tos_onboarding.state`, `tos_selection.decision`, `tos_auth_code`, or any
  `tos_*` column at all.
- A row in `notifications` is a **copy of a fact**. Reading it back to make a decision is prohibited,
  and `notifications.entity_id` is a link for a human, not a foreign key the server trusts.
- **Every notification MUST have a portal surface showing the same fact.** If a message is lost in a
  spam filter, the candidate still sees the step, the decision, the recorded reason and the deadline
  in `/portal/applications` and on the onboarding form. A notification that is the only place a fact
  appears is a defect, and the conformance suite asserts a surface for each key (§25).
- The inverse also holds: **a fact is not established by having been notified.** "We emailed them" is
  not a state. `tos_notification_log` answers whether we tried; the domain table answers what is true.

---

## 20. Audit trail [brief §31]

### 20.1 The sink

`src/lib/audit.ts`, **unchanged**, is the only writer. This spec adds no second audit table and no
"talent audit" module.

```ts
logAudit({ userId, action, entity, entityId, diff, ipAddress }): Promise<AuditResult>  // { ok, error? }
logAuditOrThrow(args): Promise<void>                                                    // throws when the row did not land
```

Facts about it that this section depends on, all of them already true in the tree:

- `logAudit` **swallows** the failure and returns `{ ok: false, error }`. 454 call sites depend on a
  logging hiccup never blocking somebody's work. **MUST NOT** change that.
- On failure it forwards to `trackError('audit.write_failed', err, { action, entity, entityId })`,
  which writes `edu_error_log` and surfaces on the `/admin/ops` incident board. `args.diff` and
  `args.userId` are **deliberately not forwarded**, because the error log is a lower-trust store with
  different retention and a wider read audience. **MUST NOT** change that either — and the same
  judgement is what §20.4 applies one level up.
- `logAuditOrThrow` is the strict variant, for paths where the audit row **is** the control. It is
  already used that way by `src/lib/auth/registry.ts` (`recordStrict`).
- `ensureAuditIndexes()` is called from **readers**, not from `logAudit`. A write path must not pay
  for schema work. New talent surfaces that read `audit_log` call it; nothing that writes does.

### 20.2 Naming

| Element | Rule |
|---|---|
| `action` | `tos.<subject>.<verb>`, lowercase, dot-separated, neutral verb (`create`, `update`, `decide`, `issue`, `revoke`, `consume`, `verify`, `apply`, `reveal`, `merge`, `prune`). **Stable forever** — `/admin/audit` builds its facet list from `action`, and `audit_action_idx` is the index that makes it cheap. Renaming an action orphans every historical row. |
| `entity` | The **table name** the row lives in: `tos_selection`, `tos_stage_run`, `tos_identity`, `hr_onboarding_documents`. `audit_entity_idx` is on `(entity, entity_id)` and only helps if the pair is written consistently. |
| `entityId` | The primary key of that row, as text. For `tos_opportunity` it is `role_id`; for `tos_application_link` it is `application_id`. Never a code, never an email, never a composite string, never a person's name. |
| `userId` | The acting `users.id`, taken from the session. `null` **only** for a genuinely unauthenticated actor — a code-entry attempt from a signed-out visitor, or a scheduled job. **Never the subject of the action**: an audit row records who acted, and putting the subject there makes every candidate look like an administrator. |
| `ipAddress` | Taken from the request on the server (`clientAddress`). **Never** from a request body (§21.2). |

### 20.3 Event catalogue

Every event in [brief §31] appears here, plus the events this specification introduces beyond it —
marked **new** — which are code verification attempts, grant issue and consume, correction requests,
provisioning events, sensitive-field reveals, and overrides.

The **Strict** column means `logAuditOrThrow` plus the ordering rule in §20.5.

| Event | action | entity | entityId | diff carries | Strict |
|---|---|---|---|---|---|
| Opportunity configured | `tos.opportunity.create` / `.update` | `tos_opportunity` | `role_id` | changed field keys with from/to for non-sensitive config (`applications_open`, `pipeline_id`, `code_validity_days`, `access_profile_id`) | no |
| Opportunity opened or closed | `tos.opportunity.open` / `.close` | `tos_opportunity` | `role_id` | `{ from, to, closes_at }` | no |
| Pipeline or stage configured | `tos.pipeline.update` / `tos.pipeline_stage.update` | `tos_pipeline` / `tos_pipeline_stage` | row id | `slot_no`, changed keys, and the **shape** of `pass_rule` / `evaluator_rule` (rule keys, never candidate data) | no |
| Application linked to a person | `tos.application.link` | `tos_application_link` | `application_id` | `{ person_id, opportunity_role_id, pathway, applicant_type, source_slug }` | no |
| Eligibility refused | `tos.eligibility.refuse` | `tos_opportunity` | `role_id` | `{ person_id, failed_rule_keys }` — **rule keys, never the underlying attribute values** | no |
| Stage run opened | `tos.stage_run.invite` | `tos_stage_run` | run id | `{ slot_no, kind, due_at }` | no |
| Stage submitted | `tos.stage_run.submit` | `tos_stage_run` | run id | `{ slot_no, submitted_at, external_ref }` | no |
| Stage decided | `tos.stage_run.decide` | `tos_stage_run` | run id | `{ slot_no, from, to, score, decided_by }` | no |
| Stage waived or skipped | `tos.stage_run.waive` / `.skip` | `tos_stage_run` | run id | `{ slot_no, from, to, override_id }` | **yes** |
| Advisory flag raised | `tos.stage_run.flag` **(new)** | `tos_stage_run` | run id | `{ slot_no, flag_kind, source }` — and **nothing about the outcome**, because a flag never sets one (§21.1 R-12) | no |
| Evaluation recorded | `tos.evaluation.create` | `tos_evaluation` | evaluation id | `{ stage_run_id, verdict, score, dimension_keys }` — **keys only**, never the free-text comments | no |
| Evaluation amended | `tos.evaluation.update` | `tos_evaluation` | evaluation id | `{ from_verdict, to_verdict, from_score, to_score }` | no |
| Selection decided | `tos.selection.decide` | `tos_selection` | selection id | `{ decision, opportunity_role_id, application_id, reason_length }` — the **reason text is not copied**; it is already on the row, behind that row's gate | **yes** |
| Second signature | `tos.selection.approve` | `tos_selection` | selection id | `{ approved_by_user_id }` | **yes** |
| Selection authorised | `tos.selection.authorise` | `tos_selection` | selection id | `{ from: false, to: true }` | **yes** |
| Selection suspended | `tos.selection.suspend` | `tos_selection` | selection id | `{ suspended_reason_length, codes_revoked, grants_revoked }` | **yes** |
| Code issued | `tos.auth_code.issue` | `tos_auth_code` | code id | `{ selection_id, code_last4, expires_at, max_uses }` | **yes** |
| Code re-issued | `tos.auth_code.reissue` | `tos_auth_code` | **new** code id | `{ superseded_code_id, code_last4, expires_at }` | **yes** |
| Code delivered | `tos.auth_code.deliver` | `tos_auth_code` | code id | `{ delivered_at, channel: 'email' }` — **never the address** | no |
| Code revoked | `tos.auth_code.revoke` | `tos_auth_code` | code id | `{ revoked_reason_length, superseded_by_id }` | **yes** |
| **Code verification attempt** | `tos.auth_code.verify` **(new)** | `tos_auth_code` | the matched code id, or `null` when nothing matched | `{ outcome, matched: true\|false, attempt_id, rung }` where `attempt_id` is the `tos_code_attempt.id` and `outcome` is one of §10.3's eleven result codes plus `rate_limited` and `ok`. **Never the code, never its normalised form, never its hash** | **yes** on `ok`; see §20.5 |
| **Challenge sent** | `tos.auth_code.challenge` **(new)** | `tos_code_challenge` | challenge id | `{ auth_code_id, expires_at }` — **never the challenge token or its hash, never the address** | no |
| **Challenge disowned** | `tos.auth_code.disown` **(new)** | `tos_auth_code` | code id | `{ challenge_id, reported_at }` | no |
| Code lock cleared | `tos.code.lock.cleared` | `tos_code_attempt` | `null` | `{ code_last4, cleared_by_user_id }` — **never the hash the bucket was keyed on** | **yes** |
| **Grant issued** | `tos.grant.issue` **(new)** | `tos_onboarding_grant` | grant id | `{ selection_id, auth_code_id, expires_at }` — **never the grant token or its hash** | **yes** |
| **Grant consumed** | `tos.grant.consume` **(new)** | `tos_onboarding_grant` | grant id | `{ consumed_at, onboarding_id }` | **yes** |
| Grant revoked or expired | `tos.grant.revoke` **(new)** | `tos_onboarding_grant` | grant id | `{ reason: 'revoked' \| 'expired' \| 'superseded' }` | no |
| Onboarding opened | `tos.onboarding.create` | `tos_onboarding` | onboarding id | `{ selection_id, form_version, locked_field_keys }` — **key names only** | no |
| Onboarding saved | `tos.onboarding.save` | `tos_onboarding` | onboarding id | `{ answered_field_keys }` — **key names only, never a value** | no |
| Onboarding submitted | `tos.onboarding.submit` | `tos_onboarding` | onboarding id | `{ answered_field_keys, document_count }` | no |
| Onboarding verified | `tos.onboarding.verify` | `tos_onboarding` | onboarding id | `{ verified_by_user_id }` | **yes** |
| Onboarding approved | `tos.onboarding.approve` | `tos_onboarding` | onboarding id | `{ identity_id, employee_id }` | **yes** |
| Onboarding rejected | `tos.onboarding.reject` | `tos_onboarding` | onboarding id | `{ rejection_reason_length }` | **yes** |
| **Correction requested** | `tos.correction.create` **(new)** | `tos_correction_request` | request id | `{ onboarding_id, field_key }` — **the field key, never the current or the proposed value** | no |
| **Correction decided** | `tos.correction.decide` **(new)** | `tos_correction_request` | request id | `{ field_key, state, decided_by_user_id }` | **yes** when the field is Class B, C or H (§21.3) |
| **Sensitive field revealed** | `tos.onboarding.reveal` **(new)** | `hr_employees` | employee id | `{ field_key, subject_person_id }` — **never the value revealed** | **yes** |
| Document submitted | `tos.document.submit` | `hr_onboarding_documents` | document id | `{ doc_type }` — **never the link, never the title if the title is free text** | no |
| Document reviewed | `tos.document.review` | `hr_onboarding_documents` | document id | `{ doc_type, from_status, to_status }` — **never the link, never the reviewer note** | no |
| Identity created | `tos.identity.create` | `tos_identity` | identity id | `{ person_id, identity_type, identity_code, department_id, engagement_type, source_onboarding_id }` — `department_id` as **TEXT** | **yes** |
| Identity activated | `tos.identity.activate` | `tos_identity` | identity id | `{ from, to, is_primary }` | **yes** |
| Identity suspended / terminated | `tos.identity.suspend` / `.terminate` | `tos_identity` | identity id | `{ from, to, reason_length, sessions_revoked }` | **yes** |
| Access profile changed | `tos.access_profile.update` | `tos_access_profile` | profile id | `{ changed_keys, rbac_role_keys, admin_section_keys, app_system_keys }` | **yes** |
| **Provisioning applied** | `tos.provisioning.apply` **(new)** | `tos_provisioning_event` | event id | `{ identity_id, action, target_kind, target_key, state }` | **yes** |
| **Provisioning failed** | `tos.provisioning.fail` **(new)** | `tos_provisioning_event` | event id | `{ identity_id, target_kind, target_key, error_reason }` | no |
| Access requested | `tos.access_request.create` | `tos_access_request` | request id | `{ identity_id, target_kind, target_key }` | no |
| Access request decided | `tos.access_request.decide` | `tos_access_request` | request id | `{ state, approver_user_id, expires_at }` | **yes** |
| **Override recorded** | `tos.override.record` **(new)** | `tos_override` | override id | `{ entity, entity_id, from_state, to_state, approval_level, approver_user_id }` — **the reason text stays on the row, not in the diff** | **yes** |
| Person merged | `tos.person.merge` | `tos_person` | **winning** person id | `{ merged_person_id, emails_moved, links_moved, identities_moved }` | **yes** |
| Backfill run | `tos.backfill.run` | `tos_person` | `null` | `{ persons_created, links_created, identities_created }` — counts only | no |
| Retention prune | `tos.audit.prune` | `audit_log` | `null` | `{ table, older_than, rows_deleted }` — counts only, never the rows | **yes** |

### 20.4 What belongs in `diff`, and what MUST NOT

**MAY** appear in `diff`:

- the **keys** of fields that changed, and `from` / `to` values for **operational** fields — states,
  dates, booleans, counts, enum-like strings, and record identifiers;
- record identifiers (`selection_id`, `identity_id`, `application_id`, `role_id`, and
  `department_id` as **TEXT** — never `::uuid`);
- `tos_auth_code.code_last4`, which is already stored in the clear as a display fact and is the only
  way an administrator can tell two codes apart;
- lengths and counts standing in for free text (`reason_length`, `document_count`);
- the outcome vocabulary of a verification attempt, and the rung it stopped at.

**MUST NOT** appear in `diff`, ever:

| Never | Because |
|---|---|
| The authorization code, its normalised form, **or its `code_hash`** | The hash is a **verifier**. An audit reader holding it can confirm a guessed code offline. `tos_auth_code.code_hash` is a keyed HMAC precisely so the code is unrecoverable from the database; copying it into `audit_log` puts the verifier in a second, longer-lived, more widely read table. |
| A grant token or its hash, a challenge token or its hash, a session token, a recovery code, a TOTP secret, a password or password hash, a face descriptor | Same reason, and none of them are needed to explain what happened. |
| `pan_number`, `aadhaar_number`, `uan_number`, `esic_number`, `pf_number` | Statutory identifiers. `audit_log` is readable by anyone holding `audit.view` — a wider audience than the HR record itself — and its retention is far longer. |
| `bank_account_number`, `bank_ifsc`, `bank_holder`, `bank_name`, `bank_branch`, and the same fields on `hr_bank_account` (`account_number`, `ifsc`, `upi_id`) | Same. A masked last-four MAY be logged **only** on a payment-instrument change, never on a read. |
| `date_of_birth`, `blood_group`, or any health-adjacent value | §21.3. These are HR record fields; an audit diff is not where they belong, and an audit surface is not an oversight screen. |
| A document's contents, its `drive_url`, or any preview or thumbnail of it | **The link is the access control.** A link in an audit row hands the document to everyone who can read audit rows, for as long as the row is retained. |
| A candidate's free-text answers, evaluator comments, correction notes, appeal grounds, rejection or suspension reasons | They live on their own rows behind their own gates. The audit records **that** they changed, **who** changed them, and how long the text was. |
| A rendered notification subject or body | It may contain a code (§19.9). |
| An email address, in any diff | The `entityId` resolves to the person. An address in the diff makes `audit_log` a contact database with a seven-year retention. |

**REASON, stated once.** `logAudit` already refuses to forward `diff` to the error log for exactly
this reason, in a comment that names salary, PAN and health-adjacent fields. The same judgement
applies one level up: `diff` is the widest-travelling, longest-lived copy of whatever is put in it,
and nothing sensitive belongs in a store chosen for its durability.

### 20.5 Strict audit, and the ordering rule

`src/lib/legal-hold.ts` sets the pattern this project uses for security-significant access:
`logAccess()` **must succeed before anything renders**. Anything else is a page that shows somebody's
private messages and then discovers it could not record that it did.

**MUST**: the same ordering applies to **code redemption**, and to every row marked **Strict** in
§20.3.

```ts
// src/lib/talentos/redeem.ts — the ORDER is the security property, not an implementation detail.
//
// Note the signature: there is NO email parameter. Per §10.6 the redemption form has no email
// field, because an address the requester types is an address the requester chose. The bound person
// is proved by the session (path A) or by a challenge sent to tos_auth_code.delivered_to_email
// (path B), never by a claim in the request.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit, logAuditOrThrow } from '@/lib/audit';
import { normaliseAuthCode, isWellFormed } from '@/lib/talentos/codes';
import { hashAuthCode } from '@/lib/talentos/codes';
import { MSG_GENERIC, MSG_MALFORMED } from '@/lib/talentos/messages';

// Declared before the handler that uses them. `const` is not hoisted.
const BUSY = 'This could not be completed right now. Please try again shortly.';

export async function redeemCode(input: {
  code: string;
  ip: string;
  ua: string;
  sessionUserId: string | null;
  opportunityRoleId: string;
}) {
  const normalised = normaliseAuthCode(input.code);
  const codeHash = isWellFormed(normalised) ? hashAuthCode(normalised) : null;

  // 1. RATE LIMIT FIRST, read from tos_code_attempt (§10.4). Fails closed: if the counters cannot
  //    be read, the redemption is refused rather than allowed.
  const limited = await checkBuckets({ ip: input.ip, codeHash, personId: null });
  if (limited.blocked) {
    await recordAttempt({ codeHash, outcome: 'rate_limited', ip: input.ip, ua: input.ua });
    await logAudit({
      userId: input.sessionUserId, action: 'tos.auth_code.verify', entity: 'tos_auth_code',
      entityId: null, diff: { outcome: 'rate_limited', matched: false }, ipAddress: input.ip,
    });
    return { ok: false, message: MSG_GENERIC };   // identical to every other refusal (§10.3)
  }

  // 2. Run the ladder (§10.3 rungs 1 to 11). It reads; it changes nothing.
  const verdict = await runLadder({ normalised, codeHash, ...input });

  // 3. RECORD THE ATTEMPT. tos_code_attempt is the rate limiter's memory and the abuse board's only
  //    source, so its write failure refuses the request: a redemption that leaves no attempt row has
  //    silently bought the next attacker an extra guess.
  const attempt = await recordAttempt({
    codeHash, matchedCodeId: verdict.codeId, personId: verdict.personId,
    outcome: verdict.outcome, ip: input.ip, ua: input.ua,
  });
  if (!attempt.ok) return { ok: false, message: BUSY };

  // 4. A FAILED outcome is audited non-strictly and returns here. Refusing a second time on an audit
  //    hiccup adds nothing — the request is already being refused — and logAudit has already routed
  //    the failure to trackError and the /admin/ops board.
  if (verdict.outcome !== 'ok') {
    await logAudit({
      userId: input.sessionUserId, action: 'tos.auth_code.verify', entity: 'tos_auth_code',
      entityId: verdict.codeId, ipAddress: input.ip,
      diff: { outcome: verdict.outcome, matched: !!verdict.codeId, attempt_id: attempt.id, rung: verdict.rung },
    });
    return { ok: false, message: verdict.message };
  }

  // 5. THE SUCCESS PATH IS STRICT, and it is audited BEFORE the code is consumed and before any
  //    grant exists. An unlogged redemption is an unattributable onboarding: there is no later way
  //    to answer "who used this code, from where, and when".
  try {
    await logAuditOrThrow({
      userId: input.sessionUserId, action: 'tos.auth_code.verify', entity: 'tos_auth_code',
      entityId: verdict.codeId, ipAddress: input.ip,
      diff: { outcome: 'ok', matched: true, attempt_id: attempt.id, rung: 'ok' },
    });
  } catch (e: any) {
    // FAIL CLOSED. No consumption, no grant, no disclosure. The real reason is on e.cause; e.message
    // from postgres-js is only the failed SQL.
    console.error('[talentos] redemption refused, audit unavailable:', e?.cause?.message || e?.message);
    return { ok: false, message: BUSY };
  }

  // 6. ONLY NOW consume, in ONE conditional update that cannot double-spend.
  const r = await db.execute(sql`
    UPDATE tos_auth_code
       SET use_count   = use_count + 1,
           consumed_at = CASE WHEN use_count + 1 >= max_uses THEN NOW() ELSE consumed_at END
     WHERE id = ${verdict.codeId}::uuid
       AND revoked_at IS NULL
       AND expires_at > NOW()
       AND use_count  < max_uses
     RETURNING id, selection_id, person_id, opportunity_role_id`);
  const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);   // postgres-js returns plain arrays
  if (rows.length === 0) return { ok: false, message: MSG_GENERIC };   // lost the race; still generic

  // 7. Mint the grant, then audit it strictly and undo on failure (§11.2).
  //    ... INSERT tos_onboarding_grant, then logAuditOrThrow('tos.grant.issue', …)
}
```

**MUST NOT** reorder these steps. Minting the grant first and auditing afterwards reproduces exactly
the failure this project has already had: the work happened, the record did not, and nothing on any
surface said so.

**MUST**: a caller of `logAuditOrThrow` catches the throw and **undoes** what it was auditing, as
`registry.ts` already does around `recordStrict`. Where the work cannot be undone, it **MUST NOT**
have been started before the audit row landed. That is the whole content of the ordering rule.

**The same ordering, in three other places:**

| Operation | Audit that must land first | What is refused if it does not |
|---|---|---|
| Revealing a Class C field (§21.3) | `tos.onboarding.reveal` | The value is not returned. The screen shows the masked form and a plain message. |
| Applying a provisioning event (§14.3) | `tos.provisioning.apply` | The RBAC write does not happen; the event stays `pending`. |
| Creating an identity (§13.3) | `tos.identity.create` | `completeHire()` is not called; nothing is minted. |

### 20.6 Retention

| Store | Retention | Rule |
|---|---|---|
| `audit_log` rows with a `tos.*` action | **7 years** from `created_at` | These record who decided a person's selection, who authorised their access, and who revoked it. The limitation period for an employment dispute is the floor, not the target. |
| `tos_code_attempt` | **180 days** | It holds `ip_address` and `user_agent`, whose security value decays quickly and whose privacy cost does not. The `tos.auth_code.verify` audit row survives, so the decision record outlives the network metadata. |
| `tos_code_challenge` | **90 days** | Consumed or expired rows are evidence of a redemption path, not of a decision. |
| `tos_notification_log` | **24 months** | Long enough to answer "was I told", short enough not to accumulate a recipient graph. |
| `tos_override` | **Never pruned** | An override records a rule being set aside by a named person. It has no expiry. |
| `tos_provisioning_event` | **7 years** | Deprovisioning is derived by replaying grants (§21.1 R-10); pruning them destroys the ability to revoke. |

**MUST NOT** delete an `audit_log` row whose `entity_id` is in scope of an open matter in
`legal_matters` (`src/lib/legal-hold.ts`). The pruning job checks first, and refuses the whole batch
rather than pruning around the hold.

The pruning job is itself audited (`tos.audit.prune`) with **counts only**, and is **Strict**: a
prune that cannot be recorded does not run. **MUST NOT** copy the deleted rows anywhere — an archive
of pruned audit rows is the retained data the retention policy said it had deleted.

### 20.7 Who may read the audit surface

| Surface | Gate | Shows |
|---|---|---|
| `/admin/audit` | `can(user, 'audit.view')` from `src/lib/auth/permissions.ts`, plus the `audit` admin-section gate that `src/middleware.ts` already applies by path. Unchanged. | All of `audit_log`, filtered by action, entity, user, days. |
| `/api/admin/**` audit endpoints | `denyAdminApi(locals, { section: 'audit', action: 'view', permission: 'audit.view', label: 'audit.read' })` **on the first line of the handler**, before the body is read and before any SELECT. | Same data, same answer as the page. |
| Talent-scoped view | The **same page**, filtered to `entity LIKE 'tos\_%'`. **No new surface and no second gate.** A separate talent audit screen would be a second permission to keep in step with the first. | — |
| A candidate's own history | `/portal/applications`, `/portal/appeals` and the onboarding form, rendered from `tos_stage_run`, `tos_selection`, `tos_onboarding` and `tos_correction_request` — **not** from `audit_log`. | Their own facts, their own reasons, their own deadlines. |

**REASON for not exposing `audit_log` to its subject directly**: an audit row names the acting
administrator, the internal action vocabulary and the diff. The person is entitled to the **decision
and its written reason**, which the domain tables carry and which §19 already delivers. Those are two
different disclosures and only one of them is theirs.

**MUST NOT**: no admin surface offers an edit or a delete control on `audit_log`. It is append-only
in practice and **MUST** be treated as append-only by policy. The only writer is `logAudit`. The only
deleter is the retention job in §20.6.

**MUST NOT** offer a free-text search across `audit_log.diff`. The facets are `action`, `entity`,
`entity_id`, `user_id` and a date range — the four indexes `ensureAuditIndexes()` guarantees. A
substring search over diffs is how a store that carefully excludes sensitive values still becomes a
tool for finding people.

### 20.8 A failed audit write on a security-significant action MUST surface

- `logAudit` returns `{ ok: false, error }` **and** forwards to `trackError('audit.write_failed', …)`,
  which lands on the `/admin/ops` incident board. **MUST NOT** reintroduce a bare `console.error`
  there: stdout is not a surface, and a failing audit subsystem was the one class of fault that board
  could not see.
- **MUST**: every **Strict** row in §20.3 uses `logAuditOrThrow` and fails its operation **closed**.
- **MUST NOT** wrap a strict audit in `catch {}` or in a catch that only sets a message. This project
  has already lost hours of sign-in availability to a bare `catch { errorMsg = 'Login error' }` that
  hid a total outage.
- **MUST** log the cause: `e?.cause?.message || e?.message`. From postgres-js, `e.message` is the
  failed SQL and tells an operator nothing.
- **MUST**: a non-strict `logAudit` returning `{ ok: false }` on a talent write is still counted. The
  `/admin/ops` board groups `audit.write_failed` by fingerprint; a rising count there is the signal
  that the audit trail is degrading while every screen still reads healthy.

---

## 21. Security requirements [brief §28, §29]

### 21.1 Requirements, each with its enforcement point

| Id | Requirement | Enforced at |
|---|---|---|
| R-01 | Authentication | `src/lib/auth/session.ts`, `password.ts`, `webauthn.ts`, `face.ts`, `two-factor.ts` |
| R-02 | Authorization, server-side, on every request | `src/lib/rbac/guard.ts`, `src/lib/auth/permissions.ts`, `src/lib/auth/api-guard.ts`, `src/middleware.ts` |
| R-03 | Second step for privileged accounts | `src/lib/auth/two-factor.ts` |
| R-04 | Session security | `src/lib/auth/session.ts`, `src/lib/auth/cookie.ts` |
| R-05 | Rate limiting | `tos_code_attempt` (§10.4), the attempt buckets in `two-factor.ts` |
| R-06 | CAPTCHA placement | Unauthenticated public write endpoints only |
| R-07 | The authorization code, end to end | `src/lib/talentos/codes.ts`, `tos_auth_code`, `tos_onboarding_grant` |
| R-08 | Encryption in transit and at rest | `src/lib/http-guard.ts`, the hosting edge, the managed database |
| R-09 | Document storage | `src/lib/hr-onboarding.ts`, `hr_onboarding_documents` |
| R-10 | Expiration, suspension, revocation | `tos_identity`, `tos_provisioning_event`, `sessions` |
| R-11 | Audit logging | §20 |
| R-12 | Abuse detection, advisory only | `tos_code_attempt`, `tos_stage_run.advisory_flags` |

---

**R-01 Authentication.** This project has **multi-method authentication**: any **one** of password,
passkey, face or authenticator code signs a person in. They are **alternative first factors, not
stacked factors**, and a surface that demands two of them by default has misread the model.

- WebAuthn here is **self-built** — `src/lib/auth/webauthn.ts` (`rpFromRequest`,
  `registrationOptions`, `verifyRegistration`, `authenticationOptions`, `verifyAuthentication`).
  **MUST NOT** add an external WebAuthn library or a hosted identity provider for any talent surface.
  This is a standing architectural rule on this project, not a preference.
- **MUST NOT** build a sign-in screen for any talent surface. Every authenticated page consumes
  `Astro.locals.user` and the existing session. A new login form is a new attack surface with none of
  the existing throttling, none of the second-step logic, and none of the recovery-code guard.
- Exactly **one** unauthenticated write path is introduced by this specification: the authorization
  code entry form. It authenticates **the bearer of a high-entropy secret**, not a session, and
  everything in R-05, R-06 and R-07 exists because of that.
- **The code form is not a second authentication method.** Possession of the code is never sufficient
  (§10.6): the redeemer is additionally proved to be the bound person, either by an authenticated
  session or by a single-use challenge sent to `tos_auth_code.delivered_to_email`. The form has **no
  email field**, because an address the requester types is an address the requester chose.
- Email verification is a **precondition**, not an authentication method: §5.3 requires a verified
  `tos_person_email` before any selection, redemption or onboarding step proceeds.
- **MUST NOT** derive any authorization from an email domain (§5.7). `email.endsWith('@edurankai.in')`
  guarding anything is a defect wherever it appears, and conformance test T-07 asserts it.

**R-02 Authorization.** Server-side, on **every** request, **before** any query.

| Kind of decision | Call |
|---|---|
| Capability on a resource | `await requireCapability(user, cap, res, ctx)` — `src/lib/rbac/guard.ts`. Throws `ForbiddenError` and writes exactly one audit row. |
| Admin section page | The `PATH_SECTION` gate in `src/middleware.ts`, plus `canAccessSection(user, '<section>', 'view' \| 'edit')` on the page itself. |
| Named non-section ability | `can(user, '<permission>')` — `src/lib/auth/permissions.ts`. |
| `/api/admin/**` endpoint | `const denied = await denyAdminApi(locals, { section, action, permission?, label }); if (denied) return denied;` — `src/lib/auth/api-guard.ts`, **on the first line of the handler**. |

- **REASON `denyAdminApi` is not optional**: `isExempt()` in `src/middleware.ts` hard-returns true for
  anything starting `/api/`, so an admin API route is **structurally an unguarded URL**. Twenty of
  them once checked `user.role !== 'applicant'`, which every internal role passes — including the
  `editor` role a promotion once handed to every intern.
- **MUST NOT** gate on `user.role !== 'applicant'`, on any role string comparison, or on the mere
  presence of a session.
- **MUST** authorize **before** fetching. `docs/workforce-os/AUTHORIZATION_FIRST.md` prohibits
  filtering after fetching: a query that ran for an unauthorised principal has already happened,
  whatever the response body says.
- **MUST** fail closed. `canOpenAdmin()` denies when the employee lookup throws and `canAccessSection`
  returns false on a query error, so a database hiccup refuses rather than admits. Anything new here
  inherits that direction.
- **Hiding a button is not authorization.** Every rendered surface re-checks on the POST (§21.2).
- Per-record authority is separate from section authority. Deciding a stage additionally requires the
  actor to be in `tos_opportunity.evaluator_user_ids`, or to resolve as hiring manager or department
  head for that opportunity through `src/lib/org-graph.ts` (§8.5). A section key is permission to
  reach the screen, not permission to act on every row on it.

**R-03 Second step for privileged accounts.** The second step (`isSecondStepRequired(userId)`,
`availableSecondFactors(userId)` returning `'totp' | 'face'`, `canCompleteSecondStep`,
`startPendingChallenge`, `recordChallengeAttempt`, `consumePendingChallenge`) is an **additional**
gate after the first factor and is distinct from the multi-method choice in R-01. Do not conflate
them: R-01 is which door you came through; R-03 is a second door in front of a small number of rooms.

An account is **privileged**, and **MUST** have the second step enabled, if it holds any of:

- `audit.view`;
- edit on the `users`, `team_roles` or `settings` admin sections;
- edit on `talent_codes`, `talent_selection`, `talent_onboarding`, `talent_identity` or
  `talent_access`;
- the ability to set `tos_selection.is_authorised`, to issue or revoke an authorization code, to
  approve an onboarding, or to apply a provisioning event;
- any founder-console access.

**Enforcement point, concretely**: the code-issue, selection-authorise, onboarding-approve,
identity-create and provisioning-apply handlers **MUST** refuse when `isSecondStepRequired(actorId)`
returns false, with a plain message linking to enrolment. Refusing to let an unenrolled account
authorise a selection is the enforcement; a policy page saying it should be enrolled is not.

`MAX_CHALLENGE_ATTEMPTS = 5` and `PENDING_TTL_SECONDS = 300` already bound the challenge, and
`hasRecoveryCodesLeft(userId)` guards against lockout. **MUST NOT** add a new challenge mechanism for
talent surfaces; reuse this one.

**R-04 Session security.** Existing behaviour, which this spec inherits and **MUST NOT** weaken:

- The session token is `randomBytes(20)`, and **the database stores only its sha256** (`hashToken`,
  module-private in `session.ts`). A database read cannot forge a session.
- 30-day life with sliding renewal inside the last 15 days (`RENEW_THRESHOLD_MS`).
- `validateSessionToken` deletes the session when `users.is_active` goes false.
- Cookies are `httpOnly: true`, `sameSite: 'lax'`, and `secure` in production
  (`src/lib/auth/cookie.ts`).

Added by this spec:

- **MUST**: suspending or terminating a `tos_identity` deletes every `sessions` row for that
  identity's `user_id`, **in the same operation** as the status change, recording `sessions_revoked`
  in the audit diff (§20.3). **REASON**: `users.is_active` alone takes effect on the next
  `validateSessionToken` call, which is correct but invisible and unbounded in time; and an identity
  may be suspended while the `users` row stays active for another identity of the same person, in
  which case `is_active` is the wrong lever entirely.
- **MUST NOT** keep onboarding authority in a cookie **value**. The cookie carries an opaque token
  whose sha256 is `tos_onboarding_grant.grant_token_hash`; the **authority is the row**, which has an
  expiry, a consumption marker and a revocation column (§11.1). A signed cookie carrying
  `{selectionId, isAuthorised}` would be authority the server cannot withdraw.
- The grant cookie is `httpOnly`, `sameSite: 'lax'`, `secure` in production, path-scoped to the
  onboarding route, and **MUST** be cleared on consumption and on sign-out.

**R-05 Rate limiting.** The authoritative numbers are §10.4's. They are restated here as the
enforcement contract, unchanged:

| Bucket | Limit | Window | On exceeding |
|---|---|---|---|
| per IP | **10 failed attempts** | 60 minutes | refuse for the rest of the window, outcome `rate_limited` |
| per IP | **40 failed attempts** | 24 hours | refuse for the rest of the window |
| per `code_hash` | **5 failed attempts** | 60 minutes | that hash is locked for 60 minutes |
| per authenticated person | **15 failed attempts** | 24 hours | refuse. **MUST NOT** affect that person's sign-in. |
| global | **200 failed attempts** | 60 minutes | raise a sweep alert on the abuse board (`tos.admin.code_abuse`) |

Alongside, and already in the tree for the sign-in path:

| Bucket | Limit | Window | Constant |
|---|---|---|---|
| Password attempts per identifier | 20 | 900 s | `PASSWORD_MAX_PER_IDENTIFIER` |
| Password attempts per IP | 60 | 900 s | `PASSWORD_MAX_PER_IP` |
| Second-step challenge attempts | 5 | per challenge | `MAX_CHALLENGE_ATTEMPTS` |
| Challenge sends per code | 3 | 24 hours | §10.6 path B |

- **MUST** count **failures only**. A success clears the IP and code buckets, so somebody who fumbles
  their code four times and then gets it right is not still throttled an hour later.
- **MUST** read the counters from `tos_code_attempt`, not from process memory. On a serverless
  deployment an in-memory counter resets on almost every invocation, which is indistinguishable from
  having no limit while looking as though it has one.
- **MUST** apply the limit **before** the code is looked up (§20.5 step 1), so a refused request never
  touches `tos_auth_code` at all.
- **Fails closed.** If the counts cannot be read, the redemption is refused. Redemption is a
  once-in-a-relationship path: refusing for the minutes a database hiccup lasts costs a support
  message, while the other direction costs an unlimited guessing window against a bearer credential.
- **The per-code lock cannot be weaponised.** The bucket key is the hash of the **submitted** code, so
  only a requester who already possesses that exact code can fill its bucket. Locking never touches
  `tos_auth_code`: a locked code is not revoked, not expired and not consumed, so an attacker cannot
  destroy a legitimate person's credential by guessing at it.
- The refusal **MUST NOT** say which limit was hit, **MUST NOT** state the attempts remaining, and
  **MUST NOT** let a rate-limited IP be told apart from a rate-limited code. It returns `MSG_GENERIC`
  with the same status, the same page and the same 400 ms floor as every other refusal (§10.3).
- **A rate limit is scoped to redemption and to nothing else.** It **MUST NOT** block sign-in, the
  portal, an application, an appeal, or a second opportunity.
- SHOULD additionally cap onboarding submission at 5 per hour per person, correction requests at 10
  per onboarding, and document link submissions at `MAX_DOCS` (5) per person as the existing module
  already does — each refused with a plain message rather than silently dropped.

**R-06 CAPTCHA placement, and why it is not on the code-entry form.**

Position: **no CAPTCHA on the authorization code entry form.** That is a decision, not a hedge, and
here is the defence.

1. **It does not address the threat.** The secret is 12 Crockford base32 characters from a CSPRNG —
   **60 bits**, `2^60` possibilities (§10.1). With 200 live codes and a 10,000-guesses-per-hour
   botnet, the expected time to a first hit is on the order of `2^60 / 200` guesses. The rate limit
   in R-05 caps a single address at 10 failures an hour. A CAPTCHA in front of that changes nothing
   an attacker cares about, because the attacker is not blocked by *effort*, they are blocked by
   *arithmetic*.
2. **It carries a real cost on the highest-stakes form in the product.** This is the screen a newly
   selected person reaches, often on a phone, often on a poor connection, sometimes with assistive
   technology. A CAPTCHA failure there does not degrade gracefully: the fallback is the candidate
   mailing the people desk and a human doing the verification by correspondence, which is a **worse**
   security outcome than the form they were blocked from.
3. **A third-party CAPTCHA is an outbound data flow and an external dependency**, against the standing
   rule that core capabilities are first-party and self-hostable, and against R-01's prohibition on
   hosted identity components.

Where CAPTCHA-shaped friction **does** belong: unauthenticated public write endpoints with **no
shared secret and no per-record budget** — the application form, the fee-waiver request, and the
moderated "Other" suggestion that writes into `application_sources`. There it **MUST** be a
first-party challenge (a honeypot field, a minimum time-on-form, a per-IP submission budget counted
from a table), never an embedded third-party widget.

**The rule, generalised**: where a request presents a high-entropy secret **and** the failure budget
is enforced server-side from a persisted table, CAPTCHA is redundant. Where it presents nothing and
anyone may post, friction is required.

**R-07 The authorization code, end to end.**

| Phase | Requirement |
|---|---|
| Format | `ERAI-SEL-ONB-<YY>-<OPP>-<G1>-<G2>-<G3>`. The secret is `<G1><G2><G3>`: **12 Crockford base32 characters, 60 bits**. The prefix is public and composable — `ERAI-SEL-ONB` is fixed, `YY` is the year, `OPP` is `tos_opportunity.opportunity_code`, which appears on a careers page. **MUST NOT** count the prefix as entropy. |
| Generation | `randomBytes` from `node:crypto`, masked `b & 31` against a 32-symbol alphabet, which is bias-free because 256 is an exact multiple of 32. **MUST NOT** use `Math.random()`, a timestamp, a counter, or anything derived from `selection_ref` or `person_code`. |
| Alphabet | Crockford base32: `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — no `I`, `L`, `O`, `U`. **REASON**: a code is read down a telephone and typed back. |
| Normalisation | One function, `normaliseAuthCode`, used at generation and at every validation, with no second implementation in the tree. Uppercase, strip non-alphanumerics, fold `I`/`L` to `1`, `O` to `0`, `U` to `V`. None of the four folded characters is in the alphabet, so no fold can collide with a character a real code contains. |
| Storage | `tos_auth_code.code_hash` is a **keyed** hash — `HMAC-SHA256(TOS_CODE_PEPPER, normalised)`, hex, `NOT NULL UNIQUE`. It **fails closed** when the pepper is unset or shorter than 32 bytes. **REASON**: 60 bits defeats an online attack, but a leaked hash column is an offline problem; a server-side key that never enters the database removes that path. Rotating the pepper invalidates every live code and is therefore a deliberate revoke-and-reissue operation, never a routine secret roll. |
| Plaintext lifetime | Returned exactly once, to the issuing administrator, in a copy-once panel that says it will not be shown again; and sent once by email. Persisted in **neither**. `code_display_prefix` and `code_last4` are the only clear-text fragments and exist solely so an administrator can identify a code. |
| Transport | Email over the platform's own SMTP, in the body. **MUST NOT** appear in a URL, a query string, a path segment, a redirect, or a QR code. URLs land in server logs, referrer headers, browser history and shared screenshots. |
| Entry | POST only, `autocomplete="off"`, `cache-control: no-store` via `secureJson` / `secureHeaders` from `src/lib/http-guard.ts`. **MUST NOT** accept the code as a GET parameter, ever. **MUST NOT** put an email field on the form (§10.6). |
| Lookup | Normalise the **whole** string, hash the **whole** string, look up by hash against the unique index. **MUST NOT** parse the code into parts before lookup — splitting off `<OPP>` to resolve the opportunity first would reveal which opportunity codes exist through a differently-timed refusal. **MUST NOT** exist any endpoint, admin query or support tool that searches codes by prefix or lists code hashes. |
| Proof of person | Path A, an authenticated session whose `tos_person` is `tos_auth_code.person_id`; or path B, a single-use 32-byte challenge sent **only** to `tos_auth_code.delivered_to_email`, 15-minute TTL, at most 5 verification attempts and 3 sends per code per 24 hours. Following it re-runs the whole ladder. **MUST NOT** accept as proof: possession of the code alone, a matching name, a matching phone number, an `@edurankai.in` sender domain, a referrer header, or a value echoed back from a hidden field. |
| Disclosure order | Rate limit, then well-formedness, then lookup, then the status rungs, then the person proof (§10.3). For any requester not proven to be the bound person, rungs 2 to 11 **and success** are byte-for-byte identical: same message, same HTTP status, same page, same headers, no `Set-Cookie` difference, and a fixed 400 ms floor. Only the malformed rung differs, because well-formedness is computable offline from the published format. |
| Consumption | One conditional `UPDATE … WHERE revoked_at IS NULL AND expires_at > NOW() AND use_count < max_uses RETURNING …` (§20.5). Two concurrent redemptions cannot both win. **MUST NOT** implement check-then-update as two statements. **MUST NOT** consume on any failed rung: that would let anyone who intercepts a code burn it, turning a read-only attack into denial of service against the one person who needs it. |
| After consumption | Mint `tos_onboarding_grant`: two-hour expiry, single use, hash stored, opaque token in an httpOnly cookie (§11). |
| Revocation | `revoked_at`, `revoked_by_user_id`, `revoked_reason`, and `superseded_by_id` on re-issue. Re-issue revokes the previous code and every live grant for that selection in the same transaction, so a selection is never sitting on two working codes. **MUST NOT** mutate `code_hash` in place. |
| Logging | **MUST NOT** write the code, its normalised form or its hash to `console`, `trackError`, `audit_log.diff`, `tos_notification_log`, `tos_code_attempt` (which stores only the hash for bucketing, never the input), an analytics event, or any message returned to a client. |
| Support | An administrator asked "what is my code" **cannot** answer, and the admin surface says so in those words. The only remedy is re-issue, which is audited (`tos.auth_code.reissue`) and notifies the candidate (`tos.code.reissued`). |

**R-08 Encryption in transit and at rest — what this deployment actually provides.** Stated
honestly, because a specification that overstates this is how a policy page ends up making a claim
the infrastructure does not support.

- **In transit, browser to platform**: HTTPS terminated at the hosting edge. `secureHeaders()` in
  `src/lib/http-guard.ts` sets `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin` and a CSP that
  currently ships **report-only**, because a large number of pages use `define:vars`, which Astro can
  only emit as an inline script. **Talent surfaces MUST NOT add new inline scripts**, so they do not
  extend that blocker; and `define:vars` cannot be combined with `is:inline`.
- **In transit, platform to database**: TLS to the managed transaction pooler. The connection string
  is read from the environment and never hardcoded.
- **In transit, outbound mail**: the platform's own SMTP with TLS. There is no third-party mail API.
- **At rest**: the managed Postgres instance provides volume-level encryption. State plainly what
  that does and does not do: it protects a physically removed disk. It does **not** protect against a
  leaked connection string, an over-broad `SELECT`, a stolen session, an unguarded API route, or an
  administrator with more access than they need.
- **There is no column-level encryption in this deployment.** `pan_number`, `aadhaar_number`,
  `bank_account_number` and the rest are plaintext columns in `hr_employees` and `hr_bank_account`,
  protected by access control, masking and audit (§21.3) — **not** by ciphertext. **MUST NOT** write
  copy, a policy page, a partner answer or a specification claiming otherwise. If a jurisdiction or a
  partner requires field-level encryption, that is a schema change plus a key-management decision,
  not a configuration flag, and it is out of scope here.
- The one place this spec **does** add cryptography is where a secret is stored: `code_hash`
  (HMAC-SHA256 with a pepper), `grant_token_hash` and `challenge_hash` (sha256), and the existing
  session `hashToken`. Those are verifier hashes, not encryption, and nothing in the system can
  recover the original from them.
- Secrets are read from the environment. **MUST NOT** commit one, and **MUST NOT** read any `.env*`
  file from application code beyond `process.env`.

**R-09 Document storage — links, not binaries, so the boundary is the link's access setting.**

- Documents of any kind are submitted as **links**, verified server-side by `addDoc()` in
  `src/lib/hr-onboarding.ts`. `isDriveLink()` requires an `https://` document-sharing host from the
  allowed set and a maximum length of 500 characters; `linkProblem()` returns a reason the person can
  act on; `MAX_DOCS` is 5; `ACCESS_FORMAT` is `'Anyone with the link - Viewer'`.
- **The security boundary is the link's access setting**, and it lives on the candidate's own storage
  account. The platform cannot enforce it and **MUST NOT** claim to. What the platform does is
  (a) require the format, (b) tell the candidate plainly, in the onboarding form and in
  `tos.onboarding.document_returned`, that anyone holding the link can view the file and that they
  must not share a document they are unwilling to expose that way, and (c) record a **human**
  reviewer's verification that the link opened and showed what it claimed
  (`hr_onboarding_documents.status`, `tos.document.review`).
- **MUST NOT** add an upload path for documents, for any document type, for any reason. The **only**
  stored binary in this system is the small identity photo — a 320px JPEG, captured live or uploaded
  on the identity screen.
- A document link **MUST NOT** appear on a public page, in a notification body, in an audit diff, in
  an error message, in `tos_notification_log`, or in any export.
- A rejected or superseded document is **hidden, not deleted**. Revoking the link is the candidate's
  own action on their own account; the record that a submission was made has to survive.
- The reviewer surface is gated by the `hr` / `employees` / `talent_onboarding` sections. **An
  evaluator on a recruitment stage has no access to onboarding documents at all** — different stage,
  different authority, different data (§21.3 rule 5).
- The candidate-facing copy describing a link **MUST NOT** name a storage provider (§19.4 rule 6).
  The existing `addDoc()` refusal message does name one; rewording it is a copy fix owed on this
  work, recorded here rather than left implicit.

**R-10 Expiration, suspension and revocation.**

- `tos_identity.status` is the authority: `pending | active | suspended | expired | terminated`. Only
  `active` grants anything. The partial unique index
  `tos_identity_one_primary ON tos_identity (person_id) WHERE is_primary AND status = 'active'` means
  suspension frees the primary slot automatically. **MUST NOT** work around it by clearing
  `is_primary` instead of setting the status: that leaves an active identity nobody can find.
- `tos_identity.ended_on` drives a daily sweep that moves an identity to `expired`, emitting
  `tos.identity.expiring` 14 days beforehand and `tos.identity.ended` on the day.
- **Revocation is a replay, not a guess.** Every grant is a `tos_provisioning_event` row
  (`action = 'grant'`, `target_kind`, `target_key`, `state = 'applied'`). Deprovisioning selects the
  applied grants for the identity and writes the negating `revoke` events through the same modules.
  **A grant applied by direct SQL against `rbac_*` has no event and therefore cannot be revoked** —
  which is exactly why provisioning writes through `src/lib/rbac/*` and `src/lib/auth/registry.ts`
  and never with raw SQL (§14).
- Deprovisioning **MUST** be idempotent: running it twice has no additional effect and produces no
  duplicate `revoke` events for targets already revoked.
- Suspension **MUST** also delete the person's `sessions` rows (R-04) and disable the official mailbox
  through the `mail` provisioner registered in `tos_app_system`. An identity that cannot sign in but
  still receives mail is suspended on paper only.
- `tos_access_request.expires_at` is enforced by the same sweep; an expired approval writes a `revoke`
  event like any other. **MUST NOT** implement a grant with no expiry path.
- **MUST NOT** delete a `tos_identity` row, ever. `terminated` is a status, and history has to
  resolve — §5.5's merge-never-delete rule applies to identities as much as to persons.

**R-11 Audit logging.** §20 in full, and in particular §20.5's ordering rule and §20.8's
failure-visibility invariant. The one-line version: **an action that cannot be recorded does not
happen.**

**R-12 Abuse detection — advisory only.**

| Signal | Source |
|---|---|
| Repeated failed code attempts from one address, or against one code | `tos_code_attempt` |
| A valid code redeemed by a signed-in person it is not bound to | `tos_code_attempt.outcome = 'person_mismatch'` |
| A recipient who says they did not enter their code | the §10.6 path B "this was not me" link |
| Proctoring and integrity flags on an assessment | `tos_stage_run.advisory_flags` |
| A cluster of provisioning failures | `tos_provisioning_event.state = 'failed'` |
| An actor with an unusual rate of overrides | `tos_override` grouped by `actor_user_id` |
| A cluster of undelivered notifications to one recipient domain | `tos_notification_log` |

**MUST**: detection is **advisory**. **No code path may set a stage outcome, a selection decision, an
identity status, an onboarding state, or an access grant from a detector.** The only automated
responses permitted are:

1. the rate-limit refusal in R-05, which is time-bounded, self-clearing, and touches no domain row; and
2. raising a notification to a named human audience.

A human decides, and any state change made after a detector fires **MUST** carry a `tos_override` row
naming that human and their written reason (§4.8).

**REASON**: an automated integrity flag on an assessment is a probabilistic signal about a camera
feed, a keystroke pattern or a network hiccup. A false positive that auto-rejects a candidate is an
unrecoverable harm inflicted by a system that was never asked to be right — and the person it lands
on has no way to see the evidence, let alone contest it. The flag belongs in front of a reviewer,
with the submission, and nowhere else.

### 21.2 DO NOT TRUST FRONTEND STATE [brief §29]

**The anti-pattern.** Every value below arrived in the request body, and every one of them is a
decision the client was allowed to make about itself:

```ts
// src/pages/api/onboarding/start.ts  — FORBIDDEN. Do not write this, in any variation.
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json();
  if (!body.isSelected) return new Response('not selected', { status: 403 });   // the client said so
  await db.execute(sql`
    INSERT INTO tos_onboarding (onboarding_ref, selection_id, person_id, opportunity_role_id, locked_fields)
    VALUES (${body.ref}, ${body.selectionId}::uuid, ${body.personId}::uuid, ${body.roleId}::uuid,
            ${JSON.stringify(body.lockedFields)}::jsonb)`);   // the client chose its own title and stipend
  return new Response('ok');
};
```

Three separate failures, each sufficient on its own: an authority flag read from the body; record
identifiers read from the body, so any authenticated caller can address any other person's records;
and the organisation-controlled snapshot read from the body, so the candidate writes their own
designation and their own stipend.

**The correct pattern.** Nothing is believed; everything is re-derived from a server-side row, and
the row **is** the grant:

```ts
// src/pages/api/onboarding/start.ts
import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { secureJson } from '@/lib/http-guard';
import { logAuditOrThrow } from '@/lib/audit';
import { nextOnboardingRef } from '@/lib/talentos/codes';

// Declared BEFORE the handler. `const` is not hoisted, and a handler reaching a later declaration
// has taken pages down on this project twice.
const GENERIC = 'This onboarding link is not open. Enter your authorization code again.';
const BUSY = 'This could not be completed right now. Please try again shortly.';
const hashToken = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

export const POST: APIRoute = async ({ cookies, clientAddress }) => {
  const raw = cookies.get('era_onb')?.value || '';
  if (!raw) return secureJson({ ok: false, error: GENERIC }, 403);

  // ONE query establishes person, selection, opportunity AND authority. The body is never consulted;
  // this handler does not even read it.
  const r = await db.execute(sql`
    SELECT g.id            AS grant_id,
           g.selection_id, g.person_id, g.opportunity_role_id,
           s.is_authorised, s.suspended_at,
           s.offered_title, s.offered_department_id, s.offered_position_id, s.employment_type,
           s.reporting_manager_user_id, s.proposed_start_date,
           s.stipend_amount, s.stipend_currency
      FROM tos_onboarding_grant g
      JOIN tos_selection s ON s.id = g.selection_id
     WHERE g.grant_token_hash = ${hashToken(raw)}
       AND g.consumed_at IS NULL
       AND g.revoked_at  IS NULL
       AND g.expires_at  > NOW()
     LIMIT 1`);
  const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);   // postgres-js returns plain arrays
  const grant = rows[0];
  if (!grant || grant.is_authorised !== true || grant.suspended_at) {
    return secureJson({ ok: false, error: GENERIC }, 403);
  }

  // locked_fields is built from the SELECTION, not from the request. offered_department_id stays
  // TEXT and is never cast to ::uuid — departments.id is a varchar slug in one schema and a UUID in
  // the other, and a ::uuid cast throws the first time a slug arrives.
  const locked = {
    offered_title: grant.offered_title,
    offered_department_id: grant.offered_department_id,
    offered_position_id: grant.offered_position_id,
    employment_type: grant.employment_type,
    reporting_manager_user_id: grant.reporting_manager_user_id,
    proposed_start_date: grant.proposed_start_date,
    stipend_amount: grant.stipend_amount,          // NULL means unpaid, and the copy says so (§19.6)
    stipend_currency: grant.stipend_currency,
  };

  try {
    await db.execute(sql`
      INSERT INTO tos_onboarding (onboarding_ref, selection_id, person_id, opportunity_role_id, locked_fields)
      VALUES (${await nextOnboardingRef()}, ${grant.selection_id}::uuid, ${grant.person_id}::uuid,
              ${grant.opportunity_role_id}::uuid, ${JSON.stringify(locked)}::jsonb)
      ON CONFLICT (selection_id) DO NOTHING`);
    await db.execute(sql`
      UPDATE tos_onboarding_grant SET consumed_at = NOW()
       WHERE id = ${grant.grant_id}::uuid AND consumed_at IS NULL`);
    await logAuditOrThrow({
      userId: null, action: 'tos.grant.consume', entity: 'tos_onboarding_grant',
      entityId: String(grant.grant_id), diff: { selection_id: grant.selection_id },
      ipAddress: clientAddress,
    });
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[talentos] onboarding start failed:', e?.cause?.message || e?.message);
    return secureJson({ ok: false, error: BUSY }, 500);
  }
  return secureJson({ ok: true });
};
```

**Fields a request body may carry, and what the server MUST re-derive them from.** A body value
listed here is at most a hint for a form control. It is never the value written, and never the value
a decision is made on.

| Field the body may carry | The server MUST re-derive it from |
|---|---|
| `personId` | `tos_onboarding_grant.person_id`, or `tos_person` resolved from `Astro.locals.user.id` |
| `userId`, `actorUserId` | `Astro.locals.user.id`. Never from the body, in any handler, ever. |
| `selectionId` | `tos_onboarding_grant.selection_id` |
| `opportunityRoleId`, `roleId` | `tos_selection.opportunity_role_id` / `tos_application_link.opportunity_role_id` |
| `applicationId` | `tos_application_link` for the resolved person and opportunity |
| `isSelected`, `isAuthorised`, `canOnboard`, `isAdmin`, `role` | `tos_selection.is_authorised` **and** `suspended_at IS NULL`; for admin authority, `denyAdminApi` / `canAccessSection`. There is no client-side equivalent of any of these facts. |
| `stageState`, `passed`, `outcome`, `verdict` | `tos_evaluation` rows for the run, applied through `tos_pipeline_stage.pass_rule` |
| `score` | `tos_evaluation.score`. A client-supplied score is a self-awarded one. |
| `slotNo`, `pipelineStageId`, `pipelineId` | `tos_stage_run` for the application, and `tos_opportunity.pipeline_id`. A posted slot number selects nothing. |
| `dueAt`, `submittedAt`, `decidedAt`, `issuedAt`, any timestamp | `NOW()` on the server, or the stored column. **Never a client clock.** |
| `offeredTitle`, `department`, `departmentId`, `positionId`, `teamId`, `employmentType`, `startDate`, `reportingManager` | `tos_selection` — the locked snapshot. A change comes only through `tos_correction_request` (§12.4). |
| `stipendAmount`, `stipendCurrency` | `tos_selection.stipend_amount` / `stipend_currency`. A candidate-supplied stipend is not a fact about their engagement. |
| `identityType` | `tos_opportunity` policy plus `tos_selection`. Never a posted string. |
| `identityCode`, `employeeCode`, `personCode`, `selectionRef`, `onboardingRef` | Minted server-side by the MAX-plus-retry helper (§5.1). A posted reference is an attempt to address another person's record. |
| `accessProfileId`, `rbacRoles`, `adminSections`, `appSystems`, `capabilities` | `tos_access_profile` resolved from the identity (§14.1). **A posted permission list is a privilege-escalation request wearing a form field.** |
| `applicantType` (`internal` / `external`) | A `tos_identity` lookup for the resolved person. Never a radio button. |
| `email`, `claimedEmail` | The verified row in `tos_person_email`. **The code-entry form has no email field at all** (§10.6); a posted one on that route MUST be ignored outright, not validated and used. |
| `code`, `grantToken`, `challengeToken` | These are the one legitimate class of body-supplied secret. They are **normalised, hashed and looked up** — never trusted, never parsed for meaning, never echoed back. |
| `feePaid`, `waiverApproved` | The existing fee and waiver tables |
| `ipAddress`, `userAgent` | The request, on the server (`clientAddress`, the `user-agent` header). A body-supplied address poisons the rate limiter and the abuse board simultaneously. |
| `sourceSlug` | Validated against `application_sources`. An unknown value takes the moderated "Other" path, never a free-text insert. |
| `state`, `status`, `decision` on any `tos_*` row | The owning module's transition function. **MUST NOT** accept a target state from a client at all — not as a validated enum, not as an index into a list. |

Additional rules:

- **A GET that renders must re-derive too.** Hiding a button, disabling an input or omitting a sidebar
  entry is presentation. The POST re-checks, always, with the same call.
- `hidden` inputs, `disabled` attributes, `readonly` and `data-*` values are **display**, not
  authority. So is anything in `localStorage`, `sessionStorage`, a service-worker cache, or the
  offline queue in `public/offline-sync.js`: an offline-queued talent write is re-authorised on
  replay exactly as if it had arrived fresh.
- Validate the shape with `validateBody(schema, body)` from `src/lib/http-guard.ts`, **and then**
  ignore every field in the table above. Schema validation proves a value is well-formed; it proves
  nothing about whether the sender was entitled to send it.
- Return `sanitizeError(e)` to the client and log `e?.cause?.message || e?.message` on the server.
- In `.astro` files: declare every `const` **before** the POST handler that uses it; hoist any `<` or
  `<=` comparison out of JSX into the frontmatter; no `Record<string,string>` typed maps inside JSX;
  no arrow characters in JSX strings; `define:vars` cannot combine with `is:inline`; and a `<script>`
  inside a JSX conditional breaks parsing.

### 21.3 The privacy boundary

Onboarding is the point at which this system first handles date of birth, statutory identifiers and
bank details. `hr_employees` already carries `date_of_birth`, `blood_group`, `pan_number`,
`aadhaar_number`, `uan_number`, `esic_number`, `pf_number`, `bank_name`, `bank_holder`,
`bank_account_number`, `bank_ifsc` and `bank_branch`; `hr_bank_account` carries `holder`,
`account_number`, `ifsc`, `bank_name` and `upi_id`. This spec adds no new column of this kind and
**MUST NOT**.

**Field classes:**

| Class | Fields | Who may see |
|---|---|---|
| **A — record** | `full_name`, `work_email`, `designation`, `department_id`, `employment_type`, `employment_status`, `onboarding_status`, joining and probation dates, `employee_code`, `tos_identity.identity_code` | Any administrator who can open the section the field appears in |
| **B — personal** | `date_of_birth`, personal phone and address, emergency contact | HR core only (`hr` / `employees` sections, the `HR_CORE` audience), on the **single employee record** |
| **C — statutory and financial** | `pan_number`, `aadhaar_number`, `uan_number`, `esic_number`, `pf_number`, all `bank_*` fields, and every field of `hr_bank_account` | HR core only, **masked by default**, revealed **one field of one record at a time** |
| **H — health-adjacent** | `blood_group`, and anything from the wellness subsystem | The person themselves; and, for `blood_group`, HR core on the single employee record as an emergency-contact field. **Never on any oversight, analytics or list surface.** |

**Rules.**

1. **Class C is masked everywhere by default** — last four characters only. A full value is returned
   **only** by a per-record, per-field reveal action that calls
   `logAuditOrThrow({ action: 'tos.onboarding.reveal', entity: 'hr_employees', entityId, diff: { field_key, subject_person_id } })`
   and **proceeds only if that write succeeded**. This is the legal-hold ordering — `logAccess()` must
   succeed before anything renders — applied to the second-most sensitive read in the product. The
   diff records **which** field was revealed and to whom it belongs; **never the value**.
2. **No bulk anything for Class C.** No list column, no search result, no CSV or spreadsheet export,
   no API response carrying more than one record's Class C field, no notification body, no audit diff,
   no error message, no `tos_notification_log` row, and no entry in `tos_onboarding.locked_fields`.
   The locked-fields snapshot holds organisation-controlled facts only: title, department, position,
   employment type, manager, start date, stipend.
3. **Collect only what the engagement needs.** An unpaid engagement with no payroll run **MUST NOT**
   ask for bank, PF or ESIC details at all — there is nothing to pay into and nothing to file. The
   onboarding form's required set derives from `tos_selection.employment_type`,
   `tos_selection.stipend_amount` and `tos_opportunity.required_document_types`, never from a single
   global form. **REASON**: the cheapest way to protect a statutory identifier is not to hold it.
4. **Nothing in Class B, C or H is collected before authorization.** `applications` carries none of it
   and **MUST NOT** be extended to. It is collected inside `tos_onboarding.answers` after a selection
   is authorised — which means a rejected candidate never handed the platform a bank account, and a
   breach of the recruitment tables exposes no statutory identifier at all.
5. **Evaluators see none of it.** The evaluation surface renders the stage submission and, where
   `tos_pipeline_stage.evaluator_rule` sets `{"blind": true}`, a reference rather than a name. An
   evaluator has no route to `hr_employees`, to onboarding answers, or to documents. Section
   authority for `talent_evaluation` grants none of the onboarding sections.
6. **`date_of_birth`**: HR core, single record. Any birthday or anniversary feature renders **day and
   month only** and is opt-in. **MUST NOT** appear in a list, an export, a filter or an analytics
   dimension. An age band is a derived health-adjacent attribute and is not an available dimension
   either.
7. **`blood_group` is health-adjacent and is treated as such.** It exists as an emergency-contact
   field on the employment record. It **MUST NOT** appear on any oversight screen, analytics
   dimension, list, export, filter, or per-person admin table beyond the single employee record
   opened by an HR-core role.
8. **The absolute rule.** *No oversight surface in this system renders one row per person of
   health-adjacent data.* Aggregates only, and any group smaller than `MIN_GROUP` (5, from
   `src/lib/wellness.ts`) is **suppressed**, not shown. If you find yourself writing a query that
   returns a row per user of wellness, medical, blood-group or date-of-birth data on an admin
   surface, **that screen must not exist** — the requirement that produced it has been misread. This
   rule has already been broken once on this project, by a survey that read staff gender data out of
   `hr_employees` while building the system whose entire premise is that nobody reads private health
   data without consent.
9. **A person's own record is not an oversight screen.** A candidate or employee may see their own
   Class B and C values in full in their own portal, and may raise a `tos_correction_request` against
   any of them. Self-access is a right, not an exception to these rules, and it needs no reveal audit
   because there is no third party in the disclosure.
10. **Corrections to Class B, C and H fields are strictly audited** (`tos.correction.decide`, §20.3),
    recording the field key and copying **neither** the old nor the new value into the diff.
11. **Separation and retention.** On termination the identity closes (R-10); Class C fields are
    retained for the statutory period on the `hr_employees` record and **MUST NOT** be copied into any
    `tos_*` table as part of the closure. A record in scope of an open matter in `legal_matters` is
    not pruned (§20.6).
12. **The gender field is not a dimension.** Where `hr_employees` carries one, it is Class B, it is
    visible on the single record to HR core, and it **MUST NOT** be a filter, a facet, a group-by, a
    column, or an input to any eligibility rule, access profile or selection decision.

---

## 22. Edge cases [brief §34]

### 22.0 The contract these cases are decided against

Three rules govern every case below. They are stated once here and not repeated per case.

**R1 — The enumeration-oracle rule.** Every redemption failure that could reveal whether a code
exists, whom it belongs to, or which opportunity it is bound to renders **one identical body, one
identical HTTP status (200), and one identical set of response headers**. The ladder distinguishes
outcomes precisely — in `tos_code_attempt.outcome` and in `audit_log` — and tells the visitor
nothing. The single generic body is:

> **That code did not open anything.**
> If a code was sent to you, check it against the message it arrived in and try once more. If it
> still does not open, reply to that message and a person will look at it.

REASON: a message that distinguishes "expired" from "no such code" turns the entry form into an
oracle for enumerating live selections. The distinction is worth nothing to the honest holder of a
code — they retype it either way — and is worth a great deal to someone probing.

**R2 — What the visitor may be told specifically.** Only outcomes that are *about the person in
front of the screen rather than about the code* may be specific: `rate_limited`, `account_inactive`,
and `ok`. Everything else renders R1.

**R3 — The redemption input is the code plus the address the code was delivered to.** Both are
checked against `tos_auth_code`, then `tos_selection.person_id`, then `tos_person_email`. A
successful redemption sets `is_verified = TRUE` and `verified_at = NOW()` on the matched
`tos_person_email` row.
REASON: possession of a code delivered to an address *is* proof of control of that address, so this
removes an entire verification round trip and closes §5.3 rung 3 (unverified email) at the only
moment it matters. It also means no anonymous visitor can redeem on a code alone.

**Result vocabulary** — the values written to `tos_code_attempt.outcome`, referenced throughout this
section and by §25:

| outcome | rung | rendered |
|---|---|---|
| `malformed` | 0 — shape and checksum | R1 |
| `rate_limited` | 0 — attempt budget | specific |
| `not_found` | 1 — hash lookup | R1 |
| `revoked` | 2 — `revoked_at IS NOT NULL` | R1 |
| `expired` | 3 — `expires_at <= NOW()` | R1 |
| `exhausted` | 4 — `use_count >= max_uses` | R1 |
| `selection_missing` | 5 — selection row absent | R1 |
| `selection_unauthorised` | 5 — `is_authorised = FALSE` | R1 |
| `selection_suspended` | 5 — `suspended_at IS NOT NULL` | R1 |
| `selection_superseded` | 5 — decision is no longer `selected` | R1 |
| `opportunity_closed` | 6 — presented scope disagrees with the bound scope | R1 |
| `person_mismatch` | 7 — address does not belong to the bound person | R1 |
| `account_inactive` | 8 — `users.is_active = FALSE` | specific |
| `ok` | — | grant issued |

Surface paths used in this section: `/onboarding` (code entry, public), `/onboarding/form`
(grant-gated onboarding application), `/portal/applications` (existing candidate funnel),
`/careers/[slug]` (existing), and the admin console under `/admin/talent/*`. Where §§6–21 name a
route for the same surface, that name wins.

**Every case below writes both**: a `tos_code_attempt` row (where the case arises at redemption) and
a `logAudit({ userId, action, entity, entityId, diff })` row through `src/lib/audit.ts`. Audit
actions use the `tos.` namespace.

### 22.1 Additional DDL introduced by this section

Two uniqueness guarantees that the cases below depend on and that §4 does not yet carry. Both are
indexes over columns that already exist, both are idempotent, and both MUST be appended to
`db/talent-os-schema.sql` and to the `ensureOnce('tos_identity_v1', …)` and
`ensureOnce('tos_provisioning_v1', …)` bootstraps.

```sql
-- One onboarding approval mints at most one identity, however many times it is approved.
CREATE UNIQUE INDEX IF NOT EXISTS tos_identity_source_onboarding_uq
  ON tos_identity (source_onboarding_id) WHERE source_onboarding_id IS NOT NULL;

-- A grant already applied cannot be applied again. Replay becomes a no-op at the database rather
-- than in the retry loop, which is where the retry loop is least trustworthy.
CREATE UNIQUE INDEX IF NOT EXISTS tos_prov_event_grant_uq
  ON tos_provisioning_event (identity_id, target_kind, target_key)
  WHERE action = 'grant' AND state = 'applied';
```

### 22.2 The ten cases from the brief

**E-01 · Expired code** [brief §34]
- *Scenario*: the code is well formed, matches a `tos_auth_code` row, and `expires_at <= NOW()`.
- *Behaviour*: rung 3 fails. No grant is issued and `use_count` is not incremented. The code is
  **not** auto-revoked — an expired code the person is still holding is evidence, and an
  administrator may issue a replacement against the same `selection_id`.
- *Surface*: `/onboarding`, message R1.
- *Audit*: `tos_code_attempt(outcome='expired', matched_code_id, code_hash, ip_address)` and
  `logAudit({ action: 'tos.code.attempt', entity: 'tos_auth_code', entityId: code.id, diff: { outcome: 'expired' } })`.
- *Test*: T-17, T-25.

**E-02 · A code for opportunity A presented against opportunity B** [brief §34]
- *Scenario*: a valid code is entered on a surface scoped to a different opportunity, or a grant is
  carried to `/onboarding/form?role=<other>`.
- *Behaviour*: the code carries its own `opportunity_role_id`; the surface does not choose it. The
  redemption **ignores** any opportunity supplied by the client and derives it from the code. If a
  client-supplied opportunity is present and disagrees, the attempt is refused as
  `opportunity_closed` and the disagreement is recorded. The grant is scoped to
  `tos_onboarding_grant.opportunity_role_id`, and `/onboarding/form` reads the opportunity from the
  grant alone.
- *Surface*: `/onboarding`, message R1.
- *Audit*: `tos_code_attempt(outcome='opportunity_closed')` plus
  `logAudit({ action: 'tos.code.scope_mismatch', entity: 'tos_auth_code', entityId: code.id, diff: { bound: roleId, presented: presentedRoleId } })`.
- *Test*: T-21, T-30.

**E-03 · An employee applies with no code** [brief §34]
- *Scenario*: a person with an active `tos_identity` applies to an open opportunity through
  `/careers/[slug]` and has no selection, and therefore no code.
- *Behaviour*: **this is normal and MUST succeed.** A code is required only on the
  `direct_onboarding` pathway. The application is created with
  `tos_application_link.pathway = 'recruitment'`, `applicant_type = 'internal'` and
  `applicant_identity_id` set to their active identity. Internal eligibility
  (`tos_opportunity.internal_eligible`, `internal_identity_types`, `min_tenure_days`,
  `requires_manager_consent`) is evaluated at submit. They then enter the seven stages like anyone
  else.
- *Surface*: the normal application flow. No code field is rendered on the recruitment pathway at
  all, because a field that must be left blank teaches people that blank fields are acceptable.
- *Audit*: `logAudit({ action: 'tos.application.created', entity: 'applications', entityId, diff: { pathway: 'recruitment', applicant_type: 'internal' } })`.
- *Test*: T-51, T-53, T-54.

**E-04 · An employee is already selected for the position they are applying to** [brief §34]
- *Scenario*: a live `tos_selection` exists for `(person_id, opportunity_role_id)` with
  `decision = 'selected'` and `suspended_at IS NULL`.
- *Behaviour*: a second selection insert is refused by `tos_selection_live_uq`. A second
  **application** to the same opportunity is refused earlier, at submit. This is the person's own
  record, so R1 does not apply and the message is specific; their existing route is surfaced instead
  of a dead end.
- *Surface*: `/careers/[slug]`, message: "You have already been selected for this opportunity. Your
  onboarding is open — continue it from your applications page."
- *Audit*: `logAudit({ action: 'tos.application.blocked_duplicate', entity: 'tos_selection', entityId: sel.id, diff: { reason: 'already_selected' } })`.
- *Test*: T-52, T-61.

**E-05 · An intern applies for a full-time role** [brief §34]
- *Scenario*: an active identity of type `INTERN` applies to an opportunity whose
  `internal_identity_types` does not contain `INTERN`, or whose `min_tenure_days` is not met.
- *Behaviour*: eligibility fails at submit and **the application is not created.** The identity is
  not modified and the intern's current engagement is untouched. An empty `internal_identity_types`
  array means "no restriction", not "no one" — every internal type is admitted.
- *Surface*: `/careers/[slug]`, naming the rule that failed and, for tenure, the date it will be met:
  "This opportunity is open to internal applicants after 180 days in role. Your record shows 92 days,
  so you become eligible on 4 March 2027."
- *Audit*: `logAudit({ action: 'tos.eligibility.refused', entity: 'roles', entityId: roleId, diff: { rule, identity_type, tenure_days } })`.
- *Test*: T-53, T-54.

**E-06 · A candidate completed all seven stages, but for a different position** [brief §34]
- *Scenario*: `tos_stage_run` rows for application X (opportunity A) are all `passed`. The person
  applies to opportunity B.
- *Behaviour*: **nothing carries over.** `tos_stage_run` is keyed on `application_id`; the new
  application has no runs and starts at slot 1. Prior completion is *visible* to an evaluator as
  history on the person, and MAY be grounds for an explicit per-stage waiver — which is a
  `tos_stage_run.state = 'waived'` written together with a `tos_override` row carrying a reason,
  never an automatic skip.
- *Surface*: `/portal/applications` shows opportunity B at step 01. The admin candidate view shows a
  read-only "prior evaluation history" panel listing opportunity A's runs.
- *Audit*: any waiver writes
  `tos_override(entity='tos_stage_run', entity_id, from_state, to_state='waived', reason, actor_user_id)`.
- *Test*: T-55, T-44.

**E-07 · The code has already been used** [brief §34]
- *Scenario*: `use_count >= max_uses`, or `consumed_at IS NOT NULL` on a single-use code.
- *Behaviour*: rung 4 fails. Consumption is a single conditional UPDATE, so a second attempt cannot
  win a race:

```sql
UPDATE tos_auth_code
   SET use_count = use_count + 1,
       consumed_at = CASE WHEN use_count + 1 >= max_uses THEN NOW() ELSE consumed_at END
 WHERE id = $1
   AND revoked_at IS NULL
   AND expires_at > NOW()
   AND use_count < max_uses
RETURNING id, use_count, max_uses;
```

```ts
const r = await db.execute(sql`/* the statement above */`);
const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
if (!rows.length) return { outcome: 'exhausted' as const };   // zero rows is the refusal, not an error
```

  A zero-row return is `exhausted`, and the redemption is not retried in application code.
- *Surface*: `/onboarding`, message R1.
- *Audit*: `tos_code_attempt(outcome='exhausted')`.
- *Test*: T-18, T-26.

**E-08 · The candidate's identity differs from the selection record** [brief §34]
- *Scenario*: the address entered with the code does not belong to the bound `person_id`; or the
  signed-in session resolves to a different person; or the onboarding form arrives with a name, date
  of birth or address contradicting the locked snapshot.
- *Behaviour*: at redemption this is rung 7, `person_mismatch`, rendered as R1 — the entry surface
  MUST NOT confirm that the code is real by naming whom it belongs to. **Inside** an open onboarding
  a contradiction on a locked field is not refused silently: the field stays locked and the candidate
  is offered a correction request, which writes `tos_correction_request` and is decided by a human.
- *Surface*: `/onboarding` R1; or `/onboarding/form`, message: "This detail comes from your selection
  record and cannot be edited here. If it is wrong, request a correction and a person will check it
  against your documents."
- *Audit*: `tos_code_attempt(outcome='person_mismatch')`; or
  `logAudit({ action: 'tos.onboarding.correction_requested', entity: 'tos_correction_request', entityId, diff: { field_key, current_value, proposed_value } })`.
- *Test*: T-22, T-31, T-32.

**E-09 · The employee account is inactive** [brief §34]
- *Scenario*: `users.is_active = FALSE`, or the person's `tos_identity` is `suspended` or
  `terminated`, at any point in the flow.
- *Behaviour*: rung 8. Every internal route closes at once — application submit, code redemption, an
  open grant, and any provisioning still pending. An open `tos_onboarding_grant` is revoked
  (`revoked_at = NOW()`). Pending `tos_provisioning_event` rows move to `state = 'failed'` with
  `error_reason = 'identity not active'`; **applied** grants are revoked through the deprovisioning
  path so RBAC and the identity agree.
- *Surface*: this is about the person, not about a code, so R2 permits a specific message.
  `/onboarding`: "Your account is not active, so this step cannot continue. The people desk can
  restore it."
- *Audit*: `tos_code_attempt(outcome='account_inactive')` and
  `logAudit({ action: 'tos.identity.route_closed', entity: 'tos_identity', entityId, diff: { reason } })`.
- *Test*: T-23, T-62.

**E-10 · The candidate withdraws** [brief §34]
- *Scenario*: the person withdraws at any point — before evaluation, mid-stage, after selection, or
  during onboarding.
- *Behaviour*: one entry point, `withdraw(personId, applicationId, note)`, does all of it in a single
  transaction: `applications.stage = 'withdrawn'` (the existing `CLOSED_STAGES` key, so the existing
  tracker renders the correct ending rather than the last open step); open `tos_stage_run` rows go to
  `skipped`; a live `tos_selection` goes to `decision = 'withdrawn'` with `is_authorised = FALSE`;
  every live `tos_auth_code` for that selection is revoked with
  `revoked_reason = 'candidate withdrew'`; open grants are revoked; an open `tos_onboarding` is
  rejected with `rejection_reason = 'withdrawn by candidate'`. **No identity is created and none is
  touched.** Withdrawal is reversible only by an administrator, through `tos_override`.
- *Surface*: `/portal/applications` renders the existing `withdrawn` descriptor: "This application is
  no longer being taken forward at your request. Every other open role remains available to you."
- *Audit*: `logAudit({ action: 'tos.withdraw', entity: 'applications', entityId, diff: { stage_from, selection_id, codes_revoked } })`.
- *Test*: T-56.

### 22.3 Cases this design implies

**E-11 · The opportunity closed between code issue and redemption**
- *Scenario*: `tos_opportunity.applications_open = FALSE`, or `closes_at < NOW()`, or `roles.is_open`
  is false, after the code was issued.
- *Behaviour*: **the code still works.** REASON: `applications_open` governs *new applications*, not
  a selection the organisation has already made and authorised. Closing intake MUST NOT strand a
  person the organisation has already chosen. Only `is_authorised = FALSE`, `suspended_at`, or an
  explicit revocation stops a redemption. The `opportunity_closed` outcome is reserved for the scope
  mismatch in E-02 and for an opportunity an administrator has hard-closed by explicitly cancelling
  its live selections.
- *Surface*: normal redemption; the candidate reaches `/onboarding/form`.
- *Audit*: `tos_code_attempt(outcome='ok')` plus
  `logAudit({ action: 'tos.code.redeemed_after_close', entity: 'tos_auth_code', entityId })`, so the
  event is visible in the report rather than surprising in a conversation.
- *Test*: T-63.

**E-12 · The selection was suspended after the code was issued and delivered**
- *Scenario*: `tos_selection.suspended_at` is set while a code sits in the candidate's inbox.
- *Behaviour*: rung 5 fails, `selection_suspended`. Suspension MUST NOT auto-revoke the code —
  suspension is often temporary (a pending verification), and revoking severs the audit link between
  the delivered artefact and the person. Lifting the suspension restores the same code if it has not
  expired.
- *Surface*: `/onboarding`, R1.
- *Audit*: `tos_code_attempt(outcome='selection_suspended')`; the suspension itself already wrote
  `tos_override(entity='tos_selection', to_state='suspended', reason)`.
- *Test*: T-20, T-44.

**E-13 · Two people race the same multi-use code**
- *Scenario*: `max_uses > 1` and two redemptions arrive in the same millisecond.
- *Behaviour*: the conditional UPDATE in E-07 is the only increment path, so the database serialises
  them. Each winner receives its own `tos_onboarding_grant`. When `max_uses` is reached the last
  winner sets `consumed_at` and every later attempt is `exhausted`. **A multi-use code still binds to
  one `person_id`**, so rung 7 stops a second *person* regardless of remaining uses: multi-use means
  "this person may open the form more than once", never "this code is transferable".
- *Surface*: winners proceed; losers see R1.
- *Audit*: one `tos_code_attempt` per attempt, each with its own outcome.
- *Test*: T-27, T-22.

**E-14 · A person is merged mid-onboarding**
- *Scenario*: a §5.5 merge runs while `tos_onboarding` is open for the losing person row.
- *Behaviour*: the merge repoints `tos_person_email`, `tos_application_link.person_id`,
  `tos_selection.person_id`, `tos_auth_code.person_id`, `tos_onboarding_grant.person_id`,
  `tos_onboarding.person_id` and `tos_identity.person_id` to the winner, then sets `merged_into_id`
  on the loser. Nothing is deleted. An open grant survives, because it is keyed on `selection_id` and
  the selection moved with it. If the merge would produce two live selections for one opportunity,
  `tos_selection_live_uq` refuses it and the operator must first suspend one selection with a written
  reason. **A merge is never automatic.**
- *Surface*: `/admin/talent/people`, with a merge preview listing exactly what will repoint and how
  many rows of each kind.
- *Audit*: `logAudit({ action: 'tos.person.merged', entity: 'tos_person', entityId: winnerId, diff: { loser, repointed: { emails, applications, selections, codes, onboardings, identities } } })`.
- *Test*: T-09, T-57.

**E-15 · An evaluator is also the candidate**
- *Scenario*: a person listed in `tos_opportunity.evaluator_user_ids`, or holding an evaluation
  capability, applies to that opportunity — or is routed their own stage run.
- *Behaviour*: writing `tos_evaluation` is refused when `evaluator_user_id` resolves, through
  `tos_person.user_id`, to the `tos_application_link.person_id` of the run's application. The same
  check refuses them as `tos_stage_run.decided_by`, as `tos_selection.decided_by_user_id`, as
  `tos_selection.approved_by_user_id`, and as `tos_onboarding.approved_by_user_id`. It cannot be
  expressed as an index — the relationship spans three tables — so it is a guard with its own test,
  and `tos_override` cannot lift it.
- *Surface*: the review queue omits their own application entirely; reached by URL it renders "You
  are the applicant on this record. It has been routed to another evaluator."
- *Audit*: `logAudit({ action: 'tos.evaluation.self_refused', entity: 'tos_stage_run', entityId, diff: { evaluator_user_id } })`.
- *Test*: T-42.

**E-16 · An onboarding is approved twice**
- *Scenario*: a double click, a retried request, or two administrators approving at the same moment.
- *Behaviour*: approval claims the transition with a conditional UPDATE:

```sql
UPDATE tos_onboarding
   SET state = 'approved', approved_at = NOW(), approved_by_user_id = $2
 WHERE id = $1 AND approved_at IS NULL
RETURNING id;
```

  A zero-row return means somebody else approved it; the handler re-reads the row and returns the
  **existing** result rather than an error. Identity creation is protected a second time by
  `tos_identity_source_onboarding_uq` (§22.1), and employment creation a third time by
  `completeHire()`, which is already idempotent, returns the existing `hr_employees` row, and never
  throws. Three independent guarantees, because this is the step that mints a human's employment
  record.
- *Surface*: `/admin/talent/onboarding/[id]` shows the approval as already done, with the approver
  and the time, and exactly one identity.
- *Audit*: the first approval writes `logAudit({ action: 'tos.onboarding.approved', … })`; the second
  writes
  `logAudit({ action: 'tos.onboarding.approve_noop', entity: 'tos_onboarding', entityId, diff: { already_approved_by, already_approved_at } })`.
- *Test*: T-33, T-34.

**E-17 · A provisioning step fails halfway**
- *Scenario*: four targets derived from a `tos_access_profile`; two apply, the third throws, the
  fourth never runs.
- *Behaviour*: **fail-partial, never fail-silent, and never roll the identity back.** Each target is
  its own `tos_provisioning_event` row. Applied rows stay `applied`. The failing row is written
  `state = 'failed'` with `error_reason = e?.cause?.message || e?.message`. Remaining rows stay
  `pending`. The identity stays `active` — the person exists and their employment record is real;
  what is missing is one system's access. A retry re-runs only `pending` and `failed` rows, and
  `tos_prov_event_grant_uq` makes replay of an applied row a no-op.
  REASON for not rolling back: revoking access already granted, because a fourth unrelated system
  timed out, produces a person who can sign in on Monday and cannot on Tuesday for no reason anybody
  can see.
- *Surface*: `/admin/talent/provisioning` lists every non-`applied` row with its reason and a "run
  again" control. Nothing anywhere reports "provisioned" while a row is `pending` or `failed`.
- *Audit*: one `tos_provisioning_event` per target, plus
  `logAudit({ action: 'tos.provisioning.partial', entity: 'tos_identity', entityId, diff: { applied, failed, pending } })`.
- *Test*: T-45, T-47, T-48.

**E-18 · A code is delivered to an address the person no longer controls**
- *Scenario*: the delivery address in `tos_person_email` is a former employer's mailbox, a shared
  address, or one the person has lost.
- *Behaviour*: delivery targets are restricted at issue. A code MUST NOT be sent to an address whose
  `is_verified` is false, and MUST NOT be sent to an `is_official` address belonging to an identity
  whose status is not `active`. The remedy is revoke-and-reissue, never resend: the administrator
  revokes with a `revoked_reason`, adds and verifies a new address, and issues a fresh code — which
  under E-27 revokes any remaining live code for that selection in any case. `delivered_at` records
  that delivery happened and is never treated as proof of receipt.
- *Surface*: `/admin/talent/selections/[id]` lists the person's addresses with their verified state
  and refuses delivery to unverified ones, stating why inline rather than presenting a disabled
  control with no explanation.
- *Audit*: `logAudit({ action: 'tos.code.revoked', entity: 'tos_auth_code', entityId, diff: { reason } })`
  followed by `tos.code.issued` for the replacement.
- *Test*: T-58, T-64.

**E-19 · A code is revoked before it is redeemed**
- *Behaviour*: rung 2, `revoked`. Revocation is permanent; there is no un-revoke, and a replacement
  is a new row. R1 at the surface.
- *Audit*: `tos_code_attempt(outcome='revoked')`.
- *Test*: T-16.

**E-20 · Someone guesses at codes**
- *Behaviour*: rung 0 applies before any lookup. The budget is per IP and per `code_hash` prefix over
  a rolling window, read from `tos_code_attempt` through `tos_code_attempt_ip_idx`. Over budget, the
  request is refused **before** the hash lookup, so the timing of a refused attempt carries no
  information about whether the code existed. A malformed input writes a row with `code_hash = NULL`.
- *Surface*: specific under R2: "Too many attempts from this connection. Try again in 15 minutes."
- *Audit*: `tos_code_attempt(outcome='rate_limited' | 'malformed')` and, at a threshold,
  `logAudit({ action: 'tos.code.abuse_suspected', entity: 'tos_code_attempt', diff: { ip, attempts, window } })`.
- *Test*: T-11, T-14, T-24.

**E-21 · Every stage passed, but no selection decision was recorded**
- *Behaviour*: passing slot 7 does **not** create a `tos_selection`. The projection maps this state
  to the candidate-visible `decision` step, not to `onboarded`, and the candidate sees that step's
  existing wording. The admin queue surfaces it as "awaiting decision" with the clock from
  `tos_pipeline_stage.sla_days`. A selection is a human act with a written `decision_reason`; no code
  path infers one from stage outcomes.
- *Surface*: `/portal/applications` at step 05.
- *Test*: T-40, T-41.

**E-22 · The same person applies twice to the same opportunity**
- *Behaviour*: refused at submit while an application for that `(person_id, opportunity_role_id)` sits
  in an open stage. Permitted once the previous one is in a `CLOSED_STAGES` key and the opportunity
  is open again — a re-application is a new `applications` row with a new `tos_application_link`, and
  the person's history stays intact and visible on both.
- *Surface*: `/careers/[slug]`, naming the open application and linking to it.
- *Test*: T-61.

**E-23 · A person with no account reaches redemption**
- *Behaviour*: permitted. R3 makes the code plus the delivery address sufficient. The grant is
  server-side and anonymous-safe; `tos_onboarding_grant.person_id` is set from the code, never from a
  session. A `users` row is created only if and when identity provisioning needs one, at approval.
  REASON: requiring account creation before onboarding puts an authentication problem in front of a
  person who has been selected and has nothing yet to authenticate with.
- *Test*: T-29, T-30.

**E-24 · The grant expires while the candidate is filling in the form**
- *Behaviour*: `tos_onboarding_grant.expires_at` is issue plus two hours. Answers are written to
  `tos_onboarding.answers` on every step, so an expiry loses nothing. On expiry the form refuses
  further writes and asks the person to enter the same code again, which still works if it has uses
  left and has not expired. Where the code was single-use and is now consumed, the person is told to
  contact the people desk and an administrator re-issues under E-27.
- *Surface*: `/onboarding/form`, specific under R2 because it concerns their own session rather than a
  code: "This session has timed out for security. Your answers are saved. Enter your code again to
  continue."
- *Test*: T-28.

**E-25 · An internship is recorded with no stipend**
- *Behaviour*: `tos_selection.stipend_amount IS NULL` means **unpaid**, and every surface showing the
  engagement MUST say so in words. No surface may render an empty amount, a dash, or "to be
  confirmed". Copy: "This internship is unpaid. No stipend is payable." Where an amount is present it
  is rendered with `stipend_currency` and is never described as a salary.
- *Surface*: the `/onboarding/form` summary panel, the offer summary, and
  `/admin/talent/selections/[id]`.
- *Test*: T-35.

**E-26 · A detector flags a candidate during an assessment**
- *Behaviour*: the detector appends to `tos_stage_run.advisory_flags` and does nothing else. It MUST
  NOT write `state`, `score`, `decided_at`, `decided_by`, or any `tos_evaluation` row. A stage
  outcome is set only through a `decided_by` user id that resolves to a real person. A flag with no
  human decision leaves the run exactly where it was.
- *Surface*: the evaluator screen presents flags as context under the words "Advisory only. A
  reviewer decides." Where a flag changes an outcome, the candidate is told a review took place and
  the reason is in the outcome note.
- *Audit*: `logAudit({ action: 'tos.stage.flag_recorded', entity: 'tos_stage_run', entityId, diff: { flag } })`
  — recorded as a flag, never as a decision.
- *Test*: T-41.

**E-27 · Two administrators issue two codes for the same selection**
- *Behaviour*: issuing a code revokes every live code for that `selection_id` in the same
  transaction, with `revoked_reason = 'superseded by a newly issued code'`. Exactly one live code per
  selection at any time. REASON: two live codes for one selection means the audit cannot say which
  artefact the person actually held, and the revoke-and-reissue remedy in E-18 stops being
  meaningful.
- *Surface*: `/admin/talent/selections/[id]` shows the live code by `code_display_prefix` and
  `code_last4`, with revoked ones listed beneath. The plaintext is shown once, at issue, and is never
  recoverable — only `code_hash` is stored.
- *Test*: T-13, T-58.

**E-28 · A selection is created without an application**
- *Behaviour*: refused by `tos_selection.application_id NOT NULL`. The `direct_onboarding` pathway
  therefore MUST mint an `applications` row first, with
  `tos_application_link.pathway = 'direct_onboarding'`, before any selection exists. That row carries
  what is known and is marked as not candidate-submitted.
  REASON: a person's record must read the same whichever door they came through, and every downstream
  join — funnel projection, documents, audit — is keyed on `application_id`.
- *Test*: T-59.

**E-29 · A department slug reaches a UUID column**
- *Behaviour*: `tos_identity.department_id`, `tos_selection.offered_department_id` and
  `tos_access_profile.department_id` are TEXT and are never cast. Translation into
  `hr_employees.department_id`, which is a UUID in `db/hr-schema.sql`, is owned by `completeHire()`
  and is not reimplemented anywhere under `src/lib/talentos/`. A new `::uuid` on a department
  expression is a defect; both the linter pass and a test look for it.
- *Test*: T-50.

**E-30 · A rejected onboarding is followed by a new selection**
- *Behaviour*: rejection sets `rejected_at` and `rejection_reason` and leaves the selection intact.
  `tos_onboarding.selection_id` is UNIQUE, so a retry reopens the **same** onboarding row rather than
  creating a second; the state moves back through the override ledger with a reason. A genuinely new
  selection on different terms suspends the old one first, so `tos_selection_live_uq` is satisfied,
  and gets its own onboarding.
- *Test*: T-44, T-60.

**E-31 · A terminated identity's mailbox still resolves**
- *Behaviour*: covered in full by §5.7. The mailbox is a delivery fact. Every internal route asks
  `tos_identity.status = 'active'`, never the address. This is the case §5.7 already binds to T-07.
- *Test*: T-07.

**E-32 · An administrator overrides a state with no reason**
- *Behaviour*: refused. `tos_override.reason` is NOT NULL and the writer enforces a 20-character
  minimum before the state write, inside the same transaction. A state write with no accompanying
  `tos_override` row is a defect regardless of who made it, the founder included.
- *Surface*: the override dialog will not submit without a reason, and states plainly that the reason
  is permanent and attributable.
- *Test*: T-44.

**E-33 · A code is never opened and simply expires**
- *Behaviour*: a daily sweep marks nothing and deletes nothing. Expired codes remain as rows. The
  selection stays `selected` and `is_authorised`; the candidate appears on an "authorised, not
  started" list once `code_validity_days` has passed, and a human decides whether to re-issue, make
  contact, or suspend the selection with a reason. **No automated withdrawal.**
- *Surface*: `/admin/talent/selections?filter=not_started`.
- *Test*: T-65.

---

## 23. Non-negotiable distinctions [brief §38]

Nine distinctions. Each is enforced twice — once by a database object that survives a bad code path,
and once by a named guard that produces a comprehensible refusal. Neither layer alone is enough: a
constraint with no guard yields a 500 page, and a guard with no constraint yields a corrupt row the
first time somebody writes SQL by hand.

| # | Distinction | Enforced in the DATABASE | Enforced in the BACKEND | Test |
|---|---|---|---|---|
| 1 | Core concept — the two applicant pathways | §2.1, §4.3 `pathway`, §16.1 entry experience, T-59, T-61 |
| 2 | Internal EduRankAI people may apply directly | §4.1 `tos_identity`, §7 eligibility, §16.2 internal route, T-51, T-53 |
| 3 | The two primary questions | §16.1 (candidate-facing copy in full), §17 `POST /api/talent/entry/resolve` |
| 4 | High-level decision tree | §16.3 decision endpoint, §7 evaluation order |
| 5 | "Apply" has two meanings | §4.3 `pathway` vocabulary, §16.1 copy, `src/lib/talentos/vocab.ts` |
| 6 | Do not duplicate the seven stages | §10.3 ladder into §12 direct onboarding, §22 E-05, T-53 |
| 7 | The seven stages when not yet passed, admin-configurable | §4.4, §8.1–§8.2, T-39, T-40 |
| 8 | Selection authorization code and its bindings | §4.5, §10.1–§10.2, T-11 to T-13, T-58, T-64. **Deviation** — the secret is widened from one five-character group (25 bits) to three four-character groups (60 bits). The brief's readable structure is unchanged; 25 bits is not a defensible bearer credential and the arithmetic is given in §10.1. |
| 9 | Code does not equal permission | §10.5, §14, §23 row 5, T-26, T-27 |
| 10 | Same-form principle | §12.1, §12.2, T-31, T-32 |
| 11 | Existing employee, intern, fellow or member flow | §7, §13.5 internal transfer, §22 E-03 to E-06 |
| 12 | The identity registry and its fields | §4.1 `tos_identity`, §5.6, T-08, T-34 |
| 13 | The @edurankai.in rule | §5.7, §23 row 4, T-07 |
| 14 | External applicants and their channels | §1.1 `application_sources`, §4.3 `source_slug`, T-72 |
| 15 | Admin console navigation | §18.1 |
| 16 | Opportunity configuration fields | §4.2 `tos_opportunity`, §6 |
| 17 | Selection status values and the post-selection sequence | §4.5, §8.3, §17.2 state machine |
| 18 | Application form engine | §12.2. **Deviation** — brief §18 lists "document uploads" as a field type. Documents of any kind are submitted as verified links with "Anyone with the link" access, per the existing `src/lib/hr-onboarding.ts` model; the only stored binary is the 320px photo. Reason in §12.2.5. |
| 19 | Pre-filling | §12.3 `locked_fields`, T-35 |
| 20 | Onboarding completion sequence | §13, §17.2, T-33, T-34, T-60 |
| 21 | Departmental access derivation | §14.1, §14.7, T-45, T-47 |
| 22 | RBAC + ABAC effective-permission formula | §14.4, §23 rows 7 and 8, T-46, T-69, T-70 |
| 23 | Employee and internal portal modules | §15 |
| 24 | Consolidated application history per person | §2.1, §2.2, §16.2, T-02 to T-06 |
| 25 | Selection history preservation | §4.4 `tos_evaluation`, §4.5 `tos_selection`, §9, T-42, T-43 |
| 26 | The code validation ladder | §10.3, T-14 to T-24 |
| 27 | Admin override with mandatory audit | §4.8 `tos_override`, §22 E-32, T-44 |
| 28 | Security | §21, §10.4 rate limits |
| 29 | Do not trust frontend state | §11, §21.2, §4.6 `tos_onboarding_grant`, T-28 to T-30 |
| 30 | Notification system | §19, T-73, T-74 |
| 31 | Audit trail event list | §20, T-71 |
| 32 | Data model entity list | §2 — all 25 entities mapped. **Deviation** — "Candidate" is not a table. It is the role a person plays in one opportunity, expressed as a query (§2.1); giving it a table is how a system ends up with three unrelated records for one human, which brief §24 and §33 forbid. |
| 33 | One person, many applications, one current identity | §2.2, §4.1 `tos_identity_one_primary`, §5, T-06, T-08 |
| 34 | The ten edge cases | §22 in full |
| 35 | UX principle for the first screen | §16.1 |
| 36 | Admin state-at-a-glance examples | §18.2 |
| 37 | Final business logic | §16.3 decision endpoint plus §10.3 ladder — the paragraph is executable as those two, not as prose |
| 38 | The nine non-negotiable distinctions | §23 in full |
| 39 | End-to-end talent system objective | §27 build order; §1 records that nothing in §1.1 or §1.2 is rebuilt |

---

## 27. Build order

Six phases. Each is independently shippable, independently verifiable, and leaves the system working
if the next phase never lands. Ordered by risk: the irreversible data decisions come first, while
they are still cheap to change.

### Phase 1 — Schema and person backfill

**Contains** `db/talent-os-schema.sql` and `src/lib/talentos/schema.ts` (all of §4 plus §22.1);
`codes.ts` (`nextPersonCode`, identity-code minting); `person.ts` (`resolvePerson`, `mergePersons`);
`backfill.ts` and `db/talent-os-backfill.sql`.
**Unblocks** everything. Nothing else can be built against a person that does not exist.
**Gated by** T-01 to T-10, T-50.
**Surface** `/admin/talent/people` — a searchable list of persons with their addresses,
applications and identities, plus the merge preview. That is the phase's proof: an administrator can
find one human and see every record belonging to them.
**Note** the backfill is run by the founder from the command handed over. It is idempotent and
reports counts.

### Phase 2 — Entry experience and the code path

**Contains** `tos_opportunity` configuration and its admin editor; `tos_application_link` written at
submit; eligibility evaluation; code issue, delivery, the redemption ladder, rate limiting, and the
`tos_onboarding_grant` route authority.
**Unblocks** onboarding. It is also the first real security surface, so it ships before anything
depends on it.
**Gated by** T-11 to T-30, T-51 to T-54, T-58, T-63 to T-65.
**Surface** `/onboarding` — enter a code and an address and reach a page that could not be reached by
guessing. T-25 and T-30 are run against the deployed URL, not in CI.

### Phase 3 — Evaluation

**Contains** `tos_pipeline`, the seven-slot editor, `tos_stage_run`, `tos_evaluation`, the projection
onto the existing six-step funnel, advisory flags, and the override ledger.
**Unblocks** selection with a real basis. It ships after the code path because the code path is what
protects the outcome.
**Gated by** T-39 to T-44, T-55, T-66.
**Surface** `/admin/talent/pipelines`, and the candidate's own `/portal/applications`, which must
keep rendering the same six steps it rendered before this phase — visibly unchanged is the pass
condition.

### Phase 4 — Onboarding and identity

**Contains** `tos_onboarding`, locked fields, correction requests, the document layer through the
existing `hr-onboarding.ts`, approval, identity minting, and the call into `completeHire()`.
**Unblocks** provisioning. This is the phase that creates a human's employment record, so it carries
the three independent idempotency guarantees of §22 E-16.
**Gated by** T-31 to T-38, T-56, T-57, T-59, T-60, T-67.
**Surface** `/onboarding/form` end to end, then `/admin/talent/onboarding` to approve, then the new
row visible on the existing `/admin/hr` surfaces.

### Phase 5 — Provisioning

**Contains** `tos_access_profile`, `tos_app_system`, derivation, `tos_provisioning_event`,
`tos_access_request`, and deprovisioning on termination.
**Unblocks** the access half of the brief. It is last of the functional phases because it is the only
one that can be done by hand in the interim with no data loss.
**Gated by** T-45 to T-49, T-62, T-68, T-69, T-70.
**Surface** `/admin/talent/provisioning` — every event with its state and, where it failed, the real
Postgres reason from `e.cause`.

### Phase 6 — Console

**Contains** the selections console, the code register, the abuse board over `tos_code_attempt`, the
"authorised, not started" list, the audit view, and a copy pass across every candidate-facing string.
**Unblocks** nothing. It makes the preceding five phases operable by somebody who did not build them.
**Gated by** T-71 to T-75.
**Surface** `/admin/talent` as a whole.

### Not in scope for v1

| Not built | Why |
|---|---|
| Document upload and storage | Links only, per §26 brief §36. Revisit only if a partner's compliance requirement makes links unacceptable, and then as an S3-backed store behind a swappable interface, not as blob storage bolted onto a form. |
| Automated scoring or ranking of candidates | The seven stages record human judgement. A model that ranks people is a different product with different obligations, and this build must not smuggle one in through `pass_rule`. |
| A candidate-facing appeals workflow | Decisions are already stated to be appealable and appeals are handled by a person today. Building a workflow before there is volume would fix the wrong shape. |
| Multi-organisation or partner-scoped tenancy | One organisation. Every `tos_*` table would need a tenant column, and adding it later to eleven tables is cheaper than carrying an unused one through every query now. |
| Automated deprovisioning on a schedule | Termination-triggered revocation ships in Phase 5. A time-based sweep that revokes access with no human in the loop is how people lose access on a Friday evening for no stated reason. |
| Interview scheduling | `tos_stage_run.external_ref` points at the existing scheduling subsystem. Rebuilding it would breach §1. |

---

## 28. Open decisions requiring founder sign-off

Policy, not mechanism. Each could reasonably go either way. This specification has taken a default so
the build is not blocked, but the default is a decision somebody should make on purpose.

**D-01 · Does a selection require a second signature?**
`tos_selection.approved_by_user_id` and `approved_at` exist for it. Options: (a) the decider's own
signature suffices; (b) a second named person must approve before `is_authorised` can be set; (c)
second signature only above a grade or a stipend threshold.
*Recommendation*: (b) for employment-backed identity types, (a) for the rest.
*Cost of deciding late*: low now, high later. Retro-fitting a second signature leaves every selection
already authorised under (a) unattributable to a second approver, and the audit cannot say whether
that was policy or omission.

**D-02 · How long is a code valid, and may it be multi-use?**
`code_validity_days` defaults to 21 and `code_multi_use` to false. Options: a shorter window with
easy re-issue, or a longer one with fewer support requests.
*Recommendation*: keep 21 days and single use; re-issue is one click and is fully audited.
*Cost of deciding late*: low. It is per-opportunity configuration and changes nothing structural.

**D-03 · Who may issue and revoke a code?**
Options: the hiring manager for their own opportunities; a central people-desk capability; the
founder only.
*Recommendation*: a dedicated capability granted to the people desk, with hiring managers able to
request issue but not perform it.
*Cost of deciding late*: moderate. The capability name is baked into every guard and into the seeded
roles; renaming it later touches the RBAC seed and every grant already issued under the old name.

**D-04 · Is manager visibility of an internal application on by default?**
`tos_opportunity.requires_manager_consent` exists per opportunity. Options: never; per-opportunity
opt-in disclosed to the applicant; always.
*Recommendation*: per-opportunity opt-in, disclosed before the person submits rather than after.
*Cost of deciding late*: low in code, high in trust. An internal applicant who discovers after the
fact that their manager was notified will not apply again.

**D-05 · How long are unsuccessful applications and their evaluations retained?**
Nothing in §4 expires. Options: a fixed retention window with deletion; retention with consented
transfer into the existing talent pool; indefinite.
*Recommendation*: 12 months, or longer only where the person consented to the talent pool, with that
consent recorded on the application.
*Cost of deciding late*: high. Retention cannot be applied retroactively to data that should already
have gone, and a policy adopted after a year of collection begins by deleting evidence.

**D-06 · Which positions are sensitive enough to require an extra check before provisioning?**
`tos_access_profile.requires_approval` exists but nothing populates the list.
*Recommendation*: a named list from the people desk before Phase 5 ships; until then, every profile
carrying an admin section key requires approval.
*Cost of deciding late*: moderate. The interim default is safe but noisy, and noise is how approval
steps come to be clicked through.

**D-07 · What happens to access on the day one engagement ends and the next has not started?**
The model allows an `ended_on` on one identity and a `pending` next one. Options: access lapses at
midnight and returns on the new start date; access carries across the gap; the outgoing identity is
extended by hand.
*Recommendation*: access lapses, and the gap is shown on the identity screen a week ahead so somebody
can act on purpose.
*Cost of deciding late*: moderate. The failure mode is a person arriving for the first day of a new
engagement with nothing working, which is exactly the experience this build exists to remove.

**D-08 · Does a rejected onboarding invalidate the selection?**
§22 E-30 keeps the selection and reopens the same onboarding row. Options: as built; or rejection
suspends the selection and a fresh decision is required.
*Recommendation*: as built for correctable rejections such as a missing document, and suspension with
a written reason for substantive ones.
*Cost of deciding late*: low. Both paths already exist; this decides only which one the default
button performs.
