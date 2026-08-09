-- db/backfill-xp-ledger.sql
-- ONE-OFF. Moves XP that learners have already earned out of the retired ledger and into the one
-- that survived. Run it once, by hand. It is safe to run again: every statement is idempotent.
--
-- WHY THIS EXISTS
-- ---------------
-- This codebase had two XP ledgers writing to different tables. src/lib/xp.ts (user_xp + xp_events)
-- is the one that survived; src/lib/xp-ledger.ts (edu_xp_ledger) has been deleted. Its rows are NOT
-- test data — they are lesson completions on /aquintutor/lesson/[id] and official assessment passes,
-- and /aquintutor/xp has been showing those totals to the learners who earned them.
--
-- UNTIL YOU RUN THIS, THOSE LEARNERS SEE A SMALLER NUMBER THAN THEY SAW LAST WEEK. Nothing is lost —
-- edu_xp_ledger is untouched and still holds every row — but the pages now read the surviving ledger
-- and will not find that history there. If any learner has XP in edu_xp_ledger, run this before you
-- tell anybody the collapse is done.
--
-- HOW TO RUN IT
-- -------------
--   npx vercel env pull .env.production
--   node scripts/apply-sql.mjs db/backfill-xp-ledger.sql --env-file .env.production --dry-run
--   node scripts/apply-sql.mjs db/backfill-xp-ledger.sql --env-file .env.production
--
-- Check the host in the banner before applying. Read-only first: the SELECT at the bottom of this
-- file tells you how much is waiting to move, so run the dry run, then the file, then compare.
--
-- WHAT IT WILL NOT DO
-- -------------------
--   * It does not delete or modify edu_xp_ledger. That table stays exactly as it is, unread by the
--     application, as the record of where these points came from.
--   * It does not touch xp_period_rollups. Historic XP must not appear in this week's or this
--     month's leaderboard: those are period boards, and back-dating them would rank a learner for
--     work they did in April.
--   * It does not migrate edu_gamer_state. That table is still live: src/lib/xp.ts reads and writes
--     its opt_out column, which is the learner's choice about appearing on leaderboards. Its streak
--     and last_day columns are superseded by user_xp.streak_days and are simply no longer read.

-- 1. The columns and the unique index the surviving ledger needs. The application creates these on
--    its own first run; they are repeated here so this file can be applied to a database that has
--    not served a request yet. Every one is additive.
ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS award_key TEXT;
ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS source_id VARCHAR(140);
ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS xp_amount INT;
ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS delta INTEGER;

-- THE INDEX IS WHAT MAKES THE REST OF THIS FILE RE-RUNNABLE. award_key is UNIQUE and NULLable;
-- Postgres does not treat two NULLs as equal, so every historic row and every repeatable award is
-- unaffected. Create it BEFORE the insert below or the ON CONFLICT has nothing to conflict against
-- and a second run would award everything twice.
CREATE UNIQUE INDEX IF NOT EXISTS xp_events_award_key_uidx ON xp_events (award_key);

-- 2. The move itself, in one statement so the totals can never drift from the events.
--
--    The old ledger's award_key was built as user|action|object, which is byte-for-byte what
--    xpAwardKey() in src/lib/xp.ts builds today. That is deliberate: after this runs, a learner who
--    re-opens a lesson they completed under the old ledger is recognised as having already been paid
--    for it, and is not awarded again.
--
--    Only rows whose user still exists are moved — xp_events has a foreign key to users, and a
--    learner who deleted their account should not be resurrected by a backfill.
--
--    user_xp.total_xp is INCREASED by exactly what was inserted, never recomputed from scratch: XP
--    earned through the surviving ledger is already in that column and must not be double counted or
--    thrown away.
WITH moved AS (
  INSERT INTO xp_events (user_id, source, source_id, delta, xp_amount, reason, award_key, created_at)
  SELECT l.user_id,
         l.action,
         NULLIF(LEFT(l.object_id, 140), ''),
         l.xp,
         l.xp,
         'Earned before the two XP ledgers were merged',
         l.award_key,
         l.at
  FROM edu_xp_ledger l
  WHERE l.xp > 0
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id)
  ON CONFLICT DO NOTHING
  RETURNING user_id, COALESCE(delta, 0) AS delta
), totals AS (
  SELECT user_id, SUM(delta)::int AS add_xp FROM moved GROUP BY user_id
)
INSERT INTO user_xp (user_id, total_xp)
SELECT user_id, add_xp FROM totals
ON CONFLICT (user_id) DO UPDATE
  SET total_xp = user_xp.total_xp + EXCLUDED.total_xp,
      updated_at = NOW();

-- 3. Level follows XP. Same curve as levelFromXp() in src/lib/xp.ts: floor(sqrt(xp/100)) + 1.
--    Applied to everybody, not only the backfilled rows, because it is cheap and it corrects any row
--    whose level drifted from its total for any other reason.
UPDATE user_xp
SET level = GREATEST(1, FLOOR(SQRT(GREATEST(total_xp, 0) / 100.0))::int + 1)
WHERE level IS DISTINCT FROM GREATEST(1, FLOOR(SQRT(GREATEST(total_xp, 0) / 100.0))::int + 1);

-- 4. WHAT IS LEFT. Run this before and after. Before: the number of rows and points still waiting to
--    move. After: it must be 0 rows and 0 points. Anything still listed is a ledger row whose user no
--    longer exists, which is correct to leave behind.
SELECT COUNT(*)::int AS rows_not_moved,
       COALESCE(SUM(l.xp), 0)::int AS points_not_moved
FROM edu_xp_ledger l
WHERE l.xp > 0
  AND NOT EXISTS (SELECT 1 FROM xp_events e WHERE e.award_key = l.award_key);
