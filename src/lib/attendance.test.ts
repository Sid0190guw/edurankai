// The clock people actually read.
//
// =================================================================================================
// THREE EMPLOYEES REPORTED THE SAME THING IN ONE EVENING
// =================================================================================================
//
//   "Actually I clocked in at around 11:30 AM, but the attendance tracker is showing my check-in
//    time as 06:11 AM."
//   "Ya there is some issue, I also clocked in at 11:15 in the morning and it was showing 6:15."
//   "The portal is showing incorrect IN and OUT timings in my attendance record."
//
// Every attendance screen formatted a punch with getUTCHours(), and India is UTC+5:30. The tracker
// had recorded the right instant and displayed it against the wrong clock — 06:11 UTC IS 11:41 in
// Kolkata, and 06:15 UTC is 11:45. Each of them reasonably assumed the record was wrong.
//
// It was not cosmetic either. Shifts are stored as minutes past LOCAL midnight, so comparing a 09:00
// shift against a UTC punch made everybody appear five and a half hours EARLY, and nobody could ever
// be marked late.
//
// The figures below are the ones from those messages, so a regression reproduces the complaint
// rather than an abstraction of it.

import { describe, it, expect, report } from './test-shim';
import { clockTimeIst, minuteOfDayIst, punctuality, computeDay, ATTENDANCE_TIME_ZONE } from './attendance';

describe('clock times are shown in the zone people work in', () => {
  it('shows the punch reported as 06:11 as 11:41', () => {
    expect(clockTimeIst('2026-08-13T06:11:00.000Z')).toBe('11:41');
  });

  it('shows the second reported punch as 11:45, not 06:15', () => {
    expect(clockTimeIst('2026-08-13T06:15:00.000Z')).toBe('11:45');
  });

  it('uses a 24-hour clock, so 6pm is not confusable with 6am', () => {
    // 12:30 UTC is 18:00 IST. An am/pm formatter here would have made the original complaint
    // ambiguous rather than obvious.
    expect(clockTimeIst('2026-08-13T12:30:00.000Z')).toBe('18:00');
  });

  it('rolls across midnight UTC without inventing a 25th hour', () => {
    // 20:00 UTC is 01:30 the NEXT day in Kolkata. Adding 5.5 to the hour would print 25:30.
    expect(clockTimeIst('2026-08-13T20:00:00.000Z')).toBe('01:30');
  });

  it('is empty for nothing, rather than printing a fake time', () => {
    expect(clockTimeIst(null)).toBe('');
    expect(clockTimeIst('')).toBe('');
    expect(clockTimeIst('not a date')).toBe('');
  });

  it('names the working zone explicitly rather than reading the machine', () => {
    // A server that moved region would otherwise silently restate everybody's hours.
    expect(ATTENDANCE_TIME_ZONE).toBe('Asia/Kolkata');
  });
});

describe('lateness is measured against that same clock', () => {
  const shift = { id: 's1', name: 'General', startMinute: 9 * 60, endMinute: 18 * 60 } as any;
  const at = (iso: string) => ({
    clockIn: iso, clockOut: null, breakMinutes: 0, workedMinutes: 0, onBreak: false, open: true,
  }) as any;

  it('minuteOfDayIst agrees with what the screen shows', () => {
    // If these two disagreed, somebody could be shown 11:41 and recorded as arriving at 06:11.
    expect(minuteOfDayIst('2026-08-13T06:11:00.000Z')).toBe(11 * 60 + 41);
    expect(minuteOfDayIst(null)).toBe(null);
  });

  it('arriving 11:41 against a 09:00 shift is LATE, not five hours early', () => {
    const p = punctuality(shift, at('2026-08-13T06:11:00.000Z'));
    expect(p.lateMinutes).toBe(161);
    expect(p.earlyMinutes).toBe(0);
  });

  it('somebody genuinely early is still early', () => {
    // 03:00 UTC is 08:30 IST, half an hour before the shift.
    expect(punctuality(shift, at('2026-08-13T03:00:00.000Z')).lateMinutes).toBe(0);
  });

  it('no shift means nothing to be late for', () => {
    expect(punctuality(null, at('2026-08-13T06:11:00.000Z')).noShift).toBe(true);
  });
});

describe('worked time, which was the other half of the complaint', () => {
  // "I have worked for more than 5 hours, but after clocking out the website is showing my total
  //  working time as 0 minutes." Worked time is the span between the first clock_in and the last
  //  clock_out, so it is zero when — and only when — no clock_out was ever paired.
  const ev = (kind: string, at: string) => ({ kind, at } as any);

  it('a paired day counts the span', () => {
    const d = computeDay([
      ev('clock_in', '2026-08-13T06:11:00.000Z'),
      ev('clock_out', '2026-08-13T11:41:00.000Z'),
    ]);
    expect(d.workedMinutes).toBe(330);
    expect(d.open).toBe(false);
  });

  it('an UNPAIRED clock-in reports zero AND says the day is still open', () => {
    // This is the state behind the report. The zero is correct; what was missing is that the day is
    // open, which is the thing a person needs told rather than a bare 0.
    const d = computeDay([ev('clock_in', '2026-08-13T06:11:00.000Z')]);
    expect(d.workedMinutes).toBe(0);
    expect(d.open).toBe(true);
  });

  it('breaks come off the span rather than being ignored', () => {
    const d = computeDay([
      ev('clock_in', '2026-08-13T06:00:00.000Z'),
      ev('break_start', '2026-08-13T08:00:00.000Z'),
      ev('break_end', '2026-08-13T08:30:00.000Z'),
      ev('clock_out', '2026-08-13T11:00:00.000Z'),
    ]);
    expect(d.workedMinutes).toBe(270);
    expect(d.breakMinutes).toBe(30);
  });

  it('a break left open is not counted as worked time', () => {
    const d = computeDay([
      ev('clock_in', '2026-08-13T06:00:00.000Z'),
      ev('break_start', '2026-08-13T08:00:00.000Z'),
    ]);
    expect(d.onBreak).toBe(true);
    expect(d.workedMinutes).toBe(0);
  });
});

report();
