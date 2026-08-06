// src/lib/hr/employee-code.ts — the ONE place an employee_code is minted.
//
// WHY THIS EXISTS. Two code paths created employees and both numbered them with
// `SELECT COUNT(*) FROM hr_employees` + 1:
//   - src/lib/hr/sync.ts, when an application turns 'hired'
//   - src/pages/admin/hr/employees/index.astro, the "Add employee" form
// hr_employees.employee_code is `TEXT NOT NULL UNIQUE` (db/hr-schema.sql:47), and COUNT(*) is wrong
// as a sequence in two ordinary situations:
//   1. A row has ever been deleted. Codes 0001..0005 exist, 0003 is removed, COUNT(*) is 4, so the
//      next hire is minted ERA-EMP-0005 — which already exists. The INSERT violates the unique
//      constraint and the whole hire is lost.
//   2. Two hires land at the same time. Both read the same COUNT, both mint the same code, and the
//      loser's INSERT throws.
// On the auto-hire path that exception was caught and written to console only, so the applicant
// showed "Hired" and no employee record existed — the failure mode that went unnoticed for eleven
// days on this project.
//
// MAX, NOT COUNT, and then a bounded retry. MAX of the numeric suffix is immune to deletions; the
// retry closes the race between two concurrent readers, which no single SELECT can. The retry is on
// the UNIQUE VIOLATION ONLY (SQLSTATE 23505 on the employee_code constraint) — any other failure is
// raised immediately rather than attempted five times.
//
// NO NEW TABLE AND NO SEQUENCE. A Postgres sequence would be the textbook answer, but the live
// hr_employees rows were numbered by the counter above, so a fresh sequence would start at 1 and
// collide with every existing code until it caught up. Deriving from MAX works against the data
// that is actually there.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const EMPLOYEE_CODE_PREFIX = 'ERA-EMP-';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

/** True when a thrown error is a Postgres unique violation. The code lives on e.cause, not e. */
export function isUniqueViolation(e: any): boolean {
  const code = e?.cause?.code || e?.code;
  return String(code || '') === '23505';
}

/**
 * The next free employee code, derived from the highest number already issued.
 *
 * Codes that do not match the house pattern (an import, a hand-typed one) are ignored by the MAX
 * rather than parsed, so one malformed row cannot push the counter to a wild value or throw a cast
 * error on every hire.
 */
export async function nextEmployeeCode(): Promise<string> {
  const r = await db.execute(sql`SELECT COALESCE(MAX(regexp_replace(employee_code, '^ERA-EMP-', '')::bigint), 0)::bigint AS mx
    FROM hr_employees WHERE employee_code ~ '^ERA-EMP-[0-9]+$'`);
  const mx = Number(rows(r)[0]?.mx || 0);
  return EMPLOYEE_CODE_PREFIX + String(mx + 1).padStart(4, '0');
}

/**
 * Run `attempt` with a freshly minted code, re-minting and retrying if another writer took it first.
 *
 * `attempt` must do exactly one INSERT and must not be otherwise repeatable — it is called again on
 * a unique violation, and on nothing else.
 */
export async function withEmployeeCode<T>(attempt: (code: string) => Promise<T>, tries = 5): Promise<T> {
  let last: any = null;
  for (let i = 0; i < Math.max(1, tries); i++) {
    const code = await nextEmployeeCode();
    try {
      return await attempt(code);
    } catch (e: any) {
      if (!isUniqueViolation(e)) throw e;
      last = e;
    }
  }
  throw last;
}
