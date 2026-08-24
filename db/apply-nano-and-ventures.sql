-- db/apply-nano-and-ventures.sql
-- ================================================================================================
-- ONE PASTE. EVERYTHING THE NANO DEPARTMENT AND THE VENTURE TAGS NEED.
-- ================================================================================================
--
-- Open the Supabase SQL editor, paste this whole file, run it once. No connection string, no CLI,
-- no psql. It replaces all three of these, which are kept for the psql route and for reference:
--
--     db/product-domains-schema.sql
--     db/xscale-schema.paste-1-tables.sql
--     db/xscale-schema.paste-2-indexes.sql
--
-- IT IS ONE TRANSACTION, AND THAT IS FINE HERE. A web SQL console wraps a paste in a single
-- implicit transaction: every lock is held until the last statement and any failure rolls the whole
-- thing back. For a data migration that would be a reason to split it up. This is ~30 short DDL
-- statements against a table of about a thousand rows, all idempotent, and all-or-nothing is
-- actually the behaviour you want — you either have the whole shape or you have what you started
-- with, never half of it.
--
-- NO `CREATE INDEX CONCURRENTLY` ANYWHERE BELOW, deliberately: it is illegal inside a transaction
-- block and would abort the entire paste on the first one. The plain form takes a SHARE lock on
-- `roles` while each index builds — reads continue, WRITES BLOCK. Under a second per index at this
-- table size, but run it when the site is quiet rather than mid-morning.
--
-- Running it twice changes nothing.
--
-- ------------------------------------------------------------------------------------------------
-- AFTER THIS FILE, TWO CLICKS. The schema is only the shape; it publishes nothing.
--
--   1. /admin/roles/divisions -> "Import"
--        Creates the Extreme-Scale, Nano & Fundamental Engineering department, its 15 divisions and
--        179 postings. The department is NOT in CATALOG_DEPARTMENTS — this button is its only
--        creator. Time-boxed against the function ceiling and idempotent: keep clicking until it
--        says nothing remaining.
--
--   2. /admin/roles/divisions -> "Publish division" on Nano Engineering & Nanotechnology
--        The import inserts every posting as is_open=false, job_status='DRAFT' BY DESIGN — an
--        import must not publish anything. Only publishing makes those 15 nano postings public.
--
--   3. (optional) /admin/roles/diagnose -> "Tag roles from the venture mapping"
--        Writes the venture tag onto every role in a department that builds one. The venture pages
--        already resolve roles by department and do not need this; it records the linkage in the
--        database instead of re-deriving it on every render.
-- ------------------------------------------------------------------------------------------------


-- ================================================================================================
-- PART A — THE VENTURE TAG COLUMNS
-- ================================================================================================
--
-- `product`, `products` and `openings` are added at runtime by ensureRoleProductColumn(), which
-- runs through ensureOnce() and is a NO-OP whenever SCHEMA_BOOTSTRAP is off — which it is, in
-- production, deliberately (request-path DDL took the site down on 2026-08-23). Nothing in db/
-- created them either, so on this database they may simply not exist.
--
-- The venture pages do NOT depend on them: they resolve a role's venture from its department and
-- retry without these columns entirely. This makes the linkage a recorded fact rather than an
-- inference, and lets the admin role editor show and edit it.

ALTER TABLE roles ADD COLUMN IF NOT EXISTS product  VARCHAR(80);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS products TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS openings INT;

-- GIN, because the predicate is `products @> ARRAY['visvambhara']::text[]`. That form was chosen
-- over `'visvambhara' = ANY(products)` precisely so this index can serve it.
CREATE INDEX IF NOT EXISTS roles_product_idx  ON roles (product);
CREATE INDEX IF NOT EXISTS roles_products_gin ON roles USING GIN (products);


-- ================================================================================================
-- PART B — THE NANO DEPARTMENT: DIVISIONS
-- ================================================================================================
--
-- `divisions` is the level between a department and its roles, and it exists in exactly two places:
-- this DDL, and ensureXscaleSchema() — which, again, is a no-op in production. Without it the
-- Import button cannot run at all: every division insert awaits that ensure first.

CREATE TABLE IF NOT EXISTS divisions (
  id                      VARCHAR(60) PRIMARY KEY,
  department_id           VARCHAR(50) NOT NULL,
  slug                    VARCHAR(120) NOT NULL,
  name                    VARCHAR(200) NOT NULL,
  code                    VARCHAR(20),
  summary                 TEXT NOT NULL DEFAULT '',
  charter                 TEXT NOT NULL DEFAULT '',
  research_classification VARCHAR(40),
  scale_min_exp           INT,
  scale_max_exp           INT,
  domains                 TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  skill_categories        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  collaborates_with       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  integrity_note          TEXT NOT NULL DEFAULT '',
  sort_order              INT NOT NULL DEFAULT 0,
  is_visible              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The foreign key is added separately and tolerantly. On a database where `departments` is missing
-- or differently typed, a hard failure here would roll back this entire paste — and every reader in
-- src/lib/xscale already tolerates a missing relation.
DO $$
BEGIN
  IF to_regclass('public.departments') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'divisions_department_id_fkey'
     )
  THEN
    ALTER TABLE divisions
      ADD CONSTRAINT divisions_department_id_fkey
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'divisions_department_id_fkey not added: %', SQLERRM;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS divisions_slug_key ON divisions (slug);
CREATE INDEX        IF NOT EXISTS divisions_dept_idx ON divisions (department_id, sort_order);


-- ================================================================================================
-- PART C — THE RESEARCH COLUMNS ON `roles`
-- ================================================================================================
--
-- Additive, nullable, and invisible to every existing query. NOT a second postings table: that
-- would mean a second careers page, a second apply flow, a second admin console and a second set of
-- application rows /admin/applications cannot see. Every reader treats NULL as "not a research
-- posting", so nothing that works today changes behaviour when this runs.

ALTER TABLE roles ADD COLUMN IF NOT EXISTS division_id              VARCHAR(60);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS research_classification  VARCHAR(40);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS scale_min_exp            INT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS scale_max_exp            INT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS skill_categories         TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS career_level             INT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS job_status               VARCHAR(20);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS valid_through            TIMESTAMPTZ;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS preferred_skills         TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS tools                    TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS deliverables             TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS evaluation_criteria      TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS reporting_to             VARCHAR(200);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS collaborates_with        TEXT[];
ALTER TABLE roles ADD COLUMN IF NOT EXISTS application_instructions TEXT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS integrity_note           TEXT;

-- Every reader COALESCEs a NULL job_status to 'PUBLISHED', so the site is correct with or without
-- this. It is here so the admin console shows a status for the whole catalogue rather than a blank
-- column. Only where job_status IS NULL: re-running must never overwrite a status an editor set.
UPDATE roles
   SET job_status = CASE WHEN is_open THEN 'PUBLISHED' ELSE 'CLOSED' END
 WHERE job_status IS NULL;


-- ================================================================================================
-- PART D — THE FILTER INDEXES ON `roles`
-- ================================================================================================
--
-- roles_scale_idx is composite on (scale_min_exp, scale_max_exp) because the scale-band filter tests
-- both in one predicate: `scale_min_exp <= band_hi AND scale_max_exp >= band_lo`.
--
-- roles_public_listing_idx serves the public listing's ordering: filter on the visibility rule, then
-- is_featured DESC, sort_order ASC, created_at DESC.

CREATE INDEX IF NOT EXISTS roles_division_idx       ON roles (division_id);
CREATE INDEX IF NOT EXISTS roles_classification_idx ON roles (research_classification);
CREATE INDEX IF NOT EXISTS roles_job_status_idx     ON roles (job_status);
CREATE INDEX IF NOT EXISTS roles_scale_idx          ON roles (scale_min_exp, scale_max_exp);
CREATE INDEX IF NOT EXISTS roles_skillcat_gin       ON roles USING GIN (skill_categories);
CREATE INDEX IF NOT EXISTS roles_public_listing_idx
  ON roles (is_open, job_status, is_featured DESC, sort_order ASC, created_at DESC);


-- ================================================================================================
-- PART E — VERIFICATION. READ THESE. A GREEN TICK PROVES THE STATEMENTS PARSED, NOT THAT THIS IS
-- THE DATABASE THE SITE READS.
-- ================================================================================================

-- E1. The divisions table exists.
SELECT to_regclass('public.divisions') AS divisions_table;
-- EXPECT: divisions

-- E2. All nineteen columns landed: 3 venture tag columns + 16 research columns.
SELECT COUNT(*)::int AS columns_present
  FROM information_schema.columns
 WHERE table_name = 'roles'
   AND column_name IN ('product','products','openings',
                       'division_id','research_classification','scale_min_exp','scale_max_exp',
                       'skill_categories','career_level','job_status','valid_through',
                       'preferred_skills','tools','deliverables','evaluation_criteria',
                       'reporting_to','collaborates_with','application_instructions',
                       'integrity_note');
-- EXPECT: 19

-- E3. All ten indexes exist.
SELECT COUNT(*)::int AS indexes_present
  FROM pg_indexes
 WHERE (tablename = 'roles' AND indexname IN ('roles_product_idx','roles_products_gin',
        'roles_division_idx','roles_classification_idx','roles_job_status_idx','roles_scale_idx',
        'roles_skillcat_gin','roles_public_listing_idx'))
    OR (tablename = 'divisions' AND indexname IN ('divisions_slug_key','divisions_dept_idx'));
-- EXPECT: 10

-- E4. Nothing landed INVALID.
SELECT c.relname AS invalid_index
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE NOT i.indisvalid
   AND (c.relname LIKE 'roles_%' OR c.relname LIKE 'divisions_%');
-- EXPECT: no rows

-- E5. The nano department, before Import. Zero is the CORRECT answer here — the postings do not
--     exist until you press Import, and they are not public until you press Publish.
SELECT COUNT(*)::int AS xscale_postings
  FROM roles WHERE department_id = 'extreme-scale-engineering';
-- EXPECT: 0 now, 179 after Import.

-- E6. The departments the venture pages resolve roles through. `is_open` alone on purpose: naming
--     job_status here would have failed before Part C ran, and this is an UPPER BOUND — the pages
--     also require job_status='PUBLISHED' and an unexpired deadline, so they may show fewer.
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
-- The department list is checked against PRODUCT_DOMAINS by src/lib/product-domains.test.ts, so it
-- cannot drift from the mapping without failing the build.
