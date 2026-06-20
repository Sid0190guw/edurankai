// Fee waiver coupons — single-use codes admins can mint and share with an
// applicant (in their thread, by email, or 1:1). When redeemed on /apply/pay
// it bypasses the payment step and materialises the application with
// fee_waiver_granted = true, the same way an approved waiver does.
//
// Design choices:
//   - One coupon row per code; code is human-readable (EDU-A1B2-C3D4).
//   - max_uses defaults to 1 — single applicant per code. If admin wants to
//     hand out a bulk-comm code for an event, they raise max_uses.
//   - expires_at default = +30 days.
//   - bound_user_id / bound_intent_id / bound_role_id are optional. If set,
//     redeem must match (so a code shared with Alice can't be reused by Bob).
//   - reason text is shown to the applicant on redemption + recorded in the
//     materialised application's fee_waiver_reason.
//
// Self-bootstrapping schema; safe to call ensure...() on every redeem.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

let ready: Promise<void> | null = null;
export function ensureCouponSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS fee_waiver_coupons (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(64) NOT NULL UNIQUE,
        reason TEXT,
        bound_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        bound_intent_id UUID REFERENCES application_intents(id) ON DELETE SET NULL,
        bound_role_id UUID,
        max_uses INT NOT NULL DEFAULT 1,
        used_count INT NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS fwc_code_idx ON fee_waiver_coupons(code)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS fwc_bound_user_idx ON fee_waiver_coupons(bound_user_id) WHERE bound_user_id IS NOT NULL`);

      await db.execute(sql`CREATE TABLE IF NOT EXISTS fee_waiver_coupon_redemptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        coupon_id UUID NOT NULL REFERENCES fee_waiver_coupons(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        intent_id UUID,
        application_id UUID,
        redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ip_address VARCHAR(64),
        user_agent TEXT
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS fwcr_coupon_idx ON fee_waiver_coupon_redemptions(coupon_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS fwcr_user_idx ON fee_waiver_coupon_redemptions(user_id)`);
    } catch (_) {}
  })();
  return ready;
}

function randomCode(): string {
  // EDU-XXXX-XXXX (8 hex chars, easy to type)
  const buf = randomBytes(4).toString('hex').toUpperCase();
  return 'EDU-' + buf.slice(0, 4) + '-' + buf.slice(4, 8);
}

export async function generateCoupon(opts: {
  createdByUserId: string;
  reason?: string | null;
  boundUserId?: string | null;
  boundIntentId?: string | null;
  boundRoleId?: string | null;
  maxUses?: number;
  expiresInDays?: number;
}): Promise<{ ok: boolean; code?: string; id?: string; error?: string }> {
  await ensureCouponSchema();
  const maxUses = Math.max(1, Math.min(1000, opts.maxUses || 1));
  const expiresInDays = Math.max(1, Math.min(365, opts.expiresInDays || 30));
  // Up to 5 attempts to avoid the rare collision on the unique index.
  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    try {
      const ins = rows(await db.execute(sql`
        INSERT INTO fee_waiver_coupons (
          code, reason, bound_user_id, bound_intent_id, bound_role_id, max_uses,
          expires_at, created_by_user_id
        ) VALUES (
          ${code}, ${opts.reason || null}, ${opts.boundUserId || null}, ${opts.boundIntentId || null}, ${opts.boundRoleId || null}, ${maxUses},
          NOW() + (${expiresInDays} || ' days')::interval, ${opts.createdByUserId}
        ) RETURNING id
      `));
      return { ok: true, code, id: ins[0]?.id };
    } catch (e: any) {
      if (!/duplicate|unique/i.test(e?.message || '')) {
        return { ok: false, error: e?.message || 'db error' };
      }
    }
  }
  return { ok: false, error: 'could not generate unique code' };
}

export interface CouponPreview {
  ok: boolean;
  error?: string;
  coupon?: {
    id: string;
    code: string;
    reason: string | null;
    bound_user_id: string | null;
    bound_intent_id: string | null;
    bound_role_id: string | null;
    max_uses: number;
    used_count: number;
    expires_at: string | null;
    remaining: number;
  };
}

export async function previewCoupon(code: string, userId: string, intentId?: string | null): Promise<CouponPreview> {
  await ensureCouponSchema();
  const cleanCode = (code || '').toString().trim().toUpperCase().replace(/\s+/g, '');
  if (!cleanCode) return { ok: false, error: 'enter a code' };
  const row = rows(await db.execute(sql`
    SELECT * FROM fee_waiver_coupons WHERE code = ${cleanCode} LIMIT 1
  `))[0] as any;
  if (!row) return { ok: false, error: 'code not found' };
  if (row.revoked_at) return { ok: false, error: 'this code has been revoked' };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: 'this code has expired' };
  if (row.used_count >= row.max_uses) return { ok: false, error: 'this code has been fully redeemed' };
  if (row.bound_user_id && row.bound_user_id !== userId) return { ok: false, error: 'this code is bound to a different account' };
  // Intent binding is advisory once a coupon is tied to a user: that applicant
  // may have abandoned the original intent and started a fresh application (new
  // intent id). The user binding is the real security boundary, so only enforce
  // the intent match for a pure intent-scoped code (no user binding). This fixes
  // the "this code is bound to a different application" rejection.
  if (row.bound_intent_id && intentId && row.bound_intent_id !== intentId && !(row.bound_user_id && row.bound_user_id === userId)) {
    return { ok: false, error: 'this code is bound to a different application' };
  }

  // Per-user single-redeem: if this user already redeemed THIS coupon, block.
  const dup = rows(await db.execute(sql`
    SELECT id FROM fee_waiver_coupon_redemptions
    WHERE coupon_id = ${row.id} AND user_id = ${userId} LIMIT 1
  `))[0];
  if (dup) return { ok: false, error: 'you have already redeemed this code' };

  return {
    ok: true,
    coupon: {
      id: row.id,
      code: row.code,
      reason: row.reason,
      bound_user_id: row.bound_user_id,
      bound_intent_id: row.bound_intent_id,
      bound_role_id: row.bound_role_id,
      max_uses: row.max_uses,
      used_count: row.used_count,
      expires_at: row.expires_at,
      remaining: row.max_uses - row.used_count,
    },
  };
}

export async function recordRedemption(opts: {
  couponId: string;
  userId: string;
  intentId?: string | null;
  applicationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  await ensureCouponSchema();
  try {
    // Atomically bump used_count; the check on used_count<max_uses prevents races.
    const upd = rows(await db.execute(sql`
      UPDATE fee_waiver_coupons
      SET used_count = used_count + 1
      WHERE id = ${opts.couponId}
        AND used_count < max_uses
        AND (expires_at IS NULL OR expires_at > NOW())
        AND revoked_at IS NULL
      RETURNING id
    `));
    if (!upd[0]) return { ok: false, error: 'coupon no longer valid' };
    await db.execute(sql`
      INSERT INTO fee_waiver_coupon_redemptions (coupon_id, user_id, intent_id, application_id, ip_address, user_agent)
      VALUES (${opts.couponId}, ${opts.userId}, ${opts.intentId || null}, ${opts.applicationId || null}, ${opts.ipAddress || null}, ${opts.userAgent || null})
    `);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'db error' };
  }
}

export async function listCouponsByCreator(userId: string, limit = 50) {
  await ensureCouponSchema();
  return rows(await db.execute(sql`
    SELECT c.id, c.code, c.reason, c.bound_user_id, c.max_uses, c.used_count, c.expires_at, c.revoked_at, c.created_at,
      bu.email AS bound_user_email, bu.name AS bound_user_name
    FROM fee_waiver_coupons c
    LEFT JOIN users bu ON bu.id = c.bound_user_id
    WHERE c.created_by_user_id = ${userId}
    ORDER BY c.created_at DESC LIMIT ${limit}
  `));
}

export async function revokeCoupon(couponId: string, adminUserId: string) {
  await ensureCouponSchema();
  await db.execute(sql`
    UPDATE fee_waiver_coupons SET revoked_at = NOW()
    WHERE id = ${couponId} AND revoked_at IS NULL
  `);
}
