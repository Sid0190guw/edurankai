// src/lib/delegation.ts — standing in for somebody, with an end date and a name on every action.
//
// WHAT THIS IS FOR. An executive assistant needs to do things for the founder: clear an approval
// queue, chase an onboarding, answer a candidate. The wrong way to build that is a shared login or
// an "act as" impersonation, because both destroy the only question an audit log has to answer —
// who actually did this. The right way already exists in this codebase: `temporary_delegate` in the
// organization graph. This module is the missing grant path for it, plus the rules about what a
// delegation may never carry.
//
// THE FOUR PROPERTIES THAT MAKE IT SAFE, and each is enforced here rather than described:
//
//   1. THE ASSISTANT IS THEMSELVES. There is no impersonation and no borrowed session. They sign in
//      as themselves and act on somebody's authority. src/lib/workflow.ts already records this:
//      ActedVia is 'routed' | 'delegate' | 'capability', so a decision taken while standing in is
//      already stamped as such. Nothing in this file may weaken that into looking like the principal
//      acted personally.
//
//   2. IT ENDS BY ITSELF. A delegation is bounded by effective_from and effective_to and by nothing
//      else. org-graph.ts is explicit that there is no "is delegated" boolean somebody has to
//      remember to switch off when they get back from leave — the commonest way a temporary
//      authority becomes a permanent one. An open-ended delegation is refused here.
//
//   3. IT IS NARROW. A delegation carries the domains it names and no others, and
//      `temporary_delegate` is deliberately absent from RESPONSIBILITY_TYPES in org-graph.ts, so
//      standing in confers nothing automatically. Note also that isResponsibleFor() allows exactly
//      ONE hop of delegation: an assistant cannot re-delegate onward.
//
//   4. SOME THINGS CANNOT BE HANDED OVER AT ALL. See NEVER_DELEGABLE. These are not conveniences
//      withheld; they are the acts whose whole protection is that a specific person had to perform
//      them personally. Delegating the power to grant power dissolves every other limit in one move.

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  closeRelationship,
  openRelationship,
  type OrgWriteResult,
} from '@/lib/org-graph';

// -------------------------------------------------------------------------------------------------
// CONSTANTS FIRST. `const` is not hoisted, and a binding declared under its first reader has taken
// pages down on this project more than once.
// -------------------------------------------------------------------------------------------------

/**
 * The domains a delegation can carry. Deliberately coarse: a list fine enough to be precise is a
 * list nobody reads before pressing grant, and a delegation nobody read is not consent.
 */
export const DELEGABLE_DOMAINS = [
  'approvals.queue',      // decide what the graph routed to the principal
  'calendar.manage',      // meetings, sessions, scheduling
  'correspondence.draft', // draft mail and messages, never send as the principal
  'recruitment.progress', // move candidates along a pipeline
  'onboarding.chase',     // nudge and track a joiner's outstanding steps
  'documents.file',       // organise and file, never sign
  'tasks.assign',         // put work on somebody's board
] as const;

export type DelegableDomain = (typeof DELEGABLE_DOMAINS)[number];

export const DOMAIN_LABELS: Readonly<Record<DelegableDomain, string>> = Object.freeze({
  'approvals.queue': 'Decide approvals routed to me',
  'calendar.manage': 'Manage my calendar and sessions',
  'correspondence.draft': 'Draft mail and messages for me',
  'recruitment.progress': 'Move candidates through hiring',
  'onboarding.chase': 'Chase outstanding onboarding steps',
  'documents.file': 'File and organise documents',
  'tasks.assign': 'Assign tasks on my behalf',
});

/**
 * Acts that no delegation carries, ever, whatever the principal wishes.
 *
 * Each is here because its ONLY protection is that a named person had to do it themselves:
 *
 *  - GRANTING AUTHORITY. If the power to grant can be delegated, every other limit on this list can
 *    be routed around in two steps. This is the one that makes the rest enforceable.
 *  - PAY AND EMPLOYMENT STATUS. Somebody's livelihood is not an errand.
 *  - A RECORD OF ACHIEVEMENT. A credential, a grade, a verified skill — statements about a person
 *    that outlive this platform.
 *  - SIGNING. A signature is a claim that a specific person assented.
 *  - HEALTH AND WELLNESS. Out of bounds to everyone including the founder; delegation cannot reach
 *    what the principal could not reach.
 *  - LEGAL HOLD. Requires an open numbered matter and a written reason from the person accessing it.
 */
export const NEVER_DELEGABLE: readonly { id: string; why: string }[] = Object.freeze([
  { id: 'authority.grant', why: 'Granting access or capability. Delegating this would dissolve every other limit on this list.' },
  { id: 'pay.change', why: 'Changing pay, a salary structure or a payroll run.' },
  { id: 'employment.status', why: 'Hiring, terminating, promoting or reclassifying a person.' },
  { id: 'achievement.record', why: 'Issuing, revoking or altering a credential, grade or verified skill.' },
  { id: 'document.sign', why: 'Signing anything. A signature says a specific person assented.' },
  { id: 'wellness.read', why: 'Individual health or wellness data. Nobody may read it, including the principal.' },
  { id: 'legalhold.access', why: 'Legal-hold records, which need an open matter and a written reason from the reader.' },
]);

/** A delegation with no end date is the failure mode this whole design exists to prevent. */
export const MAX_DELEGATION_DAYS = 180;

export interface GrantInput {
  /** hr_employees.id of the person handing authority over. */
  principalEmployeeId: string;
  /** hr_employees.id of the person standing in. */
  delegateEmployeeId: string;
  domains: DelegableDomain[];
  from: Date | string;
  /** Required. There is no open-ended delegation. */
  until: Date | string;
  reason: string;
  /** users.id of whoever is recording this, for the audit row. */
  actorUserId: string;
}

export interface DelegationSummary {
  id: string;
  principalEmployeeId: string;
  delegateEmployeeId: string;
  domains: DelegableDomain[];
  from: string;
  until: string;
  reason: string;
  inForce: boolean;
}

function isUuid(v: unknown): boolean {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function toDate(v: Date | string): Date | null {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Everything that must be true before authority changes hands. Separated from the write so a
 * surface can PREVIEW the answer and show the person exactly what they are about to hand over,
 * rather than discovering a refusal after pressing a button.
 */
export function checkGrant(input: GrantInput): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  if (!isUuid(input?.principalEmployeeId)) problems.push('The principal must be an employee record.');
  if (!isUuid(input?.delegateEmployeeId)) problems.push('The person standing in must be an employee record.');

  // Delegating to yourself is not a delegation; it is a way to make an action look like two people
  // agreed when only one did.
  if (input?.principalEmployeeId && input.principalEmployeeId === input.delegateEmployeeId) {
    problems.push('A person cannot delegate to themselves.');
  }

  const domains = Array.isArray(input?.domains) ? input.domains : [];
  if (domains.length === 0) {
    problems.push('Choose at least one thing this person may do. A delegation that names nothing carries nothing.');
  }
  for (const d of domains) {
    if (!(DELEGABLE_DOMAINS as readonly string[]).includes(d)) {
      problems.push('Not something that can be delegated: ' + String(d));
    }
  }

  const from = input?.from ? toDate(input.from) : null;
  const until = input?.until ? toDate(input.until) : null;
  if (!from) problems.push('A start date is required.');
  if (!until) {
    // The single most important rule in this file.
    problems.push('An end date is required. A delegation without one becomes permanent by accident.');
  }
  if (from && until) {
    if (until.getTime() <= from.getTime()) {
      problems.push('The end date must be after the start date.');
    } else {
      const days = (until.getTime() - from.getTime()) / 86_400_000;
      if (days > MAX_DELEGATION_DAYS) {
        problems.push('A delegation may run for at most ' + MAX_DELEGATION_DAYS +
          ' days. Renew it deliberately rather than granting it indefinitely.');
      }
    }
  }

  if (!String(input?.reason || '').trim()) {
    problems.push('A reason is required. Somebody reading the audit log in a year needs to know why.');
  }
  if (!isUuid(input?.actorUserId)) problems.push('The person recording this must be signed in.');

  return { ok: problems.length === 0, problems };
}

/**
 * Hand authority over, bounded and recorded.
 *
 * Writes a `temporary_delegate` edge through openRelationship() — the one correct way to change the
 * graph — with the granted domains in the note so the edge itself carries what it covers. Never a
 * raw INSERT: the partial unique indexes in org-graph-schema.ts are the real backstop and a second
 * write path would get around them.
 */
export async function grantDelegation(input: GrantInput): Promise<OrgWriteResult> {
  const check = checkGrant(input);
  if (!check.ok) return { ok: false, error: check.problems.join(' ') };

  const from = toDate(input.from)!;
  const until = toDate(input.until)!;

  // The note carries the scope, the end date and the reason, so an edge read months later explains
  // itself without a join to a table that might not have been written.
  const note = JSON.stringify({
    kind: 'delegation',
    domains: input.domains,
    until: until.toISOString(),
    reason: String(input.reason).trim().slice(0, 500),
  });

  const res = await openRelationship({
    type: 'temporary_delegate',
    subjectEmployeeId: input.delegateEmployeeId,  // the one standing in
    objectEmployeeId: input.principalEmployeeId,  // the one being stood in for
    scopeType: 'global',
    scopeId: null,
    effectiveFrom: from,
    createdByUserId: input.actorUserId,
    note,
  });

  if (!res.ok) return res;

  // Handing over authority is exactly the kind of act that must be visible afterwards. Audited
  // through the same sink as every other sensitive change, and NOT swallowed: if the record of the
  // grant cannot be written, the caller is told, because an unlogged delegation is worse than none.
  try {
    const { logAudit } = await import('@/lib/audit');
    await logAudit({
      userId: input.actorUserId,
      action: 'delegation.granted',
      entity: 'org_relationship',
      entityId: String(res.id || ''),
      diff: {
        principalEmployeeId: input.principalEmployeeId,
        delegateEmployeeId: input.delegateEmployeeId,
        domains: input.domains,
        from: from.toISOString(),
        until: until.toISOString(),
        reason: String(input.reason).trim(),
      },
    });
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[delegation] grant recorded but audit failed:', why);
    return { ok: true, id: res.id, error: 'The delegation was created but could not be written to the audit log: ' + why };
  }

  return res;
}

/**
 * End a delegation now.
 *
 * Closes the edge rather than deleting it, so "who was standing in on the day this was approved"
 * stays answerable. Revocation is deliberately cheap and always available: an authority you cannot
 * withdraw in one action was never really bounded.
 */
export async function endDelegation(
  relationshipId: string,
  actorUserId: string,
  reason: string,
): Promise<OrgWriteResult> {
  if (!isUuid(relationshipId)) return { ok: false, error: 'Unknown delegation.' };
  if (!isUuid(actorUserId)) return { ok: false, error: 'You must be signed in to end a delegation.' };

  const res = await closeRelationship(relationshipId, { asOf: new Date() });
  if (!res.ok) return res;

  try {
    const { logAudit } = await import('@/lib/audit');
    await logAudit({
      userId: actorUserId,
      action: 'delegation.ended',
      entity: 'org_relationship',
      entityId: relationshipId,
      diff: { reason: String(reason || '').trim() },
    });
  } catch (e: any) {
    console.error('[delegation] ended but audit failed:', e?.cause?.message || e?.message);
  }
  return res;
}

/**
 * What this person may currently do on somebody else's behalf.
 *
 * Reads the graph, which is the only source. Returns [] on failure and says so through `error` —
 * a caller must be able to tell "nothing is delegated to you" from "we could not read the graph",
 * because the first is a fact about the organization and the second is a fault.
 */
export async function delegationsHeldBy(
  delegateEmployeeId: string,
): Promise<{ rows: DelegationSummary[]; error: string | null }> {
  if (!isUuid(delegateEmployeeId)) return { rows: [], error: null };
  try {
    const r: any = await db.execute(sql`
      SELECT id, subject_employee_id, object_employee_id, effective_from, effective_to, note
      FROM org_relationships
      WHERE type = 'temporary_delegate'
        AND status = 'active'
        AND subject_employee_id = ${delegateEmployeeId}
        AND effective_from <= NOW()
        AND (effective_to IS NULL OR effective_to > NOW())
      ORDER BY effective_from DESC`);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    return { rows: rows.map(toSummary), error: null };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[delegation] read failed:', why);
    return { rows: [], error: why };
  }
}

/** What this person has handed to others, so they can see it and withdraw it. */
export async function delegationsGrantedBy(
  principalEmployeeId: string,
): Promise<{ rows: DelegationSummary[]; error: string | null }> {
  if (!isUuid(principalEmployeeId)) return { rows: [], error: null };
  try {
    const r: any = await db.execute(sql`
      SELECT id, subject_employee_id, object_employee_id, effective_from, effective_to, note
      FROM org_relationships
      WHERE type = 'temporary_delegate'
        AND status = 'active'
        AND object_employee_id = ${principalEmployeeId}
        AND (effective_to IS NULL OR effective_to > NOW())
      ORDER BY effective_from DESC`);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    return { rows: rows.map(toSummary), error: null };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[delegation] read failed:', why);
    return { rows: [], error: why };
  }
}

function toSummary(row: any): DelegationSummary {
  let domains: DelegableDomain[] = [];
  let reason = '';
  let until = '';
  try {
    const n = JSON.parse(String(row.note || '{}'));
    if (Array.isArray(n.domains)) domains = n.domains;
    reason = String(n.reason || '');
    until = String(n.until || '');
  } catch {
    // A note we cannot parse is not a reason to hide the delegation: an edge with unreadable scope
    // is more alarming than one with none, and the person must still be able to end it.
  }
  const to = String(row.effective_to || until || '');
  const now = Date.now();
  const fromMs = new Date(String(row.effective_from)).getTime();
  const toMs = to ? new Date(to).getTime() : Number.POSITIVE_INFINITY;
  return {
    id: String(row.id),
    delegateEmployeeId: String(row.subject_employee_id),
    principalEmployeeId: String(row.object_employee_id),
    domains,
    from: String(row.effective_from || ''),
    until: to,
    reason,
    inForce: Number.isFinite(fromMs) && fromMs <= now && now < toMs,
  };
}

/**
 * May this person do this thing on that person's behalf, right now?
 *
 * The single question every surface asks. False on any failure, and false for anything on
 * NEVER_DELEGABLE regardless of what an edge claims — so a malformed or over-broad note cannot
 * widen a delegation past the hard limits.
 */
export async function mayActFor(
  delegateEmployeeId: string,
  principalEmployeeId: string,
  domain: string,
): Promise<boolean> {
  if (NEVER_DELEGABLE.some((n) => n.id === domain)) return false;
  if (!(DELEGABLE_DOMAINS as readonly string[]).includes(domain)) return false;
  if (delegateEmployeeId === principalEmployeeId) return false;

  const { rows, error } = await delegationsHeldBy(delegateEmployeeId);
  if (error) return false;
  return rows.some((d) =>
    d.inForce &&
    d.principalEmployeeId === principalEmployeeId &&
    d.domains.includes(domain as DelegableDomain));
}
