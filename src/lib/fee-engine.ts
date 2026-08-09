// -------------------------------------------------------------------------------------------------
// src/lib/fee-engine.ts — WHAT A LEARNER OWES, CALCULATED, NEVER STORED.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: there is no single course price. A charge is a LIST OF LINE
// ITEMS, each with a type — base fee, registration, application, examination, certification,
// laboratory, material, service — and the net payable is what falls out of applying discounts,
// coupons, scholarships, waivers, sponsorships and then taxes to those lines, IN A STATED ORDER.
// The number a learner is charged is derived every time it is needed, and it arrives with the
// breakdown that produced it, so the answer to "why do I owe this" is the calculation itself rather
// than somebody's recollection of a field.
//
// WHAT IS HERE TODAY, AND WHY THE LEGACY PRICE IS STILL READ. `training_courses.price_inr_paise` is
// the single stored number the live checkout uses (src/pages/api/aquintutor/start-enrollment.ts:79).
// It is not deleted here and nothing in this file writes it: courseFeeLines() prefers a real fee
// schedule when one exists and otherwise DERIVES one base line from that column, flagged
// `derivedFromLegacyPrice`. A screen can then say, truthfully, that this course has a price and not
// yet a schedule. Migrating a course means adding its lines; nothing breaks on the day it has none.
//
// -------------------------------------------------------------------------------------------------
// MONEY IS AN INTEGER COUNT OF MINOR UNITS. NEVER A FLOAT. NOT ONCE.
//
// Every amount in this file — a line, an adjustment, a tax, the total — is a whole number of paise
// (or of whatever minor unit the currency uses). src/lib/money.ts already documents what floats did
// to this codebase: `1.005 * 100 === 100.49999999999999`, six copies of one rounding helper, and a
// wallet that refused a withdrawal for exactly the balance it displayed. A fee is the same money.
//
// A FRACTION CAN ONLY ENTER HERE THROUGH A PERCENTAGE, and that is the ONE place rounding happens:
// pctOfMinor() turns a percentage into whole minor units, half away from zero, immediately, and
// every step after it is integer arithmetic. There is no second rounding and nothing is rounded at
// the end.
//
// THE SECOND AND LAST PLACE A REMAINDER CAN APPEAR is splitting one adjustment across several lines.
// allocate() uses the largest-remainder method, so the parts sum EXACTLY to the whole that was
// already rounded. A total that does not equal the sum of its printed lines is a document somebody
// has to explain.
//
// -------------------------------------------------------------------------------------------------
// ORDER OF OPERATIONS — A DECISION, STATED AND ENFORCED.
//
//     discount  ->  coupon  ->  scholarship  ->  waiver  ->  sponsorship  ->  tax
//
// and each stage applies to the BALANCE STILL PAYABLE after the stage before it (a cascade), not to
// the original gross.
//
// WHY THIS ORDER:
//   discount     a commercial adjustment to the list price — early-bird, bundle, cohort. It defines
//                what the thing actually costs before anybody's circumstances are considered.
//   coupon       a marketing instrument redeemed against that real price.
//   scholarship  an award out of a FINITE BUDGET. It comes after the commercial reductions so the
//                budget buys the maximum real relief: a scholarship must not be spent covering a
//                discount the learner was getting anyway.
//   waiver       a hardship decision about the residue — of what is still owed, this person pays
//                less or nothing. A human decides it on the facts as they stand after every
//                automatic reduction, which is exactly the number a reviewer should be looking at.
//   sponsorship  a third party settling whatever nobody else covered. Last, because that is what it
//                means.
//   tax          on what is actually payable. Tax on a gross nobody is charged is tax on a fiction.
//
// WHY IT HAS TO BE SAID OUT LOUD, precisely: for two PERCENTAGES in a cascade the order genuinely
// does not change the total (multiplication commutes — 10% then 50% and 50% then 10% both leave
// 45%). The order changes the answer the moment any adjustment is a FIXED amount, is CAPPED, or is
// SCOPED to some charge types and not others: a fixed 1,000 off 10,000 followed by a 50% waiver
// leaves 4,500, and the same two the other way round leave 4,000. Both of those are tested. And even
// where the total is identical, the order decides WHICH instrument is recorded as having covered
// which rupee — which is what a scholarship budget counts, what a sponsor is invoiced for, and what
// a refund has to unwind. So the order is fixed here, in one constant, and no caller may reorder it
// by handing the adjustments over in a different sequence.
//
// NOTHING GOES NEGATIVE. Every adjustment is capped at the balance remaining in its own scope, so a
// 100% waiver on top of a 100% scholarship reduces nothing further and is reported as capped rather
// than as a credit. Money owed back to a learner is a REFUND (src/pages/api/admin/payments/refund.ts)
// or wallet credit (src/lib/account-credit.ts); it is not a negative fee.
//
// -------------------------------------------------------------------------------------------------
// WHAT THIS FILE DOES NOT DO, DELIBERATELY:
//   - it does not take money. Settlement is `payments` + src/lib/payment-effects.ts, and the kernel
//     path is src/lib/course-payments.ts behind the PaymentGateway interface in payment-gateway.ts.
//   - it does not decide a waiver. src/lib/fee-waiver.ts and the course-fee-waiver work owned by the
//     course-delivery pass decide that; this engine only knows how to APPLY the decision. The
//     adapters near the bottom convert their records into adjustments so neither side is duplicated.
//   - it does not convert currency. src/lib/fx.ts does that, before a line reaches here. Mixing
//     currencies in one quote is refused rather than guessed.
// -------------------------------------------------------------------------------------------------

import { ensureOnce } from '@/lib/ensure-once';

// Resolved LAZILY, for the reason src/lib/audit.ts states: a top-level `@/lib/db` import puts every
// pure function in this module — which is nearly all of it, and all of the arithmetic — out of reach
// of a test that needs no database at all.
async function ctx(): Promise<{ db: any; sql: any }> {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

const MOD = '[fee-engine]';
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
function why(e: any): string {
  // The real Postgres reason is on e.cause; e.message is only the failed SQL.
  return String(e?.cause?.message || e?.message || e || 'unknown reason');
}

// =================================================================================================
// THE VOCABULARY
// =================================================================================================

/**
 * THE EIGHT KINDS OF CHARGE. A fee is made of these; it is never one number.
 *
 * Adding a member is additive — chargeTypeLabel() gains a case and nothing already stored changes
 * meaning. Removing one is not, because rows already carry it.
 */
export const CHARGE_TYPES = [
  'base',
  'registration',
  'application',
  'examination',
  'certification',
  'laboratory',
  'material',
  'service',
] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number];

const CHARGE_TYPE_SET = new Set<string>(CHARGE_TYPES);
export function isChargeType(v: unknown): v is ChargeType {
  return typeof v === 'string' && CHARGE_TYPE_SET.has(v);
}

/** Learner-facing. Plain words; no provider names, no competitor names, no price framing. */
export function chargeTypeLabel(v: string): string {
  if (v === 'base') return 'Course fee';
  if (v === 'registration') return 'Registration';
  if (v === 'application') return 'Application';
  if (v === 'examination') return 'Examination';
  if (v === 'certification') return 'Certification';
  if (v === 'laboratory') return 'Laboratory';
  if (v === 'material') return 'Materials';
  if (v === 'service') return 'Services';
  return String(v || '');
}

/**
 * THE FIVE THINGS THAT REDUCE WHAT IS OWED, IN THE ORDER THEY ARE APPLIED.
 *
 * This array IS the order of operations. computeFee() iterates it; it never iterates the caller's
 * list. Handing the adjustments over in a different sequence cannot change the arithmetic.
 */
export const ADJUSTMENT_ORDER = ['discount', 'coupon', 'scholarship', 'waiver', 'sponsorship'] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_ORDER)[number];

const ADJUSTMENT_SET = new Set<string>(ADJUSTMENT_ORDER);
export function isAdjustmentKind(v: unknown): v is AdjustmentKind {
  return typeof v === 'string' && ADJUSTMENT_SET.has(v);
}

export function adjustmentKindLabel(v: string): string {
  if (v === 'discount') return 'Discount';
  if (v === 'coupon') return 'Coupon';
  if (v === 'scholarship') return 'Scholarship';
  if (v === 'waiver') return 'Fee waiver';
  if (v === 'sponsorship') return 'Sponsored';
  return String(v || '');
}

/**
 * HOW ONE TAX COMPONENT IS CALCULATED.
 *
 *   percent_of_taxable_net   `value` percent of the taxable balance AFTER every adjustment.
 *   fixed                    `value` as whole minor units.
 *
 * There is no percent_of_total, for the reason src/lib/invoices.ts gives about its own tax lines and
 * src/lib/payroll.ts gives about percent_of_gross: a tax computed on a total it is itself part of has
 * no fixed point. taxComponentFromInvoiceComponent() maps the invoices catalogue's spelling
 * ('percent_of_subtotal') onto this one, so tax is configured in ONE place for the whole product.
 */
export const FEE_TAX_BASES = ['percent_of_taxable_net', 'fixed'] as const;
export type FeeTaxBasis = (typeof FEE_TAX_BASES)[number];

export function feeTaxBasisLabel(v: string): string {
  if (v === 'percent_of_taxable_net') return 'Percentage of the taxable amount payable';
  if (v === 'fixed') return 'Fixed amount';
  return String(v || '');
}

// =================================================================================================
// THE ARITHMETIC. Pure, integer, and the only place a fraction is allowed to exist.
// =================================================================================================

/**
 * Coerce anything to a whole number of minor units.
 *
 * A non-finite input answers 0 rather than NaN, because NaN propagates silently through every sum
 * after it and comes out the other end as a total nobody can explain.
 */
export function minorUnits(n: number | string | null | undefined): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v);
}

/**
 * THE ONE ROUNDING POINT. A percentage of an integer amount, rounded to whole minor units, half away
 * from zero, at the moment it is computed.
 *
 * `.toPrecision(15)` before rounding is the same defence src/lib/money.ts documents: it re-renders
 * the product inside a double's honest precision, so a value that really is a half unit is not
 * rounded down by a representation artefact. Both operands are non-negative here (a negative
 * "discount" is refused above), so half-up and half-away-from-zero are the same rule.
 */
export function pctOfMinor(baseMinor: number, percent: number): number {
  const base = minorUnits(baseMinor);
  const pct = Number(percent);
  if (!Number.isFinite(pct) || pct <= 0 || base <= 0) return 0;
  const exact = Number(((base * pct) / 100).toPrecision(15));
  return Math.round(exact);
}

/**
 * Split an already-rounded total across weights so the parts sum EXACTLY to it.
 *
 * Largest remainder: every part gets the floor of its exact share, and the units left over go to the
 * largest fractional remainders, ties broken by the larger weight and then by the earlier position,
 * so the same input always produces the same split. No part can exceed its own weight, which is what
 * keeps a line from being reduced below zero.
 */
export function allocate(totalMinor: number, weights: number[]): number[] {
  const total = Math.max(0, minorUnits(totalMinor));
  const w = weights.map((x) => Math.max(0, minorUnits(x)));
  const sum = w.reduce((a, b) => a + b, 0);
  const out = w.map(() => 0);
  if (total <= 0 || sum <= 0) return out;
  if (total >= sum) return w.slice();

  const rem: Array<{ i: number; frac: number; w: number }> = [];
  let given = 0;
  for (let i = 0; i < w.length; i++) {
    const exact = (total * w[i]) / sum;
    const floor = Math.floor(exact);
    out[i] = floor;
    given += floor;
    rem.push({ i, frac: exact - floor, w: w[i] });
  }
  rem.sort((a, b) => (b.frac - a.frac) || (b.w - a.w) || (a.i - b.i));
  let left = total - given;
  for (let k = 0; k < rem.length && left > 0; k++) {
    out[rem[k].i] += 1;
    left -= 1;
  }
  return out;
}

// =================================================================================================
// THE SHAPES
// =================================================================================================

export interface ChargeLine {
  /** Stable within one schedule. It is what an adjustment, a refund and a receipt line refer to. */
  code: string;
  type: ChargeType;
  /** Learner-facing. Plain words. */
  label: string;
  /** Whole minor units, per unit. */
  amountMinor: number;
  /** Whole units, at least 1. */
  quantity?: number;
  /** Default true. A line excluded from tax says so here rather than by being left out of a sum. */
  taxable?: boolean;
  /** Informational only — this engine never computes a refund. */
  refundable?: boolean;
  /** Default true. An optional line the learner did not take should simply not be passed in. */
  mandatory?: boolean;
  note?: string | null;
}

export interface FeeAdjustment {
  kind: AdjustmentKind;
  /** Stable identifier for the instrument: a coupon code, a scholarship code, a waiver reference. */
  code: string;
  /** Learner-facing reason. This is what the breakdown shows next to the money. */
  label: string;
  basis: 'percent' | 'fixed';
  /** percent: 0..100. fixed: whole minor units. */
  value: number;
  /** Charge types this applies to. Absent or empty means every line. */
  appliesTo?: ChargeType[] | null;
  /** Ceiling in minor units — a percentage award capped at a stated maximum. */
  maxMinor?: number | null;
  /** The row this came from: a scholarship award id, a coupon id, a waiver id. */
  ref?: string | null;
  /** Who is covering it, when that is somebody other than the learner (a sponsor, a fund). */
  coveredBy?: string | null;
}

export interface FeeTaxComponent {
  code: string;
  label: string;
  basis: FeeTaxBasis;
  /** percent basis: a percentage. fixed basis: whole minor units. */
  value: number;
}

export interface FeeLineResult {
  code: string;
  type: ChargeType;
  typeLabel: string;
  label: string;
  quantity: number;
  unitMinor: number;
  grossMinor: number;
  /** Everything allocated against this line, as a positive number. */
  reducedMinor: number;
  netMinor: number;
  taxable: boolean;
}

export interface AppliedAdjustment {
  kind: AdjustmentKind;
  kindLabel: string;
  code: string;
  label: string;
  basis: 'percent' | 'fixed';
  value: number;
  ref: string | null;
  coveredBy: string | null;
  scope: ChargeType[] | 'all';
  /** What the rule asked for, before it met the balance still payable. */
  requestedMinor: number;
  /** What it actually reduced. */
  appliedMinor: number;
  capped: boolean;
  /** Stated whenever something was capped or refused, so a screen never has to guess why. */
  note: string | null;
}

export interface FeeTaxResult {
  code: string;
  label: string;
  basis: FeeTaxBasis;
  value: number;
  amountMinor: number;
}

export interface FeeBreakdown {
  currency: string;
  lines: FeeLineResult[];
  grossMinor: number;
  adjustments: AppliedAdjustment[];
  adjustmentTotalMinor: number;
  /** How much each kind of instrument covered. A screen can say who paid for what. */
  coverage: Record<AdjustmentKind, number>;
  /** After every adjustment, before tax. */
  netMinor: number;
  taxableNetMinor: number;
  taxLines: FeeTaxResult[];
  taxTotalMinor: number;
  /** What the learner owes. Never negative. */
  payableMinor: number;
  /** False when the fee comes to nothing — a screen must not open a checkout for zero. */
  requiresPayment: boolean;
  /** The declared order, returned with every result so a caller cannot be unsure which one ran. */
  order: readonly AdjustmentKind[];
  /** Ordered, learner-readable sentences: the breakdown as prose. */
  explain: string[];
  /** Anything the caller must be told about its own input. Never silently corrected. */
  warnings: string[];
}

export interface FeeInput {
  lines: ChargeLine[];
  adjustments?: FeeAdjustment[];
  taxes?: FeeTaxComponent[];
  currency?: string;
}

const ZERO_COVERAGE = (): Record<AdjustmentKind, number> => ({
  discount: 0, coupon: 0, scholarship: 0, waiver: 0, sponsorship: 0,
});

// =================================================================================================
// THE CALCULATION
// =================================================================================================

/**
 * THE NET PAYABLE, AND THE REASON FOR IT.
 *
 * Pure: no database, no clock, no configuration read. The same input always produces the same
 * breakdown, which is what makes it testable to the paisa and what lets a screen and a charge agree.
 */
export function computeFee(input: FeeInput): FeeBreakdown {
  const warnings: string[] = [];
  const explain: string[] = [];
  const currency = String(input.currency || 'INR').toUpperCase().slice(0, 8) || 'INR';

  // ---- 1. the lines -----------------------------------------------------------------------------
  const lines: FeeLineResult[] = [];
  for (const raw of input.lines || []) {
    if (!raw) continue;
    const type: ChargeType = isChargeType(raw.type) ? raw.type : 'base';
    if (!isChargeType(raw.type)) {
      warnings.push('A charge of an unrecognised type (' + String(raw?.type) + ') was counted as a course fee.');
    }
    const qtyRaw = raw.quantity === undefined || raw.quantity === null ? 1 : Number(raw.quantity);
    const quantity = Number.isFinite(qtyRaw) && qtyRaw >= 1 ? Math.floor(qtyRaw) : 1;
    let unit = minorUnits(raw.amountMinor);
    if (unit < 0) {
      // A negative charge is a credit, and credits are src/lib/account-credit.ts, not a fee line.
      warnings.push('A negative amount on "' + String(raw.label || raw.code) + '" was ignored. Money owed back to a learner is a refund or credit, never a negative charge.');
      unit = 0;
    }
    const gross = unit * quantity;
    lines.push({
      code: String(raw.code || type),
      type,
      typeLabel: chargeTypeLabel(type),
      label: String(raw.label || chargeTypeLabel(type)),
      quantity,
      unitMinor: unit,
      grossMinor: gross,
      reducedMinor: 0,
      netMinor: gross,
      taxable: raw.taxable !== false,
    });
  }

  const grossMinor = lines.reduce((a, l) => a + l.grossMinor, 0);
  if (lines.length === 0) {
    explain.push('There is nothing to pay for: no charge has been set for this yet.');
  } else {
    explain.push('Charges total ' + formatMinor(grossMinor, currency) + ' across ' + lines.length + (lines.length === 1 ? ' line.' : ' lines.'));
  }

  // ---- 2. the adjustments, in the declared order -------------------------------------------------
  const remaining = lines.map((l) => l.grossMinor);
  const applied: AppliedAdjustment[] = [];
  const coverage = ZERO_COVERAGE();
  const supplied = (input.adjustments || []).filter((a) => a && isAdjustmentKind(a.kind));
  for (const a of input.adjustments || []) {
    if (a && !isAdjustmentKind(a.kind)) {
      warnings.push('An adjustment of an unknown kind (' + String(a.kind) + ') was ignored. Nothing was reduced by it.');
    }
  }

  for (const kind of ADJUSTMENT_ORDER) {
    for (const a of supplied) {
      if (a.kind !== kind) continue;

      const scopeTypes = (a.appliesTo || []).filter(isChargeType);
      const scope: ChargeType[] | 'all' = scopeTypes.length ? scopeTypes : 'all';
      const idx: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (scope === 'all' || scopeTypes.indexOf(lines[i].type) >= 0) idx.push(i);
      }
      const scopeRemaining = idx.reduce((s, i) => s + remaining[i], 0);

      let note: string | null = null;
      let requested = 0;
      if (a.basis === 'percent') {
        const pct = Number(a.value);
        if (!Number.isFinite(pct) || pct < 0) {
          note = 'This was not applied: a percentage below zero is a surcharge, and a surcharge is a charge line.';
        } else {
          requested = pctOfMinor(scopeRemaining, pct);
        }
      } else {
        const fixed = minorUnits(a.value);
        if (fixed < 0) {
          note = 'This was not applied: a reduction below zero is a charge, and a charge is a line item.';
        } else {
          requested = fixed;
        }
      }

      const cap = a.maxMinor === null || a.maxMinor === undefined ? null : Math.max(0, minorUnits(a.maxMinor));
      if (cap !== null && requested > cap) {
        requested = cap;
        note = 'Limited to the maximum of ' + formatMinor(cap, currency) + ' set on this award.';
      }

      const applyMinor = Math.min(requested, scopeRemaining);

      // A percentage is taken of what is STILL payable, so an earlier award that already cleared the
      // balance makes `requested` itself zero — and `applyMinor < requested` is then false. That
      // reported a reduction which covered nothing as though it had applied cleanly, which is the one
      // thing a fee breakdown must never do: a learner shown a full waiver that reduced nothing, with
      // no note saying so, has been told something untrue about their own money.
      // Exhausted scope is a capping whatever the arithmetic says. A genuine zero-value award is not.
      const askedForSomething = note === null && Number(a.value) > 0;
      const capped = applyMinor < requested || (scopeRemaining === 0 && askedForSomething);
      if (capped) {
        note = scopeRemaining === 0
          ? 'Nothing was left to reduce by the time this was applied, so it covered nothing.'
          : 'Reduced to ' + formatMinor(applyMinor, currency) + ', which is all that was still payable.';
      }

      if (applyMinor > 0) {
        const parts = allocate(applyMinor, idx.map((i) => remaining[i]));
        for (let k = 0; k < idx.length; k++) {
          const i = idx[k];
          remaining[i] -= parts[k];
          lines[i].reducedMinor += parts[k];
        }
        coverage[kind] += applyMinor;
      }

      applied.push({
        kind,
        kindLabel: adjustmentKindLabel(kind),
        code: String(a.code || kind),
        label: String(a.label || adjustmentKindLabel(kind)),
        basis: a.basis === 'fixed' ? 'fixed' : 'percent',
        value: Number(a.value) || 0,
        ref: a.ref ? String(a.ref) : null,
        coveredBy: a.coveredBy ? String(a.coveredBy) : null,
        scope,
        requestedMinor: requested,
        appliedMinor: applyMinor,
        capped,
        note,
      });

      explain.push(
        adjustmentKindLabel(kind) + ' — ' + String(a.label || a.code) + ': ' +
        (applyMinor > 0 ? 'less ' + formatMinor(applyMinor, currency) : 'nothing to reduce') +
        (note ? ' (' + note + ')' : '') + '.',
      );
    }
  }

  for (let i = 0; i < lines.length; i++) lines[i].netMinor = remaining[i];
  const adjustmentTotalMinor = lines.reduce((a, l) => a + l.reducedMinor, 0);
  const netMinor = lines.reduce((a, l) => a + l.netMinor, 0);
  const taxableNetMinor = lines.reduce((a, l) => a + (l.taxable ? l.netMinor : 0), 0);

  // ---- 3. tax, on what is actually payable -------------------------------------------------------
  const taxLines: FeeTaxResult[] = [];
  let taxTotalMinor = 0;
  for (const t of input.taxes || []) {
    if (!t) continue;
    const basis: FeeTaxBasis = t.basis === 'fixed' ? 'fixed' : 'percent_of_taxable_net';
    if (t.basis && t.basis !== 'fixed' && t.basis !== 'percent_of_taxable_net') {
      warnings.push('Tax component "' + String(t.code) + '" named a basis this engine does not have (' + String(t.basis) + '); it was treated as a percentage of the taxable amount payable.');
    }
    const amount = basis === 'fixed' ? Math.max(0, minorUnits(t.value)) : pctOfMinor(taxableNetMinor, Number(t.value));
    if (amount > 0 || basis === 'fixed') {
      taxLines.push({ code: String(t.code || ''), label: String(t.label || t.code || 'Tax'), basis, value: Number(t.value) || 0, amountMinor: amount });
      taxTotalMinor += amount;
      explain.push(String(t.label || t.code) + ': ' + formatMinor(amount, currency) + '.');
    }
  }

  const payableMinor = Math.max(0, netMinor + taxTotalMinor);
  explain.push(payableMinor === 0
    ? 'Nothing is payable.'
    : 'Payable now: ' + formatMinor(payableMinor, currency) + '.');

  return {
    currency,
    lines,
    grossMinor,
    adjustments: applied,
    adjustmentTotalMinor,
    coverage,
    netMinor,
    taxableNetMinor,
    taxLines,
    taxTotalMinor,
    payableMinor,
    requiresPayment: payableMinor > 0,
    order: ADJUSTMENT_ORDER,
    explain,
    warnings,
  };
}

/**
 * Minor units as text, for a breakdown a learner reads.
 *
 * DISPLAY ONLY — nothing in the arithmetic ever reads this back. Two decimals, because every
 * currency this product takes money in today has two; a zero-decimal currency would need a real
 * exponent table and would be wrong to guess at, so it is not guessed at.
 */
export function formatMinor(minor: number, currency = 'INR'): string {
  const v = minorUnits(minor);
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const major = Math.floor(abs / 100);
  const rest = abs % 100;
  return sign + String(currency).toUpperCase() + ' ' + major.toLocaleString('en-IN') + '.' + String(rest).padStart(2, '0');
}

// =================================================================================================
// STORAGE — THE SCHEDULE. Additive DDL, one ensureOnce key, never a DROP.
// =================================================================================================

export const FEE_SCHEDULE_TABLE = 'fee_schedule_items';

/**
 * ONE ROW PER CHARGE, not one price per course. `scope_id` is TEXT because the things a fee attaches
 * to do not agree on an id type — a course is a uuid, a programme is a slug — and casting a slug to
 * uuid is how a whole surface starts answering nothing.
 */
export function ensureFeeScheduleSchema(): Promise<void> {
  return ensureOnce('fee_schedule_items_v1', async () => {
    const { db, sql } = await ctx();
    await db.execute(sql`CREATE TABLE IF NOT EXISTS fee_schedule_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scope_kind VARCHAR(20) NOT NULL,
      scope_id TEXT NOT NULL DEFAULT '',
      charge_type VARCHAR(20) NOT NULL,
      code VARCHAR(60) NOT NULL,
      label TEXT NOT NULL,
      amount_minor BIGINT NOT NULL DEFAULT 0,
      currency VARCHAR(8) NOT NULL DEFAULT 'INR',
      quantity INT NOT NULL DEFAULT 1,
      taxable BOOLEAN NOT NULL DEFAULT TRUE,
      mandatory BOOLEAN NOT NULL DEFAULT TRUE,
      refundable BOOLEAN NOT NULL DEFAULT FALSE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      position INT NOT NULL DEFAULT 0,
      note TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS fee_schedule_scope_idx ON fee_schedule_items (scope_kind, scope_id, position)`);
    // ONE LINE PER CODE PER SCOPE, said by the database and not only by the writer. Two rows with the
    // same code is a charge counted twice on a document that prints both — and saveScheduleItem()
    // below depends on this index for its ON CONFLICT, which is why a failure here is reported.
    try {
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS fee_schedule_code_uq ON fee_schedule_items (scope_kind, scope_id, code)`);
    } catch (e: any) {
      console.error(MOD, 'could not create the UNIQUE index on (scope_kind, scope_id, code) — a duplicate charge line may already exist:', why(e));
    }
  });
}

/**
 * DID THE SCHEMA ACTUALLY LAND? ensureOnce() swallows its rejection on purpose, so an ensure that
 * returned tells a caller nothing at all. This asks information_schema, which is the only answer
 * worth printing on an admin screen.
 */
export async function verifyFeeScheduleSchema(): Promise<{ ok: boolean; missing: string[]; hasUniqueIndex: boolean; reason?: string }> {
  const need = ['id', 'scope_kind', 'scope_id', 'charge_type', 'code', 'label', 'amount_minor', 'currency', 'is_active'];
  try {
    const { db, sql } = await ctx();
    const cols = rows(await db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'fee_schedule_items'`));
    const have = new Set(cols.map((x: any) => String(x.column_name)));
    const missing = need.filter((c) => !have.has(c));
    const idx = rows(await db.execute(sql`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'fee_schedule_items' AND indexname = 'fee_schedule_code_uq'`));
    return { ok: cols.length > 0 && missing.length === 0, missing, hasUniqueIndex: idx.length > 0 };
  } catch (e: any) {
    return { ok: false, missing: need, hasUniqueIndex: false, reason: why(e) };
  }
}

export type FeeScopeKind = 'course' | 'programme' | 'global';

export interface FeeScheduleItem extends ChargeLine {
  id: string;
  scopeKind: FeeScopeKind;
  scopeId: string;
  currency: string;
  isActive: boolean;
  position: number;
}

function mapItem(r: any): FeeScheduleItem {
  return {
    id: String(r?.id || ''),
    scopeKind: (String(r?.scope_kind || 'course') as FeeScopeKind),
    scopeId: String(r?.scope_id || ''),
    code: String(r?.code || ''),
    type: isChargeType(r?.charge_type) ? r.charge_type : 'base',
    label: String(r?.label || ''),
    // BIGINT arrives as a STRING from postgres-js so no precision is lost on the way out. Number()
    // here is safe and deliberate: these are paise, and a fee needing more than 2^53 of them is not
    // a fee.
    amountMinor: minorUnits(r?.amount_minor),
    quantity: Number(r?.quantity) || 1,
    currency: String(r?.currency || 'INR'),
    taxable: r?.taxable !== false,
    mandatory: r?.mandatory !== false,
    refundable: r?.refundable === true,
    isActive: r?.is_active !== false,
    position: Number(r?.position) || 0,
    note: r?.note ? String(r.note) : null,
  };
}

/**
 * The charge lines recorded against one scope.
 *
 * THROWS RATHER THAN ANSWERING []. An unreadable schedule that returns an empty list is a course
 * that silently becomes free — the caller would price it at zero and let somebody enrol. A caller
 * that cannot price something must refuse to charge, not charge nothing.
 */
export async function feeSchedule(scopeKind: FeeScopeKind, scopeId: string, includeInactive = false): Promise<FeeScheduleItem[]> {
  await ensureFeeScheduleSchema();
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      SELECT * FROM fee_schedule_items
       WHERE scope_kind = ${scopeKind} AND scope_id = ${String(scopeId || '')}
         AND (${includeInactive} OR is_active = TRUE)
       ORDER BY position ASC, created_at ASC`));
    return r.map(mapItem);
  } catch (e: any) {
    console.error(MOD, 'could not read the fee schedule for', scopeKind, scopeId, '-', why(e));
    throw new Error('The fee schedule could not be read: ' + why(e));
  }
}

export interface SaveScheduleItemInput {
  scopeKind: FeeScopeKind;
  scopeId: string;
  code: string;
  chargeType: ChargeType;
  label: string;
  amountMinor: number;
  currency?: string;
  quantity?: number;
  taxable?: boolean;
  mandatory?: boolean;
  refundable?: boolean;
  position?: number;
  note?: string | null;
  isActive?: boolean;
}

/**
 * Write one charge line.
 *
 * THE CAPABILITY IS THE SURFACE'S TO CHECK — `courses.pricing.manage`, which already exists in
 * permissions.ts (the union AND PERMS_BY_ROLE) and in registry.ts BUILTIN_PERMISSIONS where it is
 * marked sensitive. It is asked next to the person making the request, where there is a session to
 * attribute it to, rather than here where there is not.
 *
 * NEVER SWALLOWS. A pricing write that fails silently is a course still priced at whatever it was,
 * on a screen that says the new number was saved.
 */
export async function saveScheduleItem(input: SaveScheduleItemInput, actorUserId: string | null): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!isChargeType(input.chargeType)) return { ok: false, error: 'That is not a kind of charge this platform recognises.' };
  const code = String(input.code || '').trim().slice(0, 60);
  if (!code) return { ok: false, error: 'A charge line needs a code, so a receipt and a refund can refer to the same thing.' };
  const amount = minorUnits(input.amountMinor);
  if (amount < 0) return { ok: false, error: 'A charge cannot be negative. Money owed back to a learner is a refund, not a fee.' };
  await ensureFeeScheduleSchema();
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      INSERT INTO fee_schedule_items (
        scope_kind, scope_id, charge_type, code, label, amount_minor, currency,
        quantity, taxable, mandatory, refundable, is_active, position, note, created_by, updated_at)
      VALUES (
        ${input.scopeKind}, ${String(input.scopeId || '')}, ${input.chargeType}, ${code},
        ${String(input.label || chargeTypeLabel(input.chargeType)).slice(0, 300)}, ${amount},
        ${String(input.currency || 'INR').toUpperCase().slice(0, 8)},
        ${Math.max(1, Math.floor(Number(input.quantity) || 1))},
        ${input.taxable !== false}, ${input.mandatory !== false}, ${input.refundable === true},
        ${input.isActive !== false}, ${Math.floor(Number(input.position) || 0)},
        ${input.note ? String(input.note).slice(0, 500) : null}, ${actorUserId || null}, NOW())
      ON CONFLICT (scope_kind, scope_id, code) DO UPDATE SET
        charge_type = EXCLUDED.charge_type,
        label = EXCLUDED.label,
        amount_minor = EXCLUDED.amount_minor,
        currency = EXCLUDED.currency,
        quantity = EXCLUDED.quantity,
        taxable = EXCLUDED.taxable,
        mandatory = EXCLUDED.mandatory,
        refundable = EXCLUDED.refundable,
        is_active = EXCLUDED.is_active,
        position = EXCLUDED.position,
        note = EXCLUDED.note,
        updated_at = NOW()
      RETURNING id`));
    if (!r.length) return { ok: false, error: 'Nothing was saved and no reason was recorded. Please try again.' };
    return { ok: true, id: String(r[0].id) };
  } catch (e: any) {
    const reason = why(e);
    console.error(MOD, 'saveScheduleItem failed for', input.scopeKind, input.scopeId, code, '-', reason);
    // ON CONFLICT needs the unique index built above. If it never built, say so rather than reporting
    // a saved price that was not saved. (SQLSTATE 42P10 — the same class of fault documented on
    // training_enrollments in learning-progress.ts.)
    if (/no unique or exclusion constraint/i.test(reason)) {
      return { ok: false, error: 'This charge could not be saved because the fee schedule is missing its uniqueness index. Nothing was changed. An administrator needs to check fee_schedule_code_uq.' };
    }
    return { ok: false, error: 'That charge could not be saved. Nothing was changed. (' + reason.slice(0, 160) + ')' };
  }
}

/** Retire a charge line. Never a DELETE: a line a receipt already printed must stay readable. */
export async function deactivateScheduleItem(id: string): Promise<{ ok: boolean; error?: string }> {
  await ensureFeeScheduleSchema();
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      UPDATE fee_schedule_items SET is_active = FALSE, updated_at = NOW()
       WHERE id = ${id}::uuid AND is_active = TRUE RETURNING id`));
    if (!r.length) return { ok: false, error: 'That charge was not retired — it may already be inactive, or it no longer exists.' };
    return { ok: true };
  } catch (e: any) {
    console.error(MOD, 'deactivateScheduleItem failed for', id, '-', why(e));
    return { ok: false, error: 'That charge could not be retired just now. Nothing was changed.' };
  }
}

// =================================================================================================
// THE LEGACY BRIDGE — a course that has a price and not yet a schedule.
// =================================================================================================

/**
 * The floor the live checkout already enforces, in minor units.
 *
 * src/pages/api/aquintutor/start-enrollment.ts refuses an amount between 1 and 1000 paise because
 * `price_inr_paise` is in PAISE and a course saved as "500" charges Rs 5 — that has already taken a
 * real Rs 1.20 payment on this platform. The constant lives here so the guard has ONE definition;
 * the checkout still carries its own copy and should be pointed at this one.
 */
export const SUSPECT_PRICE_CEILING_MINOR = 1000;

export interface CourseFeeLines {
  currency: string;
  lines: ChargeLine[];
  /** True when there is no schedule and the single stored price was read instead. */
  derivedFromLegacyPrice: boolean;
  /** True when the stored price is small enough to be a rupee figure typed into a paise column. */
  priceSuspect: boolean;
  free: boolean;
  notes: string[];
}

/**
 * The charge lines for a training course: the schedule if it has one, otherwise the one price it
 * stores, said out loud as a derivation rather than passed off as a schedule.
 */
export async function courseFeeLines(courseId: string): Promise<CourseFeeLines> {
  const notes: string[] = [];
  const scheduled = await feeSchedule('course', courseId);
  if (scheduled.length) {
    const currencies = Array.from(new Set(scheduled.map((s) => s.currency)));
    if (currencies.length > 1) {
      // Refused, not averaged. src/lib/fx.ts converts; this engine must never guess a rate.
      throw new Error('This course has charges in more than one currency (' + currencies.join(', ') + '). A single quote cannot mix currencies; convert them first.');
    }
    return {
      currency: currencies[0] || 'INR',
      lines: scheduled.map((s) => ({
        code: s.code, type: s.type, label: s.label, amountMinor: s.amountMinor,
        quantity: s.quantity, taxable: s.taxable, mandatory: s.mandatory, refundable: s.refundable,
      })),
      derivedFromLegacyPrice: false,
      priceSuspect: false,
      free: scheduled.every((s) => s.amountMinor === 0),
      notes,
    };
  }

  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`
    SELECT id, title, slug, is_free, is_paid_course, price_inr_paise, access_type
      FROM training_courses WHERE id = ${courseId}::uuid LIMIT 1`));
  const course = r[0] as any;
  if (!course) throw new Error('That course does not exist, so it cannot be priced.');

  const price = minorUnits(course.price_inr_paise);
  const free = course.is_free === true || course.is_paid_course !== true || price <= 0;
  if (free) {
    notes.push('This course has no charges. It is free to whoever may enrol.');
    return { currency: 'INR', lines: [], derivedFromLegacyPrice: false, priceSuspect: false, free: true, notes };
  }

  const suspect = price > 0 && price < SUSPECT_PRICE_CEILING_MINOR;
  if (suspect) {
    notes.push('The stored price for this course is ' + formatMinor(price, 'INR') + ', which is small enough to be a rupee figure typed into a field that counts paise. No payment should be taken against it until somebody confirms the number.');
  }
  notes.push('This course still stores a single price and has no fee schedule. The charge below was derived from that price; adding the real lines replaces it.');
  return {
    currency: 'INR',
    lines: [{ code: 'legacy_base', type: 'base', label: 'Course fee', amountMinor: price, quantity: 1, taxable: true, mandatory: true }],
    derivedFromLegacyPrice: true,
    priceSuspect: suspect,
    free: false,
    notes,
  };
}

// =================================================================================================
// TAX CONFIGURATION — read from the ONE catalogue an administrator already maintains.
// =================================================================================================

/**
 * Map a row from `invoice_tax_components` (src/lib/invoices.ts — THE configurable tax catalogue,
 * empty on a fresh database and deliberately staying empty until somebody configures it) onto this
 * engine's shape. Read-only, and it is a read of another module's table on purpose: two tax
 * catalogues is two chances to charge two different amounts of tax for the same thing.
 *
 * NO COMPLIANCE CLAIM IS MADE HERE, exactly as invoices.ts says of itself: a tax component is
 * something an administrator configures, and this engine applies what it is given.
 */
export function taxComponentFromInvoiceComponent(row: any): FeeTaxComponent {
  const basis = String(row?.basis || 'percent_of_subtotal');
  return {
    code: String(row?.code || ''),
    label: String(row?.label || row?.code || 'Tax'),
    // 'percent_of_subtotal' there means "of the sum of the lines"; here the taxable base is the
    // amount actually payable after adjustments, which is that same intent applied to a fee.
    basis: basis === 'fixed' ? 'fixed' : 'percent_of_taxable_net',
    value: Number(row?.value) || 0,
  };
}

/** Active tax components, or an empty list when none are configured — which is the honest default. */
export async function feeTaxComponents(): Promise<FeeTaxComponent[]> {
  try {
    const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`
      SELECT code, label, basis, value FROM invoice_tax_components
       WHERE is_active = TRUE ORDER BY code ASC`));
    return r.map(taxComponentFromInvoiceComponent);
  } catch (e: any) {
    // A missing catalogue is not an error: this deployment may charge no tax at all. It is logged so
    // "no tax was applied" is never indistinguishable from "the tax table could not be read".
    console.error(MOD, 'tax components could not be read; the quote carries no tax -', why(e));
    return [];
  }
}

// =================================================================================================
// ADAPTERS — turning what other modules already store into adjustments, so nothing is forked.
// =================================================================================================

/**
 * A REDEEMED FEE-WAIVER COUPON. src/lib/fee-waiver-coupons.ts (owned by the course-delivery pass —
 * read here, never edited) treats redemption as waiving the fee outright: recordRedemption() claims
 * the use and the application is materialised with fee_waiver_granted = true. So a coupon maps to a
 * 100% coupon-kind adjustment, and the reason the coupon carries is what the learner is shown.
 */
export function adjustmentFromCoupon(coupon: { id?: string; code?: string; reason?: string | null }): FeeAdjustment {
  return {
    kind: 'coupon',
    code: String(coupon?.code || 'COUPON'),
    label: String(coupon?.reason || 'Fee covered by a code'),
    basis: 'percent',
    value: 100,
    ref: coupon?.id ? String(coupon.id) : null,
  };
}

/**
 * AN APPROVED WAIVER, as src/lib/fee-waiver.ts already stores one: `grant_pct` (a percentage) or
 * `grant_amount` + `grant_currency` (an amount in MAJOR units, DECIMAL(8,2)).
 *
 * `grant_amount` is converted to minor units here and NOT converted between currencies: the currency
 * it was granted in is returned alongside, and a caller quoting in another currency must refuse or
 * convert deliberately through src/lib/fx.ts. An exchange rate applied silently inside a waiver is
 * money nobody decided to give away.
 */
export function adjustmentFromWaiverRecord(row: {
  id?: string;
  grant_pct?: number | null;
  grant_amount?: number | string | null;
  grant_currency?: string | null;
  reason?: string | null;
}): { adjustment: FeeAdjustment | null; currency: string | null; error?: string } {
  const pct = row?.grant_pct === null || row?.grant_pct === undefined ? null : Number(row.grant_pct);
  const label = String(row?.reason || 'Fee waiver granted');
  if (pct !== null && Number.isFinite(pct) && pct > 0) {
    return {
      adjustment: { kind: 'waiver', code: 'waiver', label, basis: 'percent', value: Math.min(100, pct), ref: row?.id ? String(row.id) : null },
      currency: null,
    };
  }
  const amt = Number(row?.grant_amount);
  if (Number.isFinite(amt) && amt > 0) {
    return {
      adjustment: { kind: 'waiver', code: 'waiver', label, basis: 'fixed', value: Math.round(amt * 100), ref: row?.id ? String(row.id) : null },
      currency: String(row?.grant_currency || 'INR').toUpperCase(),
    };
  }
  return { adjustment: null, currency: null, error: 'That waiver record states no percentage and no amount, so there is nothing to apply.' };
}

// =================================================================================================
// THE QUOTE — the whole thing, for one learner and one course.
// =================================================================================================

export interface QuoteInput {
  courseId: string;
  userId?: string | null;
  /** Anything the caller already resolved: a coupon, a waiver decision, a sponsor. */
  adjustments?: FeeAdjustment[];
  /** Set false to quote the list price with no personal awards applied. */
  includeScholarships?: boolean;
  /** Set false to quote without tax (an admin view of the charges themselves). */
  includeTax?: boolean;
}

export interface Quote extends FeeBreakdown {
  courseId: string;
  derivedFromLegacyPrice: boolean;
  priceSuspect: boolean;
  free: boolean;
}

/**
 * WHAT THIS LEARNER OWES FOR THIS COURSE, RIGHT NOW.
 *
 * Never cached, never stored as a number. If a charge has to be frozen — because an order was
 * created against it — freeze the BREAKDOWN alongside the payment (the `notes` column on `payments`
 * already carries one for the application fee, see breakdownForNotes in src/lib/checkout-summary.ts),
 * so the receipt can show the same lines later without the engine having to agree with its own past.
 */
export async function quoteCourseFee(input: QuoteInput): Promise<Quote> {
  const base = await courseFeeLines(input.courseId);
  const adjustments: FeeAdjustment[] = [];

  if (input.includeScholarships !== false && input.userId) {
    try {
      const { scholarshipAdjustments } = await import('@/lib/scholarships');
      const awarded = await scholarshipAdjustments(String(input.userId), input.courseId, base.currency);
      for (const a of awarded.adjustments) adjustments.push(a);
      // An award that could not be applied — a currency this course is not charged in — is carried
      // through to the learner rather than dropped into a log they will never read.
      for (const w of awarded.warnings) base.notes.push(w);
    } catch (e: any) {
      // Reported, never swallowed: a learner who holds an award and is quoted the full fee will pay
      // it, and nobody would ever know the award existed.
      console.error(MOD, 'scholarship awards could not be read for user', input.userId, 'course', input.courseId, '-', why(e));
      base.notes.push('Any scholarship you hold could not be checked just now, so it is not shown below. Please do not pay until this is resolved.');
    }
  }

  for (const a of input.adjustments || []) adjustments.push(a);

  const taxes = input.includeTax === false ? [] : await feeTaxComponents();
  const breakdown = computeFee({ lines: base.lines, adjustments, taxes, currency: base.currency });
  for (const n of base.notes) breakdown.warnings.push(n);

  return {
    ...breakdown,
    courseId: input.courseId,
    derivedFromLegacyPrice: base.derivedFromLegacyPrice,
    priceSuspect: base.priceSuspect,
    free: base.free,
  };
}
