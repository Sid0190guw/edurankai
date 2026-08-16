// Tests for the measurement primitives. Every one of these runs without a database, which is the
// property that makes them worth having.
import { describe, it, expect } from 'vitest';
import {
  escapeLabelValue, sanitizeName, renderLabels, seriesKey,
  quantileExact, summarize, histogramQuantile,
  Counter, Gauge, Histogram, MetricRegistry, toPrometheus, exposeName,
  DURATION_BUCKETS_MS,
} from './metrics';

describe('label rendering', () => {
  it('escapes the three characters that would corrupt a scrape', () => {
    expect(escapeLabelValue('a"b')).toBe('a\\"b');
    expect(escapeLabelValue('a\\b')).toBe('a\\\\b');
    expect(escapeLabelValue('a\nb')).toBe('a\\nb');
  });

  it('sanitizes names to the Prometheus grammar', () => {
    expect(sanitizeName('mail.send-duration')).toBe('mail_send_duration');
    expect(sanitizeName('9lives')).toBe('_9lives');
    expect(sanitizeName('ok_name')).toBe('ok_name');
  });

  it('sorts keys so label order cannot split one series into two', () => {
    expect(renderLabels({ b: '2', a: '1' })).toBe(renderLabels({ a: '1', b: '2' }));
    expect(seriesKey('x', { b: 2, a: 1 })).toBe(seriesKey('x', { a: 1, b: 2 }));
  });

  it('drops null, undefined and empty rather than rendering them as values', () => {
    expect(renderLabels({ a: '1', b: null, c: undefined, d: '' })).toBe('{a="1"}');
  });

  it('renders nothing for an empty label set', () => {
    expect(renderLabels({})).toBe('');
  });
});

describe('quantileExact', () => {
  it('interpolates between order statistics (R-7)', () => {
    // 1..10, p50 sits between 5 and 6 at position 4.5 => 5.5
    expect(quantileExact([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5.5);
  });

  it('returns the endpoints for p0 and p100', () => {
    expect(quantileExact([3, 1, 2], 0)).toBe(1);
    expect(quantileExact([3, 1, 2], 1)).toBe(3);
  });

  it('does not mutate the caller array', () => {
    const xs = [3, 1, 2];
    quantileExact(xs, 0.5);
    expect(xs).toEqual([3, 1, 2]);
  });

  it('is null for an empty sample rather than 0', () => {
    // A latency of zero and "nothing was measured" must never render the same.
    expect(quantileExact([], 0.5)).toBeNull();
  });

  it('ignores NaN and Infinity instead of poisoning the result', () => {
    expect(quantileExact([1, NaN, 2, Infinity, 3], 0.5)).toBe(2);
  });
});

describe('summarize', () => {
  it('reports count alongside the percentiles so a thin sample is visible', () => {
    const s = summarize([10, 20, 30]);
    expect(s.count).toBe(3);
    expect(s.min).toBe(10);
    expect(s.max).toBe(30);
    expect(s.mean).toBe(20);
  });

  it('returns all-null for no samples', () => {
    expect(summarize([])).toEqual({ count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null });
  });

  it('handles a large sample without stack overflow (no spread into Math.min)', () => {
    const xs = Array.from({ length: 200_000 }, (_, i) => i);
    const s = summarize(xs);
    expect(s.count).toBe(200_000);
    expect(s.min).toBe(0);
    expect(s.max).toBe(199_999);
  });
});

describe('Counter', () => {
  it('accumulates per label set', () => {
    const c = new Counter('m', 'h');
    c.inc({ a: '1' });
    c.inc({ a: '1' }, 4);
    c.inc({ a: '2' });
    expect(c.get({ a: '1' })).toBe(5);
    expect(c.get({ a: '2' })).toBe(1);
  });

  it('refuses a negative increment — a counter that goes down is not a counter', () => {
    const c = new Counter('m', 'h');
    c.inc({}, 5);
    c.inc({}, -3);
    expect(c.get({})).toBe(5);
  });

  it('reports 0 for a label set never seen, but emits no series for it', () => {
    const c = new Counter('m', 'h');
    expect(c.get({ never: 'seen' })).toBe(0);
    expect(c.snapshot().series).toHaveLength(0);
  });
});

describe('Gauge', () => {
  it('sets and adds', () => {
    const g = new Gauge('g', 'h');
    g.set(10);
    g.add(-4);
    expect(g.get()).toBe(6);
  });

  it('is null when never set, distinguishing "unset" from zero', () => {
    expect(new Gauge('g', 'h').get()).toBeNull();
  });
});

describe('Histogram', () => {
  it('keeps buckets cumulative even when bounds are supplied out of order', () => {
    const h = new Histogram('h', 'help', [100, 10, 50]);
    expect(h.bounds).toEqual([10, 50, 100]);
    h.observe(30);
    const s = h.seriesFor()!;
    // 30 is <= 50 and <= 100, but not <= 10
    expect(s.cumulative).toEqual([0, 1, 1, 1]);
  });

  it('counts an over-range observation only in +Inf', () => {
    const h = new Histogram('h', 'help', [10]);
    h.observe(999);
    const s = h.seriesFor()!;
    expect(s.cumulative).toEqual([0, 1]);
    expect(s.count).toBe(1);
  });

  it('tracks sum, min and max alongside the buckets', () => {
    const h = new Histogram('h', 'help', DURATION_BUCKETS_MS);
    h.observe(5); h.observe(15); h.observe(1000);
    const s = h.seriesFor()!;
    expect(s.count).toBe(3);
    expect(s.sum).toBe(1020);
    expect(s.min).toBe(5);
    expect(s.max).toBe(1000);
  });
});

describe('histogramQuantile', () => {
  it('reports "not measured" rather than zero for an empty series', () => {
    const q = histogramQuantile(null, [1, 10], 0.99);
    expect(q.value).toBeNull();
    expect(q.count).toBe(0);
    expect(q.saturated).toBe(false);
  });

  it('returns the bucket it landed in so the true resolution is visible', () => {
    const h = new Histogram('h', 'help', [10, 100, 1000]);
    for (let i = 0; i < 100; i++) h.observe(50);
    const q = histogramQuantile(h.seriesFor(), h.bounds, 0.5);
    expect(q.bucket).toEqual({ lower: 10, upper: 100 });
    expect(q.value).toBeGreaterThan(10);
    expect(q.value).toBeLessThanOrEqual(100);
  });

  it('flags saturation when the quantile falls in the open +Inf bucket', () => {
    const h = new Histogram('h', 'help', [10]);
    for (let i = 0; i < 10; i++) h.observe(5_000);
    const q = histogramQuantile(h.seriesFor(), h.bounds, 0.99);
    expect(q.saturated).toBe(true);
    expect(q.value).toBe(10); // a LOWER bound: "p99 exceeds 10ms", not "p99 is 10ms"
  });

  it('never returns a value above the bucket it landed in', () => {
    const h = new Histogram('h', 'help', [10, 20]);
    h.observe(1); h.observe(2); h.observe(15);
    const q = histogramQuantile(h.seriesFor(), h.bounds, 0.99);
    expect(q.value!).toBeLessThanOrEqual(20);
  });
});

describe('Prometheus exposition', () => {
  it('converts millisecond instruments to seconds AND renames them', () => {
    // Naming without converting, or converting without renaming, would both be worse than neither.
    expect(exposeName('api_request_duration_ms', 'ms')).toBe('edurankai_mail_api_request_duration_seconds');
    const h = new Histogram('api_request_duration_ms', 'help', [1000], 'ms');
    h.observe(1000);
    const text = toPrometheus([h.snapshot()]);
    expect(text).toContain('le="1"');       // 1000ms rendered as 1s
    expect(text).toContain('_sum 1');
  });

  it('emits HELP and TYPE for every metric', () => {
    const c = new Counter('sent_total', 'Messages sent');
    c.inc({ node: 'mta-01' });
    const text = toPrometheus([c.snapshot()]);
    expect(text).toContain('# HELP edurankai_mail_sent_total Messages sent');
    expect(text).toContain('# TYPE edurankai_mail_sent_total counter');
    expect(text).toContain('edurankai_mail_sent_total{node="mta-01"} 1');
  });

  it('merges extra labels so many nodes can share one series name', () => {
    const c = new Counter('sent_total', 'h');
    c.inc({ kind: 'x' });
    const text = toPrometheus([c.snapshot()], { instance: 'worker-3' });
    expect(text).toContain('instance="worker-3"');
    expect(text).toContain('kind="x"');
  });

  it('emits the +Inf bucket and keeps it equal to _count', () => {
    const h = new Histogram('d_ms', 'h', [10], 'ms');
    h.observe(1); h.observe(5000);
    const text = toPrometheus([h.snapshot()]);
    expect(text).toContain('le="+Inf"} 2');
    expect(text).toContain('_count 2');
  });

  it('produces parseable output with a quote inside a label value', () => {
    const c = new Counter('x_total', 'h');
    c.inc({ target: 'say "hi"' });
    const text = toPrometheus([c.snapshot()]);
    expect(text).toContain('target="say \\"hi\\""');
  });
});

describe('MetricRegistry', () => {
  it('returns the same instrument for the same name', () => {
    const r = new MetricRegistry();
    expect(r.counter('a', 'h')).toBe(r.counter('a', 'h'));
    expect(r.has('a')).toBe(true);
  });

  it('snapshots every instrument in name order', () => {
    const r = new MetricRegistry();
    r.counter('zeta', 'h').inc();
    r.counter('alpha', 'h').inc();
    expect(r.snapshot().map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });
});
