// src/lib/hire-reconcile.ts — WHO IS LOST, AND WHERE.
//
// -------------------------------------------------------------------------------------------------
// THE QUESTION NO SCREEN IN THIS PRODUCT COULD ANSWER
// -------------------------------------------------------------------------------------------------
// "Which signed offers have no employee record?"
//
// A hire failed on this project and stayed invisible for eleven days. Not because nothing was
// recorded — offer_letters said 'signed', applications said 'hired', both correct — but because the
// third table simply had no row and NOTHING JOINED THE THREE. Every screen showed its own table and
// each looked right on its own.
//
// This module asks the join. Ten checks, each one a state a real person can be sitting in while every
// individual screen reports success:
//
//   1. signed offers with no employee record          the eleven-day hire
//   2. hires whose handoff did not complete           which step, and the real Postgres reason
//   3. employees with no account                      on the register, cannot sign in
//   4. employees with no department, manager or pay   nobody can give them work; payroll computes zero
//   5. onboarding started and never finished          the checklist nobody closed
//   6. joining documents rejected and left            HR bounced it; the person may not know
//   7. offers that lapsed and still read 'sent'       counted as awaiting signature forever
//   8. leavers whose record is still active           they left; their access did not
//   9. leavers still on the organization graph        approvals still route to somebody who has gone
//  10. exits with reports still attached              a team pointing at a ghost
//
// -------------------------------------------------------------------------------------------------
// A CHECK THAT COULD NOT RUN SAYS SO
// -------------------------------------------------------------------------------------------------
// Every function returns { rows, error }. An empty list because a table does not exist and an empty
// list because nobody is lost are OPPOSITE facts, and a reconciliation screen that renders both as a
// reassuring "None" is worse than no screen at all — it is the same swallowed failure this whole file
// exists to catch, one layer up. The page prints the error next to the heading.
//
// ALMOST READ-ONLY. Every repair belongs to the module that owns the record — hire-completion.ts for
// the handoff and for onboarding status, hr-separation.ts for closing an exit properly,
// org-graph.ts for edges. The single write below (closeLeaverEdge) is a thin, audited wrapper over
// org-graph.closeRelationship() and exists only because check 9 finds edges that no exit will ever
// close: the person's record was closed by hand, or before the graph existed, so completeSeparation()
// is not coming for them. It CLOSES, never revokes — a person who worked here and left is the exact
// opposite of an edge that should never have existed.
//
// HOUSE RULES OBSERVED: postgres-js returns PLAIN ARRAYS; the real Postgres reason is on e.cause;
// hr_employees uses full_name; no relationship is read from users.role; no DDL is executed here.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rowsOf(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
function reasonOf(e: any): string { return String(e?.cause?.message || e?.message || 'unknown error'); }

/** A check result. `error` is non-null when the check could NOT be answered. */
export interface Check<T> {
  rows: T[];
  error: string | null;
}

async function check<T>(name: string, run: () => Promise<T[]>): Promise<Check<T>> {
  try {
    return { rows: await run(), error: null };
  } catch (e: any) {
    console.error('[hire-reconcile] ' + name + ':', reasonOf(e));
    return { rows: [], error: 'This check could not run: ' + reasonOf(e) };
  }
}

function cap(limit: number, fallback = 50): number {
  const n = Number(limit) || fallback;
  return Math.max(1, Math.min(200, n));
}

function dateOnly(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
}

// -------------------------------------------------------------------------------------------------
// 1. SIGNED OFFERS WITH NO EMPLOYEE RECORD
// -------------------------------------------------------------------------------------------------

export interface SignedNoEmployee {
  offerId: string;
  applicationId: string | null;
  userId: string | null;
  candidateName: string;
  candidateEmail: string;
  roleTitle: string;
  signedAt: string | null;
  daysSince: number | null;
  handoffState: string | null;
  lastError: string | null;
}

/**
 * The check that would have found the eleven-day hire on day one.
 *
 * An employee is matched four ways — application, account, personal email, work email — because the
 * record can legitimately have been created through any of the doors. A person only appears here when
 * NONE of the four finds them, which is the honest definition of "this hire exists nowhere in HR".
 */
export async function signedOffersWithoutEmployee(limit = 50): Promise<Check<SignedNoEmployee>> {
  return check('signedOffersWithoutEmployee', async () => rowsOf(await db.execute(sql`
    SELECT o.id, o.application_id, o.created_user_id, o.candidate_name, o.candidate_email,
           o.role_title, o.signed_at,
           EXTRACT(DAY FROM (NOW() - o.signed_at))::int AS days_since,
           h.state AS handoff_state, h.last_error
      FROM offer_letters o
      LEFT JOIN hr_employees e
        ON  (o.application_id IS NOT NULL AND e.application_id = o.application_id)
         OR (o.created_user_id IS NOT NULL AND e.user_id = o.created_user_id)
         OR (COALESCE(o.candidate_email, '') <> ''
             AND lower(COALESCE(e.personal_email, '')) = lower(o.candidate_email))
         OR (COALESCE(o.candidate_email, '') <> ''
             AND lower(COALESCE(e.email, '')) = lower(o.candidate_email))
      LEFT JOIN hr_hire_handoffs h ON h.offer_id = o.id
     WHERE o.status = 'signed' AND e.id IS NULL
     ORDER BY o.signed_at DESC NULLS LAST
     LIMIT ${cap(limit)}`)).map((r: any) => ({
    offerId: String(r.id),
    applicationId: r.application_id ? String(r.application_id) : null,
    userId: r.created_user_id ? String(r.created_user_id) : null,
    candidateName: String(r.candidate_name || ''),
    candidateEmail: String(r.candidate_email || ''),
    roleTitle: String(r.role_title || ''),
    signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
    daysSince: r.days_since === null || r.days_since === undefined ? null : Number(r.days_since),
    handoffState: r.handoff_state ? String(r.handoff_state) : null,
    lastError: r.last_error ? String(r.last_error) : null,
  })));
}

// -------------------------------------------------------------------------------------------------
// 2. HANDOFFS THAT DID NOT COMPLETE
// -------------------------------------------------------------------------------------------------

export interface IncompleteHandoff {
  id: string;
  offerId: string | null;
  applicationId: string | null;
  employeeId: string | null;
  candidateName: string;
  roleTitle: string;
  agreedPay: string | null;
  steps: Array<{ key: string; label: string; ok: boolean; skipped: boolean; detail: string }>;
  gaps: string[];
  lastError: string | null;
  attempts: number;
  updatedAt: string | null;
}

/** Every hire whose handoff has an unfinished step, with the step named and the reason kept. */
export async function incompleteHandoffs(limit = 50): Promise<Check<IncompleteHandoff>> {
  return check('incompleteHandoffs', async () => rowsOf(await db.execute(sql`
    SELECT id, offer_id, application_id, employee_id, candidate_name, role_title, agreed_pay,
           steps, gaps, last_error, attempts, updated_at
      FROM hr_hire_handoffs
     WHERE state <> 'complete'
     ORDER BY updated_at DESC
     LIMIT ${cap(limit)}`)).map((r: any) => ({
    id: String(r.id),
    offerId: r.offer_id ? String(r.offer_id) : null,
    applicationId: r.application_id ? String(r.application_id) : null,
    employeeId: r.employee_id ? String(r.employee_id) : null,
    candidateName: String(r.candidate_name || ''),
    roleTitle: String(r.role_title || ''),
    agreedPay: r.agreed_pay ? String(r.agreed_pay) : null,
    steps: Array.isArray(r.steps) ? r.steps : [],
    gaps: Array.isArray(r.gaps) ? r.gaps : [],
    lastError: r.last_error ? String(r.last_error) : null,
    attempts: Number(r.attempts || 0),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  })));
}

// -------------------------------------------------------------------------------------------------
// 3. EMPLOYEES WITH NO ACCOUNT
// -------------------------------------------------------------------------------------------------

export interface EmployeeNoAccount {
  employeeId: string;
  fullName: string;
  employeeCode: string | null;
  email: string | null;
  joiningDate: string | null;
  reason: string;
}

/**
 * On the register, and cannot sign in.
 *
 * Two different facts, and the row says which: user_id is NULL (nobody ever linked an account), or
 * user_id points at a users row that is no longer there.
 */
export async function employeesWithoutAccount(limit = 50): Promise<Check<EmployeeNoAccount>> {
  return check('employeesWithoutAccount', async () => rowsOf(await db.execute(sql`
    SELECT e.id, e.full_name, e.employee_code, COALESCE(e.email, e.personal_email) AS email,
           e.joining_date, (e.user_id IS NULL) AS never_linked
      FROM hr_employees e
      LEFT JOIN users u ON u.id = e.user_id
     WHERE e.is_active = true
       AND (e.user_id IS NULL OR u.id IS NULL)
     ORDER BY e.joining_date DESC NULLS LAST, e.created_at DESC
     LIMIT ${cap(limit)}`)).map((r: any) => ({
    employeeId: String(r.id),
    fullName: String(r.full_name || ''),
    employeeCode: r.employee_code ? String(r.employee_code) : null,
    email: r.email ? String(r.email) : null,
    joiningDate: dateOnly(r.joining_date),
    reason: r.never_linked
      ? 'No account has ever been linked to this employee record.'
      : 'The account this record points at no longer exists.',
  })));
}

// -------------------------------------------------------------------------------------------------
// 4. EMPLOYEES WITH NO DEPARTMENT, NO MANAGER OR NO PAY
// -------------------------------------------------------------------------------------------------

export interface PlacementGap {
  employeeId: string;
  fullName: string;
  employeeCode: string | null;
  designation: string | null;
  joiningDate: string | null;
  onboardingStatus: string;
  missing: string[];
}

/**
 * The cascade the signing path used to create every time.
 *
 * No department and no manager is not a tidiness problem: src/lib/employee-tasks.ts admits an
 * assigner only if they are the person themselves, their reporting manager, or a head of their
 * department — so with both NULL, NOBODY in the company can give this person their first task. Every
 * onboarding step owned via a relationship resolves unowned. And a NULL base salary is a payslip of
 * zero that balances perfectly and warns nobody.
 */
export async function employeesMissingPlacement(limit = 50): Promise<Check<PlacementGap>> {
  return check('employeesMissingPlacement', async () => rowsOf(await db.execute(sql`
    SELECT e.id, e.full_name, e.employee_code, e.designation, e.joining_date,
           COALESCE(e.onboarding_status, 'pending') AS onboarding_status,
           (e.department_id IS NULL) AS no_department,
           (e.reporting_manager_id IS NULL) AS no_manager,
           (e.base_salary IS NULL OR e.base_salary = 0) AS no_salary
      FROM hr_employees e
     WHERE e.is_active = true
       AND (e.department_id IS NULL OR e.reporting_manager_id IS NULL
            OR e.base_salary IS NULL OR e.base_salary = 0)
     ORDER BY e.joining_date DESC NULLS LAST, e.created_at DESC
     LIMIT ${cap(limit)}`)).map((r: any) => {
    const missing: string[] = [];
    if (r.no_department) missing.push('department');
    if (r.no_manager) missing.push('reporting manager');
    if (r.no_salary) missing.push('base salary');
    return {
      employeeId: String(r.id),
      fullName: String(r.full_name || ''),
      employeeCode: r.employee_code ? String(r.employee_code) : null,
      designation: r.designation ? String(r.designation) : null,
      joiningDate: dateOnly(r.joining_date),
      onboardingStatus: String(r.onboarding_status || 'pending'),
      missing,
    };
  }));
}

// -------------------------------------------------------------------------------------------------
// 5. ONBOARDING STARTED AND NEVER FINISHED
// -------------------------------------------------------------------------------------------------

export interface OnboardingOpen {
  employeeId: string;
  fullName: string;
  employeeCode: string | null;
  joiningDate: string | null;
  daysSinceJoining: number | null;
  onboardingStatus: string;
  journeyId: string | null;
  pendingItems: number;
  overdueItems: number;
  unownedItems: number;
}

/**
 * Everyone whose onboarding has not been closed, and what is actually outstanding.
 *
 * onboarding_status was a one-way street until src/lib/hire-completion.ts gave it an exit: the portal
 * wrote 'submitted' and nothing anywhere wrote 'verified' or 'complete', so two analytics modules
 * counted every employee the company has ever hired as "currently onboarding", forever. This lists
 * them with the checklist state beside the status, so closing one is an informed act rather than a
 * shrug.
 *
 * The journey tables belong to src/lib/onboarding-journey.ts and may not exist yet on a fresh
 * database. That is why the joins are LEFT and why the whole check reports its own failure.
 */
export async function onboardingUnfinished(limit = 50): Promise<Check<OnboardingOpen>> {
  return check('onboardingUnfinished', async () => {
    const { ensureJourneySchema } = await import('@/lib/onboarding-journey');
    await ensureJourneySchema();
    return rowsOf(await db.execute(sql`
      SELECT e.id, e.full_name, e.employee_code, e.joining_date,
             COALESCE(e.onboarding_status, 'pending') AS onboarding_status,
             (CURRENT_DATE - e.joining_date)::int AS days_since_joining,
             j.id AS journey_id,
             COUNT(i.id) FILTER (WHERE i.state = 'pending')::int AS pending_items,
             COUNT(i.id) FILTER (WHERE i.state = 'pending' AND i.due_on IS NOT NULL
                                   AND i.due_on < CURRENT_DATE)::int AS overdue_items,
             COUNT(i.id) FILTER (WHERE i.owner_employee_id IS NULL
                                   AND i.state IN ('pending', 'blocked'))::int AS unowned_items
        FROM hr_employees e
        LEFT JOIN hr_onboarding_journeys j ON j.employee_id = e.id
        LEFT JOIN hr_onboarding_journey_items i ON i.journey_id = j.id
       WHERE e.is_active = true
         AND COALESCE(e.onboarding_status, 'pending') <> 'complete'
       GROUP BY e.id, e.full_name, e.employee_code, e.joining_date, e.onboarding_status, j.id
       ORDER BY e.joining_date ASC NULLS LAST
       LIMIT ${cap(limit)}`)).map((r: any) => ({
      employeeId: String(r.id),
      fullName: String(r.full_name || ''),
      employeeCode: r.employee_code ? String(r.employee_code) : null,
      joiningDate: dateOnly(r.joining_date),
      daysSinceJoining: r.days_since_joining === null || r.days_since_joining === undefined
        ? null : Number(r.days_since_joining),
      onboardingStatus: String(r.onboarding_status || 'pending'),
      journeyId: r.journey_id ? String(r.journey_id) : null,
      pendingItems: Number(r.pending_items || 0),
      overdueItems: Number(r.overdue_items || 0),
      unownedItems: Number(r.unowned_items || 0),
    }));
  });
}

// -------------------------------------------------------------------------------------------------
// 6. JOINING DOCUMENTS REJECTED AND LEFT
// -------------------------------------------------------------------------------------------------

export interface RejectedDoc {
  id: number;
  userId: string;
  personName: string;
  docType: string;
  title: string;
  reviewNote: string | null;
  reviewedAt: string | null;
}

/**
 * A rejected credential holds the whole document step open, and the hire's own progress() reads
 * complete only when EVERY document is verified. reviewDoc() now tells them; these are the ones
 * rejected before it did, still waiting on somebody who was never told anything was wrong.
 */
export async function rejectedJoiningDocuments(limit = 50): Promise<Check<RejectedDoc>> {
  return check('rejectedJoiningDocuments', async () => rowsOf(await db.execute(sql`
    SELECT d.id, d.user_id, d.doc_type, d.title, d.review_note, d.reviewed_at,
           COALESCE(u.name, u.email, '') AS person_name
      FROM hr_onboarding_documents d
      LEFT JOIN users u ON u.id::text = d.user_id
     WHERE d.status = 'rejected'
     ORDER BY d.reviewed_at DESC NULLS LAST, d.id DESC
     LIMIT ${cap(limit)}`)).map((r: any) => ({
    id: Number(r.id),
    userId: String(r.user_id || ''),
    personName: String(r.person_name || ''),
    docType: String(r.doc_type || ''),
    title: String(r.title || ''),
    reviewNote: r.review_note ? String(r.review_note) : null,
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
  })));
}

// -------------------------------------------------------------------------------------------------
// 7. OFFERS THAT LAPSED AND STILL READ 'sent'
// -------------------------------------------------------------------------------------------------

export interface LapsedOffer {
  offerId: string;
  applicationId: string | null;
  candidateName: string;
  roleTitle: string;
  expiryDate: string | null;
  daysOverdue: number | null;
}

/**
 * Expiry was computed per page load and never persisted, so a lapsed offer stayed indistinguishable
 * from a live one in every count, export and "awaiting signature" widget. expireOffer() in
 * hire-completion.ts is the transition; this is the list it acts on.
 *
 * The date is compared AS TEXT. offer_letters.expiry_date is varchar, and a ::date cast throws on the
 * whole query the moment one row holds anything that is not a date — ISO strings compare correctly
 * without the cast, and the regex keeps malformed rows out rather than letting them raise.
 */
export async function lapsedOffers(limit = 50): Promise<Check<LapsedOffer>> {
  return check('lapsedOffers', async () => rowsOf(await db.execute(sql`
    SELECT o.id, o.application_id, o.candidate_name, o.role_title, o.expiry_date,
           (CURRENT_DATE - to_date(substring(o.expiry_date from 1 for 10), 'YYYY-MM-DD'))::int AS days_overdue
      FROM offer_letters o
     WHERE o.status = 'sent'
       AND o.expiry_date IS NOT NULL
       AND substring(o.expiry_date from 1 for 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       AND substring(o.expiry_date from 1 for 10) < to_char(CURRENT_DATE, 'YYYY-MM-DD')
     ORDER BY o.expiry_date ASC
     LIMIT ${cap(limit)}`)).map((r: any) => ({
    offerId: String(r.id),
    applicationId: r.application_id ? String(r.application_id) : null,
    candidateName: String(r.candidate_name || ''),
    roleTitle: String(r.role_title || ''),
    expiryDate: r.expiry_date ? String(r.expiry_date).slice(0, 10) : null,
    daysOverdue: r.days_overdue === null || r.days_overdue === undefined ? null : Number(r.days_overdue),
  })));
}

// -------------------------------------------------------------------------------------------------
// 8. LEAVERS WHOSE RECORD IS STILL ACTIVE
// -------------------------------------------------------------------------------------------------

export interface OpenLeaver {
  employeeId: string;
  fullName: string;
  employeeCode: string | null;
  lastWorkingDay: string | null;
  separationId: string | null;
  separationStatus: string | null;
  daysSince: number | null;
}

/**
 * Their last working day has passed and hr_employees.is_active is still true.
 *
 * This is an ACCESS fact, not a bookkeeping one — an active employee record is what the workspace,
 * the task board and the approval queues read. hr-separation.completeSeparation() is the proper exit
 * and it refuses until the clearances, the interview and the settlement are done; this list is how
 * somebody finds the exits that stalled before reaching it.
 */
export async function leaversStillActive(limit = 50): Promise<Check<OpenLeaver>> {
  return check('leaversStillActive', async () => rowsOf(await db.execute(sql`
    SELECT e.id, e.full_name, e.employee_code,
           COALESCE(e.last_working_day, e.exit_date) AS last_day,
           (CURRENT_DATE - COALESCE(e.last_working_day, e.exit_date))::int AS days_since,
           s.id AS separation_id, s.status AS separation_status
      FROM hr_employees e
      LEFT JOIN hr_separations s ON s.employee_id = e.id AND s.closed_at IS NULL
     WHERE e.is_active = true
       AND COALESCE(e.last_working_day, e.exit_date) IS NOT NULL
       AND COALESCE(e.last_working_day, e.exit_date) < CURRENT_DATE
     ORDER BY COALESCE(e.last_working_day, e.exit_date) ASC
     LIMIT ${cap(limit)}`)).map((r: any) => ({
    employeeId: String(r.id),
    fullName: String(r.full_name || ''),
    employeeCode: r.employee_code ? String(r.employee_code) : null,
    lastWorkingDay: dateOnly(r.last_day),
    separationId: r.separation_id ? String(r.separation_id) : null,
    separationStatus: r.separation_status ? String(r.separation_status) : null,
    daysSince: r.days_since === null || r.days_since === undefined ? null : Number(r.days_since),
  })));
}

// -------------------------------------------------------------------------------------------------
// 9. LEAVERS STILL ON THE ORGANIZATION GRAPH
// -------------------------------------------------------------------------------------------------

export interface OpenEdge {
  relationshipId: string;
  type: string;
  subjectEmployeeId: string | null;
  subjectName: string;
  objectEmployeeId: string | null;
  objectName: string;
  effectiveFrom: string | null;
  /** Which end of the edge has left. */
  leaverSide: 'subject' | 'object' | 'both';
  leaverEmployeeId: string;
  leaverName: string;
}

/**
 * An open edge belonging to somebody whose employee record is closed.
 *
 * The graph is deliberately append-only — an edge is CLOSED with effective_to, never deleted, because
 * revoking would erase the approvals that person legitimately made. But an edge left OPEN keeps
 * answering "who manages this team" with the name of somebody who has gone, so their reports' leave
 * routes to nobody and the halt says nothing about an exit.
 */
export async function leaversWithOpenEdges(limit = 100): Promise<Check<OpenEdge>> {
  return check('leaversWithOpenEdges', async () => rowsOf(await db.execute(sql`
    SELECT r.id, r.type, r.subject_employee_id, r.object_employee_id, r.effective_from,
           COALESCE(se.full_name, '') AS subject_name,
           COALESCE(oe.full_name, '') AS object_name,
           COALESCE(se.is_active, true) AS subject_active,
           COALESCE(oe.is_active, true) AS object_active
      FROM org_relationships r
      LEFT JOIN hr_employees se ON se.id = r.subject_employee_id
      LEFT JOIN hr_employees oe ON oe.id = r.object_employee_id
     WHERE r.status = 'active'
       AND r.effective_to IS NULL
       AND (se.is_active = false OR oe.is_active = false)
     ORDER BY r.effective_from DESC
     LIMIT ${cap(limit, 100)}`)).map((r: any) => {
    const subjectGone = r.subject_active === false;
    const objectGone = r.object_active === false;
    const side: 'subject' | 'object' | 'both' =
      subjectGone && objectGone ? 'both' : (subjectGone ? 'subject' : 'object');
    return {
      relationshipId: String(r.id),
      type: String(r.type || ''),
      subjectEmployeeId: r.subject_employee_id ? String(r.subject_employee_id) : null,
      subjectName: String(r.subject_name || ''),
      objectEmployeeId: r.object_employee_id ? String(r.object_employee_id) : null,
      objectName: String(r.object_name || ''),
      effectiveFrom: r.effective_from ? new Date(r.effective_from).toISOString() : null,
      leaverSide: side,
      leaverEmployeeId: String(subjectGone ? (r.subject_employee_id || '') : (r.object_employee_id || '')),
      leaverName: String(subjectGone ? (r.subject_name || '') : (r.object_name || '')),
    };
  }));
}

// -------------------------------------------------------------------------------------------------
// 10. EXITS WITH REPORTS STILL ATTACHED
// -------------------------------------------------------------------------------------------------

export interface ExitWithReports {
  separationId: string;
  employeeId: string;
  fullName: string;
  lastWorkingDay: string | null;
  separationStatus: string;
  reportCount: number;
}

/**
 * An open separation where people still report to the person leaving.
 *
 * completeSeparation() refuses to close in this state and offers the leaver's own manager as the
 * default landing place — but only if somebody opens that screen. This is the list that says somebody
 * should.
 */
export async function exitsWithReportsAttached(limit = 50): Promise<Check<ExitWithReports>> {
  return check('exitsWithReportsAttached', async () => rowsOf(await db.execute(sql`
    SELECT s.id AS separation_id, s.employee_id, s.last_working_day, s.status,
           COALESCE(e.full_name, '') AS full_name,
           COUNT(r.id)::int AS report_count
      FROM hr_separations s
      JOIN hr_employees e ON e.id = s.employee_id
      LEFT JOIN org_relationships r
        ON  r.subject_employee_id = s.employee_id
        AND r.type = 'reporting_manager'
        AND r.status = 'active'
        AND r.effective_to IS NULL
     WHERE s.closed_at IS NULL
     GROUP BY s.id, s.employee_id, s.last_working_day, s.status, e.full_name
    HAVING COUNT(r.id) > 0
     ORDER BY s.last_working_day ASC NULLS LAST
     LIMIT ${cap(limit)}`)).map((r: any) => ({
    separationId: String(r.separation_id),
    employeeId: String(r.employee_id),
    fullName: String(r.full_name || ''),
    lastWorkingDay: dateOnly(r.last_working_day),
    separationStatus: String(r.status || ''),
    reportCount: Number(r.report_count || 0),
  })));
}

// -------------------------------------------------------------------------------------------------
// THE ONE REPAIR THAT BELONGS NOWHERE ELSE
// -------------------------------------------------------------------------------------------------

/**
 * Close one open edge belonging to somebody who has left.
 *
 * WHY THIS IS NOT completeSeparation(). That function is the right way to end an employment and it
 * does far more: it reassigns the direct reports first, closes every edge at the end of the last
 * working day, and refuses until the clearances, the exit interview and the settlement are recorded.
 * Use it whenever there is a separation to close, and this screen links to it.
 *
 * This exists for the edges completeSeparation() will never reach: the record was closed by hand, or
 * it was closed before the Organization Graph existed. Those edges keep answering "who manages this
 * team" with a name that has gone, and nothing else in the product can close them.
 *
 * REFUSES IF THE PERSON IS STILL HERE. The check finds the edge because one END of it is inactive;
 * this re-reads that fact at write time rather than trusting a list rendered seconds ago.
 */
export async function closeLeaverEdge(
  relationshipId: string,
  actorUserId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const id = String(relationshipId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { ok: false, error: 'That relationship could not be identified.' };
  }
  try {
    const found = rowsOf(await db.execute(sql`
      SELECT r.id, r.type,
             COALESCE(se.is_active, true) AS subject_active,
             COALESCE(oe.is_active, true) AS object_active,
             GREATEST(
               COALESCE(se.last_working_day, se.exit_date, DATE '1900-01-01'),
               COALESCE(oe.last_working_day, oe.exit_date, DATE '1900-01-01')
             ) AS last_day
        FROM org_relationships r
        LEFT JOIN hr_employees se ON se.id = r.subject_employee_id
        LEFT JOIN hr_employees oe ON oe.id = r.object_employee_id
       WHERE r.id = ${id}::uuid AND r.status = 'active' AND r.effective_to IS NULL
       LIMIT 1`));
    if (!found.length) {
      return { ok: false, error: 'That edge is already closed, or is not an open active relationship.' };
    }
    const row = found[0] as any;
    if (row.subject_active !== false && row.object_active !== false) {
      return { ok: false, error: 'Both people on that relationship are still employed here. Nothing was changed.' };
    }

    // The closing instant. Edges close at the END of the last working day, not at its start — a person
    // who worked that day was still the manager that day, and closing at midnight would make every
    // approval they made on their final day read as an approval by nobody. Where no last working day
    // was ever recorded, close as of now rather than guessing a date backwards.
    const lastDay = row.last_day ? new Date(row.last_day) : null;
    const asOf = lastDay && !isNaN(lastDay.getTime()) && lastDay.getUTCFullYear() > 1900
      ? new Date(lastDay.toISOString().slice(0, 10) + 'T23:59:59Z')
      : new Date();

    const { closeRelationship } = await import('@/lib/org-graph');
    const done = await closeRelationship(id, { asOf });
    if (!done.ok) return { ok: false, error: done.error || 'The edge was not closed.' };

    try {
      const { logAudit } = await import('@/lib/audit');
      await logAudit({
        userId: actorUserId, action: 'org.edge_closed_for_leaver', entity: 'org_relationship', entityId: id,
        diff: { type: String(row.type || ''), closedAsOf: asOf.toISOString(), via: 'reconciliation screen' },
      });
    } catch (e: any) {
      console.error('[hire-reconcile] closeLeaverEdge audit:', reasonOf(e));
    }
    return { ok: true };
  } catch (e: any) {
    console.error('[hire-reconcile] closeLeaverEdge:', reasonOf(e));
    return { ok: false, error: 'The edge was not closed: ' + reasonOf(e) };
  }
}

// -------------------------------------------------------------------------------------------------
// THE WHOLE PICTURE, IN ONE ROUND OF READS
// -------------------------------------------------------------------------------------------------

export interface ReconciliationReport {
  signedNoEmployee: Check<SignedNoEmployee>;
  incompleteHandoffs: Check<IncompleteHandoff>;
  noAccount: Check<EmployeeNoAccount>;
  placementGaps: Check<PlacementGap>;
  onboardingOpen: Check<OnboardingOpen>;
  rejectedDocs: Check<RejectedDoc>;
  lapsed: Check<LapsedOffer>;
  openLeavers: Check<OpenLeaver>;
  openEdges: Check<OpenEdge>;
  exitsWithReports: Check<ExitWithReports>;
  /** People who need a human, counted across the checks that mean somebody is stuck. */
  urgentCount: number;
  /** How many checks could not be answered at all. Rendered, never hidden. */
  failedChecks: number;
}

export async function reconciliationReport(): Promise<ReconciliationReport> {
  // The handoff ledger is joined by two of the checks below, so it has to exist before they run.
  // A failure here is not fatal — those two checks will report their own inability rather than
  // taking the whole screen down — but it is logged with the real reason rather than dropped.
  try {
    const { ensureHireHandoffSchema } = await import('@/lib/hire-completion');
    await ensureHireHandoffSchema();
  } catch (e: any) {
    console.error('[hire-reconcile] handoff schema:', reasonOf(e));
  }

  const [
    signedNoEmployee, handoffs, noAccount, placementGaps, onboardingOpen,
    rejectedDocs, lapsed, openLeavers, openEdges, exitsWithReports,
  ] = await Promise.all([
    signedOffersWithoutEmployee(),
    incompleteHandoffs(),
    employeesWithoutAccount(),
    employeesMissingPlacement(),
    onboardingUnfinished(),
    rejectedJoiningDocuments(),
    lapsedOffers(),
    leaversStillActive(),
    leaversWithOpenEdges(),
    exitsWithReportsAttached(),
  ]);

  const all = [signedNoEmployee, handoffs, noAccount, placementGaps, onboardingOpen,
    rejectedDocs, lapsed, openLeavers, openEdges, exitsWithReports];

  return {
    signedNoEmployee,
    incompleteHandoffs: handoffs,
    noAccount,
    placementGaps,
    onboardingOpen,
    rejectedDocs,
    lapsed,
    openLeavers,
    openEdges,
    exitsWithReports,
    // Deliberately NOT every list. Onboarding still running and an offer that lapsed are ordinary;
    // a signed hire with no record, a person who cannot sign in, a leaver still active and a leaver
    // still on the graph are each somebody stuck or somebody holding access they should not.
    urgentCount: signedNoEmployee.rows.length + handoffs.rows.length + noAccount.rows.length
      + openLeavers.rows.length + openEdges.rows.length + exitsWithReports.rows.length,
    failedChecks: all.filter((c) => c.error).length,
  };
}
