-- db/product-domains-schema.sql
-- ================================================================================================
-- THE THREE COLUMNS THE VENTURE PAGES DEPEND ON, WHICH NO FILE IN db/ HAS EVER CREATED.
-- ================================================================================================
--
-- `roles.product`, `roles.products` and `roles.openings` are added at runtime by
-- ensureRoleProductColumn() in src/lib/role-products.ts. That ensure runs through ensureOnce(),
-- which is a NO-OP whenever SCHEMA_BOOTSTRAP is off — and it is off in production by default and
-- deliberately (see the header of src/lib/ensure-once.ts: request-path DDL took the site down on
-- 2026-08-23). Nothing in db/ creates them either. So on any database that has not happened to run
-- that ALTER while bootstrap was on, the columns simply do not exist, every read of them throws,
-- and the catch renders it as "no roles are open for this venture".
--
-- This file is the applied, hand-run version of that same DDL. It is idempotent: running it twice
-- changes nothing.
--
-- HOW TO RUN IT
--
--   psql "$DATABASE_URL" -f db/product-domains-schema.sql
--
-- A SQL-editor paste (Supabase / any web console) is ONE implicit transaction: every lock is held
-- until the last statement, and any failure rolls the whole file back. That is acceptable here —
-- there are five short statements and no data migration — but psql -f is still preferred, because
-- it commits statement by statement and a partial success stays applied.
--
-- WHAT THIS FILE DOES NOT DO: it does not tag a single role.
--
-- Tagging is deliberately not here. Matching a product row to a venture needs the same
-- token-boundary matcher the application uses (domainForProduct() in src/lib/product-domains.ts —
-- `aquintutor-ai` must resolve to the `aquintutor` mapping, and `hei` must NOT match a slug that
-- merely contains the letters "hei"). Re-implementing that in SQL as a pile of LIKE patterns would
-- be a second, subtly different definition of the same rule, and this repository has already been
-- bitten by two surfaces answering the same question two different ways.
--
-- So the tags are written from inside the application, by an operator, at:
--
--   /admin/roles/diagnose  ->  "Tag roles from the venture mapping"
--
-- which runs backfillProductTagsFromDomains() and therefore uses the one matcher. That page also
-- reports whether the columns below actually exist, so it is the place to check this file landed.
--
-- The venture pages do NOT need the tags to be correct — they resolve a role's venture from its
-- department at read time, and retry without these columns entirely if they are missing. The tags
-- matter for the admin editors, for anything that filters by product, and so that the linkage is a
-- fact recorded in the database rather than only an inference made while rendering.

-- ── 1. The columns ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE roles ADD COLUMN IF NOT EXISTS product  VARCHAR(80);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS products TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS openings INT;

-- ── 2. The indexes ──────────────────────────────────────────────────────────────────────────────
--
-- The GIN index is what makes `products @> ARRAY['visvambhara']::text[]` an index lookup rather
-- than a sequential scan. It is also why the predicate is written with @> instead of
-- `'visvambhara' = ANY(products)`, which cannot use it.

CREATE INDEX IF NOT EXISTS roles_product_idx  ON roles (product);
CREATE INDEX IF NOT EXISTS roles_products_gin ON roles USING GIN (products);

-- ── 3. Verification ─────────────────────────────────────────────────────────────────────────────
--
-- Reported success and observable result are not the same thing. Run these and read them; a green
-- "ALTER TABLE" from the client proves the statement parsed, not that this database is the one the
-- site reads.

-- 3a. All three columns must be present.
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'roles'
   AND column_name IN ('product', 'products', 'openings')
 ORDER BY column_name;
-- EXPECT exactly three rows: openings (integer), product (character varying), products (ARRAY).

-- 3b. Both indexes must be present.
SELECT indexname
  FROM pg_indexes
 WHERE tablename = 'roles'
   AND indexname IN ('roles_product_idx', 'roles_products_gin')
 ORDER BY indexname;
-- EXPECT two rows.

-- 3c. How many open roles are tagged today. Before the admin backfill this is normally 0 or 2 —
--     two catalogue entries in src/data carry a product tag and both name the karate platform.
SELECT COUNT(*) FILTER (WHERE COALESCE(array_length(products, 1), 0) > 0) AS tagged,
       COUNT(*)                                                          AS open_roles
  FROM roles
 WHERE is_open = true;

-- 3d. The departments the venture pages resolve roles through, and how many open roles each has.
--     If a department listed in src/lib/product-domains.ts is missing from this result, that
--     venture's page will be empty no matter what this file did — the postings are closed or were
--     never imported, which is a catalogue problem and not a schema one.
--
--     NOTE ON `is_open = true` HERE. The application gates a public listing on three conditions:
--     is_open, COALESCE(job_status,'PUBLISHED')='PUBLISHED', and an unexpired application_deadline
--     (openPostingClause() in src/lib/product-domains.ts, matching listOpportunities()). This query
--     uses is_open ALONE on purpose, because `job_status` comes from the hand-run
--     db/xscale-schema.sql and may not exist on this database — naming it would make the whole
--     verification block fail with a column error rather than answer the question. So treat the
--     number below as an UPPER BOUND: the page may legitimately show fewer.
SELECT r.department_id, d.name, COUNT(*)::int AS open_roles
  FROM roles r
  LEFT JOIN departments d ON d.id = r.department_id
 WHERE r.is_open = true
   AND r.department_id IN (
     'aerospace-space',
     'martial-arts', 'sports-tech',
     'education-learning',
     'smart-cities', 'geospatial', 'public-sector-impact'
   )
 GROUP BY r.department_id, d.name
 ORDER BY open_roles DESC, r.department_id;
-- The department list above is generated from PRODUCT_DOMAINS and is checked against it by
-- src/lib/product-domains.test.ts, so it cannot drift from the mapping without failing the build.
