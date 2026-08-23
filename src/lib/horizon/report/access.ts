// src/lib/horizon/report/access.ts — WHO MAY READ A REPORT, AND HOW MUCH OF IT.
//
// =================================================================================================
// THE POLICY IN FIVE SENTENCES
// =================================================================================================
//
// 1. A report is permitted by HOLDING ONE OF ITS PERMISSIONS, by BEING ITS SUBJECT where the
//    definition allows that, or by BEING THE SUBJECT'S REPORTING MANAGER on a manager-audience
//    report. Nothing else opens one.
// 2. A degraded permission resolve DENIES. An access layer that opens up when the database blinks is
//    the same mistake as a sidebar that does, and this codebase has written that comment once
//    already.
// 3. IDENTIFIERS ARE WITHHELD, EXPLANATIONS ARE NOT. A viewer without oversight permission still
//    sees every statement, every confidence and every piece of reasoning; what they do not see is
//    the relation names and row ids that let them go and read other people's records. That is the
//    line rule 18 is actually drawing, and hiding the reasoning instead would leave an unexplained
//    conclusion about a person on the screen — the exact thing this engine exists to prevent.
// 4. A SUBJECT READING THEIR OWN REPORT SEES THE MOST, not the least. They get the internals, because
//    a system that reasons about somebody and will not show them the reasoning cannot be audited by
//    the only person with a real interest in auditing it.
// 5. CONTRIBUTORS ARE PROTECTED FROM THE SUBJECT. When the subject is the reader, feedback is shown
//    in full and its authors are not named. Feedback stops being honest the moment the person it is
//    about can see who wrote what, and the content is the useful half anyway.
//
// =================================================================================================
// WHY THIS PATCH ADDS NO PERMISSION NAMES
// =================================================================================================
//
// `Permission` in src/lib/auth/permissions.ts is a union several patches read and one file owns.
// Widening it for a report engine would be a change to a shared contract in exchange for nothing:
// every report here maps cleanly onto a permission that already exists and already means the right
// thing. If a later patch needs `intelligence.report.*` as first-class keys, the definitions in
// registry.ts are the only place that changes.
import { resolvePermissions, holdsPermission } from '@/lib/auth/registry';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { toRows } from '@/lib/page-safety';
import type { ReportDefinition, ReportSubject, SectionKind, ViewerContext } from './types';

export interface AccessDecision {
  allowed: boolean;
  /** A sentence for the person who was refused. Never a code. */
  reason: string;
  basis: 'permission' | 'self' | 'manager' | 'denied';
  viewer: ViewerContext;
  /** Sections the viewer will see less of, and why. Rendered; never silent. */
  redactions: { section: SectionKind; reason: string }[];
  /** May this viewer record the final human decision from the report surface. */
  canRecordDecision: boolean;
  /** True when feedback author names are removed before the document is built. */
  anonymiseFeedbackAuthors: boolean;
}

/**
 * The two permissions that mean "this person is here to oversee the system", as opposed to "this
 * person is doing their job". Holding either is what unlocks record-level identifiers.
 *
 * Both are super_admin-only in PERMS_BY_ROLE today, and both can be granted to a custom role through
 * the registry — which is the point of resolving through resolvePermissions() rather than testing
 * `user.role` directly. A founder who creates an auditor role gets a working auditor with no deploy.
 */
const OVERSIGHT_PERMISSIONS = ['audit.view', 'profiles.manage'];

function denied(reason: string, viewer: ViewerContext): AccessDecision {
  return {
    allowed: false, reason, basis: 'denied', viewer,
    redactions: [], canRecordDecision: false, anonymiseFeedbackAuthors: false,
  };
}

/**
 * hr_employees.id for a users.id, or null.
 *
 * Cached per call rather than per request: this runs once per report generation, and a report
 * generation is already several round trips. Adding a memo here would be the kind of cache that
 * outlives a permission change.
 */
export async function employeeIdForUser(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const rows = toRows(await db.execute(sql`
      SELECT id::text AS id FROM hr_employees WHERE user_id = ${userId}::uuid LIMIT 1`));
    const r: any = rows[0];
    return r ? String(r.id) : null;
  } catch {
    // A failure here must not be read as "this person is not an employee", because that would open
    // nothing and close a self-view. It returns null and the caller denies — fail closed.
    return null;
  }
}

/**
 * Is the viewer the reporting manager of this employee?
 *
 * hr_employees.reporting_manager_id HOLDS A users.id. The column sits among a dozen employee ids and
 * reads like another one; comparing it to an hr_employees.id returns false for every manager in the
 * organisation, silently, which would turn this check into a blanket denial nobody notices.
 */
async function isReportingManagerOf(subjectEmployeeId: string, viewerUserId: string | null): Promise<boolean> {
  if (!viewerUserId) return false;
  try {
    const rows = toRows(await db.execute(sql`
      SELECT 1 AS ok
        FROM hr_employees
       WHERE id = ${subjectEmployeeId}::uuid
         AND reporting_manager_id = ${viewerUserId}::uuid
       LIMIT 1`));
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * The access decision for one viewer, one report and one subject.
 *
 * `locals` is threaded through to resolvePermissions so eight checks on one page cost one lookup.
 */
export async function decideAccess(
  definition: ReportDefinition,
  subject: ReportSubject,
  viewerUser: { id: string | null; role: string | null },
  opts: { locals?: any } = {},
): Promise<AccessDecision> {
  const baseViewer: ViewerContext = {
    userId: viewerUser.id || null,
    role: viewerUser.role || 'unknown',
    employeeId: null,
    canSeeInternals: false,
  };

  if (!viewerUser.id) {
    return denied('You are not signed in.', baseViewer);
  }
  // The one role in PERMS_BY_ROLE that holds nothing. Named explicitly so the refusal is a sentence
  // rather than an empty permission set producing a vaguer one.
  if (viewerUser.role === 'applicant') {
    return denied('This console is not part of the applicant portal.', baseViewer);
  }

  const resolved = await resolvePermissions(viewerUser.id, { locals: opts.locals });
  if (resolved.degraded) {
    return denied(
      'Your permissions could not be read just now, so nothing is being shown. This is a refusal by '
      + 'design: an access check that opens up when the database is unavailable is not an access check.',
      baseViewer,
    );
  }

  const viewerEmployeeId = await employeeIdForUser(viewerUser.id);
  const hasOversight = OVERSIGHT_PERMISSIONS.some((p) => holdsPermission(resolved, p));
  const hasRequired = definition.requiredPermissions.some((p) => holdsPermission(resolved, String(p)));

  const isSelf = definition.allowSelf
    && subject.kind !== 'organisation'
    && !!viewerEmployeeId
    && viewerEmployeeId === subject.id;

  let isManager = false;
  if (!hasRequired && !isSelf && subject.kind !== 'organisation' && subject.kind !== 'applicant') {
    // Only asked when it can change the answer. It is a round trip.
    isManager = await isReportingManagerOf(subject.id, viewerUser.id);
  }

  if (!hasRequired && !isSelf && !isManager) {
    return denied(
      'You do not hold a permission that opens this report, you are not its subject, and you are not '
      + 'the reporting manager of its subject.',
      { ...baseViewer, employeeId: viewerEmployeeId },
    );
  }

  const basis: AccessDecision['basis'] = hasRequired ? 'permission' : (isSelf ? 'self' : 'manager');

  // INTERNALS. The subject always sees their own; otherwise it takes oversight permission, or a
  // standard-sensitivity report the viewer is properly permitted for.
  const canSeeInternals = isSelf || hasOversight || (hasRequired && definition.sensitivity === 'standard');

  const redactions: { section: SectionKind; reason: string }[] = [];
  if (!canSeeInternals) {
    // Recorded against every section that carries provenance a reader would otherwise follow.
    const reason =
      'Record identifiers and relation names are withheld at your permission level. Every statement, '
      + 'its confidence and its reasoning are shown in full.';
    for (const s of ['facts', 'derived', 'human_feedback', 'ai_interpretation', 'recommendation', 'human_decision'] as SectionKind[]) {
      redactions.push({ section: s, reason });
    }
  }

  const anonymiseFeedbackAuthors = isSelf;
  if (anonymiseFeedbackAuthors) {
    redactions.push({
      section: 'human_feedback',
      reason:
        'You are reading a report about yourself. The feedback is shown in full and the people who '
        + 'wrote it are not named — that is what keeps it honest.',
    });
  }

  return {
    allowed: true,
    reason: basis === 'permission'
      ? 'Opened on a permission you hold.'
      : (basis === 'self' ? 'Opened as the subject of this report.' : 'Opened as the reporting manager of its subject.'),
    basis,
    viewer: {
      userId: viewerUser.id,
      role: viewerUser.role || 'unknown',
      employeeId: viewerEmployeeId,
      canSeeInternals,
    },
    redactions,
    // RECORDING A DECISION IS NOT A READING RIGHT. It takes a permission on the report, and it is
    // refused to somebody who only reached the document by being its subject or their manager —
    // neither of whom is the person the organisation asked to decide.
    canRecordDecision: basis === 'permission' && !!definition.decisionContext,
    anonymiseFeedbackAuthors,
  };
}
