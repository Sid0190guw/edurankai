import { describe, it, expect } from 'vitest';
import {
  zonedTimeToUtc, utcToZonedInput, zoneOffsetMinutes, isValidTimeZone, formatInZone,
  nextOccurrence, occurrencePreview, recurrenceErrors, isDue, minutesLate,
  type Recurrence,
} from '@/lib/mail-schedule';

describe('time zones', () => {
  it('recognises real zones and refuses invented ones', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('resolves an IST wall clock to the right UTC instant', () => {
    // 09:30 IST is 04:00 UTC — India is UTC+5:30 all year.
    expect(zonedTimeToUtc('2026-08-20T09:30', 'Asia/Kolkata').toISOString()).toBe('2026-08-20T04:00:00.000Z');
  });

  it('does NOT read the wall clock in the server zone', () => {
    const ist = zonedTimeToUtc('2026-08-20T09:30', 'Asia/Kolkata').getTime();
    const utc = zonedTimeToUtc('2026-08-20T09:30', 'UTC').getTime();
    expect(utc - ist).toBe(5.5 * 3600 * 1000);
  });

  it('handles a summer/winter offset change in a DST zone', () => {
    // New York is UTC-4 in August and UTC-5 in January.
    expect(zonedTimeToUtc('2026-08-20T09:00', 'America/New_York').toISOString()).toBe('2026-08-20T13:00:00.000Z');
    expect(zonedTimeToUtc('2026-01-20T09:00', 'America/New_York').toISOString()).toBe('2026-01-20T14:00:00.000Z');
  });

  it('lands after the jump rather than refusing on a spring-forward gap', () => {
    // 02:30 on 8 March 2026 does not exist in New York.
    const at = zonedTimeToUtc('2026-03-08T02:30', 'America/New_York');
    expect(Number.isNaN(at.getTime())).toBe(false);
    expect(at.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('refuses input it cannot read', () => {
    expect(Number.isNaN(zonedTimeToUtc('tomorrow', 'UTC').getTime())).toBe(true);
    expect(Number.isNaN(zonedTimeToUtc('2026-08-20T09:30', 'Mars/Olympus').getTime())).toBe(true);
  });

  it('round-trips a wall clock back to the picker', () => {
    const at = zonedTimeToUtc('2026-08-20T09:30', 'Asia/Kolkata');
    expect(utcToZonedInput(at, 'Asia/Kolkata')).toBe('2026-08-20T09:30');
  });

  it('reports the offset in minutes', () => {
    expect(zoneOffsetMinutes('Asia/Kolkata', new Date('2026-08-20T00:00:00Z'))).toBe(330);
    expect(zoneOffsetMinutes('UTC', new Date('2026-08-20T00:00:00Z'))).toBe(0);
  });

  it('formats with the zone named, so a stamp is never ambiguous', () => {
    expect(formatInZone(new Date('2026-08-20T04:00:00Z'), 'Asia/Kolkata')).toContain('Asia/Kolkata');
    expect(formatInZone(new Date('2026-08-20T04:00:00Z'), 'Asia/Kolkata')).toContain('09:30');
  });
});

describe('recurrence validation', () => {
  const good: Recurrence = { freq: 'weekly', interval: 1, hour: 9, minute: 30, timeZone: 'Asia/Kolkata', anchor: '2026-08-17T04:00:00Z' };

  it('accepts a sound rule', () => {
    expect(recurrenceErrors(good)).toEqual([]);
  });

  it('refuses a bad frequency, zone, clock, interval, anchor and weekday', () => {
    expect(recurrenceErrors({ ...good, freq: 'hourly' as any })[0]).toContain('how often');
    expect(recurrenceErrors({ ...good, timeZone: 'Mars/Olympus' })[0]).toContain('time zone');
    expect(recurrenceErrors({ ...good, hour: 25 })[0]).toContain('Hour');
    expect(recurrenceErrors({ ...good, minute: 99 })[0]).toContain('Minute');
    expect(recurrenceErrors({ ...good, interval: 0 })[0]).toContain('Repeat every');
    expect(recurrenceErrors({ ...good, anchor: 'someday' })[0]).toContain('first send date');
    expect(recurrenceErrors({ ...good, byWeekday: [9] })[0]).toContain('Weekdays');
  });
});

describe('nextOccurrence', () => {
  const daily: Recurrence = { freq: 'daily', interval: 1, hour: 9, minute: 0, timeZone: 'Asia/Kolkata', anchor: '2026-08-16T03:30:00Z' };

  it('finds the next daily slot', () => {
    const n = nextOccurrence(daily, new Date('2026-08-16T05:00:00Z'));
    expect(n!.toISOString()).toBe('2026-08-17T03:30:00.000Z');
  });

  it('honours an interval', () => {
    const every3 = { ...daily, interval: 3 };
    const list = occurrencePreview(every3, new Date('2026-08-16T05:00:00Z'), 3).map((d) => d.toISOString().slice(0, 10));
    expect(list).toEqual(['2026-08-19', '2026-08-22', '2026-08-25']);
  });

  it('keeps the local hour across a DST change', () => {
    const ny: Recurrence = { freq: 'weekly', interval: 1, byWeekday: [1], hour: 9, minute: 0, timeZone: 'America/New_York', anchor: '2026-10-26T13:00:00Z' };
    const list = occurrencePreview(ny, new Date('2026-10-26T14:00:00Z'), 3);
    // 9am NY is 13:00 UTC before the November change and 14:00 UTC after it — the WALL CLOCK holds.
    expect(list[0].toISOString()).toBe('2026-11-02T14:00:00.000Z');
    expect(list.every((d) => ['13:00', '14:00'].includes(d.toISOString().slice(11, 16)))).toBe(true);
  });

  it('respects selected weekdays', () => {
    const r: Recurrence = { freq: 'weekly', interval: 1, byWeekday: [1, 4], hour: 9, minute: 0, timeZone: 'UTC', anchor: '2026-08-17T09:00:00Z' };
    const days = occurrencePreview(r, new Date('2026-08-17T10:00:00Z'), 4).map((d) => d.getUTCDay());
    expect(days).toEqual([4, 1, 4, 1]);
  });

  it('clamps a monthly series anchored on the 31st to the end of a short month', () => {
    const r: Recurrence = { freq: 'monthly', interval: 1, hour: 9, minute: 0, timeZone: 'UTC', anchor: '2026-01-31T09:00:00Z' };
    const list = occurrencePreview(r, new Date('2026-01-31T10:00:00Z'), 3).map((d) => d.toISOString().slice(0, 10));
    expect(list).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('stops at `until`', () => {
    const r = { ...daily, until: '2026-08-18T23:59:00Z' };
    expect(occurrencePreview(r, new Date('2026-08-16T05:00:00Z'), 5)).toHaveLength(2);
  });

  it('stops at `count`', () => {
    const r = { ...daily, count: 2 };
    expect(occurrencePreview(r, new Date('2026-08-16T05:00:00Z'), 5)).toHaveLength(2);
  });

  it('returns null for a rule it cannot read rather than guessing', () => {
    expect(nextOccurrence({ ...daily, timeZone: 'Mars/Olympus' }, new Date())).toBeNull();
  });

  it('never returns an instant at or before the cursor', () => {
    const exact = new Date('2026-08-17T03:30:00.000Z');
    expect(nextOccurrence(daily, exact)!.getTime()).toBeGreaterThan(exact.getTime());
  });
});

describe('due-ness', () => {
  const now = new Date('2026-08-20T04:00:00Z');

  it('is due at or after the instant', () => {
    expect(isDue('2026-08-20T03:59:00Z', now)).toBe(true);
    expect(isDue('2026-08-20T04:00:00Z', now)).toBe(true);
    expect(isDue('2026-08-20T04:01:00Z', now)).toBe(false);
  });

  it('accepts a grace window for a cron that does not fire on the second', () => {
    expect(isDue('2026-08-20T04:02:00Z', now, 5 * 60000)).toBe(true);
  });

  it('treats a missing or unreadable instant as not due', () => {
    expect(isDue(null, now)).toBe(false);
    expect(isDue('whenever', now)).toBe(false);
  });

  it('a campaign whose cron did not run is LATE, not cancelled', () => {
    expect(isDue('2026-08-19T04:00:00Z', now)).toBe(true);
    expect(minutesLate('2026-08-19T04:00:00Z', now)).toBe(1440);
    expect(minutesLate('2026-08-21T04:00:00Z', now)).toBe(0);
  });
});
