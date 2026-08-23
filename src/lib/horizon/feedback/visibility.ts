// src/lib/horizon/feedback/visibility.ts — WHO MAY READ WHAT. The two halves that need IO.
//
// =================================================================================================
// THE RULES ARE NEXT DOOR, AND THEY CANNOT REACH A DATABASE
// =================================================================================================
//
// visibility-rules.ts holds the redaction table and the redaction functions. It imports nothing that
// can do IO, which is what lets it be tested exactly and what guarantees a redaction rule can never
// come to depend on a lookup that might time out. This file holds the two things that genuinely need
// the outside world — resolving the view, and logging the access — and re-exports the rest so no
// consumer has to know about the split.
//
// =================================================================================================
// TWO QUESTIONS, KEPT APART, NEITHER ANSWERED HERE FROM SCRATCH
// =================================================================================================
//
//   "Does this person answer for that person's work?"   A RELATIONSHIP, per ROW.
//                                                        -> src/lib/org-graph.ts, through
//                                                           performance-scope.ts canSeePerformanceOf.
//   "May this person open the people desk at all?"       A CAPABILITY, per USER.
//                                                        -> permissions.ts, through the composed
//                                                           context's holds(), resolved by the caller.
//
// This module composes those two answers into a VIEW. It resolves no relationship of its own and
// reads no role name. There is no `users.role` comparison in this file and there must never be one:
// the incident that produced the permission registry was an intern who reached a console because a
// role was "roughly right".
//
// =================================================================================================
// FAILS CLOSED, EVERY TIME
// =================================================================================================
//
// A resolution that throws produces 'none'. A manager wrongly shown an empty page asks one question;
// a manager wrongly shown a note somebody marked hr_channel is a disclosure that cannot be undone,
// and the note in question is frequently about that manager.
import { canSeePerformanceOf, isUuid, type PerfViewer } from '@/lib/performance-scope';
import { logAudit } from '@/lib/audit';
import { type FeedbackView } from './visibility-rules';

export {
  FEEDBACK_VIEW_LABELS,
  VIEW_RIGHTS,
  redactItems,
  redactSignal,
  viewNotice,
  type FeedbackView,
  type ViewRights,
} from './visibility-rules';

/**
 * Resolve the view ONCE per request.
 *
 * ORDER MATTERS AND IS SUBJECT-FIRST: their own record beats everything, then the people desk, then
 * the relationship. `author` is not returned here — it is a per-ITEM fact, applied by redactItems()
 * so that somebody who is both a colleague and an author sees their own item inside whatever view
 * they otherwise hold.
 */
export async function resolveFeedbackView(
  viewer: PerfViewer,
  subjectEmployeeId: string,
): Promise<FeedbackView> {
  try {
    if (!isUuid(subjectEmployeeId)) return 'none';
    if (viewer.employeeId && viewer.employeeId === subjectEmployeeId) return 'subject';
    if (viewer.managesOrg) return 'hr';
    const responsible = await canSeePerformanceOf(viewer, subjectEmployeeId);
    return responsible ? 'responsible' : 'none';
  } catch {
    // A resolution that throws is a broken composition, not a grant.
    return 'none';
  }
}

/**
 * ACCESS LOGGING. Sensitive personal data is purpose-limited and access-logged.
 *
 * READING YOUR OWN RECORD IS NOT LOGGED. A log of a person reading their own feedback is not an
 * audit trail, it is attendance monitoring of self-reflection — and burying the reads that matter in
 * thousands that do not is how an audit log stops being read at all.
 *
 * NEVER BLOCKS THE RENDER. logAudit already swallows; this is defensive on top. A page that refuses
 * to load because the audit table is slow is a page people route around.
 */
export async function logFeedbackAccess(args: {
  viewerUserId: string;
  subjectEmployeeId: string;
  view: FeedbackView;
  purpose: string;
  itemCount: number;
}): Promise<void> {
  if (args.view === 'subject' || args.view === 'none') return;
  try {
    await logAudit({
      userId: args.viewerUserId,
      action: 'feedback.record.read',
      entity: 'hr_feedback',
      entityId: args.subjectEmployeeId,
      diff: {
        view: args.view,
        purpose: String(args.purpose || '').slice(0, 200),
        itemCount: args.itemCount,
      },
    });
  } catch {
    // Deliberately silent: logAudit logs its own failures.
  }
}
