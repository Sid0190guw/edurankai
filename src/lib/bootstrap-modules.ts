// THE ONE LIST OF MODULES THAT CREATE THEIR OWN TABLES.
//
// This platform has no migration runner: each module creates its own tables the first time somebody
// opens it, so an unvisited module's first real user is the one who discovers the table is missing.
// Two surfaces exist to do them all deliberately — POST /api/admin/ops/bootstrap and the
// "Create module tables" button on /admin/setup — and until 2026-08-24 EACH OF THEM CARRIED ITS OWN
// COPY OF THE LIST.
//
// They had already drifted, in the direction that shows least and hurts most: the endpoint ran
// twenty-five modules, and the BUTTON — the only one of the two an operator can reach without
// pasting fetch() into DevTools — ran thirteen. Sign-in's four tables, the LMS, the daily report,
// learning progress and the clock-out checks were creatable by API and not by console. The button's
// own label promised what it could not do for half the list, which is the same defect as an empty
// state that overclaims.
//
// So the list lives here and both import it. A module added in one place is added in both, and
// neither surface can quietly fall behind again.
//
// EVERY ENTRY IS IDEMPOTENT AND ADDITIVE. CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
// inside an ensureOnce guard. Nothing here drops or alters existing data, and running it twice does
// nothing the second time.
export interface BootstrapModule {
  /** What the operator sees when this one fails. */
  name: string;
  /** The import that triggers the module's own bootstrap. */
  run: () => Promise<unknown>;
}

// ORDER IS NOT DECORATION IN THE LAST THIRD OF THIS LIST. A table that REFERENCES another cannot be
// created before it, and these ensures each run their statements in one sequence that stops at the
// first failure — so a dependency that runs afterwards fails and takes its whole batch with it.
// Where order matters it is stated on the entry.
export const BOOTSTRAP_MODULE_LIST: BootstrapModule[] = [
  { name: 'auth-registry', run: async () => (await import('@/lib/auth/registry')).ensureRegistrySchema() },
  { name: 'rbac', run: async () => (await import('@/lib/rbac/store')).ensureRbacSchema() },
  { name: 'observability-health', run: async () => (await import('@/lib/observability-health')).ensureObservabilitySchema() },
  { name: 'feature-flags', run: async () => (await import('@/lib/observability')).ensureFlagSchema() },
  { name: 'knowledge-sync', run: async () => (await import('@/lib/knowledge-sync')).ensureSyncSchema() },
  { name: 'mail', run: async () => (await import('@/lib/mail')).ensureMailSchema() },
  // Discovery. Both its tables are read by /aquintutor/search and /admin/search, and created by
  // nothing else on this deployment -- see db/search-index-schema.sql.
  { name: 'search-index', run: async () => (await import('@/lib/search-index')).ensureSearchSchema() },
  // AUTHENTICATION. Added 2026-08-24, when registering these tables in BOOTSTRAP_MODULES turned
  // "we cannot tell" into /api/health reporting three module tables not yet created. The whole
  // sign-in subsystem was outside this list, so the one button an operator has for "create what is
  // missing" could not create any of it.
  //
  // Each of these four memoises its own bootstrap in a module-level flag, and that flag used to be
  // set even when production had refused the DDL — so a caller would get an instant return and
  // report ok:true over tables that were never created. They now latch only on a run that was
  // permitted to create something, which is what makes pressing the button mean anything.
  { name: 'auth-totp', run: async () => (await import('@/lib/auth/twofactor')).ensureTwoFactorSchema() },
  { name: 'auth-second-step', run: async () => (await import('@/lib/auth/two-factor')).ensureSecondStepSchema() },
  { name: 'auth-passkeys', run: async () => (await import('@/lib/auth/webauthn')).ensurePasskeySchema() },
  { name: 'auth-recovery', run: async () => (await import('@/lib/auth/recovery')).ensureRecoverySchema() },
  // The erasure RECORD, not the erasure. Its table had no exported ensure until now, so its only
  // creator was somebody's first face deletion — the one moment you least want to find it missing.
  { name: 'face-erasure-log', run: async () => (await import('@/lib/auth/face-erasure')).ensureFaceErasureSchema() },
  // THE FOUR THAT WERE MONITORED BUT NOT CREATABLE. /api/health has reported on these for a while
  // and nothing could make any of them, so the button's own label — "create the missing tables now"
  // — was a promise it could not keep for a quarter of the list it verifies against.
  { name: 'daily-report', run: async () => (await import('@/lib/daily-report')).ensureDailyReportSchema() },
  { name: 'learning-progress', run: async () => (await import('@/lib/learning-progress')).ensureLearningProgressSchema() },
  { name: 'clock-out-checks', run: async () => (await import('@/lib/attendance-verify-clockout')).ensureClockOutSchema() },
  { name: 'lms', run: async () => (await import('@/lib/lms/schema')).ensureLmsSchema() },
  // HIRING DECISION SUPPORT AND THE CAPABILITY SPINE IT READS, ADDED 2026-08-24.
  //
  // WHY: /admin/applications/[id]/decision refused to record a real decision in production with
  // relation "hiring_decisions" does not exist. That table's only creator is
  // ensureHiringDecisionSchema(), and src/lib/hiring-decision.ts shipped on 2026-08-23, the same day
  // production stopped running request-path DDL — so it has never been created on the live database
  // and this button, the one control an operator has for "create what is missing", could not create
  // it either.
  //
  // ORDER MATTERS HERE, WHICH IS UNUSUAL FOR THIS LIST. hr_role_requirements and hr_skill_relations
  // both REFERENCE hr_skills, and ensureSpineSchema() runs its CREATEs in one sequence that stops at
  // the first failure — so the skill catalogue is created first, then the spine, then the decision
  // table. Run the other way round, the spine's later statements fail and the failure is silent.
  //
  // AND hr-lifecycle COMES BEFORE THE CATALOGUE, WHICH IS NEW AND IS NOT COSMETIC.
  // ensurePerformanceSchema() sends 48 statements as ONE batch and the first of them is
  // ALTER TABLE hr_employee_goals ADD COLUMN. That table belongs to hr-lifecycle. If it does not
  // exist the batch fails on its first statement and NOTHING in it is created — including hr_skills
  // and hr_employee_skills, which have no connection to goals at all. ensurePerformanceSchema does
  // await ensureLifecycleSchema() itself, but that await goes through ensureOnce, which SWALLOWS: a
  // failure there returns as success and the batch runs anyway against a table that was never made.
  // Listing it as a module of its own is what puts that failure on the screen under its own name,
  // instead of surfacing as a confusing error about goals from a module about skills.
  { name: 'hr-lifecycle', run: async () => (await import('@/lib/hr-lifecycle')).ensureLifecycleSchema() },
  { name: 'capability-catalogue', run: async () => (await import('@/lib/performance-schema')).ensurePerformanceSchema() },
  { name: 'person-spine', run: async () => (await import('@/lib/person-spine')).ensureSpineSchema() },
  { name: 'capability-readings', run: async () => (await import('@/lib/match')).ensureMatchSchema() },
  { name: 'hiring-decision', run: async () => (await import('@/lib/hiring-decision')).ensureHiringDecisionSchema() },
  // THE HR INTELLIGENCE DESK AND ITS ACCESS LOG. Registered 2026-08-29, and the same story as
  // hiring-decision above: six hri_* tables whose only creator is ensureHrIntelSchema(), named in no
  // db/*.sql, so on a deployment that refuses request-path DDL they have never been created and the
  // one button an operator has for "create what is missing" could not create them either.
  //
  // IT IS THE ACCESS LOG THAT MAKES THIS URGENT RATHER THAN UNTIDY. recordAccess() writes the row
  // that says who opened somebody's development record and why, and /admin/hr/intelligence/[id]
  // refuses to assemble anything when that write fails — correctly, because an unlogged read of a
  // person's record is not offered as a fallback. So a missing hri_access_log does not degrade the
  // feature, it closes it, and the sentence the operator gets says the access could not be recorded
  // without saying that the table it would go in does not exist.
  //
  // NO ORDER DEPENDENCY. The only REFERENCES inside this module point at hri_development_plans,
  // which its own DDL creates first; nothing here references another module's table.
  { name: 'hr-intelligence', run: async () => (await import('@/lib/hr-intelligence/schema')).ensureHrIntelSchema() },
  // These two have no exported ensure; a harmless READ triggers the same internal bootstrap.
  { name: 'error-log', run: async () => (await import('@/lib/logger')).recentErrors(1) },
  { name: 'job-queue', run: async () => (await import('@/lib/job-queue')).claimBatch(0) },
];

/** One module's outcome, in the shape both surfaces report. */
export interface BootstrapOutcome {
  module: string;
  ok: boolean;
  /** The real Postgres reason (e.cause.message), never the failed SQL. */
  error?: string;
  /** True when this module was refused by a connection an EARLIER module poisoned, then retried. */
  retriedAfterSweep?: boolean;
}

/**
 * Run every module bootstrap, in order, and report honestly what each one did.
 *
 * THE CALLER MUST ALREADY BE INSIDE allowingDdl(). This does not open that scope itself, because
 * deciding that an operator asked for DDL is a permission question and belongs at the surface that
 * checked the permission — not in a helper that anything could import.
 *
 * ONE FAILURE IS NOT ALLOWED TO BE REPORTED AS TWENTY. SQLSTATE 25P02 ("current transaction is
 * aborted") says the CONNECTION is unusable, not that this module is wrong; before 2026-08-24 one
 * poisoned connection made every module after it look broken and left the real cause off the screen
 * entirely. Such a module is swept and retried once, and counted as failed only if it fails again on
 * a clean connection.
 */
export async function runBootstrapModules(
  modules: BootstrapModule[] = BOOTSTRAP_MODULE_LIST,
): Promise<BootstrapOutcome[]> {
  const { healAbortedTransactions, isAbortedTransaction } = await import('@/lib/db');
  const results: BootstrapOutcome[] = [];
  for (const m of modules) {
    try {
      await m.run();
      results.push({ module: m.name, ok: true });
      continue;
    } catch (e: any) {
      // The real Postgres reason is on e.cause; e.message is only the failed SQL. Never swallowed —
      // one module failing must not hide behind the ones that worked.
      const why = e?.cause?.message || e?.message || 'unknown error';
      console.error('[bootstrap] ' + m.name + ' failed:', why);
      if (!isAbortedTransaction(e)) {
        results.push({ module: m.name, ok: false, error: why });
        continue;
      }
      // Not this module's fault. Clear the pool and give it the fair attempt it never had.
      await healAbortedTransactions().catch(() => {});
      try {
        await m.run();
        results.push({ module: m.name, ok: true, retriedAfterSweep: true });
      } catch (e2: any) {
        const why2 = e2?.cause?.message || e2?.message || 'unknown error';
        console.error('[bootstrap] ' + m.name + ' failed after sweep:', why2);
        results.push({ module: m.name, ok: false, error: why2, retriedAfterSweep: true });
      }
    }
  }
  // Before the caller's verification query and anything else it renders. Nothing should have
  // poisoned anything; this costs one round trip on the runs where something did.
  await healAbortedTransactions().catch(() => {});
  return results;
}
