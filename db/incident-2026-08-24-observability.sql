-- db/incident-2026-08-24-observability.sql
--
-- RUN BY THE OPERATOR, ONCE, BY HAND:
--   psql "$DATABASE_URL" -f db/incident-2026-08-24-observability.sql
--
-- Idempotent and additive. Nothing here drops, renames or retypes anything, so re-running is safe.
--
-- WHY THIS FILE EXISTS
--
-- edu_error_log is the durable error table behind trackError(), /admin/ops and the error grouping in
-- src/lib/observability-health.ts. Its ONLY creator in the codebase was src/lib/logger.ts, in a ctx()
-- helper that ran five DDL statements on the first log write of every serverless instance -- outside
-- ensureOnce(), so the production schema-bootstrap kill switch never covered it, and with no
-- lock_timeout, so a contended ALTER on this table could queue readers behind it.
--
-- The 2026-08-24 incident fix refuses request-time DDL at the db.execute() chokepoint
-- (src/lib/schema-bootstrap.ts). The table itself already exists on production precisely BECAUSE that
-- unguarded DDL had been running -- but its definition lived nowhere an operator could apply, which
-- is the gap this file closes. Without it, the one table the incident response depends on for
-- observability would have no controlled definition at all.
--
-- Keep this in step with ERR_DDL / ERR_DDL_EXTRA in src/lib/logger.ts.

BEGIN;

-- Bounded, so a contended lock gives up instead of queueing every reader behind it. The whole file is
-- three statements against one small table; three seconds is far longer than any of them needs.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS edu_error_log (
  id          bigserial PRIMARY KEY,
  event       text,
  message     text,
  context     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The grouping key, computed at WRITE time by observability-health.errorFingerprint so that 400
-- repeats of one fault collapse with a GROUP BY instead of reading 400 rows into memory.
ALTER TABLE edu_error_log ADD COLUMN IF NOT EXISTS fingerprint text;

-- Quoted: RELEASE is a (non-reserved) Postgres keyword. Legal unquoted, but quoting costs nothing.
ALTER TABLE edu_error_log ADD COLUMN IF NOT EXISTS "release" text;

-- What makes the "last 24h" incident board cheap. Without it every ops page load sequentially scans
-- a table that only ever grows.
CREATE INDEX IF NOT EXISTS edu_error_log_created_idx ON edu_error_log (created_at DESC);
CREATE INDEX IF NOT EXISTS edu_error_log_fp_idx ON edu_error_log (fingerprint);

COMMIT;
