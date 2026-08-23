// src/lib/fusion/schema.ts — THE FOUR TABLES THIS PATCH OWNS, AND NOTHING ELSE.
//
// =================================================================================================
// FOUR TABLES, AND WHY NONE OF THEM DUPLICATES SOMEBODY ELSE'S
// =================================================================================================
//
//   hif_weight_profiles     the source weighting in force, owned by a named person.
//   hif_snapshots           one computation of one person's profile, at one moment.
//   hif_readings            the ten readings inside a snapshot. THIS is what makes evolution possible.
//   hif_notes               a named human's written response to a reading. Beside it, never over it.
//
// WHAT IS DELIBERATELY ABSENT:
//
//   NO SIGNALS TABLE. A signal is DERIVED from a row another module owns, and storing it here would
//   make a second copy of somebody else's record that drifts the moment theirs changes. Signals are
//   gathered on every computation and kept only inside the snapshot's explanation JSON, which is a
//   record of WHAT WAS BELIEVED AT THE TIME rather than a mirror of anybody's table. This project has
//   already lost a year to two tables holding one fact — XP, course progress, chat_messages — and
//   src/lib/evidence-graph.ts refuses to add a `level` column for exactly this reason.
//
//   NO EMPLOYEE TABLE, NO SKILL TABLE, NO REVIEW TABLE, NO FEEDBACK TABLE. hr_employees, hr_skills,
//   hr_employee_skills, performance reviews and feedback all have owners. This module reads through
//   those owners' modules and stores foreign keys as plain columns — never a copy of their rows.
//
//   NO DECISION TABLE. A decision is not an intelligence output. src/lib/workflow.ts is the only
//   approval engine in this product and src/lib/application-stages.ts is the only thing that moves a
//   candidate. There is nowhere here to record that somebody was promoted or let go, and that
//   absence is the design.
//
// =================================================================================================
// DDL IS ADDITIVE, IDEMPOTENT, AND SENT AS ONE MESSAGE
// =================================================================================================
//
// ensureBatch() sends the whole block over the simple protocol in one round trip with a lock timeout,
// because the function region and the database region differ and each separate statement costs about
// 177ms. Twelve statements as twelve calls is two seconds a person waits for.
//
// ensureOnce SWALLOWS its failure so callers keep the tolerate-missing-schema behaviour the rest of
// this codebase relies on. That means a resolved ensure proves the promise settled, NOT that any DDL
// ran — so verifyFusionSchema() asks information_schema rather than trusting it. This project has
// shipped a bootstrap that reported `ok: true, ran: 8, failed: 0` while ten tables were missing.
//
// The same statements are in db/hif-fusion-schema.sql for the user to run by hand, which is the
// established pattern here for anything touching production.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureBatch } from '@/lib/ensure-once';
import { textIn } from '@/lib/pg-array';

export const MOD = 'fusion/schema';

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
export const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
export const logFail = (tag: string, e: any) =>
  console.error('[' + MOD + '] ' + tag, e?.cause?.message || e?.message);

export const FUSION_TABLES = [
  'hif_weight_profiles',
  'hif_snapshots',
  'hif_readings',
  'hif_notes',
] as const;

// -------------------------------------------------------------------------------------------------
// THE DDL. Every statement IF NOT EXISTS; every column addition ADD COLUMN IF NOT EXISTS.
// -------------------------------------------------------------------------------------------------

const DDL_WEIGHTS = `
CREATE TABLE IF NOT EXISTS hif_weight_profiles (
  key             TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  owner_user_id   UUID NOT NULL,
  weights         JSONB NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// owner_user_id is NOT NULL on purpose. A weighting with no owner is an unattributed policy about
// people, and saveWeightProfile() refuses one before it ever reaches this table.

const DDL_SNAPSHOTS = `
CREATE TABLE IF NOT EXISTS hif_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID NOT NULL,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  weight_profile_key  TEXT NOT NULL,
  weights             JSONB NOT NULL,
  dimensions_read     INT NOT NULL DEFAULT 0,
  signals_used        INT NOT NULL DEFAULT 0,
  signals_refused     INT NOT NULL DEFAULT 0,
  providers_missing   INT NOT NULL DEFAULT 0,
  computed_by_user_id UUID,
  reason              TEXT
);
CREATE INDEX IF NOT EXISTS hif_snapshots_emp ON hif_snapshots (employee_id, computed_at DESC);
`;

// `weights` is stored ON the snapshot as well as named by key, because a stored profile can be
// edited afterwards and a reading has to stay explainable against the weighting it was ACTUALLY
// produced under. A snapshot that pointed only at a key would silently re-explain itself every time
// somebody changed the policy.

const DDL_READINGS = `
CREATE TABLE IF NOT EXISTS hif_readings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id           UUID NOT NULL,
  employee_id           UUID NOT NULL,
  dimension             TEXT NOT NULL,
  status                TEXT NOT NULL,
  reading               INT,
  confidence_value      INT NOT NULL DEFAULT 0,
  confidence_band       TEXT NOT NULL DEFAULT 'insufficient',
  confidence_direction  TEXT NOT NULL DEFAULT 'first_reading',
  independent_sources   INT NOT NULL DEFAULT 0,
  sentence              TEXT NOT NULL,
  payload               JSONB NOT NULL,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS hif_readings_one ON hif_readings (snapshot_id, dimension);
CREATE INDEX IF NOT EXISTS hif_readings_evolution ON hif_readings (employee_id, dimension, computed_at DESC);
`;

// `reading` is NULLABLE and that is the whole point: a dimension that could not be read has no
// number. A NOT NULL DEFAULT 0 here would have turned every absence in this system into a finding of
// zero about a person, permanently, in the storage layer where nobody would think to look for it.
//
// hif_readings_evolution is the index the whole "profile evolution over time" feature rests on: one
// person, one dimension, newest first.

const DDL_NOTES = `
CREATE TABLE IF NOT EXISTS hif_notes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID NOT NULL,
  dimension           TEXT,
  author_user_id      UUID NOT NULL,
  author_relationship TEXT,
  stance              TEXT NOT NULL,
  body                TEXT NOT NULL,
  written_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hif_notes_emp ON hif_notes (employee_id, written_at DESC);
`;

// NO UNIQUE CONSTRAINT ON (employee_id, dimension, author_user_id), deliberately. A person may write
// twice, and the second note does not replace the first: "I said X in March and Y in August" is the
// record, and collapsing it would be this module editing somebody's stated view after the fact.
//
// There is no `weight` column and no `is_authoritative` column. One person's feedback never becomes
// organisational truth, and a column that could make it so is a column somebody would eventually set.

const FUSION_DDL = DDL_WEIGHTS + DDL_SNAPSHOTS + DDL_READINGS + DDL_NOTES;

export function ensureFusionSchema(): Promise<void> {
  return ensureBatch('hif_fusion_v1', FUSION_DDL);
}

// -------------------------------------------------------------------------------------------------
// WHAT IS ACTUALLY THERE. ensureOnce swallows; this asks.
// -------------------------------------------------------------------------------------------------

const REQUIRED_COLUMNS: Record<string, string[]> = {
  hif_weight_profiles: ['key', 'label', 'owner_user_id', 'weights', 'updated_at'],
  hif_snapshots: ['id', 'employee_id', 'computed_at', 'weight_profile_key', 'weights', 'dimensions_read'],
  hif_readings: ['id', 'snapshot_id', 'employee_id', 'dimension', 'status', 'reading',
    'confidence_value', 'confidence_band', 'confidence_direction', 'sentence', 'payload', 'computed_at'],
  hif_notes: ['id', 'employee_id', 'author_user_id', 'stance', 'body', 'written_at'],
};

export interface FusionSchemaReport {
  ok: boolean;
  tables: { table: string; present: boolean; missingColumns: string[] }[];
  sentence: string;
  error?: string;
}

export async function verifyFusionSchema(): Promise<FusionSchemaReport> {
  try {
    const names = [...FUSION_TABLES];
    const cols = rowsOf(await db.execute(sql`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ${textIn(names)}`));

    const byTable = new Map<string, Set<string>>();
    for (const c of cols) {
      const t = String(c.table_name);
      if (!byTable.has(t)) byTable.set(t, new Set());
      byTable.get(t)!.add(String(c.column_name));
    }

    const tables = names.map((t) => {
      const have = byTable.get(t) || new Set<string>();
      return {
        table: t,
        present: have.size > 0,
        missingColumns: (REQUIRED_COLUMNS[t] || []).filter((c) => !have.has(c)),
      };
    });

    const bad = tables.filter((t) => !t.present || t.missingColumns.length > 0);
    return {
      ok: bad.length === 0,
      tables,
      sentence: bad.length === 0
        ? 'The intelligence profile tables are present with every column this module reads.'
        : bad.map((t) => t.present
          ? t.table + ' exists but is missing ' + t.missingColumns.join(', ')
          : t.table + ' does not exist').join('. ') + '. Run db/hif-fusion-schema.sql.',
    };
  } catch (e: any) {
    logFail('verifyFusionSchema', e);
    return {
      ok: false,
      tables: [],
      sentence: 'We could not read the database schema, so we cannot say what is present. That is a '
        + 'failure to look, not a report that the tables are missing.',
      error: e?.cause?.message || e?.message || 'unreadable',
    };
  }
}
