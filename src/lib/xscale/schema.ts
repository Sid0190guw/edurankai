// src/lib/xscale/schema.ts — THE DIVISION LAYER AND THE EXTENDED ROLE COLUMNS.
//
// WHAT THIS ADDS TO A SCHEMA THAT ALREADY WORKS.
//
// The recruitment system here is real and in production: `departments` -> `roles` -> `applications`,
// with a six-step apply flow and an admin pipeline. Nothing in this module replaces any of that.
// It adds the one structural level the department needs and the site did not have —
//
//     departments  ->  DIVISIONS  ->  roles  ->  applications
//
// — plus the classification columns a research posting needs (research classification, scale range,
// skill categories, an explicit job status and a valid-through date), added to `roles` the way every
// other optional role facet on this project is added: ADDITIVE `ALTER ... ADD COLUMN IF NOT EXISTS`,
// outside the Drizzle schema, read through helpers that tolerate their absence.
//
// WHY NOT A NEW roles TABLE. Because a second postings table is a second everything: a second
// careers page, a second apply flow, a second admin console, a second set of application rows that
// /admin/applications cannot see. The brief is explicit that an existing system is to be integrated
// with rather than competed against, and this project already carries one unresolved fork of exactly
// that kind (tal_* against tos_*). One is enough.
//
// *** THIS DDL DOES NOT RUN IN PRODUCTION, AND THAT IS DELIBERATE. ***
//
// SCHEMA_BOOTSTRAP defaults to OFF in production (src/lib/ensure-once.ts) after a request-path DDL
// outage on 2026-08-23. ensureXscaleSchema() is therefore a no-op on the live site and every reader
// below is written to survive the tables and columns not existing. The migration is applied by hand,
// once, from db/xscale-schema.sql:
//
//     psql "$DATABASE_URL" -f db/xscale-schema.sql
//
// Keep that file and the DDL here IDENTICAL in effect. This constant is what local development and
// the test suite create their schema from; that file is what production runs.
import { ensureBatch } from '@/lib/ensure-once';

/**
 * Divisions, and the additive columns on `roles`.
 *
 * Every statement is idempotent, and every one of them is a no-op on the second run. The batch is
 * wrapped by ensureBatch in an explicit transaction with a 3s lock_timeout — see the long note in
 * ensure-once.ts about why an unbounded ALTER on `roles` is what took the site down.
 */
export const XSCALE_DDL = `
  CREATE TABLE IF NOT EXISTS divisions (
    id VARCHAR(60) PRIMARY KEY,
    department_id VARCHAR(50) NOT NULL,
    slug VARCHAR(120) NOT NULL,
    name VARCHAR(200) NOT NULL,
    code VARCHAR(20),
    summary TEXT NOT NULL DEFAULT '',
    charter TEXT NOT NULL DEFAULT '',
    research_classification VARCHAR(40),
    scale_min_exp INT,
    scale_max_exp INT,
    domains TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    skill_categories TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    collaborates_with TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    integrity_note TEXT NOT NULL DEFAULT '',
    sort_order INT NOT NULL DEFAULT 0,
    is_visible BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS divisions_slug_key ON divisions (slug);
  CREATE INDEX IF NOT EXISTS divisions_dept_idx ON divisions (department_id, sort_order);

  ALTER TABLE roles ADD COLUMN IF NOT EXISTS division_id VARCHAR(60);
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS research_classification VARCHAR(40);
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS scale_min_exp INT;
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS scale_max_exp INT;
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS skill_categories TEXT[];
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS career_level INT;
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS job_status VARCHAR(20);
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS valid_through TIMESTAMPTZ;
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS preferred_skills TEXT[];
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS tools TEXT[];
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS deliverables TEXT[];
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS evaluation_criteria TEXT[];
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS reporting_to VARCHAR(200);
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS collaborates_with TEXT[];
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS application_instructions TEXT;
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS integrity_note TEXT;

  CREATE INDEX IF NOT EXISTS roles_division_idx ON roles (division_id);
  CREATE INDEX IF NOT EXISTS roles_classification_idx ON roles (research_classification);
  CREATE INDEX IF NOT EXISTS roles_job_status_idx ON roles (job_status);
  CREATE INDEX IF NOT EXISTS roles_scale_idx ON roles (scale_min_exp, scale_max_exp);
`;

export const XSCALE_SCHEMA_KEY = 'xscale_divisions_v1';

export function ensureXscaleSchema(): Promise<void> {
  return ensureBatch(XSCALE_SCHEMA_KEY, XSCALE_DDL);
}

/** Every table and column this module needs, for the deployment check to report against. */
export const XSCALE_REQUIREMENTS = Object.freeze({
  tables: ['divisions'] as readonly string[],
  roleColumns: [
    'division_id', 'research_classification', 'scale_min_exp', 'scale_max_exp',
    'skill_categories', 'career_level', 'job_status', 'valid_through',
    'preferred_skills', 'tools', 'deliverables', 'evaluation_criteria',
    'reporting_to', 'collaborates_with', 'application_instructions', 'integrity_note',
  ] as readonly string[],
});

/**
 * Is the migration actually applied?
 *
 * NOT "did ensure() resolve". This project has already shipped a bootstrap that reported
 * `ok: true, ran: 8, failed: 0` while the health check said ten tables were missing, because every
 * ensure had thrown into a catch. This asks the catalogue instead, which is the only answer that
 * cannot be faked by a swallowed exception.
 */
export async function xscaleInstallStatus(): Promise<{
  installed: boolean;
  missingTables: string[];
  missingRoleColumns: string[];
  readable: boolean;
}> {
  const out = {
    installed: false,
    missingTables: [] as string[],
    missingRoleColumns: [] as string[],
    readable: false,
  };
  try {
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    const r: any = await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'divisions') AS has_divisions,
        (SELECT COALESCE(array_agg(column_name), ARRAY[]::text[]) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'roles') AS role_cols`);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    const row = rows[0];
    if (!row) return out;
    out.readable = true;
    if (!Number(row.has_divisions)) out.missingTables.push('divisions');
    const have = new Set<string>((row.role_cols || []).map((c: string) => String(c)));
    for (const c of XSCALE_REQUIREMENTS.roleColumns) if (!have.has(c)) out.missingRoleColumns.push(c);
    out.installed = out.missingTables.length === 0 && out.missingRoleColumns.length === 0;
    return out;
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[xscale] install status:', e?.cause?.message || e?.message);
    return out;
  }
}
