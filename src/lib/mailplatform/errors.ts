// src/lib/mailplatform/errors.ts — THREE KINDS OF FAILURE, AND WHY THEY MUST NOT SHARE A PATH. Pure.
//
//   TEMPORARY  the world was busy. The same attempt would probably work in a minute.
//              -> retry with exponential backoff, then dead-letter.
//   PERMANENT  the attempt is wrong and will be wrong for ever. A template that does not exist, a
//              malformed address, an action nobody implemented.
//              -> dead-letter immediately. Retrying is just five more identical failures, delayed.
//   BUSINESS   nothing failed. The answer is simply no: the contact unsubscribed, the deadline has
//              no date, the list is empty.
//              -> end the run, record why, and DO NOT count it as an error anywhere.
//
// Collapsing these was the defect this file exists to prevent. A queue that retries everything
// re-sends mail after a bounce that will bounce again; a queue that retries nothing dead-letters
// half a campaign on one pooler blip; and a queue that treats "this candidate unsubscribed" as an
// error puts a red number on an operator's screen for the system working exactly as designed.
export type FailureKind = 'temporary' | 'permanent' | 'business';

/** Thrown by an action when the answer is a legitimate no. Never retried, never counted as an error. */
export class BusinessRuleFailure extends Error {
  readonly kind: FailureKind = 'business';
  constructor(message: string) { super(message); this.name = 'BusinessRuleFailure'; }
}

/** Thrown by an action when the attempt can never succeed as written. Dead-letters immediately. */
export class PermanentFailure extends Error {
  readonly kind: FailureKind = 'permanent';
  constructor(message: string) { super(message); this.name = 'PermanentFailure'; }
}

/** Thrown when the world was busy. Retried with backoff. */
export class TemporaryFailure extends Error {
  readonly kind: FailureKind = 'temporary';
  constructor(message: string) { super(message); this.name = 'TemporaryFailure'; }
}

/** The real Postgres reason lives on e.cause; e.message is only the failed SQL. This is the house
 *  rule from CLAUDE.md and it is why a run's `error` column is readable at all. */
export function reasonOf(e: any): string {
  return String(e?.cause?.message || e?.message || e || 'unknown error');
}

const TEMPORARY_PATTERNS = [
  /\bECONNRESET\b/i, /\bETIMEDOUT\b/i, /\bECONNREFUSED\b/i, /\bEAI_AGAIN\b/i, /\bEPIPE\b/i, /\bENETUNREACH\b/i,
  /timeout/i, /timed out/i, /temporarily unavailable/i, /too many connections/i, /connection terminated/i,
  /server closed the connection/i, /rate limit/i, /\b(429|503|504)\b/, /\b4\.\d\.\d\b/,          // SMTP 4.x.x = try again
  /deadlock detected/i, /could not serialize/i, /terminating connection/i,
];

const PERMANENT_PATTERNS = [
  /\b5\.\d\.\d\b/,                                   // SMTP 5.x.x = do not try again
  /\b(400|401|403|404|405|410|422)\b/,
  /no such user/i, /mailbox unavailable/i, /user unknown/i, /does not exist/i, /invalid address/i,
  /authentication failed/i, /not authorized/i, /unknown action/i, /unsupported/i,
];

/**
 * Classify a failure that arrived as an exception.
 *
 * An explicitly typed failure always wins — an action that KNOWS why it failed is never second
 * guessed by a regular expression. Only an untyped error is matched against the patterns.
 *
 * THE DEFAULT IS TEMPORARY, and it is the safer of the two defaults for this engine: a misclassified
 * temporary error costs a handful of retries and then dead-letters anyway, so nothing is lost; a
 * misclassified permanent error dead-letters a run on the first transient blip and a human has to
 * find and resume it by hand. Neither default sends anything twice — that is prevented in the step
 * ledger, not here.
 */
export function classifyError(e: any): FailureKind {
  if (e instanceof BusinessRuleFailure || e?.kind === 'business' || e?.name === 'BusinessRuleFailure') return 'business';
  if (e instanceof PermanentFailure || e?.kind === 'permanent' || e?.name === 'PermanentFailure') return 'permanent';
  if (e instanceof TemporaryFailure || e?.kind === 'temporary' || e?.name === 'TemporaryFailure') return 'temporary';
  const text = reasonOf(e);
  for (const re of PERMANENT_PATTERNS) if (re.test(text)) return 'permanent';
  for (const re of TEMPORARY_PATTERNS) if (re.test(text)) return 'temporary';
  return 'temporary';
}

/** 1m, 2m, 4m, 8m, 16m, capped at an hour. Deliberately slower than src/lib/job-queue.ts's seconds:
 *  a workflow step usually involves an outside mail server, and hammering one that just refused us
 *  is how a sending domain earns a reputation problem. */
export function retryDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(3_600_000, 60_000 * Math.pow(2, n));
}

export const DEFAULT_MAX_RETRIES = 5;

export type RetryOutcome =
  | { action: 'retry'; delayMs: number; reason: string }
  | { action: 'dead_letter'; reason: string }
  | { action: 'end_run'; reason: string };

/**
 * What to do with a step that just failed. Pure, so the retry policy is testable without a database
 * and identical for every action.
 */
export function decideRetry(kind: FailureKind, retryCount: number, maxRetries = DEFAULT_MAX_RETRIES): RetryOutcome {
  if (kind === 'business') return { action: 'end_run', reason: 'a business rule ended this run; it is not an error and will not be retried' };
  if (kind === 'permanent') return { action: 'dead_letter', reason: 'the failure is permanent, so retrying would fail identically' };
  if (retryCount >= maxRetries) return { action: 'dead_letter', reason: 'still failing after ' + maxRetries + ' retries' };
  return { action: 'retry', delayMs: retryDelayMs(retryCount), reason: 'temporary failure, attempt ' + (retryCount + 1) + ' of ' + maxRetries };
}
