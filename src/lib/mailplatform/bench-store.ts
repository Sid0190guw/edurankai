// src/lib/mailplatform/bench-store.ts — where a benchmark result lives so a screen can read it.
//
// SPLIT FROM capacity.ts DELIBERATELY. capacity.ts is pure and has no database import, which is what
// lets its 34 tests run without a connection. The moment it imports `@/lib/db` that stops being
// true, so persistence lives here instead.
//
// WHY A TABLE AND NOT A FILE. The benchmark runs on a laptop or a CI box; the admin screen renders
// on Vercel. There is no shared filesystem between them, so a JSON file on disk is invisible to the
// surface that needs it — the "engine that is not reachable from a screen" failure this project
// keeps hitting. The runner POSTs its report to /api/admin/mail/bench-report and it lands here.
//
// APPEND-ONLY, AND SMALL. One row per run, newest read first. Benchmark history is the only way to
// see a regression — a single "latest" row would answer "how fast is it" and never "is it getting
// slower", which is the more useful question.

import type { CapacityReport } from './capacity';
// Millisecond-safe date formatting. See the long note on toIso() in ./events.ts: postgres-js hands
// back a JS Date for timestamptz, and `new Date(String(date))` silently truncates to the second.
import { toIso } from './events';

const rows = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] })?.rows || []));
const reason = (e: unknown): string => {
  const err = e as { cause?: { message?: string }; message?: string };
  return String(err?.cause?.message || err?.message || 'unknown error');
};

const DDL = [
  `CREATE TABLE IF NOT EXISTS mp_bench_reports (
    id bigserial PRIMARY KEY,
    generated_at timestamptz NOT NULL,
    environment text,
    label text,
    messages_per_sec double precision,
    highest_sustained_tier text,
    report jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS mp_bench_reports_time_idx ON mp_bench_reports (generated_at DESC)`,
];

let ready = false;
async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  if (!ready) { for (const d of DDL) await db.execute(sql.raw(d)); ready = true; }
  return { db, sql };
}

export interface StoredBenchReport {
  id: number;
  generatedAt: string;
  environment: string | null;
  label: string | null;
  messagesPerSec: number | null;
  highestSustainedTier: string | null;
  report: CapacityReport;
}

export async function saveBenchReport(report: CapacityReport, label?: string): Promise<{ ok: boolean; id?: number; error?: string }> {
  try {
    const { db, sql } = await ctx();
    const sustained = report.tiers.filter((t) => t.verdict === 'sustained');
    const top = sustained.length ? sustained[sustained.length - 1].tier.label : null;
    const r = rows(await db.execute(sql`
      INSERT INTO mp_bench_reports (generated_at, environment, label, messages_per_sec, highest_sustained_tier, report)
      VALUES (${report.generatedAt}::timestamptz, ${report.configuration.environment}, ${label ?? null},
              ${report.throughput.messagesPerSec}, ${top}, ${JSON.stringify(report)}::jsonb)
      RETURNING id`));
    return { ok: true, id: Number(r[0]?.id) };
  } catch (e) {
    return { ok: false, error: reason(e) };
  }
}

/**
 * The most recent report, or null.
 *
 * `ok: false` and `report: null` are different states and the caller must show them differently: one
 * is "no benchmark has been run", the other is "the benchmark history could not be read". The screen
 * that conflates them tells an operator there is no evidence when the truth is that it could not look.
 */
export async function latestBenchReport(): Promise<{ ok: boolean; report: StoredBenchReport | null; error?: string }> {
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      SELECT id, generated_at, environment, label, messages_per_sec, highest_sustained_tier, report
      FROM mp_bench_reports ORDER BY generated_at DESC, id DESC LIMIT 1`));
    if (!r.length) return { ok: true, report: null };
    const row = r[0];
    return {
      ok: true,
      report: {
        id: Number(row.id),
        generatedAt: toIso(row.generated_at),
        environment: row.environment ? String(row.environment) : null,
        label: row.label ? String(row.label) : null,
        messagesPerSec: row.messages_per_sec === null || row.messages_per_sec === undefined ? null : Number(row.messages_per_sec),
        highestSustainedTier: row.highest_sustained_tier ? String(row.highest_sustained_tier) : null,
        report: (typeof row.report === 'string' ? JSON.parse(row.report) : row.report) as CapacityReport,
      },
    };
  } catch (e) {
    return { ok: false, report: null, error: reason(e) };
  }
}

/** Recent runs, for spotting a regression. Report body omitted — this is a list, not a detail view. */
export async function benchHistory(limit = 10): Promise<{ ok: boolean; runs: Omit<StoredBenchReport, 'report'>[]; error?: string }> {
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      SELECT id, generated_at, environment, label, messages_per_sec, highest_sustained_tier
      FROM mp_bench_reports ORDER BY generated_at DESC, id DESC LIMIT ${Math.min(50, Math.max(1, limit))}`));
    return {
      ok: true,
      runs: r.map((row) => ({
        id: Number(row.id),
        generatedAt: toIso(row.generated_at),
        environment: row.environment ? String(row.environment) : null,
        label: row.label ? String(row.label) : null,
        messagesPerSec: row.messages_per_sec === null || row.messages_per_sec === undefined ? null : Number(row.messages_per_sec),
        highestSustainedTier: row.highest_sustained_tier ? String(row.highest_sustained_tier) : null,
      })),
    };
  } catch (e) {
    return { ok: false, runs: [], error: reason(e) };
  }
}
