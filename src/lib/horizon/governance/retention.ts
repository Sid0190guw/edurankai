// src/lib/horizon/governance/retention.ts — RETENTION CONTROLS, AND THE DELETION / ANONYMISATION
// WORKFLOW.
//
// =================================================================================================
// TWO DIFFERENT ACTS, KEPT APART ON PURPOSE
// =================================================================================================
//
//   RETENTION is a schedule. Every class of record has a period, a stated basis for that period, and
//   an action when it runs out. It applies to everybody and nobody has to ask for it.
//
//   ERASURE is a request about ONE person, made by a named human, approved by a DIFFERENT named
//   human, and executed against whichever patches have registered themselves as holding data for
//   that person.
//
// =================================================================================================
// THE RULE THAT MAKES THIS SAFE TO RUN AT ALL: THIS LAYER SWEEPS ONLY ITS OWN TABLES
// =================================================================================================
//
// Most of the records a retention policy needs to govern live in hzn_* tables owned by other HORIZON
// patches. It would be easy — and wrong — to put those table names in a map here and DELETE from
// them on a schedule. A retention job that reaches into another patch's storage is a cross-patch
// write, it breaks the moment that patch reshapes its table, and the first symptom is a feature
// quietly missing rows with nothing connecting the two events.
//
// So every policy row carries an `ownerModule`, and the sweep does one of two things with it:
//
//   owner is this layer   ->  it acts. Delete or anonymise, under the stated policy.
//   owner is another      ->  it COUNTS and REPORTS, and touches nothing. The number is shown on the
//                             console so somebody can see the backlog, and removing it is the owning
//                             patch's to do — through registerRetentionSweeper() below if they want
//                             this layer to drive the schedule.
//
// =================================================================================================
// WHY ANONYMISE IS THE DEFAULT AND DELETE IS NOT
// =================================================================================================
//
// `anonymise` severs the identity and keeps the aggregate; `delete` destroys the row. For an
// intelligence layer anonymise is usually the honest choice — statistics that describe nobody in
// particular are not the person's data, and destroying them to satisfy a request that was about the
// person is theatre. Where the record IS the person — their consent, the decisions taken about them
// — it is kept longer and reviewed by a human rather than expiring on a timer.
//
// AND THE AUDIT TRAIL IS NEVER SET TO DELETE AUTOMATICALLY. setRetentionPolicy() refuses it. A trail
// that expires on a schedule cannot answer a question asked after the schedule ran, and "the system
// deleted the evidence automatically" is not an answer anybody accepts.
import { ensureGovernanceSchema } from './schema';
import type { SubjectRef } from '@/lib/horizon/ids';
import type { ErasureRequest, ErasureStatus, GovernanceActor, GovernanceResult, RetentionPolicy } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reason = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const fail = (message: string): GovernanceResult<never> => ({ ok: false, error: message });

let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}
async function sqlTag(): Promise<any> {
  return (await import('drizzle-orm')).sql;
}

/** The subject kinds this layer will build a statement around. Anything else is refused outright. */
const SUBJECT_KINDS = ['employee', 'applicant'];

/**
 * Quote a value for the few statements that cannot be parameterised, because the table name they act
 * on is chosen at runtime and postgres will not take a table name as a bind parameter.
 *
 * Doubling the quote is correct escaping, but it is not what makes this safe on its own — what makes
 * it safe is that every value reaching here has already been checked against a fixed list or is a
 * timestamp this module generated. The escape is the second line of defence, not the first.
 */
function lit(value: string): string {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// ---------------------------------------------------------------------------------------------
// The classes, and who owns each one
// ---------------------------------------------------------------------------------------------

export interface RetentionTarget {
  recordClass: string;
  table: string;
  dateColumn: string;
  /** The module that owns the table. Only 'horizon.governance' is ever swept by this module. */
  ownerModule: string;
  /** Columns nulled when anonymising. `subject_id` is redacted to a constant, never nulled. */
  identityColumns: string[];
  dataClass: string;
  defaultDays: number;
  defaultAction: 'delete' | 'anonymise' | 'review';
  basis: string;
}

export const RETENTION_TARGETS: RetentionTarget[] = [
  // ---- owned here -----------------------------------------------------------------------------
  {
    recordClass: 'decision_log', table: 'hgov_decision_log', dateColumn: 'decided_at',
    ownerModule: 'horizon.governance', identityColumns: ['subject_id'],
    dataClass: 'operational', defaultDays: 2555, defaultAction: 'review',
    basis: 'Seven years. A decision about somebody\'s employment is the record that defends both sides of a dispute, and it has to outlive the employment.',
  },
  {
    recordClass: 'erasure_request', table: 'hgov_erasure_request', dateColumn: 'created_at',
    ownerModule: 'horizon.governance', identityColumns: ['subject_id'],
    dataClass: 'operational', defaultDays: 2555, defaultAction: 'review',
    basis: 'Seven years. The proof that somebody asked for erasure and that it was honoured must outlive the data it removed.',
  },
  // ---- owned elsewhere: counted and reported, never touched ------------------------------------
  {
    recordClass: 'access_log', table: 'hzn_access_log', dateColumn: 'created_at',
    ownerModule: 'horizon.schema', identityColumns: ['actor_id', 'actor_name', 'ip_address', 'subject_id'],
    dataClass: 'operational', defaultDays: 2555, defaultAction: 'review',
    basis: 'Seven years. The access trail must outlive the employment it records, and a person may ask for it long after leaving.',
  },
  {
    recordClass: 'computation', table: 'hzn_computation', dateColumn: 'started_at',
    ownerModule: 'horizon.schema', identityColumns: ['subject_id'],
    dataClass: 'inferred', defaultDays: 1095, defaultAction: 'anonymise',
    basis: 'Three years. Long enough to explain a decision that was challenged; the identity is severed after that and the run statistics are kept.',
  },
  {
    recordClass: 'intelligence_result', table: 'hzn_intelligence_result', dateColumn: 'computed_at',
    ownerModule: 'horizon.schema', identityColumns: ['subject_id'],
    dataClass: 'inferred', defaultDays: 1095, defaultAction: 'anonymise',
    basis: 'Three years, tied to the computation that produced it.',
  },
  {
    recordClass: 'feedback_contribution', table: 'hzn_feedback_contribution', dateColumn: 'created_at',
    ownerModule: 'horizon.feedback', identityColumns: ['subject_id'],
    dataClass: 'feedback', defaultDays: 1095, defaultAction: 'anonymise',
    basis: 'Three years. Kept while a review cycle can still be questioned, then de-identified.',
  },
  {
    recordClass: 'consent_event', table: 'hzn_consent_event', dateColumn: 'occurred_at',
    ownerModule: 'horizon.intake', identityColumns: ['subject_id'],
    dataClass: 'operational', defaultDays: 2555, defaultAction: 'review',
    basis: 'Seven years. Proof that consent was given, and that a withdrawal was actioned, has to outlive the processing it authorised.',
  },
];

const TARGET_BY_CLASS = new Map<string, RetentionTarget>(RETENTION_TARGETS.map((t) => [t.recordClass, t]));

export function retentionClasses(): string[] {
  return RETENTION_TARGETS.map((t) => t.recordClass);
}

export function retentionTarget(recordClass: string): RetentionTarget | null {
  return TARGET_BY_CLASS.get(recordClass) || null;
}

/** True only for classes this layer may act on. Everything else is counted and left alone. */
export function sweepableHere(recordClass: string): boolean {
  return TARGET_BY_CLASS.get(recordClass)?.ownerModule === 'horizon.governance';
}

/**
 * A patch that wants this layer to drive its retention schedule registers a sweeper.
 *
 * Rule 8, applied to deletion: the owning patch knows what a safe removal looks like in its own
 * tables, and this layer knows when the period is up. Neither half is enough on its own.
 */
export interface RetentionSweeper {
  recordClass: string;
  sweep(olderThan: Date, action: 'delete' | 'anonymise'): Promise<{ affected: number; note: string }>;
}

const SWEEPERS = new Map<string, RetentionSweeper>();

export function registerRetentionSweeper(s: RetentionSweeper): void {
  if (!s?.recordClass || typeof s.sweep !== 'function') return;
  if (!SWEEPERS.has(s.recordClass)) SWEEPERS.set(s.recordClass, s);
}

export function registeredSweepers(): string[] {
  return Array.from(SWEEPERS.keys());
}

// ---------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------

const mapPolicy = (r: any): RetentionPolicy => ({
  recordClass: String(r.record_class),
  ownerModule: String(r.owner_module),
  dataClass: String(r.data_class),
  retainDays: Number(r.retain_days),
  action: r.action,
  basis: String(r.basis),
  overriddenBy: r.overridden_by ? String(r.overridden_by) : null,
  updatedAt: String(r.updated_at),
});

/**
 * Write the code defaults into the table if they are not there yet.
 *
 * ON CONFLICT DO NOTHING, deliberately. An administrator who has set a period must not have it
 * silently reset on the next deploy — that is how a considered decision gets undone by a release
 * nobody connected to it.
 */
export async function ensureRetentionDefaults(): Promise<void> {
  try {
    await ensureGovernanceSchema();
    const db = await database();
    const sql = await sqlTag();
    for (const t of RETENTION_TARGETS) {
      await db.execute(sql`
        INSERT INTO hgov_retention_policy (record_class, owner_module, data_class, retain_days, action, basis)
        VALUES (${t.recordClass}, ${t.ownerModule}, ${t.dataClass}, ${t.defaultDays}, ${t.defaultAction}, ${t.basis})
        ON CONFLICT (record_class) DO NOTHING`);
    }
  } catch (e: any) {
    const { logEvent } = await import('@/lib/logger');
    logEvent('warn', 'horizon.governance.retention_defaults_failed', { message: reason(e) });
  }
}

export async function listRetentionPolicies(): Promise<RetentionPolicy[]> {
  try {
    await ensureRetentionDefaults();
    const db = await database();
    const sql = await sqlTag();
    const r = rows(await db.execute(sql`SELECT * FROM hgov_retention_policy ORDER BY owner_module ASC, record_class ASC`));
    if (r.length > 0) return r.map(mapPolicy);
  } catch { /* fall through to the code defaults */ }
  // The code defaults, so the screen shows the policy in force even when the table does not exist
  // yet. Marked as not overridden, which is exactly what they are.
  return RETENTION_TARGETS.map((t) => ({
    recordClass: t.recordClass, ownerModule: t.ownerModule, dataClass: t.dataClass,
    retainDays: t.defaultDays, action: t.defaultAction, basis: t.basis,
    overriddenBy: null, updatedAt: '',
  }));
}

export async function setRetentionPolicy(input: {
  recordClass: string;
  retainDays: number;
  action: 'delete' | 'anonymise' | 'review';
  basis: string;
  actor: GovernanceActor;
}): Promise<GovernanceResult> {
  const cls = String(input?.recordClass || '');
  const target = TARGET_BY_CLASS.get(cls);
  if (!target) return fail('"' + cls + '" is not a record class this layer governs.');
  if (!input.actor?.id) return fail('A signed-in person must be recorded as setting the policy.');
  const days = Math.floor(Number(input.retainDays));
  if (!Number.isFinite(days) || days < 1) return fail('A retention period is a whole number of days, at least one.');
  const basis = String(input.basis || '').trim();
  if (basis.length < 10) {
    return fail('State why the period is what it is. A retention period with no recorded basis is the first thing a regulator asks about.');
  }
  // The evidential classes cannot be set to expire on a timer.
  const evidential = ['access_log', 'decision_log', 'consent_event', 'erasure_request'];
  if (evidential.includes(cls) && input.action === 'delete') {
    return fail('The ' + cls.replace(/_/g, ' ') + ' cannot be set to delete automatically. Use "review" and have a person decide.');
  }
  try {
    await ensureRetentionDefaults();
    const db = await database();
    const sql = await sqlTag();
    const before = rows(await db.execute(sql`SELECT retain_days, action FROM hgov_retention_policy WHERE record_class = ${cls} LIMIT 1`))[0] || null;
    await db.execute(sql`
      UPDATE hgov_retention_policy
         SET retain_days = ${days}, action = ${input.action}, basis = ${basis},
             overridden_by = ${input.actor.id}::uuid, updated_at = NOW()
       WHERE record_class = ${cls}`);
    const { logAudit } = await import('@/lib/audit');
    await logAudit({
      userId: input.actor.id, action: 'horizon.retention.changed',
      entity: 'hgov_retention_policy', entityId: cls,
      diff: { from: before ? { days: before.retain_days, action: before.action } : null, to: { days, action: input.action }, basis },
      ipAddress: input.actor.ip || undefined,
    });
    return { ok: true };
  } catch (e: any) { return fail(reason(e)); }
}

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------

export interface RetentionDue {
  recordClass: string;
  ownerModule: string;
  action: 'delete' | 'anonymise' | 'review';
  retainDays: number;
  dueCount: number;
  /** False when the count could not be read. Shown as unknown, never as zero. */
  readable: boolean;
  /** True when this layer may act on it; false means counted and reported only. */
  sweepable: boolean;
}

/** What is past its period right now. A read, never a write — safe to call from a page. */
export async function retentionDue(): Promise<RetentionDue[]> {
  const policies = await listRetentionPolicies();
  const out: RetentionDue[] = [];
  for (const p of policies) {
    const target = TARGET_BY_CLASS.get(p.recordClass);
    if (!target) continue;
    let dueCount = 0;
    let readable = true;
    try {
      const db = await database();
      const sql = await sqlTag();
      const cutoff = new Date(Date.now() - p.retainDays * 86400000).toISOString();
      // Table and column names come from RETENTION_TARGETS above, never from a parameter.
      const r = rows(await db.execute(sql.raw(
        `SELECT COUNT(*)::int AS n FROM ${target.table} WHERE ${target.dateColumn} < ${lit(cutoff)}::timestamptz`)));
      dueCount = Number(r[0]?.n || 0);
    } catch { readable = false; }
    out.push({
      recordClass: p.recordClass, ownerModule: p.ownerModule, action: p.action,
      retainDays: p.retainDays, dueCount, readable,
      sweepable: p.ownerModule === 'horizon.governance' || SWEEPERS.has(p.recordClass),
    });
  }
  return out;
}

export interface SweepReport {
  recordClass: string;
  action: string;
  affected: number;
  note: string;
}

/**
 * Apply the retention schedule.
 *
 * `review` classes are NEVER touched — they are reported for a human, which is what the action means.
 * `dryRun` is the DEFAULT: a function that deletes by default is one somebody calls to see what it
 * would do.
 */
export async function applyRetention(actor: GovernanceActor, opts: { dryRun?: boolean } = {}): Promise<SweepReport[]> {
  const dryRun = opts.dryRun !== false;
  const policies = await listRetentionPolicies();
  const report: SweepReport[] = [];

  for (const p of policies) {
    const target = TARGET_BY_CLASS.get(p.recordClass);
    if (!target) continue;
    const cutoff = new Date(Date.now() - p.retainDays * 86400000).toISOString();
    const due = await countDue(target, cutoff);

    if (p.action === 'review') {
      report.push({
        recordClass: p.recordClass, action: 'review', affected: due,
        note: 'Held for a person to decide. Nothing is removed automatically from this class.',
      });
      continue;
    }

    // Owned elsewhere: counted and reported, never touched — unless the owner registered a sweeper.
    if (p.ownerModule !== 'horizon.governance') {
      const sweeper = SWEEPERS.get(p.recordClass);
      if (!sweeper) {
        report.push({
          recordClass: p.recordClass, action: 'report only', affected: due,
          note: p.ownerModule + ' owns this table. ' + due + ' rows are past the period; removing them is that patch\'s to do.',
        });
        continue;
      }
      if (dryRun) {
        report.push({ recordClass: p.recordClass, action: p.action + ' (dry run, via ' + sweeper.recordClass + ')', affected: due, note: 'Nothing was changed.' });
        continue;
      }
      try {
        const out = await sweeper.sweep(new Date(cutoff), p.action);
        report.push({ recordClass: p.recordClass, action: p.action + ' (by owner)', affected: out.affected, note: out.note });
      } catch (e: any) {
        report.push({ recordClass: p.recordClass, action: p.action, affected: 0, note: 'FAILED in the owning patch: ' + reason(e) });
      }
      continue;
    }

    if (dryRun) {
      report.push({ recordClass: p.recordClass, action: p.action + ' (dry run)', affected: due, note: 'Nothing was changed.' });
      continue;
    }

    try {
      const db = await database();
      const sql = await sqlTag();
      if (p.action === 'delete') {
        const r = rows(await db.execute(sql.raw(
          `DELETE FROM ${target.table} WHERE ${target.dateColumn} < ${lit(cutoff)}::timestamptz RETURNING id`)));
        report.push({ recordClass: p.recordClass, action: 'delete', affected: r.length, note: 'Rows removed.' });
      } else {
        const sets = target.identityColumns
          .map((c) => (c === 'subject_id' ? "subject_id = 'anonymised'" : `${c} = NULL`)).join(', ');
        const r = rows(await db.execute(sql.raw(
          `UPDATE ${target.table} SET ${sets} WHERE ${target.dateColumn} < ${lit(cutoff)}::timestamptz`
          + ` AND subject_id <> 'anonymised' RETURNING id`)));
        report.push({ recordClass: p.recordClass, action: 'anonymise', affected: r.length, note: 'Identity severed; the row was kept.' });
      }
    } catch (e: any) {
      report.push({ recordClass: p.recordClass, action: p.action, affected: 0, note: 'FAILED: ' + reason(e) });
    }
  }

  if (!dryRun && actor?.id) {
    const { logAudit } = await import('@/lib/audit');
    await logAudit({
      userId: actor.id, action: 'horizon.retention.applied', entity: 'hgov_retention_policy',
      diff: { report }, ipAddress: actor.ip || undefined,
    });
  }
  return report;
}

async function countDue(target: RetentionTarget, cutoff: string): Promise<number> {
  try {
    const db = await database();
    const sql = await sqlTag();
    const r = rows(await db.execute(sql.raw(
      `SELECT COUNT(*)::int AS n FROM ${target.table} WHERE ${target.dateColumn} < ${lit(cutoff)}::timestamptz`)));
    return Number(r[0]?.n || 0);
  } catch { return 0; }
}

// ---------------------------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------------------------

/**
 * A patch that holds data about a subject and can remove it.
 *
 * Registered by the OWNING patch at load. This layer never reaches into another patch's tables; it
 * asks, and records what came back — including "nothing was removed", which is a valid and important
 * answer.
 */
export interface ErasureParticipant {
  name: string;
  /** What this participant holds, in one line, for the person reading the request before approving it. */
  describes: string;
  erase(subject: SubjectRef, action: 'delete' | 'anonymise'): Promise<{ removed: number; note: string }>;
}

const PARTICIPANTS: ErasureParticipant[] = [];

export function registerErasureParticipant(p: ErasureParticipant): void {
  if (!p?.name || typeof p.erase !== 'function') return;
  if (PARTICIPANTS.some((x) => x.name === p.name)) return;
  PARTICIPANTS.push(p);
}

export function registeredErasureParticipants(): { name: string; describes: string }[] {
  return PARTICIPANTS.map((p) => ({ name: p.name, describes: p.describes }));
}

/**
 * What stands in the way of erasing this subject.
 *
 * FAILS CLOSED IN BOTH DIRECTIONS THAT MATTER. An open legal matter naming the subject blocks. And
 * if the legal-hold register cannot be read at all, that blocks too — "I could not check" and "there
 * is nothing to find" are different answers, and only one of them makes it safe to destroy data.
 */
export async function erasureBlockers(subject: SubjectRef, subjectUserId?: string | null): Promise<string[]> {
  const blockers: string[] = [];
  try {
    const { listMatters } = await import('@/lib/legal-hold');
    const result = await listMatters('open');
    if (!result.ok) {
      blockers.push('The legal-hold register could not be read (' + result.reason + '), so it cannot be shown that this person is free of a hold.');
    } else {
      const uid = subjectUserId || (subject.idScheme === 'user' ? subject.id : null);
      if (uid) {
        for (const m of result.rows) {
          if (Array.isArray(m.subjectUserIds) && m.subjectUserIds.includes(uid)) {
            blockers.push('Open legal matter ' + m.reference + ' (' + m.title + ') names this person.');
          }
        }
      } else if (result.rows.length > 0) {
        blockers.push('There are ' + result.rows.length + ' open legal matters and this subject has no user id to check them against. A person must confirm before this proceeds.');
      }
    }
  } catch (e: any) {
    blockers.push('The legal-hold check itself failed (' + reason(e) + '). Erasure is irreversible, so this blocks.');
  }
  return blockers;
}

const mapErasure = (r: any): ErasureRequest => ({
  id: String(r.id),
  subject: {
    kind: r.subject_kind, id: String(r.subject_id),
    idScheme: r.subject_scheme, organisationId: r.organisation_id,
  } as SubjectRef,
  action: r.action,
  scope: Array.isArray(r.scope) ? r.scope : [],
  requestedBy: String(r.requested_by),
  reason: String(r.reason),
  status: r.status as ErasureStatus,
  approvedBy: r.approved_by ? String(r.approved_by) : null,
  approvedAt: r.approved_at ? String(r.approved_at) : null,
  blockers: Array.isArray(r.blockers) ? r.blockers : [],
  report: r.report || {},
  createdAt: String(r.created_at),
  completedAt: r.completed_at ? String(r.completed_at) : null,
});

export async function requestErasure(input: {
  subject: SubjectRef;
  subjectUserId?: string | null;
  action: 'delete' | 'anonymise';
  scope?: string[];
  reason: string;
  actor: GovernanceActor;
}): Promise<GovernanceResult<ErasureRequest>> {
  if (!input?.subject?.id) return fail('An erasure request needs a subject.');
  if (!input.actor?.id) return fail('A signed-in person must be recorded as making the request.');
  const why = String(input.reason || '').trim();
  if (why.length < 15) return fail('Say why, in at least 15 characters. This request destroys or de-identifies somebody\'s records.');
  if (input.action !== 'delete' && input.action !== 'anonymise') return fail('The action is either delete or anonymise.');

  try {
    await ensureGovernanceSchema();
    const blockers = await erasureBlockers(input.subject, input.subjectUserId);
    const db = await database();
    const sql = await sqlTag();
    const r = rows(await db.execute(sql`
      INSERT INTO hgov_erasure_request (organisation_id, subject_kind, subject_id, subject_scheme,
                                        action, scope, requested_by, reason, status, blockers)
      VALUES (${input.subject.organisationId}, ${input.subject.kind}, ${input.subject.id},
              ${input.subject.idScheme}, ${input.action}, ${JSON.stringify(input.scope || [])}::jsonb,
              ${input.actor.id}::uuid, ${why},
              ${blockers.length > 0 ? 'blocked' : 'requested'}, ${JSON.stringify(blockers)}::jsonb)
      RETURNING *`));
    const record = mapErasure(r[0]);
    const { logAudit } = await import('@/lib/audit');
    await logAudit({
      userId: input.actor.id, action: 'horizon.erasure.requested',
      entity: 'hgov_erasure_request', entityId: record.id,
      diff: { subject: input.subject.kind + ':' + input.subject.id, action: input.action, blockers },
      ipAddress: input.actor.ip || undefined,
    });
    return { ok: true, data: record };
  } catch (e: any) { return fail(reason(e)); }
}

/**
 * Approve somebody else's request. SELF-APPROVAL IS REFUSED, without exception and with no setting
 * that turns it off. One person who can both request and approve the destruction of a record is one
 * person who can destroy a record, and nothing downstream would catch it — the record would be gone.
 */
export async function approveErasure(id: string, actor: GovernanceActor): Promise<GovernanceResult<ErasureRequest>> {
  if (!id || !actor?.id) return fail('A request id and a signed-in approver are required.');
  try {
    await ensureGovernanceSchema();
    const db = await database();
    const sql = await sqlTag();
    const existing = rows(await db.execute(sql`SELECT * FROM hgov_erasure_request WHERE id = ${id}::uuid LIMIT 1`))[0];
    if (!existing) return fail('That request does not exist.');
    if (String(existing.requested_by) === actor.id) {
      return fail('You cannot approve your own erasure request. A second named person has to look at it.');
    }
    if (String(existing.status) !== 'requested') {
      return fail('That request is ' + String(existing.status) + ', not awaiting approval.');
    }
    // Re-checked at approval, never trusted from request time: a matter may have opened since.
    const blockers = await erasureBlockers(mapErasure(existing).subject);
    if (blockers.length > 0) {
      await db.execute(sql`UPDATE hgov_erasure_request SET status = 'blocked', blockers = ${JSON.stringify(blockers)}::jsonb WHERE id = ${id}::uuid`);
      return fail('This request is blocked: ' + blockers.join(' '));
    }
    const r = rows(await db.execute(sql`
      UPDATE hgov_erasure_request SET status = 'approved', approved_by = ${actor.id}::uuid,
             approved_at = NOW(), blockers = '[]'::jsonb
       WHERE id = ${id}::uuid RETURNING *`));
    const { logAudit } = await import('@/lib/audit');
    await logAudit({ userId: actor.id, action: 'horizon.erasure.approved', entity: 'hgov_erasure_request', entityId: id, ipAddress: actor.ip || undefined });
    return { ok: true, data: mapErasure(r[0]) };
  } catch (e: any) { return fail(reason(e)); }
}

export async function rejectErasure(id: string, why: string, actor: GovernanceActor): Promise<GovernanceResult> {
  if (!id || !actor?.id) return fail('A request id and a signed-in person are required.');
  if (String(why || '').trim().length < 10) return fail('Say why the request is being refused.');
  try {
    await ensureGovernanceSchema();
    const db = await database();
    const sql = await sqlTag();
    await db.execute(sql`
      UPDATE hgov_erasure_request
         SET status = 'rejected', approved_by = ${actor.id}::uuid, approved_at = NOW(),
             report = report || ${JSON.stringify({ rejectedBecause: String(why) })}::jsonb
       WHERE id = ${id}::uuid AND status IN ('requested', 'blocked')`);
    const { logAudit } = await import('@/lib/audit');
    await logAudit({ userId: actor.id, action: 'horizon.erasure.rejected', entity: 'hgov_erasure_request', entityId: id, diff: { why }, ipAddress: actor.ip || undefined });
    return { ok: true };
  } catch (e: any) { return fail(reason(e)); }
}

/**
 * Carry out an approved request.
 *
 * WHAT IT DOES NOT ERASE, AND SAYS SO ON THE REPORT. Three things survive every erasure, and naming
 * them is the difference between an honest report and one that lets a reader assume the record is
 * gone:
 *
 *   - the erasure request itself, which is the proof the request was honoured;
 *   - the consent history, which is the proof processing was lawful while it ran;
 *   - the human decision log, where a decision about this person's employment stands as a business
 *     record that both sides may need.
 *
 * Anything claiming to erase "everything" is either wrong or is destroying records somebody will
 * need. Stating the exceptions where the person who asked can read them is the honest alternative.
 */
export async function executeErasure(id: string, actor: GovernanceActor): Promise<GovernanceResult<ErasureRequest>> {
  if (!id || !actor?.id) return fail('A request id and a signed-in person are required.');
  try {
    await ensureGovernanceSchema();
    const db = await database();
    const sql = await sqlTag();
    const existing = rows(await db.execute(sql`SELECT * FROM hgov_erasure_request WHERE id = ${id}::uuid LIMIT 1`))[0];
    if (!existing) return fail('That request does not exist.');
    if (String(existing.status) !== 'approved') return fail('Only an approved request can be executed. This one is ' + String(existing.status) + '.');

    const record = mapErasure(existing);
    const subject = record.subject;
    const action = record.action;

    // Checked before a single statement is built around it. The statements below interpolate the
    // subject because the table is chosen at runtime and cannot be a bind parameter; an unrecognised
    // kind is refused here rather than escaped and trusted.
    if (!SUBJECT_KINDS.includes(String(subject.kind))) {
      return fail('"' + String(subject.kind) + '" is not a subject kind this layer erases.');
    }
    if (action !== 'delete' && action !== 'anonymise') {
      return fail('"' + String(action) + '" is not an erasure action.');
    }

    // Checked a third time, immediately before anything is destroyed.
    const blockers = await erasureBlockers(subject);
    if (blockers.length > 0) {
      await db.execute(sql`UPDATE hgov_erasure_request SET status = 'blocked', blockers = ${JSON.stringify(blockers)}::jsonb WHERE id = ${id}::uuid`);
      return fail('Blocked immediately before execution: ' + blockers.join(' '));
    }

    await db.execute(sql`UPDATE hgov_erasure_request SET status = 'executing' WHERE id = ${id}::uuid`);

    const report: Record<string, unknown> = { own: {}, participants: {}, kept: [] };
    const kept = report.kept as string[];

    // 1. This layer's own tables, minus the ones that ARE the proof.
    for (const target of RETENTION_TARGETS) {
      if (target.ownerModule !== 'horizon.governance') continue;
      if (target.recordClass === 'decision_log') {
        kept.push('decision_log: kept — a decision a named person took about this individual is a business record both sides may need.');
        continue;
      }
      if (target.recordClass === 'erasure_request') {
        kept.push('erasure_request: kept — it is the proof that this request was made and honoured.');
        continue;
      }
      try {
        const where = `WHERE subject_kind = ${lit(subject.kind)} AND subject_id = ${lit(subject.id)}`;
        if (action === 'delete') {
          const r = rows(await db.execute(sql.raw(`DELETE FROM ${target.table} ${where} RETURNING id`)));
          (report.own as any)[target.recordClass] = { removed: r.length };
        } else {
          const sets = target.identityColumns
            .map((c) => (c === 'subject_id' ? "subject_id = 'anonymised'" : `${c} = NULL`)).join(', ');
          const r = rows(await db.execute(sql.raw(`UPDATE ${target.table} SET ${sets} ${where} RETURNING id`)));
          (report.own as any)[target.recordClass] = { anonymised: r.length };
        }
      } catch (e: any) {
        (report.own as any)[target.recordClass] = { failed: reason(e) };
      }
    }

    kept.push('hzn_consent_event: kept by the intake patch — it is the proof that the processing was lawful while it ran.');

    // 2. Every other patch that registered itself.
    for (const p of PARTICIPANTS) {
      try {
        const out = await p.erase(subject, action);
        (report.participants as any)[p.name] = { removed: out.removed, note: out.note };
      } catch (e: any) {
        (report.participants as any)[p.name] = { failed: reason(e) };
      }
    }
    if (PARTICIPANTS.length === 0) {
      kept.push('No other patch has registered an erasure participant, so only this layer\'s own records were acted on. Everything held in the hzn_* tables is untouched.');
    }

    const anyFailure = JSON.stringify(report).includes('"failed"');
    const finalStatus: ErasureStatus = anyFailure ? 'blocked' : 'completed';

    const r = rows(await db.execute(sql`
      UPDATE hgov_erasure_request
         SET status = ${finalStatus}, report = ${JSON.stringify(report)}::jsonb,
             completed_at = ${anyFailure ? null : sql`NOW()`},
             blockers = ${anyFailure ? JSON.stringify(['Part of the erasure failed. See the report.']) : '[]'}::jsonb
       WHERE id = ${id}::uuid RETURNING *`));

    const { logAudit } = await import('@/lib/audit');
    await logAudit({
      userId: actor.id, action: 'horizon.erasure.executed',
      entity: 'hgov_erasure_request', entityId: id,
      diff: { subject: subject.kind + ':' + subject.id, action, status: finalStatus },
      ipAddress: actor.ip || undefined,
    });

    return { ok: true, data: mapErasure(r[0]) };
  } catch (e: any) { return fail(reason(e)); }
}

export async function listErasureRequests(status?: ErasureStatus, limit = 100): Promise<ErasureRequest[]> {
  try {
    await ensureGovernanceSchema();
    const db = await database();
    const sql = await sqlTag();
    const n = Math.min(500, Math.max(1, limit));
    const r = status
      ? rows(await db.execute(sql`SELECT * FROM hgov_erasure_request WHERE status = ${status} ORDER BY created_at DESC LIMIT ${n}`))
      : rows(await db.execute(sql`SELECT * FROM hgov_erasure_request ORDER BY created_at DESC LIMIT ${n}`));
    return r.map(mapErasure);
  } catch { return []; }
}
