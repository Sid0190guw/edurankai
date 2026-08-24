-- db/search-index-schema.sql
--
-- RUN THIS BY HAND AGAINST PRODUCTION. Nothing in the application will create these tables there.
--
-- =================================================================================================
-- WHY /admin/search SAYS relation "edu_search_index" does not exist
-- =================================================================================================
--
-- Both tables have exactly one creator: ensureSearchSchema() in src/lib/search-index.ts, which
-- issues CREATE TABLE IF NOT EXISTS through db.execute(). Since 2026-08-23 that chokepoint
-- (guardedExecute in src/lib/db/index.ts) REFUSES DDL when schema bootstrap is off, which is the
-- production default, and returns the same empty result postgres-js gives for a real DDL statement.
-- The module shipped 2026-07-19 (commit 2e450670), five weeks BEFORE that chokepoint landed, so for
-- those five weeks the ensure would have created both tables on the first production request that
-- opened a search surface. Evidently no such request happened: /admin/search reported the relation
-- missing on 2026-08-24. Either way the window is now closed — the ensure returns having created
-- nothing, neither table appears in any other db/*.sql file, and the tables do not exist.
--
-- The policy's safety argument — "every caller already tolerates a missing table, so the failure
-- mode is a feature with no rows" — is only half true here:
--
--   edu_search_index
--       /aquintutor/search calls search(), which SELECTs from it. The page caught the error and
--       rendered "Nothing found", so a student searching the catalogue was told the catalogue was
--       empty rather than that the search was broken. /admin/search reports the error honestly,
--       which is how this was found. Reindex now cannot repair it either: reindex() starts with
--       DELETE FROM edu_search_index and fails on the same missing relation.
--
--   edu_search_queries
--       Written best-effort by logQuery() (so nothing breaks), read by /admin/search's Top search
--       queries panel — which is why that panel says "unknown", not "no searches".
--
-- src/lib/assistant/scope.ts also names edu_search_index as the `public_catalogue` scope, so the
-- assistant's public-catalogue reads have been hitting a missing relation as well.
--
-- =================================================================================================
-- HOW TO RUN IT
-- =================================================================================================
--
--   psql "$DATABASE_URL" -f db/search-index-schema.sql
--
-- or paste it into the Supabase SQL editor. Additive and idempotent: every statement is IF NOT
-- EXISTS, nothing is dropped or altered, and running it twice is a no-op. After it succeeds, open
-- /admin/search and press Reindex now to populate the index from published kernel objects.
--
-- IF REINDEX REPORTS AN ERROR ABOUT kernel_objects, THAT IS A DIFFERENT MISSING TABLE, NOT THIS ONE.
-- The index is built from the kernel, and kernel_objects is bootstrap-only in exactly the same way
-- these two were (src/lib/kernel/store.ts is its only creator, and no db/*.sql declares it). Reindex
-- now says so out loud instead of reporting "Indexed 0 objects", which is what it used to do.

-- The index itself. Column-for-column identical to ensureSearchSchema(), so a development database
-- that bootstrapped itself and a production database created from this file are the same shape.
CREATE TABLE IF NOT EXISTS edu_search_index (
  object_id       UUID PRIMARY KEY,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  school          TEXT,
  level           TEXT,
  language        TEXT,
  security_labels TEXT[] NOT NULL DEFAULT '{public}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- search() ends every candidate query with ORDER BY updated_at DESC LIMIT 300, and indexStatus()
-- reads MAX(updated_at). Without this the catalogue is sorted by a sequential scan on every search.
CREATE INDEX IF NOT EXISTS edu_search_index_updated_idx ON edu_search_index (updated_at DESC);

-- The query log. Written best-effort on every student search; read only by /admin/search.
CREATE TABLE IF NOT EXISTS edu_search_queries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query        TEXT NOT NULL,
  user_id      UUID,
  result_count INT NOT NULL DEFAULT 0,
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS edu_search_q_idx ON edu_search_queries (at DESC);

-- Verify, do not trust a green message. This must return two rows.
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' AND table_name IN ('edu_search_index', 'edu_search_queries')
 ORDER BY table_name;
