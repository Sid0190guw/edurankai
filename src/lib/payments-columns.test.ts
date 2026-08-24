// src/lib/payments-columns.test.ts — THE COLUMN ON `payments` IS `razorpay_payment_id`.
//
// =================================================================================================
// WHY THIS IS A SOURCE SCAN
// =================================================================================================
//
// /receipt/[order] selected `payment_id` from `payments`. No such column exists on this deployment
// and none ever did: every write is `UPDATE payments SET razorpay_payment_id = …` (the Razorpay
// verify handlers) and every other reader selects it by that name (/admin/finance among them).
//
// So the statement did not return "no such order" — it threw `column "payment_id" does not exist`,
// for every order id, every time. Measured on the live site 2026-08-24: three different order
// references, three failures. That page is where the emailed receipt link lands after a real
// payment, and the failure branch told the reader "could not be reached just now… please reload in
// a moment", which was never going to become true.
//
// It cannot be caught by a unit test, because reaching the statement needs the database. It CAN be
// caught by reading the SQL, which is what this does. `payments` is not in src/lib/db/schema.ts and
// no db/*.sql creates it, so there is no declaration to check against — the writers ARE the
// specification, and this asserts the readers agree with them.
//
// NOTE the `training_enrollments.payment_id` column is real and unrelated; only statements that
// actually read FROM payments are examined.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function sources(): string[] {
  const out: string[] = [];
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(ts|astro)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
    }
  })('src');
  return out;
}

/**
 * Every SQL-ish chunk that reads FROM the payments table.
 *
 * Bounded by the statement's own keywords rather than by the template literal, because these are
 * written inline in page frontmatter as often as in a lib.
 */
function paymentsReads(src: string): string[] {
  const out: string[] = [];
  const re = /SELECT[\s\S]{0,900}?FROM\s+payments\b/gi;
  for (const m of src.matchAll(re)) out.push(m[0]);
  return out;
}

describe('reads of the payments table', () => {
  const files = sources();

  it('never select a bare payment_id, which does not exist on that table', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const chunk of paymentsReads(src)) {
        // The real column, and the alias form that renames it for a template, are both fine.
        const stripped = chunk
          .replace(/razorpay_payment_id/gi, '')
          .replace(/\bAS\s+payment_id\b/gi, '');
        if (/\bpayment_id\b/.test(stripped)) {
          offenders.push(f.split(path.sep).join('/') + ': ' + chunk.replace(/\s+/g, ' ').slice(0, 120));
        }
      }
    }
    // Named rather than counted, so the next person sees the statement instead of a number.
    expect(offenders.join('\n')).toBe('');
  });

  it('finds the reads it claims to be checking, so a silent regex failure cannot pass this file', () => {
    // If the matcher ever stops matching, the assertion above becomes vacuously true. This is the
    // guard against a green test that checks nothing — the failure mode of every source scan.
    const total = files.reduce((n, f) => n + paymentsReads(fs.readFileSync(f, 'utf8')).length, 0);
    expect(total).toBeGreaterThan(5);
  });
});
