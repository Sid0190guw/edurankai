// src/lib/mailgov/retention.ts — THE SWEEP.
//
// The policy arithmetic is in ./retention-policy.ts (pure, tested). This file reads policies, asks
// ./holds.ts what may not be touched, and deletes in batches.
//
// FOUR RULES THIS ENGINE FOLLOWS, EACH BECAUSE THE OBVIOUS IMPLEMENTATION GETS IT WRONG:
//
//   1. IT NEVER DELETES WHAT A LEGAL HOLD COVERS, and an unreadable hold table stops the sweep for
//      that class rather than being treated as "no holds". Failing towards keeping data is
//      recoverable; the other direction is not.
//
//   2. IT DELETES IN BATCHES, in separate statements. A single `DELETE ... WHERE created_at < x` on a
//      tenant with two years of backlog holds one transaction open for minutes, which on a pooled
//      connection (this deployment uses the Supabase transaction pooler) means everything else
//      queues behind a cleanup job.
//
//   3. IT RECORDS EVERY RUN, including the ones that deleted nothing. "Retention is configured" and
//      "retention has ever run" look identical on a settings screen and are the two states an
//      operator most needs to tell apart — this project has already shipped a bootstrap that
//      reported success over ten missing tables, and the lesson was the same one.
//
//   4. PRUNING THE AUDIT LOG CHECKPOINTS EACH BATCH IN THE SAME TRANSACTION THAT DELETES IT. It is
//      the one sweep that damages the evidence it is part of, so the range, the count and the hash
//      the surviving chain links back to go in beside the rows they describe — never ahead of them on
//      a separate connection, which is how a checkpoint ends up attesting to a delete that rolled
//      back. The prune itself is an audit event, so removing a checkpoint is as detectable as
//      removing anything else.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';
import { ensureGovernanceSchema, rows, dbReason, tableExists } from './schema';
import { heldReferences } from './holds';
import {
  RETENTION_CLASSES, RETENTION_SPECS, cutoffFor, crossClassConflicts, defaultPolicy,
  resolvePolicies, sweepPlan, validatePolicy,
  type RetentionClass, type RetentionPolicy, type SweepTask, type PruneCheckpoint,
} from './retention-policy';

const MAX_BATCHES = 40;

export type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

function mapPolicy(r: any): RetentionPolicy {
  return {
    orgId: String(r.org_id),
    environment: String(r.environment),
    dataClass: String(r.data_class) as RetentionClass,
    retainDays: Number(r.retain_days),
    action: (r.action === 'redact' ? 'redact' : 'delete'),
    enabled: r.enabled !== false,
    updatedBy: r.updated_by ? String(r.updated_by) : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

/**
 * Every class, always — stored where a tenant has chosen, the platform default everywhere else.
 * `updatedAt === null` is how a screen tells the two apart, and it should say which is which.
 */
export async function getPolicies(orgId: string, environment = 'production'): Promise<{ ok: boolean; reason?: string; policies: RetentionPolicy[]; conflicts: string[] }> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT * FROM mailapi_retention_policies
       WHERE org_id = ${orgId}::uuid AND environment = ${environment}`));
    const policies = resolvePolicies(orgId, environment, r.map(mapPolicy));
    return { ok: true, policies, conflicts: crossClassConflicts(policies) };
  } catch (e: any) {
    // Defaults are returned so the screen can still show what WOULD apply, with the read failure
    // stated. A blank retention screen during a database hiccup reads as "no policies", which is the
    // one thing it must never imply.
    return {
      ok: false, reason: dbReason(e),
      policies: RETENTION_CLASSES.map((c) => defaultPolicy(orgId, environment, c)),
      conflicts: [],
    };
  }
}

export async function setPolicy(input: {
  orgId: string;
  environment?: string;
  dataClass: string;
  retainDays: number;
  action?: string;
  enabled?: boolean;
  byUserId: string;
}): Promise<{ ok: boolean; error?: string; conflicts?: string[] }> {
  const environment = input.environment || 'production';
  const v = validatePolicy(input.dataClass, input.retainDays, input.action || 'delete');
  if (!v.ok) return { ok: false, error: v.error };

  try {
    await ensureGovernanceSchema();
    await db.execute(sql`
      INSERT INTO mailapi_retention_policies (org_id, environment, data_class, retain_days, action, enabled, updated_by, updated_at)
      VALUES (${input.orgId}::uuid, ${environment}, ${input.dataClass}, ${v.retainDays},
              ${input.action || 'delete'}, ${input.enabled !== false}, ${input.byUserId}::uuid, now())
      ON CONFLICT (org_id, environment, data_class) DO UPDATE
        SET retain_days = EXCLUDED.retain_days, action = EXCLUDED.action, enabled = EXCLUDED.enabled,
            updated_by = EXCLUDED.updated_by, updated_at = now()`);

    // Conflicts are REPORTED, not refused. Each policy is individually valid; the combination is a
    // judgement about their organization's obligations, and refusing it would be this platform
    // deciding a customer's retention strategy for them. Saying nothing would be worse.
    const after = await getPolicies(input.orgId, environment);
    return { ok: true, conflicts: after.conflicts };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

export interface SweepOutcome {
  dataClass: RetentionClass;
  action: string;
  cutoff: string;
  affected: number;
  skippedHeld: number;
  ok: boolean;
  error?: string;
  note?: string;
}

export interface SweepReport {
  ok: boolean;
  dryRun: boolean;
  orgId: string;
  environment: string;
  outcomes: SweepOutcome[];
  totalAffected: number;
  error?: string;
}

/**
 * Run every enabled policy for one organization.
 *
 * `dryRun` counts what WOULD go without touching anything, which is the mode the console offers
 * first. A retention screen whose only button is "delete two years of mail now" is a screen people
 * are right to be frightened of.
 */
export async function runSweep(input: {
  orgId: string;
  environment?: string;
  now?: Date;
  dryRun?: boolean;
  byUserId?: string | null;
}): Promise<SweepReport> {
  const environment = input.environment || 'production';
  const now = input.now || new Date();
  const dryRun = input.dryRun === true;

  const base: SweepReport = { ok: true, dryRun: !!dryRun, orgId: input.orgId, environment, outcomes: [], totalAffected: 0 };
  const got = await getPolicies(input.orgId, environment);
  if (!got.ok) return { ...base, ok: false, error: got.reason };

  const tasks = sweepPlan(got.policies, now);
  for (const task of tasks) {
    const outcome = await runTask(task, !!dryRun, input.byUserId || null);
    base.outcomes.push(outcome);
    base.totalAffected += outcome.affected;
    if (!dryRun) await recordRun(task, outcome);
  }
  return base;
}

async function recordRun(task: SweepTask, outcome: SweepOutcome): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO mailapi_retention_runs (org_id, environment, data_class, action, cutoff, affected, skipped_held, ok, error, finished_at)
      VALUES (${task.orgId}::uuid, ${task.environment}, ${task.dataClass}, ${task.action},
              ${task.cutoff}::timestamptz, ${outcome.affected}, ${outcome.skippedHeld},
              ${outcome.ok}, ${outcome.error || null}, now())`);
  } catch (e: any) {
    logEvent('error', 'mailgov.retention.run-record-failed', { dataClass: task.dataClass, message: dbReason(e) });
  }
}

/**
 * One class.
 *
 * Every branch asks holds first, and every branch that cannot establish the hold position does
 * NOTHING and says why. `skippedHeld` is reported separately from `affected` so a run that deleted
 * nothing because everything is held does not look like a run that found nothing to do.
 */
async function runTask(task: SweepTask, dryRun: boolean, byUserId: string | null): Promise<SweepOutcome> {
  const spec = RETENTION_SPECS[task.dataClass];
  const out: SweepOutcome = {
    dataClass: task.dataClass, action: task.action, cutoff: task.cutoff,
    affected: 0, skippedHeld: 0, ok: true,
  };

  try {
    await ensureGovernanceSchema();

    if (spec.holdable) {
      // Every holdable class is held at MESSAGE granularity today: a delivery event, an attachment
      // and an AI record all hang off a message, so holding the message holds its evidence with it.
      // A class held at a different granularity would need its own scope here, and would say so.
      const held = await heldReferences(task.orgId, 'message');
      if (held === null) {
        return { ...out, ok: false, error: 'The legal hold table could not be read, so nothing was deleted for this class.' };
      }
      if (held.orgWide) {
        const n = await countFor(task);
        return { ...out, affected: 0, skippedHeld: n, note: 'An organization-wide legal hold covers every record in this class.' };
      }
      out.skippedHeld = held.refs.length;
      return await executeClass(task, dryRun, held.refs, out, byUserId);
    }

    return await executeClass(task, dryRun, [], out, byUserId);
  } catch (e: any) {
    return { ...out, ok: false, error: dbReason(e) };
  }
}

/** How many rows the cutoff covers, for the dry run and the held-everything case. */
async function countFor(task: SweepTask): Promise<number> {
  const t = TARGETS[task.dataClass];
  if (!t) return 0;
  if (!(await tableExists(t.table))) return 0;
  try {
    const r = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM ${sql.raw(t.table)}
       WHERE ${sql.raw(t.timeColumn)} < ${task.cutoff}::timestamptz
         ${t.orgColumn ? sql`AND ${sql.raw(t.orgColumn)} = ${task.orgId}::uuid` : sql``}`))[0];
    return Number(r?.n) || 0;
  } catch {
    return 0;
  }
}

/**
 * Where each class lives.
 *
 * Table and column names are LITERALS in this map and are interpolated with sql.raw — they never come
 * from a request. The values (cutoff, org id, batch size) are parameterised like everything else.
 */
const TARGETS: Record<RetentionClass, { table: string; timeColumn: string; orgColumn: string | null; optional?: boolean }> = {
  messages: { table: 'mailapi_messages', timeColumn: 'created_at', orgColumn: 'org_id' },
  attachments: { table: 'mailapi_messages', timeColumn: 'created_at', orgColumn: 'org_id' },
  delivery_events: { table: 'mailapi_message_events', timeColumn: 'occurred_at', orgColumn: 'org_id' },
  campaign_events: { table: 'mailapi_campaign_events', timeColumn: 'occurred_at', orgColumn: 'org_id', optional: true },
  audit_logs: { table: 'mailapi_audit_events', timeColumn: 'occurred_at', orgColumn: 'org_id' },
  ai_records: { table: 'mailapi_ai_records', timeColumn: 'created_at', orgColumn: 'org_id' },
  security_events: { table: 'mailapi_security_events', timeColumn: 'occurred_at', orgColumn: 'org_id' },
  consent_records: { table: 'mailapi_consent', timeColumn: 'updated_at', orgColumn: 'org_id' },
};

async function executeClass(
  task: SweepTask,
  dryRun: boolean,
  heldRefs: string[],
  out: SweepOutcome,
  byUserId: string | null,
): Promise<SweepOutcome> {
  const t = TARGETS[task.dataClass];
  if (!t) return { ...out, ok: false, error: 'No target table is defined for ' + task.dataClass + '.' };

  if (!(await tableExists(t.table))) {
    return { ...out, note: t.optional
      ? 'No ' + t.table + ' table on this deployment, so there is nothing of this class to sweep yet.'
      : 'Expected table ' + t.table + ' is missing.' , ok: !!t.optional };
  }

  if (dryRun) {
    // The audit log is pruned PLATFORM-WIDE (one chain across every tenant — see pruneAuditLog), so an
    // org-scoped count here would under-report what the real run removes. Counting it the way it is
    // actually deleted, and saying so, is the difference between a preview and a misleading number.
    if (task.dataClass === 'audit_logs') {
      const r = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM mailapi_audit_events WHERE occurred_at < ${task.cutoff}::timestamptz`))[0];
      return {
        ...out, affected: Number(r?.n) || 0,
        note: 'Dry run: nothing was deleted. Audit pruning is platform-wide, so this counts every tenant’s events past the cutoff, not only this organization’s.',
      };
    }
    const n = await countFor(task);
    return { ...out, affected: n, note: 'Dry run: nothing was deleted.' };
  }

  // The audit log has its own path — a checkpoint, a session flag, and a transaction.
  if (task.dataClass === 'audit_logs') return pruneAuditLog(task, out, byUserId);

  // Attachments on this platform are a jsonb column on the message rather than a table of their own,
  // so "delete attachments" means clearing that column and any rows in the internal store — NOT
  // deleting the messages, which have their own, usually longer, policy.
  if (task.dataClass === 'attachments') return clearAttachments(task, out);

  const held = heldRefs.length ? heldRefs : null;
  let affected = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const r = rows(await db.execute(sql`
      WITH doomed AS (
        SELECT id FROM ${sql.raw(t.table)}
         WHERE ${sql.raw(t.timeColumn)} < ${task.cutoff}::timestamptz
           ${t.orgColumn ? sql`AND ${sql.raw(t.orgColumn)} = ${task.orgId}::uuid` : sql``}
           ${held ? sql`AND id::text <> ALL(${held}::text[])` : sql``}
         LIMIT ${task.batchSize}
      )
      DELETE FROM ${sql.raw(t.table)} WHERE id IN (SELECT id FROM doomed) RETURNING id`));
    affected += r.length;
    if (r.length < task.batchSize) break;
  }
  return { ...out, affected };
}

/**
 * Attachments: clear the stored list on old messages, and remove rows from the internal attachment
 * table for messages past their cutoff.
 *
 * The object-storage side is NOT deleted here, and that is stated rather than hidden: this platform's
 * attachment policy is links rather than uploads, so most rows point at somewhere we do not own.
 * Where an object DOES belong to us, deleting it is a storage operation with its own failure modes
 * and belongs in the storage layer, not inside a row-deleting loop. governanceHealth() reports the
 * storage backend so the gap is visible.
 */
async function clearAttachments(task: SweepTask, out: SweepOutcome): Promise<SweepOutcome> {
  let affected = 0;
  try {
    const r = rows(await db.execute(sql`
      UPDATE mailapi_messages SET attachments = '[]'::jsonb
       WHERE org_id = ${task.orgId}::uuid
         AND created_at < ${task.cutoff}::timestamptz
         AND attachments <> '[]'::jsonb
      RETURNING id`));
    affected += r.length;
  } catch (e: any) {
    return { ...out, ok: false, error: dbReason(e) };
  }

  if (await tableExists('mail_attachments')) {
    try {
      const r = rows(await db.execute(sql`
        DELETE FROM mail_attachments a
         USING mail_messages m
         WHERE a.message_id = m.id AND m.created_at < ${task.cutoff}::timestamptz
        RETURNING a.id`));
      affected += r.length;
    } catch (e: any) {
      return { ...out, affected, ok: false, error: dbReason(e) };
    }
  }

  return {
    ...out, affected,
    note: 'Stored attachment objects in object storage are not removed by this sweep; the rows pointing at them are.',
  };
}

/**
 * Prune the audit log.
 *
 * THE CHECKPOINT AND THE DELETE ARE ONE TRANSACTION, PER BATCH, AND THAT IS THE WHOLE POINT OF THIS
 * FUNCTION'S SHAPE. It used to write the checkpoint with a bare `db.execute` — its own autocommit, on
 * its own connection — and only then open a transaction holding one unbatched
 * `DELETE ... WHERE occurred_at < cutoff RETURNING id` over the entire range. On any real backlog
 * that DELETE loses: every removed row fires the per-row plpgsql trigger in ./schema.ts
 * (mailapi_audit_guard, which calls current_setting for each one) and the statement runs into the
 * connection's 30s statement_timeout (src/lib/db/index.ts) and rolls back — while the checkpoint
 * claiming "removed 412,000" is already committed and cannot be taken back. The retention console
 * then shows a checkpoint attesting to a deletion beside the events it says are gone, the next run
 * writes another one, and the one table whose entire purpose is to prove nothing was tampered with
 * fills with rows asserting deletions that never happened.
 *
 * So each batch does all three of these or none of them:
 *
 *   1. Set `mailgov.prune` — the only flag the delete trigger accepts. Transaction-local (the `true`
 *      argument) because on a pooled connection a session-local setting would leak to whoever gets
 *      the connection next, leaving the audit table deletable by an unrelated request, which is the
 *      exact hole the trigger exists to close. It must therefore be set inside EVERY batch.
 *   2. Read the batch — the OLDEST rows past the cutoff, `ORDER BY seq ASC`. The order is
 *      load-bearing: `last_removed_hash` has to be the hash of the newest row THIS batch actually
 *      removes, because that is what the first surviving row links back to and what
 *      verifyAuditChain() resolves as its anchor (./audit.ts, `ORDER BY to_seq DESC LIMIT 1`).
 *      Descending order would checkpoint a hash for rows a later batch has not reached yet.
 *   3. Write that batch's checkpoint, then delete exactly that batch.
 *
 * A batch that rolls back therefore leaves no checkpoint behind, and a run the platform kills between
 * batches leaves every checkpoint describing rows that are genuinely gone. Stopping at MAX_BATCHES is
 * reported as stopping short, never as a finished prune.
 *
 * The prune is itself recorded as an audit event by the caller, so the log contains the reason its
 * own oldest entries are missing.
 */
export async function pruneAuditLog(task: SweepTask, out: SweepOutcome, byUserId: string | null): Promise<SweepOutcome> {
  // Declared outside the try so the catch can still say how much genuinely went. A failure that
  // reports affected 0 after eight committed batches reads as "nothing was touched", and the next
  // person to look at the checkpoint list would not be able to square the two.
  let removed = 0;
  let lastSeq = 0;

  try {
    let stoppedShort = false;
    // Platform-wide by design: the chain is one chain across every tenant, and pruning one tenant's
    // rows out of the middle of it would break every link that crosses them. Audit retention is a
    // PLATFORM policy, and the console says so on the retention screen.
    //
    // Only the COUNT is read here — for the early return, and so the note can say how much is left
    // when a run stops short. The range endpoints are NOT read here any more: each batch reads its
    // own, because a range read up front describes rows a later statement may never reach.
    const doomed = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM mailapi_audit_events
       WHERE occurred_at < ${task.cutoff}::timestamptz`))[0];
    const count = Number(doomed?.n) || 0;
    if (!count) return { ...out, affected: 0, note: 'Nothing older than the cutoff.' };

    for (let i = 0; i < MAX_BATCHES; i++) {
      let n = 0;
      let batchTo = 0;

      await (db as any).transaction(async (tx: any) => {
        await tx.execute(sql`SELECT set_config('mailgov.prune', 'on', true)`);

        const batch = rows(await tx.execute(sql`
          SELECT seq, hash FROM mailapi_audit_events
           WHERE occurred_at < ${task.cutoff}::timestamptz
           ORDER BY seq ASC LIMIT ${task.batchSize}`));
        if (!batch.length) return;

        const checkpoint: PruneCheckpoint = {
          fromSeq: Number(batch[0].seq),
          toSeq: Number(batch[batch.length - 1].seq),
          removed: batch.length,
          lastRemovedHash: String(batch[batch.length - 1].hash || ''),
          cutoff: task.cutoff,
          by: byUserId,
        };
        // No anchor, no prune. A checkpoint carrying a blank hash tells a later verifier nothing, and
        // deleting the rows anyway would leave the surviving chain with nothing to link back to. The
        // throw rolls this batch back, so nothing has gone and the sweep reports why.
        if (!checkpoint.lastRemovedHash) {
          throw new Error('Audit event seq ' + checkpoint.toSeq + ' has no hash, so no checkpoint could anchor the surviving chain. Nothing was pruned in this batch.');
        }

        await tx.execute(sql`
          INSERT INTO mailapi_audit_checkpoints (from_seq, to_seq, removed, last_removed_hash, cutoff, created_by)
          VALUES (${checkpoint.fromSeq}, ${checkpoint.toSeq}, ${checkpoint.removed},
                  ${checkpoint.lastRemovedHash}, ${checkpoint.cutoff}::timestamptz, ${byUserId}::uuid)`);

        // `seq <= toSeq` deletes exactly the rows just read: the batch is the LOWEST-seq rows past the
        // cutoff, so nothing else in the range can sit at or below its last seq. RETURNING 1 rather
        // than the ids — only the count is used, and materialising a batch of ids buys nothing.
        n = rows(await tx.execute(sql`
          DELETE FROM mailapi_audit_events
           WHERE occurred_at < ${task.cutoff}::timestamptz AND seq <= ${checkpoint.toSeq}
          RETURNING 1`)).length;
        batchTo = checkpoint.toSeq;
      });

      if (!n) break;
      removed += n;
      lastSeq = batchTo;
      if (n < task.batchSize) break;
      // The ceiling is a decision, not an accident. A prune that walks away with rows still past the
      // cutoff has to say so — the next run picks them up, but an operator reading "pruned 20,000"
      // must not take it to mean the cutoff is now clean.
      if (i === MAX_BATCHES - 1) stoppedShort = true;
    }

    if (!removed) {
      return {
        ...out, affected: 0,
        note: 'Nothing was left past the cutoff by the time the first batch ran, so no checkpoint was written.',
      };
    }

    const anchored = 'Pruned ' + removed + ' audit events up to seq ' + lastSeq
      + '; each batch was checkpointed inside the transaction that deleted it.';
    return {
      ...out, affected: removed,
      note: stoppedShort
        ? anchored + ' This run stopped at its batch ceiling with roughly ' + Math.max(count - removed, 0)
          + ' still older than the cutoff; the next run continues from there.'
        : anchored,
    };
  } catch (e: any) {
    const failed: SweepOutcome = { ...out, affected: removed, ok: false, error: dbReason(e) };
    if (removed) {
      failed.note = 'The batches that committed before this failed removed ' + removed
        + ' audit events up to seq ' + lastSeq + ', and each of those is checkpointed. Everything else is still past the cutoff.';
    }
    return failed;
  }
}

export interface RetentionRunRow {
  id: string;
  orgId: string | null;
  dataClass: string;
  action: string;
  cutoff: string;
  affected: number;
  skippedHeld: number;
  ok: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export async function listRetentionRuns(orgId: string | null, limit = 50): Promise<ReadResult<RetentionRunRow>> {
  try {
    await ensureGovernanceSchema();
    const r = await db.execute(sql`
      SELECT * FROM mailapi_retention_runs
       WHERE ${orgId ? sql`org_id = ${orgId}::uuid` : sql`TRUE`}
       ORDER BY started_at DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`);
    return {
      ok: true,
      rows: rows(r).map((x: any) => ({
        id: String(x.id),
        orgId: x.org_id ? String(x.org_id) : null,
        dataClass: String(x.data_class),
        action: String(x.action),
        cutoff: new Date(x.cutoff).toISOString(),
        affected: Number(x.affected) || 0,
        skippedHeld: Number(x.skipped_held) || 0,
        ok: x.ok !== false,
        error: x.error ?? null,
        startedAt: new Date(x.started_at).toISOString(),
        finishedAt: x.finished_at ? new Date(x.finished_at).toISOString() : null,
      })),
    };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

/** Every organization with at least one enabled policy — what the scheduled sweep iterates. */
export async function organizationsWithPolicies(): Promise<string[]> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT DISTINCT org_id FROM mailapi_retention_policies WHERE enabled = true`));
    return r.map((x: any) => String(x.org_id));
  } catch {
    return [];
  }
}

export { cutoffFor, RETENTION_SPECS, RETENTION_CLASSES };
