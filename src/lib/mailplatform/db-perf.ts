// src/lib/mailplatform/db-perf.ts — database performance analysis for the mail tables (Patch 8 §4).
//
// "DO NOT PREMATURELY INTRODUCE COMPLEXITY WITHOUT MEASUREMENTS" IS THE BRIEF, AND IT IS THE DESIGN.
// Nothing here changes a schema. Every function READS a catalogue view and returns a finding with
// the evidence attached, so a decision to add an index or partition a table is made from
// pg_stat_user_tables rather than from an opinion. The recommendations are recommendations: SQL is
// printed for a human to run, never executed. That is also this project's established rule for
// production DDL (CLAUDE.md, and the migration pattern in .dev-scripts).
//
// IT DOES NOT REBUILD WHAT EXISTS. src/lib/observability-health.ts already has poolSignals() and
// slowQueries(); this module imports them rather than writing a second version that could disagree
// with the first on the /admin/ops screen.
//
// EVERY READ SAYS WHETHER IT COULD READ. A "no missing indexes" panel drawn from a query that threw
// is the exact failure CLAUDE.md names, and on a performance screen it is worse than useless: it
// ends the investigation.
//
// WHY THE CANDIDATE TABLE LIST IS EXPLICIT. Scanning every table in the database would drown the
// mail signal in 250 unrelated ones. MAIL_TABLES is the set this subsystem owns — the live tables
// from src/lib/mail.ts and mail-advanced.ts, the queue, and the event store.

import { poolSignals, slowQueries } from '@/lib/observability-health';

/** The tables this subsystem owns. `present` is resolved at read time — several are created lazily. */
export const MAIL_TABLES: readonly string[] = [
  'mail_messages', 'mail_recipients', 'mail_box', 'mail_attachments', 'mail_reads',
  'mail_scheduled', 'mail_labels', 'mail_message_labels', 'mail_rules', 'mail_link_clicks',
  'email_logs', 'edu_jobs', 'edu_job_log', 'mp_events',
];

const rows = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] })?.rows || []));
const reason = (e: unknown): string => {
  const err = e as { cause?: { message?: string }; message?: string };
  return String(err?.cause?.message || err?.message || 'unknown error');
};
const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

// ---------------------------------------------------------------------------
// Table statistics
// ---------------------------------------------------------------------------

export interface TableStat {
  table: string;
  liveRows: number;
  deadRows: number;
  totalBytes: number;
  indexBytes: number;
  seqScans: number;
  seqRowsRead: number;
  indexScans: number;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
}

export interface TableStats { ok: boolean; tables: TableStat[]; error?: string }

/**
 * One query over pg_stat_user_tables joined to the size functions.
 *
 * `n_live_tup` and `n_dead_tup` are ESTIMATES maintained by the statistics collector, not counts.
 * That is a feature here: an exact COUNT(*) on a large event table is a sequential scan, and a
 * performance page must not be the slowest query on the system.
 */
export async function tableStats(tables: readonly string[] = MAIL_TABLES): Promise<TableStats> {
  try {
    const { db, sql } = await ctx();
    const list = sql.join(tables.map((t) => sql`${t}`), sql`, `);
    const r = rows(await db.execute(sql`
      SELECT relname AS table_name, n_live_tup, n_dead_tup, seq_scan, seq_tup_read, idx_scan,
             last_vacuum, last_autovacuum, last_analyze,
             pg_total_relation_size(relid) AS total_bytes,
             pg_indexes_size(relid) AS index_bytes
      FROM pg_stat_user_tables
      WHERE relname IN (${list})
      ORDER BY pg_total_relation_size(relid) DESC`));
    return {
      ok: true,
      tables: r.map((x) => ({
        table: String(x.table_name),
        liveRows: n(x.n_live_tup),
        deadRows: n(x.n_dead_tup),
        totalBytes: n(x.total_bytes),
        indexBytes: n(x.index_bytes),
        seqScans: n(x.seq_scan),
        seqRowsRead: n(x.seq_tup_read),
        indexScans: n(x.idx_scan),
        lastVacuum: x.last_vacuum ? new Date(String(x.last_vacuum)).toISOString() : null,
        lastAutovacuum: x.last_autovacuum ? new Date(String(x.last_autovacuum)).toISOString() : null,
        lastAnalyze: x.last_analyze ? new Date(String(x.last_analyze)).toISOString() : null,
      })),
    };
  } catch (e) {
    return { ok: false, tables: [], error: reason(e) };
  }
}

// ---------------------------------------------------------------------------
// Findings (pure)
// ---------------------------------------------------------------------------

export type FindingKind = 'sequential_scan' | 'dead_tuples' | 'unvacuumed' | 'large_table' | 'partition_candidate' | 'unused_index' | 'index_bloat';

export interface Finding {
  kind: FindingKind;
  table: string;
  severity: 'info' | 'warning' | 'critical';
  detail: string;
  /** What to DO. SQL where there is a specific statement; never run automatically. */
  recommendation: string;
  evidence: Record<string, number | string | null>;
}

export interface AnalysisThresholds {
  /** A table is worth partitioning above this row count AND when it is append-only by nature. */
  partitionRowThreshold: number;
  /** Above this many rows, a sequential scan is a real cost rather than a cheap small-table plan. */
  seqScanRowThreshold: number;
  /** Ratio of sequential to total scans that suggests a missing index. */
  seqScanRatio: number;
  /** Dead tuples as a fraction of live rows before bloat is worth naming. */
  deadTupleRatio: number;
  /** Bytes above which a table is "large" for this deployment. */
  largeTableBytes: number;
  /** Days without an analyze before the planner's statistics are suspect. */
  staleAnalyzeDays: number;
}

export const DEFAULT_ANALYSIS: AnalysisThresholds = {
  partitionRowThreshold: 10_000_000,
  seqScanRowThreshold: 50_000,
  seqScanRatio: 0.5,
  deadTupleRatio: 0.2,
  largeTableBytes: 1024 * 1024 * 1024,
  staleAnalyzeDays: 7,
};

/**
 * Tables that are append-only and time-ordered, and therefore genuinely partitionable.
 *
 * The distinction matters. Partitioning a table that is updated in place across partition keys costs
 * you row movement and gains nothing; partitioning an append-only log turns retention from a
 * multi-hour DELETE plus vacuum into an instant DETACH. Only the second kind is ever recommended.
 */
export const APPEND_ONLY_TABLES: readonly string[] = ['mp_events', 'email_logs', 'edu_job_log', 'mail_reads', 'mail_link_clicks'];

/**
 * Turn statistics into findings. PURE — every branch is unit-testable without a database.
 *
 * The sequential-scan rule deliberately requires BOTH a high ratio and a large table. A small table
 * scanned constantly is the planner making the correct choice, and "add an index" on it is advice
 * that makes writes slower for no read benefit. Most naive missing-index detectors get this wrong.
 */
export function analyzeTables(stats: readonly TableStat[], t: AnalysisThresholds = DEFAULT_ANALYSIS, now: number = Date.now()): Finding[] {
  const findings: Finding[] = [];

  for (const s of stats) {
    const totalScans = s.seqScans + s.indexScans;
    const seqRatio = totalScans > 0 ? s.seqScans / totalScans : 0;

    if (s.liveRows >= t.seqScanRowThreshold && seqRatio >= t.seqScanRatio && s.seqScans > 0) {
      findings.push({
        kind: 'sequential_scan',
        table: s.table,
        severity: s.liveRows > 1_000_000 ? 'critical' : 'warning',
        detail: s.table + ' is scanned sequentially ' + (seqRatio * 100).toFixed(0) + '% of the time with ~' + s.liveRows.toLocaleString() + ' live rows; ' + s.seqRowsRead.toLocaleString() + ' rows have been read that way.',
        recommendation: 'Identify the predicate from pg_stat_statements and index it. Confirm with EXPLAIN (ANALYZE, BUFFERS) before and after — an index that the planner does not choose is pure write cost.',
        evidence: { liveRows: s.liveRows, seqScans: s.seqScans, indexScans: s.indexScans, seqRatio: Number(seqRatio.toFixed(3)) },
      });
    }

    if (s.liveRows > 1000 && s.deadRows / Math.max(1, s.liveRows) >= t.deadTupleRatio) {
      findings.push({
        kind: 'dead_tuples',
        table: s.table,
        severity: 'warning',
        detail: s.table + ' holds ' + s.deadRows.toLocaleString() + ' dead tuples against ' + s.liveRows.toLocaleString() + ' live (' + ((s.deadRows / Math.max(1, s.liveRows)) * 100).toFixed(0) + '%). Dead tuples are read by every sequential scan and inflate the index.',
        recommendation: 'VACUUM (ANALYZE) ' + s.table + '; — and if it recurs, autovacuum is not keeping up: lower autovacuum_vacuum_scale_factor for this table rather than vacuuming it by hand on a schedule.',
        evidence: { liveRows: s.liveRows, deadRows: s.deadRows, lastAutovacuum: s.lastAutovacuum },
      });
    }

    const analyzedAt = s.lastAnalyze ? Date.parse(s.lastAnalyze) : null;
    if (s.liveRows > 10_000 && (analyzedAt === null || now - analyzedAt > t.staleAnalyzeDays * 86_400_000)) {
      findings.push({
        kind: 'unvacuumed',
        table: s.table,
        severity: 'info',
        detail: s.table + ' has not been analyzed ' + (analyzedAt === null ? 'ever, as far as the statistics collector knows' : 'for ' + Math.floor((now - analyzedAt) / 86_400_000) + ' days') + '. The planner is choosing plans from stale row estimates.',
        recommendation: 'ANALYZE ' + s.table + ';',
        evidence: { liveRows: s.liveRows, lastAnalyze: s.lastAnalyze },
      });
    }

    if (s.totalBytes >= t.largeTableBytes) {
      findings.push({
        kind: 'large_table',
        table: s.table,
        severity: 'info',
        detail: s.table + ' occupies ' + formatBytes(s.totalBytes) + ' (' + formatBytes(s.indexBytes) + ' of that is indexes).',
        recommendation: 'Check retention: does this table need every row it holds? Deleting from a large hot table is expensive — see the partitioning note if it is append-only.',
        evidence: { totalBytes: s.totalBytes, indexBytes: s.indexBytes, liveRows: s.liveRows },
      });
    }

    if (APPEND_ONLY_TABLES.includes(s.table) && s.liveRows >= t.partitionRowThreshold) {
      findings.push({
        kind: 'partition_candidate',
        table: s.table,
        severity: 'warning',
        detail: s.table + ' is append-only and holds ~' + s.liveRows.toLocaleString() + ' rows. Retention on an unpartitioned table of this size is a bulk DELETE followed by hours of vacuum, against a table that is still being written to.',
        recommendation: 'Partition by month on the timestamp column. mailplatform/events.ts EVENT_DDL already carries a worked example (mp_event_stream); this table does not, and converting later requires copying every row.',
        evidence: { liveRows: s.liveRows, totalBytes: s.totalBytes },
      });
    }
  }

  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.table.localeCompare(b.table));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? Math.round(v) : Number(v.toFixed(1))) + ' ' + units[i];
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

export interface IndexStat { table: string; index: string; scans: number; sizeBytes: number; isUnique: boolean; isPrimary: boolean }

export async function indexStats(tables: readonly string[] = MAIL_TABLES): Promise<{ ok: boolean; indexes: IndexStat[]; error?: string }> {
  try {
    const { db, sql } = await ctx();
    const list = sql.join(tables.map((t) => sql`${t}`), sql`, `);
    const r = rows(await db.execute(sql`
      SELECT s.relname AS table_name, s.indexrelname AS index_name, s.idx_scan,
             pg_relation_size(s.indexrelid) AS size_bytes,
             i.indisunique AS is_unique, i.indisprimary AS is_primary
      FROM pg_stat_user_indexes s
      JOIN pg_index i ON i.indexrelid = s.indexrelid
      WHERE s.relname IN (${list})
      ORDER BY s.idx_scan ASC, pg_relation_size(s.indexrelid) DESC`));
    return {
      ok: true,
      indexes: r.map((x) => ({
        table: String(x.table_name), index: String(x.index_name), scans: n(x.idx_scan),
        sizeBytes: n(x.size_bytes), isUnique: x.is_unique === true, isPrimary: x.is_primary === true,
      })),
    };
  } catch (e) {
    return { ok: false, indexes: [], error: reason(e) };
  }
}

/**
 * Indexes that have never been used.
 *
 * NEVER recommends dropping a UNIQUE or PRIMARY index, whatever its scan count. Those exist to
 * enforce a constraint, not to serve a query — `edu_jobs.dedup_key` is the idempotency guarantee for
 * the entire queue and its scan count is irrelevant. Dropping it because a statistics view called it
 * unused would allow duplicate sends, which is the worst outcome available to a mail system.
 *
 * Also: statistics are cumulative since the last `pg_stat_reset()`, so on a recently reset or
 * recently deployed database everything looks unused. That caveat travels with the finding.
 */
export function unusedIndexes(indexes: readonly IndexStat[], minSizeBytes = 1024 * 1024): Finding[] {
  return indexes
    .filter((i) => i.scans === 0 && !i.isUnique && !i.isPrimary && i.sizeBytes >= minSizeBytes)
    .map((i) => ({
      kind: 'unused_index' as const,
      table: i.table,
      severity: 'info' as const,
      detail: 'Index ' + i.index + ' on ' + i.table + ' (' + formatBytes(i.sizeBytes) + ') has recorded zero scans. Every insert into ' + i.table + ' pays to maintain it.',
      recommendation: 'Confirm the counter has had time to accumulate (statistics are cumulative since the last pg_stat_reset), then: DROP INDEX CONCURRENTLY ' + i.index + ';',
      evidence: { scans: 0, sizeBytes: i.sizeBytes },
    }));
}

// ---------------------------------------------------------------------------
// Locks and deadlocks
// ---------------------------------------------------------------------------

export interface LockSignals {
  ok: boolean;
  waiting: number;
  longestWaitSeconds: number | null;
  deadlocks: number | null;
  blockedQueries: { pid: number; waitEvent: string | null; waitSeconds: number; query: string }[];
  error?: string;
}

/**
 * Current lock waits and the database's cumulative deadlock count.
 *
 * The deadlock counter comes from pg_stat_database and is CUMULATIVE since the last reset, so a
 * non-zero value is not necessarily current — it is reported as a total, and the reader is told so.
 * The queue's `FOR UPDATE SKIP LOCKED` should keep this at zero; a rising number is the signal that
 * something is taking locks in an order the queue does not expect.
 */
export async function lockSignals(): Promise<LockSignals> {
  try {
    const { db, sql } = await ctx();
    const blocked = rows(await db.execute(sql`
      SELECT pid, wait_event, EXTRACT(EPOCH FROM (now() - state_change)) AS wait_seconds, LEFT(query, 200) AS query
      FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
      ORDER BY state_change ASC LIMIT 10`));
    let deadlocks: number | null = null;
    try {
      deadlocks = n(rows(await db.execute(sql`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`))[0]?.deadlocks);
    } catch { /* not exposed through every pooler; null rather than 0 — see the module header */ }
    const waits = blocked.map((b) => n(b.wait_seconds));
    return {
      ok: true,
      waiting: blocked.length,
      longestWaitSeconds: waits.length ? Math.max(...waits) : null,
      deadlocks,
      blockedQueries: blocked.map((b) => ({ pid: n(b.pid), waitEvent: b.wait_event ? String(b.wait_event) : null, waitSeconds: Math.round(n(b.wait_seconds)), query: String(b.query || '').replace(/\s+/g, ' ') })),
    };
  } catch (e) {
    return { ok: false, waiting: 0, longestWaitSeconds: null, deadlocks: null, blockedQueries: [], error: reason(e) };
  }
}

// ---------------------------------------------------------------------------
// The whole picture
// ---------------------------------------------------------------------------

export interface DbPerfReport {
  at: string;
  pool: Awaited<ReturnType<typeof poolSignals>>;
  slow: Awaited<ReturnType<typeof slowQueries>>;
  tables: TableStats;
  indexes: Awaited<ReturnType<typeof indexStats>>;
  locks: LockSignals;
  findings: Finding[];
  /** Read failures, so an empty findings list can be told apart from a clean bill of health. */
  unreadable: string[];
}

export async function dbPerfReport(): Promise<DbPerfReport> {
  const [pool, slow, tables, indexes, locks] = await Promise.all([
    poolSignals().catch(() => ({ available: false, total: 0, active: 0, idle: 0, idleInTransaction: 0, maxConnections: null, note: 'pool read failed' })),
    slowQueries(10).catch(() => ({ available: false, note: 'slow query read failed', rows: [] })),
    tableStats(),
    indexStats(),
    lockSignals(),
  ]);

  const unreadable: string[] = [];
  if (!tables.ok) unreadable.push('table statistics: ' + (tables.error || 'unknown'));
  if (!indexes.ok) unreadable.push('index statistics: ' + (indexes.error || 'unknown'));
  if (!locks.ok) unreadable.push('lock signals: ' + (locks.error || 'unknown'));
  if (!pool.available) unreadable.push('connection pool: ' + (pool.note || 'unavailable'));
  if (!slow.available) unreadable.push('slow queries: ' + slow.note);

  return {
    at: new Date().toISOString(),
    pool, slow, tables, indexes, locks,
    findings: [...analyzeTables(tables.tables), ...unusedIndexes(indexes.indexes)],
    unreadable,
  };
}
