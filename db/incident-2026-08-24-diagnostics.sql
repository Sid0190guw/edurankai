-- db/incident-2026-08-24-diagnostics.sql
--
-- READ-ONLY DIAGNOSTICS FOR THE 2026-08-24 INCIDENT. RUN THESE YOURSELF.
--
--   psql "$DATABASE_URL" -f db/incident-2026-08-24-diagnostics.sql
--
-- Or paste them one at a time into the Supabase SQL editor, which is easier to read.
--
-- NOTHING HERE WRITES, LOCKS, OR TERMINATES ANYTHING. No pg_terminate_backend, no pg_cancel_backend,
-- no DDL, no SET outside a transaction. Every statement is a SELECT against a catalog or statistics
-- view. It is safe to run during an incident, which is the only time it is useful.
--
-- WHY YOU AND NOT ME. CLAUDE.md forbids me from opening a database connection from this working
-- directory, and the reason is on the record: a previous agent asked to survey source files connected
-- to production instead and read staff gender data out of hr_employees. The established pattern here
-- is that I hand over the command. This is that hand-over.
--
-- Each query is numbered and says WHAT ANSWER WOULD MEAN WHAT, so the output is interpretable without
-- coming back to me.


-- =================================================================================================
-- 1. WHAT IS RUNNING RIGHT NOW
-- =================================================================================================
--
-- Run this FIRST and run it twice, thirty seconds apart. What matters is not a single slow query but
-- whether the SAME query is still there on the second run.
--
-- READING IT:
--   * application_name 'PostgREST' with a long-running SELECT over pg_class / pg_attribute /
--     pg_constraint is the schema-cache introspection. If it is present and older than a few seconds,
--     that is the 57014 statement timeout in the log, caught in the act.
--   * wait_event_type 'Lock' means it is queued behind somebody else -- go to query 2.
--   * state 'idle in transaction' with a long duration is a leaked connection and is worse than a
--     slow query, because it holds a pooler session it will never give back.
--   * A CREATE/ALTER here at all, from the application, means request-time DDL is still reaching the
--     database despite the fix. That should now be impossible outside allowingDdl(); if you see one,
--     the guard is not deployed or SCHEMA_BOOTSTRAP is set to 'on'.

SELECT
  pid,
  usename,
  application_name,
  state,
  wait_event_type,
  wait_event,
  now() - query_start AS duration,
  LEFT(query, 1000)   AS query
FROM pg_stat_activity
WHERE state <> 'idle'
  AND pid <> pg_backend_pid()
ORDER BY query_start ASC;


-- =================================================================================================
-- 2. WHO IS BLOCKING WHOM
-- =================================================================================================
--
-- The 2026-08-23 mechanism, if it is still happening: ALTER TABLE takes ACCESS EXCLUSIVE before it
-- evaluates IF NOT EXISTS, and a PENDING exclusive lock is granted ahead of shared locks requested
-- after it -- so a single no-op ALTER puts every subsequent SELECT on that table in a queue.
--
-- READING IT: an AccessExclusiveLock holder with several AccessShareLock waiters behind it on the
-- same relation is that exact shape. Empty output is good and means locks are not the current
-- problem.

SELECT
  blocked.pid                        AS blocked_pid,
  blocked.usename                    AS blocked_user,
  now() - blocked.query_start        AS blocked_for,
  LEFT(blocked.query, 200)           AS blocked_query,
  blocker.pid                        AS blocker_pid,
  blocker.usename                    AS blocker_user,
  blocker.state                      AS blocker_state,
  now() - blocker.query_start        AS blocker_running_for,
  LEFT(blocker.query, 200)           AS blocker_query
FROM pg_stat_activity blocked
JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS b(pid) ON TRUE
JOIN pg_stat_activity blocker ON blocker.pid = b.pid
WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0
ORDER BY blocked_for DESC;


-- =================================================================================================
-- 3. THE POSTGREST EVENT TRIGGERS -- THE ACTUAL SOURCE OF THE RELOAD STORM
-- =================================================================================================
--
-- This is the query that proves the mechanism, and it is the most important one in this file.
--
-- Nothing in the EduRankAI repository sends a schema-reload notification. Grepping the entire tree,
-- dist/ included, for the NOTIFY, for pg_notify, and for the literal channel name returns nothing,
-- and there is no @supabase/* client in package.json at all -- so the application never speaks to
-- PostgREST. Supabase installs these two event triggers on every project, and THEY send it, on any
-- DDL the application runs.
--
-- READING IT: two enabled rows (pgrst_ddl_watch on ddl_command_end, pgrst_drop_watch on sql_drop) is
-- the normal, expected Supabase configuration. It confirms that every CREATE TABLE / ALTER TABLE /
-- CREATE FUNCTION / CREATE TRIGGER / COMMENT the application executed fired a cache reload. It is
-- NOT something to remove -- PostgREST needs it to stay correct. The fix is to stop sending the DDL,
-- which is what this incident's code change does.

SELECT
  evtname          AS trigger_name,
  evtevent         AS fires_on,
  evtenabled       AS enabled,
  p.proname        AS function_name,
  n.nspname        AS function_schema
FROM pg_event_trigger e
JOIN pg_proc p ON p.oid = e.evtfoid
JOIN pg_namespace n ON n.oid = p.pronamespace
ORDER BY evtname;


-- =================================================================================================
-- 4. HOW BIG THE SCHEMA CACHE ACTUALLY IS
-- =================================================================================================
--
-- The incident report says 500+ relations and 270+ relationships. This measures it, because the cost
-- of a schema-cache reload scales with these numbers, and it is why the introspection query hits the
-- statement timeout on this project and would not on a small one.
--
-- READING IT: if relations is in the high hundreds, a reload is genuinely expensive and the reload
-- STORM is fatal rather than merely wasteful. The number also tells you whether reducing the exposed
-- schema is worth doing -- see the note under query 5.

SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r')                          AS tables,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('v','m'))                   AS views,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f'))       AS relations_total,
  (SELECT count(*) FROM pg_constraint WHERE contype = 'f')                    AS foreign_keys,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public')                                              AS functions_in_public,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)                     AS user_triggers;


-- =================================================================================================
-- 5. THE STATEMENT TIMEOUT THAT IS PRODUCING 57014
-- =================================================================================================
--
-- PostgREST connects as `authenticator`. Supabase sets a per-role statement_timeout, and the schema
-- cache load is a single statement -- so if introspection over the relation count from query 4 takes
-- longer than that timeout, the cache can NEVER load, and PostgREST will retry with 1-2-4-8-16s
-- backoff forever. That is a self-sustaining storm independent of whatever first triggered it.
--
-- READING IT:
--   * If authenticator has a short statement_timeout (a few seconds) and query 4 shows several
--     hundred relations, this is the loop. Two legitimate remedies, in order of preference:
--       (a) STOP THE RELOADS (the code fix) so the cache only has to load once, when it has the
--           database to itself and is far more likely to finish inside the timeout;
--       (b) REDUCE WHAT POSTGREST EXPOSES. The application does not use PostgREST at all -- there is
--           no @supabase/* client -- so the exposed schema list can be narrowed in the project's API
--           settings, which shrinks the introspection query directly. This is the one durable fix and
--           it removes an entire failure mode this application never needed.
--     Raising authenticator's statement_timeout is explicitly NOT on that list; it hides the symptom
--     and lets a single introspection hold resources for longer.
--   * Also read `role_conn_limit`: if PostgREST is fighting the application for connection slots,
--     that is visible here.

SELECT
  r.rolname                                             AS role,
  r.rolconnlimit                                        AS role_conn_limit,
  COALESCE(
    (SELECT s FROM unnest(r.rolconfig) AS s WHERE s LIKE 'statement_timeout=%'),
    '(inherits database/cluster default)'
  )                                                     AS statement_timeout,
  COALESCE(
    (SELECT s FROM unnest(r.rolconfig) AS s WHERE s LIKE 'idle_in_transaction_session_timeout=%'),
    '(inherits default)'
  )                                                     AS idle_in_txn_timeout
FROM pg_roles r
WHERE r.rolname IN ('authenticator', 'postgres', 'anon', 'authenticated', 'service_role',
                    'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin')
ORDER BY r.rolname;

-- The cluster-wide defaults, for comparison with the per-role values above.
SELECT name, setting, unit, source
FROM pg_settings
WHERE name IN ('statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout',
               'max_connections', 'superuser_reserved_connections')
ORDER BY name;


-- =================================================================================================
-- 6. CONNECTION PRESSURE
-- =================================================================================================
--
-- src/lib/db/index.ts runs max:2 per instance with idle_timeout:15. The bound that actually matters
-- is 2 x (however many instances Vercel decides to run), which rises with exactly the concurrency
-- that triggers the problem. This shows how the slots are being spent, and by whom.
--
-- READING IT: a large `idle` count from the application user means instances are holding connections
-- they are not using. A large PostgREST count during a reload storm means PostgREST is competing with
-- the site for slots -- which is how a schema-cache problem becomes a 504 on /admin.
--
-- NOTE: this is the DIRECT Postgres view. It cannot see Supavisor's own client-side slot ceiling,
-- which is configured in Supabase under Database -> Connection pooling. If this query shows plenty of
-- headroom while the application still cannot get a connection, the ceiling is Supavisor's, not
-- Postgres's, and that is the number to raise.

SELECT
  COALESCE(usename, '(none)')          AS db_user,
  COALESCE(application_name, '(none)') AS application_name,
  state,
  count(*)                             AS connections,
  max(now() - state_change)            AS longest_in_this_state
FROM pg_stat_activity
GROUP BY 1, 2, 3
ORDER BY connections DESC;


-- =================================================================================================
-- 7. DID THE MAIL-PLATFORM SCHEMA EVER GET APPLIED
-- =================================================================================================
--
-- This one answers a specific open question in the incident report rather than a general one.
--
-- src/lib/mailplatform/schema.ts is the ONE bootstrap in the codebase that does this properly: it
-- memoises per process AND probes mp_schema_migrations for its SCHEMA_VERSION (currently 2) before
-- doing anything. If that row is present, a cold start costs one indexed read.
--
-- IF IT IS ABSENT, the probe fails on every cold instance and applySchema() runs ~129 DDL statements
-- plus MP_TRIGGERS -- and MP_TRIGGERS contains a DO block that DROPs and re-CREATEs an updated_at
-- trigger on every mp_* table it finds. That is two schema-reload notifications per table, on every
-- cold serverless instance, which on ~47 tables is roughly ninety notifications per instance. Against
-- 274 reloads and 121 pool initialisations in the log, that arithmetic is uncomfortably close.
--
-- READING IT:
--   * a row with version 2  -> this is NOT contributing; the probe short-circuits.
--   * no row, or no table   -> apply db/mail-platform-schema.sql once, by hand, as the operator.
--     That makes the probe succeed and the 129 statements stop being attempted at all.

SELECT to_regclass('public.mp_schema_migrations') IS NOT NULL AS migrations_table_exists;

SELECT version, note, applied_at
FROM mp_schema_migrations
ORDER BY version DESC
LIMIT 10;
-- (If the table does not exist the statement above will error. That error IS the answer; nothing
--  before or after it is affected, because this file runs no transaction.)


-- =================================================================================================
-- 8. WHERE THE EGRESS IS GOING
-- =================================================================================================
--
-- 9.335 GB transferred against a 0.155 GB database is roughly sixty times the whole database, so it
-- is repeated reads, not one large table. This attributes it.
--
-- Requires pg_stat_statements. The first query says whether you have it.
--
-- READING IT: sort by `rows` and by `total_bytes_estimate`, NOT by mean_exec_time. The thing that
-- burns egress is a cheap query returning many rows very often -- a polled endpoint or a dashboard
-- widget -- and it will not appear anywhere near the top of a slowest-queries list.

SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')
       AS pg_stat_statements_installed;

SELECT
  calls,
  rows,
  rows / GREATEST(calls, 1)                     AS rows_per_call,
  ROUND(total_exec_time::numeric / 1000, 1)     AS total_seconds,
  ROUND(mean_exec_time::numeric, 1)             AS mean_ms,
  LEFT(query, 300)                              AS query
FROM pg_stat_statements
ORDER BY rows DESC
LIMIT 40;

-- The same list ordered by how often it is called, which is what identifies a polling loop.
SELECT
  calls,
  rows,
  ROUND(mean_exec_time::numeric, 1) AS mean_ms,
  LEFT(query, 300)                  AS query
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 40;


-- =================================================================================================
-- 9. WHICH TABLES ARE ACTUALLY BEING READ, AND HOW
-- =================================================================================================
--
-- Sequential scans on a large table are both a latency problem and an egress problem: the whole
-- relation is read to answer a query that an index could have answered from a few pages.
--
-- READING IT: a table with a high seq_scan count AND a high n_live_tup is a candidate for an index --
-- but only after query 8 has shown you the actual statement. Do not add indexes from this list alone;
-- indexing every column is explicitly not the fix.

SELECT
  relname                       AS table_name,
  n_live_tup                    AS approx_rows,
  seq_scan,
  seq_tup_read,
  idx_scan,
  CASE WHEN seq_scan > 0 THEN seq_tup_read / seq_scan ELSE 0 END AS avg_rows_per_seq_scan,
  pg_size_pretty(pg_total_relation_size(relid))                  AS total_size
FROM pg_stat_user_tables
WHERE seq_scan > 0
ORDER BY seq_tup_read DESC
LIMIT 30;


-- =================================================================================================
-- 10. WHICH SELF-BOOTSTRAPPING TABLES DO NOT EXIST
-- =================================================================================================
--
-- This is the safety check on the code fix, and it is the one to run BEFORE deploying if you want to
-- be careful.
--
-- The fix refuses request-time DDL. Every table those bootstraps create already exists on production
-- precisely BECAUSE their unguarded DDL had been running on every request -- so suppression removes
-- nothing. But that argument is only as good as the premise, and this is how you check the premise
-- instead of trusting it.
--
-- Add any table you are unsure about to the list. Anything that comes back false is a table whose
-- feature will report "no rows" rather than erroring, and which you should create by applying the
-- matching file in db/ (or by setting SCHEMA_BOOTSTRAP=on for one deploy, confirming
-- /api/health reports missingCount 0, then unsetting it again).
--
-- /api/health already reports this continuously for the modules in BOOTSTRAP_MODULES; this covers the
-- ones that were never on that list, which is the same set the fix affects.

SELECT t.name, to_regclass('public.' || t.name) IS NOT NULL AS exists
FROM (VALUES
  ('edu_error_log'),                -- src/lib/logger.ts, the observability backbone
  ('study_abroad_requests'),        -- src/lib/study-abroad.ts, 37 statements per request
  ('mp_schema_migrations'),         -- src/lib/mailplatform/schema.ts version probe
  ('xp_events'),                    -- src/lib/xp.ts and src/lib/gamification.ts, two shapes
  ('user_xp'),
  ('hr_events'),                    -- src/lib/hr-events.ts append-only log
  ('mti_manager_actions'),          -- src/lib/manager-intelligence/schema.ts
  ('user_face_enrollments'),        -- the face-2FA gate in src/middleware.ts
  ('team_roles'),                   -- src/lib/auth/registry.ts
  ('role_permissions'),
  ('user_role_assignments'),
  ('permission_catalogue'),
  ('audit_log'),
  ('org_relationships'),            -- read by src/lib/day-one.ts on the /admin dashboard
  ('payroll_components'),
  ('hr_holidays'),
  ('training_courses'),
  ('departments'),
  ('hr_employees'),
  ('hr_leave_request'),
  ('applications'),
  ('roles'),
  ('users'),
  ('events'),
  ('hei_institutions')
) AS t(name)
ORDER BY exists, t.name;


-- =================================================================================================
-- 11. IS THE EGRESS OVERAGE THE RELOAD STORM ITSELF?
-- =================================================================================================
--
-- This is the query that tests the leading explanation for 9.335 GB, and it is worth running before
-- anybody spends a day optimising application queries that may not be the problem.
--
-- THE HYPOTHESIS. Supabase counts database egress as bytes leaving the database toward a client, and
-- PostgREST is a client. Loading its schema cache means introspecting every relation, column,
-- constraint and relationship in the exposed schemas -- on this database, 500+ relations and 270+
-- relationships -- and the result set is large. The log shows that happening 274 times, with 121
-- connection-pool initialisations behind it. A few tens of megabytes per introspection multiplied by
-- 274 lands in the same order of magnitude as the overage, and the database is only 0.155 GB, so
-- whatever produced 9.335 GB read something small many times rather than something large once.
--
-- If that is right, then the egress overage and the /admin 504 are the SAME incident seen from two
-- angles, and stopping the reloads fixes both. It also means the application's own queries may be
-- entirely innocent.
--
-- READING IT: look for a query text mentioning pg_class, pg_attribute, pg_namespace, pg_constraint
-- or pg_proc near the top when ordered by `rows`. That is PostgREST introspecting. If its `calls`
-- count is in the hundreds, the hypothesis is confirmed and no application query needs changing yet.
-- If instead the top rows-producers are ordinary application SELECTs, the egress is genuinely the
-- application's and the unbounded-read work in the report is where to spend the time.
--
-- Requires pg_stat_statements (query 8 tells you whether you have it). If the extension was reset or
-- installed recently, `calls` will undercount -- check pg_stat_statements_reset time before
-- concluding anything from a low number.

SELECT
  calls,
  rows,
  rows / GREATEST(calls, 1) AS rows_per_call,
  ROUND(total_exec_time::numeric / 1000, 1) AS total_seconds,
  CASE
    WHEN query ~* 'pg_class|pg_attribute|pg_namespace|pg_constraint|pg_proc|information_schema'
      THEN 'CATALOG / INTROSPECTION'
    ELSE 'application'
  END AS kind,
  LEFT(query, 200) AS query
FROM pg_stat_statements
ORDER BY rows DESC
LIMIT 25;

-- Totals by kind, which is the one-line answer.
SELECT
  CASE
    WHEN query ~* 'pg_class|pg_attribute|pg_namespace|pg_constraint|pg_proc|information_schema'
      THEN 'CATALOG / INTROSPECTION'
    ELSE 'application'
  END AS kind,
  sum(calls) AS calls,
  sum(rows)  AS rows_returned
FROM pg_stat_statements
GROUP BY 1
ORDER BY rows_returned DESC;

-- When were these statistics last reset? A low count means nothing if the answer is "ten minutes ago".
SELECT stats_reset FROM pg_stat_statements_info;
