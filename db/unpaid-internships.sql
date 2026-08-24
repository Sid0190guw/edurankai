-- db/unpaid-internships.sql
--
-- POLICY: every internship and apprenticeship at EduRankAI is unpaid. The single exception is the
-- flagship programme 'llm-engineering-intern'.
--
-- The public site no longer trusts roles.salary to decide paid-vs-unpaid — that decision lives in
-- src/lib/compensation-text.ts and is keyed on the slug — so nothing a candidate sees depends on
-- this file. It exists because /admin/roles, the offer stage and every export read the raw column,
-- and "up to INR 3 LPA + research stipend" sitting on an intern row is a trap for whoever reads it
-- next.
--
-- SAFE BY DEFAULT. Running this file previews and writes NOTHING. The UPDATE is gated behind a psql
-- variable, so the read and the write are the same file but not the same run:
--
--   .\scripts\psql-env.ps1 -f db\unpaid-internships.sql               -- preview only
--   .\scripts\psql-env.ps1 -v apply=1 -f db\unpaid-internships.sql    -- preview, then write
--
-- Use scripts/psql-env.ps1 rather than psql directly. `psql "$DATABASE_URL"` is bash syntax: in
-- PowerShell that argument is DROPPED entirely (verified — psql receives no conninfo at all), libpq
-- falls back to localhost:5432, and the "Connection refused" you get names a host that appears
-- nowhere in a Supabase connection string. The helper also sets PGCLIENTENCODING=UTF8.
--
-- ENCODING. The replacement text below writes its em dash as the Unicode escape U&'...\2014...'
-- rather than as a literal character. A Windows console on codepage 1252 can hand psql mis-decoded
-- bytes — every byte of the UTF-8 sequence E2 80 94 is *defined* in WIN1252, so nothing errors, psql reports
-- success, and the column silently stores mojibake. The escape form is pure ASCII on the wire and
-- cannot be mangled by any client encoding. Do NOT extend U& to the regex literals: \y is not a
-- Unicode escape and U&'\y...' is a syntax error.

\set ON_ERROR_STOP on

-- The U& escapes are only safe while this is on; if it is off the backslashes are consumed and the
-- literal silently becomes something else. Fail loudly rather than write garbage.
DO $$
BEGIN
  IF current_setting('standard_conforming_strings') <> 'on' THEN
    RAISE EXCEPTION 'standard_conforming_strings is off; the U& escapes would be misread. Aborting.';
  END IF;
END $$;

\echo ''
\echo '=== 1. ROWS THAT WILL BE REWRITTEN (their current value, before any change) ======='
\echo ''

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

\echo ''
\echo '=== 2. OF THOSE, THE ONES MATCHED ONLY BY TITLE OR SLUG - read these carefully ===='
\echo '    A genuine internship stored with the wrong level and engagement belongs here and'
\echo '    SHOULD be rewritten. A permanent role that merely has the word in its name - say'
\echo '    "Internship Programme Manager" - should not, and needs its salary restored by hand'
\echo '    afterwards from section 1 output. No such role exists in any catalog today (0 of'
\echo '    ~800 trainee-word titles carry the word anywhere but the end), so expect none.'
\echo ''

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

\if :{?apply}

\echo ''
\echo '=== 3. APPLYING ================================================================='
\echo ''

-- The guard is the "Unpaid" PREFIX, not equality with the line below. That is deliberate: several
-- legitimate unpaid strings are in use and must survive untouched — the Extreme-Scale trainee line
-- (src/data/xscale-catalog.ts:107, on every trainee row of the 179-posting import) and the Campus
-- Ambassador line (src/data/role-catalog.ts:1017) both start with "Unpaid" and say something more
-- specific than this generic wording. An exact-equality guard would flatten both.
--
-- Apprenticeships get their own noun; a single string made an apprenticeship row claim an
-- "internship certificate" while the page rendered the word "apprenticeship" beside it.
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

\echo ''
\echo '=== 4. VERIFY - the dash that actually landed in the column ======================'
\echo '    Do not judge this by eye. With client_encoding=UTF8 and a console still on CP1252'
\echo '    a CORRECT em dash prints as garbage; the codepoint is the truth, not the glyph.'
\echo '    Expect dash_codepoint 8212, and zero rows from the mojibake check.'
\echo ''

SELECT ascii(substr(salary, 8, 1)) AS dash_codepoint, count(*) AS rows
FROM roles
WHERE salary LIKE 'Unpaid %'
GROUP BY 1
ORDER BY 2 DESC;

SELECT slug, salary AS mojibake_row
FROM roles
WHERE salary LIKE '%' || chr(226) || '%'
   OR salary LIKE '%' || chr(194) || '%';

\else

\echo ''
\echo '=== PREVIEW ONLY. Nothing was written. ==========================================='
\echo '    Re-run with -v apply=1 to write:'
\echo '    scripts/psql-env.ps1 -v apply=1 -f db/unpaid-internships.sql'
\echo ''

\endif

\echo ''
\echo '=== 5. THE ONLY TRAINEE ROLE ALLOWED TO CARRY PAY - expect exactly one row ======='
\echo ''

SELECT slug, level::text AS level, engagement_type::text AS engagement, salary
FROM roles
WHERE (level::text IN ('Intern', 'Apprentice') OR engagement_type::text IN ('Internship', 'Apprenticeship'))
  AND salary NOT ILIKE 'Unpaid%'
ORDER BY slug;
