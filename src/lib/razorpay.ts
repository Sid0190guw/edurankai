// src/lib/razorpay.ts - Razorpay integration (no SDK, native fetch + crypto)
// Reads RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET from env.
// All amounts are in PAISE (Razorpay's smallest unit). 1 INR = 100 paise.

import crypto from 'node:crypto';

const RZP_API = 'https://api.razorpay.com/v1';

function getCreds(): { keyId: string; keySecret: string } | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

function authHeader(keyId: string, keySecret: string): string {
  return 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64');
}

export interface CreateOrderInput {
  amountPaise: number;
  currency?: string;
  receipt?: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt: string | null;
  created_at: number;
}

export async function createOrder(input: CreateOrderInput): Promise<{ ok: true; order: RazorpayOrder } | { ok: false; error: string }> {
  const creds = getCreds();
  if (!creds) return { ok: false, error: 'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not configured' };

  if (!Number.isInteger(input.amountPaise) || input.amountPaise < 100) {
    return { ok: false, error: 'amountPaise must be an integer >= 100 (i.e. >= INR 1.00)' };
  }

  try {
    const resp = await fetch(RZP_API + '/orders', {
      method: 'POST',
      headers: {
        'Authorization': authHeader(creds.keyId, creds.keySecret),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: input.currency || 'INR',
        receipt: input.receipt,
        notes: input.notes || {},
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: 'razorpay ' + resp.status + ': ' + text };
    }
    const order = (await resp.json()) as RazorpayOrder;
    return { ok: true, order };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'network error' };
  }
}

// Verify the post-checkout signature returned by Razorpay's frontend handler.
// HMAC-SHA256 of `${orderId}|${paymentId}` keyed with the API secret.
export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
  const creds = getCreds();
  if (!creds) return false;
  if (!orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac('sha256', creds.keySecret)
    .update(orderId + '|' + paymentId)
    .digest('hex');
  // timing-safe compare
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Verify a webhook delivery from Razorpay.
// Body must be the RAW request body string (not parsed JSON re-stringified).
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Fetch a payment record from Razorpay (defence-in-depth for verify endpoint).
export async function fetchPayment(paymentId: string): Promise<any | null> {
  const creds = getCreds();
  if (!creds) return null;
  try {
    const resp = await fetch(RZP_API + '/payments/' + encodeURIComponent(paymentId), {
      method: 'GET',
      headers: { 'Authorization': authHeader(creds.keyId, creds.keySecret) },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null;
  }
}

// Fetch all payment attempts against an order. Used by reconciliation to find
// a payment that was captured at Razorpay but never recorded here (browser
// closed before /verify AND the webhook never fired). Returns [] on any error.
export async function fetchOrderPayments(orderId: string): Promise<any[]> {
  const creds = getCreds();
  if (!creds || !orderId) return [];
  try {
    const resp = await fetch(RZP_API + '/orders/' + encodeURIComponent(orderId) + '/payments', {
      method: 'GET',
      headers: { 'Authorization': authHeader(creds.keyId, creds.keySecret) },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data?.items) ? data.items : [];
  } catch (_) {
    return [];
  }
}

// Public key for the browser checkout - safe to expose.
export function getPublicKeyId(): string | null {
  return process.env.RAZORPAY_KEY_ID || null;
}

// Issue a refund against a captured payment. Full refund if amountPaise is
// omitted; partial refund otherwise. Returns the Razorpay refund entity or
// an error message.
export async function refundPayment(opts: {
  paymentId: string;
  amountPaise?: number;
  speed?: 'normal' | 'optimum';
  notes?: Record<string, string>;
}): Promise<{ ok: true; refund: any } | { ok: false; error: string }> {
  const creds = getCreds();
  if (!creds) return { ok: false, error: 'Razorpay keys not configured' };
  const body: any = { speed: opts.speed || 'normal' };
  if (opts.amountPaise && opts.amountPaise > 0) body.amount = opts.amountPaise;
  if (opts.notes) body.notes = opts.notes;
  try {
    const resp = await fetch(RZP_API + '/payments/' + encodeURIComponent(opts.paymentId) + '/refund', {
      method: 'POST',
      headers: {
        'Authorization': authHeader(creds.keyId, creds.keySecret),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (data as any)?.error?.description || (data as any)?.error?.code || ('HTTP ' + resp.status);
      return { ok: false, error: msg };
    }
    return { ok: true, refund: data };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'refund request failed' };
  }
}

// Convenience for the in-app checkout
export function isConfigured(): boolean {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}
