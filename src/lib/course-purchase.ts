// src/lib/course-purchase.ts — BUYING A COURSE, ON THE PAYMENT PATH THAT ALREADY EXISTS.
//
// =================================================================================================
// NO SECOND PAYMENT PATH. THIS IS THE ONE.
// =================================================================================================
//
// The gateway primitive is src/lib/razorpay.ts. The record is the `payments` table, which is already
// polymorphic — reference_type 'training_course' is already one of its values — and which already
// carries refunds, receipts (/receipt/[order]), reconciliation and the finance console. The order is
// created by /api/aquintutor/start-enrollment, which this module now does the work for; nothing here
// creates a table, a second order endpoint, or a second reconcile.
//
// WHAT THIS MODULE ADDS is the part that was missing rather than duplicated:
//
//   1. THE PRICE COMES FROM THE COURSE AND THE PERSON, SERVER-SIDE. Never from the browser. The
//      caller sends a course slug; everything else is read here.
//   2. AN APPROVED WAIVER IS APPLIED BEFORE THE ORDER IS CREATED, so a partial waiver leaves a
//      balance that goes through the SAME verified path as a full price. There is no second
//      "waived" enrolment door that skips verification.
//   3. PAYING TWICE FOR ONE COURSE IS REFUSED BEFORE ANY MONEY MOVES. An existing enrolment, or an
//      existing captured payment against this course, is answered with a sentence — not with a
//      second order that takes the money and then discovers the duplicate.
//   4. THE ENROLMENT EFFECT IS SHARED. completeCoursePurchase() is called by the browser
//      confirmation AND by applyPaidEffects() — so the webhook and the reconcile backstop finish a
//      purchase whose browser died mid-checkout. Until now course confirmation existed ONLY on the
//      browser route, which meant a closed tab was a paid learner with no course.
//
// =================================================================================================
// ENROLMENT FOLLOWS A VERIFIED PAYMENT AND NOTHING ELSE
// =================================================================================================
//
// Nothing in this module enrols anybody because a browser said it paid. The two ways in are:
//
//   - the gateway signature verifies (HMAC over order|payment, checked in src/lib/razorpay.ts) AND
//     the stored payments row is not refunded; or
//   - the price for this person is genuinely zero: a free course, an employees-free course for
//     somebody inside the company, or a waiver that covers the whole fee. That path takes no money
//     and writes a zero-value receipt row saying exactly why.
//
// A failed signature check is never swallowed: the caller flags the row 'signature_mismatch' and
// says so, which is the behaviour /api/aquintutor/confirm-payment already had and keeps.
//
// =================================================================================================
// ON CONFLICT (course_id, user_id) DOES NOT WORK ON THIS TABLE
// =================================================================================================
//
// `training_enrollments` HAS NO UNIQUE KEY on (course_id, user_id) — src/lib/learning-progress.ts,
// src/lib/learning-admin.ts, src/lib/performance-learning.ts and the portal course page all say so
// in their own comments. Postgres answers an ON CONFLICT naming columns with no matching constraint
// by REFUSING THE WHOLE STATEMENT, so the confirmation route's
// `ON CONFLICT (course_id, user_id) DO UPDATE` could not ever have enrolled a paying learner: it
// throws, the catch turns it into "we could not finish that enrolment", and the money is already
// taken. The insert below is the INSERT ... SELECT ... WHERE NOT EXISTS form that ensureEnrolment()
// uses for exactly this reason.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createOrder, getPublicKeyId, isConfigured } from '@/lib/razorpay';
import { logAudit } from '@/lib/audit';
import {
  MIN_CHARGE_INR_PAISE,
  chargeInrPaise,
  formatPrice,
  getCoursePricing,
  type PriceCurrency,
} from '@/lib/course-pricing';
import { consumeWaiver, payableForCourse } from '@/lib/course-waiver';

// -------------------------------------------------------------------------------------------------
// CONSTANTS — above every function that reads them. `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) => console.error('[course-purchase] ' + tag, causeOf(e));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** A refunded payment is terminal. Nothing re-grants a course off one. */
export const TERMINAL_PAYMENT_STATES = ['refunded', 'partially_refunded'];

/** The purpose written on a course order, and the polymorphic reference the payments table uses. */
export const COURSE_PURPOSE = 'course_enrollment';
export const COURSE_REFERENCE_TYPE = 'training_course';
/** A zero-value receipt for a course somebody did not have to pay for. */
export const COURSE_WAIVED_PURPOSE = 'course_fee_waived';

export interface PurchaseUser {
  id?: string | null;
  role?: string | null;
  email?: string | null;
  name?: string | null;
}

export type StartPurchaseResult =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      paid: false;
      alreadyEnrolled?: boolean;
      /** Set when the course was granted without payment, so a screen can say why. */
      reason: string;
      redirect: string;
    }
  | {
      ok: true;
      paid: true;
      orderId: string;
      keyId: string | null;
      amountPaise: number;
      currency: 'INR';
      /** What the learner is being asked for, in the currency the course is priced in. */
      displayAmount: string;
      courseTitle: string;
      courseSlug: string;
      waiverPct: number | null;
      prefill: { name: string; email: string };
    };

// -------------------------------------------------------------------------------------------------
// ALREADY BOUGHT?
// -------------------------------------------------------------------------------------------------

export interface OwnershipCheck {
  /** They already have the course. */
  enrolled: boolean;
  /** A captured, non-refunded payment exists for this course and this person. */
  paid: boolean;
  /** The order id of that payment, so a screen can point at the receipt. */
  orderId: string | null;
}

/**
 * DOES THIS PERSON ALREADY OWN THIS COURSE?
 *
 * Asked BEFORE an order is created, and answered from two independent facts, because either alone
 * has a hole: an enrolment can exist without a payment (a free course, an HR assignment), and a
 * payment can exist without an enrolment (the confirmation failed and reconcile has not run yet).
 * Taking money in either case is charging somebody twice for one thing.
 *
 * Returns null when the answer could not be read, and the caller refuses rather than proceeding:
 * "not owned" is the answer that takes the money, so it must never be the answer a failed query
 * produces.
 */
export async function ownershipOf(userId: string, courseId: string): Promise<OwnershipCheck | null> {
  if (!isUuid(userId) || !isUuid(courseId)) return null;
  try {
    const enrol = rowsOf(await db.execute(sql`
      SELECT id FROM training_enrollments
       WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid LIMIT 1`));
    const paid = rowsOf(await db.execute(sql`
      SELECT order_id FROM payments
       WHERE user_id = ${userId}::uuid
         AND reference_type = ${COURSE_REFERENCE_TYPE}
         AND reference_id = ${courseId}::uuid
         AND status = 'paid'
       ORDER BY created_at DESC LIMIT 1`));
    return {
      enrolled: enrol.length > 0,
      paid: paid.length > 0,
      orderId: paid.length ? String((paid[0] as any).order_id) : null,
    };
  } catch (e: any) {
    logFail('ownershipOf', e);
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// STARTING A PURCHASE
// -------------------------------------------------------------------------------------------------

/**
 * Everything /api/aquintutor/start-enrollment does, with the price and the waiver resolved here.
 *
 * THE ORDER OF THE CHECKS IS THE POINT:
 *   1. the course exists and is published;
 *   2. this person is in its audience;
 *   3. THEY DO NOT ALREADY OWN IT — before anything touches the gateway;
 *   4. what they owe, after any granted waiver, computed server-side;
 *   5. zero owed -> enrol now and write a zero-value receipt saying why;
 *   6. otherwise create ONE order and ONE payments row, and refuse the whole thing if the row
 *      cannot be written — that row is the only record of which course was bought and by whom.
 */
export async function startCoursePurchase(user: PurchaseUser, courseSlug: string): Promise<StartPurchaseResult> {
  const userId = String(user?.id || '').trim();
  if (!isUuid(userId)) return { ok: false, status: 401, error: 'Please sign in to enrol.' };

  const slug = String(courseSlug || '').trim();
  if (!slug) return { ok: false, status: 400, error: 'Which course?' };

  const pricing = await getCoursePricing(slug, { publishedOnly: true });
  if (!pricing) return { ok: false, status: 404, error: 'That course could not be found.' };

  const payable = await payableForCourse({ id: userId, role: user?.role || null }, pricing.courseId);
  if (!payable) return { ok: false, status: 404, error: 'That course could not be found.' };
  if (!payable.allowed) return { ok: false, status: 403, error: 'That course is not open to your account.' };

  // ---------------------------------------------------------------------------------------------
  // PAYING TWICE FOR ONE COURSE MUST NOT BE POSSIBLE, and the refusal has to SAY SO.
  //
  // "You already have this course" is the whole message. A second order that quietly succeeds and
  // then enrols an already-enrolled person is a charge nobody can explain to the payer.
  // ---------------------------------------------------------------------------------------------
  const owned = await ownershipOf(userId, pricing.courseId);
  if (!owned) {
    return {
      ok: false,
      status: 503,
      error: 'We could not check whether you already have this course, so we have not taken any payment. Try again in a moment.',
    };
  }
  if (owned.paid) {
    return {
      ok: false,
      status: 409,
      error: 'You have already paid for this course, so we have not charged you again. Open it from your courses'
        + (owned.orderId ? ' - your receipt is at /receipt/' + owned.orderId + '.' : '.'),
    };
  }
  if (owned.enrolled) {
    return { ok: true, paid: false, alreadyEnrolled: true, reason: 'You are already enrolled on this course.', redirect: '/portal/courses/' + pricing.slug };
  }

  // ---------------------------------------------------------------------------------------------
  // NOTHING TO PAY. Free course, free for our team, or a waiver that covers the whole fee.
  // ---------------------------------------------------------------------------------------------
  if (payable.free || payable.payableMinor <= 0) {
    const granted = await grantFreeEnrolment({
      userId,
      email: user?.email || null,
      pricing: { courseId: pricing.courseId, slug: pricing.slug, title: pricing.title, currency: pricing.currency },
      listMinor: payable.listMinor,
      waiverId: payable.waiver && payable.waiver.status === 'approved' ? payable.waiver.id : null,
      grantPct: payable.grantPct,
      reason: payable.reason,
    });
    if (!granted.ok) return { ok: false, status: 500, error: granted.error || 'We could not start that course just now. Try again in a moment.' };
    return { ok: true, paid: false, reason: payable.reason, redirect: '/portal/courses/' + pricing.slug };
  }

  if (!isConfigured()) {
    return { ok: false, status: 503, error: 'Payments are not available just now, so nothing was charged. Write to connect@edurankai.in and we will enrol you.' };
  }

  // The settlement figure, recomputed now rather than read from a stored snapshot: a course priced
  // in a currency other than the rupee must be charged at today's rate, not at the rate on the day
  // somebody typed the price in.
  const fx = await chargeInrPaise(payable.payableMinor, payable.currency);
  const amountPaise = fx.paise;

  // THE ABSURD-PRICE GUARD, KEPT. price_inr_paise is in PAISE, and a course saved as 500 meaning
  // "five hundred rupees" charges five. A failed checkout is a support message; a wrong charge is a
  // refund, a reconciliation problem and a learner who believes they have paid.
  if (amountPaise < MIN_CHARGE_INR_PAISE) {
    console.error('[course-purchase] refusing an amount below the floor', {
      slug: pricing.slug, amountPaise, payableMinor: payable.payableMinor, currency: payable.currency,
    });
    return {
      ok: false,
      status: 409,
      error: 'This course is not correctly priced yet, so we have not taken any payment. Please write to connect@edurankai.in and we will sort it out.',
    };
  }

  const receipt = 'aq_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const order = await createOrder({
    amountPaise,
    currency: 'INR',
    receipt,
    notes: {
      purpose: COURSE_PURPOSE,
      courseSlug: pricing.slug || '',
      userId,
      email: user?.email || '',
    },
  });
  if (!order.ok) return { ok: false, status: 502, error: order.error || 'Checkout could not be opened just now, so nothing was charged.' };

  // THE PAYMENTS ROW IS NOT OPTIONAL AND ITS FAILURE IS NOT SWALLOWED. It is the ONLY record of
  // which course was bought and by whom; without it the confirmation answers "payment record
  // missing" and support has nothing to find, reconcile or refund against. Refusing costs an unused
  // order that expires on its own and charges nobody.
  //
  // The notes are a BOUND PARAMETER cast to jsonb, not a hand-quoted string built with sql.raw. The
  // quoting trick used elsewhere on this path is correct today only because every value in it is
  // internally generated; these notes carry a waiver id and a percentage, and the first
  // user-supplied string dropped into a hand-rolled quoter is the bug.
  const notes = JSON.stringify({
    receipt,
    courseSlug: pricing.slug,
    listMinor: payable.listMinor,
    payableMinor: payable.payableMinor,
    currency: payable.currency,
    waiverId: payable.waiver && payable.waiver.status === 'approved' ? payable.waiver.id : null,
    waiverPct: payable.grantPct,
    fxRate: fx.rate,
    fxLive: fx.live,
    fxDate: fx.date,
  });

  try {
    await db.execute(sql`
      INSERT INTO payments (
        order_id, amount_paise, currency, status, purpose,
        reference_type, reference_id, user_id, email, notes
      ) VALUES (
        ${order.order.id}, ${amountPaise}, 'INR', 'created', ${COURSE_PURPOSE},
        ${COURSE_REFERENCE_TYPE}, ${pricing.courseId}::uuid, ${userId}::uuid,
        ${user?.email || 'unknown@edurankai.in'}, ${notes}::jsonb
      )`);
  } catch (e: any) {
    console.error('[course-purchase] order', order.order.id, 'could not be recorded for user', userId,
      'course', pricing.courseId, '-', causeOf(e));
    return { ok: false, status: 500, error: 'We could not open checkout just now, so nothing was charged. Try again in a moment.' };
  }

  return {
    ok: true,
    paid: true,
    orderId: order.order.id,
    keyId: getPublicKeyId(),
    amountPaise,
    currency: 'INR',
    displayAmount: formatPrice(payable.payableMinor, payable.currency),
    courseTitle: pricing.title || 'this course',
    courseSlug: pricing.slug || slug,
    waiverPct: payable.grantPct,
    prefill: { name: user?.name || '', email: user?.email || '' },
  };
}

// -------------------------------------------------------------------------------------------------
// GRANTING A COURSE THAT COSTS THIS PERSON NOTHING
// -------------------------------------------------------------------------------------------------

interface FreeGrantInput {
  userId: string;
  email: string | null;
  pricing: { courseId: string; slug: string | null; title: string | null; currency: PriceCurrency };
  listMinor: number;
  waiverId: string | null;
  grantPct: number | null;
  reason: string;
}

/**
 * Enrol somebody who owes nothing, and leave a RECEIPT saying why they owed nothing.
 *
 * The zero-value payments row is the same device src/lib/fee-waiver.ts already uses for a waived
 * application fee: it makes /receipt/[order] render, and it means the finance console can answer
 * "who got this course for nothing, and on whose decision" without a second table.
 */
async function grantFreeEnrolment(input: FreeGrantInput): Promise<{ ok: boolean; error?: string }> {
  try {
    const created = await enrolOnce(input.userId, input.pricing.courseId, null, 0);

    // A waiver is single-use. Spent here even when the enrolment already existed, because the course
    // has been granted either way and an unspent waiver is a second free course.
    if (input.waiverId) await consumeWaiver(input.waiverId, null);

    if (created) {
      const orderId = 'FREE-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const notes = JSON.stringify({
        waived: true,
        reason: input.reason,
        waiverId: input.waiverId,
        grantPct: input.grantPct,
        listMinor: input.listMinor,
        currency: input.pricing.currency,
        courseSlug: input.pricing.slug,
      });
      await db.execute(sql`
        INSERT INTO payments (order_id, amount_paise, currency, status, purpose, reference_type, reference_id, user_id, email, notes)
        VALUES (${orderId}, 0, 'INR', 'paid', ${COURSE_WAIVED_PURPOSE}, ${COURSE_REFERENCE_TYPE}, ${input.pricing.courseId}::uuid,
                ${input.userId}::uuid, ${input.email || 'unknown@edurankai.in'}, ${notes}::jsonb)`)
        .catch((e: any) => {
          // The learner HAS the course; only the receipt is missing. Logged, never silent, never a
          // reason to tell them the enrolment failed.
          logFail('zero-value receipt', e);
        });

      await logAudit({
        userId: input.userId,
        action: input.waiverId ? 'course.enrolled.waived' : 'course.enrolled.free',
        entity: 'training_course',
        entityId: input.pricing.courseId,
        diff: { waiverId: input.waiverId, grantPct: input.grantPct, listMinor: input.listMinor, currency: input.pricing.currency },
      });
    }
    return { ok: true };
  } catch (e: any) {
    logFail('grantFreeEnrolment', e);
    return { ok: false, error: 'We could not start that course just now. Nothing was charged. Try again in a moment.' };
  }
}

/**
 * ONE ENROLMENT, WHATEVER HAPPENS. Returns true only when THIS call created it.
 *
 * INSERT ... SELECT ... WHERE NOT EXISTS, because training_enrollments has no unique key on
 * (course_id, user_id) — see this file's header. The test and the write are one statement, which is
 * as close to atomic as this table allows without the migration that adds the constraint.
 *
 * THROWS on failure. The callers are a payment confirmation and a paid-effect runner, and both must
 * treat "the money is taken and the learner has nothing" as loud rather than as a return value
 * somebody forgets to read.
 */
async function enrolOnce(userId: string, courseId: string, paymentRowId: string | null, amountPaidPaise: number): Promise<boolean> {
  const made = rowsOf(await db.execute(sql`
    INSERT INTO training_enrollments (course_id, user_id, progress_pct, payment_id, amount_paid_paise)
    SELECT ${courseId}::uuid, ${userId}::uuid, 0, ${paymentRowId}::uuid, ${amountPaidPaise}
     WHERE NOT EXISTS (
       SELECT 1 FROM training_enrollments WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid)
    RETURNING id`));

  if (made.length > 0) {
    // Only a real insert moves the seat counter. A repeat that enrolled nobody used to bump it
    // anyway, and no query could reconcile the number back afterwards.
    await db.execute(sql`UPDATE training_courses SET enrolled_count = COALESCE(enrolled_count, 0) + 1 WHERE id = ${courseId}::uuid`)
      .catch((e: any) => logFail('seat counter', e));
    return true;
  }

  // Already enrolled — attach the payment to the existing row so the record says what was paid.
  if (paymentRowId) {
    await db.execute(sql`
      UPDATE training_enrollments
         SET payment_id = COALESCE(payment_id, ${paymentRowId}::uuid),
             amount_paid_paise = COALESCE(NULLIF(amount_paid_paise, 0), ${amountPaidPaise})
       WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid`)
      .catch((e: any) => logFail('attach payment to existing enrolment', e));
  }
  return false;
}

// -------------------------------------------------------------------------------------------------
// COMPLETING A PURCHASE — THE SHARED EFFECT
// -------------------------------------------------------------------------------------------------

export interface CompleteResult {
  applied: boolean;
  created: boolean;
  courseId: string | null;
  userId: string | null;
  /** Set when the order is not a course purchase at all — the caller simply has nothing to do. */
  notACourse?: boolean;
  /** Set when the order is refunded and therefore terminal. */
  refunded?: boolean;
}

/**
 * ENROL THE PAYER OF THIS ORDER. Idempotent, and safe to call from every direction.
 *
 * THREE CALLERS, ON PURPOSE: the browser confirmation (/api/aquintutor/confirm-payment), the
 * Razorpay webhook and the reconcile backstop (both through applyPaidEffects). Before this existed,
 * course confirmation lived ONLY on the browser route — so a learner whose tab closed between paying
 * and returning was charged and never enrolled, and neither the webhook nor reconcile could finish
 * it. That is not a style point; it is a paid person with no course.
 *
 * IT DOES NOT VERIFY THE SIGNATURE and it does not mark the payment paid. Both are the caller's job,
 * and both already exist: verify does it for the browser, the webhook signature does it for
 * Razorpay, reconcileOrder() does it against the gateway's own record. What this refuses on its own
 * account is a REFUNDED order, because a refund is terminal and a replayed confirmation must never
 * re-grant a course somebody's money was returned for.
 *
 * THROWS when the enrolment itself fails, so runEffect() in payment-effects.ts records it on the
 * payments row and alerts a human. A swallowed failure here is the exact shape of "paid but not
 * applied" that module exists to make impossible.
 */
export async function completeCoursePurchase(orderId: string, paymentId: string | null): Promise<CompleteResult> {
  const order = String(orderId || '').trim();
  const empty: CompleteResult = { applied: false, created: false, courseId: null, userId: null };
  if (!order) return empty;

  const pay = rowsOf(await db.execute(sql`
    SELECT id, user_id, reference_id, reference_type, purpose, amount_paise, status, notes
      FROM payments WHERE order_id = ${order} LIMIT 1`))[0] as any;
  if (!pay) return empty;

  const isCourse = String(pay.purpose || '') === COURSE_PURPOSE
    || String(pay.reference_type || '') === COURSE_REFERENCE_TYPE;
  if (!isCourse) return { ...empty, notACourse: true };

  if (TERMINAL_PAYMENT_STATES.indexOf(String(pay.status || '')) >= 0) {
    console.error('[course-purchase] refused to grant a course against a REFUNDED order', order, '- nothing was changed');
    return { ...empty, refunded: true };
  }

  const courseId = pay.reference_id ? String(pay.reference_id) : '';
  const userId = pay.user_id ? String(pay.user_id) : '';
  if (!isUuid(courseId) || !isUuid(userId)) {
    throw new Error('the payment row for order ' + order + ' does not name both a course and a learner');
  }

  const created = await enrolOnce(userId, courseId, pay.id ? String(pay.id) : null, Number(pay.amount_paise) || 0);

  // Spend the waiver the order was priced with. Recorded on the order at creation, so a partial
  // waiver cannot be used again on a second purchase.
  let waiverId: string | null = null;
  try {
    const notes = typeof pay.notes === 'string' ? JSON.parse(pay.notes) : (pay.notes || {});
    waiverId = notes && notes.waiverId ? String(notes.waiverId) : null;
  } catch (e: any) {
    logFail('reading order notes for order ' + order, e);
  }
  if (waiverId) await consumeWaiver(waiverId, order);

  if (created) {
    await logAudit({
      userId,
      action: 'course.enrolled.paid',
      entity: 'training_course',
      entityId: courseId,
      diff: { orderId: order, paymentId: paymentId || null, amountPaise: Number(pay.amount_paise) || 0, waiverId },
    });
  }

  return { applied: true, created, courseId, userId };
}
