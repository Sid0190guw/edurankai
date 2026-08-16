// src/lib/mailplatform/capacity.ts — scale targets, and the rule that stops us claiming one
// (Patch 8 §1, §14, §15).
//
// THE BRIEF'S FIRST INSTRUCTION IS THE WHOLE DESIGN: "Do not claim that any target is achieved until
// it is benchmarked." So the type system makes the claim impossible to make by accident. There is no
// function here that returns a throughput number on its own. Every projection carries the
// `Measurement` it came from, and a tier's verdict can only be `sustained` if a real run actually
// held the required rate — `projected` is the best any amount of arithmetic can earn.
//
// WHAT A PROJECTION IS WORTH, STATED ONCE. Extrapolation from a measured rate assumes the system is
// LINEAR in the resource being added, and email pipelines are not: the queue is a Postgres table
// whose claim contention grows with worker count, connection pools have hard ceilings, and remote
// providers throttle by sender rather than by how many senders you run. A projection says "if
// nothing else becomes the bottleneck first, this many workers would be needed" — and the whole
// engineering question is which thing becomes the bottleneck first. bottleneckNotes() names the ones
// already known for this deployment, so the number is never read alone.
//
// TIERS ARE DAILY, WORKLOAD IS NOT. 100,000/day is 1.16/s averaged and perhaps 20/s at the peak of a
// campaign send window. Sizing to the average guarantees the queue backs up every day at the same
// hour. PEAK_FACTOR is applied and named rather than buried.

// ---------------------------------------------------------------------------
// Scale tiers
// ---------------------------------------------------------------------------

export interface ScaleTier {
  id: string;
  perDay: number;
  label: string;
}

/** The five targets named in §1, smallest first. */
export const SCALE_TIERS: readonly ScaleTier[] = [
  { id: 't1', perDay: 10_000, label: '10 thousand/day' },
  { id: 't2', perDay: 100_000, label: '100 thousand/day' },
  { id: 't3', perDay: 1_000_000, label: '1 million/day' },
  { id: 't4', perDay: 10_000_000, label: '10 million/day' },
  { id: 't5', perDay: 100_000_000, label: '100 million/day' },
];

/**
 * Ratio of peak send rate to daily average.
 *
 * 4× is the working assumption for a mixed transactional-plus-campaign workload: campaigns land in a
 * business-hours window, transactional mail follows product usage which is also business hours, and
 * the two peaks coincide. It is AN ASSUMPTION — this deployment has not yet run enough volume to
 * measure the real diurnal curve — and it is exported so a real one replaces it in one place. Under
 * a pure-campaign workload the true factor is far higher, because a campaign is a single burst.
 */
export const PEAK_FACTOR = 4;

export function perSecondAverage(perDay: number): number { return perDay / 86_400; }
export function perSecondPeak(perDay: number, peakFactor = PEAK_FACTOR): number { return perSecondAverage(perDay) * peakFactor; }

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

export type MeasurementSource = 'benchmark' | 'production' | 'none';

/**
 * A throughput number WITH its provenance.
 *
 * There is no bare `number` anywhere in this module's public surface for a reason: a throughput that
 * has lost track of where it came from is indistinguishable from one somebody typed, and the entire
 * point of this file is that those must never look alike.
 */
export interface Measurement {
  source: MeasurementSource;
  /** Sustained messages per second observed. Null when nothing has been measured. */
  messagesPerSec: number | null;
  /** How long the rate was HELD. A burst rate over 2 seconds is not a sustained rate. */
  durationSec: number | null;
  /** How many messages the run actually put through. */
  messagesTested: number | null;
  /** Worker concurrency in force during the run — the denominator for per-worker throughput. */
  concurrency: number | null;
  /** Fraction of attempts that failed, 0..1. A high rate invalidates the throughput above it. */
  failureRate: number | null;
  /** Where it was run. Never `production` for a load test — see loadgen.ts. */
  environment: string | null;
  at: string | null;
  notes?: string;
}

export const NO_MEASUREMENT: Measurement = {
  source: 'none', messagesPerSec: null, durationSec: null, messagesTested: null,
  concurrency: null, failureRate: null, environment: null, at: null,
  notes: 'No benchmark has been run against this deployment.',
};

/** Minimum evidence before a measurement may be used for anything at all. */
export const MIN_SUSTAIN_SECONDS = 60;
export const MIN_MESSAGES = 500;
export const MAX_ACCEPTABLE_FAILURE_RATE = 0.005;

export interface Validity { usable: boolean; reasons: string[] }

/**
 * Is this measurement strong enough to reason from?
 *
 * The thresholds exist because the ways a load test lies are well known and all of them produce a
 * FLATTERING number: a short run measures the queue absorbing a burst rather than the workers
 * draining it; a small run is dominated by warm caches and an empty table; and a run with a high
 * failure rate is measuring how fast the system can REJECT work, which is always faster than doing it.
 */
export function validate(m: Measurement): Validity {
  const reasons: string[] = [];
  if (m.source === 'none' || m.messagesPerSec === null) return { usable: false, reasons: ['no measurement recorded'] };
  if (m.messagesPerSec <= 0) reasons.push('measured rate is not positive');
  if ((m.durationSec ?? 0) < MIN_SUSTAIN_SECONDS) reasons.push('run held for ' + (m.durationSec ?? 0) + 's; a sustained rate needs at least ' + MIN_SUSTAIN_SECONDS + 's (a shorter run measures queue absorption, not drain)');
  if ((m.messagesTested ?? 0) < MIN_MESSAGES) reasons.push('only ' + (m.messagesTested ?? 0) + ' messages; at least ' + MIN_MESSAGES + ' are needed before caches and an empty table stop dominating');
  if (m.failureRate !== null && m.failureRate > MAX_ACCEPTABLE_FAILURE_RATE) reasons.push('failure rate ' + (m.failureRate * 100).toFixed(2) + '% exceeds ' + (MAX_ACCEPTABLE_FAILURE_RATE * 100).toFixed(2) + '%; throughput measured while failing is not throughput');
  return { usable: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type TierVerdict = 'sustained' | 'projected' | 'insufficient_evidence' | 'unmeasured';

export interface TierAssessment {
  tier: ScaleTier;
  requiredAvgPerSec: number;
  requiredPeakPerSec: number;
  verdict: TierVerdict;
  /** One sentence an engineer can put in front of a stakeholder without qualifying it further. */
  statement: string;
  /** Workers needed at the measured per-worker rate, to carry the PEAK. Null without a measurement. */
  workersForPeak: number | null;
  /** Multiple of the measured rate this tier demands. Null without a measurement. */
  headroomFactor: number | null;
}

/**
 * Assess one tier against one measurement.
 *
 * `sustained` requires that the measured rate ALREADY meets the peak requirement — not the average.
 * Meeting the average and calling the tier achieved is the standard way this claim goes wrong: the
 * system genuinely handles the daily total and falls over every day at 10am.
 */
export function assessTier(tier: ScaleTier, m: Measurement, peakFactor = PEAK_FACTOR): TierAssessment {
  const requiredAvg = perSecondAverage(tier.perDay);
  const requiredPeak = perSecondPeak(tier.perDay, peakFactor);
  const v = validate(m);

  if (m.source === 'none') {
    return { tier, requiredAvgPerSec: requiredAvg, requiredPeakPerSec: requiredPeak, verdict: 'unmeasured', statement: tier.label + ' needs ' + requiredPeak.toFixed(2) + ' msg/s at peak. Nothing has been benchmarked, so there is no basis for any claim.', workersForPeak: null, headroomFactor: null };
  }
  if (!v.usable) {
    return { tier, requiredAvgPerSec: requiredAvg, requiredPeakPerSec: requiredPeak, verdict: 'insufficient_evidence', statement: tier.label + ' cannot be assessed: ' + v.reasons.join('; ') + '.', workersForPeak: null, headroomFactor: null };
  }

  const rate = m.messagesPerSec as number;
  const perWorker = m.concurrency && m.concurrency > 0 ? rate / m.concurrency : null;
  const workersForPeak = perWorker && perWorker > 0 ? Math.ceil(requiredPeak / perWorker) : null;
  const headroom = rate / requiredPeak;

  if (rate >= requiredPeak) {
    return {
      tier, requiredAvgPerSec: requiredAvg, requiredPeakPerSec: requiredPeak, verdict: 'sustained',
      statement: tier.label + ' is SUSTAINED: a measured ' + rate.toFixed(2) + ' msg/s held for ' + m.durationSec + 's exceeds the ' + requiredPeak.toFixed(2) + ' msg/s peak requirement (' + headroom.toFixed(1) + '× headroom).',
      workersForPeak, headroomFactor: headroom,
    };
  }
  return {
    tier, requiredAvgPerSec: requiredAvg, requiredPeakPerSec: requiredPeak, verdict: 'projected',
    statement: tier.label + ' is NOT demonstrated. Measured ' + rate.toFixed(2) + ' msg/s; the peak requirement is ' + requiredPeak.toFixed(2) + ' msg/s, i.e. ' + (requiredPeak / rate).toFixed(1) + '× more than has been observed'
      + (workersForPeak !== null ? '. At the measured per-worker rate that is ' + workersForPeak + ' workers, IF the system scales linearly — which it does not, see bottleneckNotes().' : '.'),
    workersForPeak, headroomFactor: headroom,
  };
}

export function assessAll(m: Measurement, peakFactor = PEAK_FACTOR): TierAssessment[] {
  return SCALE_TIERS.map((t) => assessTier(t, m, peakFactor));
}

/** The highest tier actually demonstrated. Null when none is — which is the honest default. */
export function highestSustained(m: Measurement, peakFactor = PEAK_FACTOR): ScaleTier | null {
  const sustained = assessAll(m, peakFactor).filter((a) => a.verdict === 'sustained');
  return sustained.length ? sustained[sustained.length - 1].tier : null;
}

// ---------------------------------------------------------------------------
// Derived resource requirements
// ---------------------------------------------------------------------------

export interface ResourceModel {
  /** Bytes stored per message: row plus bodies plus recipient rows. Measured, or estimated and said so. */
  bytesPerMessage: number;
  /** Rows written to the event store per message across its lifecycle. */
  eventsPerMessage: number;
  /** Database statements per message on the send path. */
  dbStatementsPerMessage: number;
  /** Connections one worker holds. On a transaction pooler this is 1 per in-flight statement. */
  connectionsPerWorker: number;
  source: 'measured' | 'estimated';
  notes: string;
}

/**
 * Starting model, EXPLICITLY estimated.
 *
 * `source: 'estimated'` is carried through into the report so no consumer can mistake it for
 * measurement. The estimates come from the shape of the schema this repository already has —
 * mail_messages plus mail_recipients plus a delivery event or two — not from a vendor's marketing
 * page. scripts/mail-bench.mjs replaces them with `measured` values when run with --measure-storage.
 */
export const ESTIMATED_RESOURCES: ResourceModel = {
  bytesPerMessage: 24 * 1024,
  eventsPerMessage: 4,
  dbStatementsPerMessage: 6,
  connectionsPerWorker: 1,
  source: 'estimated',
  notes: 'Estimated from the existing mail_messages/mail_recipients/email_logs row shapes at a ~16KB average body. Not measured. Re-derive with a benchmark before sizing storage from it.',
};

export interface TierResources {
  tier: ScaleTier;
  storagePerDayBytes: number;
  storagePerYearBytes: number;
  eventsPerDay: number;
  eventsPerSecPeak: number;
  dbStatementsPerSecPeak: number;
  /** Null when no measurement supports a worker count. */
  workers: number | null;
  connections: number | null;
  source: 'measured' | 'estimated';
}

export function resourcesFor(tier: ScaleTier, m: Measurement, model: ResourceModel = ESTIMATED_RESOURCES, peakFactor = PEAK_FACTOR): TierResources {
  const peak = perSecondPeak(tier.perDay, peakFactor);
  const a = assessTier(tier, m, peakFactor);
  const workers = a.workersForPeak;
  return {
    tier,
    storagePerDayBytes: tier.perDay * model.bytesPerMessage,
    storagePerYearBytes: tier.perDay * model.bytesPerMessage * 365,
    eventsPerDay: tier.perDay * model.eventsPerMessage,
    eventsPerSecPeak: peak * model.eventsPerMessage,
    dbStatementsPerSecPeak: peak * model.dbStatementsPerMessage,
    workers,
    connections: workers === null ? null : workers * model.connectionsPerWorker,
    source: model.source,
  };
}

/** Human bytes. Binary units, because that is what a disk and a Postgres table report. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? Math.round(v) : Number(v.toFixed(1))) + ' ' + units[i];
}

// ---------------------------------------------------------------------------
// Bottlenecks
// ---------------------------------------------------------------------------

export interface Bottleneck {
  /** Tier at which this is expected to bind, by id. */
  bindsAt: string;
  component: string;
  limit: string;
  consequence: string;
  remedy: string;
}

/**
 * The things that break BEFORE the arithmetic says they should, on THIS deployment.
 *
 * Every entry names a constraint that is real and already present in this repository, not a generic
 * scaling caution. A projection printed without these is the kind of number that gets committed to
 * in a meeting.
 */
export function bottleneckNotes(): Bottleneck[] {
  return [
    {
      bindsAt: 't1',
      component: 'Vercel cron (worker trigger)',
      limit: 'The Hobby plan runs cron DAILY. /api/jobs/run drains a bounded batch per invocation.',
      consequence: 'Queue latency is measured in HOURS regardless of how fast a worker is, because nothing invokes it. This binds at the very first tier and it is a plan setting, not a code limit.',
      remedy: 'Paid plan for minute-level cron, or an external scheduler / long-lived worker process hitting /api/jobs/run.',
    },
    {
      bindsAt: 't2',
      component: 'Serverless function wall time',
      limit: 'A request-scoped worker must finish inside the platform timeout (tens of seconds).',
      consequence: 'Batch size is capped by wall time rather than by throughput, and a long batch is killed mid-flight — which is exactly the stalled-processing gap queue-observability.ts alerts on.',
      remedy: 'Move workers to a long-lived process (the single dedicated server stage in docs/mail-server-plan.md).',
    },
    {
      bindsAt: 't2',
      component: 'Postgres queue claim contention',
      limit: 'edu_jobs uses FOR UPDATE SKIP LOCKED, which is correct and still serialises on the same hot rows as workers multiply.',
      consequence: 'Adding workers stops adding throughput at some concurrency; the extra workers spend their time contending. The knee has to be MEASURED, it cannot be derived.',
      remedy: 'Benchmark claim rate against worker count and find the knee. Beyond it, partition by kind or move to a broker — the queue is reliable, it is not a broker.',
    },
    {
      bindsAt: 't3',
      component: 'Connection pooler',
      limit: 'Supabase transaction pooler (:6543) has a fixed connection ceiling shared by the whole application.',
      consequence: 'Workers and web requests compete for the same pool. Saturation shows up first as latency on unrelated pages, then as connection errors sitewide — this project has already had whole-site outages from database exhaustion.',
      remedy: 'Separate pool/credentials for workers, read replicas for analytics, and batch inserts so statements per message falls.',
    },
    {
      bindsAt: 't3',
      component: 'Event storage in Postgres',
      limit: 'At 1M messages/day the event table takes on the order of 4M rows/day at the modelled 4 events per message.',
      consequence: 'Analytics queries begin to compete with the send path on the same instance — the thing §6 exists to prevent.',
      remedy: 'Time-partition the event table, then move analytics to ClickHouse. events.ts is already shaped for the copy.',
    },
    {
      bindsAt: 't4',
      component: 'Sending IP reputation',
      limit: 'Not a capacity limit. Large mailbox providers throttle per sending IP by reputation, and a new IP is throttled hardest.',
      consequence: 'Adding MTA nodes does not multiply accepted mail. Sending faster than reputation allows produces deferrals and then blocks, which take weeks to undo.',
      remedy: 'Warm IP pools gradually, separate transactional and marketing streams (mta-pool.ts already models both), and drive throttles from measured deferral rates.',
    },
    {
      bindsAt: 't5',
      component: 'Single-region architecture',
      limit: '100M/day is ~4,600 msg/s peak at the modelled factor, sustained.',
      consequence: 'This is a different system: multi-region MTA clusters, a real broker, a column store, and a dedicated deliverability function. Nothing in this repository is evidence about it.',
      remedy: 'See docs/mail-server-plan.md. Do not project to this tier from a laptop benchmark.',
    },
  ];
}

// ---------------------------------------------------------------------------
// The capacity report (§15)
// ---------------------------------------------------------------------------

export interface BenchConfiguration {
  cpu: string | null;
  ramGB: number | null;
  storage: string | null;
  workers: number | null;
  concurrency: number | null;
  environment: string | null;
  target: string | null;
  nodeVersion?: string | null;
}

export interface LatencySummary {
  operation: string;
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  unit: 'ms';
}

export interface CapacityReport {
  schema: 'edurankai.mail.capacity/1';
  generatedAt: string;
  configuration: BenchConfiguration;
  measurement: Measurement;
  validity: Validity;
  throughput: { messagesPerSec: number | null; messagesPerMin: number | null; messagesPerDayEquivalent: number | null };
  latency: LatencySummary[];
  queueLatencyMs: LatencySummary | null;
  databaseLatencyMs: LatencySummary | null;
  failureRate: number | null;
  tiers: TierAssessment[];
  resources: TierResources[];
  bottlenecks: Bottleneck[];
  /** Everything the run did NOT establish. Never empty in practice; a report without it is a sales document. */
  caveats: string[];
}

/**
 * Assemble the machine-readable report §15 asks for.
 *
 * IT FABRICATES NOTHING. Every field is either copied from the measurement, derived from it with the
 * derivation stated, or null. A report generated with NO_MEASUREMENT is a valid, useful artifact: it
 * says, in a fixed schema, that nothing is known — which is the true state until somebody runs the
 * benchmark.
 */
export function buildCapacityReport(input: {
  configuration: BenchConfiguration;
  measurement: Measurement;
  latency?: LatencySummary[];
  queueLatency?: LatencySummary | null;
  databaseLatency?: LatencySummary | null;
  resourceModel?: ResourceModel;
  peakFactor?: number;
  generatedAt?: string;
}): CapacityReport {
  const m = input.measurement;
  const peakFactor = input.peakFactor ?? PEAK_FACTOR;
  const model = input.resourceModel ?? ESTIMATED_RESOURCES;
  const v = validate(m);
  const rate = v.usable ? (m.messagesPerSec as number) : null;

  const caveats: string[] = [];
  if (!v.usable) caveats.push('The measurement does not meet the minimum evidence bar: ' + v.reasons.join('; ') + '.');
  if (model.source === 'estimated') caveats.push('Storage and event volumes use ESTIMATED per-message costs (' + model.notes + ').');
  caveats.push('Peak sizing uses a peak-to-average factor of ' + peakFactor + '×, which is an assumption and not a measured diurnal curve for this deployment.');
  caveats.push('Tier projections assume linear scaling in workers. bottlenecks[] lists the constraints expected to bind first; each one invalidates linearity from the tier named.');
  if (m.environment && /prod/i.test(m.environment)) caveats.push('This run reports a production-like environment. Load generation must never target production or public recipients — see loadgen.ts.');
  if (rate !== null) caveats.push('messagesPerDayEquivalent is the measured rate held for 24h at peak-equivalent load. It is NOT a demonstrated daily volume: nothing here ran for 24 hours.');

  return {
    schema: 'edurankai.mail.capacity/1',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    configuration: input.configuration,
    measurement: m,
    validity: v,
    throughput: {
      messagesPerSec: rate,
      messagesPerMin: rate === null ? null : rate * 60,
      // Divided by the peak factor deliberately: a system holding R msg/s at PEAK carries
      // R*86400/peakFactor per day, not R*86400. The larger number is the one everybody quotes.
      messagesPerDayEquivalent: rate === null ? null : Math.floor((rate * 86_400) / peakFactor),
    },
    latency: input.latency ?? [],
    queueLatencyMs: input.queueLatency ?? null,
    databaseLatencyMs: input.databaseLatency ?? null,
    failureRate: m.failureRate,
    tiers: assessAll(m, peakFactor),
    resources: SCALE_TIERS.map((t) => resourcesFor(t, m, model, peakFactor)),
    bottlenecks: bottleneckNotes(),
    caveats,
  };
}

/** One-line summary for a screen or a commit message. Deliberately blunt. */
export function headline(report: CapacityReport): string {
  const sustained = report.tiers.filter((t) => t.verdict === 'sustained');
  if (!sustained.length) {
    return report.measurement.source === 'none'
      ? 'No benchmark has been run. No scale target is demonstrated.'
      : 'Measured ' + (report.throughput.messagesPerSec?.toFixed(2) ?? 'n/a') + ' msg/s. No scale target is demonstrated at peak.';
  }
  const top = sustained[sustained.length - 1];
  return 'Demonstrated up to ' + top.tier.label + ' at ' + (report.throughput.messagesPerSec?.toFixed(2) ?? 'n/a') + ' msg/s sustained. Higher tiers are projections only.';
}
