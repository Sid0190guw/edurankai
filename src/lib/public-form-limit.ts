// src/lib/public-form-limit.ts — attempt limiting for forms anyone on the internet can POST to.
//
// WHY THIS FILE EXISTS. /contact accepts a POST from an unauthenticated visitor and INSERTs a row.
// Its only defence was a honeypot, which stops the bots that fill hidden fields and nothing else.
// On 2026-08-22 ordinary traffic against that form was enough to take the entire site down: each
// POST also leaked a database connection until the pooler had no slots left and every route on the
// site returned a gateway timeout. The leak is fixed (ee96b2d), but the exposure underneath it is
// not addressed by that fix — an unauthenticated writer with no ceiling is still an unauthenticated
// writer with no ceiling, and the next thing it exhausts will be a different resource.
//
// It REUSES countAttempt() from @/lib/auth/two-factor rather than adding a second limiter with its
// own table, for exactly the reason src/lib/auth/recovery.ts gives for doing the same: one limiter,
// one table, one place to raise a threshold. countAttempt is a single atomic
// INSERT ... ON CONFLICT DO UPDATE RETURNING, so two concurrent lambdas cannot both see "1".
//
// WHAT IT DOES WHEN THE COUNTER ITSELF IS DOWN is the caller's decision, stated per call site — see
// WhenUnavailable below. A contact form should let the message through; an endpoint that sends mail
// from the site's own domain, or spends metered model budget, or opens a live payment order, should
// refuse. overRecoveryLimit() in src/lib/auth/recovery.ts makes the same choice in the 'refuse'
// direction and explains why: waving an attacker through there costs an account.
import { createHash } from 'node:crypto';

// Declared before every function that reads them — `const` is not hoisted, and a handler reaching a
// later declaration has taken pages down on this project.

/**
 * Generous enough for a shared office, campus or mobile-carrier NAT, where many real people leave
 * one address; far below what a script does in a minute. A limiter that locks out a university is a
 * worse outcome than one that lets a determined spammer send eleven messages an hour.
 */
export const PUBLIC_FORM_MAX_PER_IP = 10;
export const PUBLIC_FORM_WINDOW_SECONDS = 3600;

/**
 * The client address as the edge presents it.
 *
 * x-forwarded-for is a comma-separated chain and only the FIRST entry is the client. Bucketing on
 * the whole string would give every visitor a distinct bucket as soon as an intermediary appended
 * itself, which is not a limit at all.
 */
export function clientIp(headers: Headers): string {
  const chain = headers.get('x-forwarded-for') || headers.get('cf-connecting-ip') || '';
  return (chain.split(',')[0] || '').trim();
}

/** Hashed, so the attempt table never becomes an incidental log of who visited what. */
const bucketFor = (form: string, ip: string): string =>
  'pubform:' + form + ':' + createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 32);

export interface FormLimitVerdict {
  /** True when the caller has spent their allowance and the write must be refused. */
  blocked: boolean;
  /** Attempts spent in the current window. For the server log only — never the response body. */
  used: number;
}

/**
 * What to do when the counter itself cannot be reached. Stated at every call site rather than
 * defaulted silently, because the right answer differs per endpoint and getting it wrong is
 * invisible until the day the database hiccups.
 *
 *  'allow'  — the guarded write is cheap and refusing wrongly hurts a real person more than
 *             letting an extra one through. Contact and intake forms.
 *  'refuse' — the guarded action costs something that is not recoverable by deleting rows:
 *             outbound mail from the site's own sending identity, metered model spend, a live
 *             payment-gateway call. Better to drop a request than to run one unmetered.
 */
export type WhenUnavailable = 'allow' | 'refuse';

export interface FormLimitOptions {
  /** What to do when the counter itself cannot be reached. Defaults to 'allow'. */
  whenUnavailable?: WhenUnavailable;
  /** Ceiling for this bucket. Defaults to PUBLIC_FORM_MAX_PER_IP — raise it for conversational
   *  endpoints, where ten turns an hour is a normal person rather than an attacker. */
  max?: number;
  /** Window in seconds. Defaults to PUBLIC_FORM_WINDOW_SECONDS. */
  windowSeconds?: number;
}

/**
 * Count this submission against the caller's hourly allowance for `form` and say whether to refuse.
 *
 * Call it ONLY on POST, and — for a form — only once the submission has passed validation; counting
 * page views, or counting a visitor's typo, spends an allowance nobody used. For an endpoint whose
 * work is expensive per call, count FIRST, before doing any of that work.
 */
export async function overPublicFormLimit(form: string, ip: string, opts: FormLimitOptions = {}): Promise<FormLimitVerdict> {
  const whenUnavailable = opts.whenUnavailable || 'allow';
  const max = opts.max ?? PUBLIC_FORM_MAX_PER_IP;
  const windowSeconds = opts.windowSeconds ?? PUBLIC_FORM_WINDOW_SECONDS;
  try {
    // Imported HERE, not at module scope: src/lib/auth/two-factor.ts reads import.meta.env at module
    // scope, which is undefined outside Vite, so a top-level import makes anything that imports this
    // module unloadable in the plain-node shim test runner. This function is already async.
    const { countAttempt } = await import('@/lib/auth/two-factor');
    const used = await countAttempt(bucketFor(form, ip), windowSeconds);
    return { blocked: used > max, used };
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the SQL that failed.
    console.error('[public-form-limit] counter unavailable for ' + form + ', ' + whenUnavailable + ':', String(e?.cause?.message || e?.message || 'unknown error'));
    return { blocked: whenUnavailable === 'refuse', used: 0 };
  }
}
