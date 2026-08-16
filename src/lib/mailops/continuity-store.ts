// src/lib/mailops/continuity-store.ts — the ledger behind the continuity surface.
//
// WHAT THIS EXISTS TO SOLVE. The backup and restore work happens on the founder's machine, because
// no agent and no process in this repository may open the production database. That rule is
// non-negotiable here and it has a cost: the platform has no idea whether any of it happened. A
// screen that says "backups: configured" while nothing has run since March is worse than no screen.
//
// So the scripts REPORT. Each one POSTs its outcome to /api/mailops/report with the machine secret,
// and the rows below are what the continuity page reads. The platform never takes the backup; it
// records that one was taken, and — the part that matters — records whether a restore of it was
// ever proved to work.
//
// EVERY READ REPORTS ITS OWN FAILURE. Not one function here returns an empty array on a caught
// exception. /admin/mail/health once rendered "0 inbound, 0 outbound, last never" over a thrown
// query, which is the most alarming state the system can be in drawn to look exactly like the
// calmest one. The shape used instead is { ok, rows, error } and the surface prints the error.
//
// postgres-js RETURNS PLAIN ARRAYS. `r.rows[0]` is undefined against this driver; the normaliser
// below is the house pattern and it is not optional. The real Postgres reason is on `e.cause` —
// `e.message` is only the failed SQL.

import type { AssetClass } from './objectives';
import type { BackupArtefact, RestoreCheck, RestoreTest } from './backup';
import type { ComponentId } from './failure-model';
import type { MigrationId, MigrationReport } from './migration';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export interface ReadResult<T> {
  ok: boolean;
  data: T;
  /** Present when ok is false. The surface prints this rather than drawing a zero. */
  error?: string;
}

const DDL = [
  // One row per backup artefact the scripts produce. `ok` false rows are kept deliberately — a
  // failed backup is a fact the page has to show, and deleting it makes the history look clean.
  `CREATE TABLE IF NOT EXISTS mailops_backup_runs (
     id text PRIMARY KEY,
     asset_class text NOT NULL,
     taken_at timestamptz NOT NULL,
     finished_at timestamptz,
     ok boolean NOT NULL DEFAULT true,
     size_bytes bigint,
     location text NOT NULL DEFAULT '',
     encrypted boolean NOT NULL DEFAULT false,
     offsite boolean NOT NULL DEFAULT false,
     checksum text,
     error text,
     reported_by text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS mailops_backup_runs_asset_idx ON mailops_backup_runs (asset_class, taken_at DESC)`,

  // One row per restore test. This table is the only thing that turns a copy into a backup.
  `CREATE TABLE IF NOT EXISTS mailops_restore_tests (
     id text PRIMARY KEY,
     asset_class text NOT NULL,
     artefact_id text,
     started_at timestamptz NOT NULL,
     finished_at timestamptz,
     ok boolean NOT NULL DEFAULT false,
     checks jsonb NOT NULL DEFAULT '[]'::jsonb,
     duration_seconds integer,
     artefact_age_seconds integer,
     target text NOT NULL DEFAULT '',
     notes text,
     reported_by text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS mailops_restore_tests_asset_idx ON mailops_restore_tests (asset_class, finished_at DESC)`,

  // Overrides of the default RPO/RTO targets. The BASIS is not stored — it is a fact about what has
  // been demonstrated, not a preference, so it stays in code where it cannot be edited into
  // something flattering from a form.
  `CREATE TABLE IF NOT EXISTS mailops_objectives (
     asset_class text PRIMARY KEY,
     rpo_seconds integer NOT NULL,
     rto_seconds integer NOT NULL,
     updated_by text,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  // Migration runs, with the verification report attached as JSON so the decision that was taken
  // can be reconstructed later, not just its outcome.
  `CREATE TABLE IF NOT EXISTS mailops_migration_runs (
     id text PRIMARY KEY,
     migration_id text NOT NULL,
     status text NOT NULL DEFAULT 'planned',
     stage text,
     report jsonb,
     verified boolean NOT NULL DEFAULT false,
     cutover_at timestamptz,
     decommissioned_at timestamptz,
     notes text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  // What the mail host last said about itself. One row per component, overwritten.
  `CREATE TABLE IF NOT EXISTS mailops_component_status (
     component text PRIMARY KEY,
     state text NOT NULL,
     detail text NOT NULL DEFAULT '',
     observed_at timestamptz NOT NULL DEFAULT now(),
     source text
   )`,
];

let _ready = false;

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  if (!_ready) {
    for (const stmt of DDL) await db.execute(sql.raw(stmt));
    _ready = true;
  }
  return { db, sql };
}

// ---------------------------------------------------------------------------
// Backup artefacts
// ---------------------------------------------------------------------------

export interface BackupRunInput {
  id: string;
  assetClass: AssetClass;
  takenAt: string;
  finishedAt?: string | null;
  ok: boolean;
  sizeBytes?: number | null;
  location: string;
  encrypted: boolean;
  offsite: boolean;
  checksum?: string | null;
  error?: string | null;
  reportedBy?: string | null;
}

export async function recordBackupRun(input: BackupRunInput): Promise<{ ok: boolean; error?: string }> {
  try {
    const { db, sql } = await ctx();
    await db.execute(sql`
      INSERT INTO mailops_backup_runs
        (id, asset_class, taken_at, finished_at, ok, size_bytes, location, encrypted, offsite, checksum, error, reported_by)
      VALUES
        (${input.id}, ${input.assetClass}, ${input.takenAt}, ${input.finishedAt ?? null}, ${input.ok},
         ${input.sizeBytes ?? null}, ${input.location}, ${input.encrypted}, ${input.offsite},
         ${input.checksum ?? null}, ${input.error ?? null}, ${input.reportedBy ?? null})
      ON CONFLICT (id) DO UPDATE SET
        finished_at = EXCLUDED.finished_at, ok = EXCLUDED.ok, size_bytes = EXCLUDED.size_bytes,
        location = EXCLUDED.location, encrypted = EXCLUDED.encrypted, offsite = EXCLUDED.offsite,
        checksum = EXCLUDED.checksum, error = EXCLUDED.error
    `);
    return { ok: true };
  } catch (e: any) {
    console.error('[mailops/continuity-store] recordBackupRun failed:', reasonOf(e));
    return { ok: false, error: reasonOf(e) };
  }
}

export async function listBackupArtefacts(limit = 200): Promise<ReadResult<BackupArtefact[]>> {
  try {
    const { db, sql } = await ctx();
    const r = await db.execute(sql`
      SELECT id, asset_class, taken_at, size_bytes, location, encrypted, offsite, checksum, ok, error
      FROM mailops_backup_runs
      ORDER BY taken_at DESC
      LIMIT ${limit}
    `);
    const data = rows(r)
      // A failed run is not an artefact. It stays in the table as history, but it must never be
      // counted as a copy that exists — that is how a retention policy ends up "keeping" nothing.
      .filter((x: any) => x.ok !== false)
      .map((x: any): BackupArtefact => ({
        id: String(x.id),
        assetClass: String(x.asset_class) as AssetClass,
        takenAt: new Date(x.taken_at).toISOString(),
        sizeBytes: x.size_bytes == null ? null : Number(x.size_bytes),
        location: String(x.location || ''),
        encrypted: !!x.encrypted,
        checksum: x.checksum ? String(x.checksum) : null,
        offsite: !!x.offsite,
      }));
    return { ok: true, data };
  } catch (e: any) {
    console.error('[mailops/continuity-store] listBackupArtefacts failed:', reasonOf(e));
    return { ok: false, data: [], error: reasonOf(e) };
  }
}

export async function listFailedBackupRuns(limit = 20): Promise<ReadResult<{ id: string; assetClass: string; takenAt: string; error: string }[]>> {
  try {
    const { db, sql } = await ctx();
    const r = await db.execute(sql`
      SELECT id, asset_class, taken_at, error FROM mailops_backup_runs
      WHERE ok = false ORDER BY taken_at DESC LIMIT ${limit}
    `);
    return {
      ok: true,
      data: rows(r).map((x: any) => ({
        id: String(x.id),
        assetClass: String(x.asset_class),
        takenAt: new Date(x.taken_at).toISOString(),
        error: String(x.error || 'no reason recorded'),
      })),
    };
  } catch (e: any) {
    console.error('[mailops/continuity-store] listFailedBackupRuns failed:', reasonOf(e));
    return { ok: false, data: [], error: reasonOf(e) };
  }
}

// ---------------------------------------------------------------------------
// Restore tests
// ---------------------------------------------------------------------------

export interface RestoreTestInput {
  id: string;
  assetClass: AssetClass;
  artefactId?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  ok: boolean;
  checks: RestoreCheck[];
  durationSeconds?: number | null;
  artefactAgeSeconds?: number | null;
  target: string;
  notes?: string | null;
  reportedBy?: string | null;
}

export async function recordRestoreTest(input: RestoreTestInput): Promise<{ ok: boolean; error?: string }> {
  try {
    const { db, sql } = await ctx();
    await db.execute(sql`
      INSERT INTO mailops_restore_tests
        (id, asset_class, artefact_id, started_at, finished_at, ok, checks, duration_seconds, artefact_age_seconds, target, notes, reported_by)
      VALUES
        (${input.id}, ${input.assetClass}, ${input.artefactId ?? null}, ${input.startedAt}, ${input.finishedAt ?? null},
         ${input.ok}, ${JSON.stringify(input.checks || [])}::jsonb, ${input.durationSeconds ?? null},
         ${input.artefactAgeSeconds ?? null}, ${input.target}, ${input.notes ?? null}, ${input.reportedBy ?? null})
      ON CONFLICT (id) DO UPDATE SET
        finished_at = EXCLUDED.finished_at, ok = EXCLUDED.ok, checks = EXCLUDED.checks,
        duration_seconds = EXCLUDED.duration_seconds, artefact_age_seconds = EXCLUDED.artefact_age_seconds,
        notes = EXCLUDED.notes
    `);
    return { ok: true };
  } catch (e: any) {
    console.error('[mailops/continuity-store] recordRestoreTest failed:', reasonOf(e));
    return { ok: false, error: reasonOf(e) };
  }
}

export async function listRestoreTests(limit = 200): Promise<ReadResult<RestoreTest[]>> {
  try {
    const { db, sql } = await ctx();
    const r = await db.execute(sql`
      SELECT id, asset_class, artefact_id, started_at, finished_at, ok, checks,
             duration_seconds, artefact_age_seconds, target, notes
      FROM mailops_restore_tests
      ORDER BY COALESCE(finished_at, started_at) DESC
      LIMIT ${limit}
    `);
    const data = rows(r).map((x: any): RestoreTest => ({
      id: String(x.id),
      assetClass: String(x.asset_class) as AssetClass,
      artefactId: x.artefact_id ? String(x.artefact_id) : null,
      startedAt: new Date(x.started_at).toISOString(),
      finishedAt: x.finished_at ? new Date(x.finished_at).toISOString() : null,
      ok: !!x.ok,
      checks: Array.isArray(x.checks) ? x.checks : [],
      durationSeconds: x.duration_seconds == null ? null : Number(x.duration_seconds),
      artefactAgeSeconds: x.artefact_age_seconds == null ? null : Number(x.artefact_age_seconds),
      target: String(x.target || ''),
      notes: x.notes ? String(x.notes) : null,
    }));
    return { ok: true, data };
  } catch (e: any) {
    console.error('[mailops/continuity-store] listRestoreTests failed:', reasonOf(e));
    return { ok: false, data: [], error: reasonOf(e) };
  }
}

// ---------------------------------------------------------------------------
// Objective overrides
// ---------------------------------------------------------------------------

export async function listObjectiveOverrides(): Promise<ReadResult<Record<string, { rpoSeconds: number; rtoSeconds: number }>>> {
  try {
    const { db, sql } = await ctx();
    const r = await db.execute(sql`SELECT asset_class, rpo_seconds, rto_seconds FROM mailops_objectives`);
    const data: Record<string, { rpoSeconds: number; rtoSeconds: number }> = {};
    for (const x of rows(r)) {
      data[String(x.asset_class)] = { rpoSeconds: Number(x.rpo_seconds), rtoSeconds: Number(x.rto_seconds) };
    }
    return { ok: true, data };
  } catch (e: any) {
    console.error('[mailops/continuity-store] listObjectiveOverrides failed:', reasonOf(e));
    return { ok: false, data: {}, error: reasonOf(e) };
  }
}

export async function setObjective(
  assetClass: AssetClass,
  rpoSeconds: number,
  rtoSeconds: number,
  updatedBy: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { db, sql } = await ctx();
    await db.execute(sql`
      INSERT INTO mailops_objectives (asset_class, rpo_seconds, rto_seconds, updated_by, updated_at)
      VALUES (${assetClass}, ${Math.max(0, Math.round(rpoSeconds))}, ${Math.max(0, Math.round(rtoSeconds))}, ${updatedBy}, now())
      ON CONFLICT (asset_class) DO UPDATE SET
        rpo_seconds = EXCLUDED.rpo_seconds, rto_seconds = EXCLUDED.rto_seconds,
        updated_by = EXCLUDED.updated_by, updated_at = now()
    `);
    return { ok: true };
  } catch (e: any) {
    console.error('[mailops/continuity-store] setObjective failed:', reasonOf(e));
    return { ok: false, error: reasonOf(e) };
  }
}

// ---------------------------------------------------------------------------
// Component status, as last reported by the mail host
// ---------------------------------------------------------------------------

export interface ComponentStatusRow {
  component: ComponentId;
  state: 'up' | 'down' | 'degraded' | 'unknown';
  detail: string;
  observedAt: string;
  source: string | null;
}

export async function recordComponentStatus(
  component: ComponentId,
  state: ComponentStatusRow['state'],
  detail: string,
  source: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { db, sql } = await ctx();
    await db.execute(sql`
      INSERT INTO mailops_component_status (component, state, detail, observed_at, source)
      VALUES (${component}, ${state}, ${detail.slice(0, 500)}, now(), ${source})
      ON CONFLICT (component) DO UPDATE SET
        state = EXCLUDED.state, detail = EXCLUDED.detail, observed_at = now(), source = EXCLUDED.source
    `);
    return { ok: true };
  } catch (e: any) {
    console.error('[mailops/continuity-store] recordComponentStatus failed:', reasonOf(e));
    return { ok: false, error: reasonOf(e) };
  }
}

/**
 * What the mail host last said, and how long ago.
 *
 * STALENESS IS THE POINT. A row saying 'up' from four hours ago is not evidence that anything is up
 * — it is evidence that something was up four hours ago and has said nothing since, which on a
 * single-laptop deployment is the exact signature of the lid being closed. Callers get
 * `staleAfterSeconds` and must treat anything older as 'unknown', not as the last state.
 */
export async function listComponentStatus(staleAfterSeconds = 600): Promise<ReadResult<{ statuses: ComponentStatusRow[]; stale: ComponentId[] }>> {
  try {
    const { db, sql } = await ctx();
    const r = await db.execute(sql`SELECT component, state, detail, observed_at, source FROM mailops_component_status`);
    const now = Date.now();
    const statuses: ComponentStatusRow[] = [];
    const stale: ComponentId[] = [];
    for (const x of rows(r)) {
      const observedAt = new Date(x.observed_at);
      const component = String(x.component) as ComponentId;
      const isStale = (now - observedAt.getTime()) / 1000 > staleAfterSeconds;
      if (isStale) stale.push(component);
      statuses.push({
        component,
        state: isStale ? 'unknown' : (String(x.state) as ComponentStatusRow['state']),
        detail: isStale
          ? `Last reported ${Math.round((now - observedAt.getTime()) / 60000)} minutes ago and has said nothing since. Treated as unknown, not as ${x.state}.`
          : String(x.detail || ''),
        observedAt: observedAt.toISOString(),
        source: x.source ? String(x.source) : null,
      });
    }
    return { ok: true, data: { statuses, stale } };
  } catch (e: any) {
    console.error('[mailops/continuity-store] listComponentStatus failed:', reasonOf(e));
    return { ok: false, data: { statuses: [], stale: [] }, error: reasonOf(e) };
  }
}

// ---------------------------------------------------------------------------
// Migration runs
// ---------------------------------------------------------------------------

export interface MigrationRunRow {
  id: string;
  migrationId: MigrationId;
  status: 'planned' | 'copying' | 'verifying' | 'verified' | 'cutover' | 'soaking' | 'complete' | 'rolled_back';
  stage: string | null;
  report: MigrationReport | null;
  verified: boolean;
  cutoverAt: string | null;
  decommissionedAt: string | null;
  notes: string | null;
  updatedAt: string;
}

export async function upsertMigrationRun(row: {
  id: string;
  migrationId: MigrationId;
  status: MigrationRunRow['status'];
  stage?: string | null;
  report?: MigrationReport | null;
  verified?: boolean;
  cutoverAt?: string | null;
  decommissionedAt?: string | null;
  notes?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { db, sql } = await ctx();
    await db.execute(sql`
      INSERT INTO mailops_migration_runs (id, migration_id, status, stage, report, verified, cutover_at, decommissioned_at, notes, updated_at)
      VALUES (${row.id}, ${row.migrationId}, ${row.status}, ${row.stage ?? null},
              ${row.report ? JSON.stringify(row.report) : null}::jsonb, ${row.verified ?? false},
              ${row.cutoverAt ?? null}, ${row.decommissionedAt ?? null}, ${row.notes ?? null}, now())
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status, stage = EXCLUDED.stage,
        report = COALESCE(EXCLUDED.report, mailops_migration_runs.report),
        verified = EXCLUDED.verified, cutover_at = COALESCE(EXCLUDED.cutover_at, mailops_migration_runs.cutover_at),
        decommissioned_at = COALESCE(EXCLUDED.decommissioned_at, mailops_migration_runs.decommissioned_at),
        notes = EXCLUDED.notes, updated_at = now()
    `);
    return { ok: true };
  } catch (e: any) {
    console.error('[mailops/continuity-store] upsertMigrationRun failed:', reasonOf(e));
    return { ok: false, error: reasonOf(e) };
  }
}

export async function listMigrationRuns(limit = 50): Promise<ReadResult<MigrationRunRow[]>> {
  try {
    const { db, sql } = await ctx();
    const r = await db.execute(sql`
      SELECT id, migration_id, status, stage, report, verified, cutover_at, decommissioned_at, notes, updated_at
      FROM mailops_migration_runs ORDER BY updated_at DESC LIMIT ${limit}
    `);
    const data = rows(r).map((x: any): MigrationRunRow => ({
      id: String(x.id),
      migrationId: String(x.migration_id) as MigrationId,
      status: String(x.status) as MigrationRunRow['status'],
      stage: x.stage ? String(x.stage) : null,
      report: x.report || null,
      verified: !!x.verified,
      cutoverAt: x.cutover_at ? new Date(x.cutover_at).toISOString() : null,
      decommissionedAt: x.decommissioned_at ? new Date(x.decommissioned_at).toISOString() : null,
      notes: x.notes ? String(x.notes) : null,
      updatedAt: new Date(x.updated_at).toISOString(),
    }));
    return { ok: true, data };
  } catch (e: any) {
    console.error('[mailops/continuity-store] listMigrationRuns failed:', reasonOf(e));
    return { ok: false, data: [], error: reasonOf(e) };
  }
}
