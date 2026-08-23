-- db/hiring-decision-schema.sql
-- PATCH 10 — HUMAN HIRING DECISION SUPPORT. One table: the recorded final human decision.
--
-- SAFE TO RUN ON PRODUCTION. Every statement is CREATE TABLE IF NOT EXISTS or CREATE INDEX
-- IF NOT EXISTS. It creates nothing that exists, drops nothing, and rewrites no row.
--
-- RUN IT YOURSELF. This repository's convention is that migrations are handed to the user and run by
-- them; nothing in the build opens a production connection. The application also self-bootstraps
-- this table through ensureHiringDecisionSchema() on first use, so running this file is the way to
-- create it deliberately and out of the request path rather than the only way to create it.
--
-- WHAT THIS TABLE IS, AND WHAT IT IS NOT
-- ---------------------------------------------------------------------------------------------
-- It records that a NAMED PERSON decided something about an application, when, why, and what
-- evidence they were looking at. It is not a score, not a recommendation, and not a pipeline stage.
--
--   decided_by_user_id IS NOT NULL. That is the structural half of "no automated intelligence score
--   may independently make a hiring decision" — there is no way to write a decision into this table
--   without an account attached to it.
--
--   reasoning IS NOT NULL. A recorded decision with no reason is an opaque decision with a
--   timestamp on it.
--
--   support_state is NULLABLE and is what the support report SHOWED at the time. It is kept beside
--   the decision so a later reader can see what the deciding person was looking at. It is never the
--   decision, and no code path converts one into the other.
--
-- APPEND-ONLY. src/lib/hiring-decision.ts INSERTs and never UPDATEs decision, reasoning,
-- decided_by_user_id or decided_at, and never DELETEs. A later decision stamps the previous row's
-- superseded_at and inserts a new one, so the history is the table.
--
-- TABLES THIS DOES NOT DUPLICATE, ALL CHECKED BEFORE IT WAS WRITTEN:
--   hr_match_decisions       — a judgement about an advisory coverage view. Moves no stage.
--   match_evaluations        — a stored capability reading plus agreed/disagreed/set_aside.
--   application_stage_events — the funnel's own actor history (src/lib/application-stages.ts).
--   manual_interviews        — one interview's outcome, per interview, not per application.
--   tal_* / tos_*            — the two unreconciled recruitment stacks. This table builds on
--                              neither and is keyed on applications.id, so it survives either.

CREATE TABLE IF NOT EXISTS hiring_decisions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHAT IT IS ABOUT. Keyed on applications.id, the one identifier both recruitment stacks agree on.
  -- No FOREIGN KEY, matching this project's convention for self-bootstrapping tables: the bootstrap
  -- runs over a transaction pooler that cannot be relied on for ordering, and a decision must not
  -- vanish because somebody archived an application row.
  application_id      UUID NOT NULL,
  role_id             UUID,

  -- WHAT THE REPORT SHOWED. Advisory, historical, never acted on by itself.
  support_state       VARCHAR(40),
  support_because     JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- THE HUMAN DECISION: hire | reject | hold | next_stage.
  decision            VARCHAR(20) NOT NULL,
  decided_by_user_id  UUID NOT NULL,
  decided_by_name     VARCHAR(200),
  decided_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reasoning           TEXT NOT NULL,

  -- THE EVIDENCE THEY WERE SHOWN, frozen. The report is re-derivable; what a person saw is not.
  evidence_refs       JSONB NOT NULL DEFAULT '[]'::jsonb,
  report_snapshot     JSONB,

  -- WHAT THE CANDIDATE IS TOLD. Screened before it is stored: no protected attribute, no refused
  -- subject, no birth-derived term, and nothing that fails the HORIZON language guard.
  candidate_feedback  TEXT,

  -- WHAT THE FUNNEL DID ABOUT IT. Written by this table's owner AFTER asking
  -- src/lib/application-stages.ts to move; that module owns applications.stage and its history.
  stage_moved_to      VARCHAR(40),
  stage_note          TEXT,

  -- SUPERSESSION RATHER THAN EDITING.
  superseded_at       TIMESTAMPTZ,
  superseded_by_id    UUID,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every decision on one application, newest first. The history read.
CREATE INDEX IF NOT EXISTS hiring_decisions_app_idx
  ON hiring_decisions (application_id, decided_at DESC);

-- The decision that stands. Partial, because that is the row almost every read wants.
CREATE INDEX IF NOT EXISTS hiring_decisions_current_idx
  ON hiring_decisions (application_id) WHERE superseded_at IS NULL;

-- "What has this person decided" — the accountability read, which is the point of a named actor.
CREATE INDEX IF NOT EXISTS hiring_decisions_actor_idx
  ON hiring_decisions (decided_by_user_id, decided_at DESC);

-- VERIFY (safe, read-only). Run after the statements above.
--
--   SELECT COUNT(*) AS decisions,
--          COUNT(*) FILTER (WHERE superseded_at IS NULL) AS standing,
--          COUNT(DISTINCT application_id) AS applications,
--          COUNT(DISTINCT decided_by_user_id) AS deciders
--     FROM hiring_decisions;
--
-- A row with a NULL decided_by_user_id or a blank reasoning cannot exist. If one ever does, it was
-- not written by src/lib/hiring-decision.ts:
--
--   SELECT id, application_id, decision, decided_at
--     FROM hiring_decisions
--    WHERE decided_by_user_id IS NULL OR COALESCE(TRIM(reasoning), '') = '';
