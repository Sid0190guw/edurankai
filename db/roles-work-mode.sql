-- db/roles-work-mode.sql
--
-- Corrects the work mode stored on every advertised role.
--
-- THE POLICY: permanent engagements are ON SITE; internships and apprenticeships may be on site or
-- hybrid; nothing is remote. It lives in src/lib/work-mode.ts, and this file is the same rule
-- expressed in SQL.
--
-- YOU DO NOT NORMALLY NEED THIS FILE. The button "Correct work mode on every role" on
-- /admin/roles/diagnose does exactly this, inside the app, with credentials that are already
-- correct. This exists for the case where the site is down or you would rather see the rows first.
--
-- Nothing a candidate sees depends on running it: every rendering surface (careers list, job page,
-- JobPosting structured data, the public jobs feed) resolves the mode from the engagement and
-- rewrites a stale row on the way out. This corrects the stored string itself, which is what
-- exports, the mirrored job board and offer-letter drafts read.
--
-- Run it yourself against the production database. Read-only preview first.

-- The alternation must stay in step with claimsRemote() in src/lib/work-mode.ts. Note
-- 'telecommut[a-z]*' and not a bare 'telecommut': the trailing \y is a word boundary, so
-- 'telecommut' alone matches NOTHING that actually occurs -- 'Telecommute' and
-- 'telecommuting' both continue with a word character where the boundary is required. SQL
-- and TypeScript disagreeing is the one failure this file cannot have: it would leave rows
-- the page rewrites on the way out but the stored value, exports and offer drafts still
-- claim as remote.
-- 1. PREVIEW — the rows that contradict the policy, and what they would become.
SELECT
  slug,
  engagement_type,
  level,
  location AS current_location,
  CASE
    WHEN engagement_type IN ('Internship', 'Apprenticeship') OR level IN ('Intern', 'Apprentice')
      THEN 'On-site / Hybrid — Kolkata, West Bengal, India'
    ELSE 'On-site — Kolkata, West Bengal, India'
  END AS corrected_location
FROM roles
WHERE location ~* '\y(remote|telecommut[a-z]*|work[ -]?from[ -]?home|wfh|anywhere|worldwide)\y'
   OR (
     location ~* '\yhybrid\y'
     AND engagement_type NOT IN ('Internship', 'Apprenticeship')
     AND level NOT IN ('Intern', 'Apprentice')
   )
ORDER BY engagement_type, slug;

-- 2. APPLY — one statement. Only rows that contradict the policy are touched, so a role with a
--    genuine bespoke site ("On-site — your own campus (India)", "On-site, India (exact location
--    disclosed on selection)") keeps the wording it was given.
UPDATE roles
   SET location = CASE
         WHEN engagement_type IN ('Internship', 'Apprenticeship') OR level IN ('Intern', 'Apprentice')
           THEN 'On-site / Hybrid — Kolkata, West Bengal, India'
         ELSE 'On-site — Kolkata, West Bengal, India'
       END,
       updated_at = now()
 WHERE location ~* '\y(remote|telecommut[a-z]*|work[ -]?from[ -]?home|wfh|anywhere|worldwide)\y'
    OR (
      location ~* '\yhybrid\y'
      AND engagement_type NOT IN ('Internship', 'Apprenticeship')
      AND level NOT IN ('Intern', 'Apprentice')
    );

-- 3. VERIFY — must return zero rows.
SELECT count(*) AS still_advertising_remote
FROM roles
WHERE location ~* '\y(remote|telecommut[a-z]*|work[ -]?from[ -]?home|wfh|anywhere|worldwide)\y'
   OR (
     location ~* '\yhybrid\y'
     AND engagement_type NOT IN ('Internship', 'Apprenticeship')
     AND level NOT IN ('Intern', 'Apprentice')
   );
