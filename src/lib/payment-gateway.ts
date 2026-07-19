// src/lib/payment-gateway.ts — pluggable payment gateway + plans + access gating (Prompt AP5). The
// gateway INTERFACE (createOrder / verify / refund / publicKey / mode) is implemented against Razorpay
// (real, keys from env via src/lib/razorpay.ts — NEVER hardcoded) with an honest SANDBOX fallback when
// no keys are configured. Sandbox is clearly labelled and never presents a test charge as real money.
// Access is GATED by a paid payment record tied to enrolment: paid -> unlocked; failed/refunded -> locked.
import { createOrder as rzpCreate, verifyPaymentSignature, refundPayment, getPublicKeyId, isConfigured } from '@/lib/razorpay';

export type PlanKind = 'free' | 'per-course' | 'subscription';
export interface Plan { id: string; kind: PlanKind; label: string; priceInr: number; period?: 'monthly' | 'yearly' }
export const PLANS: Plan[] = [
  { id: 'free', kind: 'free', label: 'Free access', priceInr: 0 },
  { id: 'course', kind: 'per-course', label: 'Single course', priceInr: 499 },
  { id: 'sub-monthly', kind: 'subscription', label: 'All courses (monthly)', priceInr: 999, period: 'monthly' },
  { id: 'sub-yearly', kind: 'subscription', label: 'All courses (yearly)', priceInr: 9990, period: 'yearly' },
];
export function planById(id: string): Plan | null { return PLANS.find((p) => p.id === id) || null; }
export function amountPaise(plan: Plan): number { return Math.round(plan.priceInr * 100); }

export type PaymentStatus = 'created' | 'paid' | 'failed' | 'refunded';
/** The access rule: only a captured, non-refunded payment (or a free plan) unlocks a course. */
export function unlockedByPayment(status: PaymentStatus | null, plan: Plan | null): boolean {
  if (plan && plan.kind === 'free') return true;
  return status === 'paid';
}

/** A minor may not pay directly — a paid plan needs guardian authorization first (child-safety). */
export function requiresGuardianAuth(isMinor: boolean, plan: Plan | null): boolean {
  return !!isMinor && !!plan && plan.kind !== 'free';
}
/** Total revenue (paise) from REAL captured payments only — never fabricated. */
export function revenuePaise(payments: { status: string; amount_paise: number; mode?: string }[]): { total: number; live: number; sandbox: number } {
  let total = 0, live = 0, sandbox = 0;
  for (const p of payments || []) { if (p.status !== 'paid') continue; const a = Number(p.amount_paise) || 0; total += a; if (p.mode === 'sandbox' || p.mode === 'comp') sandbox += a; else live += a; }
  return { total, live, sandbox };
}

export interface GatewayOrder { id: string; amount: number; currency: string; keyId: string | null }
export interface PaymentGateway {
  mode: 'live' | 'sandbox';
  createOrder(amountPaise: number, receipt: string, notes?: Record<string, string>): Promise<{ ok: true; order: GatewayOrder } | { ok: false; error: string }>;
  verify(orderId: string, paymentId: string, signature: string): boolean;
  refund(paymentId: string, amountPaise?: number): Promise<{ ok: boolean; error?: string }>;
  publicKey(): string | null;
}

function razorpayGateway(): PaymentGateway {
  return {
    mode: 'live',
    async createOrder(amount, receipt, notes) {
      const r = await rzpCreate({ amount, currency: 'INR', receipt, notes } as any);
      if (!r.ok) return r;
      return { ok: true, order: { id: r.order.id, amount: r.order.amount, currency: r.order.currency, keyId: getPublicKeyId() } };
    },
    verify(orderId, paymentId, signature) { return verifyPaymentSignature(orderId, paymentId, signature); },
    async refund(paymentId, amountPaise) { return refundPayment({ paymentId, amount: amountPaise } as any); },
    publicKey() { return getPublicKeyId(); },
  };
}

// SANDBOX: no real gateway configured. Orders are clearly test; a test payment is verified against a
// deterministic sandbox token so dev can exercise the unlock path — but it is NEVER a real charge.
export const SANDBOX_TOKEN = 'sandbox-ok';
function sandboxGateway(): PaymentGateway {
  return {
    mode: 'sandbox',
    async createOrder(amount, receipt) { return { ok: true, order: { id: 'test_order_' + receipt + '_' + Date.now(), amount, currency: 'INR', keyId: null } }; },
    verify(_orderId, _paymentId, signature) { return signature === SANDBOX_TOKEN; },   // test-only; not real money
    async refund() { return { ok: true }; },
    publicKey() { return null; },
  };
}

/** The active gateway: real Razorpay when keys are configured, else the labelled sandbox. */
export function getGateway(): PaymentGateway { return isConfigured() ? razorpayGateway() : sandboxGateway(); }
export function gatewayMode(): 'live' | 'sandbox' { return isConfigured() ? 'live' : 'sandbox'; }
