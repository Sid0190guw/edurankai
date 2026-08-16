// src/lib/mailplatform/instrument.ts — what gets measured, what gets logged, and what must never be
// logged (Patch 8 §2, §12).
//
// THE CATALOGUE IS THE CONTRACT. MEASURED_OPERATIONS below is the list of things the brief asks to
// have latency for, written down as data rather than scattered across call sites. Two consequences,
// both deliberate:
//
//   1. A dashboard panel or an alert rule can be generated FROM the catalogue, so a panel can never
//      reference a series nothing emits — the "queue latency p99" panel that renders an empty graph
//      forever because nobody wired the timer is the failure this prevents.
//   2. `unmeasuredOperations()` reports which declared operations have produced no observations. On
//      /admin/mail/performance that renders as "declared, never observed" instead of as a zero. An
//      operation nobody has instrumented and an operation that is genuinely fast look identical on
//      every monitoring system I have ever used, and they are the opposite of each other.
//
// LOGGING IS SUBTRACTIVE HERE. src/lib/logger.ts already redacts SECRET-SHAPED VALUES (tokens, keys,
// anything matching SECRET_PATTERNS). That is necessary and not sufficient for mail: a message body
// contains no secret pattern and is the single most sensitive thing this subsystem touches, and a
// recipient address is personal data that a support engineer does not need in order to debug a
// deferral. scrubMailMeta() drops bodies outright and reduces addresses to their DOMAIN, which is
// the part deliverability work actually needs. See LOG_DENY and the note on subjects below.

import { redactMeta, logEvent, type LogLevel } from '@/lib/logger';
import { getRegistry, DURATION_BUCKETS_MS, AGE_BUCKETS_MS, SIZE_BUCKETS, type Labels } from './metrics';

// ---------------------------------------------------------------------------
// The measured-operation catalogue
// ---------------------------------------------------------------------------

export type OperationLayer =
  | 'api' | 'database' | 'queue' | 'worker' | 'smtp' | 'delivery' | 'inbound' | 'workflow' | 'campaign';

export interface MeasuredOperation {
  /** Stable key used at the call site: timed('smtp.connect', …). */
  key: string;
  layer: OperationLayer;
  /** Metric name, un-prefixed and un-suffixed; metrics.ts adds `edurankai_mail_` and the unit. */
  metric: string;
  help: string;
  buckets: readonly number[];
  /** What a reader should conclude when this number rises. Rendered on the performance screen. */
  meaning: string;
}

/**
 * Every latency the brief (§2) asks for, one entry each. Adding a timer means adding a row here
 * first; a test asserts the nine required layers are all covered.
 */
export const MEASURED_OPERATIONS: readonly MeasuredOperation[] = [
  {
    key: 'api.request', layer: 'api', metric: 'api_request_duration_ms', buckets: DURATION_BUCKETS_MS,
    help: 'Wall time of a mail API request, from route entry to response.',
    meaning: 'Rising p99 with flat p50 is queueing or a cold start, not slower code.',
  },
  {
    key: 'db.query', layer: 'database', metric: 'db_query_duration_ms', buckets: DURATION_BUCKETS_MS,
    help: 'Round trip of one database statement, including time waiting for a pooled connection.',
    meaning: 'On the Supabase transaction pooler this includes CHECKOUT time, so it rises under pool saturation before any query gets slower.',
  },
  {
    key: 'queue.enqueue', layer: 'queue', metric: 'queue_enqueue_duration_ms', buckets: DURATION_BUCKETS_MS,
    help: 'Time to write one job into the queue.',
    meaning: 'This is an INSERT on edu_jobs; if it climbs, the queue table is the bottleneck, not the workers.',
  },
  {
    key: 'queue.wait', layer: 'queue', metric: 'queue_wait_duration_ms', buckets: AGE_BUCKETS_MS,
    help: 'Time a job spent queued before a worker claimed it (enqueue to claim).',
    meaning: 'The honest definition of queue latency. Grows without bound when arrival rate exceeds drain rate.',
  },
  {
    key: 'message.process', layer: 'worker', metric: 'message_process_duration_ms', buckets: DURATION_BUCKETS_MS,
    help: 'Time a worker spent processing one message job, claim to acknowledgement.',
    meaning: 'Multiply by concurrency to get the drain rate ceiling; see capacity.ts.',
  },
  {
    key: 'smtp.connect', layer: 'smtp', metric: 'smtp_connect_duration_ms', buckets: DURATION_BUCKETS_MS,
    help: 'TCP connect plus TLS plus EHLO to a remote MX or relay.',
    meaning: 'Dominated by network and remote policy. A pooled connection should not pay this per message; if p50 tracks message count, pooling is not working.',
  },
  {
    key: 'delivery.attempt', layer: 'delivery', metric: 'delivery_duration_ms', buckets: DURATION_BUCKETS_MS,
    help: 'One delivery attempt end to end, connect through final SMTP response.',
    meaning: 'Compare against smtp.connect: the difference is data transfer plus remote acceptance time.',
  },
  {
    key: 'inbound.parse', layer: 'inbound', metric: 'inbound_parse_duration_ms', buckets: DURATION_BUCKETS_MS,
    help: 'Parsing one inbound MIME message into headers, bodies and attachments.',
    meaning: 'Scales with message SIZE, not count. A tail here is large attachments, and it is CPU on the request path.',
  },
  {
    key: 'workflow.execute', layer: 'workflow', metric: 'workflow_execute_duration_ms', buckets: DURATION_BUCKETS_MS,
    help: 'One automation workflow run, from trigger to terminal node.',
    meaning: 'Long runs hold a worker slot; a wait node that blocks rather than re-queues shows up here as a multi-second p99.',
  },
  {
    key: 'campaign.generate', layer: 'campaign', metric: 'campaign_generate_duration_ms', buckets: DURATION_BUCKETS_MS,
    help: 'Materialising the recipient set for a campaign from its segment definition.',
    meaning: 'The one operation whose cost is a function of AUDIENCE size rather than send rate. Read it next to campaign_recipients_generated.',
  },
];

export const OPERATION_KEYS: readonly string[] = MEASURED_OPERATIONS.map((o) => o.key);

export function findOperation(key: string): MeasuredOperation | null {
  return MEASURED_OPERATIONS.find((o) => o.key === key) ?? null;
}

/**
 * Declared operations that have recorded NOTHING in this process.
 *
 * Rendered on the performance screen as "declared, never observed" — see the header note. This is
 * per-process and therefore also empty-ish right after a cold start, which the screen says too.
 */
export function unmeasuredOperations(): MeasuredOperation[] {
  const reg = getRegistry();
  return MEASURED_OPERATIONS.filter((op) => {
    if (!reg.has(op.metric)) return true;
    const snap = reg.histogram(op.metric, op.help, op.buckets).snapshot();
    return snap.series.length === 0;
  });
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/**
 * The identifiers §12 asks every log line to carry.
 *
 * All optional: a queue worker has no request_id and an inbound parse has no campaign_id, and
 * inventing one so the shape looks uniform would make the field useless for joining.
 */
export interface Correlation {
  requestId?: string;
  messageId?: string;
  campaignId?: string;
  workflowId?: string;
  workerId?: string;
  /** Tenant/organization. Present on everything multi-tenant; see mailplatform/types.ts Organization. */
  tenantId?: string;
  nodeId?: string;
}

/** A short, sortable, collision-resistant correlation id. Prefixed so a grep hit says what it is. */
export function newCorrelationId(prefix = 'req'): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const rand = c && typeof c.randomUUID === 'function' ? c.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(16).slice(2, 18).padEnd(16, '0');
  return prefix + '_' + Date.now().toString(36) + rand.slice(0, 10);
}

/**
 * Read an inbound correlation id from request headers, or mint one.
 *
 * Accepting a CALLER-SUPPLIED id is what makes a trace span two services, and it is also untrusted
 * input that ends up in log files — so it is length-capped and character-restricted here rather than
 * being passed through. An id containing a newline can forge a whole log line.
 */
export function correlationFromHeaders(headers: { get(name: string): string | null } | null | undefined): string {
  const raw = headers?.get('x-request-id') || headers?.get('x-correlation-id') || '';
  const clean = String(raw).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
  return clean.length >= 8 ? clean : newCorrelationId();
}

// ---------------------------------------------------------------------------
// Privacy-safe log metadata
// ---------------------------------------------------------------------------

/**
 * Field names that must never reach a log line, whatever their value looks like.
 *
 * SECRET_PATTERNS in logger.ts cannot catch these, because a message body does not LOOK like a
 * secret — it looks like prose, and prose passes every redaction regex ever written. The only safe
 * treatment is to drop the field by name.
 */
export const LOG_DENY: readonly string[] = [
  'body', 'bodyHtml', 'bodyText', 'html', 'text', 'raw', 'mime', 'content',
  'password', 'pass', 'smtpPass', 'secret', 'apiKey', 'token', 'dkimPrivateKey', 'privateKey',
  'attachment', 'attachments',
];

/** Field names holding an email address. Reduced to a domain rather than dropped — see below. */
export const LOG_ADDRESS_FIELDS: readonly string[] = [
  'to', 'from', 'cc', 'bcc', 'recipient', 'recipientAddress', 'sender', 'email', 'address', 'replyTo',
];

/**
 * Keep the DOMAIN, drop the local part: `alice@example.com` becomes `@example.com`.
 *
 * The domain is the half deliverability work actually needs — throttling, reputation, a provider
 * deferring everything — and the local part is the half that identifies a person. Logging the whole
 * address to debug a bounce puts a recipient list into a log aggregator that has a different
 * retention policy and a different access list from the database it came from.
 */
export function maskAddress(value: unknown): string {
  const s = String(value ?? '');
  const at = s.lastIndexOf('@');
  if (at < 0) return '[address]';
  const domain = s.slice(at + 1).toLowerCase().replace(/[^a-z0-9.:-]/g, '');
  return domain ? '@' + domain : '[address]';
}

/**
 * A stable, non-reversible tag for a subject line.
 *
 * Subjects are not secret and are not quite public: "Your test results" plus a recipient domain is
 * already a disclosure. But threading bugs are unreadable without SOME per-subject identity, so a
 * short non-cryptographic digest gives grouping without content. Not a security boundary — it is a
 * short hash and a determined reader with a candidate list could confirm a guess; it is a
 * data-minimisation measure, and anything needing a real one should not be in a log line at all.
 */
export function subjectTag(subject: unknown): string {
  const s = String(subject ?? '');
  if (!s) return 'subj:empty';
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'subj:' + (h >>> 0).toString(36);
}

/**
 * Apply the mail-specific rules, then hand the result to logger.redactMeta for the secret-shaped
 * pass. Both run: this one knows about bodies and addresses, that one knows about tokens.
 */
export function scrubMailMeta(meta: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(meta || {})) {
    const lower = key.toLowerCase();
    if (LOG_DENY.some((d) => d.toLowerCase() === lower)) { out[key] = '[dropped]'; continue; }
    if (LOG_ADDRESS_FIELDS.some((f) => f.toLowerCase() === lower)) {
      const v = meta[key];
      out[key] = Array.isArray(v) ? v.map(maskAddress) : maskAddress(v);
      continue;
    }
    if (lower === 'subject') { out[key] = subjectTag(meta[key]); continue; }
    out[key] = meta[key];
  }
  return redactMeta(out);
}

/** Structured log with correlation ids and mail scrubbing applied. This is the only logger mail code should call. */
export function mailLog(level: LogLevel, event: string, corr: Correlation = {}, meta: Record<string, unknown> = {}): void {
  const ids: Record<string, unknown> = {};
  if (corr.requestId) ids.request_id = corr.requestId;
  if (corr.messageId) ids.message_id = corr.messageId;
  if (corr.campaignId) ids.campaign_id = corr.campaignId;
  if (corr.workflowId) ids.workflow_id = corr.workflowId;
  if (corr.workerId) ids.worker_id = corr.workerId;
  if (corr.tenantId) ids.tenant_id = corr.tenantId;
  if (corr.nodeId) ids.node_id = corr.nodeId;
  logEvent(level, event, { ...ids, ...scrubMailMeta(meta) } as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Labels allowed on latency series. Kept SHORT deliberately — see the cardinality note. */
export interface OperationLabels {
  /** Route, table, job kind, MTA node, remote domain — whatever identifies the variant of this op. */
  target?: string;
  outcome?: 'ok' | 'error' | 'deferred';
  tenantId?: string;
}

/**
 * CARDINALITY IS THE WHOLE COST MODEL OF A METRICS SYSTEM. Every distinct label combination is a
 * separate time series stored forever. `target` must be a BOUNDED set — a route pattern, a job kind,
 * a node name — never a message id, a recipient address or a subject. `tenantId` is bounded by the
 * number of organizations, which is fine at tens and is NOT fine at a hundred thousand: at that
 * scale drop it here and get per-tenant numbers from the event store instead, which is built for
 * high-cardinality slicing and metrics are not.
 */
export function labelsFor(op: MeasuredOperation, l: OperationLabels = {}): Labels {
  return { layer: op.layer, op: op.key, target: l.target, outcome: l.outcome, tenant: l.tenantId };
}

/** Record one observation for a declared operation. Unknown keys are ignored, loudly, once. */
export function observe(key: string, durationMs: number, l: OperationLabels = {}): void {
  const op = findOperation(key);
  if (!op) { logEvent('warn', 'mail.metric.undeclared_operation', { key }); return; }
  getRegistry().histogram(op.metric, op.help, op.buckets, 'ms').observe(durationMs, labelsFor(op, l));
}

/**
 * Time an async operation, record it, and let the original error through.
 *
 * THE ERROR IS RE-THROWN, ALWAYS. An instrumentation wrapper that swallows is how a whole subsystem
 * goes quiet — this repository has already lost a sign-in outage to a bare catch, and CLAUDE.md
 * names it. The failure is recorded with outcome=error and then re-thrown unchanged, so the caller's
 * own error handling, including `e.cause` where the real Postgres reason lives, is untouched.
 */
export async function timed<T>(key: string, fn: () => Promise<T>, l: OperationLabels = {}, corr: Correlation = {}): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    observe(key, Date.now() - started, { ...l, outcome: l.outcome ?? 'ok' });
    return result;
  } catch (e: unknown) {
    observe(key, Date.now() - started, { ...l, outcome: 'error' });
    const err = e as { cause?: { message?: string }; message?: string };
    mailLog('error', 'mail.op.failed', corr, { op: key, target: l.target, durationMs: Date.now() - started, message: String(err?.cause?.message || err?.message || 'error').slice(0, 300) });
    throw e;
  }
}

/** Counters and gauges that are not latencies. Named here so dashboards and alerts share one source. */
export const COUNTERS = {
  messagesAccepted: 'messages_accepted_total',
  messagesDelivered: 'messages_delivered_total',
  messagesDeferred: 'messages_deferred_total',
  messagesBounced: 'messages_bounced_total',
  messagesFailed: 'messages_failed_total',
  jobsEnqueued: 'jobs_enqueued_total',
  jobsProcessed: 'jobs_processed_total',
  jobsRetried: 'jobs_retried_total',
  jobsDeadLettered: 'jobs_dead_lettered_total',
  inboundAccepted: 'inbound_accepted_total',
  eventsRecorded: 'events_recorded_total',
  eventsDropped: 'events_dropped_total',
} as const;

export const GAUGES = {
  queueDepth: 'queue_depth',
  queueOldestAgeMs: 'queue_oldest_age_ms',
  workersActive: 'workers_active',
  mtaNodesHealthy: 'mta_nodes_healthy',
  poolConnectionsActive: 'pool_connections_active',
} as const;

export function count(name: string, labels: Labels = {}, by = 1): void {
  getRegistry().counter(name, 'EduRankAI Mail counter: ' + name).inc(labels, by);
}
export function setGauge(name: string, value: number, labels: Labels = {}, unit: 'ms' | 'count' = 'count'): void {
  getRegistry().gauge(name, 'EduRankAI Mail gauge: ' + name, unit).set(value, labels);
}
/** Recipient-set size and batch size are distributions, not averages. */
export function observeSize(metric: string, value: number, labels: Labels = {}): void {
  getRegistry().histogram(metric, 'EduRankAI Mail size distribution: ' + metric, SIZE_BUCKETS, 'count').observe(value, labels);
}
