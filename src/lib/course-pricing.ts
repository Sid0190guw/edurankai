// src/lib/course-pricing.ts — WHAT A COURSE COSTS, AND WHO IS EXCUSED FROM PAYING IT.
//
// =================================================================================================
// ACCESS_TYPE ALREADY ANSWERS HALF OF THIS, SO IT IS EXTENDED RATHER THAN REPLACED
// =================================================================================================
//
// `training_courses.access_type` is a four-value string — 'public' | 'employees' | 'applicants' |
// 'both' — and it is enforced identically in five places (start-enrollment.ts, the portal course
// page, the portal catalogue, sitemap.xml.ts and the public course page). It answers exactly one
// question: WHO MAY ENROL AT ALL. It has never been a paywall and it is not turned into one here.
//
// A PRICE ANSWERS A DIFFERENT QUESTION: what it costs the people who may enrol. The four honest
// models the product needs are the PRODUCT of those two facts plus one more — whether the people
// inside the company pay:
//
//   free to everyone                 audience is open, price is zero
//   free to employees, paid public   audience is open, price is set, employees_free is true
//   paid for everyone                audience is open, price is set, employees_free is false
//   closed                           audience is employees only — free to them, not for sale
//
// So this module adds THREE columns and no second notion of who may enrol:
//
//   price_minor      the authored amount, in the minor units of price_currency (paise, centimes)
//   price_currency   the currency it was authored in
//   employees_free   do the people inside the company pay for this one
//
// and keeps the columns that already existed in step with them, because five surfaces read those and
// a price that only one screen agrees with is worse than no price at all:
//
//   price_inr_paise  what the gateway is asked for. Razorpay settles in INR.
//   is_free          true exactly when the chargeable amount is zero
//   is_paid_course   true exactly when it is not
//   pricing_model    'free' | 'paid' — the legacy string three AquinTutor pages render a pill from
//
// A PRICE OF ZERO IS FREE, AND MUST READ AS FREE. formatPrice() returns the word, never '0.00'.
// Nothing in this module produces marketing copy, and no caller may print a figure as a slogan: a
// fee is a field on a course.
//
// =================================================================================================
// WHY THE AUTHORED CURRENCY AND THE CHARGED AMOUNT ARE TWO DIFFERENT NUMBERS
// =================================================================================================
//
// The gateway takes INR paise. A course authored at CHF 40 therefore has to be converted, and the
// rate moves. Both numbers are kept: price_minor + price_currency is what a person decided and what
// every screen shows, and price_inr_paise is the settlement figure. When the authored currency is
// not INR the settlement figure is RECOMPUTED AT CHECKOUT (src/lib/fx.ts, the only converter in this
// codebase) so nobody is charged last month's rate; the stored one is an indicative snapshot for
// listing screens, and it says so.
//
// =================================================================================================
// THE FLOOR, AND WHY IT IS NOT A REFUSAL
// =================================================================================================
//
// start-enrollment.ts already refuses to charge under 1000 paise, because price_inr_paise is in
// PAISE and a course saved as "500" meaning five hundred rupees would charge five. That guard stays.
// But a 95% fee waiver on a small course can also land under the floor, and refusing THAT would
// punish somebody for the size of the help they were given. A balance below the floor is treated as
// fully covered and recorded as such — see netAfterWaiver().

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { convertToInrPaise } from '@/lib/fx';
import { logAudit } from '@/lib/audit';

// -------------------------------------------------------------------------------------------------
// CONSTANTS — every one declared ABOVE the functions that read it. `const` is not hoisted, and on
// this project a const under its first use has taken two admin surfaces down.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on `e.cause`; `e.message` is only the SQL that failed. */
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) => console.error('[course-pricing] ' + tag, causeOf(e));

/**
 * The smallest amount this product will ask a gateway for: ten rupees.
 *
 * Below it, a charge is far more likely to be a units mistake (rupees typed into a paise column)
 * than a real price, and the existing checkout already refuses on exactly this figure.
 */
export const MIN_CHARGE_INR_PAISE = 1000;

/**
 * The currencies a course may be priced in. Every one of them is convertible by src/lib/fx.ts, which
 * carries a conservative fallback rate for each in case the rate service is unreachable.
 *
 * Adding one here without adding it there means a course whose price cannot be settled.
 */
export const PRICE_CURRENCIES = ['INR', 'CHF', 'USD', 'EUR', 'GBP'] as const;
export type PriceCurrency = (typeof PRICE_CURRENCIES)[number];

export function isPriceCurrency(v: unknown): v is PriceCurrency {
  return typeof v === 'string' && (PRICE_CURRENCIES as readonly string[]).includes(v.toUpperCase());
}

/** The four access audiences that already exist on training_courses. Not extended, not renamed. */
export const ACCESS_TYPES = ['public', 'employees', 'applicants', 'both'] as const;
export type AccessType = (typeof ACCESS_TYPES)[number];

/**
 * THE FOUR FEE MODELS, DERIVED — never stored as a fifth column.
 *
 * They are a reading of (access_type, price, employees_free), so there is exactly one place a
 * disagreement could come from and it is the three facts themselves. A stored model string would be
 * a fourth fact that drifts from the other three the first time somebody edits one of them.
 */
export type FeeModel = 'free_to_all' | 'employees_free_public_paid' | 'paid_for_all' | 'closed';

export const FEE_MODEL_LABELS: Record<FeeModel, string> = {
  free_to_all: 'Free to everyone',
  employees_free_public_paid: 'Free for our team, paid for everyone else',
  paid_for_all: 'Paid',
  closed: 'Closed - our team only, not for sale',
};

// -------------------------------------------------------------------------------------------------
// THE SHAPES
// -------------------------------------------------------------------------------------------------

/** The pricing facts of one course, as this module reads them. */
export interface CoursePricing {
  courseId: string;
  slug: string | null;
  title: string | null;
  accessType: AccessType;
  /** The authored amount, in minor units of `currency`. Zero means free. */
  priceMinor: number;
  currency: PriceCurrency;
  employeesFree: boolean;
  /** Indicative settlement figure stored on the row. Recomputed at checkout for non-INR prices. */
  storedInrPaise: number;
  feeModel: FeeModel;
  /** Can anybody buy this at all? False for a closed course whatever its price says. */
  purchasable: boolean;
}

/** What one signed-in person would pay for one course, and why. */
export interface PriceForUser {
  /** Is this person in the course's audience at all? */
  allowed: boolean;
  /** Nothing to pay: free course, employee on an employees-free course, or a full waiver. */
  free: boolean;
  /** The amount still owed, in minor units of `currency`. Zero when free. */
  payableMinor: number;
  currency: PriceCurrency;
  /** The list price before any waiver, for a screen that wants to show what was covered. */
  listMinor: number;
  /** One sentence a person can read. Never a database message, never a slogan. */
  reason: string;
  feeModel: FeeModel;
}

/** The user shape this module needs. Deliberately tiny — it must work for a learner with no role. */
export interface PricedUser {
  id?: string | null;
  role?: string | null;
}

// -------------------------------------------------------------------------------------------------
// SCHEMA. ADDITIVE ONLY, AND VERIFIED RATHER THAN ASSUMED.
// -------------------------------------------------------------------------------------------------

let pricingSchema: Promise<boolean> | null = null;

/**
 * Add the three pricing columns to training_courses if they are absent.
 *
 * RETURNS WHETHER THE COLUMNS ARE ACTUALLY THERE, read back from information_schema — not whether
 * the DDL appeared to succeed. `CREATE ... IF NOT EXISTS` is a no-op on an existing object even when
 * that object is missing what was asked for, and this project has already lost a day to a column
 * that was declared in a file and absent from the live table. Callers that write a price MUST check
 * this answer; a write into a column that does not exist is a price nobody is charged.
 *
 * On failure the memoised promise is cleared so the next call retries rather than the process
 * carrying a permanent false.
 */
export function ensureCoursePricingSchema(): Promise<boolean> {
  if (pricingSchema) return pricingSchema;
  pricingSchema = (async () => {
    try {
      await db.execute(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS price_minor INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS price_currency VARCHAR(8) NOT NULL DEFAULT 'INR'`);
      await db.execute(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS employees_free BOOLEAN NOT NULL DEFAULT true`);
      await db.execute(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS price_updated_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS price_updated_by UUID`);
      // The columns the checkout and five reading surfaces already depend on. Asserted, never
      // assumed: price_inr_paise and is_paid_course have no CREATE anywhere in this repository.
      await db.execute(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS price_inr_paise INTEGER NOT NULL DEFAULT 0`);
      await db.execute(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS is_paid_course BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT true`);
      // Three AquinTutor pages render a pill from this legacy string. It is kept in step by the
      // writer below rather than left to disagree with the price beside it.
      await db.execute(sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS pricing_model VARCHAR(24) NOT NULL DEFAULT 'free'`);
    } catch (e: any) {
      logFail('ensureCoursePricingSchema', e);
    }

    // THE VERIFICATION. src/lib/ensure-once.ts swallows DDL failures by design, so no ensure return
    // in this codebase is evidence of anything. This one asks the catalogue.
    try {
      const found = rowsOf(await db.execute(sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'training_courses'
           AND column_name IN ('price_minor', 'price_currency', 'employees_free', 'price_inr_paise')`))
        .map((r: any) => String(r.column_name));
      const missing = ['price_minor', 'price_currency', 'employees_free', 'price_inr_paise']
        .filter((c) => !found.includes(c));
      if (missing.length) {
        console.error('[course-pricing] pricing columns are NOT on training_courses:', missing.join(', ')
          + ' - no price can be stored or charged until they are.');
        return false;
      }
      return true;
    } catch (e: any) {
      logFail('ensureCoursePricingSchema.verify', e);
      return false;
    }
  })().catch((e: any) => {
    logFail('ensureCoursePricingSchema', e);
    pricingSchema = null;
    return false;
  });
  return pricingSchema;
}

// -------------------------------------------------------------------------------------------------
// PURE READINGS. No database, no user session — these are the arithmetic and they are unit-tested.
// -------------------------------------------------------------------------------------------------

/** Normalise whatever came out of the row into one of the four audiences. */
export function accessTypeOf(raw: unknown): AccessType {
  const v = String(raw || '').trim().toLowerCase();
  return (ACCESS_TYPES as readonly string[]).includes(v) ? (v as AccessType) : 'public';
}

export function normaliseCurrency(raw: unknown): PriceCurrency {
  const v = String(raw || 'INR').trim().toUpperCase();
  return isPriceCurrency(v) ? (v as PriceCurrency) : 'INR';
}

/**
 * IS THIS COURSE FOR SALE AT ALL?
 *
 * Only an OPEN audience is. A course restricted to one internal audience is closed: the people it is
 * for get it as part of being here, and nobody else can buy their way in. That is the fourth model,
 * and expressing it as "audience is restricted" rather than as a separate not_for_sale flag is what
 * keeps access_type the single answer to who may enrol.
 */
export function isPurchasable(accessType: AccessType): boolean {
  return accessType === 'public' || accessType === 'both';
}

/** Which of the four models this course is in. Derived from the three facts and nothing else. */
export function feeModelOf(accessType: AccessType, priceMinor: number, employeesFree: boolean): FeeModel {
  const price = Math.max(0, Math.floor(Number(priceMinor) || 0));
  if (!isPurchasable(accessType)) return 'closed';
  if (price === 0) return 'free_to_all';
  return employeesFree ? 'employees_free_public_paid' : 'paid_for_all';
}

/**
 * IS THIS PERSON TREATED AS ONE OF OURS FOR PRICING?
 *
 * `user.role !== 'applicant'` — the SAME test the five access_type gates already apply, reproduced
 * here on purpose and in ONE place instead of a sixth copy.
 *
 * IT IS KNOWN TO BE WRONG IN PRINCIPLE AND IS DELIBERATELY NOT FIXED HERE.
 * src/pages/api/aquintutor/start-enrollment.ts carries the long note: employment is a FACT held in
 * hr_employees, not an ability a role grants, and this test sweeps in `partner`, `teacher` and
 * `technical_moderator` — external AquinTutor scopes who are employees of nobody. Correcting it
 * changes WHO GETS A COURSE FREE, which is a policy decision with money attached, so it is reported
 * for a human rather than made in passing. Centralising it here is the mechanism half: when somebody
 * does decide, it is one function and every surface follows.
 */
export function treatedAsEmployee(user: PricedUser | null | undefined): boolean {
  const role = String(user?.role || '').trim();
  return !!role && role !== 'applicant';
}

/** Is this person inside the course's audience? The same rule as the five existing gates. */
export function audienceAllows(accessType: AccessType, user: PricedUser | null | undefined): boolean {
  const employee = treatedAsEmployee(user);
  if (accessType === 'public' || accessType === 'both') return true;
  if (accessType === 'employees') return employee;
  if (accessType === 'applicants') return !employee;
  return false;
}

/**
 * A PRICE AS A PERSON READS IT. Zero is the word "Free", never a zero with decimals.
 *
 * No currency symbols beyond the ISO code: the code is unambiguous, and a symbol invites the figure
 * to be pasted into a headline. A fee is a field.
 */
export function formatPrice(minor: number, currency: string): string {
  const n = Math.max(0, Math.floor(Number(minor) || 0));
  if (n === 0) return 'Free';
  return normaliseCurrency(currency) + ' ' + (n / 100).toFixed(2);
}

/**
 * WHAT IS LEFT TO PAY AFTER A WAIVER, in the same minor units.
 *
 * `grantPct` is 0-100. 100 (or anything that reduces the balance below the gateway floor) leaves
 * nothing to pay: a balance the gateway cannot take is not a reason to refuse somebody the course
 * they were granted help with. The rounding is toward the LEARNER — a part-rupee always goes their
 * way, because the alternative is arguing with somebody about a paisa.
 */
export function netAfterWaiver(listMinor: number, grantPct: number | null | undefined, inrPaiseFloor = MIN_CHARGE_INR_PAISE): number {
  const list = Math.max(0, Math.floor(Number(listMinor) || 0));
  if (list === 0) return 0;
  const pct = Math.min(100, Math.max(0, Math.floor(Number(grantPct) || 0)));
  if (pct <= 0) return list;
  if (pct >= 100) return 0;
  const net = Math.floor(list - (list * pct) / 100);
  if (net <= 0) return 0;
  // The floor is expressed in INR paise. For a non-INR price it is a conservative approximation —
  // every supported currency is worth more than the rupee, so treating its minor units as paise can
  // only ever be MORE generous to the learner, never less.
  return net < inrPaiseFloor ? 0 : net;
}

/** How much of the list price a grant covers, in minor units — for the receipt and the record. */
export function coveredByWaiver(listMinor: number, grantPct: number | null | undefined): number {
  const list = Math.max(0, Math.floor(Number(listMinor) || 0));
  return Math.max(0, list - netAfterWaiver(list, grantPct));
}

/**
 * WHAT THIS PERSON PAYS FOR THIS COURSE, BEFORE ANY WAIVER IS APPLIED.
 *
 * Pure. It reads the course's three pricing facts and the person's audience, and it returns a
 * sentence with every answer so a screen never has to invent one.
 */
export function priceForUser(pricing: CoursePricing, user: PricedUser | null | undefined): PriceForUser {
  const base = {
    currency: pricing.currency,
    listMinor: pricing.priceMinor,
    feeModel: pricing.feeModel,
  };

  if (!audienceAllows(pricing.accessType, user)) {
    return { ...base, allowed: false, free: false, payableMinor: 0, reason: 'This course is not open to your account.' };
  }

  if (pricing.feeModel === 'closed') {
    return {
      ...base,
      allowed: true,
      free: true,
      payableMinor: 0,
      reason: 'This course is part of working here. There is nothing to pay.',
    };
  }

  if (pricing.priceMinor === 0) {
    return { ...base, allowed: true, free: true, payableMinor: 0, reason: 'This course is free.' };
  }

  if (pricing.employeesFree && treatedAsEmployee(user)) {
    return {
      ...base,
      allowed: true,
      free: true,
      payableMinor: 0,
      reason: 'This course is free for our team. There is nothing to pay.',
    };
  }

  return {
    ...base,
    allowed: true,
    free: false,
    payableMinor: pricing.priceMinor,
    reason: 'This course costs ' + formatPrice(pricing.priceMinor, pricing.currency) + '.',
  };
}

/** Build the pricing facts from a training_courses row. Tolerates every legacy shape of that row. */
export function pricingFromRow(row: any): CoursePricing {
  const accessType = accessTypeOf(row?.access_type);
  const currency = normaliseCurrency(row?.price_currency);
  // price_minor is the authored figure. Where it has never been written (every course that predates
  // this module) fall back to the legacy INR paise column, which IS the authored figure for an INR
  // course — so nothing that was already priced silently becomes free.
  const authored = Number(row?.price_minor);
  const legacy = Number(row?.price_inr_paise);
  let priceMinor = Number.isFinite(authored) && authored > 0
    ? Math.floor(authored)
    : (currency === 'INR' && Number.isFinite(legacy) && legacy > 0 ? Math.floor(legacy) : 0);
  // An explicit is_free wins over a stale figure: it is what four admin forms write today.
  if (row?.is_free === true) priceMinor = 0;
  const employeesFree = row?.employees_free === false ? false : true;
  return {
    courseId: String(row?.id || ''),
    slug: row?.slug ? String(row.slug) : null,
    title: row?.title ? String(row.title) : null,
    accessType,
    priceMinor,
    currency,
    employeesFree,
    storedInrPaise: Number.isFinite(legacy) ? Math.max(0, Math.floor(legacy)) : 0,
    feeModel: feeModelOf(accessType, priceMinor, employeesFree),
    purchasable: isPurchasable(accessType),
  };
}

// -------------------------------------------------------------------------------------------------
// READS AND WRITES
// -------------------------------------------------------------------------------------------------

/** The pricing facts for one course, by id or by slug. Null when there is no such published course. */
export async function getCoursePricing(idOrSlug: string, opts: { publishedOnly?: boolean } = {}): Promise<CoursePricing | null> {
  const key = String(idOrSlug || '').trim();
  if (!key) return null;
  await ensureCoursePricingSchema();
  try {
    const r = await db.execute(sql`
      SELECT id, slug, title, access_type, is_free, is_paid_course,
             price_inr_paise, price_minor, price_currency, employees_free, is_published
        FROM training_courses
       WHERE (id::text = ${key} OR slug = ${key})
         ${opts.publishedOnly ? sql`AND is_published = true` : sql``}
       LIMIT 1`);
    const row = rowsOf(r)[0];
    return row ? pricingFromRow(row) : null;
  } catch (e: any) {
    logFail('getCoursePricing', e);
    return null;
  }
}

/**
 * THE AMOUNT THE GATEWAY IS ASKED FOR, in INR paise, for a balance expressed in the authored
 * currency. The only converter in this codebase is src/lib/fx.ts and this is the only caller of it
 * on the course path.
 *
 * Returns `live: false` when the rate service could not be reached and a fallback rate was used —
 * the caller decides whether that is acceptable to charge on, and the answer is recorded in the
 * payment notes either way, because "what rate did we use" is a question somebody asks after a
 * refund request and there must be an answer.
 */
export async function chargeInrPaise(minor: number, currency: PriceCurrency): Promise<{ paise: number; rate: number; live: boolean; date: string }> {
  const amount = Math.max(0, Math.floor(Number(minor) || 0));
  if (amount === 0) return { paise: 0, rate: 1, live: true, date: new Date().toISOString().substring(0, 10) };
  if (currency === 'INR') return { paise: amount, rate: 1, live: true, date: new Date().toISOString().substring(0, 10) };
  const fx = await convertToInrPaise(currency, amount);
  return { paise: fx.paise, rate: fx.rate, live: fx.live, date: fx.date };
}

export interface SetPricingInput {
  courseId: string;
  priceMinor: number;
  currency: string;
  employeesFree: boolean;
  /** Optional: set the audience in the same write, so the fee model cannot be half-changed. */
  accessType?: string | null;
  actorUserId: string | null;
}

export interface SetPricingResult {
  ok: boolean;
  error?: string;
  pricing?: CoursePricing;
  /** Set when the price stored for settlement had to be converted and the rate was not live. */
  warning?: string;
}

/**
 * SET WHAT A COURSE COSTS. The one writer.
 *
 * It writes the three new columns AND the four legacy ones in a single statement, so no reader can
 * ever see half a change: four admin forms and five enrolment gates read those legacy columns, and a
 * course that is is_free=true with a price on it is a course that is sold and given away at the same
 * time depending on which screen you opened.
 *
 * AUTHORIZATION IS NOT ASKED HERE. This is a mechanism, and the capability
 * (`courses.pricing.manage`) is checked by the surface that calls it — the same shape every other
 * writer in this codebase uses. The AUDIT is written here, because an audit that depends on every
 * caller remembering to write it is an audit with holes in it.
 */
export async function setCoursePricing(input: SetPricingInput): Promise<SetPricingResult> {
  const courseId = String(input?.courseId || '').trim();
  if (!courseId) return { ok: false, error: 'That is not a course.' };

  const currency = normaliseCurrency(input?.currency);
  const priceMinor = Math.max(0, Math.floor(Number(input?.priceMinor) || 0));
  const employeesFree = input?.employeesFree !== false;
  const accessType = input?.accessType ? accessTypeOf(input.accessType) : null;

  // A PRICE THE GATEWAY CANNOT TAKE IS REFUSED AT THE FORM, not discovered at the checkout by a
  // learner. Zero is fine — that is free. Anything between zero and the floor is a units mistake
  // nine times out of ten, and the tenth time it is a price nobody can pay.
  if (priceMinor > 0 && priceMinor < MIN_CHARGE_INR_PAISE) {
    return {
      ok: false,
      error: 'A price has to be at least ' + formatPrice(MIN_CHARGE_INR_PAISE, currency)
        + '. Amounts are entered in whole units - 499 means four hundred and ninety-nine, not four rupees ninety-nine.',
    };
  }

  const ready = await ensureCoursePricingSchema();
  if (!ready) {
    return { ok: false, error: 'The price columns are not present on this database, so nothing was saved. This is on us - the log names the missing columns.' };
  }

  // The settlement snapshot. For an INR price it is the same number; for anything else it is a
  // conversion, and a non-live rate is reported rather than hidden — the checkout recomputes it
  // anyway, so a stale snapshot misleads a listing screen rather than a payer.
  let inrPaise = priceMinor;
  let warning: string | undefined;
  if (priceMinor > 0 && currency !== 'INR') {
    const fx = await chargeInrPaise(priceMinor, currency);
    inrPaise = fx.paise;
    if (!fx.live) warning = 'The exchange rate service could not be reached, so the settlement figure shown on listing screens uses a fallback rate. The amount actually charged is recalculated at checkout.';
  }

  const isFree = priceMinor === 0;
  const purchasable = accessType ? isPurchasable(accessType) : null;

  try {
    const updated = rowsOf(await db.execute(sql`
      UPDATE training_courses
         SET price_minor = ${priceMinor},
             price_currency = ${currency},
             employees_free = ${employeesFree},
             price_inr_paise = ${isFree ? 0 : inrPaise},
             is_free = ${isFree},
             is_paid_course = ${!isFree},
             pricing_model = ${isFree ? 'free' : 'paid'},
             access_type = COALESCE(${accessType}::text, access_type),
             price_updated_at = NOW(),
             price_updated_by = ${input.actorUserId || null}::uuid,
             updated_at = NOW()
       WHERE id = ${courseId}::uuid
      RETURNING id, slug, title, access_type, is_free, is_paid_course,
                price_inr_paise, price_minor, price_currency, employees_free`));

    if (!updated.length) {
      return { ok: false, error: 'That course could not be found, so nothing was saved.' };
    }

    const pricing = pricingFromRow(updated[0]);

    // A CLOSED COURSE WITH A PRICE ON IT IS A CONTRADICTION, and the reader would resolve it silently
    // (isPurchasable is false, so nobody is ever charged). Say so instead of leaving a number on a
    // row that nothing will ever read.
    if (purchasable === false && priceMinor > 0) {
      warning = 'This course is restricted to one audience, so it is not for sale and the price will not be charged to anybody. Set the audience to open if you meant to sell it.';
    }

    await logAudit({
      userId: input.actorUserId,
      action: 'course.pricing.set',
      entity: 'training_course',
      entityId: courseId,
      diff: {
        priceMinor,
        currency,
        employeesFree,
        accessType: pricing.accessType,
        feeModel: pricing.feeModel,
        settlementInrPaise: pricing.storedInrPaise,
      },
    });

    return { ok: true, pricing, warning };
  } catch (e: any) {
    // The learner-facing sentence never carries the database's words; the log always does.
    logFail('setCoursePricing', e);
    return { ok: false, error: 'That price could not be saved. Nothing was changed. Try again in a moment.' };
  }
}
