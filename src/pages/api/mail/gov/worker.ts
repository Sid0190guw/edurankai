// POST/GET /api/mail/gov/worker — the background pass for governance work.
//
// Runs, in order: export jobs waiting to be built, deletion jobs whose grace window has elapsed,
// expiry of exports whose download window has closed, and the retention sweep for every organization
// with a policy.
//
// AUTHORISED BY cronAuth(), NOT BY A SESSION. src/middleware.ts exempts everything under /api/,
// so this endpoint's own check IS the gate — and src/lib/auth/cron-auth.ts fails CLOSED when
// CRON_SECRET is absent, which is the correct direction for an endpoint that can delete a tenant's
// data. A job that does not run is visible (exports queue up, and governanceHealth() says so); a job
// endpoint anybody may call is invisible and costs whatever the job can do.
//
// IT DOES A BOUNDED AMOUNT OF WORK PER CALL. A few exports, a few deletions, and the retention sweep
// for a handful of organizations — then it returns and says what is left. A worker that tries to
// drain the whole queue in one request is a worker that times out at the edge halfway through a
// deletion, which is the single worst place to be interrupted.
import type { APIRoute } from 'astro';
import { govJson } from '@/lib/mailgov/http';
import { cronAuth } from '@/lib/auth/cron-auth';
import { logEvent } from '@/lib/logger';
import { expireExports, pendingExports, runExportJob } from '@/lib/mailgov/exports';
import { dueDeletions, runDeletionJob } from '@/lib/mailgov/deletion';
import { organizationsWithPolicies, runSweep } from '@/lib/mailgov/retention';
import { recordAudit, AUDIT_ACTIONS } from '@/lib/mailgov/audit';
import type { GovActor } from '@/lib/mailgov/policy';

const MAX_EXPORTS = 3;
const MAX_DELETIONS = 2;
const MAX_SWEEPS = 5;

/**
 * The worker acts as the platform itself, not as a person.
 *
 * A null userId in an audit event reads as "the system did this", which is exactly right for a
 * scheduled sweep — and it is visibly different from a named administrator's action, so nobody can
 * later mistake an automated prune for somebody's decision.
 */
const SYSTEM_ACTOR: GovActor = {
  userId: null, email: 'system@worker', role: 'platform_owner', orgId: null, via: 'none',
};

async function run(request: Request): Promise<Response> {
  const auth = cronAuth(request);
  if (!auth.allowed) {
    // The reason is logged, not returned: telling an unauthorised caller that the secret is simply
    // not configured tells them to keep trying after the next deploy.
    logEvent('warn', 'mailgov.worker.refused', { reason: auth.reason });
    return govJson({ ok: false, error: 'unauthorized' }, 401);
  }

  const started = Date.now();
  const report = {
    exports: { run: 0, ok: 0, failed: 0, remaining: 0 },
    deletions: { run: 0, ok: 0, blocked: 0, failed: 0, remaining: 0 },
    expired: 0,
    sweeps: { organizations: 0, affected: 0, failed: 0 },
    errors: [] as string[],
  };

  // ---- exports --------------------------------------------------------------------------------
  try {
    const pending = await pendingExports(MAX_EXPORTS + 1);
    report.exports.remaining = Math.max(0, pending.length - MAX_EXPORTS);
    for (const id of pending.slice(0, MAX_EXPORTS)) {
      report.exports.run++;
      const r = await runExportJob(id);
      if (r.ok) {
        report.exports.ok++;
        await recordAudit({
          actor: SYSTEM_ACTOR, action: AUDIT_ACTIONS.EXPORT_COMPLETED,
          targetType: 'export', targetId: id, result: 'ok',
          reason: 'Export built by the scheduled worker.', meta: { rows: r.rows || 0 },
        });
      } else {
        report.exports.failed++;
        report.errors.push('export ' + id + ': ' + (r.error || 'unknown'));
      }
    }
  } catch (e: any) {
    report.errors.push('exports: ' + String(e?.cause?.message || e?.message || e));
  }

  try {
    report.expired = await expireExports();
  } catch (e: any) {
    report.errors.push('expiry: ' + String(e?.cause?.message || e?.message || e));
  }

  // ---- deletions -------------------------------------------------------------------------------
  try {
    const due = await dueDeletions(new Date(), MAX_DELETIONS + 1);
    report.deletions.remaining = Math.max(0, due.length - MAX_DELETIONS);
    for (const id of due.slice(0, MAX_DELETIONS)) {
      report.deletions.run++;
      // The audit event is written BEFORE the deletion runs, by the same rule the interactive path
      // follows: an unrecordable deletion does not happen.
      const pre = await recordAudit({
        actor: SYSTEM_ACTOR, action: AUDIT_ACTIONS.DELETION_EXECUTED,
        targetType: 'deletion_job', targetId: id, result: 'ok',
        reason: 'Grace window elapsed; executed by the scheduled worker.',
      });
      if (!pre.ok) {
        report.deletions.failed++;
        report.errors.push('deletion ' + id + ': not started, the audit event could not be written (' + (pre.error || 'unknown') + ')');
        continue;
      }
      const r = await runDeletionJob(id);
      if (r.ok) report.deletions.ok++;
      else if (r.blocked) {
        report.deletions.blocked++;
        report.errors.push('deletion ' + id + ' blocked: ' + r.blocked);
      } else {
        report.deletions.failed++;
        report.errors.push('deletion ' + id + ': ' + (r.error || 'unknown'));
      }
    }
  } catch (e: any) {
    report.errors.push('deletions: ' + String(e?.cause?.message || e?.message || e));
  }

  // ---- retention -------------------------------------------------------------------------------
  try {
    const orgs = await organizationsWithPolicies();
    for (const orgId of orgs.slice(0, MAX_SWEEPS)) {
      report.sweeps.organizations++;
      const sweep = await runSweep({ orgId, dryRun: false, byUserId: null });
      report.sweeps.affected += sweep.totalAffected;
      if (!sweep.ok) {
        report.sweeps.failed++;
        report.errors.push('sweep ' + orgId + ': ' + (sweep.error || 'unknown'));
      }
      const failedClasses = sweep.outcomes.filter((o) => !o.ok);
      if (failedClasses.length) {
        report.errors.push('sweep ' + orgId + ': ' + failedClasses.map((f) => f.dataClass + ' (' + (f.error || 'unknown') + ')').join(', '));
      }
      if (sweep.totalAffected > 0) {
        await recordAudit({
          actor: SYSTEM_ACTOR, action: AUDIT_ACTIONS.RETENTION_SWEPT, orgId,
          targetType: 'organization', targetId: orgId, result: 'ok',
          reason: 'Scheduled retention sweep.',
          meta: { outcomes: sweep.outcomes.map((o) => ({ dataClass: o.dataClass, affected: o.affected, skippedHeld: o.skippedHeld })) },
        });
      }
    }
    if (orgs.length > MAX_SWEEPS) {
      // A cap that is not mentioned is a cap somebody reads as "everything was swept".
      report.errors.push(orgs.length - MAX_SWEEPS + ' organization(s) were not swept on this pass; they run on the next one.');
    }
  } catch (e: any) {
    report.errors.push('retention: ' + String(e?.cause?.message || e?.message || e));
  }

  logEvent('info', 'mailgov.worker.pass', { ms: Date.now() - started, ...report.exports, errors: report.errors.length });
  return govJson({ ok: report.errors.length === 0, ms: Date.now() - started, ...report });
}

export const POST: APIRoute = async ({ request }) => run(request);
export const GET: APIRoute = async ({ request }) => run(request);
