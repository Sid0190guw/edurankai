// src/lib/founder-slots.test.ts — THE SLOT ARITHMETIC IS PURE, AND MUST STAY THAT WAY.
//
// =================================================================================================
// WHY THIS EXISTS
// =================================================================================================
//
// getAvailableSlots() read the founder settings row AND the booked-slot set on every call, and
// /api/founder/slots called it once per day for the next twenty-one. Measured on the live site, that
// endpoint answered in 5.1-5.2 SECONDS on four consecutive probes: forty-two round trips to fetch
// two answers that do not vary by date, at the ~130ms this deployment pays for each one.
//
// The fix was not a faster query. It was moving the two reads out of the loop — src/lib/founder.ts
// now exposes them as a SlotContext, and the arithmetic as slotsForDate(ctx, date), which touches no
// database at all. This file is what keeps that true: every assertion below runs without a database,
// which is only possible while the function stays pure.
import { describe, it, expect } from 'vitest';
import { slotsForDate, type SlotContext, type FounderSettings } from './founder';

/** Every weekday carries the same window, so the test does not depend on which day it runs. */
const AVAIL = { '0': [['09:00', '12:00']], '1': [['09:00', '12:00']], '2': [['09:00', '12:00']],
  '3': [['09:00', '12:00']], '4': [['09:00', '12:00']], '5': [['09:00', '12:00']],
  '6': [['09:00', '12:00']] } as FounderSettings['availability'];

function settings(over: Partial<FounderSettings> = {}): FounderSettings {
  return {
    name: '', role: 'Founder', tagline: '', bio: '', photoUrl: '',
    connectNumber: '', connectMessage: '', connectLabel: '', calendarUrl: '',
    isPublic: true, showInNav: false,
    textPriceChf: 100, consultPriceChf: 500, currency: 'CHF', gateText: true, gateConsult: true,
    // UTC so the window arithmetic below is not a question about a zone's rules.
    timezone: 'UTC', slotMinutes: 30, bufferMinutes: 0, minNoticeHours: 12, maxDaysAhead: 30,
    availability: AVAIL, blockedDates: [],
    ...over,
  };
}

function ctx(over: Partial<FounderSettings> = {}, taken: string[] = []): SlotContext {
  return { settings: settings(over), taken: new Set(taken) };
}

/** A date comfortably inside [now + minNoticeHours, now + maxDaysAhead]. */
function dateInWindow(daysAhead = 5): string {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().slice(0, 10);
}

describe('slotsForDate', () => {
  const day = dateInWindow();

  it('expands a window into slots without reading anything', () => {
    const slots = slotsForDate(ctx(), day);
    // 09:00-12:00 at 30 minutes with no buffer is six starts: 09:00 .. 11:30.
    expect(slots.length).toBe(6);
    expect(slots.every((s) => typeof s.iso === 'string' && typeof s.label === 'string')).toBe(true);
    // Sorted and strictly increasing — the calendar renders them in order.
    const times = slots.map((s) => new Date(s.iso).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });

  it('drops a start that is already taken, and only that one', () => {
    const all = slotsForDate(ctx(), day);
    const gone = all[2].iso;
    const left = slotsForDate(ctx({}, [gone]), day);
    expect(left.length).toBe(all.length - 1);
    expect(left.some((s) => s.iso === gone)).toBe(false);
  });

  it('returns nothing for a blocked date', () => {
    expect(slotsForDate(ctx({ blockedDates: [day] }), day)).toEqual([]);
  });

  it('returns nothing for a weekday with no window', () => {
    expect(slotsForDate(ctx({ availability: {} as FounderSettings['availability'] }), day)).toEqual([]);
  });

  it('returns nothing for a malformed date rather than throwing', () => {
    expect(slotsForDate(ctx(), '')).toEqual([]);
    expect(slotsForDate(ctx(), 'not-a-date')).toEqual([]);
  });

  it('honours the notice period and the horizon', () => {
    // Today is inside the 12-hour notice for most of the window, and 400 days out is past every
    // horizon; both bounds must actually bite.
    expect(slotsForDate(ctx({ minNoticeHours: 24 * 365 }), day)).toEqual([]);
    expect(slotsForDate(ctx({ maxDaysAhead: 1 }), day)).toEqual([]);
  });

  it('adds the buffer between starts', () => {
    // 30 + 30 = one start an hour: 09:00, 10:00, 11:00.
    expect(slotsForDate(ctx({ bufferMinutes: 30 }), day).length).toBe(3);
  });

  // A NON-POSITIVE STEP IS AN INFINITE LOOP INSIDE A REQUEST, and `|| 30` does not catch a negative
  // because -5 is truthy. The settings form stores whatever number it is given. Vitest's timeout is
  // the assertion here: without the clamp in slotsForDate this test never returns.
  it('cannot be made to loop forever by a negative slot length', () => {
    const slots = slotsForDate(ctx({ slotMinutes: -5 }), day);
    expect(Array.isArray(slots)).toBe(true);
  });

  it('cannot be made to loop forever by a zero-length step', () => {
    const slots = slotsForDate(ctx({ slotMinutes: 0, bufferMinutes: 0 }), day);
    expect(Array.isArray(slots)).toBe(true);
  });
});
