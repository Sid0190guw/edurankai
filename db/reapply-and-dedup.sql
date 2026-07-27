-- db/reapply-and-dedup.sql — DB-level backstop for duplicate applications.
--
-- The app now enforces "no active duplicate + 6-month cooling" (src/lib/reapply-eligibility.ts),
-- but a unique INDEX is the only thing that also closes the concurrent-submit RACE (two requests
-- that both pass the app-level check and both insert). Run this AFTER resolving existing duplicates.
--
-- Apply with:  node scripts/apply-sql.mjs db/reapply-and-dedup.sql --env-file .env.production --dry-run
--         then without --dry-run once the target host shows Supabase and step 1 returns no rows.

-- ---------------------------------------------------------------------------
-- STEP 1 — FIND existing duplicate ACTIVE applications (same user + role, more than one live row).
-- The unique index below will FAIL to create while any of these exist. Resolve them first
-- (archive/withdraw the extras in /admin/applications) — this query only READS, it changes nothing.
-- ---------------------------------------------------------------------------
SELECT applicant_user_id, role_id, COUNT(*) AS live_apps,
       array_agg(id::text ORDER BY created_at) AS application_ids,
       array_agg(status ORDER BY created_at)   AS statuses
FROM applications
WHERE applicant_user_id IS NOT NULL
  AND role_id IS NOT NULL
  AND status NOT IN ('withdrawn', 'rejected', 'declined')
GROUP BY applicant_user_id, role_id
HAVING COUNT(*) > 1;

-- ---------------------------------------------------------------------------
-- STEP 2 — the backstop. At most ONE live application per (user, role). Re-application is still
-- allowed once the prior one is withdrawn/rejected/declined (the 6-month cooling is enforced in
-- app code, since a time-window rule cannot be a plain unique index). Idempotent.
-- If this errors with "could not create unique index ... duplicate key", STEP 1 still returns rows —
-- resolve them and re-run. It is safe to re-run the whole file.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS applications_one_live_per_user_role
  ON applications (applicant_user_id, role_id)
  WHERE applicant_user_id IS NOT NULL
    AND role_id IS NOT NULL
    AND status NOT IN ('withdrawn', 'rejected', 'declined');
