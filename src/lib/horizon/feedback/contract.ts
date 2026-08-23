// src/lib/horizon/feedback/contract.ts — THE ONLY DOOR PATCH 06 AND PATCH 10 COME THROUGH.
//
// =================================================================================================
// WHAT A CONSUMING PATCH MAY AND MAY NOT DO
// =================================================================================================
//
// MAY:  call getFeedbackSignal() / getFeedbackSignals(), read the numbers, read the flags, read the
//       explanation, follow evidenceRefs back to the items, and render any of it to a human who
//       passed its own access check.
//
// MAY NOT, and these are not stylistic preferences:
//   - Query hr_feedback, hr_feedback_dimensions or hr_feedback_examples directly. Two readers of one
//     table is two answers to "may this person see this", and the second one is a disclosure bug.
//     If this contract does not expose what you need, ASK FOR AN ADDITION — a new function here is a
//     ten-line change and a parallel reader is a permanent liability.
//   - Store `overall` on another table as if it were an observed value. It is derived, it changes
//     when new feedback arrives, and a copy of it goes stale silently. Read it when you need it.
//   - Derive an employment outcome from any number here without a named human recording the
//     decision on their own record. There is no threshold in this module that means "promote" or
//     "manage out", and inventing one downstream would make this a decision engine by the back door.
//
// =================================================================================================
// PURPOSE-LIMITED AND ACCESS-LOGGED, AT THE BOUNDARY
// =================================================================================================
//
// Every call names WHO is asking and WHY. That is not paperwork: the aggregate is derived from
// people's written opinions about a named colleague, and a read of it by somebody other than the
// subject is exactly the event an access log exists to record. The purpose string is stored on the
// audit row, so "who looked at this person's feedback, and what for" is answerable.
//
// A call with no viewer is REFUSED rather than served unredacted. There is no system-level bypass
// and adding one would remove the log at the same time as the check.
//
// =================================================================================================
// VERSIONING
// =================================================================================================
//
// FEEDBACK_CONTRACT_VERSION travels on every payload. Additive fields bump the minor. A field that
// changes meaning gets a NEW NAME and the old one keeps working until every consumer has moved —
// there is no coordinated deploy on this project and a silently re-meaning field would be read
// wrongly for weeks by whoever redeployed last.
import { isUuid } from '@/lib/performance-scope';
import type { PerfViewer } from '@/lib/performance-scope';
import { aggregateFeedback, FEEDBACK_CONTRACT_VERSION } from './aggregate';
import { readStructuredItems, readStructuredItemsFor } from './read';
import {
  logFeedbackAccess,
  redactItems,
  redactSignal,
  resolveFeedbackView,
  viewNotice,
  type FeedbackView,
} from './visibility';
import { FEEDBACK_DECISION_NOTICE, type FeedbackItem, type FeedbackSignal } from './types';

export { FEEDBACK_CONTRACT_VERSION };

/**
 * WHY THE CALLER IS ASKING. A closed list, because a free-text purpose is a purpose nobody can
 * filter an audit log by, and "purpose-limited" then means nothing.
 *
 * A new consumer adds a value here in the same change that adds its call. That is the point: the
 * list is the register of who reads this data.
 */
export const FEEDBACK_PURPOSES = [
  'employee_profile',        // PATCH 06 — the assembled record for one person
  'development_planning',    // PATCH 10 — growth, learning and support planning
  'appraisal_preparation',   // a manager reading before writing a review
  'people_desk_review',      // the people desk looking at the record itself
  'self_review',             // the subject reading their own
] as const;
export type FeedbackPurpose = (typeof FEEDBACK_PURPOSES)[number];

export const FEEDBACK_PURPOSE_LABELS: Record<FeedbackPurpose, string> = {
  employee_profile: 'Assembling the employee record',
  development_planning: 'Planning development, learning or support',
  appraisal_preparation: 'Preparing an appraisal',
  people_desk_review: 'People-desk review of the feedback record itself',
  self_review: 'The person reading their own record',
};

/**
 * What a consumer gets back. The signal, plus everything it needs to render honestly:
 * which view it was served under, what it could not see, and the sentence it must print.
 */
export interface FeedbackSignalEnvelope {
  contractVersion: string;
  subjectEmployeeId: string;
  /** null when the caller may not read this person's record at all. Not an error — an absence. */
  signal: (FeedbackSignal & { hiddenItemCount: number; redactionNote: string | null }) | null;
  /** The raw items, already redacted for this view. Category (a), for a human to read. */
  items: FeedbackItem[];
  view: FeedbackView;
  viewNotice: string;
  /** True when the caller has no standing to read this record. Render nothing, not an error. */
  denied: boolean;
  /** The sentence a consuming screen must print beside any use of a number from here. */
  decisionNotice: string;
}

function deniedEnvelope(subjectEmployeeId: string): FeedbackSignalEnvelope {
  return {
    contractVersion: FEEDBACK_CONTRACT_VERSION,
    subjectEmployeeId,
    signal: null,
    items: [],
    view: 'none',
    viewNotice: viewNotice('none'),
    denied: true,
    decisionNotice: FEEDBACK_DECISION_NOTICE,
  };
}

/**
 * THE READ CONTRACT. One person.
 *
 * `viewer` is a PerfViewer, which is what performance-scope.ts already resolves once per request on
 * every performance surface in this product. Taking that type rather than a user id is deliberate:
 * it means a consumer cannot call this without having resolved the viewer's relationships and
 * capabilities first, and it means this module resolves neither of those itself.
 *
 * `asOf` exists so a batch of subjects is weighted against one instant. Pass the same Date to every
 * call in a loop, or two people's recency factors are computed against two different "now"s and
 * their numbers are not comparable — which is exactly what a team view puts side by side.
 */
export async function getFeedbackSignal(
  subjectEmployeeId: string,
  opts: {
    viewer: PerfViewer;
    purpose: FeedbackPurpose;
    asOf?: Date;
    includeItems?: boolean;
  },
): Promise<FeedbackSignalEnvelope> {
  const subject = String(subjectEmployeeId || '');
  if (!isUuid(subject)) return deniedEnvelope(subject);
  const viewer = opts?.viewer;
  if (!viewer || !isUuid(viewer.userId)) return deniedEnvelope(subject);

  const view = await resolveFeedbackView(viewer, subject);
  if (view === 'none') {
    await logFeedbackAccess({
      viewerUserId: viewer.userId,
      subjectEmployeeId: subject,
      view,
      purpose: opts.purpose,
      itemCount: 0,
    });
    return deniedEnvelope(subject);
  }

  const asOf = opts.asOf instanceof Date ? opts.asOf : new Date();
  const all = await readStructuredItems(subject);
  // THE AGGREGATE IS COMPUTED OVER EVERYTHING, THEN REDACTED. Never the other way round: a figure
  // that moved when an item was withheld would tell the reader what the withheld item said.
  const signal = aggregateFeedback(subject, all, asOf);
  const visible = redactItems(all, view, { employeeId: viewer.employeeId, userId: viewer.userId });
  const hidden = all.filter((i) => i.status !== 'draft').length
    - visible.filter((i) => i.status !== 'draft').length;

  await logFeedbackAccess({
    viewerUserId: viewer.userId,
    subjectEmployeeId: subject,
    view,
    purpose: opts.purpose,
    itemCount: visible.length,
  });

  return {
    contractVersion: FEEDBACK_CONTRACT_VERSION,
    subjectEmployeeId: subject,
    signal: redactSignal(signal, view, Math.max(0, hidden)),
    items: opts.includeItems === false ? [] : visible,
    view,
    viewNotice: viewNotice(view),
    denied: false,
    decisionNotice: FEEDBACK_DECISION_NOTICE,
  };
}

/**
 * THE READ CONTRACT. Many people, for a team or a department view.
 *
 * THREE QUERIES TOTAL, not three per person. A consumer that loops getFeedbackSignal() over a
 * fifty-person department issues a hundred and fifty round trips at ~139ms each; this issues three.
 *
 * ACCESS IS RESOLVED PER SUBJECT, not once for the list. A manager with eight reports and one
 * skip-level gets eight 'responsible' views and one 'none', and the 'none' is simply absent from the
 * result — never present-but-empty, which a caller would render as "no feedback" about somebody they
 * are not allowed to know anything about.
 */
export async function getFeedbackSignals(
  subjectEmployeeIds: string[],
  opts: {
    viewer: PerfViewer;
    purpose: FeedbackPurpose;
    asOf?: Date;
    includeItems?: boolean;
  },
): Promise<Map<string, FeedbackSignalEnvelope>> {
  const out = new Map<string, FeedbackSignalEnvelope>();
  const viewer = opts?.viewer;
  const ids = Array.from(new Set((subjectEmployeeIds || []).filter(isUuid)));
  if (!viewer || !isUuid(viewer.userId) || !ids.length) return out;

  const asOf = opts.asOf instanceof Date ? opts.asOf : new Date();

  // Views first, so nothing is read for a subject the viewer may not see.
  const views = new Map<string, FeedbackView>();
  for (const id of ids) views.set(id, await resolveFeedbackView(viewer, id));
  const allowed = ids.filter((id) => views.get(id) !== 'none');
  if (!allowed.length) return out;

  const itemsBySubject = await readStructuredItemsFor(allowed);

  for (const id of allowed) {
    const view = views.get(id) as FeedbackView;
    const all = itemsBySubject.get(id) || [];
    const signal = aggregateFeedback(id, all, asOf);
    const visible = redactItems(all, view, { employeeId: viewer.employeeId, userId: viewer.userId });
    const hidden = all.filter((i) => i.status !== 'draft').length
      - visible.filter((i) => i.status !== 'draft').length;
    out.set(id, {
      contractVersion: FEEDBACK_CONTRACT_VERSION,
      subjectEmployeeId: id,
      signal: redactSignal(signal, view, Math.max(0, hidden)),
      items: opts.includeItems === true ? visible : [],
      view,
      viewNotice: viewNotice(view),
      denied: false,
      decisionNotice: FEEDBACK_DECISION_NOTICE,
    });
  }

  // ONE audit row for the batch, naming the count. A row per subject would bury the reads that
  // matter under a department-sized page load.
  await logFeedbackAccess({
    viewerUserId: viewer.userId,
    subjectEmployeeId: 'batch:' + allowed.length,
    view: 'hr',
    purpose: opts.purpose,
    itemCount: allowed.length,
  });

  return out;
}

// =================================================================================================
// THE EVENT SEAM — for a consumer that caches.
// =================================================================================================
//
// PULL IS THE PRIMARY CONTRACT. This is a same-process hook for the one thing pull cannot do:
// telling a consumer that a cache it built is now stale, inside the request that made it stale.
//
// IT DOES NOT CROSS REQUESTS. Every surface here runs as a serverless function; a listener
// registered in one invocation does not exist in the next. So a consumer must never depend on this
// firing — it is an optimisation, and the correct behaviour without it is "read again".
//
// hr-events.ts is NOT used for this. Its HR_EVENT_TYPES is a closed vocabulary owned by another
// module, and adding 'FeedbackRecorded' to it is that module's decision to make, not this patch's.
// See the handoff note.

export interface FeedbackRecordedEvent {
  subjectEmployeeId: string;
  feedbackId: string;
  authorUserId: string;
  status: 'draft' | 'submitted' | 'withdrawn';
  at: string;
}

type FeedbackListener = (e: FeedbackRecordedEvent) => void;
const listeners: FeedbackListener[] = [];

/** Register interest. Returns the unsubscribe. Never throws, and a throwing listener is isolated. */
export function onFeedbackRecorded(fn: FeedbackListener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** Fire. Called by the write surfaces after a successful save. A listener cannot break the save. */
export function emitFeedbackRecorded(e: FeedbackRecordedEvent): void {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      // A consumer's cache bug must not fail somebody's feedback submission.
    }
  }
}
