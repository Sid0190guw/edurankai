// src/lib/observability-health.ts — health checks, error GROUPING and the ops signals behind
// /api/health, /api/health/deep and /admin/ops.
//
// WHY THIS EXISTS. Two incidents on this project were invisible rather than loud:
//   - a gate refused a request and wrote no error row anywhere, so nothing could be read afterwards;
//   - a hire failed silently for eleven days because the real Postgres reason lived on `e.cause`
//     and was thrown away.
// src/lib/logger.ts already fixed the second (trackError reads e.cause first) and already owns the
// durable table edu_error_log. This module does NOT start a second logging system: it READS what
// logger.ts writes, groups it so 400 repeats of one fault are one row, and adds the surrounding
// signals an operator needs at 2am — database latency, connection-pool pressure, queue depth, cron
// last-run, which self-bootstrapping schemas have actually run, and WHICH COMMIT IS SERVING.
//
// DEPLOYMENT REALITY this is written against (Vercel serverless + Supabase transaction pooler):
//   - no shared in-process cache between invocations, no background timer that survives a response,
//     so nothing here memoises across requests and nothing here schedules anything;
//   - connections are precious. Every function below issues SHORT, individually-awaited statements
//     on the shared pooled client. No BEGIN, no LISTEN, no cursor, no long-lived handle — a health
//     probe that held a connection would be the outage it is meant to detect;
//   - /api/health is meant to be POLLED, so quickHealth() runs exactly two statements and executes
//     NO DDL. The self-bootstrapping CREATE TABLEs stay where they are, in the modules that own them.
//
// The pure half (fingerprinting, status roll-up, cron expectations, the deploy marker) is exported
// separately and tested in observability-health.test.ts with no database.

// ============================================================================================
// PURE — no database, no environment beyond an injectable bag. Tested.
// ============================================================================================

import { ddlPermitted } from '@/lib/schema-bootstrap';

export type Health = 'ok' | 'degraded' | 'down';
export interface Check { name: string; ok: boolean; critical?: boolean; detail?: string }

/**
 * Roll individual checks into one word. A failed CRITICAL check is `down` (the thing is not
 * serving); any other failure is `degraded` (it serves, something is wrong). Pure.
 */
export function overallStatus(checks: Check[]): Health {
  if (checks.some((c) => c.critical && !c.ok)) return 'down';
  if (checks.some((c) => !c.ok)) return 'degraded';
  return 'ok';
}

/**
 * The HTTP code an external monitor sees. Only `down` is 503 — a degraded mail transport must not
 * page somebody at 3am, an unreachable database must. Pure.
 */
export function statusHttpCode(s: Health): number {
  return s === 'down' ? 503 : 200;
}

/**
 * THE GROUPING KEY. The same fault recurring 400 times must be ONE row with a count.
 *
 * Normalises the volatile parts of a message — ids, emails, timestamps, quoted literals, bare
 * numbers — so "duplicate key ... (id)=(41f3…)" and the same failure for a different row collapse
 * together, while two genuinely different faults under one event stay apart. Computed at WRITE time
 * by logger.trackError and stored on the row, so grouping is a plain GROUP BY and never a scan of
 * 400 rows pulled into memory. Pure.
 */
export function errorFingerprint(event: string, message: string): string {
  const norm = String(message == null ? '' : message)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?/g, '<ts>')
    .replace(/0x[0-9a-fA-F]+/g, '<hex>')
    .replace(/"[^"]*"/g, '<str>')
    .replace(/'[^']*'/g, '<str>')
    .replace(/\b\d[\d_.]*\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  const ev = String(event || '').trim() || 'unknown';
  return ev + ' | ' + (norm || '(no message)');
}

/**
 * How often a cron is EXPECTED to run, in hours, from its expression. Deliberately coarse: this
 * deployment is Vercel Hobby, where crons are DAILY ONLY, so the only cases that matter are daily,
 * weekly and monthly. Unparseable falls back to daily rather than throwing. Pure.
 */
export function cronIntervalHours(schedule: string): number {
  const parts = String(schedule || '').trim().split(/\s+/);
  if (parts.length < 5) return 24;
  const hour = parts[1];
  const dom = parts[2];
  const dow = parts[4];
  if (dow !== '*' && dow !== '?') return 168;      // weekly
  if (dom !== '*' && dom !== '?') return 24 * 28;  // monthly-ish
  if (hour === '*' || hour.includes('/')) return 1;
  return 24;
}

/**
 * What to say about a cron. `never` = nothing has ever recorded a run (which is NOT the same as
 * "it failed" — it may simply not call recordCronRun yet, and the ops view says so). `overdue` =
 * a run was recorded but is older than 1.5 intervals, which on a daily cron means it missed a day.
 * Pure.
 */
export function cronRunState(schedule: string, lastRunAt: string | Date | null | undefined, now: number | Date = Date.now()): 'never' | 'ok' | 'overdue' {
  if (!lastRunAt) return 'never';
  const t = new Date(lastRunAt as any).getTime();
  if (!Number.isFinite(t)) return 'never';
  const graceMs = cronIntervalHours(schedule) * 3600 * 1000 * 1.5;
  return Number(now) - t > graceMs ? 'overdue' : 'ok';
}

/** Compact "3m ago" / "2d ago" for the ops table. Pure. */
export function relativeAge(when: string | Date | null | undefined, now: number | Date = Date.now()): string {
  if (!when) return 'never';
  const t = new Date(when as any).getTime();
  if (!Number.isFinite(t)) return 'unknown';
  const s = Math.max(0, Math.round((Number(now) - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

export interface DeployMarker {
  commit: string | null;
  shortCommit: string | null;
  ref: string | null;
  message: string | null;
  environment: string | null;
  region: string | null;
  deploymentId: string | null;
  known: boolean;
}

/**
 * WHICH COMMIT IS SERVING. Read entirely from the variables Vercel already injects — inventing a
 * new one would mean a release marker that is right until somebody forgets to set it, and it would
 * be wrong precisely on the emergency deploy nobody prepared. Locally none of these exist and the
 * marker honestly reports known:false rather than guessing. Pure over an injectable env bag.
 */
export function deployMarker(env: Record<string, string | undefined> = (typeof process !== 'undefined' ? process.env : {}) as any): DeployMarker {
  const pick = (k: string): string | null => {
    const v = env?.[k];
    const s = (v == null ? '' : String(v)).trim();
    return s ? s : null;
  };
  const commit = pick('VERCEL_GIT_COMMIT_SHA');
  return {
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    ref: pick('VERCEL_GIT_COMMIT_REF'),
    message: (pick('VERCEL_GIT_COMMIT_MESSAGE') || '').slice(0, 140) || null,
    environment: pick('VERCEL_ENV'),
    region: pick('VERCEL_REGION'),
    deploymentId: pick('VERCEL_DEPLOYMENT_ID'),
    known: !!commit,
  };
}

/**
 * WHAT AN ANONYMOUS CALLER IS ALLOWED TO BE TOLD ABOUT A DATABASE FAILURE.
 *
 * /api/health is unauthenticated on purpose, and it reported `e.cause.message` verbatim. That string
 * is written by the Postgres driver, not by us, and on the failures that matter it CONTAINS THE
 * CONNECTION CONFIGURATION:
 *
 *   getaddrinfo ENOTFOUND aws-0-ap-south-1.pooler.supabase.com   -> the database hostname
 *   password authentication failed for user "postgres.abcdefgh"  -> the database role
 *   no pg_hba.conf entry for host "10.0.0.7", user "postgres"    -> host and role
 *   connect ECONNREFUSED 10.0.0.7:6543                           -> address and port
 *
 * So the one endpoint the module's own header promises discloses nothing was the endpoint that
 * disclosed the most, and only while the site was down and being looked at by strangers.
 *
 * REDACTING THE WHOLE STRING WOULD BE THE WRONG FIX. INCIDENT.md section 2 has an operator reading
 * this field at minute two, and /api/health/deep cannot substitute for it: that route's gate is
 * `can()`, which resolves the principal FROM THE DATABASE, so during a total database outage the
 * deep endpoint is unreachable by anybody. Replacing the reason with "error" would delete the only
 * diagnosis available in exactly the incident it exists for.
 *
 * So this keeps the DIAGNOSIS and removes the CONFIGURATION: hostnames, addresses, ports, DSNs and
 * quoted identifiers are replaced by placeholders; the failure class ("ENOTFOUND", "ECONNREFUSED",
 * "password authentication failed", "timeout") survives intact. The unredacted message is still
 * written to edu_error_log and still shown on /admin/ops and /api/health/deep, both behind
 * `administer`. Pure — no database, no environment.
 */
export function publicErrorSummary(message: string | null | undefined): string {
  const raw = String(message == null ? '' : message);
  if (!raw.trim()) return 'database unreachable';
  const scrubbed = raw
    // DSNs first: postgres://user:pass@host:6543/db would otherwise be picked apart piecemeal.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<dsn>')
    // IPv6 before IPv4, because the v4 pattern would bite chunks out of a v6 literal.
    .replace(/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi, '<ip>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    // Anything with two or more dot-separated labels is a hostname here.
    .replace(/\b[\w-]+(?:\.[\w-]+)+\b/g, '<host>')
    // Quoted identifiers carry role names, database names and constraint names.
    .replace(/"[^"]*"/g, '<redacted>')
    .replace(/'[^']*'/g, '<redacted>')
    // Whatever is left that could be a port or an internal id.
    .replace(/\b\d{2,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return scrubbed.slice(0, 160) || 'database unreachable';
}

/** The release string stamped onto every error row, so a fault can be tied to a deploy. Pure. */
export function releaseTag(env?: Record<string, string | undefined>): string | null {
  const m = deployMarker(env);
  if (!m.known) return null;
  return (m.environment ? m.environment + ':' : '') + (m.shortCommit || '');
}

/**
 * The crons Vercel is configured to call. Mirrors vercel.json — and the test asserts the two match,
 * so adding a cron there without adding it here fails CI instead of quietly leaving a scheduled job
 * unmonitored. Hobby tier: daily only.
 */
export const CONFIGURED_CRONS: { path: string; schedule: string }[] = [
  { path: '/api/mail/imap-poll', schedule: '0 9 * * *' },
  { path: '/api/mail/scheduled-send', schedule: '0 7 * * *' },
  { path: '/api/payments/reconcile', schedule: '20 5 * * *' },
  { path: '/api/aquintutor/streak-nudge', schedule: '30 14 * * *' },
  { path: '/api/aquintutor/league-settle', schedule: '0 1 * * 1' },
  { path: '/api/hiring/draft-reminders', schedule: '45 4 * * *' },
  { path: '/api/cron/hr-sweep', schedule: '10 4 * * *' },
  { path: '/api/cron/hei-refresh', schedule: '0 3 * * *' },
  { path: '/api/cron/activity-digest', schedule: '0 13 * * *' },
  // Deletes facial data whose purpose has ended. The test that pairs this list against
  // vercel.json caught its absence immediately — which is the point of keeping both.
  { path: '/api/cron/face-retention', schedule: '40 2 * * *' },
  // Deadline reminders for unsubmitted coursework. Idempotent by marker row, so a retry costs
  // nothing; see src/lib/lms/notify.ts sendDueReminders().
  { path: '/api/cron/lms-reminders', schedule: '0 6 * * *' },
  // The mail automation and campaign runners. Present in vercel.json and missing from this list,
  // which is exactly the drift the paired test exists to catch.
  { path: '/api/mail/automation/tick', schedule: '15 6 * * *' },
  { path: '/api/mail/campaign-cron', schedule: '30 7 * * *' },
  // Added to vercel.json by the integrations, governance and webmail workstreams. Registered here
  // because THIS list is what /admin/diagnostics reports as "the scheduled jobs" — a cron missing
  // from it is a job nobody is watching, which is the exact drift the paired test exists to catch.
  { path: '/api/cron/mailint-dispatch', schedule: '45 7 * * *' },
  { path: '/api/mail/gov/worker', schedule: '20 2 * * *' },
  { path: '/api/mail/snooze?action=wake', schedule: '10 2 * * *' },
  // The transactional worker: scheduled sends that have come due, deferred retries, and webhook
  // redelivery. A daily run is all a Hobby plan allows and is enough for the housekeeping only —
  // an ordinary send reaches SMTP inside its own request and never waits for this. Point an
  // external scheduler at it every minute or two for retries to be timely; see
  // docs/mail-transactional-api.md.
  { path: '/api/v1/email/dispatch', schedule: '15 7 * * *' },
  // TWO ENDPOINTS THAT EXISTED, WERE SECRET-GATED, AND WERE SCHEDULED NOWHERE.
  //
  // Both were built, both refuse an unauthenticated caller, and neither appeared in vercel.json or
  // in any GitHub Actions workflow — so neither had ever run. docs/ops/MONITORING.md had recorded
  // both as open findings. Presence of a file under src/pages/api/cron/ is not evidence that
  // anything calls it, which is exactly what this list and its paired test exist to make visible.
  //
  //   /api/jobs/run          drains edu_jobs. It is the ONLY consumer of the queue, so every job
  //                          anything enqueued was sitting there unprocessed. The daily entry is a
  //                          backstop; .github/workflows/jobs-drain.yml runs it every 15 minutes,
  //                          the same arrangement imap-poll already uses to get past the Hobby
  //                          plan's daily-only limit.
  //   /api/cron/security-scan  its own header calls itself "the serverless replacement for a
  //                          resident continuous monitoring daemon — detection latency is bounded
  //                          by the cron interval". With no interval, that latency was infinite.
  { path: '/api/jobs/run', schedule: '10 4 * * *' },
  { path: '/api/cron/security-scan', schedule: '50 3 * * *' },
];

/**
 * The self-bootstrapping schemas this deployment expects, and the module that owns each CREATE
 * TABLE. There is no migration runner here — DDL runs on first use inside the owning module — so
 * "has this module ever run in production?" is answerable only by looking for its table. Absent is
 * not automatically broken: a module nothing has exercised yet has simply not bootstrapped.
 */
export const BOOTSTRAP_MODULES: { module: string; table: string; owner: string }[] = [
  { module: 'Error log', table: 'edu_error_log', owner: 'src/lib/logger.ts' },
  { module: 'Job queue', table: 'edu_jobs', owner: 'src/lib/job-queue.ts' },
  { module: 'Job delivery log', table: 'edu_job_log', owner: 'src/lib/job-queue.ts' },
  { module: 'Feature flags', table: 'edu_feature_flags', owner: 'src/lib/observability.ts' },
  { module: 'Cron runs', table: 'edu_cron_runs', owner: 'src/lib/observability-health.ts' },
  { module: 'Releases', table: 'edu_releases', owner: 'src/lib/observability-health.ts' },
  { module: 'RBAC audit', table: 'rbac_audit', owner: 'src/lib/rbac/schema.ts' },
  { module: 'Audit log', table: 'audit_log', owner: 'src/lib/db/schema.ts' },
  { module: 'Knowledge sync queue', table: 'edu_sync_queue', owner: 'src/lib/knowledge-sync.ts' },
  { module: 'Mail config', table: 'mail_config', owner: 'src/lib/mail.ts' },
  // The LMS spine — assignments, submissions, grades, sections, discussion, statement store. One
  // module owns every CREATE TABLE for it, so one table answers "has it bootstrapped in production".
  { module: 'LMS coursework', table: 'lms_assignments', owner: 'src/lib/lms/schema.ts' },

  // ============================================================================================
  // THE THREE THIS LIST WAS MISSING, AND WHY THEIR ABSENCE WAS EXPENSIVE
  // ============================================================================================
  //
  // This list is what "all expected tables present" MEANS. A table read in production but absent
  // from here is a table this endpoint reports nothing about, and the endpoint's silence reads as
  // health. All three below are read on paths a real person walks, none of them appears in any
  // db/*.sql file, and each one's only creator is an ensureOnce() bootstrap — which returns a
  // resolved promise in production, by design, for the connection-pressure reason written at the
  // top of src/lib/ensure-once.ts.
  //
  // The claim that made this safe was "every caller already tolerates a missing table, so the
  // failure mode is a feature with no rows". hr_daily_report_revisions is where that stops being
  // true: submitClockOutReport() INSERTs into it as the FIRST statement inside a db.transaction,
  // so a missing table does not degrade the daily report — it rolls back the transaction and the
  // clock-out fails. The person is left unable to end their day, and the parent table
  // hr_daily_reports IS in db/hr-schema.sql, which is exactly why nobody noticed the trail table
  // was not.
  { module: 'Daily report revisions', table: 'hr_daily_report_revisions', owner: 'src/lib/daily-report.ts' },
  // Read by /portal/profile and five other surfaces; created only by ensureLearningProgressSchema().
  { module: 'Course certificates', table: 'training_certificates', owner: 'src/lib/learning-progress.ts' },
  // The clock-out identity trail, same module and same bootstrap as the revisions table above.
  { module: 'Clock-out checks', table: 'hr_clock_out_checks', owner: 'src/lib/attendance-verify-clockout.ts' },

  // DISCOVERY, ADDED 2026-08-24 AFTER /admin/search REPORTED BOTH OF THEM MISSING IN PRODUCTION.
  //
  // Same story as the three above and one worse consequence. ensureSearchSchema() is their only
  // creator, it runs through db.execute, and db.execute refuses DDL in production — so neither
  // table has ever existed on the live database, and neither appeared here to say so. The learner
  // surface /aquintutor/search caught the missing relation and rendered "Nothing found", which is
  // not a feature with no rows: it is a student being told the catalogue is empty. Now created by
  // db/search-index-schema.sql, and monitored here.
  { module: 'Search index', table: 'edu_search_index', owner: 'src/lib/search-index.ts' },
  { module: 'Search query log', table: 'edu_search_queries', owner: 'src/lib/search-index.ts' },

  // ============================================================================================
  // THE AUTHENTICATION TABLES, ADDED 2026-08-24. THE WHOLE SUBSYSTEM WAS UNMONITORED.
  // ============================================================================================
  //
  // Not one table in src/lib/auth/ was named here, so this endpoint had nothing to say about any of
  // them — sign-in, second factors, passkeys, recovery, the permission registry. Silence from a
  // health check reads as health, and that is the defect being fixed. It is NOT a claim that any of
  // them is missing.
  //
  // THE CLAIM THAT WAS WRONG, KEPT BECAUSE THE REASONING MATTERS. A first pass here asserted these
  // tables were absent in production, on the strength of two facts: no db/*.sql creates any of them,
  // and the live endpoint was reporting `ddl.suppressed: 7` naming their CREATE statements. Both
  // facts are true and the conclusion does not follow. These bootstraps do not go through
  // ensureOnce — they call db.execute directly behind a module-level `let ensured` — so they ran on
  // every cold instance from the day each shipped until the DDL guard landed on 2026-08-23.
  // src/lib/auth/twofactor.ts shipped on 2026-06-30 and is reached on every successful password
  // sign-in. `suppressed` counts ATTEMPTS, not failures; a no-op CREATE TABLE IF NOT EXISTS against
  // an existing table is attempted and refused exactly like one against a missing table.
  //
  // The point of these entries is that nobody should have to reason about any of that again. The
  // endpoint answers it, every time it is polled, and db/auth-schema.sql is the file that fixes
  // whatever the answer turns out to be.
  //
  // ONE ENTRY PER FAILURE, NOT ONE PER MODULE. The convention above is one representative table per
  // module, on the reasoning that a module's bootstrap either ran or did not. That does not hold for
  // two-factor.ts, whose ensure creates three tables that are read in three different places — the
  // attempt limiter on the password form, the policy after a correct password, and the pending
  // challenge — so all three are named.

  // The shared attempt limiter, and the newest of this set, which makes it the one most worth
  // confirming: countAttempt() INSERTs here with no catch of its own, on all four password sign-in
  // forms and on the public form limiter.
  { module: 'Auth attempt limiter', table: 'auth_attempt_limit', owner: 'src/lib/auth/two-factor.ts' },
  // Read by isSecondStepRequired() after a CORRECT password on /admin/login, /portal/login,
  // /aquintutor/login and /hei/login. A missing relation is an ordinary query error there, and each
  // page's catch turns it into "Sign-in is temporarily unavailable" — a sign-in outage, not a
  // degraded feature.
  { module: 'Second-step policy', table: 'user_2fa_policy', owner: 'src/lib/auth/two-factor.ts' },
  // The half-finished sign-in itself. No challenge can be issued or completed without it.
  { module: 'Pending sign-in challenge', table: 'auth_pending_2fa', owner: 'src/lib/auth/two-factor.ts' },
  // TOTP enrolment and the hashed one-time recovery codes.
  { module: 'TOTP secrets', table: 'user_totp', owner: 'src/lib/auth/twofactor.ts' },
  { module: 'Recovery codes', table: 'user_backup_codes', owner: 'src/lib/auth/twofactor.ts' },
  // Passkey / fingerprint / Face ID. On this deployment any ONE of password, passkey, face or TOTP
  // signs you in, so this is a front door and not an extra.
  { module: 'Passkeys', table: 'user_passkeys', owner: 'src/lib/auth/webauthn.ts' },
  // Account recovery. Absent, a locked-out person cannot be let back in by the path built for it.
  { module: 'Account recovery tokens', table: 'auth_recovery_token', owner: 'src/lib/auth/recovery.ts' },
  // Not a feature table: the record that facial data was erased, by whom, and why. Its absence does
  // not break a screen — it means the erasure happened with no evidence that it happened.
  { module: 'Face erasure record', table: 'face_erasure_log', owner: 'src/lib/auth/face-erasure.ts' },
  // The RBAC registry. Near-certainly present already, because src/middleware.ts reads
  // role_permissions and user_role_assignments through getViewableSectionKeys() on every admin page
  // load and admin pages open — but "near-certainly" is what this list exists to replace with an
  // answer, and no committed file creates them either.
  { module: 'RBAC roles', table: 'team_roles', owner: 'src/lib/auth/registry.ts' },
  { module: 'RBAC page permissions', table: 'role_permissions', owner: 'src/lib/auth/registry.ts' },
  { module: 'RBAC role assignments', table: 'user_role_assignments', owner: 'src/lib/auth/registry.ts' },
  { module: 'Permission catalogue', table: 'permission_catalogue', owner: 'src/lib/auth/registry.ts' },
  { module: 'Permission grants', table: 'role_permission_grants', owner: 'src/lib/auth/registry.ts' },

  // CAREER INTELLIGENCE, ADDED WITH THE FEATURE RATHER THAN AFTER THE INCIDENT.
  //
  // Both are created by db/career-intel-schema.sql, which is run by hand — the production default
  // for schema bootstrap is off, so the ensure in src/lib/career-intel/store.ts creates nothing
  // there. Registering them here on day one is the whole lesson of the five entries above: a table
  // this endpoint says nothing about is a table whose absence reads as health.
  //
  // NEITHER IS LOAD-BEARING FOR THE PUBLIC EXPERIENCE, and that is stated so nobody reading a
  // "missing" line panics on a careers outage that is not happening. An anonymous visitor's
  // personalisation lives in their own browser; these two carry an explicit save and explicit
  // recommendation feedback. Absent, the Save control reports honestly that saving is unavailable
  // and the governance page reports that it cannot read, rather than showing an empty chart.
  { module: 'Career profiles', table: 'career_profiles', owner: 'src/lib/career-intel/store.ts' },
  { module: 'Career recommendation feedback', table: 'career_feedback_events', owner: 'src/lib/career-intel/store.ts' },

  // ============================================================================================
  // THE PAGES A PERSON CAN ACTUALLY OPEN, ADDED 2026-08-24 AFTER A REPO-WIDE SWEEP
  // ============================================================================================
  //
  // Every CREATE TABLE IF NOT EXISTS in src/ was collected and diffed against a full enumeration of
  // the production database: 736 statements, 325 of them naming a table the live database does not
  // have. That number is not the emergency it looks like. Around three hundred belong to library
  // modules nothing has exercised — the mail platform alone owns 47, the two unreconciled
  // recruitment stacks another 57 — and a table for a feature no one has opened is not an outage.
  //
  // THESE ARE THE ONES A PAGE UNDER src/pages CREATES, which is the difference that matters:
  // somebody navigating the site reaches them, and every one renders today as an empty list or a
  // failed save rather than an error. db/reachable-surfaces-schema.sql creates them.
  //
  // NONE OF THEM CAN BE FIXED BY THE REPAIR BUTTON. That registry calls exported ensure functions;
  // page-owned DDL is inline in a page's frontmatter with no function to call. The hand-run file is
  // the only path, which is exactly why they need to be visible here.
  { module: 'Ask a doubt', table: 'doubts', owner: 'src/pages/portal/doubts/index.astro' },
  { module: 'Library catalogue', table: 'library_resources', owner: 'src/pages/portal/library.astro' },
  { module: 'Flashcards', table: 'flashcard_decks', owner: 'src/pages/portal/flashcards.astro' },
  { module: 'Notes', table: 'notes', owner: 'src/pages/portal/notes.astro' },
  { module: 'Resume builder', table: 'user_resumes', owner: 'src/pages/portal/resume-builder.astro' },
  // Not a feature table: this is the record that decides whether one account may see another
  // person's progress. Its absence is an access-control record with nowhere to live.
  { module: 'Guardian links', table: 'parent_child_links', owner: 'src/pages/portal/parent.astro' },
  // The most consequential of the set. Without it recovery-by-questions cannot issue a challenge,
  // so a locked-out person cannot be let back in by the path built for exactly that.
  { module: 'Recovery challenge', table: 'auth_recovery_challenge', owner: 'src/pages/api/auth/verify-by-questions.ts' },
  // The idempotency record for candidate reminders. Absent, the endpoint has no memory of what it
  // already sent, and the failure mode is a person emailed the same reminder repeatedly.
  { module: 'Task reminder log', table: 'task_reminder_log', owner: 'src/pages/api/hiring/task-reminders.ts' },

  // The half of PERFORMANCE_DDL that the aborted batch never reached, beyond the two tables
  // db/capability-spine-schema.sql already recovered. db/performance-remainder-schema.sql.
  { module: 'Continuous feedback', table: 'hr_feedback', owner: 'src/lib/performance-schema.ts' },

  // PRESENT, AND LISTED ANYWAY. application_stage_events exists — it carries the funnel history the
  // hiring decision report reads — but it was unmonitored, and /api/health reports four suppressed
  // DDL statements from its module on every cold start. A table nothing says anything about is one
  // whose absence would read as health. db/application-stages-schema.sql now records its shape.
  { module: 'Application stage history', table: 'application_stage_events', owner: 'src/lib/application-stages.ts' },

  // HIRING DECISION SUPPORT, ADDED 2026-08-24 AFTER A REAL DECISION WAS REFUSED IN PRODUCTION.
  //
  // /admin/applications/[id]/decision answered a recorded hire with: relation "hiring_decisions"
  // does not exist. src/lib/hiring-decision.ts shipped 2026-08-23 — the same day production stopped
  // running request-path DDL — so ensureHiringDecisionSchema() has never created anything on the
  // live database, and nothing here said so. The table is a person's accountable decision with
  // their name and their reason on it; its absence is not a degraded feature, it is a decision that
  // cannot be recorded at all. db/hiring-decision-schema.sql is the file that creates it.
  { module: 'Hiring decisions', table: 'hiring_decisions', owner: 'src/lib/hiring-decision.ts' },

  // THE CAPABILITY SPINE THE SAME REPORT READS. Named per FAILURE rather than per module, following
  // the two-factor precedent above, because each of these is a separately worded panel on that
  // screen: an unresolved person, unreadable job requirements, and no evidence to compare.
  //
  // NONE OF THEM EXISTED IN PRODUCTION until db/capability-spine-schema.sql was run by hand on
  // 2026-08-24, and that was measured rather than assumed. A full table enumeration of the live
  // database that morning contained none of them, and neither did one of the database the site was
  // migrated FROM the same day — so it was not something the migration dropped, they had never been
  // created anywhere. All nine are confirmed present as of that run; these entries are what keeps
  // the answer current instead of remembered.
  //
  // A first pass here guessed the opposite: these modules shipped on 2026-08-04 and 2026-08-09,
  // before production stopped running request-path DDL, so "they predate the guard, they are
  // probably present" looked sound. It was wrong, and the reason is worth keeping. Both ensures run
  // their statements as ONE SEQUENCE that stops at the first failure, inside an ensureOnce() that
  // swallows — and the live database shows exactly that shape: hr_goal_key_results, the second
  // statement of the performance batch, exists; hr_feedback and everything after it, hr_skills
  // included, does not. Shipping before the guard buys you the statements up to the first failure
  // and nothing after it. db/capability-spine-schema.sql is the file that creates these.
  { module: 'Person spine', table: 'hr_persons', owner: 'src/lib/person-spine.ts' },
  { module: 'Person identity links', table: 'hr_person_identities', owner: 'src/lib/person-spine.ts' },
  { module: 'Role requirements', table: 'hr_role_requirements', owner: 'src/lib/person-spine.ts' },
  { module: 'Skill catalogue', table: 'hr_skills', owner: 'src/lib/performance-schema.ts' },
  { module: 'Evidenced skills', table: 'hr_employee_skills', owner: 'src/lib/performance-schema.ts' },
  // The stored capability reading and what a human did about it. Third unreadable panel on the same
  // screen, third table absent from the live database, same single creator behind an ensure.
  { module: 'Capability readings', table: 'match_evaluations', owner: 'src/lib/match.ts' },
];

// ============================================================================================
// DATABASE — short statements only. Nothing below holds a connection or runs a timer.
// ============================================================================================

// postgres-js resolves execute() to a PLAIN ARRAY. Never r.rows[0].
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
// Declared before every handler that uses it: `const` is not hoisted, and that has taken pages down here.
const ctx = async () => {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
};

const OBS_DDL = [
  'CREATE TABLE IF NOT EXISTS edu_cron_runs (path text PRIMARY KEY, last_run_at timestamptz NOT NULL DEFAULT now(), last_status text, last_detail text, runs bigint NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS edu_releases (sha text PRIMARY KEY, ref text, environment text, message text, first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now())',
  // THE ROLLUP GREW COLUMNS RATHER THAN BEING REPLACED. edu_cron_runs already had a consumer
  // (cronStatus) and a shape other code reads; widening it additively keeps every existing reader
  // working while giving the ops view something it can actually diagnose from. ADD COLUMN IF NOT
  // EXISTS is forward-only, which is the established pattern in this repository and the reason
  // rolling back code does not roll back schema.
  'ALTER TABLE edu_cron_runs ADD COLUMN IF NOT EXISTS last_execution_id text',
  'ALTER TABLE edu_cron_runs ADD COLUMN IF NOT EXISTS last_started_at timestamptz',
  'ALTER TABLE edu_cron_runs ADD COLUMN IF NOT EXISTS last_finished_at timestamptz',
  'ALTER TABLE edu_cron_runs ADD COLUMN IF NOT EXISTS last_duration_ms integer',
  'ALTER TABLE edu_cron_runs ADD COLUMN IF NOT EXISTS last_processed integer',
  'ALTER TABLE edu_cron_runs ADD COLUMN IF NOT EXISTS last_succeeded integer',
  'ALTER TABLE edu_cron_runs ADD COLUMN IF NOT EXISTS last_failed integer',
  'ALTER TABLE edu_cron_runs ADD COLUMN IF NOT EXISTS last_error_code text',
  'ALTER TABLE edu_cron_runs ADD COLUMN IF NOT EXISTS last_error_message text',
  'ALTER TABLE edu_cron_runs ADD COLUMN IF NOT EXISTS last_release text',
  // Consecutive failures is the number an operator actually acts on: one failed nightly run is a
  // Tuesday, four in a row is an outage nobody noticed.
  'ALTER TABLE edu_cron_runs ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0',
  'ALTER TABLE edu_cron_runs ADD COLUMN IF NOT EXISTS last_success_at timestamptz',
  // One row per execution. The rollup answers "is it healthy now"; this answers "when did it stop
  // working", which is the question during an incident and cannot be reconstructed from a rollup.
  `CREATE TABLE IF NOT EXISTS edu_cron_executions (
     execution_id text PRIMARY KEY,
     cron_id text NOT NULL,
     started_at timestamptz NOT NULL DEFAULT now(),
     finished_at timestamptz,
     duration_ms integer,
     status text NOT NULL DEFAULT 'running',
     records_processed integer,
     records_succeeded integer,
     records_failed integer,
     error_code text,
     error_message text,
     release text,
     detail text
   )`,
  'CREATE INDEX IF NOT EXISTS edu_cron_executions_cron_idx ON edu_cron_executions (cron_id, started_at DESC)',
];
let _obsReady = false;

/** Self-bootstrap this module's own two tables. Never called from the pollable /api/health. */
export async function ensureObservabilitySchema(): Promise<void> {
  if (_obsReady) return;
  const { db, sql } = await ctx();
  for (const d of OBS_DDL) await db.execute(sql.raw(d));
  // NOT `= true`. A suppressed DDL run must not latch as a completed one.
  //
  // db.execute refuses DDL when schema bootstrap is off (src/lib/schema-bootstrap.ts) and returns
  // the same empty result a real statement would, deliberately, so nothing downstream has to
  // change. The cost of that indistinguishability is exactly here: setting the flag
  // unconditionally recorded "already bootstrapped" for a loop that created nothing. Any earlier
  // request on a warm instance -- a page render, a health probe, even loading /admin/setup before
  // pressing its button -- would latch it, and the operator's allowingDdl() pass would then return
  // at the guard above and report success having done nothing.
  // Recording what actually happened means a suppressed run stays unlatched and the deliberate
  // operator pass re-runs it for real.
  _obsReady = ddlPermitted();
}

/**
 * Record that a scheduled job actually ran. One line for a cron route to adopt:
 *   await recordCronRun('/api/cron/thing', 'ok', 'processed 12');
 * Until a route adopts it, /admin/ops reports that cron as "no run recorded" — which is the honest
 * answer, and visibly different from "ran and failed".
 */
export async function recordCronRun(path: string, status: 'ok' | 'error' = 'ok', detail = ''): Promise<void> {
  try {
    await ensureObservabilitySchema();
    const { db, sql } = await ctx();
    await db.execute(sql`INSERT INTO edu_cron_runs (path, last_run_at, last_status, last_detail, runs)
      VALUES (${path}, now(), ${status}, ${String(detail || '').slice(0, 300)}, 1)
      ON CONFLICT (path) DO UPDATE SET last_run_at = now(), last_status = ${status}, last_detail = ${String(detail || '').slice(0, 300)}, runs = edu_cron_runs.runs + 1`);
  } catch (e: any) {
    // Instrumentation must never break the job it is instrumenting — but it must not vanish either.
    const { logEvent } = await import('@/lib/logger');
    logEvent('warn', 'ops.cron_run_record_failed', { path, message: e?.cause?.message || e?.message });
  }
}

// -------------------------------------------------------------------------------------------------
// CANONICAL CRON TELEMETRY
//
// WHY THIS EXISTS. recordCronRun() has been available for some time and NOT ONE ROUTE CALLED IT.
// Sixteen scheduled jobs, zero producers: /admin/ops correctly reported "not instrumented" for all
// of them, which is honest and useless. An opt-in one-liner at the bottom of a handler is a thing
// people mean to add.
//
// So the shape changed. withCronRun() WRAPS the job instead of asking to be called at the end, and
// therefore records a terminal state even when the handler throws, returns early, or forgets. The
// only way to run a wrapped job without telemetry is to not wrap it — which is visible in review,
// unlike a missing call at the bottom of a function.
//
// ONE SCHEMA FOR EVERY CRON. Before this, a route wanting to say "processed 12, failed 2" had to
// invent somewhere to put it. Two routes inventing two shapes is how an ops dashboard becomes a pile
// of free text nobody can aggregate.
//
// TELEMETRY MUST NEVER BREAK THE JOB. Every function here swallows its own persistence failure and
// logs it — but the job's outcome is untouched and its exception is re-thrown. An instrumented job
// that failed because instrumentation failed would be strictly worse than no instrumentation.
// -------------------------------------------------------------------------------------------------

/**
 * The states a scheduled job can be in. Deliberately more than ok/error:
 *   running       - started and has not reported an end. Stuck here past two intervals = timeout.
 *   success       - did its work, nothing failed.
 *   partial       - did SOME of its work. The state most often lost, because a job that processed
 *                   98 of 100 exits zero and reports "ok".
 *   failed        - threw, or every record failed.
 *   timeout       - started, never finished, and the window has passed.
 *   skipped       - ran, decided there was nothing to do. Healthy, and NOT the same as success.
 *   misconfigured - could not run for want of a secret or a setting. Not a failure of the code, and
 *                   it needs a person rather than a retry.
 */
export type CronStatus = 'running' | 'success' | 'partial' | 'failed' | 'timeout' | 'skipped' | 'misconfigured';

export interface CronOutcome {
  status?: CronStatus;
  /** Records this run looked at. */
  processed?: number;
  succeeded?: number;
  failed?: number;
  /** One human-readable line for the ops table. */
  detail?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Work out the status from the counts when the job did not state one. Pure.
 *
 * The interesting case is `partial`: any failure at all alongside any success is partial, never
 * success. A job that quietly drops 2% and reports success is the reason this function exists.
 */
export function deriveCronStatus(o: CronOutcome | null | undefined): CronStatus {
  if (o?.status) return o.status;
  const processed = Number(o?.processed ?? 0);
  const failed = Number(o?.failed ?? 0);
  const succeeded = Number(o?.succeeded ?? Math.max(0, processed - failed));
  if (processed === 0 && failed === 0) return 'skipped';
  if (failed > 0 && succeeded === 0) return 'failed';
  if (failed > 0) return 'partial';
  return 'success';
}

/**
 * What the ops view should say about a cron right now. Pure, so it is testable without a database.
 *
 * Freshness and outcome are BOTH consulted, and freshness wins when the job is simply not running:
 * a job whose last run succeeded three weeks ago is overdue, not healthy. Showing the green from
 * that last success is precisely the "never run appears as healthy" failure this replaces.
 */
export function cronHealth(
  schedule: string,
  row: { lastRunAt?: string | Date | null; lastStartedAt?: string | Date | null; status?: string | null } | null | undefined,
  now: number | Date = Date.now(),
): 'never_run' | 'running' | 'success' | 'partial' | 'failed' | 'timeout' | 'skipped' | 'misconfigured' | 'overdue' {
  const nowMs = Number(now);
  if (!row || (!row.lastRunAt && !row.lastStartedAt)) return 'never_run';

  const intervalMs = cronIntervalHours(schedule) * 3600 * 1000;
  const status = String(row.status || '') as CronStatus;

  if (status === 'running') {
    const startedAt = new Date((row.lastStartedAt || row.lastRunAt) as any).getTime();
    // Still marked running long after it should have finished: the process died mid-run and nothing
    // wrote a terminal state. Reporting that as "running" forever is how a dead job looks busy.
    if (Number.isFinite(startedAt) && nowMs - startedAt > intervalMs * 2) return 'timeout';
    return 'running';
  }

  const lastRun = new Date((row.lastRunAt || row.lastStartedAt) as any).getTime();
  if (!Number.isFinite(lastRun)) return 'never_run';
  if (nowMs - lastRun > intervalMs * 1.5) return 'overdue';

  if (status === 'success' || status === 'partial' || status === 'failed' || status === 'timeout'
      || status === 'skipped' || status === 'misconfigured') return status;
  // A run recorded by a module that keeps its own timestamp and states no status. It ran recently;
  // that is all that is known, and success is the least misleading label for "fresh, no complaint".
  return 'success';
}

/** Does this state need somebody to do something. Pure — drives the ops banner. */
export function cronNeedsAttention(state: ReturnType<typeof cronHealth>): boolean {
  return state === 'failed' || state === 'timeout' || state === 'overdue' || state === 'misconfigured';
}

function newExecutionId(): string {
  try { return (globalThis as any).crypto.randomUUID(); } catch { return Date.now() + '-' + Math.random().toString(16).slice(2); }
}

/** Mark a job as started. Returns the execution id to hand to finishCronRun(). Never throws. */
export async function startCronRun(path: string): Promise<{ executionId: string; startedAtMs: number }> {
  const executionId = newExecutionId();
  const startedAtMs = Date.now();
  try {
    await ensureObservabilitySchema();
    const { db, sql } = await ctx();
    const release = deployMarker().shortCommit || null;
    await db.execute(sql`INSERT INTO edu_cron_executions (execution_id, cron_id, started_at, status, release)
      VALUES (${executionId}, ${path}, now(), 'running', ${release})`);
    await db.execute(sql`INSERT INTO edu_cron_runs (path, last_run_at, last_status, last_execution_id, last_started_at, last_release, runs)
      VALUES (${path}, now(), 'running', ${executionId}, now(), ${release}, 1)
      ON CONFLICT (path) DO UPDATE SET last_status = 'running', last_execution_id = ${executionId},
        last_started_at = now(), last_release = ${release}, runs = edu_cron_runs.runs + 1`);
  } catch (e: any) {
    const { logEvent } = await import('@/lib/logger');
    logEvent('warn', 'ops.cron_start_record_failed', { path, message: e?.cause?.message || e?.message });
  }
  return { executionId, startedAtMs };
}

/** Record how a job ended. Never throws — the job's own result is what matters. */
export async function finishCronRun(
  path: string,
  executionId: string,
  startedAtMs: number,
  outcome: CronOutcome = {},
): Promise<CronStatus> {
  const status = deriveCronStatus(outcome);
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  try {
    await ensureObservabilitySchema();
    const { db, sql } = await ctx();
    const detail = String(outcome.detail || '').slice(0, 300) || null;
    const errorMessage = String(outcome.errorMessage || '').slice(0, 500) || null;
    await db.execute(sql`UPDATE edu_cron_executions SET
        finished_at = now(), duration_ms = ${durationMs}, status = ${status},
        records_processed = ${outcome.processed ?? null}, records_succeeded = ${outcome.succeeded ?? null},
        records_failed = ${outcome.failed ?? null}, error_code = ${outcome.errorCode || null},
        error_message = ${errorMessage}, detail = ${detail}
      WHERE execution_id = ${executionId}`);
    const failedRun = status === 'failed' || status === 'timeout';
    // consecutive_failures is the number an operator acts on: one failed nightly run is a Tuesday,
    // four in a row is an outage nobody noticed.
    await db.execute(sql`UPDATE edu_cron_runs SET
        last_run_at = now(), last_finished_at = now(), last_status = ${status},
        last_duration_ms = ${durationMs}, last_detail = ${detail},
        last_processed = ${outcome.processed ?? null}, last_succeeded = ${outcome.succeeded ?? null},
        last_failed = ${outcome.failed ?? null}, last_error_code = ${outcome.errorCode || null},
        last_error_message = ${errorMessage},
        consecutive_failures = CASE WHEN ${failedRun} THEN edu_cron_runs.consecutive_failures + 1 ELSE 0 END,
        last_success_at = CASE WHEN ${status === 'success' || status === 'skipped'} THEN now() ELSE edu_cron_runs.last_success_at END
      WHERE path = ${path}`);
  } catch (e: any) {
    const { logEvent } = await import('@/lib/logger');
    logEvent('warn', 'ops.cron_finish_record_failed', { path, executionId, message: e?.cause?.message || e?.message });
  }
  return status;
}

/**
 * Run a scheduled job with telemetry that cannot be forgotten.
 *
 *     export const GET: APIRoute = async ({ request }) => {
 *       if (!authorized(request)) return json({ error: 'unauthorised' }, 401);
 *       return withCronRun('/api/cron/thing', async () => {
 *         const r = await doTheWork();
 *         return { outcome: { processed: r.total, failed: r.failed }, value: json(r) };
 *       });
 *     };
 *
 * The handler returns its HTTP response AND the counts. A throw is recorded as `failed` with the
 * real reason and then RE-THROWN, so the route's own error handling is unchanged and a failure is
 * not hidden by the act of having observed it.
 */
export async function withCronRun<T>(
  path: string,
  fn: () => Promise<{ outcome?: CronOutcome; value: T }>,
): Promise<T> {
  const { executionId, startedAtMs } = await startCronRun(path);
  try {
    const { outcome, value } = await fn();
    await finishCronRun(path, executionId, startedAtMs, outcome || {});
    return value;
  } catch (e: any) {
    await finishCronRun(path, executionId, startedAtMs, {
      status: 'failed',
      errorCode: e?.cause?.code || e?.code || undefined,
      errorMessage: e?.cause?.message || e?.message || 'threw with no message',
      detail: 'Handler threw.',
    });
    throw e;
  }
}

/** Note the serving commit so an error row's release tag resolves to something readable later. */
export async function recordRelease(): Promise<void> {
  const m = deployMarker();
  if (!m.known || !m.commit) return;
  try {
    await ensureObservabilitySchema();
    const { db, sql } = await ctx();
    await db.execute(sql`INSERT INTO edu_releases (sha, ref, environment, message)
      VALUES (${m.commit}, ${m.ref}, ${m.environment}, ${m.message})
      ON CONFLICT (sha) DO UPDATE SET last_seen_at = now()`);
  } catch (e: any) {
    const { logEvent } = await import('@/lib/logger');
    logEvent('warn', 'ops.release_record_failed', { message: e?.cause?.message || e?.message });
  }
}

/** Does the database answer, and how fast. One statement, no DDL, no transaction. */
export async function dbPing(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    const { db, sql } = await ctx();
    await db.execute(sql`SELECT 1 AS ok`);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    return { ok: false, latencyMs: Date.now() - started, error: String(e?.cause?.message || e?.message || 'unreachable').slice(0, 300) };
  }
}

/**
 * Which self-bootstrapping schemas have run — ONE information_schema query for all of them, so a
 * polled health check costs two statements total rather than one per module.
 */
export async function bootstrapStatus(): Promise<{ module: string; table: string; owner: string; present: boolean }[]> {
  const names = BOOTSTRAP_MODULES.map((m) => m.table);
  try {
    const { db, sql } = await ctx();
    // = ANY(${jsArray}) FAILS against this driver: the array arrives as a plain parameter, not a
    // typed text[], and Postgres answers "op ANY/ALL (array) requires array on right side". So this
    // query threw on EVERY call, the catch below turned that into present:false for all ten, and
    // /api/health reported "10 module table(s) not yet created" as a fact — for weeks, while never
    // once having looked. The founder pressed the repair button repeatedly against a check that
    // could not have noticed if it worked.
    //
    // An IN list of individual placeholders is unambiguous and needs no cast.
    const placeholders = sql.join(names.map((t) => sql`${t}`), sql`, `);
    const r = rows(await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (${placeholders})`));
    const present = new Set(r.map((x: any) => String(x.table_name)));
    return BOOTSTRAP_MODULES.map((m) => ({ ...m, present: present.has(m.table) }));
  } catch (e: any) {
    // STILL fails closed — an unreadable check must not report health — but no longer silently.
    // A swallowed catch is what let a permanently broken query masquerade as a finding about the
    // database, and the real reason lives on e.cause, never on e.message.
    console.error('[health] bootstrapStatus could not read information_schema:',
      e?.cause?.message || e?.message || 'unknown error');
    return BOOTSTRAP_MODULES.map((m) => ({ ...m, present: false }));
  }
}

/**
 * The pollable check. TWO statements, no DDL, no writes. 503 when the database is unreachable so an
 * external monitor can actually see an outage instead of a cheerful static 200.
 */
export async function quickHealth(): Promise<{ status: Health; httpCode: number; checks: Check[]; database: { ok: boolean; latencyMs: number; error?: string }; schemas: { ran: number; expected: number; missing: string[] }; release: DeployMarker; at: string }> {
  const ping = await dbPing();
  const boot = ping.ok ? await bootstrapStatus() : BOOTSTRAP_MODULES.map((m) => ({ ...m, present: false }));
  const missing = boot.filter((b) => !b.present).map((b) => b.table);
  const checks: Check[] = [
    { name: 'database', ok: ping.ok, critical: true, detail: ping.ok ? ping.latencyMs + 'ms' : ping.error },
    { name: 'schema-bootstrap', ok: ping.ok && missing.length === 0, detail: missing.length ? missing.length + ' module table(s) not yet created' : 'all expected tables present' },
  ];
  const status = overallStatus(checks);
  return {
    status,
    httpCode: statusHttpCode(status),
    checks,
    database: ping,
    schemas: { ran: boot.filter((b) => b.present).length, expected: boot.length, missing },
    release: deployMarker(),
    at: new Date().toISOString(),
  };
}

/** Connection-pool pressure, from the server's own view. Best-effort: a pooler may refuse this. */
export async function poolSignals(): Promise<{ available: boolean; total: number; active: number; idle: number; idleInTransaction: number; maxConnections: number | null; note?: string }> {
  const empty = { available: false, total: 0, active: 0, idle: 0, idleInTransaction: 0, maxConnections: null as number | null };
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE state = 'active')::int AS active,
        count(*) FILTER (WHERE state = 'idle')::int AS idle,
        count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_txn
      FROM pg_stat_activity WHERE datname = current_database()`))[0];
    let maxConnections: number | null = null;
    try { maxConnections = Number(rows(await db.execute(sql`SELECT setting::int AS m FROM pg_settings WHERE name = 'max_connections'`))[0]?.m) || null; } catch { /* not exposed through some poolers */ }
    return {
      available: true,
      total: Number(r?.total || 0), active: Number(r?.active || 0), idle: Number(r?.idle || 0),
      idleInTransaction: Number(r?.idle_in_txn || 0), maxConnections,
      note: 'Server-side view. This site went fully down once when leaked watchers exhausted the pooler, so idle-in-transaction climbing is the signal to act on.',
    };
  } catch (e: any) {
    return { ...empty, note: 'pg_stat_activity not readable through this connection: ' + String(e?.cause?.message || e?.message || '').slice(0, 160) };
  }
}

/** Slowest observed statements, IF the instrumentation exists. Absent extension is reported, not faked. */
export async function slowQueries(limit = 8): Promise<{ available: boolean; note: string; rows: { query: string; calls: number; meanMs: number; maxMs: number }[] }> {
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT query, calls::bigint AS calls, mean_exec_time AS mean_ms, max_exec_time AS max_ms
      FROM pg_stat_statements ORDER BY mean_exec_time DESC NULLS LAST LIMIT ${limit}`));
    return {
      available: true,
      note: 'pg_stat_statements — literals are already normalised by the extension.',
      rows: r.map((x: any) => ({ query: String(x.query || '').replace(/\s+/g, ' ').slice(0, 220), calls: Number(x.calls || 0), meanMs: Math.round(Number(x.mean_ms || 0) * 100) / 100, maxMs: Math.round(Number(x.max_ms || 0) * 100) / 100 })),
    };
  } catch {
    return { available: false, note: 'No query instrumentation on this database (pg_stat_statements is not installed). Nothing is being measured — this panel is empty because the data does not exist, not because everything is fast.', rows: [] };
  }
}

/**
 * ERROR GROUPING. One row per distinct fault with a count, first-seen and last-seen — grouped in
 * SQL on the fingerprint stored at write time, so 400 repeats cost one row, not 400 fetched rows.
 * Rows written before the fingerprint column existed fall back to grouping by event.
 */
export async function errorGroups(opts: { hours?: number; limit?: number } = {}): Promise<{ fingerprint: string; event: string; message: string; count: number; firstSeen: string; lastSeen: string; releases: string[] }[]> {
  const hours = Math.min(720, Math.max(1, Number(opts.hours) || 24));
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 40));
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT COALESCE(fingerprint, event, 'unknown') AS fingerprint,
        MAX(event) AS event, MAX(message) AS message, COUNT(*)::int AS count,
        MIN(created_at) AS first_seen, MAX(created_at) AS last_seen,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT "release"), NULL) AS releases
      FROM edu_error_log
      WHERE created_at > now() - (${hours} * INTERVAL '1 hour')
      GROUP BY 1 ORDER BY MAX(created_at) DESC LIMIT ${limit}`));
    return r.map((x: any) => ({
      fingerprint: String(x.fingerprint), event: String(x.event || ''), message: String(x.message || ''),
      count: Number(x.count || 0), firstSeen: x.first_seen, lastSeen: x.last_seen,
      releases: Array.isArray(x.releases) ? x.releases.filter(Boolean).map(String) : [],
    }));
  } catch {
    // The release/fingerprint columns are added by logger.ts on first trackError; before that has
    // ever run the columns do not exist. Fall back rather than showing an empty incident board.
    try {
      const { db, sql } = await ctx();
      const r = rows(await db.execute(sql`SELECT event AS fingerprint, event, MAX(message) AS message, COUNT(*)::int AS count,
          MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
        FROM edu_error_log WHERE created_at > now() - (${hours} * INTERVAL '1 hour')
        GROUP BY event ORDER BY MAX(created_at) DESC LIMIT ${limit}`));
      return r.map((x: any) => ({ fingerprint: String(x.fingerprint || 'unknown'), event: String(x.event || ''), message: String(x.message || ''), count: Number(x.count || 0), firstSeen: x.first_seen, lastSeen: x.last_seen, releases: [] }));
    } catch (e: any) {
      // BOTH READS FAILED, AND AN EMPTY ARRAY IS INDISTINGUISHABLE FROM "NOTHING WENT WRONG".
      //
      // The incident board renders [] as "Nothing logged in this window" — reassuring, and the exact
      // failure mode this whole module was written against. It cannot throw (that would blank the
      // console an operator is depending on), so it says so on stdout instead of returning quietly.
      // logEvent, not trackError: writing an error row about not being able to read error rows is a
      // loop, and the reason the read failed is almost always that the database is unreachable —
      // which the banner above the panel is already reporting as DOWN.
      const { logEvent } = await import('@/lib/logger');
      logEvent('warn', 'ops.error_groups_unreadable', { hours, message: e?.cause?.message || e?.message });
      return [];
    }
  }
}

/**
 * Error volume over three windows — the shape of an incident (spiking, or steady background noise).
 *
 * `readable` IS PART OF THE ANSWER. This used to return four zeros when the read failed, and four
 * zeros is what a perfectly healthy deployment also returns — so an unreadable edu_error_log made
 * the incident board say HEALTHY, which is the single most dangerous thing this page can say. The
 * caller now has a value that separates "nothing has gone wrong" from "I could not find out".
 */
export async function errorRate(): Promise<{ lastHour: number; last24h: number; last7d: number; distinct24h: number; readable: boolean; unreadableReason?: string }> {
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT
        COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '1 hour')::int AS h1,
        COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int AS h24,
        COUNT(*)::int AS d7,
        COUNT(DISTINCT COALESCE(fingerprint, event)) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int AS distinct24
      FROM edu_error_log WHERE created_at > now() - INTERVAL '7 days'`))[0];
    return { lastHour: Number(r?.h1 || 0), last24h: Number(r?.h24 || 0), last7d: Number(r?.d7 || 0), distinct24h: Number(r?.distinct24 || 0), readable: true };
  } catch (e: any) {
    // Never throws — blanking the console an operator is depending on is worse than a partial one.
    // But it says so, on stdout and in the return value, instead of returning a healthy-looking zero.
    const reason = e?.cause?.message || e?.message || 'unknown';
    // Imported here, like every other logger use in this module, so nothing in the logging path is
    // pulled into a bundle that only wants the pure helpers at the top of this file.
    const { logEvent } = await import('@/lib/logger');
    logEvent('warn', 'ops.error_rate_unreadable', { reason });
    return { lastHour: 0, last24h: 0, last7d: 0, distinct24h: 0, readable: false, unreadableReason: reason };
  }
}

export interface CronStatusRow {
  path: string;
  schedule: string;
  lastRunAt: string | null;
  /** Kept for existing consumers. `health` is the one to render. */
  state: 'never' | 'ok' | 'overdue';
  /** The full state: never_run / running / success / partial / failed / timeout / skipped / misconfigured / overdue. */
  health: ReturnType<typeof cronHealth>;
  needsAttention: boolean;
  status: string | null;
  detail: string | null;
  source: string;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  durationMs: number | null;
  processed: number | null;
  succeeded: number | null;
  failed: number | null;
  consecutiveFailures: number;
  errorCode: string | null;
  errorMessage: string | null;
  /** When the next run is expected, from the last run plus one interval. */
  nextExpectedAt: string | null;
}

/** Configured crons joined to observed runs, plus the two last-run timestamps other modules already keep. */
export async function cronStatus(): Promise<CronStatusRow[]> {
  const observed = new Map<string, any>();
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT path, last_run_at, last_status, last_detail, last_started_at,
        last_success_at, last_duration_ms, last_processed, last_succeeded, last_failed,
        consecutive_failures, last_error_code, last_error_message
      FROM edu_cron_runs`));
    for (const x of r) observed.set(String(x.path), { at: x.last_run_at, status: x.last_status || null, detail: x.last_detail || null, source: 'recordCronRun', row: x });
  } catch {
    // Older deployments have the narrow table and no widened columns yet. Fall back rather than
    // blanking the whole panel — an ops view that disappears during a schema lag is worse than one
    // missing a column.
    try {
      const { db, sql } = await ctx();
      const r = rows(await db.execute(sql`SELECT path, last_run_at, last_status, last_detail FROM edu_cron_runs`));
      for (const x of r) observed.set(String(x.path), { at: x.last_run_at, status: x.last_status || null, detail: x.last_detail || null, source: 'recordCronRun', row: x });
    } catch { /* table not bootstrapped yet — reported as "no run recorded" below */ }
  }
  // Evidence two modules already write for themselves, so those two crons are observable today
  // without editing routes this workflow does not own.
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT imap_last_run FROM mail_config WHERE id = 1 LIMIT 1`))[0];
    if (r?.imap_last_run && !observed.has('/api/mail/imap-poll')) observed.set('/api/mail/imap-poll', { at: r.imap_last_run, status: null, detail: null, source: 'mail_config.imap_last_run' });
  } catch { /* mail not configured */ }
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT last_run_at FROM hei_miner_state WHERE id = 'default' LIMIT 1`))[0];
    if (r?.last_run_at && !observed.has('/api/cron/hei-refresh')) observed.set('/api/cron/hei-refresh', { at: r.last_run_at, status: null, detail: null, source: 'hei_miner_state.last_run_at' });
  } catch { /* miner never run */ }
  const now = Date.now();
  return CONFIGURED_CRONS.map((c) => {
    const o = observed.get(c.path);
    const row = o?.row || {};
    const lastRunAt = o?.at ? new Date(o.at).toISOString() : null;
    const lastStartedAt = row.last_started_at ? new Date(row.last_started_at).toISOString() : null;
    const health = cronHealth(c.schedule, { lastRunAt, lastStartedAt, status: o?.status || null }, now);
    const num = (v: any): number | null => (v == null ? null : Number(v));
    return {
      path: c.path, schedule: c.schedule,
      lastRunAt,
      state: cronRunState(c.schedule, o?.at || null, now),
      health,
      needsAttention: cronNeedsAttention(health),
      status: o?.status || null, detail: o?.detail || null,
      source: o?.source || 'not instrumented',
      lastStartedAt,
      lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
      durationMs: num(row.last_duration_ms),
      processed: num(row.last_processed),
      succeeded: num(row.last_succeeded),
      failed: num(row.last_failed),
      consecutiveFailures: Number(row.consecutive_failures || 0),
      errorCode: row.last_error_code ? String(row.last_error_code) : null,
      errorMessage: row.last_error_message ? String(row.last_error_message) : null,
      // Next expected run, derived from the last one plus one interval. Null when nothing has run:
      // a job that has never run has no basis for an expectation, and inventing one from `now`
      // would make a never-instrumented job look scheduled.
      nextExpectedAt: lastRunAt
        ? new Date(new Date(lastRunAt).getTime() + cronIntervalHours(c.schedule) * 3600 * 1000).toISOString()
        : null,
    };
  });
}

/** Mail transport reachability: a bounded TCP connect. Never sends mail, never sends credentials. */
export async function mailReachability(): Promise<{ configured: boolean; mode: string; host: string | null; port: number | null; reachable: boolean | null; detail: string; source: string }> {
  let cfg: any = null;
  try { const { getMailConfig } = await import('@/lib/mail'); cfg = await getMailConfig(); } catch (e: any) {
    return { configured: false, mode: 'unknown', host: null, port: null, reachable: null, detail: 'Mail config unreadable: ' + String(e?.cause?.message || e?.message || '').slice(0, 160), source: 'none' };
  }
  const host = (cfg?.smtpHost || '').trim() || null;
  const port = Number(cfg?.smtpPort || 0) || null;
  if (!host) return { configured: false, mode: 'none', host: null, port: null, reachable: null, detail: 'No SMTP transport configured — outbound mail would not leave the building.', source: cfg?.source || 'none' };
  try {
    const net = await import('node:net');
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port: port || 587 });
      const done = (v: boolean) => { try { socket.destroy(); } catch { /* already gone */ } resolve(v); };
      socket.setTimeout(2500);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
    return { configured: true, mode: 'smtp', host, port: port || 587, reachable, detail: reachable ? 'TCP connect succeeded (no auth attempted)' : 'TCP connect failed or timed out after 2.5s', source: cfg?.source || 'db' };
  } catch (e: any) {
    return { configured: true, mode: 'smtp', host, port, reachable: null, detail: 'Could not test: ' + String(e?.message || '').slice(0, 160), source: cfg?.source || 'db' };
  }
}

/** Everything the shallow check has, plus the operator-only signals. Discloses configuration — gate it. */
export async function deepHealth(): Promise<any> {
  const quick = await quickHealth();
  const [queue, pool, crons, mail, errors] = await Promise.all([
    import('@/lib/job-queue').then((m) => m.queueHealth()).catch(() => ({ pending: 0, processing: 0, failed: 0, done: 0 })),
    poolSignals(),
    cronStatus(),
    mailReachability(),
    errorRate(),
  ]);
  const overdue = crons.filter((c) => c.state === 'overdue');
  const checks: Check[] = [
    ...quick.checks,
    { name: 'mail-transport', ok: mail.configured && mail.reachable !== false, detail: mail.detail },
    { name: 'job-queue', ok: (queue as any).failed === 0, detail: (queue as any).failed + ' failed job(s)' },
    { name: 'cron', ok: overdue.length === 0, detail: overdue.length ? overdue.map((c) => c.path).join(', ') + ' overdue' : 'no overdue schedules' },
  ];
  const status = overallStatus(checks);
  return {
    status, httpCode: statusHttpCode(status), checks,
    database: quick.database, schemas: quick.schemas, release: quick.release,
    queue, pool, crons, mail, errors,
    at: new Date().toISOString(),
  };
}
