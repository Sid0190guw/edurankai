-- db/unpaid-internships-editor.sql
--
-- The Supabase SQL editor version of db/unpaid-internships.sql. Same policy, same predicate, no
-- psql meta-commands: the \if gate, \echo and \set in that file are psql features and are syntax
-- errors in the web editor.
--
-- PASTE ONE SECTION PER RUN. A paste into the Supabase SQL editor executes as ONE implicit
-- transaction: every statement's locks are held together and any failure rolls the whole paste
-- back. Pasting the file whole would also run the UPDATE before you had read the preview.
--
-- THE PREDICATE BELOW IS BYTE-IDENTICAL TO db/unpaid-internships.sql. If one changes, change both.
-- That file is the source of truth; this one exists only because the editor cannot run it.
--
-- POLICY: every internship and apprenticeship at EduRankAI is unpaid. The single exception is
-- 'llm-engineering-intern'. Nothing a candidate sees depends on this — src/lib/compensation-text.ts
-- already suppresses the stored string — but /admin/roles, the offer stage and every export read
-- this column raw.
--
-- The em dash is written as U&'...\2014...' rather than as a literal character so that no client
-- encoding, browser paste or console codepage can turn it into mojibake on the way in.


-- ============================================================================================
-- SECTION 1 — PREVIEW. Read-only. Run this first and keep the output: it is the only record of
-- what these rows said before section 3 overwrites them.
-- ============================================================================================

SELECT slug, title, level::text AS level, engagement_type::text AS engagement, salary
FROM roles
WHERE slug <> 'llm-engineering-intern'
  AND (
        level::text IN ('Intern', 'Apprentice')
     OR engagement_type::text IN ('Internship', 'Apprenticeship')
     OR title ~* '\y(intern|interns|internship|internships|apprentice|apprenticeship)\y'
     OR slug  ~* '\y(intern|interns|internship|internships|apprentice|apprenticeship)\y'
  )
  AND salary NOT ILIKE 'Unpaid%'
ORDER BY level::text, slug;


-- ============================================================================================
-- SECTION 2 — Of those, the ones matched ONLY by title or slug. Read-only.
--
-- A genuine internship stored with the wrong level and engagement belongs here and SHOULD be
-- rewritten. A permanent role that merely has the word in its name — "Internship Programme
-- Manager" — should not, and would need its salary restored by hand from section 1's output.
-- No such role exists in any catalog today, so expect zero rows.
-- ============================================================================================

SELECT slug, title, level::text AS level, engagement_type::text AS engagement, salary
FROM roles
WHERE slug <> 'llm-engineering-intern'
  AND level::text NOT IN ('Intern', 'Apprentice')
  AND engagement_type::text NOT IN ('Internship', 'Apprenticeship')
  AND (
        title ~* '\y(intern|interns|internship|internships|apprentice|apprenticeship)\y'
     OR slug  ~* '\y(intern|interns|internship|internships|apprentice|apprenticeship)\y'
  )
  AND salary NOT ILIKE 'Unpaid%'
ORDER BY slug;


-- ============================================================================================
-- SECTION 3 — THE WRITE. Run only after reading sections 1 and 2.
--
-- The guard is the "Unpaid" PREFIX, not equality with the line below: several legitimate unpaid
-- strings are in use and must survive untouched — the Extreme-Scale trainee line
-- (src/data/xscale-catalog.ts:107, on every trainee row of the 179-posting import) and the Campus
-- Ambassador line (src/data/role-catalog.ts:1017) both begin "Unpaid" and say something more
-- specific. An exact-equality guard would flatten both.
-- ============================================================================================

UPDATE roles
SET salary = CASE
      WHEN level::text = 'Apprentice' OR engagement_type::text = 'Apprenticeship'
        THEN U&'Unpaid \2014 apprenticeship certificate, mentorship, and real project experience'
      ELSE U&'Unpaid \2014 internship certificate, mentorship, and real project experience'
    END
WHERE slug <> 'llm-engineering-intern'
  AND (
        level::text IN ('Intern', 'Apprentice')
     OR engagement_type::text IN ('Internship', 'Apprenticeship')
     OR title ~* '\y(intern|interns|internship|internships|apprentice|apprenticeship)\y'
     OR slug  ~* '\y(intern|interns|internship|internships|apprentice|apprenticeship)\y'
  )
  AND salary NOT ILIKE 'Unpaid%';


-- ============================================================================================
-- SECTION 4 — VERIFY. Read-only. Run after section 3.
--
-- Judge the dash by its codepoint, not by how it looks: expect 8212 (U+2014) and zero mojibake
-- rows. The second query should return exactly one row, the flagship LLM programme.
-- ============================================================================================

SELECT ascii(substr(salary, 8, 1)) AS dash_codepoint, count(*) AS rows
FROM roles
WHERE salary LIKE 'Unpaid %'
GROUP BY 1
ORDER BY 2 DESC;

SELECT slug, salary AS mojibake_row
FROM roles
WHERE salary LIKE '%' || chr(226) || '%'
   OR salary LIKE '%' || chr(194) || '%';

SELECT slug, level::text AS level, engagement_type::text AS engagement, salary
FROM roles
WHERE (level::text IN ('Intern', 'Apprentice') OR engagement_type::text IN ('Internship', 'Apprenticeship'))
  AND salary NOT ILIKE 'Unpaid%'
ORDER BY slug;
