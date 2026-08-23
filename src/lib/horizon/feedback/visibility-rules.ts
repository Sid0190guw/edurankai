// src/lib/horizon/feedback/visibility-rules.ts — THE REDACTION RULES, WITH NO IO IN THEM.
//
// =================================================================================================
// WHY THIS IS A SEPARATE FILE FROM visibility.ts
// =================================================================================================
//
// Two reasons, and the second is the one that matters.
//
//   1. TESTABILITY. visibility.ts imports performance-scope.ts, which imports the database client at
//      module scope. Importing it from a test therefore fails at IMPORT, before a single assertion
//      runs — which reports as a broken file rather than a failed test, and a confidentiality rule
//      that reports as a broken file is a confidentiality rule nobody notices has stopped being
//      checked. Split out, these rules are pure functions over plain objects and are tested exactly.
//
//   2. THE RULES ARE THE ASSET. Which view may see an hr_channel item is a decision about people,
//      not a database concern, and keeping it in a file that cannot reach a database is a structural
//      guarantee that it can never come to depend on one. A redaction rule that does a lookup is a
//      redaction rule that can fail open when the lookup times out.
//
// visibility.ts re-exports everything here, so no consumer imports this file directly and no
// consumer has to know the split exists.
import type {
  DimensionAggregate,
  FeedbackItem,
  FeedbackSignal,
  FeedbackSignalFlag,
} from './types';

export type FeedbackView = 'subject' | 'responsible' | 'hr' | 'author' | 'none';

export const FEEDBACK_VIEW_LABELS: Record<FeedbackView, string> = {
  subject: 'Your own record',
  responsible: 'Somebody whose work you answer for',
  hr: 'The people desk, across the organisation',
  author: 'Feedback you wrote',
  none: 'No access',
};

/**
 * WHAT EACH VIEW IS ALLOWED TO SEE, as data rather than as scattered `if`s.
 *
 * Written as a table because a redaction rule expressed as five conditionals across four functions
 * is a rule that will be inconsistent within a month, and the inconsistency will be a disclosure.
 */
export interface ViewRights {
  /** Items marked hr_channel — the subject and the people desk only. */
  hrChannelItems: boolean;
  /** Per-item weights and the step-by-step arithmetic behind them. */
  weightingInternals: boolean;
  /** Flags naming another named person (repeated_unsupported, author_tendency). */
  authorLevelReadings: boolean;
  /** Disagreement, outlier and consensus figures. */
  disagreementSignals: boolean;
  /** The aggregate at all. */
  aggregate: boolean;
}

/**
 * THE ONE ROW THAT IS NOT MONOTONE, AND WHY.
 *
 * Every axis widens as you go none -> author -> responsible -> subject -> hr, except
 * `authorLevelReadings`, which the SUBJECT does not hold and the people desk does. That is
 * deliberate and it is the only asymmetry in the table: "your colleague rates you a point below
 * everybody else" is a judgement about that colleague, and handing it to the person least able to
 * hear it neutrally would turn a bias check into a grievance generator. The people desk holds it
 * because somebody has to be able to notice one person quietly marking a whole team down.
 */
export const VIEW_RIGHTS: Record<FeedbackView, ViewRights> = {
  subject: {
    hrChannelItems: true,
    weightingInternals: true,
    authorLevelReadings: false,
    disagreementSignals: true,
    aggregate: true,
  },
  responsible: {
    hrChannelItems: false,
    weightingInternals: false,
    authorLevelReadings: false,
    disagreementSignals: true,
    aggregate: true,
  },
  hr: {
    hrChannelItems: true,
    weightingInternals: true,
    authorLevelReadings: true,
    disagreementSignals: true,
    aggregate: true,
  },
  author: {
    hrChannelItems: false,
    weightingInternals: false,
    authorLevelReadings: false,
    disagreementSignals: false,
    aggregate: false,
  },
  none: {
    hrChannelItems: false,
    weightingInternals: false,
    authorLevelReadings: false,
    disagreementSignals: false,
    aggregate: false,
  },
};

/** A sentence the screen prints, so the reader knows what they are NOT seeing. */
export function viewNotice(view: FeedbackView): string {
  if (view === 'subject') {
    return 'This is everything on your record, with every author named, including anything sent '
      + 'through the people-desk channel. Readings about the colleagues who wrote it are not shown '
      + 'here; those are judgements about them, not about you.';
  }
  if (view === 'responsible') {
    return 'You are reading this because the Organization Graph records you as answering for this '
      + 'person\'s work. Items the author routed to the people desk are not shown to the reporting '
      + 'line, and neither are readings about individual authors.';
  }
  if (view === 'hr') {
    return 'The people-desk view: every item including the people-desk channel, the weighting behind '
      + 'each number, and the patterns across authors. Every read of an individual record from here '
      + 'is logged against your name.';
  }
  if (view === 'author') return 'Feedback you wrote. You can read and withdraw your own items.';
  return 'You do not have access to this person\'s feedback record.';
}

/**
 * The items this view may read.
 *
 * AN AUTHOR ALWAYS SEES THEIR OWN. Somebody who wrote an hr_channel item about a person they also
 * manage must still be able to find, read and withdraw it — hiding it would mean the only way to
 * retract something is to ask the people desk.
 */
export function redactItems(
  items: FeedbackItem[],
  view: FeedbackView,
  viewer: { employeeId: string | null; userId: string },
): FeedbackItem[] {
  const rights = VIEW_RIGHTS[view] || VIEW_RIGHTS.none;
  const mine = (i: FeedbackItem) =>
    (!!viewer.employeeId && i.authorEmployeeId === viewer.employeeId)
    || (!!viewer.userId && i.authorUserId === viewer.userId);

  if (view === 'none') return items.filter(mine);

  return items.filter((i) => {
    if (mine(i)) return true;
    // A draft belongs to nobody but its author until it is submitted.
    if (i.status === 'draft') return false;
    if (i.confidentiality === 'hr_channel' && !rights.hrChannelItems) return false;
    return true;
  });
}

/**
 * The aggregate this view may read.
 *
 * The NUMBER is not redacted per view — a manager and the people desk must be looking at the same
 * figure, or a conversation between them is two people reading two different pages. What is redacted
 * is what the figure is made OF: the per-item weighting, and any reading about a named colleague.
 *
 * WHEN THE VIEW CANNOT SEE EVERY ITEM, THE AGGREGATE IS NOT RE-COMPUTED FROM THE VISIBLE SUBSET.
 * That is deliberate and it is the safer of two bad options: recomputing would mean a manager could
 * work out the content of an hr_channel item by subtracting their own view from the people desk's,
 * which is precisely the disclosure the channel exists to prevent. So the reporting-line view shows
 * the aggregate over everything, says so in `redactionNote`, and shows the items it may show.
 */
export function redactSignal(
  signal: FeedbackSignal,
  view: FeedbackView,
  hiddenItemCount: number,
): FeedbackSignal & { hiddenItemCount: number; redactionNote: string | null } {
  const rights = VIEW_RIGHTS[view] || VIEW_RIGHTS.none;

  if (!rights.aggregate) {
    return {
      ...signal,
      overall: null,
      overallBand: 'insufficient',
      dimensions: [],
      flags: [],
      hiddenItemCount,
      redactionNote: 'This view does not include an aggregated record.',
    };
  }

  const dimensions: DimensionAggregate[] = signal.dimensions.map((d) => ({
    ...d,
    contributions: rights.weightingInternals
      ? d.contributions
      // Keep the author, the rating and the date — a manager reading "who said what" is the point of
      // the screen. Drop the arithmetic, which is an internal computation.
      : d.contributions.map((c) => ({ ...c, weightSteps: [], weight: 0 })),
    disagreement: rights.disagreementSignals ? d.disagreement : 'none',
    disagreementNote: rights.disagreementSignals ? d.disagreementNote : null,
    outlierCount: rights.disagreementSignals ? d.outlierCount : 0,
    explanation: rights.weightingInternals
      ? d.explanation
      : { ...d.explanation, processing: ['The weighting behind this figure is not shown in this view.'] },
  }));

  const flags: FeedbackSignalFlag[] = signal.flags.filter((f) => {
    const aboutAPerson = f.kind === 'repeated_unsupported' || f.kind === 'author_tendency';
    if (aboutAPerson && !rights.authorLevelReadings) return false;
    if (f.kind === 'disagreement' && !rights.disagreementSignals) return false;
    return true;
  });

  const redactionNote = hiddenItemCount > 0
    ? hiddenItemCount + ' item' + (hiddenItemCount === 1 ? '' : 's')
      + ' on this record are not shown in this view. The figures above are computed over everything '
      + 'on the record, including those, and were deliberately not recomputed from what you can see — '
      + 'a figure that moved when an item was hidden would tell you what the hidden item said.'
    : null;

  return { ...signal, dimensions, flags, hiddenItemCount, redactionNote };
}
