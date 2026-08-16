// src/lib/mailgov/health.ts — WHAT IS ACTUALLY TRUE ABOUT THIS DEPLOYMENT.
//
// Not "is the platform healthy" in the green-tick sense. This answers the questions an operator has
// when something is wrong and the console is the only thing they can see:
//
//   Do the governance tables exist here at all?
//   Is the audit log's append-only rule enforced by the DATABASE, or only by our code not issuing an
//     UPDATE? Those are different guarantees and only one of them survives somebody with psql.
//   Does the chain verify right now?
//   Is there anywhere to put an export, or would every export fail at the last step?
//   Is anything stuck: exports pending for hours, deletions blocked, retention never run?
//
// EVERY FIELD IS OBSERVED, NOT ASSUMED. `to_regclass` for the tables, `pg_trigger` for the trigger,
// a real chain walk for the audit, the actual storage backend for exports. This project has shipped a
// bootstrap that reported `ok: true, ran: 8, failed: 0` while ten tables were missing, and a mail
// health screen that drew "no transport configured" over a working mail server. A health screen that
// reports intentions is worse than no health screen, because somebody believes it.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { storageBackend, storageProvisioned } from '@/lib/storage';
import { GOVERNANCE_TABLES, auditTriggerInstalled, dbReason, ensureGovernanceSchema, rows, tablesExisting } from './schema';
import { verifyAuditChain } from './audit';

export interface HealthCheck {
  key: string;
  label: string;
  /** 'ok' | 'warn' | 'fail' | 'unknown'. `unknown` means the check itself could not run. */
  state: 'ok' | 'warn' | 'fail' | 'unknown';
  /** One sentence. Names what is wrong and what to do, never just "error". */
  detail: string;
}

export interface GovernanceHealth {
  checks: HealthCheck[];
  tables: { name: string; present: boolean }[];
  auditTrigger: boolean;
  chainOk: boolean | null;
  chainDetail: string;
  storage: { backend: string; provisioned: boolean };
  queues: { exportsPending: number; exportsFailed: number; deletionsScheduled: number; deletionsBlocked: number };
  retention: { lastRunAt: string | null; policies: number };
  worstState: 'ok' | 'warn' | 'fail' | 'unknown';
}

export async function governanceHealth(): Promise<GovernanceHealth> {
  const checks: HealthCheck[] = [];
  const out: GovernanceHealth = {
    checks,
    tables: [],
    auditTrigger: false,
    chainOk: null,
    chainDetail: 'Not checked.',
    storage: { backend: storageBackend(), provisioned: storageProvisioned() },
    queues: { exportsPending: 0, exportsFailed: 0, deletionsScheduled: 0, deletionsBlocked: 0 },
    retention: { lastRunAt: null, policies: 0 },
    worstState: 'ok',
  };

  // ---- schema ---------------------------------------------------------------------------------
  try {
    await ensureGovernanceSchema();
  } catch (e: any) {
    checks.push({
      key: 'schema.ensure', label: 'Governance schema', state: 'fail',
      detail: 'The schema could not be created or verified: ' + dbReason(e),
    });
  }

  const present = await tablesExisting([...GOVERNANCE_TABLES]);
  out.tables = GOVERNANCE_TABLES.map((t) => ({ name: t, present: present.has(t) }));
  const missing = out.tables.filter((t) => !t.present).map((t) => t.name);
  checks.push(missing.length
    ? { key: 'schema.tables', label: 'Governance tables', state: 'fail', detail: missing.length + ' missing: ' + missing.join(', ') + '. The screens that read them will be empty and that emptiness is not data.' }
    : { key: 'schema.tables', label: 'Governance tables', state: 'ok', detail: 'All ' + out.tables.length + ' present.' });

  // ---- the append-only guarantee ---------------------------------------------------------------
  out.auditTrigger = await auditTriggerInstalled();
  checks.push(out.auditTrigger
    ? { key: 'audit.trigger', label: 'Audit log immutability', state: 'ok', detail: 'The database refuses UPDATE on the audit log, and refuses DELETE outside a retention prune.' }
    : {
        key: 'audit.trigger', label: 'Audit log immutability', state: 'warn',
        detail: 'The database trigger is NOT installed, so append-only rests on this codebase issuing no UPDATE — which is true today and is a weaker guarantee than the database enforcing it. Re-run the schema ensure with a role that may create functions and triggers.',
      });

  // ---- the chain -------------------------------------------------------------------------------
  const chain = await verifyAuditChain({ limit: 500 });
  if (chain.readError) {
    out.chainOk = null;
    out.chainDetail = 'The audit log could not be read (' + chain.readError + '), so the chain was not verified. This is not the same as a broken chain.';
    checks.push({ key: 'audit.chain', label: 'Audit chain', state: 'unknown', detail: out.chainDetail });
  } else if (chain.ok) {
    out.chainOk = true;
    out.chainDetail = 'The last ' + (chain.verdict?.checked || 0) + ' of ' + chain.total + ' events verify, hash by hash.';
    checks.push({ key: 'audit.chain', label: 'Audit chain', state: 'ok', detail: out.chainDetail });
  } else {
    out.chainOk = false;
    out.chainDetail = chain.verdict?.reason
      || (chain.contentMismatches.length ? 'Events ' + chain.contentMismatches.join(', ') + ' no longer match their recorded hash.' : 'The chain did not verify.');
    checks.push({ key: 'audit.chain', label: 'Audit chain', state: 'fail', detail: out.chainDetail + ' Treat the log as compromised until this is explained.' });
  }

  // ---- storage ---------------------------------------------------------------------------------
  checks.push(out.storage.provisioned
    ? { key: 'export.storage', label: 'Export storage', state: 'ok', detail: 'Artifacts are written to ' + out.storage.backend + '.' }
    : {
        key: 'export.storage', label: 'Export storage', state: 'warn',
        detail: 'No object storage is configured (the active backend is "' + out.storage.backend + '", whose writes are discarded). Small exports are stored on the job row instead; anything larger is refused with a reason rather than reported ready. Set the S3_* variables to fix it.',
      });

  // ---- queues and retention ----------------------------------------------------------------------
  try {
    const q = rows(await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM mailapi_export_jobs WHERE status = 'pending') AS exports_pending,
        (SELECT COUNT(*)::int FROM mailapi_export_jobs WHERE status = 'failed') AS exports_failed,
        (SELECT COUNT(*)::int FROM mailapi_deletion_jobs WHERE status = 'scheduled') AS deletions_scheduled,
        (SELECT COUNT(*)::int FROM mailapi_deletion_jobs WHERE status = 'blocked') AS deletions_blocked,
        (SELECT COUNT(*)::int FROM mailapi_retention_policies WHERE enabled = true) AS policies,
        (SELECT MAX(started_at) FROM mailapi_retention_runs) AS last_run_at,
        (SELECT COUNT(*)::int FROM mailapi_export_jobs
          WHERE status = 'pending' AND created_at < now() - interval '1 hour') AS exports_stuck`))[0];

    out.queues = {
      exportsPending: Number(q?.exports_pending) || 0,
      exportsFailed: Number(q?.exports_failed) || 0,
      deletionsScheduled: Number(q?.deletions_scheduled) || 0,
      deletionsBlocked: Number(q?.deletions_blocked) || 0,
    };
    out.retention = {
      lastRunAt: q?.last_run_at ? new Date(q.last_run_at).toISOString() : null,
      policies: Number(q?.policies) || 0,
    };

    const stuck = Number(q?.exports_stuck) || 0;
    checks.push(stuck
      ? { key: 'export.worker', label: 'Export worker', state: 'warn', detail: stuck + ' export(s) have been pending for over an hour. The worker is not running: check the scheduled call to /api/mail/gov/worker.' }
      : { key: 'export.worker', label: 'Export worker', state: 'ok', detail: out.queues.exportsPending + ' pending, ' + out.queues.exportsFailed + ' failed.' });

    checks.push(out.queues.deletionsBlocked
      ? { key: 'deletion.blocked', label: 'Deletions', state: 'warn', detail: out.queues.deletionsBlocked + ' deletion(s) blocked — usually a legal hold, occasionally a missing approval. Each one names its reason.' }
      : { key: 'deletion.blocked', label: 'Deletions', state: 'ok', detail: out.queues.deletionsScheduled + ' scheduled, none blocked.' });

    if (!out.retention.policies) {
      checks.push({ key: 'retention.policies', label: 'Retention', state: 'warn', detail: 'No tenant has written a retention policy, so every class is running on the platform default. That is a valid state and worth knowing.' });
    } else if (!out.retention.lastRunAt) {
      checks.push({ key: 'retention.policies', label: 'Retention', state: 'warn', detail: out.retention.policies + ' policies are configured and the sweep has NEVER run. Configured retention that never executes is the failure this check exists for.' });
    } else {
      checks.push({ key: 'retention.policies', label: 'Retention', state: 'ok', detail: out.retention.policies + ' policies, last swept ' + out.retention.lastRunAt + '.' });
    }
  } catch (e: any) {
    checks.push({ key: 'queues', label: 'Jobs and retention', state: 'unknown', detail: 'Counters could not be read: ' + dbReason(e) });
  }

  const rank = { ok: 0, warn: 1, unknown: 2, fail: 3 } as const;
  out.worstState = checks.reduce<HealthCheck['state']>((worst, c) => (rank[c.state] > rank[worst] ? c.state : worst), 'ok');
  return out;
}
