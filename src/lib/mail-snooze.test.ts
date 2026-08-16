// src/lib/mail-snooze.test.ts — the presets, and the times a snooze may not be set to.
//
// The arithmetic is in a fixed-offset zone (Asia/Kolkata, +05:30, no daylight saving), so these
// assertions are exact rather than approximately right twice a year.
import { describe, it, expect } from 'vitest';
import { snoozePresets, validateSnoozeTime, IST_OFFSET_MIN, MORNING_HOUR, EVENING_HOUR } from './mail-snooze';

/** The local wall-clock hour of an instant, in the mailbox's zone. */
function istHour(d: Date): number {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60000).getUTCHours();
}
function istDay(d: Date): number {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60000).getUTCDay();
}
/** An instant at a given IST wall-clock time. */
function ist(y: number, m: number, d: number, h: number): Date {
  return new Date(Date.UTC(y, m - 1, d, h, 0) - IST_OFFSET_MIN * 60000);
}

describe('the menu', () => {
  it('offers later today in the morning, at the evening hour', () => {
    // Wednesday 19 August 2026, 09:00 IST.
    const p = snoozePresets(ist(2026, 8, 19, 9));
    const later = p.find((x) => x.key === 'later-today')!;
    expect(later).toBeTruthy();
    expect(istHour(later.at!)).toBe(EVENING_HOUR);
  });

  it('drops later today once it would mean "in a few minutes"', () => {
    const p = snoozePresets(ist(2026, 8, 19, 21));
    expect(p.find((x) => x.key === 'later-today')).toBeUndefined();
  });

  it('tomorrow is the next morning, not midnight', () => {
    const t = snoozePresets(ist(2026, 8, 19, 9)).find((x) => x.key === 'tomorrow')!;
    expect(istHour(t.at!)).toBe(MORNING_HOUR);
    expect(t.at!.getTime()).toBeGreaterThan(ist(2026, 8, 19, 9).getTime());
  });

  it('this weekend is Saturday morning, and is not offered at the weekend', () => {
    // Tuesday.
    const weekday = snoozePresets(ist(2026, 8, 18, 9)).find((x) => x.key === 'this-weekend');
    expect(weekday).toBeTruthy();
    expect(istDay(weekday!.at!)).toBe(6);
    // Saturday: "this weekend" would be today, which is not a snooze.
    expect(snoozePresets(ist(2026, 8, 22, 9)).find((x) => x.key === 'this-weekend')).toBeUndefined();
  });

  it('next week is the coming Monday morning, and never today', () => {
    for (const day of [17, 18, 19, 20, 21, 22, 23]) {
      const now = ist(2026, 8, day, 9);
      const nw = snoozePresets(now).find((x) => x.key === 'next-week')!;
      expect(istDay(nw.at!)).toBe(1);
      expect(istHour(nw.at!)).toBe(MORNING_HOUR);
      expect(nw.at!.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it('every offered time is in the future, whatever hour it is asked at', () => {
    for (const hour of [0, 6, 9, 13, 17, 18, 21, 23]) {
      const now = ist(2026, 8, 19, hour);
      for (const p of snoozePresets(now)) {
        if (!p.at) continue;
        expect(p.at.getTime(), p.key + ' at ' + hour + ':00').toBeGreaterThan(now.getTime());
      }
    }
  });

  it('always ends with the custom option, which carries no time of its own', () => {
    const p = snoozePresets(ist(2026, 8, 19, 9));
    expect(p[p.length - 1].key).toBe('custom');
    expect(p[p.length - 1].at).toBeNull();
  });

  it('every preset says when it will come back', () => {
    for (const p of snoozePresets(ist(2026, 8, 19, 9))) {
      if (p.key === 'custom') continue;
      expect(p.when).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2}:\d{2} (am|pm)$/);
    }
  });
});

describe('what a snooze may be set to', () => {
  const now = new Date('2026-08-19T09:00:00+05:30');

  it('refuses a time that is not one', () => {
    expect(validateSnoozeTime('later', now)).toMatchObject({ ok: false });
    expect(validateSnoozeTime('', now)).toMatchObject({ ok: false });
  });

  it('refuses the past — the conversation would come straight back', () => {
    const r = validateSnoozeTime('2026-08-19T08:00:00+05:30', now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('already passed');
  });

  it('refuses a mistyped year that would put mail out of reach for a century', () => {
    const r = validateSnoozeTime('2126-01-01T09:00:00+05:30', now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('five years');
  });

  it('accepts an ordinary future time', () => {
    const r = validateSnoozeTime('2026-08-20T08:00:00+05:30', now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.at.toISOString()).toBe('2026-08-20T02:30:00.000Z');
  });
});
