-- db/aquintutor-share-schema.sql
--
-- The one table behind /aquintutor/shared-progress/<token>: a learner mints a read-only token so a
-- parent or teacher can see verified progress without an account, and can revoke it at any time.
--
-- WHY THIS FILE EXISTS AT ALL.
--
-- Its only creator was ensureShareSchema() in src/lib/aquintutor-share.ts, which runs CREATE TABLE
-- on the request path. Production stopped running request-path DDL on 2026-08-23 and
-- src/lib/db/index.ts now refuses it outright, so on the live database this table was never created
-- and never would be. resolveShare() therefore threw `relation "aq_progress_share" does not exist`
-- for every token, in page frontmatter, with nothing catching it: the page answered 500 to every
-- visitor. Measured 2026-08-24 against three different tokens.
--
-- The page now fails honestly instead of erroring, but honest failure is not the feature. This is
-- what makes the feature exist.
--
-- HOW TO RUN IT.
--
--   psql "$DATABASE_URL" -f db/aquintutor-share-schema.sql
--
-- Use `psql -f`, which commits statement by statement. Pasting a whole file into the SQL editor runs
-- it as ONE implicit transaction, holding every lock together until the end and rolling the whole
-- file back if any statement fails.
--
-- Safe to run more than once: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS aq_progress_share (
  token       TEXT PRIMARY KEY,
  user_id     UUID NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ
);

-- listShares() reads a learner's own tokens newest first; resolveShare() reads by the primary key.
CREATE INDEX IF NOT EXISTS aq_progress_share_user_idx
  ON aq_progress_share (user_id, created_at DESC);
