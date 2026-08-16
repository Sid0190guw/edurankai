// Billing-period arithmetic and the rollup from durable events to numbers. Pure; no store.
import { describe, expect, it } from 'vitest';
import {
  addMonthsUtc,
  allCrossings,
  calendarPeriod,
  closingGauges,
  crossedThresholds,
  dailySeries,
  daysRemaining,
  emptySnapshot,
  inPeriod,
  nextPeriod,
  periodFor,
  periodProgress,
  projectedTotal,
  rollup,
  snapshotFromCounters,
  usageKey,
} from './usage';
import type { MetricKey, UsageEvent } from './types';

let seq = 0;
function ev(metric: MetricKey, quantity: number, occurredAt: string, mode?: 'delta' | 'set'): UsageEvent {
  seq += 1;
  return {
    id: 'e' + String(seq).padStart(4, '0'),
    orgId: 'org_1',
    metric,
    quantity,
    mode,
    source: 'test',
    idempotencyKey: null,
    meta: {},
    occurredAt,
  };
}

describe('month arithmetic', () => {
  it('clamps the 31st into a short month instead of rolling over', () => {
    // JavaScript's default would turn 31 January into 3 March, overlapping two billing periods.
    const jan31 = new Date('2026-01-31T00:00:00.000Z');
    expect(addMonthsUtc(jan31, 1).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(addMonthsUtc(jan31, 3).toISOString().slice(0, 10)).toBe('2026-04-30');
  });

  it('handles a leap year', () => {
    const jan31 = new Date('2028-01-31T00:00:00.000Z');
    expect(addMonthsUtc(jan31, 1).toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('walks backwards across a year boundary', () => {
    const jan15 = new Date('2026-01-15T00:00:00.000Z');
    expect(addMonthsUtc(jan15, -1).toISOString().slice(0, 10)).toBe('2025-12-15');
  });
});

describe('the period containing a moment', () => {
  const anchor = '2026-01-15T09:30:00.000Z';

  it('is half-open, so a boundary event lands in exactly one period', () => {
    const p = periodFor(anchor, '2026-02-20T00:00:00.000Z');
    expect(p.start).toBe('2026-02-15T09:30:00.000Z');
    expect(p.end).toBe('2026-03-15T09:30:00.000Z');
    expect(inPeriod(p, p.start)).toBe(true);
    expect(inPeriod(p, p.end)).toBe(false);
  });

  it('puts a moment exactly on the anchor into the new period, not the old one', () => {
    const p = periodFor(anchor, '2026-02-15T09:30:00.000Z');
    expect(p.start).toBe('2026-02-15T09:30:00.000Z');
  });

  it('is correct three years in', () => {
    const p = periodFor(anchor, '2029-04-02T12:00:00.000Z');
    expect(p.start).toBe('2029-03-15T09:30:00.000Z');
    expect(p.end).toBe('2029-04-15T09:30:00.000Z');
  });

  it('survives a month-end anchor for a whole year', () => {
    const monthEnd = '2026-01-31T00:00:00.000Z';
    const p = periodFor(monthEnd, '2026-03-01T00:00:00.000Z');
    // February's period runs from the clamped 28th to the 31st of March.
    expect(p.start).toBe('2026-02-28T00:00:00.000Z');
    expect(p.end).toBe('2026-03-31T00:00:00.000Z');
  });

  it('gives usage recorded before the anchor somewhere to live', () => {
    const p = periodFor(anchor, '2026-01-02T00:00:00.000Z');
    expect(new Date(p.end).getTime()).toBeLessThanOrEqual(new Date(anchor).getTime());
  });

  it('advances to the next period cleanly', () => {
    const p = periodFor(anchor, '2026-02-20T00:00:00.000Z');
    const n = nextPeriod(p);
    expect(n.start).toBe(p.end);
    expect(n.end).toBe('2026-04-15T09:30:00.000Z');
  });

  it('reports progress and days remaining', () => {
    const p = { start: '2026-03-01T00:00:00.000Z', end: '2026-03-31T00:00:00.000Z' };
    expect(periodProgress(p, '2026-03-16T00:00:00.000Z')).toBeCloseTo(0.5, 1);
    expect(periodProgress(p, '2026-02-01T00:00:00.000Z')).toBe(0);
    expect(periodProgress(p, '2026-04-01T00:00:00.000Z')).toBe(1);
    expect(daysRemaining(p, '2026-03-21T00:00:00.000Z')).toBe(10);
    expect(daysRemaining(p, '2026-04-10T00:00:00.000Z')).toBe(0);
  });

  it('offers a calendar month for a tenant with no anchor', () => {
    const p = calendarPeriod('2026-08-16T10:00:00.000Z');
    expect(p.start).toBe('2026-08-01T00:00:00.000Z');
    expect(p.end).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('rollup: counters accumulate, gauges carry forward', () => {
  const period = { start: '2026-03-01T00:00:00.000Z', end: '2026-04-01T00:00:00.000Z' };

  it('sums a counter over the period', () => {
    const snap = rollup({
      orgId: 'org_1',
      period,
      events: [
        ev('emails_sent', 100, '2026-03-02T00:00:00.000Z'),
        ev('emails_sent', 250, '2026-03-09T00:00:00.000Z'),
      ],
    });
    expect(snap.values.emails_sent).toBe(350);
  });

  it('resets a counter at the period boundary', () => {
    const events = [
      ev('emails_sent', 1000, '2026-02-15T00:00:00.000Z'),
      ev('emails_sent', 5, '2026-03-02T00:00:00.000Z'),
    ];
    expect(rollup({ orgId: 'org_1', period, events }).values.emails_sent).toBe(5);
  });

  it('does NOT sum a gauge like a counter across periods', () => {
    // The classic metering bug: a tenant who has held five mailboxes for three years has five.
    const snap = rollup({
      orgId: 'org_1',
      period,
      events: [],
      opening: { mailboxes: 5 },
    });
    expect(snap.values.mailboxes).toBe(5);
  });

  it('applies signed deltas to a gauge', () => {
    const snap = rollup({
      orgId: 'org_1',
      period,
      opening: { mailboxes: 5 },
      events: [
        ev('mailboxes', 2, '2026-03-03T00:00:00.000Z'),
        ev('mailboxes', -1, '2026-03-10T00:00:00.000Z'),
      ],
    });
    expect(snap.values.mailboxes).toBe(6);
    expect(snap.peaks.mailboxes).toBe(7);
  });

  it('ignores an opening value for a counter', () => {
    const snap = rollup({
      orgId: 'org_1', period, events: [], opening: { emails_sent: 900 } as any,
    });
    expect(snap.values.emails_sent).toBe(0);
  });

  it('clamps a gauge at zero when deltas drift negative', () => {
    const snap = rollup({
      orgId: 'org_1', period, opening: { mailboxes: 1 },
      events: [ev('mailboxes', -5, '2026-03-04T00:00:00.000Z')],
    });
    expect(snap.values.mailboxes).toBe(0);
  });

  it('lets a reconciler correct drift with a set event', () => {
    const snap = rollup({
      orgId: 'org_1', period, opening: { mailboxes: 99 },
      events: [
        ev('mailboxes', 1, '2026-03-04T00:00:00.000Z'),
        ev('mailboxes', 4, '2026-03-05T00:00:00.000Z', 'set'),
        ev('mailboxes', 1, '2026-03-06T00:00:00.000Z'),
      ],
    });
    expect(snap.values.mailboxes).toBe(5);
  });

  it('gives the same answer whatever order the events arrive in', () => {
    const events = [
      ev('emails_sent', 10, '2026-03-05T00:00:00.000Z'),
      ev('emails_sent', 20, '2026-03-02T00:00:00.000Z'),
      ev('emails_sent', 30, '2026-03-09T00:00:00.000Z'),
    ];
    const a = rollup({ orgId: 'org_1', period, events });
    const b = rollup({ orgId: 'org_1', period, events: [...events].reverse() });
    expect(a.values.emails_sent).toBe(b.values.emails_sent);
  });

  it('reports every metric, never undefined', () => {
    const snap = emptySnapshot('org_1', period);
    for (const v of Object.values(snap.values)) expect(typeof v).toBe('number');
  });

  it('hands the closing gauges to the next period', () => {
    const snap = rollup({ orgId: 'org_1', period, opening: { contacts: 40 }, events: [] });
    const closing = closingGauges(snap);
    expect(closing.contacts).toBe(40);
    expect(closing.emails_sent).toBeUndefined();
  });

  it('reads stored counters back into a snapshot', () => {
    const snap = snapshotFromCounters('org_1', period, [
      { orgId: 'org_1', metric: 'emails_sent', periodStart: period.start, value: 12, peak: 12, updatedAt: period.start },
    ]);
    expect(snap.values.emails_sent).toBe(12);
    expect(snap.values.api_calls).toBe(0);
  });
});

describe('idempotency keys', () => {
  it('identify the fact, and are stable across retries', () => {
    expect(usageKey('message.sent', 'msg_1')).toBe('message.sent:msg_1');
    expect(usageKey('message.sent', 'msg_1')).toBe(usageKey('message.sent', 'msg_1'));
  });

  it('skip empty parts rather than producing a ragged key', () => {
    expect(usageKey('a', null, undefined, '', 'b')).toBe('a:b');
  });
});

describe('threshold crossings fire once, on the transition', () => {
  it('fires when the line is crossed', () => {
    const c = crossedThresholds('emails_sent', 780, 810, 1000, [0.8, 0.95, 1]);
    expect(c).toHaveLength(1);
    expect(c[0].threshold).toBe(0.8);
  });

  it('does not fire again while sitting above the line', () => {
    expect(crossedThresholds('emails_sent', 810, 850, 1000, [0.8, 0.95, 1])).toHaveLength(0);
  });

  it('fires for every line a single jump passes', () => {
    const c = crossedThresholds('emails_sent', 100, 1200, 1000, [0.8, 0.95, 1]);
    expect(c.map((x) => x.threshold)).toEqual([0.8, 0.95, 1]);
  });

  it('never fires on an unlimited metric', () => {
    expect(crossedThresholds('emails_sent', 0, 1e9, null, [0.8])).toHaveLength(0);
  });

  it('sweeps a whole snapshot for a periodic check', () => {
    const period = { start: '2026-03-01T00:00:00.000Z', end: '2026-04-01T00:00:00.000Z' };
    const before = emptySnapshot('org_1', period);
    const after = rollup({ orgId: 'org_1', period, events: [ev('api_calls', 990, '2026-03-05T00:00:00.000Z')] });
    const crossings = allCrossings(before, after, (m) => (m === 'api_calls' ? 1000 : null), [0.95]);
    expect(crossings).toHaveLength(1);
    expect(crossings[0].metric).toBe('api_calls');
  });
});

describe('trends', () => {
  const period = { start: '2026-03-01T00:00:00.000Z', end: '2026-03-05T00:00:00.000Z' };

  it('sums a counter per day and emits zero for quiet days', () => {
    const series = dailySeries('emails_sent', [
      ev('emails_sent', 5, '2026-03-01T04:00:00.000Z'),
      ev('emails_sent', 7, '2026-03-01T18:00:00.000Z'),
      ev('emails_sent', 3, '2026-03-03T10:00:00.000Z'),
    ], period);
    expect(series.map((p) => p.value)).toEqual([12, 0, 3, 0]);
    expect(series[0].day).toBe('2026-03-01');
  });

  it('carries a gauge forward instead of summing it', () => {
    const series = dailySeries('mailboxes', [
      ev('mailboxes', 2, '2026-03-01T04:00:00.000Z'),
      ev('mailboxes', 1, '2026-03-03T10:00:00.000Z'),
    ], period, 3);
    expect(series.map((p) => p.value)).toEqual([5, 5, 6, 6]);
  });

  it('refuses to project from too little of the period', () => {
    const p = { start: '2026-03-01T00:00:00.000Z', end: '2026-04-01T00:00:00.000Z' };
    expect(projectedTotal(100, p, '2026-03-01T06:00:00.000Z')).toBeNull();
    expect(projectedTotal(100, p, '2026-03-16T00:00:00.000Z')).toBeGreaterThan(190);
  });
});
