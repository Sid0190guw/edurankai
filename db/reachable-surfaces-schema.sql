-- db/reachable-surfaces-schema.sql
-- FIFTEEN TABLES BEHIND PAGES A REAL PERSON CAN OPEN TODAY, none of which exist in production.
--
-- SAFE TO RUN ON PRODUCTION. Every statement is CREATE TABLE IF NOT EXISTS or CREATE INDEX
-- IF NOT EXISTS. No ALTER TABLE, nothing dropped, no row rewritten, and nothing here touches a
-- table that already exists.
--
-- RUN IT YOURSELF. Nothing in the build opens a production connection.
--
-- ============================================================================================
-- HOW THIS LIST WAS PRODUCED, BECAUSE THE METHOD MATTERS MORE THAN THE LIST
-- ============================================================================================
--
-- Every `CREATE TABLE IF NOT EXISTS` in src/ was collected (736 of them, 325 naming a table the
-- live database does not have) and diffed against a full enumeration of the production database.
-- Then the 325 were split by WHO OWNS THE CREATE:
--
--   * ~300 belong to library modules — src/lib/mailplatform/schema.ts (47), src/lib/talent/schema.ts
--     (29), src/lib/talentos/schema.ts (28), src/lib/horizon/schema.ts (9) and the like. Those are
--     subsystems nothing has exercised. A table for a feature no one has opened is not an outage,
--     and inventing DDL files for three hundred of them would be motion, not repair.
--
--   * These are created by a PAGE under src/pages. That is the difference: somebody
--     navigating the site reaches them. Every one of these renders today as an empty list, a failed
--     save, or a caught error dressed as "nothing here yet" — which is the failure mode this
--     project keeps finding, an outage that reads as an empty state.
--
-- DDL IS COPIED VERBATIM from the page that owns it, so the table this file creates is the exact
-- table that page expects. The page keeps its own `CREATE TABLE IF NOT EXISTS`; that statement is
-- refused in production (see src/lib/ensure-once.ts) and becomes a no-op once the table is here.
--
-- WHY THESE CANNOT BE FIXED BY THE REPAIR BUTTON. /admin/setup and /admin/ops run a registry of
-- exported ensure functions. Page-owned DDL has no exported function to call — it is inline in the
-- page's frontmatter — so this file is the only way to create them. The tables are registered in
-- BOOTSTRAP_MODULES so /api/health reports on them either way.

-- --------------------------------------------------------------------------------------------
-- ASK A DOUBT — src/pages/portal/doubts/index.astro and [id].astro
-- The answer table references the question table, so order matters here.
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doubts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL,
  course_id           uuid,
  subject             text NOT NULL,
  body                text NOT NULL,
  language            text DEFAULT 'en',
  urgency             text DEFAULT 'med',
  status              text DEFAULT 'open',
  aquin_answer        text,
  accepted_answer_id  uuid,
  created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doubts_status_created ON doubts (status, created_at DESC);

CREATE TABLE IF NOT EXISTS doubt_answers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doubt_id   uuid NOT NULL REFERENCES doubts(id) ON DELETE CASCADE,
  user_id    uuid,
  body       text NOT NULL,
  is_aquin   boolean DEFAULT false,
  upvotes    integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doubt_answers_doubt ON doubt_answers (doubt_id);

-- One vote per person per answer, enforced by the primary key rather than by the page.
CREATE TABLE IF NOT EXISTS doubt_answer_votes (
  answer_id  uuid NOT NULL REFERENCES doubt_answers(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (answer_id, user_id)
);

-- --------------------------------------------------------------------------------------------
-- LIBRARY — src/pages/portal/library.astro, plus the inter-library request endpoint
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS library_resources (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  isbn             VARCHAR(40),
  kind             VARCHAR(20) DEFAULT 'book',
  title            TEXT,
  authors          TEXT,
  publisher        TEXT,
  year             INT,
  subject          VARCHAR(120),
  language         VARCHAR(40) DEFAULT 'en',
  cover_url        TEXT,
  location_code    VARCHAR(40),
  total_copies     INT DEFAULT 1,
  available_copies INT DEFAULT 1,
  is_digital       BOOLEAN DEFAULT false,
  digital_url      TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS library_loans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id      UUID,
  user_id          UUID,
  loaned_at        TIMESTAMPTZ DEFAULT NOW(),
  due_at           TIMESTAMPTZ,
  returned_at      TIMESTAMPTZ,
  status           VARCHAR(20) DEFAULT 'active',
  fine_amount_paise INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS library_reservations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID,
  user_id     UUID,
  reserved_at TIMESTAMPTZ DEFAULT NOW(),
  notified_at TIMESTAMPTZ,
  status      VARCHAR(20) DEFAULT 'pending'
);

-- library_ill_requests IS NOT HERE. db/aquintutor-campus-schema.sql owns it, and owning it twice is
-- how two files drift into two different tables. Run that file too — see the note at the bottom.

-- --------------------------------------------------------------------------------------------
-- STUDY TOOLS — flashcards, notes, the resume builder. src/pages/portal/*.astro
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flashcard_decks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID,
  title      TEXT,
  subject    VARCHAR(120),
  card_count INT DEFAULT 0,
  is_public  BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spaced repetition state lives on the card. Without this table a learner's whole review history
-- has nowhere to go, which is why the deck page shows nothing rather than an error.
CREATE TABLE IF NOT EXISTS flashcards (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id          UUID,
  front            TEXT,
  back             TEXT,
  hint             TEXT,
  ease_factor      DECIMAL(4,2) DEFAULT 2.5,
  interval_days    INT DEFAULT 1,
  due_date         DATE,
  repetition_count INT DEFAULT 0,
  last_reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID,
  title         TEXT,
  body          TEXT,
  visibility    VARCHAR(20) DEFAULT 'private',
  share_token   VARCHAR(80) UNIQUE,
  course_id     UUID,
  lesson_id     UUID,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS note_collaborators (
  note_id    UUID,
  user_id    UUID,
  permission VARCHAR(20) DEFAULT 'edit',
  PRIMARY KEY (note_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_resumes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID UNIQUE,
  template       VARCHAR(40) DEFAULT 'classic',
  headline       TEXT,
  summary        TEXT,
  contact_info   JSONB DEFAULT '{}'::jsonb,
  education      JSONB DEFAULT '[]'::jsonb,
  experience     JSONB DEFAULT '[]'::jsonb,
  projects       JSONB DEFAULT '[]'::jsonb,
  skills         JSONB DEFAULT '[]'::jsonb,
  certifications JSONB DEFAULT '[]'::jsonb,
  publications   JSONB DEFAULT '[]'::jsonb,
  awards         JSONB DEFAULT '[]'::jsonb,
  languages      JSONB DEFAULT '[]'::jsonb,
  pdf_url        TEXT,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- practice_problems is likewise owned by db/aquintutor-campus-schema.sql.

-- --------------------------------------------------------------------------------------------
-- GUARDIAN ACCESS — src/pages/portal/parent.astro
--
-- This table is what decides whether one account may see another person's progress, so its absence
-- is not a missing feature: it is an access-control record with nowhere to live. The UNIQUE pair is
-- the whole point — one link per (parent, child), asserted once.
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_child_links (
  id             BIGSERIAL PRIMARY KEY,
  parent_user_id UUID NOT NULL,
  child_user_id  UUID NOT NULL,
  relationship   TEXT NOT NULL DEFAULT 'parent',
  is_primary     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (parent_user_id, child_user_id)
);

CREATE INDEX IF NOT EXISTS idx_parent_child_links_parent ON parent_child_links (parent_user_id);
CREATE INDEX IF NOT EXISTS idx_parent_child_links_child  ON parent_child_links (child_user_id);

-- --------------------------------------------------------------------------------------------
-- ACCOUNT RECOVERY — src/pages/api/auth/verify-by-questions.ts
--
-- THE MOST CONSEQUENTIAL TABLE IN THIS FILE. It holds the half-finished recovery challenge: the
-- hashed token, which questions were asked, when it expires and whether it was already used. With
-- no table, recovery-by-questions cannot issue a challenge at all, so a locked-out person cannot be
-- let back in by the path built for exactly that. `consumed_at` is what stops one challenge being
-- replayed; it is not optional.
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_recovery_challenge (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  user_id      uuid NOT NULL,
  purpose      text NOT NULL,
  question_ids jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS auth_recovery_challenge_expiry_idx ON auth_recovery_challenge (expires_at);

-- --------------------------------------------------------------------------------------------
-- HIRING REMINDERS — src/pages/api/hiring/task-reminders.ts
--
-- The UNIQUE(application_id, kind) is the idempotency: it is what stops a candidate being emailed
-- the same reminder every time the job runs. Without the table the endpoint has no memory of what
-- it has already sent.
-- --------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_reminder_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL,
  kind           VARCHAR(10) NOT NULL,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, kind)
);

-- --------------------------------------------------------------------------------------------
-- PUBLIC INTAKE FORMS — three pages that accept a submission from a visitor and, today, drop it.
-- src/pages/aquintutor/careerflow/placement.astro, /incubation.astro, /products/atlas-proctoring
-- --------------------------------------------------------------------------------------------
-- senior_placement_requests and eir_applications are owned by db/aquintutor-campus-schema.sql and
-- are NOT duplicated here. Both were unreachable for a reason worth knowing: their column was named
-- current_role, which is a RESERVED word in Postgres (the CURRENT_ROLE function), so the statement
-- was a syntax error in the page AND in the schema file, and every run of either died on it. The
-- column is now current_position in both. Nothing had ever been stored, so nothing was migrated.

CREATE TABLE IF NOT EXISTS atlas_partner_leads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company        VARCHAR(200),
  contact        VARCHAR(200),
  email          VARCHAR(200),
  monthly_volume VARCHAR(80),
  use_case       TEXT,
  status         VARCHAR(20) DEFAULT 'open',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================================
-- VERIFY (safe, read-only). Expect fifteen rows.
--
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public'
--      AND table_name IN ('doubts','doubt_answers','doubt_answer_votes','library_resources',
--                         'library_loans','library_reservations','flashcard_decks','flashcards',
--                         'notes','note_collaborators','user_resumes','parent_child_links',
--                         'auth_recovery_challenge','task_reminder_log','atlas_partner_leads')
--    ORDER BY table_name;
--
-- THEN RUN db/aquintutor-campus-schema.sql, which owns library_ill_requests, practice_problems,
-- senior_placement_requests and eir_applications. It has never run to completion: it died at the
-- current_role statement described above, so everything below that line in it may be missing too.
--
-- WHAT IS STILL MISSING AFTER THIS, AND WHY IT IS NOT HERE. About three hundred more tables are
-- CREATEd only inside library modules that no shipped page reaches — the mail platform, both
-- unreconciled recruitment stacks (tal_* and tos_*), horizon, the intelligence and fusion layers.
-- Creating them would be creating schema for features nobody has opened. The right time to write
-- each of those files is when its surface ships, and the list is reproducible in one pass: collect
-- every CREATE TABLE in src/, diff against information_schema, group by owning file.
