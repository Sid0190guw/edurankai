// src/lib/talent/ids.ts — identifier allocation. Spec section 26A.
//
// THE GUARANTEE IS THE UNIQUE CONSTRAINT, NOT THE COUNTER. Every code column in
// src/lib/talent/schema.ts carries a UNIQUE index. This module is the allocator, and it allocates
// with a single atomic statement — an UPDATE ... RETURNING against tal_id_series, so two concurrent
// requests cannot read the same next_value. Read-then-write in application code would hand both of
// them 000042 and let the database reject the loser, which is survivable; what is NOT survivable is
// the version of that bug where the loser retries into a THIRD identifier and the sequence develops
// holes nobody can explain to an auditor.
//
// IMMUTABLE AND NEVER REUSED — spec 17.4 rule 3. There is no deallocate() in this file on purpose. A
// mistaken identity is voided, not renumbered: the code stays attached to the void so a letter
// bearing it still resolves.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureTalentSchema } from '@/lib/talent/schema';
import { ID_PREFIX, ID_PAD, YEARLESS_SERIES, rowsOf, reasonOf, type IdKind } from '@/lib/talent/types';

// Declared before use: `const` is not hoisted, and a handler reaching a later declaration has taken
// pages down on this project.
const MAX_ALLOC_ATTEMPTS = 3;

/**
 * PURE. Format a code from its parts. Exported so the format has a test that never opens a
 * connection, and so a screen can show what the next code will look like without allocating one.
 *
 *   formatCode('employee', 2184)          -> 'ERAI-EMP-002184'
 *   formatCode('opportunity', 421, 2026)  -> 'ERAI-OPP-2026-00421'
 */
export function formatCode(kind: IdKind, value: number, year?: number): string {
  const prefix = ID_PREFIX[kind];
  const pad = ID_PAD[kind];
  const body = String(Math.max(0, Math.floor(value))).padStart(pad, '0');
  if (YEARLESS_SERIES.includes(kind)) return prefix + '-' + body;
  const y = year && Number.isFinite(year) ? Math.floor(year) : new Date().getUTCFullYear();
  return prefix + '-' + y + '-' + body;
}

/**
 * PURE. Does this string look like a code of that kind? Used to tell "the operator pasted an
 * opportunity code into the candidate search" from "no such candidate", which are different answers.
 */
export function looksLikeCode(kind: IdKind, raw: unknown): boolean {
  const s = String(raw || '').trim().toUpperCase();
  const prefix = ID_PREFIX[kind];
  if (!s.startsWith(prefix + '-')) return false;
  const rest = s.slice(prefix.length + 1);
  return YEARLESS_SERIES.includes(kind)
    ? /^\d{4,10}$/.test(rest)
    : /^\d{4}-\d{4,10}$/.test(rest);
}

/**
 * PURE. Which kind of thing is this code, if any? ERAI-ONBCODE must be tested BEFORE ERAI-ONB or the
 * shorter prefix swallows it — the two share a stem and that is exactly the collision spec F11
 * splits apart.
 */
export function identifyCode(raw: unknown): IdKind | null {
  const s = String(raw || '').trim().toUpperCase();
  const kinds = Object.keys(ID_PREFIX) as IdKind[];
  const byLongestPrefix = kinds.slice().sort((a, b) => ID_PREFIX[b].length - ID_PREFIX[a].length);
  for (const k of byLongestPrefix) {
    if (s.startsWith(ID_PREFIX[k] + '-')) return k;
  }
  return null;
}

/** The period a series counts within. Yearless series share one bucket for all time. */
function periodFor(kind: IdKind, year?: number): string {
  if (YEARLESS_SERIES.includes(kind)) return '';
  const y = year && Number.isFinite(year) ? Math.floor(year) : new Date().getUTCFullYear();
  return String(y);
}

/**
 * Allocate the next identifier of a kind.
 *
 * ONE STATEMENT. The INSERT ... ON CONFLICT DO UPDATE both creates the counter row on first use and
 * increments it, returning the value it reserved. There is no window between reading and writing for
 * a second request to slip into.
 */
export async function allocateCode(kind: IdKind, year?: number): Promise<string> {
  await ensureTalentSchema();
  const period = periodFor(kind, year);
  const series = String(kind);
  const pad = ID_PAD[kind];

  let lastError = '';
  for (let attempt = 0; attempt < MAX_ALLOC_ATTEMPTS; attempt++) {
    try {
      const res = await db.execute(sql`
        INSERT INTO tal_id_series (series, period, next_value, pad_width, updated_at)
        VALUES (${series}, ${period}, 2, ${pad}, NOW())
        ON CONFLICT (series) DO UPDATE
          SET next_value = CASE
                             WHEN tal_id_series.period = ${period} THEN tal_id_series.next_value + 1
                             ELSE 2
                           END,
              period     = ${period},
              updated_at = NOW()
        RETURNING next_value - 1 AS reserved`);
      // RETURNING sees the row AFTER the update, so next_value - 1 is the value this call reserved:
      // 1 on first use (the INSERT sets 2), and the previous counter value on every conflict —
      // including a period rollover, which resets to 2 and therefore reserves 1.
      const rows = rowsOf(res);
      const reserved = Number(rows[0]?.reserved ?? rows[0]?.RESERVED ?? 0);
      if (reserved > 0) return formatCode(kind, reserved, year);
      lastError = 'allocator returned no value';
    } catch (e: any) {
      lastError = reasonOf(e);
    }
  }

  // LOUDLY. Never a silent duplicate and never a fabricated identifier — the caller's transaction
  // fails and the operator is told which series is stuck.
  throw new Error('Could not allocate a ' + series + ' identifier: ' + lastError);
}

/**
 * What the next code of this kind WILL be, without consuming it. For a preview on an admin screen.
 * Advisory by nature — another request may allocate between the read and the display.
 */
export async function peekNextCode(kind: IdKind, year?: number): Promise<string> {
  await ensureTalentSchema();
  const period = periodFor(kind, year);
  try {
    const res = await db.execute(sql`
      SELECT next_value, period FROM tal_id_series WHERE series = ${String(kind)}`);
    const rows = rowsOf(res);
    if (!rows.length) return formatCode(kind, 1, year);
    const samePeriod = String(rows[0]?.period ?? '') === period;
    return formatCode(kind, samePeriod ? Number(rows[0]?.next_value ?? 1) : 1, year);
  } catch (e: any) {
    console.error('[talent-ids] peek ' + String(kind) + ': ' + reasonOf(e));
    return formatCode(kind, 1, year);
  }
}
