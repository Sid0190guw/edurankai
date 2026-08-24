-- db/unpaid-internships.sql
--
-- POLICY: every internship and apprenticeship at EduRankAI is unpaid. The single exception is the
-- flagship programme 'llm-engineering-intern'.
--
-- The public site no longer trusts this column to decide paid-vs-unpaid (that decision lives in
-- src/lib/compensation-text.ts and is keyed on the slug), so nothing is broken while these rows
-- stay wrong. This file exists so the stored data stops disagreeing with the policy — /admin/roles,
-- the offer stage and every future export read the raw column.
--
-- RUN IT YOURSELF. Section 1 shows what would change; section 2 changes it. Run them one at a time.
-- A paste into the Supabase SQL editor is ONE implicit transaction, so paste ONE section per run —
-- or use:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/unpaid-internships.sql

-- ---------------------------------------------------------------------------------------------
-- 1. PREVIEW — every trainee row that currently stores something other than the unpaid line.
-- ---------------------------------------------------------------------------------------------
SELECT slug, title, level, engagement_type, salary
FROM roles
WHERE slug <> 'llm-engineering-intern'
  AND (
        level::text IN ('Intern', 'Apprentice')
     OR engagement_type::text IN ('Internship', 'Apprenticeship')
     OR title ~* '\y(intern|interns|internship|internships|apprentice|apprenticeship)\y'
     OR slug  ~* '\y(intern|interns|internship|internships|apprentice|apprenticeship)\y'
  )
  AND salary NOT ILIKE 'Unpaid%'
ORDER BY level, slug;

-- ---------------------------------------------------------------------------------------------
-- 2. CORRECT — same predicate, one UPDATE. Idempotent: re-running it changes nothing.
--    The em dash below is the one used everywhere else in the catalogs; keep it.
-- ---------------------------------------------------------------------------------------------
UPDATE roles
SET salary = 'Unpaid — internship certificate, mentorship, and real project experience'
WHERE slug <> 'llm-engineering-intern'
  AND (
        level::text IN ('Intern', 'Apprentice')
     OR engagement_type::text IN ('Internship', 'Apprenticeship')
     OR title ~* '\y(intern|interns|internship|internships|apprentice|apprenticeship)\y'
     OR slug  ~* '\y(intern|interns|internship|internships|apprentice|apprenticeship)\y'
  )
  AND salary NOT ILIKE 'Unpaid%';

-- ---------------------------------------------------------------------------------------------
-- 3. VERIFY — expect exactly one row, the flagship programme.
-- ---------------------------------------------------------------------------------------------
SELECT slug, salary
FROM roles
WHERE (level::text IN ('Intern', 'Apprentice') OR engagement_type::text IN ('Internship', 'Apprenticeship'))
  AND salary NOT ILIKE 'Unpaid%';
