// src/lib/manager-intelligence/signals.ts — FACTS IN, SENTENCES OUT. NO DATABASE, NO CLOCK.
//
// =================================================================================================
// WHY THIS FILE IS PURE
// =================================================================================================
//
// Everything a manager will read about a person on this screen is decided here, and every rule in it
// is a function of a plain object. That is deliberate: the rules that describe a colleague to their
// manager are exactly the rules that must be reviewable line by line, testable without a database,
// and identical on every render. `now` is a PARAMETER — nothing here calls Date.now(), so the same
// facts always produce the same sentences, and a test can pin the instant.
//
// =================================================================================================
// THE FOUR RULES EVERY SIGNAL IN HERE OBEYS
// =================================================================================================
//
// 1. A RATE IS NEVER PRINTED OVER TOO FEW OBSERVATIONS. Below MIN_OBSERVATIONS the signal says how
//    little there is to read rather than dividing two small numbers into a percentage that will
//    swing thirty points on the next task. "One of two reports was late" is not a submission
//    pattern, and calling it one starts a conversation the record does not support.
//
// 2. A FAILED READ IS NOT A ZERO. facts.readFailures names the areas that could not be read, and
//    every builder below returns nothing for its area when it is listed. A manager told "no reports
//    filed" because a query timed out goes and has a conversation about something that did not
//    happen — the page prints the failure instead, in read.ts's words.
//
// 3. NOTHING IN HERE IS A JUDGEMENT ABOUT A PERSON. The vocabulary is about WORK: what is open,
//    what was sent back, what is due, what was filed. There is no score, no grade, no rating, no
//    ranking of one colleague against another by name, and no adjective describing a character.
//    `direction` is 'attention' where a manager might usefully look, never 'bad'.
//
// 4. EVERY SENTENCE CARRIES ITS OWN COUNTER-READING. `detail` says what the signal does NOT mean.
//    An overdue count with no such sentence reads as a verdict; with one it reads as a prompt to go
//    and ask, which is the only thing a count of rows can honestly be.

import {
  buildSignal,
  type BehaviourFacts,
  type CapacityFacts,
  type DeliveryFacts,
  type ManagerSignal,
  type ReworkFacts,
  type StatedFacts,
  type SubmissionFacts,
  type TeamMemberFacts,
} from './types';

// -------------------------------------------------------------------------------------------------
// CONSTANTS AND HELPERS — all declared above every function that reads them. `const` is not hoisted,
// and a declaration used above its own line has taken pages down on this project.
// -------------------------------------------------------------------------------------------------

/** Fewer observations than this and a rate is not reported at all. */
export const MIN_OBSERVATIONS = 3;

/** Reporting consistency at or above this reads as a strength. */
export const STRONG_CONSISTENCY = 0.9;
/** Below this it is worth a conversation. */
export const WEAK_CONSISTENCY = 0.6;

/** On-time delivery at or above this reads as a strength. */
export const STRONG_ON_TIME = 0.85;
/** Send-backs at or above this share of reviewed work are worth looking at together. */
export const HIGH_REWORK = 0.3;

/** A task open this long without closing is worth naming, whatever its due date says. */
export const STALE_OPEN_DAYS = 30;

/** Carrying this multiple of the team's mean active load is the workload signal. */
export const LOAD_MULTIPLE = 1.5;

/** A missing-report run of this many consecutive expected days is a pattern, not a slip. */
export const MISSING_RUN_DAYS = 3;

const pctOf = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/** "84%" — one place is false precision on counts this small, so there is none. */
const asPct = (v: number): string => String(Math.round(v * 100)) + '%';

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * How much a rate over `d` observations may claim about itself.
 *
 * This is the honest half of a percentage. Three tasks producing "67% on time" is arithmetic, not a
 * pattern, and the number that says so travels with it rather than living in a footnote nobody reads.
 */
export function rateConfidence(d: number): number {
  if (d >= 20) return 0.9;
  if (d >= 10) return 0.8;
  if (d >= 5) return 0.65;
  if (d >= MIN_OBSERVATIONS) return 0.5;
  return 0.3;
}

/**
 * A count of rows is as good as the rows. It is never 1.0: the query has a window, a scope and a
 * moment, and something recorded a minute later is outside all three.
 */
export const COUNT_CONFIDENCE = 0.95;

const COUNT_BASIS = 'Counted directly from the rows in the window. It is a count, not an estimate; '
  + 'what it cannot see is anything recorded after this page was loaded.';

const failed = (facts: TeamMemberFacts, area: string): boolean =>
  facts.readFailures.indexOf(area) >= 0;

// -------------------------------------------------------------------------------------------------
// 1. CURRENT WORK AND DELIVERY
// -------------------------------------------------------------------------------------------------

function deliverySignals(f: TeamMemberFacts, now: string): ManagerSignal[] {
  if (failed(f, 'delivery')) return [];
  const d: DeliveryFacts = f.delivery;
  const w = f.window;
  const out: ManagerSignal[] = [];
  const base = {
    section: 'current_work' as const,
    observedFrom: w.fromIso,
    observedTo: w.toIso,
    computedAt: now,
  };

  out.push(buildSignal({
    ...base,
    key: 'current_work.open_load',
    headline: String(d.openTotal) + ' ' + plural(d.openTotal, 'task is', 'tasks are') + ' open right now, '
      + String(d.inProgress) + ' of them in progress and ' + String(d.underReview) + ' under review.',
    detail: 'This is what is on the board, not a measure of effort. A person with few open tasks may '
      + 'be doing the hardest work on the team.',
    direction: 'neutral',
    evidenceStrength: 'demonstrated',
    inputs: [
      { label: 'Open tasks', value: String(d.openTotal), source: 'employee_tasks' },
      { label: 'In progress', value: String(d.inProgress), source: 'employee_tasks' },
      { label: 'Under review', value: String(d.underReview), source: 'employee_tasks' },
    ],
    processing: 'Count of employee_tasks rows assigned to this person whose status is not completed, '
      + 'cancelled or archived, grouped by status.',
    output: String(d.openTotal) + ' open',
    evidence: [{ label: 'Open task rows', kind: 'aggregate', count: d.openTotal }],
    confidence: COUNT_CONFIDENCE,
    confidenceBasis: COUNT_BASIS,
  }));

  if (d.overdue > 0) {
    out.push(buildSignal({
      ...base,
      key: 'current_work.overdue',
      headline: String(d.overdue) + ' ' + plural(d.overdue, 'task has', 'tasks have') + ' passed the due date and is still open.',
      detail: 'A due date can be wrong as easily as a piece of work can be late. This says the two '
        + 'disagree; it does not say which one is at fault.',
      direction: 'attention',
      evidenceStrength: 'demonstrated',
      inputs: [
        { label: 'Open tasks past due', value: String(d.overdue), source: 'employee_tasks' },
        { label: 'Open tasks', value: String(d.openTotal), source: 'employee_tasks' },
      ],
      processing: 'Open employee_tasks rows where due_on is earlier than today.',
      output: String(d.overdue) + ' overdue',
      evidence: [{ label: 'Overdue task rows', kind: 'aggregate', count: d.overdue }],
      confidence: COUNT_CONFIDENCE,
      confidenceBasis: COUNT_BASIS,
    }));
  }

  if (d.dueWithin7 > 0) {
    out.push(buildSignal({
      ...base,
      key: 'current_work.due_soon',
      headline: String(d.dueWithin7) + ' ' + plural(d.dueWithin7, 'task falls', 'tasks fall') + ' due in the next seven days.',
      detail: 'Read it beside the leave already booked in the same fortnight before adding anything else.',
      direction: 'neutral',
      evidenceStrength: 'demonstrated',
      inputs: [{ label: 'Open tasks due within 7 days', value: String(d.dueWithin7), source: 'employee_tasks' }],
      processing: 'Open employee_tasks rows whose due_on falls between today and today plus seven days.',
      output: String(d.dueWithin7) + ' due within a week',
      evidence: [{ label: 'Task rows due within 7 days', kind: 'aggregate', count: d.dueWithin7 }],
      confidence: COUNT_CONFIDENCE,
      confidenceBasis: COUNT_BASIS,
    }));
  }

  const unstated = Math.max(0, d.blocked - d.blockedWithStatedReason);
  if (d.blocked > 0) {
    out.push(buildSignal({
      ...base,
      key: 'current_work.blocked',
      headline: String(d.blocked) + ' ' + plural(d.blocked, 'task is', 'tasks are') + ' blocked'
        + (unstated > 0 ? ', and ' + String(unstated) + ' of ' + plural(unstated, 'them names', 'them name') + ' no cause.' : ', each with a stated cause.'),
      detail: unstated > 0
        ? 'A blocker with no stated cause is the one a manager cannot help with from here. That is a '
          + 'gap in the record, not a judgement about the person who raised it.'
        : 'Work stopped for a reason somebody wrote down. That is the record behaving as intended.',
      direction: unstated > 0 ? 'attention' : 'neutral',
      evidenceStrength: 'demonstrated',
      inputs: [
        { label: 'Blocked tasks', value: String(d.blocked), source: 'employee_tasks' },
        { label: 'Blocked with a stated cause', value: String(d.blockedWithStatedReason), source: 'employee_tasks' },
      ],
      processing: 'Open employee_tasks rows at status blocked, split by whether blocked_reason is set.',
      output: String(d.blocked) + ' blocked, ' + String(d.blockedWithStatedReason) + ' with a cause',
      evidence: [{ label: 'Blocked task rows', kind: 'aggregate', count: d.blocked }],
      confidence: COUNT_CONFIDENCE,
      confidenceBasis: COUNT_BASIS,
    }));
  }

  if (d.oldestOpenDays !== null && d.oldestOpenDays >= STALE_OPEN_DAYS) {
    out.push(buildSignal({
      ...base,
      key: 'current_work.stale_open',
      headline: 'The oldest open task has been open ' + String(d.oldestOpenDays) + ' days.',
      detail: 'Long-lived work is often work that should have been closed, split or dropped. The age '
        + 'says nothing about how hard it is.',
      direction: 'attention',
      evidenceStrength: 'demonstrated',
      inputs: [{ label: 'Age of oldest open task in days', value: String(d.oldestOpenDays), source: 'employee_tasks' }],
      processing: 'Days between today and created_at on the earliest-created open employee_tasks row.',
      output: String(d.oldestOpenDays) + ' days',
      evidence: [{ label: 'Oldest open task', kind: 'aggregate', count: 1 }],
      confidence: COUNT_CONFIDENCE,
      confidenceBasis: COUNT_BASIS,
    }));
  }

  const onTime = pctOf(d.completedOnTime, d.completedWithDueDate);
  if (onTime === null || d.completedWithDueDate < MIN_OBSERVATIONS) {
    out.push(buildSignal({
      ...base,
      key: 'current_work.on_time_insufficient',
      headline: 'Not enough closed work with a due date in this window to read a delivery pattern.',
      detail: 'There ' + plural(d.completedWithDueDate, 'is 1 closed task', 'are ' + String(d.completedWithDueDate) + ' closed tasks')
        + ' carrying a due date. A rate over that many would move by tens of points on the next one, so none is shown.',
      direction: 'neutral',
      evidenceStrength: 'derived',
      inputs: [
        { label: 'Closed with a due date in window', value: String(d.completedWithDueDate), source: 'employee_tasks' },
        { label: 'Minimum needed', value: String(MIN_OBSERVATIONS), source: 'employee_tasks' },
      ],
      processing: 'Withheld: the denominator is below MIN_OBSERVATIONS (' + String(MIN_OBSERVATIONS) + ').',
      output: 'No rate reported',
      evidence: [{ label: 'Closed tasks with a due date', kind: 'aggregate', count: d.completedWithDueDate }],
      confidence: rateConfidence(d.completedWithDueDate),
      confidenceBasis: 'Stated as a refusal rather than a figure, so the confidence describes how little '
        + 'is being claimed rather than how sure a percentage is.',
    }));
  } else {
    out.push(buildSignal({
      ...base,
      key: 'current_work.on_time_rate',
      headline: asPct(onTime) + ' of closed work with a due date was closed on or before it ('
        + String(d.completedOnTime) + ' of ' + String(d.completedWithDueDate) + ').',
      detail: 'Only tasks that carried a due date are counted. Work closed without one is not late and '
        + 'not on time; it is simply undated.',
      direction: onTime >= STRONG_ON_TIME ? 'positive' : (onTime < 0.5 ? 'attention' : 'neutral'),
      evidenceStrength: 'demonstrated',
      inputs: [
        { label: 'Closed on or before the due date', value: String(d.completedOnTime), source: 'employee_tasks' },
        { label: 'Closed with a due date', value: String(d.completedWithDueDate), source: 'employee_tasks' },
      ],
      processing: 'on-time rate = closed on or before due_on / closed with a due_on, over the window.',
      output: asPct(onTime),
      evidence: [{ label: 'Closed tasks with a due date', kind: 'aggregate', count: d.completedWithDueDate }],
      confidence: rateConfidence(d.completedWithDueDate),
      confidenceBasis: 'A rate over ' + String(d.completedWithDueDate) + ' closed '
        + plural(d.completedWithDueDate, 'task', 'tasks') + '. The fewer there are, the more one task moves it.',
    }));
  }

  return out;
}

// -------------------------------------------------------------------------------------------------
// 2. SUBMISSION PATTERNS
// -------------------------------------------------------------------------------------------------

function submissionSignals(f: TeamMemberFacts, now: string): ManagerSignal[] {
  if (failed(f, 'submission')) return [];
  const s: SubmissionFacts = f.submission;
  const w = f.window;
  const out: ManagerSignal[] = [];
  const base = {
    section: 'submission_patterns' as const,
    observedFrom: w.fromIso,
    observedTo: w.toIso,
    computedAt: now,
  };

  if (s.expectedDays < MIN_OBSERVATIONS) {
    return [buildSignal({
      ...base,
      key: 'submission.insufficient',
      headline: 'Too few recorded working days in this window to read a submission pattern.',
      detail: 'A report is expected on a day attendance records as worked. There '
        + plural(s.expectedDays, 'was 1 such day', 'were ' + String(s.expectedDays) + ' such days')
        + ' here, which is not a pattern.',
      direction: 'neutral',
      evidenceStrength: 'derived',
      inputs: [
        { label: 'Days a report was expected', value: String(s.expectedDays), source: 'hr_attendance' },
        { label: 'Minimum needed', value: String(MIN_OBSERVATIONS), source: 'hr_attendance' },
      ],
      processing: 'Withheld: expected days below MIN_OBSERVATIONS (' + String(MIN_OBSERVATIONS) + ').',
      output: 'No rate reported',
      evidence: [{ label: 'Recorded working days', kind: 'aggregate', count: s.expectedDays }],
      confidence: rateConfidence(s.expectedDays),
      confidenceBasis: 'A refusal to divide, not a measurement.',
    })];
  }

  const consistency = pctOf(s.filedDays, s.expectedDays) || 0;
  out.push(buildSignal({
    ...base,
    key: 'submission.consistency',
    headline: 'A daily report was filed on ' + String(s.filedDays) + ' of ' + String(s.expectedDays)
      + ' recorded working ' + plural(s.expectedDays, 'day', 'days') + ' (' + asPct(consistency) + ').',
    detail: 'Days recorded as leave, holiday or with no attendance record at all are not counted as '
      + 'expected, so nobody is marked down for a day they were not working.',
    direction: consistency >= STRONG_CONSISTENCY ? 'positive' : (consistency < WEAK_CONSISTENCY ? 'attention' : 'neutral'),
    evidenceStrength: 'demonstrated',
    inputs: [
      { label: 'Days filed', value: String(s.filedDays), source: 'hr_daily_reports' },
      { label: 'Days expected', value: String(s.expectedDays), source: 'hr_attendance' },
    ],
    processing: 'consistency = hr_daily_reports rows in the window / days hr_attendance records as '
      + 'present or working from home.',
    output: asPct(consistency),
    evidence: [
      { label: 'Daily reports filed', kind: 'aggregate', count: s.filedDays },
      { label: 'Recorded working days', kind: 'aggregate', count: s.expectedDays },
    ],
    confidence: rateConfidence(s.expectedDays),
    confidenceBasis: 'Measured over ' + String(s.expectedDays) + ' expected days. Both halves come from '
      + 'records the person can see on their own portal.',
  }));

  if (s.filedDays >= MIN_OBSERVATIONS) {
    const sameDay = pctOf(s.sameDayFilings, s.filedDays) || 0;
    out.push(buildSignal({
      ...base,
      key: 'submission.timeliness',
      headline: String(s.sameDayFilings) + ' of ' + String(s.filedDays) + ' reports were filed on the day they cover ('
        + asPct(sameDay) + ').',
      detail: 'Filing later is not filing worse. It matters only where somebody is waiting on the report '
        + 'to unblock their own work.',
      direction: sameDay >= 0.8 ? 'positive' : (sameDay < 0.4 ? 'attention' : 'neutral'),
      evidenceStrength: 'demonstrated',
      inputs: [
        { label: 'Filed the same day', value: String(s.sameDayFilings), source: 'hr_daily_reports' },
        { label: 'Filed at all', value: String(s.filedDays), source: 'hr_daily_reports' },
      ],
      processing: 'same-day rate = reports whose created_at date equals report_date / reports filed.',
      output: asPct(sameDay),
      evidence: [{ label: 'Reports filed', kind: 'aggregate', count: s.filedDays }],
      confidence: rateConfidence(s.filedDays),
      confidenceBasis: 'Measured over ' + String(s.filedDays) + ' filed ' + plural(s.filedDays, 'report', 'reports') + '.',
    }));
  }

  if (s.longestMissingRun >= MISSING_RUN_DAYS) {
    out.push(buildSignal({
      ...base,
      key: 'submission.gap',
      headline: 'The longest run of expected days with no report was ' + String(s.longestMissingRun) + ' days.',
      detail: 'A run is worth asking about in a way that scattered single days are not. The cause is not '
        + 'in this record and is usually not what a gap looks like from outside.',
      direction: 'attention',
      evidenceStrength: 'demonstrated',
      inputs: [{ label: 'Longest consecutive missing run', value: String(s.longestMissingRun), source: 'hr_daily_reports' }],
      processing: 'Longest consecutive sequence of expected working days carrying no hr_daily_reports row.',
      output: String(s.longestMissingRun) + ' consecutive days',
      evidence: [{ label: 'Expected days with no report', kind: 'aggregate', count: s.expectedDays - s.filedDays }],
      confidence: COUNT_CONFIDENCE,
      confidenceBasis: COUNT_BASIS,
    }));
  }

  return out;
}

// -------------------------------------------------------------------------------------------------
// 3. QUALITY AND REWORK
// -------------------------------------------------------------------------------------------------

function reworkSignals(f: TeamMemberFacts, now: string): ManagerSignal[] {
  if (failed(f, 'rework')) return [];
  const r: ReworkFacts = f.rework;
  const w = f.window;
  const out: ManagerSignal[] = [];
  const base = {
    section: 'quality_rework' as const,
    observedFrom: w.fromIso,
    observedTo: w.toIso,
    computedAt: now,
  };

  if (r.tasksReachingReview < MIN_OBSERVATIONS) {
    out.push(buildSignal({
      ...base,
      key: 'rework.insufficient',
      headline: 'Too little reviewed work in this window to read a quality pattern.',
      detail: String(r.tasksReachingReview) + ' ' + plural(r.tasksReachingReview, 'task', 'tasks')
        + ' reached a review step. Rework over that many is arithmetic, not a pattern.',
      direction: 'neutral',
      evidenceStrength: 'derived',
      inputs: [
        { label: 'Tasks that reached review', value: String(r.tasksReachingReview), source: 'audit_log' },
        { label: 'Minimum needed', value: String(MIN_OBSERVATIONS), source: 'audit_log' },
      ],
      processing: 'Withheld: the denominator is below MIN_OBSERVATIONS (' + String(MIN_OBSERVATIONS) + ').',
      output: 'No rate reported',
      evidence: [{ label: 'Tasks reaching review', kind: 'aggregate', count: r.tasksReachingReview }],
      confidence: rateConfidence(r.tasksReachingReview),
      confidenceBasis: 'A refusal to divide, not a measurement.',
    }));
  } else {
    const rate = pctOf(r.tasksSentBack, r.tasksReachingReview) || 0;
    out.push(buildSignal({
      ...base,
      key: 'rework.send_back_rate',
      headline: String(r.tasksSentBack) + ' of ' + String(r.tasksReachingReview)
        + ' reviewed tasks were sent back for more work (' + asPct(rate) + ').',
      detail: 'A send-back is a reviewer asking for a change. It can mean the work was not ready, and it '
        + 'can equally mean the brief was not clear when it was handed over.',
      direction: rate >= HIGH_REWORK ? 'attention' : (rate === 0 ? 'positive' : 'neutral'),
      evidenceStrength: 'demonstrated',
      inputs: [
        { label: 'Tasks sent back at least once', value: String(r.tasksSentBack), source: 'audit_log' },
        { label: 'Tasks that reached review', value: String(r.tasksReachingReview), source: 'audit_log' },
        { label: 'Send-back moves in total', value: String(r.sendBacks), source: 'audit_log' },
      ],
      processing: 'Audited task status moves from under_review, approved or completed back to in_progress '
        + 'or blocked, counted per task, over the window.',
      output: asPct(rate),
      evidence: [{ label: 'Audited send-back moves', kind: 'aggregate', count: r.sendBacks }],
      confidence: rateConfidence(r.tasksReachingReview),
      confidenceBasis: 'Read from audit_log, which records a move only from the point the audit call '
        + 'existed and never backfills. Moves made before that are absent rather than zero.',
    }));
  }

  if (r.reportsFiled >= MIN_OBSERVATIONS) {
    const revised = pctOf(r.reportsRevised, r.reportsFiled) || 0;
    out.push(buildSignal({
      ...base,
      key: 'rework.report_revisions',
      headline: String(r.reportsRevised) + ' of ' + String(r.reportsFiled) + ' daily reports were revised after filing ('
        + asPct(revised) + ').',
      detail: 'Revising a report is usually somebody improving their own record. It is only worth a '
        + 'conversation where a reviewer asked for the change.',
      direction: 'neutral',
      evidenceStrength: 'demonstrated',
      inputs: [
        { label: 'Reports revised', value: String(r.reportsRevised), source: 'hr_daily_reports' },
        { label: 'Reports filed', value: String(r.reportsFiled), source: 'hr_daily_reports' },
      ],
      processing: 'revision rate = hr_daily_reports rows with revision_count above zero / rows filed.',
      output: asPct(revised),
      evidence: [{ label: 'Reports filed in window', kind: 'aggregate', count: r.reportsFiled }],
      confidence: rateConfidence(r.reportsFiled),
      confidenceBasis: 'Measured over ' + String(r.reportsFiled) + ' filed ' + plural(r.reportsFiled, 'report', 'reports') + '.',
    }));
  }

  return out;
}

// -------------------------------------------------------------------------------------------------
// 4. TEAM BEHAVIOUR
// -------------------------------------------------------------------------------------------------

function behaviourSignals(f: TeamMemberFacts, now: string): ManagerSignal[] {
  if (failed(f, 'behaviour')) return [];
  const b: BehaviourFacts = f.behaviour;
  const w = f.window;
  const out: ManagerSignal[] = [];
  const base = {
    section: 'team_behaviour' as const,
    observedFrom: w.fromIso,
    observedTo: w.toIso,
    computedAt: now,
  };

  out.push(buildSignal({
    ...base,
    key: 'behaviour.working_pattern',
    headline: String(b.presentDays) + ' working ' + plural(b.presentDays, 'day', 'days') + ' recorded, '
      + String(b.leaveDays) + ' on approved leave, ' + String(b.daysWithNoRecord) + ' with no record either way.',
    detail: 'A day with no record is a missing row, not an absence. Nobody is called absent here for the '
      + 'absence of a row, and the kind of leave taken is not shown on this screen.',
    direction: 'neutral',
    evidenceStrength: 'demonstrated',
    inputs: [
      { label: 'Days recorded as worked', value: String(b.presentDays), source: 'hr_attendance' },
      { label: 'Days on approved leave', value: String(b.leaveDays), source: 'hr_leave_request' },
      { label: 'Days with no record', value: String(b.daysWithNoRecord), source: 'hr_attendance' },
    ],
    processing: 'Days in the window grouped by hr_attendance status, with approved hr_leave_request '
      + 'ranges counted as leave. Leave type and the request reason are not read.',
    output: String(b.presentDays) + ' worked, ' + String(b.leaveDays) + ' on leave',
    evidence: [{ label: 'Attendance days in window', kind: 'aggregate', count: b.attendanceDaysRecorded }],
    confidence: COUNT_CONFIDENCE,
    confidenceBasis: COUNT_BASIS,
  }));

  if (b.blockersRaised > 0) {
    out.push(buildSignal({
      ...base,
      key: 'behaviour.raises_blockers',
      headline: 'Raised ' + String(b.blockersRaised) + ' ' + plural(b.blockersRaised, 'blocker', 'blockers')
        + ' with a stated cause.',
      detail: 'Saying early that work has stopped is the behaviour a team wants. It is counted here as a '
        + 'contribution, not as a fault.',
      direction: 'positive',
      evidenceStrength: 'demonstrated',
      inputs: [{ label: 'Blockers raised with a cause', value: String(b.blockersRaised), source: 'audit_log' }],
      processing: 'Audited moves to status blocked, made by this person, that carried a stated reason.',
      output: String(b.blockersRaised) + ' raised',
      evidence: [{ label: 'Audited blocker moves', kind: 'aggregate', count: b.blockersRaised }],
      confidence: COUNT_CONFIDENCE,
      confidenceBasis: COUNT_BASIS,
    }));
  }

  if (b.workPickedUp > 0 || b.commentsWritten > 0) {
    out.push(buildSignal({
      ...base,
      key: 'behaviour.engagement',
      headline: 'Picked up ' + String(b.workPickedUp) + ' ' + plural(b.workPickedUp, 'task', 'tasks')
        + ' and wrote ' + String(b.commentsWritten) + ' ' + plural(b.commentsWritten, 'comment', 'comments') + ' on work.',
      detail: 'A count of visible activity on task records. It is not a measure of contribution, and a '
        + 'quiet colleague is not a disengaged one.',
      direction: 'neutral',
      evidenceStrength: 'demonstrated',
      inputs: [
        { label: 'Tasks accepted or started by them', value: String(b.workPickedUp), source: 'audit_log' },
        { label: 'Comments written on tasks', value: String(b.commentsWritten), source: 'employee_tasks' },
      ],
      processing: 'Audited moves to accepted or in_progress made by this person, and their comment rows '
        + 'on employee_tasks, over the window.',
      output: String(b.workPickedUp) + ' picked up, ' + String(b.commentsWritten) + ' comments',
      evidence: [{ label: 'Activity rows', kind: 'aggregate', count: b.workPickedUp + b.commentsWritten }],
      confidence: COUNT_CONFIDENCE,
      confidenceBasis: COUNT_BASIS,
    }));
  }

  // THE ONE CONDUCT LINE, AND IT IS A COUNT. See read.ts: only level 1 reaches this shape, never a
  // breach type and never a description, and levels 2 and 3 are not counted at all.
  if (b.informalConductNotes > 0) {
    out.push(buildSignal({
      ...base,
      key: 'behaviour.conduct_notes',
      headline: 'HR holds ' + String(b.informalConductNotes) + ' informal conduct '
        + plural(b.informalConductNotes, 'note', 'notes') + ' on this person.',
      detail: 'The count is all this screen shows. What the notes say, and whether they need anything from '
        + 'you, is HR’s to tell you. Do not act on this line on its own.',
      direction: 'attention',
      evidenceStrength: 'stated',
      inputs: [{ label: 'Informal conduct notes on record', value: String(b.informalConductNotes), source: 'hr_employee_flags:count_only' }],
      processing: 'Count of level-1 hr_employee_flags rows. No description, breach type, action or date '
        + 'is read, and levels 2 and 3 are excluded from the query entirely.',
      output: String(b.informalConductNotes) + ' on record',
      evidence: [{ label: 'Informal notes held by HR', kind: 'aggregate', count: b.informalConductNotes }],
      confidence: COUNT_CONFIDENCE,
      confidenceBasis: 'A count of rows. It carries no information about what any of them concerns.',
    }));
  }

  return out;
}

// -------------------------------------------------------------------------------------------------
// 5. STRENGTHS  and  6. DEVELOPMENT AREAS
// -------------------------------------------------------------------------------------------------
//
// Both are read off the same facts, and neither invents a new measurement. A strength here is a
// number that is good over enough observations to say so; a development area is a number that is not,
// over the same bar. That symmetry is deliberate: a system that finds development areas from thin
// data and strengths only from thick data is one that describes everybody as a problem.

function strengthSignals(f: TeamMemberFacts, now: string): ManagerSignal[] {
  const out: ManagerSignal[] = [];
  const w = f.window;
  const base = {
    section: 'strengths' as const,
    observedFrom: w.fromIso,
    observedTo: w.toIso,
    computedAt: now,
  };

  if (!failed(f, 'delivery')) {
    const onTime = pctOf(f.delivery.completedOnTime, f.delivery.completedWithDueDate);
    if (onTime !== null && f.delivery.completedWithDueDate >= MIN_OBSERVATIONS && onTime >= STRONG_ON_TIME) {
      out.push(buildSignal({
        ...base,
        key: 'strength.on_time_delivery',
        headline: 'Delivers dated work on time: ' + asPct(onTime) + ' of ' + String(f.delivery.completedWithDueDate)
          + ' dated tasks closed on or before the date.',
        detail: 'Worth saying out loud in a review, and worth naming as the evidence when you do.',
        direction: 'positive',
        evidenceStrength: 'demonstrated',
        inputs: [
          { label: 'Closed on or before the due date', value: String(f.delivery.completedOnTime), source: 'employee_tasks' },
          { label: 'Closed with a due date', value: String(f.delivery.completedWithDueDate), source: 'employee_tasks' },
        ],
        processing: 'On-time rate at or above ' + asPct(STRONG_ON_TIME) + ' over at least '
          + String(MIN_OBSERVATIONS) + ' dated tasks.',
        output: asPct(onTime),
        evidence: [{ label: 'Dated tasks closed', kind: 'aggregate', count: f.delivery.completedWithDueDate }],
        confidence: rateConfidence(f.delivery.completedWithDueDate),
        confidenceBasis: 'Measured over ' + String(f.delivery.completedWithDueDate) + ' dated tasks.',
      }));
    }
  }

  if (!failed(f, 'submission')) {
    const consistency = pctOf(f.submission.filedDays, f.submission.expectedDays);
    if (consistency !== null && f.submission.expectedDays >= MIN_OBSERVATIONS && consistency >= STRONG_CONSISTENCY) {
      out.push(buildSignal({
        ...base,
        key: 'strength.reporting_discipline',
        headline: 'Keeps their own record current: reports filed on ' + asPct(consistency) + ' of recorded working days.',
        detail: 'This is the habit that makes everything else on this page trustworthy, including the '
          + 'parts that count in their favour.',
        direction: 'positive',
        evidenceStrength: 'demonstrated',
        inputs: [
          { label: 'Days filed', value: String(f.submission.filedDays), source: 'hr_daily_reports' },
          { label: 'Days expected', value: String(f.submission.expectedDays), source: 'hr_attendance' },
        ],
        processing: 'Reporting consistency at or above ' + asPct(STRONG_CONSISTENCY) + ' over at least '
          + String(MIN_OBSERVATIONS) + ' expected days.',
        output: asPct(consistency),
        evidence: [{ label: 'Reports filed', kind: 'aggregate', count: f.submission.filedDays }],
        confidence: rateConfidence(f.submission.expectedDays),
        confidenceBasis: 'Measured over ' + String(f.submission.expectedDays) + ' expected days.',
      }));
    }
  }

  if (!failed(f, 'rework') && f.rework.tasksReachingReview >= 5 && f.rework.tasksSentBack === 0) {
    out.push(buildSignal({
      ...base,
      key: 'strength.first_pass_quality',
      headline: 'All ' + String(f.rework.tasksReachingReview) + ' reviewed tasks passed without being sent back.',
      detail: 'Read alongside who reviewed them. A clean pass is stronger evidence when more than one '
        + 'person did the reviewing.',
      direction: 'positive',
      evidenceStrength: 'demonstrated',
      inputs: [
        { label: 'Tasks that reached review', value: String(f.rework.tasksReachingReview), source: 'audit_log' },
        { label: 'Tasks sent back', value: String(f.rework.tasksSentBack), source: 'audit_log' },
      ],
      processing: 'No audited send-back move over at least five reviewed tasks in the window.',
      output: '0 send-backs over ' + String(f.rework.tasksReachingReview) + ' reviews',
      evidence: [{ label: 'Reviewed tasks', kind: 'aggregate', count: f.rework.tasksReachingReview }],
      confidence: rateConfidence(f.rework.tasksReachingReview),
      confidenceBasis: 'audit_log records moves only from the point auditing existed, so an older '
        + 'send-back would be invisible here rather than counted.',
    }));
  }

  if (!failed(f, 'stated') && f.stated.strengthNotes > 0) {
    out.push(buildSignal({
      ...base,
      key: 'strength.stated_by_colleagues',
      headline: String(f.stated.strengthNotes) + ' ' + plural(f.stated.strengthNotes, 'colleague has', 'colleagues have')
        + ' written a strength note about this person.',
      detail: 'The notes themselves are in the feedback record, attributed to whoever wrote them. Feedback '
        + 'on this platform is never anonymous.',
      direction: 'positive',
      evidenceStrength: 'stated',
      inputs: [{ label: 'Feedback notes themed as a strength', value: String(f.stated.strengthNotes), source: 'hr_feedback' }],
      processing: 'Count of hr_feedback rows about this person with theme = strength that the manager is '
        + 'permitted to see.',
      output: String(f.stated.strengthNotes) + ' strength notes',
      evidence: [{ label: 'Strength notes', kind: 'aggregate', count: f.stated.strengthNotes }],
      confidence: COUNT_CONFIDENCE,
      confidenceBasis: 'A count of what people wrote. It says nothing about whether they were right.',
    }));
  }

  return out;
}

function developmentSignals(f: TeamMemberFacts, now: string): ManagerSignal[] {
  const out: ManagerSignal[] = [];
  const w = f.window;
  const base = {
    section: 'development_areas' as const,
    observedFrom: w.fromIso,
    observedTo: w.toIso,
    computedAt: now,
  };

  if (!failed(f, 'delivery')) {
    const onTime = pctOf(f.delivery.completedOnTime, f.delivery.completedWithDueDate);
    if (onTime !== null && f.delivery.completedWithDueDate >= MIN_OBSERVATIONS && onTime < 0.5) {
      out.push(buildSignal({
        ...base,
        key: 'development.dated_delivery',
        headline: 'Dated work is more often closed after the date than before it (' + asPct(onTime) + ' on time).',
        detail: 'Before treating this as a delivery problem, check who set the dates and whether they were '
          + 'agreed. An estimate somebody else made is not a commitment this person broke.',
        direction: 'attention',
        evidenceStrength: 'demonstrated',
        inputs: [
          { label: 'Closed on or before the due date', value: String(f.delivery.completedOnTime), source: 'employee_tasks' },
          { label: 'Closed with a due date', value: String(f.delivery.completedWithDueDate), source: 'employee_tasks' },
        ],
        processing: 'On-time rate below 50% over at least ' + String(MIN_OBSERVATIONS) + ' dated tasks.',
        output: asPct(onTime),
        evidence: [{ label: 'Dated tasks closed', kind: 'aggregate', count: f.delivery.completedWithDueDate }],
        confidence: rateConfidence(f.delivery.completedWithDueDate),
        confidenceBasis: 'Measured over ' + String(f.delivery.completedWithDueDate) + ' dated tasks.',
      }));
    }
  }

  if (!failed(f, 'submission')) {
    const consistency = pctOf(f.submission.filedDays, f.submission.expectedDays);
    if (consistency !== null && f.submission.expectedDays >= MIN_OBSERVATIONS && consistency < WEAK_CONSISTENCY) {
      out.push(buildSignal({
        ...base,
        key: 'development.reporting_consistency',
        headline: 'Daily reports are filed on under ' + asPct(WEAK_CONSISTENCY) + ' of recorded working days ('
          + asPct(consistency) + ').',
        detail: 'The most common cause is not knowing the report is expected. Ask before treating it as '
          + 'anything else.',
        direction: 'attention',
        evidenceStrength: 'demonstrated',
        inputs: [
          { label: 'Days filed', value: String(f.submission.filedDays), source: 'hr_daily_reports' },
          { label: 'Days expected', value: String(f.submission.expectedDays), source: 'hr_attendance' },
        ],
        processing: 'Reporting consistency below ' + asPct(WEAK_CONSISTENCY) + ' over at least '
          + String(MIN_OBSERVATIONS) + ' expected days.',
        output: asPct(consistency),
        evidence: [{ label: 'Expected days with no report', kind: 'aggregate', count: f.submission.expectedDays - f.submission.filedDays }],
        confidence: rateConfidence(f.submission.expectedDays),
        confidenceBasis: 'Measured over ' + String(f.submission.expectedDays) + ' expected days.',
      }));
    }
  }

  if (!failed(f, 'rework') && f.rework.tasksReachingReview >= MIN_OBSERVATIONS) {
    const rate = pctOf(f.rework.tasksSentBack, f.rework.tasksReachingReview) || 0;
    if (rate >= HIGH_REWORK) {
      out.push(buildSignal({
        ...base,
        key: 'development.rework_rate',
        headline: asPct(rate) + ' of reviewed work came back for changes.',
        detail: 'This is as often a briefing problem as a quality one. The useful question is what the '
          + 'send-backs had in common, not how many there were.',
        direction: 'attention',
        evidenceStrength: 'demonstrated',
        inputs: [
          { label: 'Tasks sent back', value: String(f.rework.tasksSentBack), source: 'audit_log' },
          { label: 'Tasks that reached review', value: String(f.rework.tasksReachingReview), source: 'audit_log' },
        ],
        processing: 'Send-back rate at or above ' + asPct(HIGH_REWORK) + ' over at least '
          + String(MIN_OBSERVATIONS) + ' reviewed tasks.',
        output: asPct(rate),
        evidence: [{ label: 'Send-back moves', kind: 'aggregate', count: f.rework.sendBacks }],
        confidence: rateConfidence(f.rework.tasksReachingReview),
        confidenceBasis: 'Measured over ' + String(f.rework.tasksReachingReview) + ' reviewed tasks, from audit_log.',
      }));
    }
  }

  if (!failed(f, 'stated') && f.stated.improvementNotes > 0) {
    out.push(buildSignal({
      ...base,
      key: 'development.stated_by_colleagues',
      headline: String(f.stated.improvementNotes) + ' ' + plural(f.stated.improvementNotes, 'colleague has', 'colleagues have')
        + ' written an improvement note about this person.',
      detail: 'One person’s note is one person’s view. Several notes agreeing is a different thing from '
        + 'one note repeated, and this count does not tell them apart.',
      direction: 'attention',
      evidenceStrength: 'stated',
      inputs: [{ label: 'Feedback notes themed as improvement', value: String(f.stated.improvementNotes), source: 'hr_feedback' }],
      processing: 'Count of hr_feedback rows about this person with theme = improvement that the manager is '
        + 'permitted to see.',
      output: String(f.stated.improvementNotes) + ' improvement notes',
      evidence: [{ label: 'Improvement notes', kind: 'aggregate', count: f.stated.improvementNotes }],
      confidence: COUNT_CONFIDENCE,
      confidenceBasis: 'A count of what people wrote, not a finding about the person.',
    }));
  }

  return out;
}

// -------------------------------------------------------------------------------------------------
// 7. WORKLOAD AND CAPACITY
// -------------------------------------------------------------------------------------------------

function capacitySignals(f: TeamMemberFacts, now: string): ManagerSignal[] {
  if (failed(f, 'capacity')) return [];
  const c: CapacityFacts = f.capacity;
  const w = f.window;
  const out: ManagerSignal[] = [];
  const base = {
    section: 'workload_capacity' as const,
    observedFrom: w.fromIso,
    observedTo: w.toIso,
    computedAt: now,
  };

  const priorityStack = c.urgentOpen + c.highOpen;
  out.push(buildSignal({
    ...base,
    key: 'capacity.current_load',
    headline: 'Carrying ' + String(c.activeAssignments) + ' active '
      + plural(c.activeAssignments, 'assignment', 'assignments') + ', ' + String(priorityStack)
      + ' of them at high or urgent priority.',
    detail: 'Assignment counts are a proxy for load and a poor one on their own. Two of these may be an '
      + 'afternoon and one may be a fortnight.',
    direction: 'neutral',
    evidenceStrength: 'demonstrated',
    inputs: [
      { label: 'Active assignments', value: String(c.activeAssignments), source: 'employee_tasks' },
      { label: 'Urgent open', value: String(c.urgentOpen), source: 'employee_tasks' },
      { label: 'High open', value: String(c.highOpen), source: 'employee_tasks' },
    ],
    processing: 'Count of open employee_tasks rows assigned to this person, split by priority.',
    output: String(c.activeAssignments) + ' active, ' + String(priorityStack) + ' high or urgent',
    evidence: [{ label: 'Open assignment rows', kind: 'aggregate', count: c.activeAssignments }],
    confidence: COUNT_CONFIDENCE,
    confidenceBasis: COUNT_BASIS,
  }));

  if (c.teamMeanAssignments !== null && c.teamSize > 1 && c.teamMeanAssignments > 0
      && c.activeAssignments >= c.teamMeanAssignments * LOAD_MULTIPLE) {
    const multiple = Math.round((c.activeAssignments / c.teamMeanAssignments) * 10) / 10;
    out.push(buildSignal({
      ...base,
      key: 'capacity.above_team_load',
      headline: 'Holding about ' + String(multiple) + ' times the team’s average open assignment count.',
      detail: 'A comparison of counts across ' + String(c.teamSize) + ' people, not of effort or difficulty. '
        + 'It is a prompt to check, not a finding that the split is wrong.',
      direction: 'attention',
      evidenceStrength: 'derived',
      inputs: [
        { label: 'This person’s active assignments', value: String(c.activeAssignments), source: 'employee_tasks' },
        { label: 'Team mean active assignments', value: String(Math.round(c.teamMeanAssignments * 10) / 10), source: 'employee_tasks' },
        { label: 'Team size', value: String(c.teamSize), source: 'employee_tasks' },
      ],
      processing: 'Active assignments divided by the mean across the authorised team, flagged at or above '
        + String(LOAD_MULTIPLE) + ' times.',
      output: String(multiple) + 'x the team mean',
      evidence: [{ label: 'People compared', kind: 'aggregate', count: c.teamSize }],
      confidence: rateConfidence(c.teamSize),
      confidenceBasis: 'A mean over ' + String(c.teamSize) + ' people. On a small team one colleague’s '
        + 'quiet fortnight moves the average a long way.',
    }));
  }

  if (c.approvedLeaveDaysNext14 > 0 && c.dueWithin7 > 0) {
    out.push(buildSignal({
      ...base,
      key: 'capacity.leave_against_deadlines',
      headline: String(c.approvedLeaveDaysNext14) + ' approved leave '
        + plural(c.approvedLeaveDaysNext14, 'day', 'days') + ' in the next fortnight, against '
        + String(c.dueWithin7) + ' ' + plural(c.dueWithin7, 'task', 'tasks') + ' due within the week.',
      detail: 'Cover planning, nothing more. The kind of leave is not shown here and is not relevant to '
        + 'arranging cover.',
      direction: 'attention',
      evidenceStrength: 'demonstrated',
      inputs: [
        { label: 'Approved leave days in the next 14', value: String(c.approvedLeaveDaysNext14), source: 'hr_leave_request' },
        { label: 'Tasks due within 7 days', value: String(c.dueWithin7), source: 'employee_tasks' },
      ],
      processing: 'Approved hr_leave_request days overlapping the next fortnight, read beside open tasks '
        + 'due in the next seven days. Leave type and reason are not read.',
      output: String(c.approvedLeaveDaysNext14) + ' leave days against ' + String(c.dueWithin7) + ' deadlines',
      evidence: [{ label: 'Approved leave days ahead', kind: 'aggregate', count: c.approvedLeaveDaysNext14 }],
      confidence: COUNT_CONFIDENCE,
      confidenceBasis: COUNT_BASIS,
    }));
  }

  return out;
}

// -------------------------------------------------------------------------------------------------
// THE WHOLE SET
// -------------------------------------------------------------------------------------------------

/**
 * Every signal for one team member, in section order.
 *
 * @param facts gathered by read.ts, already scoped to somebody this manager is authorised to see.
 * @param now   ISO instant, passed in so the same facts always render the same page.
 */
export function signalsFor(facts: TeamMemberFacts, now: string): ManagerSignal[] {
  return [
    ...deliverySignals(facts, now),
    ...submissionSignals(facts, now),
    ...reworkSignals(facts, now),
    ...behaviourSignals(facts, now),
    ...strengthSignals(facts, now),
    ...developmentSignals(facts, now),
    ...capacitySignals(facts, now),
  ];
}

/** The signals belonging to one section, for a page that renders section by section. */
export function signalsInSection(signals: readonly ManagerSignal[], section: string): ManagerSignal[] {
  return signals.filter((s) => s.section === section);
}

/**
 * The sentence a section prints when it has nothing to show.
 *
 * IT DISTINGUISHES THREE STATES that a bare "no data" would collapse into one: the read failed, the
 * window holds nothing yet, and everything was read and nothing needed saying. Only the third is
 * good news, and only the first needs somebody to look at the system rather than at the person.
 */
export function emptySectionSentence(section: string, facts: TeamMemberFacts): string {
  const area = sectionArea(section);
  if (area && facts.readFailures.indexOf(area) >= 0) {
    return 'This section could not be read just now, so it is showing nothing rather than showing zero. '
      + 'That is a statement about the query, not about this person.';
  }
  if (section === 'strengths') {
    return 'Nothing in this window clears the bar this page sets for calling something a strength. That '
      + 'is a statement about how much has been recorded, not about the person.';
  }
  if (section === 'development_areas') {
    return 'Nothing in this window falls below the bar this page sets for raising a development area.';
  }
  return 'Nothing recorded in this window.';
}

/** Which fact area a section is read from, for the failure sentence above. */
function sectionArea(section: string): string | null {
  const k = String(section || '');
  if (k === 'current_work') return 'delivery';
  if (k === 'submission_patterns') return 'submission';
  if (k === 'quality_rework') return 'rework';
  if (k === 'team_behaviour') return 'behaviour';
  if (k === 'workload_capacity') return 'capacity';
  if (k === 'feedback') return 'stated';
  return null;
}
