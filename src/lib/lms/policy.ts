// src/lib/lms/policy.ts — THE ARITHMETIC OF A GRADE, WITH NO DATABASE IN IT.
//
// Everything a learner can dispute lives in this file: whether a submission was late, how much a
// late submission loses, which letter a percentage earns, how weighted categories roll up into one
// course grade, and what a transcript grade point is. All of it is pure, so all of it is tested
// (policy.test.ts) without a connection, and so the same function answers the learner's screen and
// the instructor's screen — a gradebook that disagrees with the student's own page is the single
// most expensive bug an LMS can have.
//
// Nothing here reads a clock of its own. Every function that needs "now" is handed one. That is
// what makes "will this be late?" answerable in the future tense on the submit form.

export type SubmissionKind = 'link' | 'text';

export const ASSIGNMENT_KINDS = [
  'essay', 'problem_set', 'project', 'lab', 'reading', 'presentation', 'case', 'peer_review', 'exam',
] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

export const ASSIGNMENT_KIND_LABELS: Array<{ key: AssignmentKind; label: string }> = [
  { key: 'essay', label: 'Essay or written response' },
  { key: 'problem_set', label: 'Problem set' },
  { key: 'project', label: 'Project' },
  { key: 'lab', label: 'Lab or notebook' },
  { key: 'reading', label: 'Reading response' },
  { key: 'presentation', label: 'Presentation' },
  { key: 'case', label: 'Case study' },
  { key: 'peer_review', label: 'Peer review' },
  { key: 'exam', label: 'Exam or timed assessment' },
];

export function kindLabel(kind: string): string {
  const hit = ASSIGNMENT_KIND_LABELS.find((k) => k.key === kind);
  return hit ? hit.label : 'Assignment';
}

// ================================================================================================
// LATENESS
// ================================================================================================

export interface Lateness { isLate: boolean; daysLate: number; secondsLate: number }

/** How late a submission is against its due date. A submission with no due date is never late.
 *  Days are ceilinged: one second past midnight is one day late, which is how a late policy of
 *  "10% per day" is universally read. Pure. */
export function lateness(dueAt: Date | string | null | undefined, at: Date): Lateness {
  if (!dueAt) return { isLate: false, daysLate: 0, secondsLate: 0 };
  const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
  if (isNaN(due.getTime())) return { isLate: false, daysLate: 0, secondsLate: 0 };
  const ms = at.getTime() - due.getTime();
  if (ms <= 0) return { isLate: false, daysLate: 0, secondsLate: 0 };
  return { isLate: true, daysLate: Math.ceil(ms / 86400000), secondsLate: Math.floor(ms / 1000) };
}

export interface LatePolicy {
  allowLate: boolean;
  penaltyPctPerDay: number;   // percent of the assignment total points, per day late
  maxLateDays: number;        // 0 means no cap
}

export interface LateOutcome {
  accepted: boolean;
  reason: string;
  daysLate: number;
  penaltyPoints: number;      // points to subtract from the raw score
  penaltyPct: number;         // the same, expressed against total points
}

/** What a late submission costs, and whether it is accepted at all. Never returns a penalty larger
 *  than the assignment (a late essay scores zero, never a negative that eats other grades). Pure. */
export function applyLatePolicy(totalPoints: number, daysLate: number, policy: LatePolicy): LateOutcome {
  if (daysLate <= 0) return { accepted: true, reason: 'on time', daysLate: 0, penaltyPoints: 0, penaltyPct: 0 };
  if (!policy.allowLate) {
    return { accepted: false, reason: 'late submissions are not accepted for this assignment', daysLate, penaltyPoints: 0, penaltyPct: 0 };
  }
  if (policy.maxLateDays > 0 && daysLate > policy.maxLateDays) {
    return { accepted: false, reason: 'more than ' + policy.maxLateDays + ' day(s) late', daysLate, penaltyPoints: 0, penaltyPct: 0 };
  }
  const rawPct = Math.max(0, policy.penaltyPctPerDay) * daysLate;
  const penaltyPct = Math.min(100, rawPct);
  const penaltyPoints = round2((Math.max(0, totalPoints) * penaltyPct) / 100);
  return { accepted: true, reason: penaltyPct + '% late penalty (' + daysLate + ' day(s))', daysLate, penaltyPoints, penaltyPct };
}

// ================================================================================================
// SUBMISSION STATE — one vocabulary, used by the learner board and the instructor queue
// ================================================================================================

export type SubmissionState =
  | 'locked'        // not open yet
  | 'not_started'
  | 'draft'
  | 'submitted'     // waiting on a grader
  | 'graded'
  | 'returned'      // sent back for another attempt
  | 'missing'       // past due, nothing submitted, still acceptable
  | 'closed';       // past the hard close, nothing submitted

export interface StateInput {
  availableFrom?: Date | string | null;
  dueAt?: Date | string | null;
  closesAt?: Date | string | null;
  allowLate: boolean;
  maxLateDays: number;
  submissionStatus?: 'draft' | 'submitted' | 'returned' | 'graded' | null;
  graded?: boolean;
}

/** The single answer to "where does this sit right now", for one learner and one assignment. Pure. */
export function submissionState(input: StateInput, now: Date): SubmissionState {
  const opens = toDate(input.availableFrom);
  if (opens && now < opens) return 'locked';
  if (input.graded || input.submissionStatus === 'graded') return 'graded';
  if (input.submissionStatus === 'returned') return 'returned';
  if (input.submissionStatus === 'submitted') return 'submitted';
  if (input.submissionStatus === 'draft') return 'draft';
  // Nothing submitted.
  if (!acceptingSubmissions(input, now).open) return 'closed';
  const late = lateness(input.dueAt, now);
  return late.isLate ? 'missing' : 'not_started';
}

export const STATE_LABELS: Array<{ key: SubmissionState; label: string; tone: string }> = [
  { key: 'locked', label: 'Not open yet', tone: '#6b5f4c' },
  { key: 'not_started', label: 'Not started', tone: '#6b5f4c' },
  { key: 'draft', label: 'In progress', tone: '#3d6b76' },
  { key: 'submitted', label: 'Under review', tone: '#a87526' },
  { key: 'returned', label: 'Returned for revision', tone: '#a8472c' },
  { key: 'graded', label: 'Graded', tone: '#4a7048' },
  { key: 'missing', label: 'Overdue', tone: '#a8472c' },
  { key: 'closed', label: 'Closed', tone: '#8a8172' },
];

export function stateLabel(state: SubmissionState): string {
  const hit = STATE_LABELS.find((s) => s.key === state);
  return hit ? hit.label : 'Unknown';
}
export function stateTone(state: SubmissionState): string {
  const hit = STATE_LABELS.find((s) => s.key === state);
  return hit ? hit.tone : '#6b5f4c';
}

/** Whether a NEW submission may still be written, and why not if not. Pure — this is the check the
 *  API route runs before it writes, and the same one the form runs to decide what to show. */
export function acceptingSubmissions(
  input: { availableFrom?: Date | string | null; dueAt?: Date | string | null; closesAt?: Date | string | null; allowLate: boolean; maxLateDays: number },
  now: Date,
): { open: boolean; reason: string; willBeLate: boolean; daysLate: number } {
  const opens = toDate(input.availableFrom);
  if (opens && now < opens) return { open: false, reason: 'not open yet', willBeLate: false, daysLate: 0 };
  const closes = toDate(input.closesAt);
  if (closes && now > closes) return { open: false, reason: 'closed', willBeLate: false, daysLate: 0 };
  const late = lateness(input.dueAt, now);
  if (!late.isLate) return { open: true, reason: 'open', willBeLate: false, daysLate: 0 };
  const outcome = applyLatePolicy(100, late.daysLate, { allowLate: input.allowLate, penaltyPctPerDay: 0, maxLateDays: input.maxLateDays });
  if (!outcome.accepted) return { open: false, reason: outcome.reason, willBeLate: true, daysLate: late.daysLate };
  return { open: true, reason: 'open (late)', willBeLate: true, daysLate: late.daysLate };
}

// ================================================================================================
// GRADE SCALE
// ================================================================================================

export interface Band { letter: string; min: number; points: number }

/** The default letter scale. A course may override it; nothing here is hardcoded downstream. */
export const DEFAULT_SCALE: Band[] = [
  { letter: 'A+', min: 97, points: 4.0 },
  { letter: 'A', min: 93, points: 4.0 },
  { letter: 'A-', min: 90, points: 3.7 },
  { letter: 'B+', min: 87, points: 3.3 },
  { letter: 'B', min: 83, points: 3.0 },
  { letter: 'B-', min: 80, points: 2.7 },
  { letter: 'C+', min: 77, points: 2.3 },
  { letter: 'C', min: 73, points: 2.0 },
  { letter: 'C-', min: 70, points: 1.7 },
  { letter: 'D', min: 60, points: 1.0 },
  { letter: 'F', min: 0, points: 0.0 },
];

/** Letter for a percentage, against a scale sorted highest-first internally. Pure. */
export function letterFor(pct: number, scale: Band[] = DEFAULT_SCALE): Band {
  const sorted = scale.slice().sort((a, b) => b.min - a.min);
  for (const band of sorted) if (pct >= band.min) return band;
  return sorted[sorted.length - 1] || { letter: 'F', min: 0, points: 0 };
}

// ================================================================================================
// WEIGHTED ROLL-UP
// ================================================================================================

export interface CategorySpec { id: string; name: string; weight: number; dropLowest: number }
export interface ScoreRow { categoryId: string | null; points: number; total: number; counted?: boolean }

export interface CategoryResult {
  id: string; name: string; weight: number;
  earned: number; possible: number; pct: number | null;
  dropped: number; counted: number;
}
export interface CourseGrade {
  pct: number | null;
  letter: string;
  points: number;
  categories: CategoryResult[];
  ungradedWeight: number;   // weight of categories with nothing graded yet
  complete: boolean;        // true when every weighted category has at least one graded score
}

/** Roll graded scores up into one course percentage.
 *
 *  Two rules that are easy to get wrong and are therefore explicit here:
 *    1. A category with NOTHING graded yet is not zero — it is unknown. It is dropped from the
 *       denominator and its weight is reported separately, so an early-term learner sees
 *       "92% on what is graded so far", not "18% overall" from an empty final exam.
 *    2. drop-lowest drops by PERCENTAGE, not by raw points, because a 9/10 quiz and a 60/100 exam
 *       are not comparable in points.
 *  Pure. */
export function courseGrade(categories: CategorySpec[], scores: ScoreRow[], scale: Band[] = DEFAULT_SCALE): CourseGrade {
  const specs = categories.length
    ? categories
    : [{ id: '__all__', name: 'All work', weight: 100, dropLowest: 0 }];

  const results: CategoryResult[] = specs.map((spec) => {
    const mine = scores.filter((s) => (categories.length ? s.categoryId === spec.id : true))
      .filter((s) => s.counted !== false && s.total > 0);
    let kept = mine;
    let dropped = 0;
    if (spec.dropLowest > 0 && mine.length > spec.dropLowest) {
      const byPct = mine.slice().sort((a, b) => (a.points / a.total) - (b.points / b.total));
      kept = byPct.slice(spec.dropLowest);
      dropped = spec.dropLowest;
    }
    const earned = kept.reduce((sum, s) => sum + s.points, 0);
    const possible = kept.reduce((sum, s) => sum + s.total, 0);
    return {
      id: spec.id, name: spec.name, weight: spec.weight,
      earned: round2(earned), possible: round2(possible),
      pct: possible > 0 ? round2((earned / possible) * 100) : null,
      dropped, counted: kept.length,
    };
  });

  const graded = results.filter((r) => r.pct !== null && r.weight > 0);
  const ungradedWeight = round2(results.filter((r) => r.pct === null).reduce((s, r) => s + r.weight, 0));
  const weightSum = graded.reduce((s, r) => s + r.weight, 0);
  if (!graded.length || weightSum <= 0) {
    return { pct: null, letter: 'not graded yet', points: 0, categories: results, ungradedWeight, complete: false };
  }
  const pct = round2(graded.reduce((s, r) => s + (r.pct as number) * r.weight, 0) / weightSum);
  const band = letterFor(pct, scale);
  return {
    pct, letter: band.letter, points: band.points, categories: results,
    ungradedWeight,
    complete: results.filter((r) => r.weight > 0).every((r) => r.pct !== null),
  };
}

// ================================================================================================
// TRANSCRIPT
// ================================================================================================

export interface TranscriptRow { creditHours: number; points: number; counted?: boolean }

/** Credit-weighted grade point average. Rows with zero credit hours (audits, non-credit courses)
 *  never move the average. Returns null when nothing counts, which is not the same as 0.00. Pure. */
export function gpa(rows: TranscriptRow[]): number | null {
  const counted = rows.filter((r) => r.counted !== false && r.creditHours > 0);
  if (!counted.length) return null;
  const credits = counted.reduce((s, r) => s + r.creditHours, 0);
  if (credits <= 0) return null;
  return round2(counted.reduce((s, r) => s + r.points * r.creditHours, 0) / credits);
}

// ================================================================================================
// RUBRICS
// ================================================================================================

export interface Criterion { id: string; label: string; points: number }

/** Total a rubric, clamping each criterion to its own maximum so a slip in a grading form can never
 *  award more than the criterion is worth. Returns the total and any clamped criteria. Pure. */
export function rubricTotal(criteria: Criterion[], scores: Record<string, number>): { total: number; possible: number; clamped: string[] } {
  const clamped: string[] = [];
  let total = 0;
  for (const c of criteria) {
    const raw = Number(scores[c.id] ?? 0);
    const safe = isFinite(raw) ? raw : 0;
    if (safe > c.points || safe < 0) clamped.push(c.id);
    total += Math.max(0, Math.min(c.points, safe));
  }
  return { total: round2(total), possible: round2(criteria.reduce((s, c) => s + c.points, 0)), clamped };
}

// ================================================================================================
// RELEASE (DRIP)
// ================================================================================================

export interface ReleaseRule {
  releaseAt?: Date | string | null;
  releaseAfterDays?: number | null;          // days after the learner enrolled
  requiresLessonId?: string | null;          // must have completed this lesson
  requiresAssignmentId?: string | null;      // must have been graded on this assignment
  minPct?: number | null;                    // ...at or above this percentage
}
export interface ReleaseContext {
  enrolledAt?: Date | string | null;
  completedLessonIds: string[];
  gradedPctByAssignment: Record<string, number>;
}

/** Whether a dripped item is open to this learner right now, with a sentence saying why not.
 *  Every rule present must pass; an empty rule opens the item. Pure. */
export function releaseState(rule: ReleaseRule | null | undefined, ctx: ReleaseContext, now: Date): { open: boolean; reason: string } {
  if (!rule) return { open: true, reason: 'open' };

  const at = toDate(rule.releaseAt);
  if (at && now < at) return { open: false, reason: 'Opens ' + at.toISOString().slice(0, 10) };

  if (rule.releaseAfterDays != null && rule.releaseAfterDays > 0) {
    const from = toDate(ctx.enrolledAt);
    if (!from) return { open: false, reason: 'Opens once you are enrolled' };
    const opensOn = new Date(from.getTime() + rule.releaseAfterDays * 86400000);
    if (now < opensOn) {
      const daysLeft = Math.ceil((opensOn.getTime() - now.getTime()) / 86400000);
      return { open: false, reason: 'Opens in ' + daysLeft + ' day(s)' };
    }
  }

  if (rule.requiresLessonId && !ctx.completedLessonIds.includes(rule.requiresLessonId)) {
    return { open: false, reason: 'Finish the previous lesson first' };
  }

  if (rule.requiresAssignmentId) {
    const got = ctx.gradedPctByAssignment[rule.requiresAssignmentId];
    if (got == null) return { open: false, reason: 'Opens after the previous assignment is graded' };
    if (rule.minPct != null && got < rule.minPct) {
      return { open: false, reason: 'Needs at least ' + rule.minPct + '% on the previous assignment' };
    }
  }

  return { open: true, reason: 'open' };
}

// ================================================================================================
// SHARED HELPERS
// ================================================================================================

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** "Due in 3 days", "6 hours overdue" — the phrasing every due-date chip uses. Pure (takes `now`). */
export function relativeDue(due: Date | string | null | undefined, now: Date): string {
  const d = toDate(due);
  if (!d) return 'No due date';
  const ms = d.getTime() - now.getTime();
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  let unit: string;
  if (mins < 60) unit = mins + (mins === 1 ? ' minute' : ' minutes');
  else if (hours < 48) unit = hours + (hours === 1 ? ' hour' : ' hours');
  else unit = days + (days === 1 ? ' day' : ' days');
  return ms >= 0 ? 'Due in ' + unit : unit + ' overdue';
}

/** Percentage of an assignment points, guarding a zero-point assignment (which is not a failure —
 *  it is ungraded practice, and dividing by it produced NaN on the gradebook). Pure. */
export function pctOf(points: number, total: number): number | null {
  if (!(total > 0)) return null;
  return round2((points / total) * 100);
}
