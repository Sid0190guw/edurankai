// The consultation booking fee schedule: one row per (applicant category, currency), revised
// without code changes at /admin/samarth/fees.
//
// NO FEE IS INVENTED. The table starts empty and nothing seeds it. A row is a DRAFT until a person
// approves it with a note, and only an APPROVED row is ever quoted to an applicant. Until a fee for
// their category and currency is approved, an applicant can register and describe their project,
// and is told plainly that booking opens once the fee is published.
//
// REVISING A FEE never edits an approved row: a new draft is created and approving it retires the
// previous one. An applicant who already accepted a fee keeps the snapshot they accepted
// (applications.fee_snapshot); the payment step refuses to charge against a snapshot whose row has
// since been retired and asks them to review the current fee instead.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ANY_CATEGORY, isApplicantCategory, categoryLabel } from '@/lib/samarth/categories';
import { isSupportedCurrency, feeBreakdown, TAX_MODES, type FeeBreakdown, type TaxMode } from '@/lib/samarth/currency';
import { rows, readSafely, writeSafely, num, iso, str, isUuid, audit, type Read, type Write, type ActorRef } from '@/lib/samarth/store-core';

export interface FeeRow {
  id: string;
  category: string;
  currency: string;
  amountMinor: number;
  taxMode: TaxMode;
  taxLabel: string;
  taxRateBp: number;
  processingBp: number;
  chargesNote: string;
  terms: string;
  status: 'draft' | 'approved' | 'retired';
  note: string;
  createdName: string;
  approvedName: string;
  approvedAt: string | null;
  approvalNote: string;
  createdAt: string | null;
}

const toFee = (r: any): FeeRow => ({
  id: str(r.id), category: str(r.category), currency: str(r.currency).toUpperCase(), amountMinor: num(r.amount_minor) || 0,
  taxMode: (['none', 'exclusive', 'inclusive'].includes(r.tax_mode) ? r.tax_mode : 'none') as TaxMode,
  taxLabel: str(r.tax_label), taxRateBp: num(r.tax_rate_bp) || 0, processingBp: num(r.processing_bp) || 0,
  chargesNote: str(r.charges_note), terms: str(r.terms),
  status: (['draft', 'approved', 'retired'].includes(r.status) ? r.status : 'draft') as FeeRow['status'],
  note: str(r.note), createdName: str(r.created_name), approvedName: str(r.approved_name), approvedAt: iso(r.approved_at),
  approvalNote: str(r.approval_note), createdAt: iso(r.created_at),
});

export function breakdownFor(f: FeeRow): FeeBreakdown {
  return feeBreakdown({ amountMinor: f.amountMinor, currency: f.currency, taxMode: f.taxMode, taxLabel: f.taxLabel, taxRateBp: f.taxRateBp, processingBp: f.processingBp });
}

export { feeProblems, TERMS_TEMPLATE, type FeeInput } from '@/lib/samarth/fee-rules';
import { feeProblems, type FeeInput } from '@/lib/samarth/fee-rules';

export async function listFees(): Promise<Read<FeeRow[]>> {
  return readSafely('the fee schedule', async () =>
    rows(await db.execute(sql`
      SELECT * FROM samarth_fee_schedule
       ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, category, currency, created_at DESC
       LIMIT 500`)).map(toFee));
}

export async function approvedFees(): Promise<Read<FeeRow[]>> {
  return readSafely('the published fees', async () =>
    rows(await db.execute(sql`
      SELECT * FROM samarth_fee_schedule WHERE status = 'approved'
       ORDER BY category, currency, approved_at DESC`)).map(toFee));
}

export async function getFee(id: string): Promise<FeeRow | null> {
  if (!isUuid(id)) return null;
  const r = rows(await db.execute(sql`SELECT * FROM samarth_fee_schedule WHERE id = ${id}::uuid LIMIT 1`))[0];
  return r ? toFee(r) : null;
}

/**
 * The approved fee for a category in a currency: the category's own row, else the all-categories
 * row. The most recently approved wins, so a half-finished revision can never quote two prices.
 */
export function pickFee(approved: FeeRow[], category: string, currency: string): FeeRow | null {
  const cur = String(currency || '').toUpperCase();
  const latest = (list: FeeRow[]) => list.sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt)))[0] || null;
  return latest(approved.filter((f) => f.status === 'approved' && f.category === category && f.currency === cur))
    || latest(approved.filter((f) => f.status === 'approved' && f.category === ANY_CATEGORY && f.currency === cur));
}

/** The currencies a category can book in right now. */
export function currenciesFor(approved: FeeRow[], category: string): string[] {
  return Array.from(new Set(approved.filter((f) => f.status === 'approved' && (f.category === category || f.category === ANY_CATEGORY)).map((f) => f.currency))).sort();
}

export async function createFeeDraft(input: FeeInput, actor: ActorRef): Promise<Write<{ id: string }>> {
  if (input.category !== ANY_CATEGORY && !isApplicantCategory(input.category)) return { ok: false, error: 'Choose an applicant category.' };
  if (!isSupportedCurrency(input.currency)) return { ok: false, error: 'Choose a supported currency.' };
  if (!input.amountMinor || input.amountMinor <= 0) return { ok: false, error: 'Enter the fee amount.' };
  return writeSafely('creating a fee draft', async () => {
    const r = rows(await db.execute(sql`
      INSERT INTO samarth_fee_schedule (category, currency, amount_minor, tax_mode, tax_label, tax_rate_bp, processing_bp, charges_note, terms, note, created_by, created_name)
      VALUES (${input.category}, ${input.currency.toUpperCase()}, ${input.amountMinor}, ${input.taxMode}, ${input.taxLabel || null},
              ${input.taxRateBp || 0}, ${input.processingBp || 0}, ${input.chargesNote || null}, ${input.terms || ''}, ${input.note || null},
              ${isUuid(actor.userId) ? actor.userId : null}::uuid, ${actor.name})
      RETURNING id`))[0];
    const id = str(r?.id);
    await audit(actor, 'samarth.fee.draft', 'samarth_fee', id, { category: input.category, currency: input.currency, amountMinor: input.amountMinor });
    return { ok: true, id };
  });
}

export async function approveFee(id: string, approvalNote: string, actor: ActorRef): Promise<Write> {
  if (!isUuid(id)) return { ok: false, error: 'Unknown fee.' };
  if (approvalNote.trim().length < 5) return { ok: false, error: 'Approving a fee needs an approval note: who decided it and on what basis.' };
  return writeSafely('approving a fee', async () => {
    const f = await getFee(id);
    if (!f) return { ok: false, error: 'That fee no longer exists.' };
    if (f.status !== 'draft') return { ok: false, error: 'Only a draft can be approved. To change a published fee, create a new draft.' };
    const problems = feeProblems({ ...f, amountMinor: f.amountMinor });
    if (problems.length) return { ok: false, error: problems.join(' ') };
    // Approve the new row FIRST, then retire the old. If the second statement fails, two rows are
    // approved for a moment and pickFee() quotes the newer one, which is the intended price.
    const done = rows(await db.execute(sql`
      UPDATE samarth_fee_schedule
         SET status = 'approved', approved_by = ${isUuid(actor.userId) ? actor.userId : null}::uuid, approved_name = ${actor.name},
             approved_at = NOW(), approval_note = ${approvalNote.trim().slice(0, 1000)}, updated_at = NOW()
       WHERE id = ${id}::uuid AND status = 'draft'
      RETURNING id`));
    if (!done.length) return { ok: false, error: 'Somebody else changed this fee a moment ago. Reload and check it.' };
    await db.execute(sql`
      UPDATE samarth_fee_schedule SET status = 'retired', retired_at = NOW(), updated_at = NOW()
       WHERE category = ${f.category} AND currency = ${f.currency} AND status = 'approved' AND id <> ${id}::uuid`);
    await audit(actor, 'samarth.fee.approve', 'samarth_fee', id, {
      category: f.category, categoryLabel: categoryLabel(f.category), currency: f.currency, amountMinor: f.amountMinor,
      taxMode: f.taxMode, taxRateBp: f.taxRateBp, processingBp: f.processingBp, note: approvalNote.trim().slice(0, 300),
    });
    return { ok: true };
  });
}

export async function retireFee(id: string, reason: string, actor: ActorRef): Promise<Write> {
  if (!isUuid(id)) return { ok: false, error: 'Unknown fee.' };
  if (reason.trim().length < 5) return { ok: false, error: 'Write why this fee is being withdrawn.' };
  return writeSafely('retiring a fee', async () => {
    const done = rows(await db.execute(sql`
      UPDATE samarth_fee_schedule SET status = 'retired', retired_at = NOW(), note = COALESCE(note, '') || ${' Retired: ' + reason.trim().slice(0, 500)}, updated_at = NOW()
       WHERE id = ${id}::uuid AND status IN ('draft', 'approved') RETURNING id, category, currency`));
    if (!done.length) return { ok: false, error: 'That fee is already retired.' };
    await audit(actor, 'samarth.fee.retire', 'samarth_fee', id, { reason: reason.trim().slice(0, 300) });
    return { ok: true };
  });
}

/** Applications waiting for a fee: requirements complete, nothing quotable in their category. */
export async function waitingForFee(): Promise<Read<{ category: string; count: number }[]>> {
  return readSafely('applications waiting for a fee', async () =>
    rows(await db.execute(sql`
      SELECT a.category, COUNT(*)::int AS n
        FROM samarth_applications a
       WHERE a.status = 'REQUIREMENTS_COMPLETE' AND a.archived = false
         AND NOT EXISTS (SELECT 1 FROM samarth_fee_schedule f WHERE f.status = 'approved' AND (f.category = a.category OR f.category = '*'))
       GROUP BY a.category ORDER BY n DESC`)).map((r) => ({ category: str(r.category), count: num(r.n) || 0 })));
}
