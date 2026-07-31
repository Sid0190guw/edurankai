// Mapping tests for credit-ledger. The arithmetic is covered in credit-hours.test.ts; what matters
// here is that a stored attendance row is interpreted as the right KIND of day — above all whether
// leave counts as authorised, since that is what the prior-notice rule turns on.
import { describe, it, expect } from 'vitest';
import { summarise, type AttendanceDay, type EngagementTerms } from './credit-hours';

const FULL: EngagementTerms = { kind: 'full-time', workingDaysPerWeek: 5, requiredCreditHours: 480 };

// Mirrors statusFor() in credit-ledger.ts. Kept in step with it deliberately: if the two ever
// disagree, one is wrong, and this is the cheaper place to find out.
interface LeaveWindow { start: string; end: string; noticeGivenAt: string | null }
const covers = (w: LeaveWindow, d: string) => !!w.start && d >= w.start && d <= (w.end || w.start);

function statusFor(row: { date: string; status: string }, leave: LeaveWindow[]) {
  const win = leave.find((w) => covers(w, row.date));
  const notified = win?.noticeGivenAt || null;
  if (row.status === 'holiday') return { status: 'holiday' as const, noticeGivenAt: null };
  if (row.status === 'present' || row.status === 'wfh') return { status: 'present' as const, noticeGivenAt: null };
  if (row.status === 'on_leave' || row.status === 'absent') {
    if (win && notified) return { status: 'authorised-leave' as const, noticeGivenAt: notified };
    if (win) return { status: 'authorised-leave' as const, noticeGivenAt: null };
    return { status: 'unauthorised-leave' as const, noticeGivenAt: null };
  }
  return { status: 'present' as const, noticeGivenAt: null };
}

const leaveWith = (start: string, end: string, requestedAt: string): LeaveWindow => ({
  start, end,
  // Strictly before — a request filed on the morning of the absence is not prior notice.
  noticeGivenAt: requestedAt < start ? requestedAt : null,
});

describe('attendance status mapping', () => {
  it('treats working from home as ordinary attendance', () => {
    // Where someone sat is not a credit question.
    expect(statusFor({ date: '2026-02-02', status: 'wfh' }, []).status).toBe('present');
  });

  it('maps a holiday to holiday', () => {
    expect(statusFor({ date: '2026-02-02', status: 'holiday' }, []).status).toBe('holiday');
  });

  it('leave with prior notice is authorised', () => {
    const l = [leaveWith('2026-02-10', '2026-02-11', '2026-02-01')];
    const r = statusFor({ date: '2026-02-10', status: 'on_leave' }, l);
    expect(r.status).toBe('authorised-leave');
    expect(r.noticeGivenAt).toBe('2026-02-01');
  });

  it('leave requested ON the day is NOT prior notice, even though approved', () => {
    // This is the rule doing its job: approval after the fact does not make it notified.
    const l = [leaveWith('2026-02-10', '2026-02-10', '2026-02-10')];
    const r = statusFor({ date: '2026-02-10', status: 'on_leave' }, l);
    expect(r.status).toBe('authorised-leave');
    expect(r.noticeGivenAt).toBeNull();      // -> counted as a notice breach downstream
  });

  it('absence with no approved request at all is unauthorised', () => {
    const r = statusFor({ date: '2026-02-10', status: 'absent' }, []);
    expect(r.status).toBe('unauthorised-leave');
  });

  it('absence covered by a notified request is still authorised', () => {
    // The grid may simply not have been updated; an administrative gap should not penalise anyone.
    const l = [leaveWith('2026-02-09', '2026-02-12', '2026-02-01')];
    expect(statusFor({ date: '2026-02-10', status: 'absent' }, l).status).toBe('authorised-leave');
  });

  it('leave outside the approved window is unauthorised', () => {
    const l = [leaveWith('2026-02-01', '2026-02-02', '2026-01-20')];
    expect(statusFor({ date: '2026-02-10', status: 'on_leave' }, l).status).toBe('unauthorised-leave');
  });
});

describe('end to end through the engine', () => {
  it('notified leave protects attendance; unnotified absence does not', () => {
    const leave = [leaveWith('2026-02-03', '2026-02-03', '2026-01-28')];
    const stored = [
      { date: '2026-02-02', status: 'present' },
      { date: '2026-02-03', status: 'on_leave' },   // notified
      { date: '2026-02-04', status: 'absent' },     // not notified
    ];
    const days: AttendanceDay[] = stored.map((r) => {
      const s = statusFor(r, leave);
      return { date: r.date, status: s.status, noticeGivenAt: s.noticeGivenAt };
    });
    const sum = summarise(days, FULL);

    expect(sum.creditHours).toBe(8);            // only the worked day
    expect(sum.expectedHours).toBe(16);         // notified leave excused, absence still expected
    expect(sum.attendancePct).toBe(50);
    expect(sum.authorisedLeaveDays).toBe(1);
    expect(sum.unauthorisedLeaveDays).toBe(1);
    expect(sum.noticeBreaches).toBe(1);         // the unnotified absence only
  });

  it('a stored 0 hours on a leave day is not read as working zero hours', () => {
    // hr_attendance defaults work_hours to 0, so passing it through would understate credit.
    const days: AttendanceDay[] = [
      { date: '2026-02-03', status: 'authorised-leave', noticeGivenAt: '2026-01-28' },
      { date: '2026-02-04', status: 'present' },   // no hours -> full expected day
    ];
    const sum = summarise(days, FULL);
    expect(sum.creditHours).toBe(8);
    expect(sum.attendancePct).toBe(100);
  });
});
