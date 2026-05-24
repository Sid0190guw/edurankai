// src/lib/proctoring.ts - vendor-agnostic proctoring layer.
// Supports Honorlock, ProctorU, Examity. Switch by setting PROCTORING_PROVIDER
// env + provider-specific keys.

import crypto from 'node:crypto';

export type ProctoringProvider = 'honorlock' | 'proctoru' | 'examity' | null;

export function getProvider(): ProctoringProvider {
  const p = (process.env.PROCTORING_PROVIDER || '').toLowerCase() as ProctoringProvider;
  if (p === 'honorlock' || p === 'proctoru' || p === 'examity') return p;
  return null;
}

export function isConfigured(): boolean {
  return getProvider() !== null;
}

// Verify HMAC webhook signature in a vendor-agnostic way.
// Most proctoring vendors send X-Signature: hmac-sha256(secret, raw_body).
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.PROCTORING_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// Build the iframe URL the candidate's browser loads to start a proctored session.
// Each vendor has its own URL format - centralised here so the test runner just
// asks for one URL and renders it.
export function buildSessionUrl(opts: {
  provider: ProctoringProvider;
  attemptId: string;
  testId: string;
  userEmail: string;
  userName: string;
  returnUrl: string;
}): string | null {
  if (!opts.provider) return null;
  const base = process.env.PROCTORING_VENDOR_BASE_URL || '';
  if (!base) return null;

  const params = new URLSearchParams({
    attempt: opts.attemptId,
    exam: opts.testId,
    email: opts.userEmail,
    name: opts.userName,
    return: opts.returnUrl,
  });

  // Vendor-specific endpoint shape - tune when integrating live.
  if (opts.provider === 'honorlock') return base + '/launch?' + params.toString();
  if (opts.provider === 'proctoru') return base + '/sessions/start?' + params.toString();
  if (opts.provider === 'examity') return base + '/session?' + params.toString();
  return null;
}
