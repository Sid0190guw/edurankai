// THE RULES OF THE COMPLETION ENGINE. Pure: no database, no clock it does not take as an argument.
//
// When a fixed-term engagement (internship, apprenticeship, contract) reaches its end, the engine:
//   1. a week before the end, asks the person's lead to review them, approve or hold, and write a
//      letter of recommendation (web push);
//   2. on the end date, measures the engagement against the criteria below;
//   3. if EVERY criterion passes, issues and emails the completion certificate itself;
//   4. otherwise holds it for a person to decide, saying exactly which criterion stopped it.
//
// A FAILED CRITERION NEVER REFUSES ANYBODY. It stops the AUTOMATIC issue and puts the decision in
// front of a human, which is the house rule for every automated check: advisory, a person decides.
// Every action the engine takes can also be taken by hand from /admin/hr/completions.

/** Days before the end date that the lead is asked to review. */
export const NOTIFY_LEAD_DAYS_BEFORE = 7;
/** Attendance below this, where attendance was marked at all, holds the automatic issue. */
export const MIN_ATTENDANCE_PCT = 75;
/** Reviews averaging below this hold the automatic issue. */
export const MIN_AVERAGE_RATING = 3;
/** More unauthorised leave days than this hold the automatic issue. */
export const MAX_UNAUTHORISED_LEAVE_DAYS = 3;

export interface Duration { months: number; weeks: number; days: number }

/** "6 Months", "3 months", "12 weeks", "1 year", "90 days", "6 mo" -> a Duration, or null. */
export function parseDuration(text: unknown): Duration | null {
  const s = String(text ?? '').toLowerCase().replace(/,/g, ' ');
  const out: Duration = { months: 0, weeks: 0, days: 0 };
  let hit = false;
  const re = /(\d+(?:\.\d+)?)\s*(years?|yrs?|months?|mos?|mo|weeks?|wks?|days?)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const u = m[2];
    if (u.startsWith('y')) out.months += Math.round(n * 12);
    else if (u.startsWith('mo')) out.months += Math.round(n);
    else if (u.startsWith('w')) out.weeks += Math.round(n);
    else out.days += Math.round(n);
    hit = true;
  }
  return hit ? out : null;
}

function isoOf(y: number, m0: number, d: number): string {
  return new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
}

/** The last day of an engagement that starts on `startIso` and lasts `d`. Start + duration - 1 day. */
export function endDateFor(startIso: string, d: Duration): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(startIso || ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]) - 1; const day = Number(m[3]);
  // Months first, clamping to the end of a shorter month (31 Jan + 1 month = 28/29 Feb).
  const targetMonth = mo + d.months;
  const lastDayOfTarget = new Date(Date.UTC(y, targetMonth + 1, 0)).getUTCDate();
  const base = Date.UTC(y, targetMonth, Math.min(day, lastDayOfTarget));
  const end = new Date(base + ((d.weeks * 7) + d.days - 1) * 86400000);
  return isoOf(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
}

/** Whole days from `todayIso` to `endIso`: 0 on the last day, negative once it has passed. */
export function daysUntil(endIso: string, todayIso: string): number | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(endIso || ''));
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(todayIso || ''));
  if (!a || !b) return null;
  return Math.round((Date.UTC(+a[1], +a[2] - 1, +a[3]) - Date.UTC(+b[1], +b[2] - 1, +b[3])) / 86400000);
}

/** Is this engagement fixed-term, i.e. one the engine should watch? */
export function isFixedTerm(employmentType: unknown, hasDuration: boolean): boolean {
  return hasDuration || /intern|apprentic|trainee|contract|fixed/i.test(String(employmentType ?? ''));
}

// -------------------------------------------------------------------------------------------------
// CRITERIA
// -------------------------------------------------------------------------------------------------

export interface CriteriaInput {
  figuresMeasured: boolean;
  eligible: boolean;
  eligibilityReason: string;
  attendanceKnown: boolean;
  attendancePct: number;
  reviewCount: number;
  averageRating: number | null;
  unauthorisedLeaveDays: number;
  creditApplicable: boolean;
  pendingCreditWeeks: number;
  leadDecision: 'approved' | 'held' | null;
  hasEmail: boolean;
}

export type CriterionState = 'pass' | 'fail' | 'unknown' | 'info';

export interface Criterion { key: string; label: string; state: CriterionState; detail: string }

export interface Evaluation { criteria: Criterion[]; allPassed: boolean; blocking: Criterion[] }

export function evaluateCriteria(i: CriteriaInput): Evaluation {
  const c: Criterion[] = [];
  c.push(i.figuresMeasured
    ? { key: 'measured', label: 'Records readable', state: 'pass', detail: 'Attendance, leave and reviews were read.' }
    : { key: 'measured', label: 'Records readable', state: 'unknown', detail: 'The attendance or review records could not be read, so nothing is concluded.' });

  c.push(i.eligible
    ? { key: 'requirement', label: 'Hours requirement', state: 'pass', detail: i.eligibilityReason }
    : { key: 'requirement', label: 'Hours requirement', state: 'fail', detail: i.eligibilityReason });

  if (i.reviewCount === 0) {
    c.push({ key: 'reviews', label: 'Reviews', state: 'unknown', detail: 'No review has been recorded, so performance has not been assessed.' });
  } else if (i.averageRating != null && i.averageRating < MIN_AVERAGE_RATING) {
    c.push({ key: 'reviews', label: 'Reviews', state: 'fail', detail: 'Average rating ' + i.averageRating + ' of 5 across ' + i.reviewCount + ' review(s), below ' + MIN_AVERAGE_RATING + '.' });
  } else {
    c.push({ key: 'reviews', label: 'Reviews', state: 'pass', detail: i.reviewCount + ' review(s)' + (i.averageRating != null ? ', average ' + i.averageRating + ' of 5' : '') + '.' });
  }

  if (!i.attendanceKnown) {
    c.push({ key: 'attendance', label: 'Attendance', state: 'info', detail: 'Attendance was not marked in the register; hours are measured from check-in and check-out instead.' });
  } else if (i.attendancePct < MIN_ATTENDANCE_PCT) {
    c.push({ key: 'attendance', label: 'Attendance', state: 'fail', detail: i.attendancePct + '%, below ' + MIN_ATTENDANCE_PCT + '%.' });
  } else {
    c.push({ key: 'attendance', label: 'Attendance', state: 'pass', detail: i.attendancePct + '%.' });
  }

  c.push(i.unauthorisedLeaveDays > MAX_UNAUTHORISED_LEAVE_DAYS
    ? { key: 'leave', label: 'Unauthorised leave', state: 'fail', detail: i.unauthorisedLeaveDays + ' day(s), more than ' + MAX_UNAUTHORISED_LEAVE_DAYS + '.' }
    : { key: 'leave', label: 'Unauthorised leave', state: 'pass', detail: i.unauthorisedLeaveDays + ' day(s).' });

  if (i.creditApplicable && i.pendingCreditWeeks > 0) {
    c.push({ key: 'credits', label: 'Weekly credits', state: 'unknown', detail: i.pendingCreditWeeks + ' week(s) are waiting on a decision. Decide them first.' });
  } else if (i.creditApplicable) {
    c.push({ key: 'credits', label: 'Weekly credits', state: 'pass', detail: 'Every week is decided.' });
  }

  if (i.leadDecision === 'held') {
    c.push({ key: 'lead', label: 'Lead review', state: 'fail', detail: 'The lead held the completion.' });
  } else if (i.leadDecision === 'approved') {
    c.push({ key: 'lead', label: 'Lead review', state: 'pass', detail: 'The lead approved the completion.' });
  } else {
    c.push({ key: 'lead', label: 'Lead review', state: 'info', detail: 'The lead has not responded. This does not hold the certificate.' });
  }

  c.push(i.hasEmail
    ? { key: 'email', label: 'Email on record', state: 'pass', detail: 'The certificate can be emailed.' }
    : { key: 'email', label: 'Email on record', state: 'info', detail: 'No email on record: the certificate is issued but cannot be sent.' });

  const blocking = c.filter((x) => x.state === 'fail' || x.state === 'unknown');
  return { criteria: c, allPassed: blocking.length === 0, blocking };
}

// -------------------------------------------------------------------------------------------------
// WHAT TO DO NEXT
// -------------------------------------------------------------------------------------------------

export type NextStep = 'none' | 'notify_lead' | 'evaluate';

export function nextStep(s: { daysLeft: number | null; leadNotified: boolean; outcome: string | null }): NextStep {
  if (s.outcome) return 'none';
  if (s.daysLeft === null) return 'none';
  if (s.daysLeft <= 0) return 'evaluate';
  if (s.daysLeft <= NOTIFY_LEAD_DAYS_BEFORE && !s.leadNotified) return 'notify_lead';
  return 'none';
}
