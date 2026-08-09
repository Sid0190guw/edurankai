// Partner payout workflow: partners request payouts against their accrued
// revenue share; super-admins approve / mark paid / reject. Self-bootstrapping
// table so it works without a manual migration.
//
// =================================================================================================
// WHAT WAS WRONG HERE, BECAUSE ALL THREE FAULTS POINTED THE SAME WAY: MONEY OUT TWICE
// =================================================================================================
//
//  1. AVAILABILITY WAS CHECKED IN JAVASCRIPT AND THEN NOT ENFORCED AT ALL.
//     /aquintutor/admin/partner read getPayoutSummary(), compared the typed amount against
//     `available`, and then called requestPayout(), which inserted whatever it was handed. Two
//     submits arriving together (a double tap, a retried POST, two tabs) both read the same summary
//     and both passed, so a partner with 40,000 available could raise two 40,000 requests and an
//     approver reviewing them separately had nothing on either screen saying they overlapped. The
//     availability test now lives INSIDE the INSERT, against the ledger as it stands in that
//     statement, exactly as coverWithCredit() does for account credit. Zero rows back means it does
//     not fit.
//
//  2. A FAILED READ REPORTED THE WHOLE LIFETIME SHARE AS AVAILABLE.
//     getPayoutSummary() caught its own failure into an empty array, so paid and pending both read 0
//     and `available` became the entire accrued share - for a partner whose payouts had ALL been
//     paid, the screen offered the lot again. An unreadable ledger is UNKNOWN, not "nothing has been
//     paid out"; the summary now says which it is, and the surface refuses to offer a request
//     against a number it could not compute.
//
//  3. decidePayout() ANSWERED ok:true WHETHER OR NOT IT MATCHED A ROW, and would move a payout OUT
//     of 'paid'. Rejecting a payout that had already been paid removed it from the paid total, which
//     put the same money back into `available` for the partner to request a second time - the bank
//     transfer having already left. 'paid' is now terminal, and a decision that matches nothing says
//     so instead of flashing "Updated."
//
// The database's own words are LOGGED (`e.cause.message`; `e.message` is only the failed SQL) and
// never handed to a caller.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

// -------------------------------------------------------------------------------------------------
// CONSTANTS FIRST - `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. */
function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown database error');
const logFail = (tag: string, e: any) => console.error('[partner-payouts] ' + tag, reasonOf(e));

/** The smallest payout, in paise. Rs 100. */
export const MIN_PAYOUT_PAISE = 10000;

/** What a partner is told when a write fails. The real reason is in the log, not on their screen. */
const WRITE_FAILED = 'That could not be saved just now. Nothing was changed - try again in a moment.';

export function ensurePayoutSchema(): Promise<void> {
  return ensureOnce('partner_payouts', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS partner_payouts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_user_id UUID NOT NULL,
      amount_paise BIGINT NOT NULL,
      method VARCHAR(40),
      details TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'requested',
      note TEXT,
      paid_ref TEXT,
      decided_by UUID,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS partner_payouts_user_idx ON partner_payouts(partner_user_id, requested_at DESC)`);
  });
}

export interface PayoutSummary {
  earned: number;
  paid: number;
  pending: number;
  available: number;
  /** False when the ledger could not be read. `available` is 0 and MEANS NOTHING in that case. */
  known: boolean;
  error: string | null;
}

// earned = lifetime accrued share (paise). locked = anything requested/approved/paid.
export async function getPayoutSummary(userId: string, earnedPaise: number): Promise<PayoutSummary> {
  const earned = Number(earnedPaise) || 0;
  try {
    await ensurePayoutSchema();
    const r = rows(await db.execute(sql`
      SELECT
        COALESCE(SUM(amount_paise) FILTER (WHERE status = 'paid'), 0)::bigint AS paid,
        COALESCE(SUM(amount_paise) FILTER (WHERE status IN ('requested','approved')), 0)::bigint AS pending
      FROM partner_payouts WHERE partner_user_id = ${userId}
    `))[0] as any;
    const paid = Number(r?.paid) || 0;
    const pending = Number(r?.pending) || 0;
    return { earned, paid, pending, available: Math.max(0, earned - paid - pending), known: true, error: null };
  } catch (e: any) {
    // A zero here is not a balance. It is the absence of an answer, and the caller is told so.
    logFail('getPayoutSummary', e);
    return { earned, paid: 0, pending: 0, available: 0, known: false, error: reasonOf(e) };
  }
}

export interface PayoutListResult { rows: any[]; error: string | null }

export async function listPayouts(userId: string): Promise<PayoutListResult> {
  try {
    await ensurePayoutSchema();
    return {
      rows: rows(await db.execute(sql`
        SELECT id, amount_paise, method, details, status, note, paid_ref, requested_at, decided_at
        FROM partner_payouts WHERE partner_user_id = ${userId}
        ORDER BY requested_at DESC LIMIT 100
      `)),
      error: null,
    };
  } catch (e: any) {
    logFail('listPayouts', e);
    return { rows: [], error: reasonOf(e) };
  }
}

/**
 * Raise a payout request.
 *
 * `earnedPaise` is the lifetime accrued share, which is computed OUTSIDE this ledger (it comes from
 * partner revenue). It is passed in so the whole availability test - earned minus everything already
 * committed - can be evaluated inside the INSERT rather than in the caller, where two requests can
 * pass the same test.
 */
export async function requestPayout(
  userId: string,
  amountPaise: number,
  method: string,
  details: string,
  earnedPaise: number,
): Promise<{ ok: boolean; error?: string }> {
  const amt = Math.round(Number(amountPaise) || 0);
  const earned = Math.round(Number(earnedPaise) || 0);
  if (!(amt >= MIN_PAYOUT_PAISE)) return { ok: false, error: 'Minimum payout is Rs 100.' };
  if (!(earned > 0)) return { ok: false, error: 'You have no accrued share to draw against yet.' };
  try {
    await ensurePayoutSchema();
    // THE CLAIM. Everything already requested, approved or paid is subtracted inside the same
    // statement that writes the row, so a second request arriving at the same instant sees the first
    // one in the sum. Zero rows back is not an error - it is "that does not fit".
    const safeMethod = (method || 'bank').slice(0, 40);
    const safeDetails = (details || '').slice(0, 2000);
    const wrote = rows(await db.execute(sql`
      INSERT INTO partner_payouts (partner_user_id, amount_paise, method, details, status)
      SELECT ${userId}::uuid, ${amt}, ${safeMethod}, ${safeDetails}, 'requested'
       WHERE ${earned} - COALESCE((
         SELECT SUM(amount_paise) FROM partner_payouts
          WHERE partner_user_id = ${userId}::uuid AND status IN ('requested','approved','paid')
       ), 0) >= ${amt}
      RETURNING id`));
    if (!wrote.length) {
      return { ok: false, error: 'That is more than your available balance - some of your share is already in a payout that has not settled.' };
    }
    return { ok: true };
  } catch (e: any) {
    logFail('requestPayout', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export async function listAllPayouts(status?: string): Promise<PayoutListResult> {
  try {
    await ensurePayoutSchema();
    const filt = status && status !== 'all' ? sql`WHERE p.status = ${status}` : sql``;
    return {
      rows: rows(await db.execute(sql`
        SELECT p.id, p.partner_user_id, p.amount_paise, p.method, p.details, p.status, p.note, p.paid_ref,
               p.requested_at, p.decided_at, u.name AS partner_name, u.email AS partner_email
        FROM partner_payouts p
        LEFT JOIN users u ON u.id = p.partner_user_id
        ${filt}
        ORDER BY (p.status = 'requested') DESC, p.requested_at DESC LIMIT 300
      `)),
      error: null,
    };
  } catch (e: any) {
    logFail('listAllPayouts', e);
    return { rows: [], error: reasonOf(e) };
  }
}

/**
 * Record a decision on one payout.
 *
 * 'paid' IS TERMINAL. Moving a payout out of 'paid' takes it back out of the paid total, which puts
 * the same money back into the partner's available balance while the transfer that settled it has
 * already left the bank. A correction to a payout that was marked paid in error is a finance
 * decision with a paper trail, not a button.
 */
export async function decidePayout(
  id: string,
  status: 'approved' | 'paid' | 'rejected',
  adminId: string,
  note?: string,
  paidRef?: string,
): Promise<{ ok: boolean; error?: string; partnerUserId?: string; amountPaise?: number }> {
  if (status !== 'approved' && status !== 'paid' && status !== 'rejected') {
    return { ok: false, error: 'That is not a decision this ledger records.' };
  }
  try {
    await ensurePayoutSchema();
    const r = rows(await db.execute(sql`
      UPDATE partner_payouts
      SET status = ${status}, decided_by = ${adminId}, decided_at = NOW(),
          note = COALESCE(${note || null}, note), paid_ref = COALESCE(${paidRef || null}, paid_ref)
      WHERE id = ${id}::uuid
        AND status <> 'paid'
      RETURNING partner_user_id, amount_paise
    `));
    if (!r.length) {
      // Tell the two apart, because they lead an operator to do different things.
      const cur = rows(await db.execute(sql`SELECT status FROM partner_payouts WHERE id = ${id}::uuid LIMIT 1`))[0] as any;
      if (cur && String(cur.status) === 'paid') {
        return { ok: false, error: 'That payout is already recorded as paid, so it was not changed. Raise a correction with finance instead.' };
      }
      return { ok: false, error: 'That payout no longer exists, so nothing was changed.' };
    }
    return { ok: true, partnerUserId: r[0]?.partner_user_id, amountPaise: Number(r[0]?.amount_paise) || 0 };
  } catch (e: any) {
    logFail('decidePayout', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export interface PayoutTotals { requested: number; pendingAmt: number; paidAmt: number; error: string | null }

export async function payoutTotals(): Promise<PayoutTotals> {
  try {
    await ensurePayoutSchema();
    const r = rows(await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'requested')::int AS requested,
        COALESCE(SUM(amount_paise) FILTER (WHERE status IN ('requested','approved')), 0)::bigint AS pending_amt,
        COALESCE(SUM(amount_paise) FILTER (WHERE status = 'paid'), 0)::bigint AS paid_amt
      FROM partner_payouts
    `))[0] as any;
    return {
      requested: Number(r?.requested) || 0,
      pendingAmt: Number(r?.pending_amt) || 0,
      paidAmt: Number(r?.paid_amt) || 0,
      error: null,
    };
  } catch (e: any) {
    logFail('payoutTotals', e);
    return { requested: 0, pendingAmt: 0, paidAmt: 0, error: reasonOf(e) };
  }
}
