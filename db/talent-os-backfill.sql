-- ================================================================================================
-- db/talent-os-backfill.sql — GIVE EVERY EXISTING HUMAN A PERSON RECORD
--
-- WHO RUNS THIS: the founder, ONCE, after db/talent-os-schema.sql and before any Talent OS surface
-- is opened to traffic.
--
-- WHO DOES NOT RUN THIS: the agent that wrote it. Nothing in this phase touched the database.
--
-- HOW TO RUN IT (Supabase SQL editor, or psql against the transaction pooler):
--     \i db/talent-os-schema.sql        -- first, if it has not already been run
--     \i db/talent-os-backfill.sql      -- this file
--     \i db/talent-os-validate.sql      -- then, to confirm
--
-- ================================================================================================
-- WHAT THIS DOES, IN ONE SENTENCE.
--
-- Every distinct email address that has ever submitted an application becomes exactly one
-- tos_person, every existing application is linked to it, and anyone who already has an
-- hr_employees row also gets an active primary tos_identity.
--
-- ================================================================================================
-- IT IS IDEMPOTENT AND IT IS SAFE TO RUN TWICE.
--
-- Every INSERT carries a NOT EXISTS guard or an ON CONFLICT DO NOTHING. Running it again after new
-- applications have arrived picks up only the new ones. Running it twice in a row changes nothing
-- the second time. It never UPDATEs a person row that already exists and never deletes anything.
--
-- ================================================================================================
-- THE RESOLUTION RULE IT IMPLEMENTS (docs/talent-os-spec.md section 5.3).
--
-- Matching is on EMAIL, case-insensitively, and on nothing else. Names collide, phone numbers are
-- reused and shared, dates of birth collide constantly at scale. Splitting one human into two
-- person rows is cheap to repair with a merge; fusing two humans into one person row means one
-- stranger can see another's application history, and that is not repairable after the fact.
--
-- So: this backfill deliberately UNDER-merges. If the same human applied from two addresses they
-- get two person rows, and People Operations merges them from the admin surface, which repoints
-- every child row and leaves the loser in place as a pointer.
--
-- ================================================================================================
-- FOUR TRAPS IN THE EXISTING DATA THAT THIS FILE HANDLES EXPLICITLY.
--
--   1. departments.id is varchar(50) SLUG in src/lib/db/schema.ts and UUID in db/hr-schema.sql.
--      Every department reference written here is TEXT and is NEVER cast to ::uuid.
--
--   2. hr_employees.reporting_manager_id holds a users.id, while the org graph's
--      subject_employee_id holds an hr_employees.id. This file writes neither, but any follow-up
--      that does must translate through hr_employees.user_id.
--
--   3. applications.email is NOT unique and is not normalised. lower(btrim(email)) is the key
--      throughout, and the same expression appears in the unique index the schema creates.
--
--   4. Person codes are derived from MAX, never COUNT. COUNT is wrong after any delete and under
--      any concurrency, which is exactly how employee codes once collided and lost hires silently.
--      The numbering below uses a window function over the rows being inserted, offset by the
--      current MAX, so re-running after new applications continues the series rather than
--      restarting it.
-- ================================================================================================


BEGIN;

-- ============================================================================================
-- === STEP 1: one tos_person per distinct application email ===
-- ============================================================================================

-- ROW_NUMBER over the NEW addresses only, offset by whatever the highest existing person number is.
-- Ordering by first_seen keeps the numbering stable and meaningful: person 000001 is the earliest
-- applicant, not whichever row the planner happened to emit first.
WITH existing_max AS (
  SELECT COALESCE(MAX(regexp_replace(person_code, '^ERAI-P-', '')::bigint), 0) AS mx
  FROM tos_person
  WHERE person_code ~ '^ERAI-P-[0-9]+$'
),
candidates AS (
  SELECT
    lower(btrim(a.email))                                   AS email_key,
    min(a.created_at)                                       AS first_seen,
    -- The most recent non-empty name this address used. A person who corrected their spelling on a
    -- later application should carry the corrected spelling.
    (array_agg(btrim(a.first_name || ' ' || a.last_name)
               ORDER BY a.created_at DESC)
     FILTER (WHERE btrim(COALESCE(a.first_name,'') || COALESCE(a.last_name,'')) <> ''))[1] AS display_name,
    (array_agg(a.phone ORDER BY a.created_at DESC) FILTER (WHERE a.phone IS NOT NULL))[1]  AS phone,
    (array_agg(a.applicant_user_id ORDER BY a.created_at DESC)
     FILTER (WHERE a.applicant_user_id IS NOT NULL))[1]     AS user_id
  FROM applications a
  WHERE a.email IS NOT NULL AND btrim(a.email) <> ''
  GROUP BY lower(btrim(a.email))
),
fresh AS (
  SELECT c.*, ROW_NUMBER() OVER (ORDER BY c.first_seen, c.email_key) AS n
  FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1 FROM tos_person_email pe WHERE lower(pe.email) = c.email_key
  )
)
INSERT INTO tos_person (person_code, display_name, primary_email, phone, user_id, created_at)
SELECT
  'ERAI-P-' || lpad((m.mx + f.n)::text, 6, '0'),
  COALESCE(NULLIF(f.display_name, ''), f.email_key),
  f.email_key,
  f.phone,
  -- Only adopt the auth account if no other person row has already claimed it: tos_person_user_idx
  -- is UNIQUE over live rows, and two applications from different addresses can carry the same
  -- applicant_user_id.
  CASE WHEN f.user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tos_person p2
                        WHERE p2.user_id = f.user_id AND p2.merged_into_id IS NULL)
       THEN f.user_id END,
  f.first_seen
FROM fresh f CROSS JOIN existing_max m;


-- ============================================================================================
-- === STEP 2: the address each person was found by, marked verified ===
-- ============================================================================================

-- VERIFIED, deliberately. These addresses were used to submit a real application and, on this
-- project, to receive its correspondence. Marking them unverified would push every existing
-- applicant through an email challenge before they could read their own application history.
--
-- is_official is computed rather than assumed, and it grants NOTHING. It is a display fact.
-- Authorization comes from tos_identity, never from a domain.
INSERT INTO tos_person_email (person_id, email, is_verified, is_official, verified_at, created_at)
SELECT p.id, p.primary_email, TRUE,
       lower(p.primary_email) LIKE '%@edurankai.in',
       p.created_at, p.created_at
FROM tos_person p
WHERE p.merged_into_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM tos_person_email e WHERE lower(e.email) = lower(p.primary_email));


-- ============================================================================================
-- === STEP 3: additional addresses from the auth account, if it differs ===
-- ============================================================================================

-- A person who applied as one address and signed up as another keeps both, so a later sign-in
-- resolves to the SAME person rather than creating a second one.
INSERT INTO tos_person_email (person_id, email, is_verified, is_official, verified_at, created_at)
SELECT p.id, lower(btrim(u.email)), u.email_verified,
       lower(u.email) LIKE '%@edurankai.in',
       CASE WHEN u.email_verified THEN u.created_at END,
       u.created_at
FROM tos_person p
JOIN users u ON u.id = p.user_id
WHERE p.merged_into_id IS NULL
  AND lower(btrim(u.email)) <> lower(p.primary_email)
  AND NOT EXISTS (SELECT 1 FROM tos_person_email e WHERE lower(e.email) = lower(btrim(u.email)));


-- ============================================================================================
-- === STEP 4: link every existing application to its person ===
-- ============================================================================================

-- pathway = 'recruitment' for every historical row, and that is not a guess: direct onboarding did
-- not exist before this system, so no historical application can have taken it.
--
-- applicant_type is derived from whether an hr_employees row existed for that address, which is the
-- only internal-ness signal the historical data actually carries.
INSERT INTO tos_application_link (
  application_id, person_id, opportunity_role_id, pathway, applicant_type, source_slug, created_at
)
SELECT
  a.id,
  p.id,
  a.role_id,
  'recruitment',
  CASE WHEN EXISTS (
    SELECT 1 FROM hr_employees h
    WHERE lower(COALESCE(h.email, '')) = lower(btrim(a.email))
       OR lower(COALESCE(h.work_email, '')) = lower(btrim(a.email))
       OR lower(COALESCE(h.personal_email, '')) = lower(btrim(a.email))
  ) THEN 'internal' ELSE 'external' END,
  a.source,
  a.created_at
FROM applications a
JOIN tos_person_email pe ON lower(pe.email) = lower(btrim(a.email))
JOIN tos_person p ON p.id = pe.person_id
WHERE a.role_id IS NOT NULL          -- a link needs an opportunity; role_id is ON DELETE SET NULL
  AND p.merged_into_id IS NULL
ON CONFLICT (application_id) DO NOTHING;


-- ============================================================================================
-- === STEP 5: an active primary identity for everyone who already has an employee record ===
-- ============================================================================================

-- WHAT THIS DOES NOT DO: create an hr_employees row. It only registers the identity that the
-- employment record already implies. EMPLOYEE and INTERN are the only employment-backed types, and
-- the type is read from hr_employees.employment_type rather than invented.
WITH existing_max AS (
  SELECT
    COALESCE(MAX(CASE WHEN identity_code ~ '^ERAI-EMP-[0-9]+$'
                 THEN regexp_replace(identity_code, '^ERAI-EMP-', '')::bigint END), 0) AS mx_emp,
    COALESCE(MAX(CASE WHEN identity_code ~ '^ERAI-INT-[0-9]+$'
                 THEN regexp_replace(identity_code, '^ERAI-INT-', '')::bigint END), 0) AS mx_int
  FROM tos_identity
),
joined AS (
  SELECT DISTINCT ON (h.id)
    h.id            AS employee_id,
    p.id            AS person_id,
    h.user_id,
    h.work_email,
    h.department_id::text AS department_id,     -- TEXT. Never ::uuid.
    h.employment_type,
    h.joining_date,
    h.exit_date,
    h.employment_status,
    CASE WHEN lower(COALESCE(h.employment_type,'')) LIKE '%intern%'
         THEN 'INTERN' ELSE 'EMPLOYEE' END AS identity_type,
    h.created_at
  FROM hr_employees h
  JOIN tos_person_email pe
    ON lower(pe.email) IN (
         lower(COALESCE(h.email,'')), lower(COALESCE(h.work_email,'')), lower(COALESCE(h.personal_email,''))
       )
  JOIN tos_person p ON p.id = pe.person_id AND p.merged_into_id IS NULL
  WHERE NOT EXISTS (SELECT 1 FROM tos_identity i WHERE i.employee_id = h.id)
  ORDER BY h.id, pe.is_verified DESC, pe.created_at ASC
),
-- ONE PRIMARY PER PERSON. tos_identity_one_primary is a UNIQUE partial index, so a person with two
-- employment records would abort the whole backfill. The earliest joining date wins the primary
-- slot; any second record is inserted non-primary and left for People Operations to date correctly.
ranked AS (
  SELECT j.*,
         ROW_NUMBER() OVER (PARTITION BY j.person_id
                            ORDER BY j.joining_date NULLS LAST, j.created_at) AS person_rank,
         ROW_NUMBER() OVER (PARTITION BY j.identity_type
                            ORDER BY j.joining_date NULLS LAST, j.created_at) AS type_seq
  FROM joined j
)
INSERT INTO tos_identity (
  person_id, identity_code, identity_type, status, is_primary, employee_id, user_id,
  official_email, department_id, engagement_type, started_on, ended_on, created_at
)
SELECT
  r.person_id,
  CASE r.identity_type
    WHEN 'INTERN' THEN 'ERAI-INT-' || lpad((m.mx_int + r.type_seq)::text, 5, '0')
    ELSE               'ERAI-EMP-' || lpad((m.mx_emp + r.type_seq)::text, 5, '0')
  END,
  r.identity_type,
  -- Only a live employment record produces an ACTIVE identity. Anything else is registered but
  -- authorises nothing, which is the whole point of the status column.
  CASE
    WHEN lower(COALESCE(r.employment_status,'')) IN ('active','probation','confirmed') THEN 'active'
    WHEN r.exit_date IS NOT NULL THEN 'terminated'
    ELSE 'suspended'
  END,
  -- IDEMPOTENCY GUARD. tos_identity_one_primary is a UNIQUE partial index, so claiming primary for
  -- a person who already holds an active primary from an earlier run would abort the whole
  -- backfill. Re-running must be a no-op, not a failure.
  (r.person_rank = 1
   AND lower(COALESCE(r.employment_status,'')) IN ('active','probation','confirmed')
   AND NOT EXISTS (SELECT 1 FROM tos_identity ex
                   WHERE ex.person_id = r.person_id AND ex.is_primary AND ex.status = 'active')),
  r.employee_id,
  r.user_id,
  r.work_email,
  r.department_id,
  r.employment_type,
  r.joining_date,
  r.exit_date,
  r.created_at
FROM ranked r CROSS JOIN existing_max m
ON CONFLICT (identity_code) DO NOTHING;


-- ============================================================================================
-- === STEP 6: report ===
-- ============================================================================================

SELECT 'tos_person'           AS table_name, count(*)::text AS rows FROM tos_person
UNION ALL SELECT 'tos_person_email',      count(*)::text FROM tos_person_email
UNION ALL SELECT 'tos_application_link',  count(*)::text FROM tos_application_link
UNION ALL SELECT 'tos_identity',          count(*)::text FROM tos_identity
UNION ALL SELECT '  of which active',     count(*)::text FROM tos_identity WHERE status = 'active'
UNION ALL SELECT '  of which primary',    count(*)::text FROM tos_identity WHERE is_primary
UNION ALL
-- Applications that could NOT be linked, and why. This number should be small and it should be
-- explainable; it is not silently zero.
SELECT 'applications with no role_id (unlinkable)',
       count(*)::text FROM applications WHERE role_id IS NULL
UNION ALL
SELECT 'applications still unlinked',
       count(*)::text FROM applications a
       WHERE a.role_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tos_application_link l WHERE l.application_id = a.id)
UNION ALL
SELECT 'employee records with no matching person',
       count(*)::text FROM hr_employees h
       WHERE NOT EXISTS (SELECT 1 FROM tos_identity i WHERE i.employee_id = h.id);

COMMIT;

-- ================================================================================================
-- AFTER RUNNING THIS, RUN db/talent-os-validate.sql.
--
-- A clean backfill is not the same as a correct one. In particular, expect and then investigate:
--
--   - "employee records with no matching person" above being non-zero. That is an employment record
--     whose address never submitted an application and never signed up, so there is nothing to link
--     it to. Those people need a tos_person created from the admin surface; the backfill will not
--     invent one from an employment record alone, because hr_employees.full_name plus a work
--     address is not evidence about which human this is in the applicant population.
--
--   - Two person rows for one human who applied from two addresses. That is the deliberate
--     under-merge described at the top of this file. Merge from the admin surface, which repoints
--     the child rows and leaves the loser in place as a pointer.
-- ================================================================================================
