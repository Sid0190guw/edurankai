-- db/career-intel-schema.sql
--
-- RUN THIS BY HAND AGAINST PRODUCTION. Nothing in the application will create these tables there.
--
-- =================================================================================================
-- WHY THIS FILE EXISTS AT ALL
-- =================================================================================================
--
-- Schema bootstrap is OFF in production by default (src/lib/ensure-once.ts, and the DDL guard on
-- db.execute). A table whose only creator is an ensure*() therefore does not exist on the live
-- site, and this project has already been bitten by that twice: /aquintutor/search told students
-- the catalogue was empty, and clock-out failed inside a transaction on a missing trail table.
-- So the two tables Career Intelligence owns are written down here, run by hand, and registered in
-- BOOTSTRAP_MODULES so /api/health says out loud whether they are present.
--
-- BOTH ARE OPTIONAL TO THE FEATURE, AND THAT IS DELIBERATE.
--
-- Career Intelligence works for an anonymous visitor with NEITHER table present. The personalisation
-- lives in the visitor's own browser and is posted to the ranking endpoint per request; nothing
-- about an anonymous person is written to this database. These tables exist for the two things that
-- genuinely need storage:
--
--   career_profiles         a SIGNED-IN person who explicitly asked us to keep their personalisation
--   career_feedback_events  explicit "not for me" / "save this" signals, used to improve which
--                           postings are recommended
--
-- If you never run this file, the careers experience still works end to end. The Save control
-- reports that saving is unavailable, which is the honest failure, rather than reporting success.
--
-- =================================================================================================
-- WHAT IS NOT STORED HERE, ON PURPOSE
-- =================================================================================================
--
-- No passive tracking. There is no "role viewed" row: a view is already counted on roles.view_count
-- and does not need a second, per-person copy. No free-text reasons on feedback — the reason is one
-- of a fixed vocabulary, so a dismissal cannot become a place where somebody types something
-- personal about themselves into an analytics table.
--
-- No astrology, ever. The reflection layer is part of the profile document a person keeps in their
-- own browser; it is stored ONLY if they save their profile, it is flagged excludedFromMatching in
-- the document itself, and no query in this application joins it to anything.
--
-- Safe to re-run.

-- -------------------------------------------------------------------------------------------------
-- career_profiles — one row per signed-in person who asked us to keep their personalisation.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_profiles (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- The whole profile document: raw responses, interpreted dimensions, confirmations, context
  -- dependencies. ONE JSONB COLUMN, NOT A COLUMN PER PREFERENCE — section 26 of the brief, and the
  -- practical reason behind it: a preference vocabulary that needs a migration to grow is a
  -- vocabulary that stops growing. Validation happens in parseProfile() before this is ever read
  -- back, which is where an untrusted document becomes a typed one.
  profile         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Which interpreter produced the readings in there, and which document shape it is. Both are
  -- needed to re-read stored raw responses with a better interpreter later without guessing.
  model_version   TEXT NOT NULL DEFAULT '',
  profile_version INTEGER NOT NULL DEFAULT 1,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------------------------------------------------
-- career_feedback_events — explicit signals about a recommendation, never about a person.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_feedback_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  role_id      UUID REFERENCES roles(id) ON DELETE CASCADE,

  -- saved | dismissed | not_interested | opened | helpful | not_helpful
  event        TEXT NOT NULL,

  -- Which tier the posting was in when the person reacted. This is what makes the data useful:
  -- "dismissed from Strong alignment" says something about the ranking; "dismissed" alone does not.
  tier         TEXT,

  -- One of a FIXED vocabulary (see src/lib/career-intel/store.ts). Never free text.
  reason       TEXT,

  -- An opaque key the browser generates. NOT an account, NOT an IP, NOT a fingerprint, and never
  -- joined to a user. It exists so a hundred reactions from one session are not read as a hundred
  -- people agreeing. A person clearing their personalisation gets a new one.
  session_key  TEXT
);

CREATE INDEX IF NOT EXISTS career_feedback_role_idx  ON career_feedback_events (role_id);
CREATE INDEX IF NOT EXISTS career_feedback_at_idx    ON career_feedback_events (at DESC);
CREATE INDEX IF NOT EXISTS career_feedback_event_idx ON career_feedback_events (event);

-- A dismissal is a signal about the RECOMMENDATION, not a record of a person's judgement to be kept
-- for ever. Nothing in the application reads a row older than ninety days; run this whenever you
-- like, or leave it — the queries are already bounded by date.
--   DELETE FROM career_feedback_events WHERE at < NOW() - INTERVAL '180 days';
