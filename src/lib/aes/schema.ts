// src/lib/aes/schema.ts — the one place the AES teaching engines create and then VERIFY their tables.
//
// ensureOnce() ends in p.catch(() => {}): a DDL failure inside it RESOLVES, and the caller reports
// success it never had. So the DDL runs under an ensureOnce key (one round trip per process, the
// house pattern) and the RESULT is then read back out of information_schema — the database saying
// what exists, not this file saying what it asked for. Only a verified-ok state is memoised; a
// state that is not ok is never cached, so the next call tries again.
import { ensureOnce } from '@/lib/ensure-once';

export interface AesTableState { name: string; present: boolean; missingColumns: string[] }
export interface AesSchemaState { ok: boolean; tables: AesTableState[]; error: string | null; checkedAt: string }

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

// db connects on FIRST USE behind a proxy; importing it dynamically keeps every pure helper in
// these modules unit-testable with no DATABASE_URL in the environment.
async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

export interface SchemaGuard {
  /** Create (additively) then verify. Returns the VERIFIED state — never a hopeful one. */
  ensure(): Promise<AesSchemaState>;
  /** The last verified state, or null if it has never verified in this process. */
  verified(): AesSchemaState | null;
}

/**
 * @param key      a NEW ensureOnce key (never reuse another module's)
 * @param ddl      additive statements only — CREATE TABLE IF NOT EXISTS / CREATE INDEX / ALTER ADD
 * @param required table -> the columns that must exist for the module to work
 */
export function makeSchemaGuard(key: string, ddl: string[], required: Record<string, string[]>): SchemaGuard {
  let verifiedState: AesSchemaState | null = null;
  let inflight: Promise<AesSchemaState> | null = null;

  async function verify(): Promise<AesSchemaState> {
    const { db, sql } = await ctx();
    const tables: AesTableState[] = [];
    for (const name of Object.keys(required)) {
      const found = rows(await db.execute(
        sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${name}`
      )).map((r: any) => String(r.column_name));
      const present = found.length > 0;
      const missingColumns = required[name].filter((c) => !found.includes(c));
      tables.push({ name, present, missingColumns });
    }
    const ok = tables.every((t) => t.present && t.missingColumns.length === 0);
    return { ok, tables, error: null, checkedAt: new Date().toISOString() };
  }

  async function run(): Promise<AesSchemaState> {
    try {
      await ensureOnce(key, async () => {
        const { db, sql } = await ctx();
        for (const stmt of ddl) await db.execute(sql.raw(stmt));
      });
      const state = await verify();
      if (state.ok) verifiedState = state;      // only a verified state is remembered
      return state;
    } catch (e: any) {
      // the real Postgres reason lives on e.cause
      return { ok: false, tables: [], error: e?.cause?.message || e?.message || 'schema check failed', checkedAt: new Date().toISOString() };
    }
  }

  return {
    verified: () => verifiedState,
    ensure: () => {
      if (verifiedState) return Promise.resolve(verifiedState);
      if (!inflight) inflight = run().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

/** Throw with the reason a write cannot proceed. Write paths call this instead of writing blind. */
export function assertSchema(state: AesSchemaState, what: string): void {
  if (state.ok) return;
  const missing = state.tables.filter((t) => !t.present || t.missingColumns.length)
    .map((t) => t.present ? `${t.name} missing ${t.missingColumns.join(', ')}` : `${t.name} absent`).join('; ');
  throw new Error(`${what}: AES schema not ready — ${state.error || missing || 'unverified'}`);
}
