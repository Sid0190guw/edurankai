// src/lib/course-payments.ts — paid-enrolment records + access gating (Prompt AP5). A payment record
// ties a plan purchase to a course; a captured payment unlocks the enrolment (Prompt 17), a refund
// re-locks it. Additive self-bootstrapping table. Pure gating logic lives in payment-gateway.ts.
import { planById, unlockedByPayment, type PaymentStatus } from '@/lib/payment-gateway';

const PAY_DDL = [
  `CREATE TABLE IF NOT EXISTS edu_course_payments (
    id bigserial PRIMARY KEY, user_id text NOT NULL, course_obj_id text, plan text NOT NULL,
    order_id text, payment_id text, amount_paise integer NOT NULL DEFAULT 0, currency text NOT NULL DEFAULT 'INR',
    status text NOT NULL DEFAULT 'created', mode text NOT NULL DEFAULT 'sandbox', authorized_by text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS edu_course_payments_user_idx ON edu_course_payments (user_id, course_obj_id)`,
  `CREATE INDEX IF NOT EXISTS edu_course_payments_order_idx ON edu_course_payments (order_id)`,
];
let _ready = false;
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); if (!_ready) { for (const d of PAY_DDL) await db.execute(sql.raw(d)); _ready = true; } return { db, sql }; }

export async function recordOrder(userId: string, courseObjId: string | null, planId: string, orderId: string, amountPaise: number, mode: string, authorizedBy?: string | null): Promise<number> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`INSERT INTO edu_course_payments (user_id, course_obj_id, plan, order_id, amount_paise, mode, authorized_by, status)
    VALUES (${userId}, ${courseObjId}, ${planId}, ${orderId}, ${amountPaise}, ${mode}, ${authorizedBy || null}, 'created') RETURNING id`));
  return Number(r[0]?.id || 0);
}
export async function paymentByOrder(orderId: string): Promise<any | null> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM edu_course_payments WHERE order_id = ${orderId} ORDER BY id DESC LIMIT 1`))[0] || null;
}
/** Mark a payment captured and UNLOCK the course enrolment. */
export async function markPaid(orderId: string, paymentId: string): Promise<{ ok: boolean; courseObjId: string | null; userId: string | null }> {
  const { db, sql } = await ctx();
  const row = await paymentByOrder(orderId); if (!row) return { ok: false, courseObjId: null, userId: null };
  await db.execute(sql`UPDATE edu_course_payments SET status = 'paid', payment_id = ${paymentId}, updated_at = now() WHERE order_id = ${orderId}`);
  if (row.course_obj_id) { try { const { enrolInCourse } = await import('@/lib/enrolment'); await enrolInCourse(String(row.user_id), String(row.course_obj_id), null); } catch {} }
  return { ok: true, courseObjId: row.course_obj_id ? String(row.course_obj_id) : null, userId: String(row.user_id) };
}
export async function markFailed(orderId: string): Promise<void> {
  const { db, sql } = await ctx(); await db.execute(sql`UPDATE edu_course_payments SET status = 'failed', updated_at = now() WHERE order_id = ${orderId}`);
}
/** Refund + re-lock the course enrolment. */
export async function markRefunded(paymentId: string): Promise<{ courseObjId: string | null; userId: string | null }> {
  const { db, sql } = await ctx();
  const row = rows(await db.execute(sql`SELECT * FROM edu_course_payments WHERE payment_id = ${paymentId} ORDER BY id DESC LIMIT 1`))[0];
  await db.execute(sql`UPDATE edu_course_payments SET status = 'refunded', updated_at = now() WHERE payment_id = ${paymentId}`);
  if (row?.course_obj_id) await db.execute(sql`UPDATE edu_enrolments SET status = 'inactive' WHERE user_id = ${String(row.user_id)}::uuid AND course_obj_id = ${String(row.course_obj_id)}::uuid`).catch(() => {});
  return { courseObjId: row?.course_obj_id ? String(row.course_obj_id) : null, userId: row ? String(row.user_id) : null };
}
/** Complimentary access granted by a registrar — recorded like a paid payment, mode 'comp'. */
export async function grantComp(userId: string, courseObjId: string, planId: string, by: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_course_payments (user_id, course_obj_id, plan, order_id, amount_paise, mode, authorized_by, status, payment_id)
    VALUES (${userId}, ${courseObjId}, ${planId}, ${'comp_' + Date.now()}, 0, 'comp', ${by}, 'paid', ${'comp'})`);
  try { const { enrolInCourse } = await import('@/lib/enrolment'); await enrolInCourse(userId, courseObjId, by); } catch {}
}

/** Is this course unlocked for the user? Latest payment status (or a free plan) decides. */
export async function courseAccess(userId: string, courseObjId: string): Promise<{ unlocked: boolean; status: PaymentStatus | null; plan: string | null }> {
  const { db, sql } = await ctx();
  const row = rows(await db.execute(sql`SELECT plan, status FROM edu_course_payments WHERE user_id = ${userId} AND course_obj_id = ${courseObjId} ORDER BY id DESC LIMIT 1`))[0];
  const status = (row?.status || null) as PaymentStatus | null;
  const plan = row?.plan ? planById(String(row.plan)) : null;
  return { unlocked: unlockedByPayment(status, plan), status, plan: row?.plan || null };
}
export async function myPayments(userId: string): Promise<any[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT id, course_obj_id, plan, amount_paise, currency, status, mode, created_at FROM edu_course_payments WHERE user_id = ${userId} ORDER BY id DESC LIMIT 50`));
}
export async function allPayments(limit = 100): Promise<any[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT id, user_id, course_obj_id, plan, amount_paise, status, mode, payment_id, created_at FROM edu_course_payments ORDER BY id DESC LIMIT ${limit}`));
}
