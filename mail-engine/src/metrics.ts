// mail-engine/src/metrics.ts — the numbers section 14 of the brief asks for, in one registry.
//
// Deliberately dependency-free and deliberately tiny: counters, gauges and a histogram with fixed
// buckets, rendered as Prometheus text. A mail server that needs a metrics SDK to tell you its queue
// depth is a mail server that stops telling you when the SDK fails to load.
//
// Gauges that describe the spool (queue depth, dead letters, unpublished events) are not incremented
// by the code paths that touch the spool — they are SAMPLED from it, in server.ts, at scrape time.
// Counters that drift from the on-disk truth are worse than no counters, and they always drift.

export type Labels = Record<string, string>;

interface Series {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  values: Map<string, { labels: Labels; value: number }>;
  buckets?: number[];
  /** histogram only: bucket key -> count */
  hist?: Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>;
}

const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000];

function keyOf(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export class Metrics {
  private series = new Map<string, Series>();

  private ensure(name: string, help: string, type: Series['type'], buckets?: number[]): Series {
    let s = this.series.get(name);
    if (!s) {
      s = { name, help, type, values: new Map(), buckets, hist: type === 'histogram' ? new Map() : undefined };
      this.series.set(name, s);
    }
    return s;
  }

  counter(name: string, help: string, labels: Labels = {}, by = 1): void {
    const s = this.ensure(name, help, 'counter');
    const k = keyOf(labels);
    const cur = s.values.get(k);
    if (cur) cur.value += by;
    else s.values.set(k, { labels, value: by });
  }

  gauge(name: string, help: string, value: number, labels: Labels = {}): void {
    const s = this.ensure(name, help, 'gauge');
    s.values.set(keyOf(labels), { labels, value });
  }

  observe(name: string, help: string, valueMs: number, labels: Labels = {}): void {
    const s = this.ensure(name, help, 'histogram', LATENCY_BUCKETS_MS);
    const k = keyOf(labels);
    let h = s.hist!.get(k);
    if (!h) {
      h = { labels, counts: new Array(LATENCY_BUCKETS_MS.length).fill(0), sum: 0, count: 0 };
      s.hist!.set(k, h);
    }
    h.sum += valueMs;
    h.count += 1;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      if (valueMs <= LATENCY_BUCKETS_MS[i]) h.counts[i] += 1;
    }
  }

  /** Read one counter/gauge back. Used by the tests and by /stats. */
  read(name: string, labels: Labels = {}): number {
    return this.series.get(name)?.values.get(keyOf(labels))?.value ?? 0;
  }

  /** Everything, as plain JSON, for the /stats endpoint. */
  snapshot(): Record<string, { type: string; help: string; samples: { labels: Labels; value: number }[] }> {
    const out: Record<string, { type: string; help: string; samples: { labels: Labels; value: number }[] }> = {};
    for (const s of this.series.values()) {
      const samples: { labels: Labels; value: number }[] = [];
      for (const v of s.values.values()) samples.push({ labels: v.labels, value: v.value });
      if (s.hist) {
        for (const h of s.hist.values()) {
          samples.push({ labels: { ...h.labels, stat: 'count' }, value: h.count });
          samples.push({ labels: { ...h.labels, stat: 'sum_ms' }, value: h.sum });
          samples.push({ labels: { ...h.labels, stat: 'avg_ms' }, value: h.count ? Math.round(h.sum / h.count) : 0 });
        }
      }
      out[s.name] = { type: s.type, help: s.help, samples };
    }
    return out;
  }

  /** Prometheus text exposition format (version 0.0.4). */
  render(): string {
    const lines: string[] = [];
    for (const s of this.series.values()) {
      lines.push(`# HELP ${s.name} ${s.help}`);
      lines.push(`# TYPE ${s.name} ${s.type}`);
      if (s.type === 'histogram' && s.hist) {
        for (const h of s.hist.values()) {
          const base = Object.entries(h.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
          for (let i = 0; i < s.buckets!.length; i++) {
            const l = base.concat(`le="${s.buckets![i]}"`).join(',');
            lines.push(`${s.name}_bucket{${l}} ${h.counts[i]}`);
          }
          const inf = base.concat('le="+Inf"').join(',');
          lines.push(`${s.name}_bucket{${inf}} ${h.count}`);
          const bl = base.join(',');
          lines.push(`${s.name}_sum${bl ? `{${bl}}` : ''} ${h.sum}`);
          lines.push(`${s.name}_count${bl ? `{${bl}}` : ''} ${h.count}`);
        }
        continue;
      }
      for (const v of s.values.values()) {
        const l = Object.entries(v.labels).map(([k, val]) => `${k}="${escapeLabel(val)}"`).join(',');
        lines.push(`${s.name}${l ? `{${l}}` : ''} ${v.value}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

/** Metric names, in one place, so a typo cannot silently create a second series. */
export const M = {
  outboundSubmitted: 'mail_outbound_submitted_total',
  outboundRejected: 'mail_outbound_rejected_total',
  outboundDelivered: 'mail_outbound_delivered_total',
  outboundDeferred: 'mail_outbound_deferred_total',
  outboundBounced: 'mail_outbound_bounced_total',
  outboundDeadLettered: 'mail_outbound_dead_lettered_total',
  outboundRetries: 'mail_outbound_retries_total',
  deliveryLatency: 'mail_delivery_latency_ms',
  smtpConnections: 'mail_smtp_connections_total',
  smtpConnectionsOpen: 'mail_smtp_connections_open',
  mtaErrors: 'mail_mta_errors_total',
  queueDepth: 'mail_queue_depth',
  queueDeferred: 'mail_queue_deferred',
  queueDeadLetters: 'mail_queue_dead_letters',
  eventsPublished: 'mail_events_published_total',
  eventsPending: 'mail_events_pending',
  inboundReceived: 'mail_inbound_received_total',
  inboundDelivered: 'mail_inbound_delivered_total',
  inboundRejected: 'mail_inbound_rejected_total',
  throttleWaits: 'mail_throttle_waits_total',
} as const;

export const metrics = new Metrics();
