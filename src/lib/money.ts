// -------------------------------------------------------------------------------------------------
// MONEY ARITHMETIC — one implementation, six modules.
//
// WHY THIS FILE EXISTS.
//
// The same helper was written six times:
//
//   const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
//
// in src/lib/payroll.ts, src/lib/loans.ts, src/lib/payroll-bonuses.ts, src/lib/settlement.ts,
// src/lib/hr-leave.ts, and as money() in src/lib/invoices.ts. Six copies of a rounding rule is six
// chances for two modules to disagree about what a payslip is worth — and all six carried the same
// defect.
//
// THE DEFECT. `n * 100` is IEEE754 double arithmetic, so a value whose DECIMAL form ends in a half
// paisa does not necessarily land on a half integer:
//
//   1.005 * 100  ===  100.49999999999999   ->  Math.round -> 100  ->  1.00   (should be 1.01)
//   2.675 * 100  ===  267.49999999999997   ->  Math.round -> 267  ->  2.67   (should be 2.68)
//   8.475 * 100  ===  847.4999999999999    ->  Math.round -> 847  ->  8.47   (should be 8.48)
//
// The bias is always DOWNWARD and it is always against the employee: a percent_of_basic component,
// a per-day loss-of-pay rate, a quantity times a rate, an EMI split into principal and interest —
// any of them can land on a half paisa, and every one of them rounded the wrong way.
//
// THE FIX. Take the decimal value back before rounding. `(Math.abs(v) * 100).toPrecision(15)`
// re-renders the product at 15 significant digits, which is inside a double's honest precision and
// therefore discards the representation artefact while keeping every digit that was really there:
// "100.500000000000" and "267.500000000000". Rounding is then done half-away-from-zero on a number
// that means what it says.
//
// THE DATABASE WAS NEVER THE PROBLEM. Every money column in this codebase is NUMERIC(14,2),
// NUMERIC(14,4) or a BIGINT count of paise. Postgres arithmetic on those is exact. The drift was
// entirely application-side, which is why the fix is entirely here.
//
// WHAT THIS CHANGES FOR REAL PEOPLE: a figure that used to round down by one paisa now rounds up.
// It is a paisa. It is reported as a policy change anyway, because a payslip that does not reconcile
// to the paisa is a payslip somebody has to explain.
// -------------------------------------------------------------------------------------------------

/**
 * Round to two decimals, half away from zero, on the DECIMAL value rather than on the binary double.
 *
 * Use for every currency amount and for the day-units in leave, which are money-shaped (0.5, 0.25).
 * Non-finite input answers 0 — the same answer the six copies gave, so no caller changes behaviour
 * on bad input.
 */
export function round2(n: number | string | null | undefined): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v === 0) return 0;
  const sign = v < 0 ? -1 : 1;
  const scaled = Number((Math.abs(v) * 100).toPrecision(15));
  return (sign * Math.round(scaled)) / 100;
}

/**
 * Round to four decimals — for a RATE, never for an amount. Tax percentages and per-unit rates are
 * NUMERIC(14,4) in the schema; rounding them at two would quietly change a 9.375% band into 9.38%.
 */
export function round4(n: number | string | null | undefined): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v === 0) return 0;
  const sign = v < 0 ? -1 : 1;
  const scaled = Number((Math.abs(v) * 10000).toPrecision(15));
  return (sign * Math.round(scaled)) / 10000;
}

/**
 * Read a NUMERIC that Postgres handed back.
 *
 * postgres-js returns NUMERIC as a STRING precisely so no precision is lost on the way out. Several
 * reads in this codebase threw that away by casting in SQL — `SUM(amount)::float` — which converts
 * an exact decimal into a double before JavaScript ever sees it. Those casts are being removed; this
 * is what replaces them. A string, a number and null all answer correctly.
 */
export function numeric(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? round2(n) : 0;
}

/**
 * A money amount as an integer count of minor units (paise).
 *
 * COMPARISONS BELONG HERE, NOT ON DOUBLES. `available = balance - pending` computed on floats
 * produced 7225.199999999999, so a withdrawal of exactly 7225.20 was refused with a message that
 * quoted 7225.20 as the available balance — the employee was told they had exactly the amount they
 * asked for and denied it. Comparing 722520 with 722520 has no such failure mode.
 */
export function toMinor(n: number | string | null | undefined): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const sign = v < 0 ? -1 : 1;
  return sign * Math.round(Number((Math.abs(v) * 100).toPrecision(15)));
}

/** The inverse of toMinor(). */
export function fromMinor(minor: number | string | null | undefined): number {
  const v = Number(minor);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v) / 100;
}

/**
 * Sum a list of amounts so the total equals the sum of its printed parts.
 *
 * Adding doubles left to right accumulates error; adding integer paise cannot. Every total that a
 * document prints beside its own lines should come through here, so "the lines add up to the total"
 * is a property of the arithmetic rather than a coincidence of the values.
 */
export function sumMoney(values: Array<number | string | null | undefined>): number {
  let minor = 0;
  for (const v of values) minor += toMinor(v);
  return fromMinor(minor);
}
