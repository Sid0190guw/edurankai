-- db/xscale-schema.paste-2-indexes.sql
-- ================================================================================================
-- PASTE 2 OF 2 — THE INDEXES. RUN THIS IN A QUIET WINDOW.
-- ================================================================================================
--
-- RUN db/xscale-schema.paste-1-tables.sql FIRST and read its two verification queries. Every index
-- below names a column that paste 1 creates; on a database where paste 1 did not land, all six fail.
--
-- WHY THESE ARE NOT `CONCURRENTLY`, AND WHAT THAT COSTS YOU.
--
-- The original db/xscale-schema.sql builds them CONCURRENTLY, which takes no write lock — but
-- CONCURRENTLY cannot run inside a transaction block, and a web SQL console wraps whatever you paste
-- in exactly one. So the choice is a plain build or no index at all, and these are plain.
--
-- A plain CREATE INDEX takes a SHARE lock on `roles` for the duration of the build. Reads continue;
-- WRITES BLOCK. Nobody can submit an application and no admin can save a role while each one runs.
-- On a table of roughly a thousand rows that is well under a second per index, so the practical cost
-- is a blink — but run it when the site is quiet rather than mid-morning, and run it as ONE paste so
-- the whole thing is over in one go.
--
-- IF YOU LATER GET psql. The original file is still the better route and is safe to run afterwards:
-- every statement here is IF NOT EXISTS, so it will simply skip what this already built.
--
-- Idempotent. Running it twice changes nothing.

-- ── The five filter indexes ─────────────────────────────────────────────────────────────────────
--
-- roles_scale_idx is composite on (scale_min_exp, scale_max_exp) because the scale-band filter tests
-- both in one predicate: `scale_min_exp <= band_hi AND scale_max_exp >= band_lo`.

CREATE INDEX IF NOT EXISTS roles_division_idx       ON roles (division_id);
CREATE INDEX IF NOT EXISTS roles_classification_idx ON roles (research_classification);
CREATE INDEX IF NOT EXISTS roles_job_status_idx     ON roles (job_status);
CREATE INDEX IF NOT EXISTS roles_scale_idx          ON roles (scale_min_exp, scale_max_exp);
CREATE INDEX IF NOT EXISTS roles_skillcat_gin       ON roles USING GIN (skill_categories);

-- ── The listing index ───────────────────────────────────────────────────────────────────────────
--
-- The public listing query filters on the visibility rule and orders by is_featured DESC,
-- sort_order ASC, created_at DESC. This serves that ordering for the common case.

CREATE INDEX IF NOT EXISTS roles_public_listing_idx
  ON roles (is_open, job_status, is_featured DESC, sort_order ASC, created_at DESC);

-- ── VERIFICATION ────────────────────────────────────────────────────────────────────────────────

-- All six exist.
SELECT indexname
  FROM pg_indexes
 WHERE tablename = 'roles'
   AND indexname IN ('roles_division_idx','roles_classification_idx','roles_job_status_idx',
                     'roles_scale_idx','roles_skillcat_gin','roles_public_listing_idx')
 ORDER BY indexname;
-- EXPECT six rows.

-- None landed INVALID. (A plain build should not, but the original file's CONCURRENTLY route can,
-- and an invalid index is not used by the planner and is NOT repaired by re-running — DROP it and
-- create it again.)
SELECT c.relname AS invalid_index
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE NOT i.indisvalid
   AND (c.relname LIKE 'roles_%' OR c.relname LIKE 'divisions_%');
-- EXPECT no rows.

-- ── NEXT, AND THIS IS WHERE THE NANO POSTINGS ACTUALLY APPEAR ───────────────────────────────────
--
-- The schema is only the shape. Nothing is visible on the careers site yet, and that is correct:
--
--   1. /admin/roles/divisions -> "Import"
--        Creates the department row (it is NOT in CATALOG_DEPARTMENTS — this button is its only
--        creator), the 15 divisions, and the 179 postings. Time-boxed against the function ceiling
--        and fully idempotent: keep clicking until it reports nothing remaining.
--
--   2. /admin/roles/divisions -> "Publish division", on Nano Engineering & Nanotechnology
--        The import inserts every posting as is_open=false, job_status='DRAFT' BY DESIGN — an import
--        must not publish anything. Publishing sets job_status='PUBLISHED' and is_open=true in one
--        statement, and only then do those 15 nano postings appear on /careers.
--
-- That page reports which tables and columns are still missing, on screen. If it still names any
-- after both pastes, the migration did not land on the database the site actually reads.
