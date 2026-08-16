// Tests for the database analysis rules, the failure-mode catalogue and the logging scrubber.
import { describe, it, expect } from 'vitest';
import { analyzeTables, unusedIndexes, DEFAULT_ANALYSIS, APPEND_ONLY_TABLES, MAIL_TABLES, type TableStat, type IndexStat } from './db-perf';
import { FAILURE_MODES, coverage, openGaps, byDependency, findFailureMode } from './failure-modes';
import { scrubMailMeta, maskAddress, subjectTag, LOG_DENY, MEASURED_OPERATIONS, OPERATION_KEYS, findOperation, correlationFromHeaders, newCorrelationId, labelsFor } from './instrument';

const NOW = Date.parse('2026-08-16T00:00:00.000Z');

function table(over: Partial<TableStat> = {}): TableStat {
  return {
    table: 'mail_messages', liveRows: 1000, deadRows: 0, totalBytes: 1024, indexBytes: 256,
    seqScans: 0, seqRowsRead: 0, indexScans: 1000,
    lastVacuum: null, lastAutovacuum: '2026-08-15T00:00:00.000Z', lastAnalyze: '2026-08-15T00:00:00.000Z',
    ...over,
  };
}

describe('analyzeTables', () => {
  it('says nothing about a healthy table', () => {
    expect(analyzeTables([table()], DEFAULT_ANALYSIS, NOW)).toHaveLength(0);
  });

  it('does NOT flag a small table that is always scanned', () => {
    // A sequential scan of a 200-row table is the planner being right. "Add an index" here is advice
    // that costs writes and buys nothing — the mistake most naive detectors make.
    const findings = analyzeTables([table({ liveRows: 200, seqScans: 10_000, indexScans: 0 })], DEFAULT_ANALYSIS, NOW);
    expect(findings.filter((f) => f.kind === 'sequential_scan')).toHaveLength(0);
  });

  it('flags a large table scanned sequentially, with the evidence attached', () => {
    const findings = analyzeTables([table({ liveRows: 2_000_000, seqScans: 900, indexScans: 100, seqRowsRead: 5_000_000 })], DEFAULT_ANALYSIS, NOW);
    const f = findings.find((x) => x.kind === 'sequential_scan')!;
    expect(f.severity).toBe('critical');
    expect(f.evidence.seqRatio).toBeCloseTo(0.9);
    expect(f.recommendation).toContain('EXPLAIN');
  });

  it('flags dead-tuple bloat and points at autovacuum tuning rather than manual vacuuming', () => {
    const f = analyzeTables([table({ liveRows: 100_000, deadRows: 50_000 })], DEFAULT_ANALYSIS, NOW).find((x) => x.kind === 'dead_tuples')!;
    expect(f.detail).toContain('50%');
    expect(f.recommendation).toContain('autovacuum_vacuum_scale_factor');
  });

  it('flags stale planner statistics, including never-analyzed', () => {
    const never = analyzeTables([table({ liveRows: 50_000, lastAnalyze: null })], DEFAULT_ANALYSIS, NOW);
    expect(never.find((f) => f.kind === 'unvacuumed')!.detail).toContain('ever');
    const stale = analyzeTables([table({ liveRows: 50_000, lastAnalyze: '2026-07-01T00:00:00.000Z' })], DEFAULT_ANALYSIS, NOW);
    expect(stale.find((f) => f.kind === 'unvacuumed')!.detail).toContain('days');
  });

  it('recommends partitioning ONLY for append-only tables', () => {
    const big = { liveRows: 50_000_000, totalBytes: 5 * 1024 ** 3 };
    const appendOnly = analyzeTables([table({ table: 'mp_events', ...big })], DEFAULT_ANALYSIS, NOW);
    expect(appendOnly.some((f) => f.kind === 'partition_candidate')).toBe(true);

    // mail_box is updated in place (read flags, folders, labels). Partitioning it would cost row
    // movement and gain nothing.
    const mutable = analyzeTables([table({ table: 'mail_box', ...big })], DEFAULT_ANALYSIS, NOW);
    expect(mutable.some((f) => f.kind === 'partition_candidate')).toBe(false);
  });

  it('sorts critical findings first', () => {
    const findings = analyzeTables([
      table({ table: 'email_logs', liveRows: 60_000, seqScans: 100, indexScans: 1, lastAnalyze: null }),
      table({ table: 'mail_messages', liveRows: 5_000_000, seqScans: 900, indexScans: 100 }),
    ], DEFAULT_ANALYSIS, NOW);
    expect(findings[0].severity).toBe('critical');
  });

  it('every append-only table named is one the subsystem actually owns', () => {
    for (const t of APPEND_ONLY_TABLES) expect(MAIL_TABLES).toContain(t);
  });
});

describe('unusedIndexes', () => {
  const idx = (over: Partial<IndexStat> = {}): IndexStat => ({ table: 'mail_messages', index: 'i', scans: 0, sizeBytes: 10 * 1024 * 1024, isUnique: false, isPrimary: false, ...over });

  it('NEVER suggests dropping a unique or primary index whatever its scan count', () => {
    // edu_jobs.dedup_key is the queue's whole idempotency guarantee. Dropping it because a stats
    // view called it unused would permit duplicate sends — the worst outcome available here.
    expect(unusedIndexes([idx({ isUnique: true })])).toHaveLength(0);
    expect(unusedIndexes([idx({ isPrimary: true })])).toHaveLength(0);
  });

  it('ignores tiny indexes that are not worth the churn', () => {
    expect(unusedIndexes([idx({ sizeBytes: 4096 })])).toHaveLength(0);
  });

  it('flags a large never-scanned index and warns that stats are cumulative', () => {
    const f = unusedIndexes([idx()])[0];
    expect(f.kind).toBe('unused_index');
    expect(f.recommendation).toContain('pg_stat_reset');
    expect(f.recommendation).toContain('CONCURRENTLY');
  });
});

describe('failure-mode catalogue', () => {
  it('covers every dependency §10 lists', () => {
    for (const dep of ['database', 'redis', 'queue', 'smtp', 'worker', 'mta', 'network', 'supabase_api', 'vercel_api', 'storage'] as const) {
      expect(byDependency(dep).length).toBeGreaterThan(0);
    }
  });

  it('every entry states what must NOT happen, not just what should', () => {
    expect(FAILURE_MODES.every((f) => f.mustNot && f.mustNot.length > 20)).toBe(true);
  });

  it('every entry says how to reproduce it and points at evidence', () => {
    expect(FAILURE_MODES.every((f) => f.reproduce.length > 10 && f.evidence.length > 0)).toBe(true);
  });

  it('anything not fully implemented names its gap — the catalogue may not flatter itself', () => {
    for (const f of FAILURE_MODES) {
      if (f.status !== 'implemented') expect(f.gap, f.id + ' is ' + f.status + ' but names no gap').toBeTruthy();
    }
  });

  it('reports coverage honestly rather than as a pass badge', () => {
    const c = coverage();
    expect(c.total).toBe(FAILURE_MODES.length);
    expect(c.implemented + c.partial + c.intended).toBe(c.total);
    expect(c.percentImplemented).toBeLessThan(100);   // it is not all built, and it must not claim to be
  });

  it('open gaps are ordered worst-first', () => {
    const gaps = openGaps();
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0].status).toBe('intended');
    expect(gaps.every((g) => g.status !== 'implemented')).toBe(true);
  });

  it('names the crashed-worker gap specifically', () => {
    const wc = findFailureMode('worker-crash')!;
    expect(wc.status).toBe('partial');
    expect(wc.gap).toContain('NOTHING sets it back');
  });

  it('is honest that Redis is simply not part of the architecture', () => {
    expect(findFailureMode('redis-unavailable')!.expected).toContain('No effect');
  });
});

describe('log scrubbing', () => {
  it('drops a message body, which no secret regex would ever catch', () => {
    const out = scrubMailMeta({ bodyHtml: '<p>diagnosis results</p>', text: 'private', messageId: 'm1' });
    expect(out.bodyHtml).toBe('[dropped]');
    expect(out.text).toBe('[dropped]');
    expect(out.messageId).toBe('m1');
  });

  it('drops every denied field name regardless of case', () => {
    const meta: Record<string, unknown> = {};
    for (const k of LOG_DENY) meta[k.toUpperCase()] = 'sensitive';
    const out = scrubMailMeta(meta);
    // Two markers, because two passes run: this module drops by NAME ('[dropped]'), then
    // logger.redactMeta relabels secret-shaped keys ('[redacted]'). Either way the value is gone,
    // and the assertion that matters is that none of the originals survived.
    expect(Object.values(out).every((v) => v === '[dropped]' || v === '[redacted]')).toBe(true);
    expect(Object.values(out)).not.toContain('sensitive');
  });

  it('keeps the recipient DOMAIN and drops the local part', () => {
    // The domain is what deliverability work needs; the local part is what identifies a person.
    expect(maskAddress('alice.smith@example.com')).toBe('@example.com');
    expect(scrubMailMeta({ to: 'bob@edurankai.in' }).to).toBe('@edurankai.in');
    expect(scrubMailMeta({ cc: ['a@x.com', 'b@y.com'] }).cc).toEqual(['@x.com', '@y.com']);
    expect(maskAddress('garbage')).toBe('[address]');
  });

  it('replaces a subject with a stable tag rather than logging it', () => {
    expect(subjectTag('Your test results')).toBe(subjectTag('Your test results'));
    expect(subjectTag('a')).not.toBe(subjectTag('b'));
    expect(scrubMailMeta({ subject: 'Your invoice' }).subject).toMatch(/^subj:/);
  });

  it('still applies the secret-shaped redaction from logger.ts', () => {
    const out = scrubMailMeta({ smtpToken: 'abcdef1234567890' });
    expect(out.smtpToken).toBe('[redacted]');
  });
});

describe('measured-operation catalogue', () => {
  it('covers all nine layers §2 asks to measure', () => {
    const layers = new Set(MEASURED_OPERATIONS.map((o) => o.layer));
    for (const l of ['api', 'database', 'queue', 'worker', 'smtp', 'delivery', 'inbound', 'workflow', 'campaign']) {
      expect(layers.has(l as never), 'missing layer ' + l).toBe(true);
    }
  });

  it('has unique keys and metric names', () => {
    expect(new Set(OPERATION_KEYS).size).toBe(OPERATION_KEYS.length);
    expect(new Set(MEASURED_OPERATIONS.map((o) => o.metric)).size).toBe(MEASURED_OPERATIONS.length);
  });

  it('every operation explains what a rise MEANS, not just that it rose', () => {
    expect(MEASURED_OPERATIONS.every((o) => o.meaning.length > 30)).toBe(true);
  });

  it('uses age buckets for queue WAIT, which runs to hours, not milliseconds', () => {
    const wait = findOperation('queue.wait')!;
    expect(Math.max(...wait.buckets)).toBeGreaterThanOrEqual(3_600_000);
  });

  it('keeps latency labels to a bounded set', () => {
    const l = labelsFor(findOperation('api.request')!, { target: '/api/mail/send', outcome: 'ok' });
    expect(Object.keys(l).sort()).toEqual(['layer', 'op', 'outcome', 'target', 'tenant']);
  });
});

describe('correlation ids', () => {
  it('mints unique prefixed ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newCorrelationId('req')));
    expect(ids.size).toBe(200);
    expect([...ids][0].startsWith('req_')).toBe(true);
  });

  it('accepts a caller id but strips anything that could forge a log line', () => {
    const h = { get: (k: string) => (k === 'x-request-id' ? 'abc\n{"level":"info","event":"forged"}' : null) };
    const id = correlationFromHeaders(h);
    expect(id).not.toContain('\n');
    expect(id).not.toContain('"');
  });

  it('mints a fresh id when the supplied one is too short to be real', () => {
    const h = { get: () => 'x' };
    expect(correlationFromHeaders(h).startsWith('req_')).toBe(true);
  });

  it('mints one when there are no headers at all', () => {
    expect(correlationFromHeaders(null).startsWith('req_')).toBe(true);
  });
});
