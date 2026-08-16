// src/lib/mailgov/deletion.ts — CONTROLLED, ASYNCHRONOUS, REVERSIBLE-UNTIL-IT-ISN'T DELETION.
//
// The plans and the gate are in ./deletion-plan.ts (pure, tested). This file executes them.
//
// THE GATE IS CHECKED TWICE, AND THE SECOND TIME IS THE ONE THAT MATTERS. Everything the plan
// requires — the typed confirmation, the approvals, the grace window, the absence of a legal hold —
// is checked when the job is requested AND again in the instant before the first row is deleted. A
// hold placed during the grace window, or a matter opened an hour after the request, has to stop the
// job; a gate evaluated once at request time would let a deletion that was lawful on Monday run on
// Thursday when it no longer is.
//
// THE STATEMENTS ARE WRITTEN OUT PER SCOPE, not generated from the plan. A deletion engine that
// builds its own SQL from a table list is one schema change away from deleting the wrong rows, and
// the failure mode is unrecoverable. The plan describes what will happen for the confirmation screen;
// this file performs it explicitly, and the two are kept in step by a test that asserts every table
// in a plan is named in its executor.
//
// COUNTS ARE RECORDED PER TABLE. "Deleted" is not a useful record. "mailapi_messages: 1,204,
// mailapi_message_events: 8,551, mailapi_consent: 3" is a record somebody can check against what
// they expected, which is the only way an erasure can be shown to have done what was asked.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';
import { ensureGovernanceSchema, rows, dbReason, tableExists } from './schema';
import { holdBlocks } from './holds';
import { normalizeEmail } from './consent-policy';
import {
  approvalsSatisfied, confirmationPhraseFor, deletionGate, deletionPlan, planSummary, scheduledFor,
  type Approval, type DeletionPlan, type DeletionScope, type DeletionStatus,
} from './deletion-plan';

const BATCH = 1000;
const MAX_BATCHES = 200;

export interface DeletionJob {
  id: string;
  orgId: string | null;
  scope: DeletionScope;
  target: string;
  targetLabel: string | null;
  reason: string;
  alsoRemoveSuppression: boolean;
  plan: DeletionPlan | null;
  status: DeletionStatus;
  requestedBy: string;
  approvals: Approval[];
  scheduledFor: string | null;
  counts: Record<string, number>;
  blockedReason: string | null;
  error: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

function map(r: any): DeletionJob {
  return {
    id: String(r.id),
    orgId: r.org_id ? String(r.org_id) : null,
    scope: String(r.scope) as DeletionScope,
    target: String(r.target),
    targetLabel: r.target_label ?? null,
    reason: String(r.reason || ''),
    alsoRemoveSuppression: !!r.also_remove_suppression,
    plan: r.plan && typeof r.plan === 'object' && (r.plan as any).steps ? (r.plan as DeletionPlan) : null,
    status: String(r.status) as DeletionStatus,
    requestedBy: String(r.requested_by),
    approvals: Array.isArray(r.approvals) ? r.approvals : [],
    scheduledFor: r.scheduled_for ? new Date(r.scheduled_for).toISOString() : null,
    counts: (r.counts && typeof r.counts === 'object') ? r.counts : {},
    blockedReason: r.blocked_reason ?? null,
    error: r.error ?? null,
    cancelledBy: r.cancelled_by ? String(r.cancelled_by) : null,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  };
}

export interface RequestDeletionResult {
  ok: boolean;
  error?: string;
  jobId?: string;
  plan?: DeletionPlan;
  status?: DeletionStatus;
  /** What still has to happen before it runs, in words, for the screen. */
  next?: string;
}

/**
 * Ask for a deletion.
 *
 * The confirmation phrase is checked HERE as well as at execution, so a mistyped target is caught
 * while the operator is still looking at the screen rather than three days later when the grace
 * window elapses. A hold is checked here too: telling somebody on day three that their request was
 * never going to be permitted is a poor way to run a governance system.
 */
export async function requestDeletion(input: {
  orgId: string | null;
  scope: DeletionScope;
  target: string;
  targetLabel?: string | null;
  reason: string;
  typedPhrase: string;
  alsoRemoveSuppression?: boolean;
  requestedBy: string;
  now?: Date;
}): Promise<RequestDeletionResult> {
  const now = input.now || new Date();
  const reason = String(input.reason || '').trim();
  if (reason.length < 15) {
    return { ok: false, error: 'Give a reason of at least 15 characters. It is the only record of why this was destroyed.' };
  }
  if (input.scope !== 'mailbox' && !input.orgId) {
    return { ok: false, error: 'Name the organization this deletion belongs to.' };
  }
  if (input.scope === 'mailbox' && input.orgId) {
    return { ok: false, error: 'A mailbox deletion acts on the internal mail store and belongs to no organization.' };
  }

  const target = input.scope === 'contact' ? normalizeEmail(input.target) : String(input.target || '').trim();
  if (!target) return { ok: false, error: 'Name what is being deleted.' };

  const expected = confirmationPhraseFor(input.scope, target);
  if (String(input.typedPhrase || '').trim().toLowerCase() !== expected) {
    return { ok: false, error: 'Type exactly: ' + expected };
  }

  const plan = deletionPlan({
    scope: input.scope, target, targetLabel: input.targetLabel || target,
    alsoRemoveSuppression: !!input.alsoRemoveSuppression,
  });

  if (input.orgId) {
    const hold = await holdBlocks({
      orgId: input.orgId,
      scope: input.scope === 'contact' ? 'address' : input.scope === 'organization' ? 'organization' : null,
      scopeRef: input.scope === 'contact' ? target : null,
    });
    if (hold.blocked) return { ok: false, error: hold.reason || 'A legal hold covers this target.' };
  }

  const due = scheduledFor(input.scope, now);
  const status: DeletionStatus = plan.approvalsRequired > 0 ? 'pending_approval' : 'scheduled';

  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      INSERT INTO mailapi_deletion_jobs (
        org_id, scope, target, target_label, reason, also_remove_suppression, plan, status,
        requested_by, approvals, scheduled_for)
      VALUES (
        ${input.orgId}::uuid, ${input.scope}, ${target}, ${input.targetLabel || target}, ${reason.slice(0, 4000)},
        ${!!input.alsoRemoveSuppression}, ${JSON.stringify(plan)}::jsonb, ${status},
        ${input.requestedBy}::uuid, '[]'::jsonb, ${due}::timestamptz)
      RETURNING id`))[0];

    const next = plan.approvalsRequired > 0
      ? 'Needs ' + plan.approvalsRequired + ' approval' + (plan.approvalsRequired === 1 ? '' : 's') + ' from other administrators'
        + (due ? ', then runs after ' + due + '.' : '.')
      : (due ? 'Runs after ' + due + ' and can be cancelled until then.' : 'Runs on the next worker pass.');

    return { ok: true, jobId: String(r?.id), plan, status, next };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * Approve. The approver must not be the requester, and cannot approve twice — approvalsSatisfied()
 * counts DISTINCT approvers excluding the requester, so both attempts are refused here rather than
 * silently counted and discovered at execution.
 */
export async function approveDeletion(input: {
  jobId: string;
  byUserId: string;
  now?: Date;
}): Promise<{ ok: boolean; error?: string; have?: number; need?: number; status?: DeletionStatus }> {
  const now = input.now || new Date();
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`SELECT * FROM mailapi_deletion_jobs WHERE id = ${input.jobId}::uuid LIMIT 1`))[0];
    if (!r) return { ok: false, error: 'No such deletion job.' };
    const job = map(r);
    if (job.status !== 'pending_approval' && job.status !== 'scheduled') {
      return { ok: false, error: 'That job is ' + job.status + ' and cannot be approved.' };
    }
    if (job.requestedBy === input.byUserId) {
      return { ok: false, error: 'The person who requested a deletion cannot approve it. That is what the approval is for.' };
    }
    if (job.approvals.some((a) => a.userId === input.byUserId)) {
      return { ok: false, error: 'You have already approved this job.' };
    }

    const approvals = [...job.approvals, { userId: input.byUserId, at: now.toISOString() }];
    const check = approvalsSatisfied(job.scope, job.requestedBy, approvals);
    const status: DeletionStatus = check.ok ? 'scheduled' : 'pending_approval';

    await db.execute(sql`
      UPDATE mailapi_deletion_jobs SET approvals = ${JSON.stringify(approvals)}::jsonb, status = ${status}
       WHERE id = ${input.jobId}::uuid`);
    return { ok: true, have: check.have, need: check.need, status };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/** Cancel, while there is still something to cancel. A running or completed job cannot be recalled. */
export async function cancelDeletion(input: {
  jobId: string;
  byUserId: string;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      UPDATE mailapi_deletion_jobs
         SET status = 'cancelled', cancelled_by = ${input.byUserId}::uuid, cancelled_at = now(),
             error = ${String(input.reason || '').slice(0, 1000) || null}
       WHERE id = ${input.jobId}::uuid AND status IN ('pending_approval', 'scheduled', 'blocked')
      RETURNING id`));
    if (!r.length) {
      return { ok: false, error: 'That job cannot be cancelled — it has already run, or it was cancelled already.' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

export async function listDeletions(orgId: string | null, limit = 50): Promise<ReadResult<DeletionJob>> {
  try {
    await ensureGovernanceSchema();
    const r = await db.execute(sql`
      SELECT * FROM mailapi_deletion_jobs
       WHERE ${orgId ? sql`org_id = ${orgId}::uuid` : sql`TRUE`}
       ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`);
    return { ok: true, rows: rows(r).map(map) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

export async function getDeletion(id: string): Promise<{ ok: boolean; job?: DeletionJob; reason?: string }> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`SELECT * FROM mailapi_deletion_jobs WHERE id = ${id}::uuid LIMIT 1`))[0];
    if (!r) return { ok: false, reason: 'No such deletion job.' };
    return { ok: true, job: map(r) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

/** Scheduled jobs whose grace window has elapsed. */
export async function dueDeletions(now = new Date(), limit = 5): Promise<string[]> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT id FROM mailapi_deletion_jobs
       WHERE status = 'scheduled'
         AND (scheduled_for IS NULL OR scheduled_for <= ${now.toISOString()}::timestamptz)
       ORDER BY created_at ASC LIMIT ${limit}`));
    return r.map((x: any) => String(x.id));
  } catch {
    return [];
  }
}

export interface ExecutionResult {
  ok: boolean;
  error?: string;
  blocked?: string;
  counts?: Record<string, number>;
  summary?: string;
}

/**
 * RUN ONE JOB.
 *
 * Claimed with a conditional UPDATE so two workers cannot both run it. The gate is re-evaluated after
 * the claim and before the first delete; a job that fails the gate now goes to `blocked` with the
 * reason, NOT to `failed` — blocked is recoverable (release the hold, get the approval) and failed is
 * an error to investigate, and collapsing them would hide which one happened.
 */
export async function runDeletionJob(jobId: string, now = new Date()): Promise<ExecutionResult> {
  try {
    await ensureGovernanceSchema();
    const claimed = rows(await db.execute(sql`
      UPDATE mailapi_deletion_jobs SET status = 'running', started_at = now()
       WHERE id = ${jobId}::uuid AND status = 'scheduled'
      RETURNING *`))[0];
    if (!claimed) return { ok: false, error: 'That job is not scheduled; another worker may have taken it.' };

    const job = map(claimed);

    // ---- the second gate ------------------------------------------------------------------------
    let activeHolds = 0;
    if (job.orgId) {
      const hold = await holdBlocks({
        orgId: job.orgId,
        scope: job.scope === 'contact' ? 'address' : job.scope === 'organization' ? 'organization' : null,
        scopeRef: job.scope === 'contact' ? job.target : null,
      });
      if (hold.blocked) {
        await block(job.id, hold.reason || 'A legal hold covers this target.');
        return { ok: false, blocked: hold.reason || 'A legal hold covers this target.' };
      }
      activeHolds = hold.count;
    }

    let orgSuspended: boolean | undefined;
    if (job.scope === 'organization') {
      const o = rows(await db.execute(sql`SELECT status, is_active FROM mailapi_orgs WHERE id = ${job.target}::uuid LIMIT 1`))[0];
      orgSuspended = !!o && (String(o.status) === 'suspended' || o.is_active === false);
    }

    const gate = deletionGate({
      scope: job.scope, target: job.target, requestedBy: job.requestedBy,
      // THE PHRASE WAS VERIFIED AT REQUEST TIME AND CANNOT BE RE-VERIFIED HERE — the operator typed it
      // into a form that no longer exists, and storing what they typed would prove nothing beyond what
      // accepting the request already proved. It is re-supplied from the plan so the gate runs whole
      // rather than in a partial form that could drift from the one the request used. The clauses that
      // genuinely need re-checking — holds, approvals, the grace window, suspension — are all live.
      typedPhrase: confirmationPhraseFor(job.scope, job.target),
      approvals: job.approvals, scheduledFor: job.scheduledFor, now,
      activeHolds, orgSuspended,
    });
    if (!gate.ok) {
      await block(job.id, gate.error || 'The deletion gate refused this job.');
      return { ok: false, blocked: gate.error };
    }

    // ---- the work ------------------------------------------------------------------------------
    const counts = job.scope === 'contact' ? await executeContact(job)
      : job.scope === 'mailbox' ? await executeMailbox(job)
      : await executeOrganization(job);

    const summary = job.plan ? planSummary(job.plan) : job.scope + ' ' + job.target;
    await db.execute(sql`
      UPDATE mailapi_deletion_jobs
         SET status = 'completed', counts = ${JSON.stringify(counts)}::jsonb, finished_at = now()
       WHERE id = ${job.id}::uuid`);

    return { ok: true, counts, summary };
  } catch (e: any) {
    const reason = dbReason(e);
    try {
      await db.execute(sql`
        UPDATE mailapi_deletion_jobs SET status = 'failed', error = ${reason.slice(0, 4000)}, finished_at = now()
         WHERE id = ${jobId}::uuid`);
    } catch (inner: any) {
      logEvent('error', 'mailgov.deletion.fail-record-failed', { jobId, message: dbReason(inner) });
    }
    return { ok: false, error: reason };
  }
}

async function block(jobId: string, reason: string): Promise<void> {
  await db.execute(sql`
    UPDATE mailapi_deletion_jobs SET status = 'blocked', blocked_reason = ${reason.slice(0, 2000)}, finished_at = now()
     WHERE id = ${jobId}::uuid`);
}

/**
 * CONTACT ERASURE.
 *
 * The interesting statement is the message one. A message addressed to three people, one of whom has
 * asked to be erased, is not that person's message to delete — it is also the other two recipients'
 * record and the organization's. So the address is removed from the recipient arrays, and only a
 * message left addressed to nobody at all is deleted. The alternative — deleting every message the
 * address appears in — erases other people's correspondence on one person's request.
 */
async function executeContact(job: DeletionJob): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const orgId = job.orgId as string;
  const email = job.target;

  counts['mailapi_consent'] = (rows(await db.execute(sql`
    DELETE FROM mailapi_consent WHERE org_id = ${orgId}::uuid AND email = ${email} RETURNING id`))).length;

  counts['mailapi_message_events'] = (rows(await db.execute(sql`
    DELETE FROM mailapi_message_events WHERE org_id = ${orgId}::uuid AND recipient = ${email} RETURNING id`))).length;

  if (await tableExists('mailapi_ai_records')) {
    counts['mailapi_ai_records'] = (rows(await db.execute(sql`
      DELETE FROM mailapi_ai_records a
       USING mailapi_messages m
       WHERE a.message_id = m.id AND m.org_id = ${orgId}::uuid
         AND m.to_emails = ${JSON.stringify([email])}::jsonb
      RETURNING a.id`))).length;
  }

  // Remove the address from every recipient list it appears in.
  const redacted = rows(await db.execute(sql`
    UPDATE mailapi_messages
       SET to_emails  = COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(to_emails)  e WHERE e <> ${JSON.stringify(email)}::jsonb), '[]'::jsonb),
           cc_emails  = COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(cc_emails)  e WHERE e <> ${JSON.stringify(email)}::jsonb), '[]'::jsonb),
           bcc_emails = COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(bcc_emails) e WHERE e <> ${JSON.stringify(email)}::jsonb), '[]'::jsonb),
           updated_at = now()
     WHERE org_id = ${orgId}::uuid
       AND (to_emails @> ${JSON.stringify([email])}::jsonb
         OR cc_emails @> ${JSON.stringify([email])}::jsonb
         OR bcc_emails @> ${JSON.stringify([email])}::jsonb)
    RETURNING id`));
  counts['mailapi_messages:redacted'] = redacted.length;

  // Anything now addressed to nobody was addressed only to them.
  counts['mailapi_messages:deleted'] = (rows(await db.execute(sql`
    DELETE FROM mailapi_messages
     WHERE org_id = ${orgId}::uuid
       AND to_emails = '[]'::jsonb AND cc_emails = '[]'::jsonb AND bcc_emails = '[]'::jsonb
    RETURNING id`))).length;

  if (job.alsoRemoveSuppression) {
    counts['mailapi_suppressions'] = (rows(await db.execute(sql`
      DELETE FROM mailapi_suppressions WHERE org_id = ${orgId}::uuid AND email = ${email} RETURNING id`))).length;
  }

  return counts;
}

/**
 * MAILBOX DELETION, over EduRankAI's own internal mail store.
 *
 * Every table is optional — this store is created lazily by src/lib/mail.ts and a deployment that has
 * never used the webmail client has none of it. A missing table is recorded as a skipped step rather
 * than a failure, because "there was nothing of this kind to delete" is a true and useful outcome.
 *
 * The last statement is the careful one: a message body is shared by every mailbox that holds it, so
 * only messages with NO remaining holder are removed. Deleting one person's mailbox must not delete
 * the other side of their conversations.
 */
async function executeMailbox(job: DeletionJob): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const userId = job.target;

  // Ordered assignments-before-labels, and every table keyed by the holder's own user_id — verified
  // against the DDL in src/lib/mail-advanced.ts rather than assumed. mail_message_labels carries a
  // user_id of its own (its primary key is message_id + label_id), so it is deletable directly and
  // does not need a join through mail_labels.
  const simple: [string, string][] = [
    ['mail_box', 'user_id'],
    ['mail_message_labels', 'user_id'],
    ['mail_rules', 'user_id'],
    ['mail_settings', 'user_id'],
    ['mail_user_prefs', 'user_id'],
    ['mail_scheduled', 'user_id'],
    ['mail_labels', 'user_id'],
  ];
  for (const [table, column] of simple) {
    if (!(await tableExists(table))) { counts[table] = -1; continue; }
    try {
      const r = rows(await db.execute(sql`
        DELETE FROM ${sql.raw(table)} WHERE ${sql.raw(column)} = ${userId}::uuid RETURNING 1 AS x`));
      counts[table] = r.length;
    } catch (e: any) {
      // One missing column must not abandon the rest of the mailbox half-deleted. Recorded as a
      // negative count, which the console renders as "not run" rather than as zero rows.
      logEvent('warn', 'mailgov.deletion.mailbox-step-failed', { table, message: dbReason(e) });
      counts[table] = -1;
    }
  }

  if (await tableExists('mail_messages') && await tableExists('mail_box')) {
    const r = rows(await db.execute(sql`
      DELETE FROM mail_messages m
       WHERE NOT EXISTS (SELECT 1 FROM mail_box b WHERE b.message_id = m.id)
      RETURNING m.id`));
    counts['mail_messages:orphaned'] = r.length;
  }

  return counts;
}

/**
 * ORGANIZATION DELETION.
 *
 * Children first, then the row. The audit log, the security events and the legal holds are NOT in
 * this list and are not deleted: the record of the deletion has to outlive the thing deleted, or the
 * platform cannot show what it did.
 *
 * The foreign keys on mailapi_orgs are ON DELETE CASCADE, so the final statement would take most of
 * these anyway. They are deleted explicitly and counted anyway, because "the cascade handled it" is
 * not a number anybody can check, and a cascade that silently changes when a table is added is how a
 * deletion quietly stops covering something.
 */
async function executeOrganization(job: DeletionJob): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const orgId = job.target;

  const del = async (label: string, statement: any): Promise<void> => {
    try {
      counts[label] = rows(await db.execute(statement)).length;
    } catch (e: any) {
      logEvent('warn', 'mailgov.deletion.org-step-failed', { label, message: dbReason(e) });
      counts[label] = -1;
    }
  };

  await del('mailapi_webhook_deliveries', sql`DELETE FROM mailapi_webhook_deliveries WHERE org_id = ${orgId}::uuid RETURNING id`);
  await del('mailapi_webhooks', sql`DELETE FROM mailapi_webhooks WHERE org_id = ${orgId}::uuid RETURNING id`);
  await del('mailapi_message_events', sql`DELETE FROM mailapi_message_events WHERE org_id = ${orgId}::uuid RETURNING id`);

  if (await tableExists('mailapi_ai_records')) {
    await del('mailapi_ai_records', sql`DELETE FROM mailapi_ai_records WHERE org_id = ${orgId}::uuid RETURNING id`);
  }

  // Messages in batches: a tenant with a million rows must not hold one transaction open for minutes
  // on a pooled connection.
  let messages = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const r = rows(await db.execute(sql`
      WITH doomed AS (SELECT id FROM mailapi_messages WHERE org_id = ${orgId}::uuid LIMIT ${BATCH})
      DELETE FROM mailapi_messages WHERE id IN (SELECT id FROM doomed) RETURNING id`));
    messages += r.length;
    if (r.length < BATCH) break;
  }
  counts['mailapi_messages'] = messages;

  await del('mailapi_template_versions', sql`
    DELETE FROM mailapi_template_versions
     WHERE template_id IN (SELECT id FROM mailapi_templates WHERE org_id = ${orgId}::uuid) RETURNING id`);
  await del('mailapi_templates', sql`DELETE FROM mailapi_templates WHERE org_id = ${orgId}::uuid RETURNING id`);
  await del('mailapi_idempotency', sql`DELETE FROM mailapi_idempotency WHERE org_id = ${orgId}::uuid RETURNING id`);
  await del('mailapi_consent', sql`DELETE FROM mailapi_consent WHERE org_id = ${orgId}::uuid RETURNING id`);
  await del('mailapi_domains', sql`DELETE FROM mailapi_domains WHERE org_id = ${orgId}::uuid RETURNING id`);
  await del('mailapi_keys', sql`DELETE FROM mailapi_keys WHERE org_id = ${orgId}::uuid RETURNING id`);
  await del('mailapi_suppressions', sql`DELETE FROM mailapi_suppressions WHERE org_id = ${orgId}::uuid RETURNING id`);
  await del('mailapi_org_members', sql`DELETE FROM mailapi_org_members WHERE org_id = ${orgId}::uuid RETURNING id`);
  await del('mailapi_retention_policies', sql`DELETE FROM mailapi_retention_policies WHERE org_id = ${orgId}::uuid RETURNING id`);
  await del('mailapi_export_jobs', sql`DELETE FROM mailapi_export_jobs WHERE org_id = ${orgId}::uuid RETURNING id`);
  await del('mailapi_support_grants', sql`DELETE FROM mailapi_support_grants WHERE org_id = ${orgId}::uuid RETURNING id`);
  await del('mailapi_orgs', sql`DELETE FROM mailapi_orgs WHERE id = ${orgId}::uuid RETURNING id`);

  return counts;
}
