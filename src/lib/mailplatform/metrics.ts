// src/lib/mailplatform/metrics.ts — the measurement primitives for EduRankAI Mail (Patch 8 §2, §11).
//
// PURE, AND DEPENDENCY-FREE ON PURPOSE. No database, no framework, no `process`. Everything here can
// be unit-tested without a connection, which matters because this is the layer that decides whether
// a scale claim is true; a measurement tool that can only be exercised against production is a
// measurement tool nobody runs.
//
// TWO WAYS TO GET A PERCENTILE, AND THEY ARE NOT INTERCHANGEABLE:
//
//   quantileExact(samples, p)   — every observation retained. The BENCHMARK path. Correct to the
//                                 sample; memory grows with N. Used by scripts/mail-bench.mjs, which
//                                 runs bounded and then exits.
//   histogramQuantile(h, p)     — bucket counts only. The LIVE path. Constant memory, and the answer
//                                 is an INTERPOLATION whose error is bounded by the width of the
//                                 bucket it lands in — never better than the bucket boundaries
//                                 allow. This is what Prometheus does, and it is why a p99 read off
//                                 a dashboard is not the same number as a p99 off a benchmark.
//
// A histogram quantile is returned WITH the bucket it fell in, so a reader can see the resolution
// they are actually getting instead of trusting three significant figures that were never measured.
//
// UNITS. Durations are recorded in MILLISECONDS, because that is the unit the brief asks for and the
// unit an operator reads. Prometheus exposition converts to SECONDS and suffixes `_seconds`, because
// base units are the ecosystem convention that every stock Grafana panel and alert expression
// assumes. The conversion happens once, at exposition, inside toPrometheus(); nothing else in this
// codebase should divide by 1000.

export type MetricKind = 'counter' | 'gauge' | 'histogram';
export type Unit = 'ms' | 'bytes' | 'count' | 'ratio';

export interface Labels { [key: string]: string | number | boolean | null | undefined }

// ---------------------------------------------------------------------------
// Label handling
// ---------------------------------------------------------------------------

/**
 * Prometheus label values are quoted strings; backslash, double-quote and newline must be escaped or
 * the exposition is unparseable. An unescaped quote in ONE label corrupts the entire scrape, not
 * just that line — which is how a single message subject in a label can blind a whole dashboard.
 */
export function escapeLabelValue(v: unknown): string {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/** Prometheus metric and label NAMES are `[a-zA-Z_][a-zA-Z0-9_]*`. Anything else is coerced, not rejected. */
export function sanitizeName(name: string): string {
  const s = String(name).replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[a-zA-Z_]/.test(s) ? s : '_' + s;
}

/**
 * Render a label set deterministically.
 *
 * SORTED BY KEY, and that is not cosmetic: the sorted rendering IS the series identity used by the
 * registry's map, so `{a,b}` and `{b,a}` must collapse to one series or the same counter increments
 * two rows that a dashboard then shows as two separate things.
 *
 * Null/undefined/empty values are DROPPED rather than rendered. An absent label and a label whose
 * value is the four characters `null` are different series in Prometheus, and code that passes
 * `campaignId` for campaign mail and nothing for transactional mail would otherwise create both.
 */
export function renderLabels(labels: Labels = {}): string {
  const keys = Object.keys(labels)
    .filter((k) => labels[k] !== null && labels[k] !== undefined && labels[k] !== '')
    .sort();
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => sanitizeName(k) + '="' + escapeLabelValue(labels[k]) + '"').join(',') + '}';
}

/** Stable series key: metric name plus rendered labels. */
export function seriesKey(name: string, labels: Labels = {}): string {
  return sanitizeName(name) + renderLabels(labels);
}

// ---------------------------------------------------------------------------
// Quantiles
// ---------------------------------------------------------------------------

/**
 * Exact quantile over raw samples, by LINEAR INTERPOLATION between the two neighbouring order
 * statistics (the "R-7" / `numpy.percentile` default).
 *
 * Not the nearest-rank method, deliberately: nearest-rank on a 20-sample benchmark reports p95 and
 * p99 as the SAME observation, which reads as "the tail is flat" when the truth is "you did not take
 * enough samples to see the tail". Interpolation at least moves when the distribution moves, and
 * `count` is reported alongside so a reader can judge whether p99 means anything at all.
 *
 * Input need not be sorted; it is copied, never sorted in place — callers reuse their arrays.
 */
export function quantileExact(samples: readonly number[], p: number): number | null {
  const xs = samples.filter((n) => typeof n === 'number' && Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const q = Math.min(1, Math.max(0, p));
  const pos = q * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

export interface Percentiles {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** The P50/P95/P99 triple the brief asks for, plus the context needed to judge it. */
export function summarize(samples: readonly number[]): Percentiles {
  const xs = samples.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (xs.length === 0) return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  let sum = 0;
  let min = xs[0];
  let max = xs[0];
  for (const x of xs) { sum += x; if (x < min) min = x; if (x > max) max = x; }
  return {
    count: xs.length,
    min,
    max,
    mean: sum / xs.length,
    p50: quantileExact(xs, 0.5),
    p95: quantileExact(xs, 0.95),
    p99: quantileExact(xs, 0.99),
  };
}

// ---------------------------------------------------------------------------
// Bucket sets
// ---------------------------------------------------------------------------

/**
 * Default duration buckets, in MILLISECONDS.
 *
 * Chosen against the operations actually being timed rather than copied from a template: a database
 * round trip over the Supabase transaction pooler is ~1–30ms, an API route ~20–300ms, an SMTP
 * connection plus handshake to a remote MX is 100ms–5s, and a deferral timeout is tens of seconds. A
 * bucket set that stops at 1s reports "everything is +Inf" for exactly the delivery attempts an
 * operator cares about, so this one runs to 60s.
 */
export const DURATION_BUCKETS_MS: readonly number[] = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
];

/** Queue and message AGES run far longer than request latencies — minutes and hours, not milliseconds. */
export const AGE_BUCKETS_MS: readonly number[] = [
  1000, 5000, 15000, 60000, 300000, 900000, 1800000, 3600000, 21600000, 86400000,
];

/** Batch and recipient SIZES: campaign generation and queue batching are counted, not timed. */
export const SIZE_BUCKETS: readonly number[] = [1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 100000, 1000000];

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export interface CounterSnapshot { kind: 'counter'; name: string; help: string; unit: Unit; series: { labels: Labels; value: number }[] }
export interface GaugeSnapshot { kind: 'gauge'; name: string; help: string; unit: Unit; series: { labels: Labels; value: number }[] }
export interface HistogramSeries {
  labels: Labels;
  /** Cumulative counts aligned with `bounds`, plus a final `+Inf` slot that equals `count`. */
  cumulative: number[];
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
}
export interface HistogramSnapshot {
  kind: 'histogram';
  name: string;
  help: string;
  unit: Unit;
  bounds: readonly number[];
  series: HistogramSeries[];
}
export type Snapshot = CounterSnapshot | GaugeSnapshot | HistogramSnapshot;

export class Counter {
  readonly kind = 'counter' as const;
  readonly unit: Unit = 'count';
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string) {}

  inc(labels: Labels = {}, by = 1): void {
    if (!Number.isFinite(by) || by < 0) return; // a counter that can go down is not a counter
    const key = seriesKey(this.name, labels);
    const cur = this.values.get(key);
    if (cur) cur.value += by;
    else this.values.set(key, { labels: { ...labels }, value: by });
  }
  get(labels: Labels = {}): number {
    return this.values.get(seriesKey(this.name, labels))?.value ?? 0;
  }
  reset(): void { this.values.clear(); }
  snapshot(): CounterSnapshot {
    return { kind: 'counter', name: this.name, help: this.help, unit: 'count', series: [...this.values.values()].map((s) => ({ labels: { ...s.labels }, value: s.value })) };
  }
}

export class Gauge {
  readonly kind = 'gauge' as const;
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string, readonly unit: Unit = 'count') {}

  set(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    this.values.set(seriesKey(this.name, labels), { labels: { ...labels }, value });
  }
  add(delta: number, labels: Labels = {}): void {
    const cur = this.values.get(seriesKey(this.name, labels));
    this.set((cur?.value ?? 0) + delta, labels);
  }
  get(labels: Labels = {}): number | null {
    const v = this.values.get(seriesKey(this.name, labels));
    return v ? v.value : null;
  }
  reset(): void { this.values.clear(); }
  snapshot(): GaugeSnapshot {
    return { kind: 'gauge', name: this.name, help: this.help, unit: this.unit, series: [...this.values.values()].map((s) => ({ labels: { ...s.labels }, value: s.value })) };
  }
}

/**
 * Fixed-bucket histogram. Constant memory per series regardless of how many observations arrive,
 * which is the only reason it is safe to leave running in a request path.
 */
export class Histogram {
  readonly kind = 'histogram' as const;
  readonly bounds: readonly number[];
  private readonly series = new Map<string, HistogramSeries>();

  constructor(readonly name: string, readonly help: string, bounds: readonly number[] = DURATION_BUCKETS_MS, readonly unit: Unit = 'ms') {
    // Sorted and deduped: an out-of-order bound silently breaks the cumulative invariant that every
    // quantile read afterwards depends on — and it breaks it QUIETLY, because the numbers still render.
    this.bounds = [...new Set(bounds)].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    const key = seriesKey(this.name, labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels: { ...labels }, cumulative: new Array(this.bounds.length + 1).fill(0), count: 0, sum: 0, min: null, max: null };
      this.series.set(key, s);
    }
    // Cumulative form: bucket i counts everything <= bounds[i]. The final slot is +Inf.
    for (let i = 0; i < this.bounds.length; i++) if (value <= this.bounds[i]) s.cumulative[i]++;
    s.cumulative[this.bounds.length]++;
    s.count++;
    s.sum += value;
    s.min = s.min === null ? value : Math.min(s.min, value);
    s.max = s.max === null ? value : Math.max(s.max, value);
  }

  seriesFor(labels: Labels = {}): HistogramSeries | null {
    return this.series.get(seriesKey(this.name, labels)) ?? null;
  }
  reset(): void { this.series.clear(); }
  snapshot(): HistogramSnapshot {
    return {
      kind: 'histogram', name: this.name, help: this.help, unit: this.unit, bounds: this.bounds,
      series: [...this.series.values()].map((s) => ({ labels: { ...s.labels }, cumulative: s.cumulative.slice(), count: s.count, sum: s.sum, min: s.min, max: s.max })),
    };
  }
}

export interface HistogramQuantile {
  value: number | null;
  /** The bucket the answer landed in — the true resolution of `value`. */
  bucket: { lower: number | null; upper: number | null } | null;
  /** True when the quantile fell in the open-ended +Inf bucket: `value` is then a LOWER BOUND only. */
  saturated: boolean;
  count: number;
}

/**
 * Prometheus-style `histogram_quantile`, with the honesty the real one lacks.
 *
 * Prometheus returns +Inf when the quantile lands in the overflow bucket and NaN when there are no
 * observations at all, and a Grafana panel renders BOTH as a blank cell — indistinguishable from
 * healthy. Here the caller gets `saturated` and `count`, so it can say "p99 exceeds 60s (top bucket
 * is open)" or "not measured", which are very different sentences.
 */
export function histogramQuantile(s: HistogramSeries | null, bounds: readonly number[], p: number): HistogramQuantile {
  if (!s || s.count === 0) return { value: null, bucket: null, saturated: false, count: 0 };
  const q = Math.min(1, Math.max(0, p));
  const rank = q * s.count;
  for (let i = 0; i < bounds.length; i++) {
    if (s.cumulative[i] >= rank) {
      const lower = i === 0 ? 0 : bounds[i - 1];
      const upper = bounds[i];
      const below = i === 0 ? 0 : s.cumulative[i - 1];
      const inBucket = s.cumulative[i] - below;
      // Observations are assumed evenly spread inside the bucket. That assumption is exactly why this
      // is an estimate; the bucket EDGES are the part that was actually measured.
      const value = inBucket <= 0 ? upper : lower + ((rank - below) / inBucket) * (upper - lower);
      return { value: Math.min(value, upper), bucket: { lower, upper }, saturated: false, count: s.count };
    }
  }
  const lastBound = bounds.length ? bounds[bounds.length - 1] : null;
  return { value: lastBound, bucket: { lower: lastBound, upper: null }, saturated: true, count: s.count };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * A registry of instruments.
 *
 * Deliberately NOT exported as a module-level singleton that anything may reach for: on serverless
 * this process may be recycled between any two requests, so an in-process registry is a per-instance,
 * since-last-cold-start view and nothing more. `getRegistry()` below owns the one process-wide
 * instance and stamps it with a start time, so the exposition endpoint can SAY that rather than let
 * a dashboard imply a continuity the runtime does not provide.
 */
export class MetricRegistry {
  private readonly instruments = new Map<string, Counter | Gauge | Histogram>();
  readonly createdAt: number = Date.now();

  counter(name: string, help: string): Counter {
    return this.getOrCreate(name, () => new Counter(sanitizeName(name), help)) as Counter;
  }
  gauge(name: string, help: string, unit: Unit = 'count'): Gauge {
    return this.getOrCreate(name, () => new Gauge(sanitizeName(name), help, unit)) as Gauge;
  }
  histogram(name: string, help: string, bounds: readonly number[] = DURATION_BUCKETS_MS, unit: Unit = 'ms'): Histogram {
    return this.getOrCreate(name, () => new Histogram(sanitizeName(name), help, bounds, unit)) as Histogram;
  }
  private getOrCreate(name: string, make: () => Counter | Gauge | Histogram) {
    const key = sanitizeName(name);
    let inst = this.instruments.get(key);
    if (!inst) { inst = make(); this.instruments.set(key, inst); }
    return inst;
  }
  has(name: string): boolean { return this.instruments.has(sanitizeName(name)); }
  names(): string[] { return [...this.instruments.keys()].sort(); }
  reset(): void { for (const i of this.instruments.values()) i.reset(); }
  snapshot(): Snapshot[] { return this.names().map((n) => this.instruments.get(n)!.snapshot()); }
}

/**
 * The process-wide registry.
 *
 * Parked on globalThis rather than in a module-level `const` because Astro/Vite can evaluate a module
 * more than once in the same process (dev HMR, and separate SSR entry chunks in the built output).
 * Two registries means half the observations land in a registry nothing ever scrapes — a metric that
 * reads LOW for a reason that has nothing to do with the system being measured, which is the worst
 * kind of wrong number.
 */
export function getRegistry(): MetricRegistry {
  const g = globalThis as unknown as { __eraMailMetrics?: MetricRegistry };
  if (!g.__eraMailMetrics) g.__eraMailMetrics = new MetricRegistry();
  return g.__eraMailMetrics;
}

// ---------------------------------------------------------------------------
// Prometheus text exposition (v0.0.4)
// ---------------------------------------------------------------------------

/** Metric names are prefixed once, here, so every series in this subsystem is greppable as one set. */
export const METRIC_PREFIX = 'edurankai_mail';

export function exposeName(name: string, unit: Unit): string {
  const base = name.startsWith(METRIC_PREFIX) ? name : METRIC_PREFIX + '_' + name;
  // `_seconds` because base units are what every stock alert expression assumes; the VALUES are
  // divided to match, below. Renaming without converting would be worse than doing neither.
  if (unit === 'ms') return base.replace(/_(ms|milliseconds)$/, '') + '_seconds';
  if (unit === 'bytes') return base.replace(/_bytes$/, '') + '_bytes';
  return base;
}

/** Prometheus wants `+Inf`, and finite numbers rendered without surprises. */
function num(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? '+Inf' : '-Inf';
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(12)));
}

/**
 * Render snapshots as Prometheus text exposition.
 *
 * `extraLabels` is how a multi-node deployment stays legible: every MTA node and every worker scrapes
 * with its own `node` / `worker_id` label, so the same series name coming from twelve machines
 * aggregates instead of colliding.
 */
export function toPrometheus(snapshots: Snapshot[], extraLabels: Labels = {}): string {
  const out: string[] = [];
  const merge = (l: Labels): Labels => ({ ...extraLabels, ...l });

  for (const s of snapshots) {
    const name = exposeName(s.name, s.unit);
    out.push('# HELP ' + name + ' ' + String(s.help).replace(/\n/g, ' '));
    out.push('# TYPE ' + name + ' ' + s.kind);

    if (s.kind === 'counter') {
      // A counter with no observations emits NOTHING rather than a fabricated 0 for a label set that
      // has never occurred. Absent and zero mean different things to a rate() query.
      for (const ser of s.series) out.push(name + renderLabels(merge(ser.labels)) + ' ' + num(ser.value));
    } else if (s.kind === 'gauge') {
      const scale = s.unit === 'ms' ? 1 / 1000 : 1;
      for (const ser of s.series) out.push(name + renderLabels(merge(ser.labels)) + ' ' + num(ser.value * scale));
    } else {
      const scale = s.unit === 'ms' ? 1 / 1000 : 1;
      for (const ser of s.series) {
        for (let i = 0; i < s.bounds.length; i++) {
          out.push(name + '_bucket' + renderLabels(merge({ ...ser.labels, le: num(s.bounds[i] * scale) })) + ' ' + num(ser.cumulative[i]));
        }
        out.push(name + '_bucket' + renderLabels(merge({ ...ser.labels, le: '+Inf' })) + ' ' + num(ser.count));
        out.push(name + '_sum' + renderLabels(merge(ser.labels)) + ' ' + num(ser.sum * scale));
        out.push(name + '_count' + renderLabels(merge(ser.labels)) + ' ' + num(ser.count));
      }
    }
  }
  return out.join('\n') + '\n';
}
