// Tests for the capacity model and the queue alert rules.
//
// The capacity tests are mostly tests of REFUSAL: the module's job is to not produce a number it
// cannot justify, and that behaviour needs assertions more than the arithmetic does.
import { describe, it, expect } from 'vitest';
import {
  SCALE_TIERS, PEAK_FACTOR, perSecondAverage, perSecondPeak,
  NO_MEASUREMENT, validate, assessTier, assessAll, highestSustained,
  resourcesFor, buildCapacityReport, headline, bottleneckNotes, formatBytes,
  ESTIMATED_RESOURCES, type Measurement,
} from './capacity';
import {
  evaluateQueueAlerts, unreadableSnapshot, DEFAULT_QUEUE_THRESHOLDS, formatAge,
  type QueueSnapshot,
} from './queue-observability';

function goodMeasurement(over: Partial<Measurement> = {}): Measurement {
  return {
    source: 'benchmark', messagesPerSec: 50, durationSec: 120, messagesTested: 6000,
    concurrency: 4, failureRate: 0.001, environment: 'staging', at: '2026-08-16T00:00:00.000Z', ...over,
  };
}

describe('tier arithmetic', () => {
  it('names the five targets from the brief', () => {
    expect(SCALE_TIERS.map((t) => t.perDay)).toEqual([10_000, 100_000, 1_000_000, 10_000_000, 100_000_000]);
  });

  it('sizes for the peak, not the daily average', () => {
    expect(perSecondAverage(86_400)).toBe(1);
    expect(perSecondPeak(86_400)).toBe(PEAK_FACTOR);
  });
});

describe('measurement validation', () => {
  it('rejects a run too short to be a sustained rate', () => {
    const v = validate(goodMeasurement({ durationSec: 5 }));
    expect(v.usable).toBe(false);
    expect(v.reasons.join(' ')).toContain('queue absorption');
  });

  it('rejects a run too small to have escaped warm caches', () => {
    expect(validate(goodMeasurement({ messagesTested: 20 })).usable).toBe(false);
  });

  it('rejects throughput measured while failing', () => {
    const v = validate(goodMeasurement({ failureRate: 0.4 }));
    expect(v.usable).toBe(false);
    expect(v.reasons.join(' ')).toContain('not throughput');
  });

  it('rejects the absence of a measurement outright', () => {
    expect(validate(NO_MEASUREMENT).usable).toBe(false);
  });

  it('accepts a run that clears every bar', () => {
    expect(validate(goodMeasurement()).usable).toBe(true);
  });
});

describe('tier verdicts', () => {
  it('claims nothing at all with no measurement', () => {
    const all = assessAll(NO_MEASUREMENT);
    expect(all.every((a) => a.verdict === 'unmeasured')).toBe(true);
    expect(all.every((a) => a.workersForPeak === null)).toBe(true);
    expect(highestSustained(NO_MEASUREMENT)).toBeNull();
  });

  it('will not claim a tier from a run that does not meet the evidence bar', () => {
    const weak = goodMeasurement({ messagesPerSec: 99_999, durationSec: 2, messagesTested: 30 });
    // A colossal rate that was held for two seconds proves nothing, and must not be laundered
    // into a tier claim by the arithmetic.
    expect(assessAll(weak).every((a) => a.verdict === 'insufficient_evidence')).toBe(true);
  });

  it('sustains a tier only when the measured rate clears the PEAK requirement', () => {
    // 10k/day = 0.116/s average, 0.463/s peak. A measured 50/s clears it comfortably.
    const a = assessTier(SCALE_TIERS[0], goodMeasurement());
    expect(a.verdict).toBe('sustained');
    expect(a.statement).toContain('SUSTAINED');

    // 1M/day = 46.3/s peak. Measured 50/s clears that too...
    expect(assessTier(SCALE_TIERS[2], goodMeasurement()).verdict).toBe('sustained');
    // ...but 10M/day = 463/s peak does not.
    const t4 = assessTier(SCALE_TIERS[3], goodMeasurement());
    expect(t4.verdict).toBe('projected');
    expect(t4.statement).toContain('NOT demonstrated');
  });

  it('meeting the daily AVERAGE is not enough to claim a tier', () => {
    // 1M/day is 11.57/s average and 46.3/s peak. A system holding exactly the average would carry
    // the daily total and collapse every day at the peak — the classic false claim.
    const avgOnly = goodMeasurement({ messagesPerSec: 11.6 });
    expect(assessTier(SCALE_TIERS[2], avgOnly).verdict).toBe('projected');
  });

  it('states the multiple still needed, and names the linearity assumption', () => {
    const a = assessTier(SCALE_TIERS[4], goodMeasurement());
    expect(a.statement).toMatch(/×? ?more than has been observed/);
    expect(a.statement).toContain('does not');   // "IF the system scales linearly — which it does not"
  });

  it('derives workers from the measured per-worker rate', () => {
    // 50/s over concurrency 4 = 12.5/s per worker. 10M/day peak is 463/s => 38 workers.
    const a = assessTier(SCALE_TIERS[3], goodMeasurement());
    expect(a.workersForPeak).toBe(Math.ceil(perSecondPeak(10_000_000) / 12.5));
  });

  it('reports no worker count when concurrency was not recorded', () => {
    expect(assessTier(SCALE_TIERS[3], goodMeasurement({ concurrency: null })).workersForPeak).toBeNull();
  });
});

describe('resources', () => {
  it('carries the estimated/measured provenance through', () => {
    const r = resourcesFor(SCALE_TIERS[2], goodMeasurement(), ESTIMATED_RESOURCES);
    expect(r.source).toBe('estimated');
    expect(r.eventsPerDay).toBe(1_000_000 * ESTIMATED_RESOURCES.eventsPerMessage);
  });

  it('formats bytes in binary units', () => {
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('unknown');
  });
});

describe('capacity report', () => {
  it('is a valid, useful artifact with no measurement at all', () => {
    const r = buildCapacityReport({ configuration: { cpu: null, ramGB: null, storage: null, workers: null, concurrency: null, environment: null, target: null }, measurement: NO_MEASUREMENT });
    expect(r.schema).toBe('edurankai.mail.capacity/1');
    expect(r.throughput.messagesPerSec).toBeNull();
    expect(r.tiers.every((t) => t.verdict === 'unmeasured')).toBe(true);
    expect(headline(r)).toContain('No benchmark has been run');
  });

  it('never leaves the caveats empty', () => {
    const r = buildCapacityReport({ configuration: { cpu: 'x', ramGB: 8, storage: 'ssd', workers: 4, concurrency: 4, environment: 'staging', target: 'http://localhost' }, measurement: goodMeasurement() });
    expect(r.caveats.length).toBeGreaterThan(0);
    expect(r.caveats.join(' ')).toContain('peak-to-average');
    expect(r.caveats.join(' ')).toContain('linear');
  });

  it('divides the daily equivalent by the peak factor rather than quoting the flattering number', () => {
    const r = buildCapacityReport({ configuration: { cpu: null, ramGB: null, storage: null, workers: null, concurrency: null, environment: null, target: null }, measurement: goodMeasurement({ messagesPerSec: 100 }) });
    expect(r.throughput.messagesPerDayEquivalent).toBe(Math.floor((100 * 86_400) / PEAK_FACTOR));
  });

  it('warns when a run reports a production-like environment', () => {
    const r = buildCapacityReport({ configuration: { cpu: null, ramGB: null, storage: null, workers: null, concurrency: null, environment: 'production', target: null }, measurement: goodMeasurement({ environment: 'production' }) });
    expect(r.caveats.join(' ')).toContain('never target production');
  });

  it('always ships the bottleneck list', () => {
    const r = buildCapacityReport({ configuration: { cpu: null, ramGB: null, storage: null, workers: null, concurrency: null, environment: null, target: null }, measurement: goodMeasurement() });
    expect(r.bottlenecks.length).toBe(bottleneckNotes().length);
    expect(r.bottlenecks[0].bindsAt).toBe('t1');   // the cron limit binds at the very first tier
  });

  it('headline stays honest when nothing was demonstrated at peak', () => {
    const r = buildCapacityReport({ configuration: { cpu: null, ramGB: null, storage: null, workers: null, concurrency: null, environment: null, target: null }, measurement: goodMeasurement({ messagesPerSec: 0.01, messagesTested: 600, durationSec: 60_000 }) });
    expect(headline(r)).toContain('No scale target is demonstrated');
  });
});

// ---------------------------------------------------------------------------

function snap(over: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    at: '2026-08-16T00:00:00.000Z',
    windowSeconds: 300,
    depth: { pending: 0, processing: 0, failed: 0, done: 100 },
    rates: { enqueuePerSec: 1, dequeuePerSec: 1, processedPerSec: 1, failedPerSec: 0, retriedPerSec: 0, windowSeconds: 300 },
    oldestPendingAgeMs: null,
    oldestProcessingAgeMs: null,
    deadLetterCount: 0,
    byKind: [],
    read: { depth: true, rates: true, ages: true, byKind: true },
    errors: [],
    ...over,
  };
}

describe('queue alerts', () => {
  it('a healthy queue produces no alerts', () => {
    expect(evaluateQueueAlerts(snap())).toHaveLength(0);
  });

  it('an UNREADABLE queue is an incident, not a quiet period', () => {
    // The failure mode CLAUDE.md names: a confident 0 because the COUNT threw.
    const alerts = evaluateQueueAlerts(unreadableSnapshot('pooler timeout'));
    expect(alerts[0].id).toBe('queue_unreadable');
    expect(alerts[0].severity).toBe('critical');
    expect(alerts[0].detail).toContain('pooler timeout');
  });

  it('fires worker_failure when work is waiting and nothing completes', () => {
    const alerts = evaluateQueueAlerts(snap({
      depth: { pending: 500, processing: 0, failed: 0, done: 0 },
      rates: { enqueuePerSec: 1, dequeuePerSec: 0, processedPerSec: 0, failedPerSec: 0, retriedPerSec: 0, windowSeconds: 300 },
    }));
    expect(alerts.map((a) => a.id)).toContain('worker_failure');
  });

  it('does NOT fire worker_failure on an idle but empty queue', () => {
    const alerts = evaluateQueueAlerts(snap({
      depth: { pending: 0, processing: 0, failed: 0, done: 0 },
      rates: { enqueuePerSec: 0, dequeuePerSec: 0, processedPerSec: 0, failedPerSec: 0, retriedPerSec: 0, windowSeconds: 300 },
    }));
    expect(alerts.map((a) => a.id)).not.toContain('worker_failure');
  });

  it('detects growth from the rate comparison even at a shallow depth', () => {
    const alerts = evaluateQueueAlerts(snap({
      depth: { pending: 50, processing: 0, failed: 0, done: 10 },
      rates: { enqueuePerSec: 10, dequeuePerSec: 2, processedPerSec: 2, failedPerSec: 0, retriedPerSec: 0, windowSeconds: 300 },
    }));
    const growth = alerts.find((a) => a.id === 'queue_growth');
    expect(growth).toBeTruthy();
    expect(growth!.value).toBeCloseTo(8);
  });

  it('detects the crashed-worker gap: rows stuck in processing forever', () => {
    const alerts = evaluateQueueAlerts(snap({ oldestProcessingAgeMs: 60 * 60 * 1000 }));
    const stalled = alerts.find((a) => a.id === 'stalled_messages');
    expect(stalled).toBeTruthy();
    expect(stalled!.detail).toContain('Nothing reclaims these');
    expect(stalled!.action).toContain('Reclaim stalled');
  });

  it('treats a retry storm as a RATIO, not a raw count', () => {
    const quiet = evaluateQueueAlerts(snap({
      rates: { enqueuePerSec: 100, dequeuePerSec: 100, processedPerSec: 100, failedPerSec: 0, retriedPerSec: 2, windowSeconds: 300 },
    }));
    expect(quiet.map((a) => a.id)).not.toContain('retry_storm');

    const storm = evaluateQueueAlerts(snap({
      rates: { enqueuePerSec: 5, dequeuePerSec: 5, processedPerSec: 1, failedPerSec: 0, retriedPerSec: 4, windowSeconds: 300 },
    }));
    expect(storm.map((a) => a.id)).toContain('retry_storm');
  });

  it('warns on a stale head even when depth is small', () => {
    const alerts = evaluateQueueAlerts(snap({
      depth: { pending: 3, processing: 0, failed: 0, done: 500 },
      oldestPendingAgeMs: 45 * 60 * 1000,
    }));
    expect(alerts.map((a) => a.id)).toContain('queue_age_critical');
  });

  it('warns about dead letters and about the danger of bulk-requeueing them', () => {
    const alerts = evaluateQueueAlerts(snap({
      depth: { pending: 0, processing: 0, failed: 99, done: 10 },
      deadLetterCount: 99,
    }));
    const dl = alerts.find((a) => a.id === 'dead_letters');
    expect(dl!.action).toContain('poison job');
  });

  it('sorts critical before warning', () => {
    const alerts = evaluateQueueAlerts(snap({
      depth: { pending: 20_000, processing: 0, failed: 50, done: 0 },
      rates: { enqueuePerSec: 10, dequeuePerSec: 0, processedPerSec: 0, failedPerSec: 0, retriedPerSec: 0, windowSeconds: 300 },
      deadLetterCount: 50,
      oldestPendingAgeMs: 60 * 60 * 1000,
    }));
    const severities = alerts.map((a) => a.severity);
    expect(severities.indexOf('warning')).toBeGreaterThan(severities.lastIndexOf('critical'));
  });

  it('every alert carries an action', () => {
    const alerts = evaluateQueueAlerts(snap({
      depth: { pending: 20_000, processing: 0, failed: 50, done: 0 },
      rates: { enqueuePerSec: 10, dequeuePerSec: 0, processedPerSec: 0, failedPerSec: 0, retriedPerSec: 5, windowSeconds: 300 },
      oldestPendingAgeMs: 60 * 60 * 1000,
      oldestProcessingAgeMs: 60 * 60 * 1000,
      deadLetterCount: 50,
    }), DEFAULT_QUEUE_THRESHOLDS);
    expect(alerts.length).toBeGreaterThan(3);
    expect(alerts.every((a) => a.action && a.action.length > 10)).toBe(true);
  });
});

describe('formatAge', () => {
  it('is coarse on purpose and says "unknown" rather than "0" for null', () => {
    expect(formatAge(null)).toBe('unknown');
    expect(formatAge(45_000)).toBe('45s');
    expect(formatAge(90 * 60 * 1000)).toBe('1h');
    expect(formatAge(72 * 3600 * 1000)).toBe('3d');
  });
});

// ---------------------------------------------------------------------------
// Regression: the anti-fabrication boundary (found by adversarial review)
// ---------------------------------------------------------------------------

describe('anti-fabrication — recompute, do not compare', () => {
  // /api/admin/mail/bench-report used to re-derive only the tier VERDICTS and compare them, storing
  // the rest of the payload verbatim. These tests pin the property that made that insufficient, and
  // the property the fix relies on: every displayed number is a deterministic function of the
  // measurement, so the server can rebuild it and never has to trust the poster.

  it('every derived field is reproducible from the measurement alone', () => {
    const m = goodMeasurement({ messagesPerSec: 100 });
    const cfg = { cpu: null, ramGB: null, storage: null, workers: null, concurrency: 8, environment: 'staging', target: null };
    const a = buildCapacityReport({ configuration: cfg, measurement: m, generatedAt: '2026-08-16T00:00:00.000Z' });
    const b = buildCapacityReport({ configuration: cfg, measurement: m, generatedAt: '2026-08-16T00:00:00.000Z' });
    // Byte-identical for identical inputs — this is what lets the route discard the posted copy.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('the attack the review found: honest verdicts beside a fabricated rate', () => {
    // Post a real 100 msg/s measurement with its HONEST verdicts (so a verdict-only check passes),
    // but inflate throughput 50x. headline() reads throughput, not the verdicts.
    const m = goodMeasurement({ messagesPerSec: 100 });
    const honest = buildCapacityReport({ configuration: { cpu: null, ramGB: null, storage: null, workers: null, concurrency: 8, environment: 'staging', target: null }, measurement: m });
    const forged = { ...honest, throughput: { messagesPerSec: 5000, messagesPerMin: 300000, messagesPerDayEquivalent: 108000000 } };

    // A verdict-only check cannot tell these apart: the verdicts are identical.
    expect(forged.tiers.map((t) => t.verdict)).toEqual(honest.tiers.map((t) => t.verdict));
    // But the headline — the bold line on the capacity card — reports the forged rate.
    expect(headline(forged as typeof honest)).toContain('5000.00 msg/s');
    // Recomputing from the measurement is what defeats it, and it is the same measurement.
    expect(headline(buildCapacityReport({ configuration: honest.configuration, measurement: forged.measurement })))
      .toContain('100.00 msg/s');
  });

  it('the trivial bypass: NO_MEASUREMENT makes a verdict-only check free to satisfy', () => {
    // Five 'unmeasured' verdicts are trivially copied, leaving every displayed number unchecked.
    const all = assessAll(NO_MEASUREMENT);
    expect(all.every((t) => t.verdict === 'unmeasured')).toBe(true);
    // Recomputing forces the rate back to null no matter what was posted alongside it.
    const rebuilt = buildCapacityReport({ configuration: { cpu: null, ramGB: null, storage: null, workers: null, concurrency: null, environment: null, target: null }, measurement: NO_MEASUREMENT });
    expect(rebuilt.throughput.messagesPerSec).toBeNull();
    expect(headline(rebuilt)).toContain('No benchmark has been run');
  });

  it('a posted generatedAt is the only client field the rebuild preserves', () => {
    const r = buildCapacityReport({ configuration: { cpu: null, ramGB: null, storage: null, workers: null, concurrency: null, environment: null, target: null }, measurement: goodMeasurement(), generatedAt: '2020-01-01T00:00:00.000Z' });
    expect(r.generatedAt).toBe('2020-01-01T00:00:00.000Z');
  });
});
